import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ModelRequest,
  type ModelToolCall,
  runOpenAI,
} from "../src/openai-transport";

const settings = {
  OPENAI_API_KEY: "synthetic-test-key",
  AI_MODEL: "gpt-5.6-sol",
};
const request: ModelRequest & { stream?: false } = {
  messages: [{ role: "user", content: "Compare the reported applicants." }],
  max_completion_tokens: 1400,
  reasoning_effort: "low",
};
const signal = () => new AbortController().signal;
const complete = (content = "READY") =>
  Response.json({
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content } },
    ],
  });
const sse = (body: ReadableStream<Uint8Array> | string) =>
  new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI private corpus transport", () => {
  it("preserves tool IDs, arguments and omitted optional filters across a function round trip", async () => {
    const call: ModelToolCall = {
      id: "call_123",
      type: "function",
      function: { name: "cohort_search", arguments: "{}" },
    };
    const expected = {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: [call] },
        },
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(expected))
      .mockResolvedValueOnce(complete());
    vi.stubGlobal("fetch", fetcher);
    const tools: ModelRequest["tools"] = [
      {
        type: "function",
        function: {
          name: "cohort_search",
          description: "Search supplied corpus",
          parameters: {
            type: "object",
            properties: { gpaMin: { type: "number" } },
            required: [],
            additionalProperties: false,
          },
        },
      },
    ];
    const first = await runOpenAI(
      settings,
      { ...request, tools, reasoning_effort: "none" },
      { signal: signal() },
    );
    expect(first).toEqual(expected);
    await runOpenAI(
      settings,
      {
        ...request,
        tools,
        reasoning_effort: "none",
        messages: [
          ...request.messages,
          { role: "assistant", content: null, tool_calls: [call] },
          {
            role: "tool",
            tool_call_id: call.id,
            content: '{"matchedProfiles":3}',
          },
        ],
      },
      { signal: signal() },
    );
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.redirect).toBe("manual");
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: false,
      max_completion_tokens: 1400,
      parallel_tool_calls: false,
      reasoning_effort: "none",
    });
    expect(payload.tools[0].function).toMatchObject({
      strict: false,
      parameters: { required: [] },
    });
    expect(payload.messages[1].tool_calls[0]).toEqual(call);
    expect(payload.messages[2].tool_call_id).toBe("call_123");
    expect(payload).not.toHaveProperty("web_search_options");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("rejects missing credentials, wrong model and outside tools before sending any content", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const env of [
      { AI_MODEL: "gpt-5.6-sol" },
      { ...settings, AI_MODEL: "different-model" },
    ])
      await expect(
        runOpenAI(env, request, { signal: signal() }),
      ).rejects.toMatchObject({ code: "provider_configuration" });
    await expect(
      runOpenAI(
        settings,
        {
          ...request,
          tools: [{ type: "function", function: { name: "web_search" } }],
        },
        { signal: signal() },
      ),
    ).rejects.toMatchObject({ code: "provider_configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects reasoning with Chat Completions tools rather than silently changing effort", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      runOpenAI(
        settings,
        {
          ...request,
          tools: [{ type: "function", function: { name: "calculate" } }],
          reasoning_effort: "low",
        },
        { signal: signal() },
      ),
    ).rejects.toMatchObject({ code: "provider_configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("streams exact bytes across fragmented Unicode and keeps the native completion marker", async () => {
    const text =
      'data: {"choices":[{"delta":{"content":"café 🙂"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const bytes = encoder.encode(text);
    let at = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          new ReadableStream({
            pull(output) {
              if (at === bytes.length) return output.close();
              output.enqueue(bytes.slice(at, ++at));
            },
          }),
        ),
      ),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: signal() },
    );
    expect(await new Response(body).text()).toBe(text);
  });

  it("aborts the pending fetch immediately when the caller stops", async () => {
    const stop = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        upstreamSignal = init.signal;
        // Deliberately ignores abort; the adapter must still settle its own call.
        return new Promise<Response>(() => {});
      }),
    );
    const pending = runOpenAI(settings, request, { signal: stop.signal });
    stop.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("cancels the upstream response and network when the stream reader cancels", async () => {
    const cancelled = vi.fn();
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        upstreamSignal = init.signal;
        return sse(
          new ReadableStream({
            start(output) {
              output.enqueue(encoder.encode("data: one\n\n"));
            },
            cancel: cancelled,
          }),
        );
      }),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: signal() },
    );
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("cancels a stalled response body when a Stop signal arrives", async () => {
    const stop = new AbortController();
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse(new ReadableStream({ cancel: cancelled }))),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: stop.signal },
    );
    const pending = body.getReader().read();
    stop.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("enforces both request and stream idle deadlines without leaving an upstream request running", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        upstreamSignal = init.signal;
        return sse(new ReadableStream({ cancel: cancelled }));
      }),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: signal(), timeoutMs: 10, idleTimeoutMs: 50 },
    );
    const reading = expect(body.getReader().read()).rejects.toMatchObject({
      code: "provider_timeout",
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(upstreamSignal?.aborted).toBe(false); // Header deadline ended after headers.
    await vi.advanceTimersByTimeAsync(40);
    await reading;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const waiting = expect(
      runOpenAI(settings, request, { signal: signal(), timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "provider_timeout" });
    await vi.advanceTimersByTimeAsync(11);
    await waiting;
  });

  it("revokes a long-running provider call when the stored generation lease is cancelled", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init: RequestInit) => {
        upstreamSignal = init.signal;
        return new Promise<Response>(() => {});
      }),
    );
    const checkpoint = vi.fn(async () => false);
    const waiting = expect(
      runOpenAI(settings, request, { signal: signal(), checkpoint }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(4001);
    await waiting;
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(upstreamSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it("times out even when downstream stops pulling after the response buffer fills", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          new ReadableStream({
            pull(output) {
              output.enqueue(encoder.encode("data: waiting\n\n"));
            },
            cancel: cancelled,
          }),
        ),
      ),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: signal(), idleTimeoutMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(51);
    await expect(body.getReader().read()).rejects.toMatchObject({
      code: "provider_timeout",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not expose provider error bodies, fetch errors or follow credentialed redirects", async () => {
    const secret = "private prompt and synthetic-test-key";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(secret, {
          status: 302,
          headers: { Location: "https://example.org/collect" },
        }),
      )
      .mockResolvedValueOnce(new Response(secret, { status: 429 }))
      .mockRejectedValueOnce(new Error(secret));
    vi.stubGlobal("fetch", fetcher);
    for (const code of [
      "provider_unavailable",
      "provider_capacity",
      "provider_unavailable",
    ]) {
      try {
        await runOpenAI(settings, request, { signal: signal() });
        expect.fail("expected an error");
      } catch (error) {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain(secret);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.every((call) => call[1].redirect === "manual"),
    ).toBe(true);
  });

  it("rejects provider truncation and malformed/non-JSON completions instead of treating them as a successful tool round", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            { finish_reason: "length", message: { content: "partial" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { message: "do not expose" } }),
      )
      .mockResolvedValueOnce(
        new Response("<html>failure</html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    for (const code of [
      "provider_incomplete",
      "provider_unavailable",
      "provider_unavailable",
    ])
      await expect(
        runOpenAI(settings, request, { signal: signal() }),
      ).rejects.toMatchObject({ code });
  });

  it("bounds cumulative stream bytes and cancels excessive upstream output", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          new ReadableStream({
            pull(output) {
              output.enqueue(new Uint8Array(600_000));
            },
            cancel: cancelled,
          }),
        ),
      ),
    );
    const body = await runOpenAI(
      settings,
      { ...request, stream: true },
      { signal: signal() },
    );
    await expect(new Response(body).arrayBuffer()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
