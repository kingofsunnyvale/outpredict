import { ProductError } from "./product-types";

export type ModelToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ModelToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ModelTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIEnvironment = {
  OPENAI_API_KEY?: string;
  AI_MODEL: string;
};

export type ModelRequest = {
  messages: ModelMessage[];
  tools?: ModelTool[];
  tool_choice?: "auto" | "none" | "required";
  parallel_tool_calls?: false;
  max_completion_tokens: number;
  reasoning_effort: "none" | "low" | "medium" | "high";
  stream?: boolean;
};

type RequestOptions = {
  signal: AbortSignal;
  checkpoint?: () => Promise<boolean>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
};

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const LOCAL_TOOLS = new Set([
  "cohort_search",
  "profile_inspect",
  "weekly_time_budget",
  "calculate",
]);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function unavailable() {
  return new ProductError(
    503,
    "The answer provider could not complete. Please retry.",
    "provider_unavailable",
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

/** Native Chat Completions SSE; the agent consumes only assistant content. */
export function runOpenAI(
  env: OpenAIEnvironment,
  input: ModelRequest & { stream: true },
  options: RequestOptions,
): Promise<ReadableStream<Uint8Array>>;
export function runOpenAI(
  env: OpenAIEnvironment,
  input: ModelRequest & { stream?: false },
  options: RequestOptions,
): Promise<unknown>;
export async function runOpenAI(
  env: OpenAIEnvironment,
  input: ModelRequest,
  options: RequestOptions,
): Promise<unknown | ReadableStream<Uint8Array>> {
  options.signal.throwIfAborted();
  if (!env.OPENAI_API_KEY?.trim() || env.AI_MODEL !== "gpt-5.6-sol")
    throw new ProductError(
      503,
      "The answer provider is not configured. Please try again later.",
      "provider_configuration",
    );
  if (
    input.tools?.some(
      (tool) =>
        tool.type !== "function" || !LOCAL_TOOLS.has(tool.function.name),
    ) ||
    (Boolean(input.tools?.length) && input.reasoning_effort !== "none") ||
    !Number.isInteger(input.max_completion_tokens) ||
    input.max_completion_tokens < 1 ||
    input.max_completion_tokens > 16_000
  )
    throw new ProductError(
      503,
      "The answer request is invalid.",
      "provider_configuration",
    );

  const controller = new AbortController();
  const { signal } = controller;
  const forwardAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal.aborted) forwardAbort();
  let closed = false;
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let streamAbort: (() => void) | undefined;
  const timeout = () =>
    controller.abort(
      new ProductError(
        503,
        "This answer took too long. Please retry with a narrower question.",
        "provider_timeout",
      ),
    );
  requestTimer = setTimeout(timeout, options.timeoutMs ?? 40_000);
  const cleanup = () => {
    closed = true;
    clearTimeout(requestTimer);
    clearTimeout(checkpointTimer);
    clearTimeout(idleTimer);
    options.signal.removeEventListener("abort", forwardAbort);
    if (streamAbort) signal.removeEventListener("abort", streamAbort);
  };
  const checkActive = async () => {
    try {
      const active = await options.checkpoint?.();
      if (!closed && active === false)
        controller.abort(
          new DOMException("Generation cancelled", "AbortError"),
        );
    } catch {
      if (!closed) controller.abort(unavailable());
    }
    if (!closed && !signal.aborted)
      checkpointTimer = setTimeout(() => void checkActive(), 4000);
  };
  if (options.checkpoint)
    checkpointTimer = setTimeout(() => void checkActive(), 4000);
  const requestBody = {
    model: env.AI_MODEL,
    messages: input.messages,
    max_completion_tokens: input.max_completion_tokens,
    reasoning_effort: input.reasoning_effort,
    store: false,
    stream: input.stream === true,
    ...(input.tools?.length
      ? {
          tools: input.tools.map(({ function: fn }) => ({
            type: "function",
            function: {
              name: fn.name,
              description: fn.description,
              parameters: fn.parameters,
              strict: false,
            },
          })),
          tool_choice: input.tool_choice ?? "auto",
          parallel_tool_calls: false,
        }
      : {}),
  };

  try {
    const response = await abortable(
      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        redirect: "manual",
        signal,
      }).then((result) => {
        if (signal.aborted) void result.body?.cancel().catch(() => {});
        return result;
      }),
      signal,
    );
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      // Neither provider response text nor headers enter user-visible errors/logs.
      if (response.status === 429)
        throw new ProductError(
          503,
          "The answer service is at capacity. Please try again shortly.",
          "provider_capacity",
        );
      throw unavailable();
    }
    const expectedType = input.stream
      ? "text/event-stream"
      : "application/json";
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes(expectedType)
    ) {
      void response.body.cancel().catch(() => {});
      throw unavailable();
    }
    if (input.stream) clearTimeout(requestTimer);
    const reader = response.body.getReader();
    let size = 0;
    const next = async () => {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (!chunk.done) {
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw unavailable();
      }
      return chunk;
    };
    if (!input.stream) {
      try {
        const decoder = new TextDecoder();
        let body = "";
        while (true) {
          const chunk = await next();
          if (chunk.done) break;
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || "error" in parsed)
          throw unavailable();
        const choices = (
          parsed as { choices?: Array<{ finish_reason?: string }> }
        ).choices;
        if (
          !Array.isArray(choices) ||
          !["stop", "tool_calls"].includes(choices[0]?.finish_reason ?? "")
        )
          throw new ProductError(
            503,
            "The answer stopped before it was complete. You can retry.",
            "provider_incomplete",
          );
        const message = (choices[0] as { message?: unknown }).message;
        if (!message || typeof message !== "object") throw unavailable();
        const reply = message as { content?: unknown; tool_calls?: unknown };
        if (
          typeof reply.content !== "string" &&
          !Array.isArray(reply.tool_calls)
        )
          throw unavailable();
        return parsed;
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        cleanup();
      }
    }

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(timeout, options.idleTimeoutMs ?? 30_000);
    };
    resetIdle();
    return new ReadableStream<Uint8Array>({
      start(output) {
        // Abort even while downstream backpressure means no pull is pending.
        streamAbort = () => {
          cleanup();
          void reader.cancel().catch(() => {});
          output.error(signal.reason);
        };
        signal.addEventListener("abort", streamAbort, { once: true });
        if (signal.aborted) streamAbort();
      },
      async pull(output) {
        try {
          const chunk = await next();
          if (chunk.done) {
            cleanup();
            reader.releaseLock();
            output.close();
          } else {
            resetIdle();
            output.enqueue(chunk.value);
          }
        } catch (error) {
          if (closed) return;
          const safeError = signal.aborted
            ? signal.reason
            : error instanceof ProductError
              ? error
              : unavailable();
          controller.abort(safeError);
          cleanup();
          void reader.cancel().catch(() => {});
          output.error(safeError);
        }
      },
      cancel() {
        controller.abort(
          new DOMException("Generation cancelled", "AbortError"),
        );
        cleanup();
        void reader.cancel().catch(() => {});
      },
    });
  } catch (error) {
    const safeError = signal.aborted
      ? signal.reason
      : error instanceof ProductError
        ? error
        : unavailable();
    controller.abort(safeError);
    cleanup();
    throw safeError;
  }
}
