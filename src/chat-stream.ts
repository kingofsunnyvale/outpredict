import { AgentFailure, runAgent } from "./agent";
import { productJson, readProductJson } from "./chat-api";
import {
  beginMessagePair,
  finishMessage,
  getChatContext,
  renewGenerationLease,
  saveMessageProgress,
} from "./chat-store";
import {
  type Evidence,
  ProductError,
  type VerifiedUser,
} from "./product-types";

const encoder = new TextEncoder();

export async function handleChatStream(
  request: Request,
  env: Env,
  user: VerifiedUser,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname);
  if (!match?.[1]) return null;
  const chatId = match[1];
  if (request.method !== "POST")
    return productJson({ error: "Method not allowed." }, 405);
  if (
    url.origin !== env.AUTH_URL ||
    request.headers.get("Origin") !== env.AUTH_URL
  ) {
    return productJson({ error: "Untrusted request origin." }, 403);
  }
  try {
    const data = await readProductJson(request, 90_000);
    if (
      !data ||
      typeof data !== "object" ||
      !("content" in data) ||
      typeof data.content !== "string" ||
      !("requestId" in data) ||
      typeof data.requestId !== "string" ||
      ("retry" in data && typeof data.retry !== "boolean") ||
      ("attachmentIds" in data &&
        (!Array.isArray(data.attachmentIds) ||
          !data.attachmentIds.every((id) => typeof id === "string")))
    ) {
      throw new ProductError(
        400,
        "Send a question and a valid request ID.",
        "invalid_message",
      );
    }
    const pair = await beginMessagePair(env, user.id, {
      chatId,
      content: data.content,
      requestId: data.requestId,
      attachmentIds:
        "attachmentIds" in data ? (data.attachmentIds as string[]) : [],
      retry: "retry" in data ? (data.retry as boolean) : false,
    });
    if (
      !pair.created &&
      ["running", "pending"].includes(pair.assistantMessage.status)
    ) {
      return productJson(
        {
          error:
            "This answer is already running. Reopen the conversation to see its progress.",
          code: "generation_running",
        },
        409,
      );
    }
    const abort = new AbortController();
    let closed = false;
    let content = pair.created ? "" : pair.assistantMessage.content;
    let evidence: Evidence = pair.assistantMessage.evidence ?? { sources: [] };
    const assistantId = pair.assistantMessage.id;
    let lastSaved = Date.now();
    let lastSavedLength = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: Record<string, unknown>) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
        };
        const checkpoint = async () => {
          if (abort.signal.aborted) return false;
          return renewGenerationLease(env, user.id, chatId, assistantId);
        };
        const run = async () => {
          try {
            emit({
              type: "meta",
              chatId,
              userMessageId: pair.userMessage.id,
              assistantMessageId: assistantId,
            });
            if (!pair.created) {
              if (content) emit({ type: "delta", text: content });
              emit({ type: "evidence", evidence });
              emit({ type: "done", status: pair.assistantMessage.status });
              return;
            }
            const context = await getChatContext(env, user.id, chatId);
            const result = await runAgent({
              env,
              messages: context.messages
                .filter(
                  (message) =>
                    message.id !== assistantId &&
                    (message.role === "user" || message.status === "complete"),
                )
                .slice(-24)
                .map(({ role, content: text, evidence: priorEvidence }) => ({
                  role,
                  content: text,
                  evidence: priorEvidence ?? undefined,
                })),
              documents: context.documents.map(({ id, name, text }) => ({
                id,
                name,
                text,
              })),
              signal: abort.signal,
              checkpoint,
              onEvent: async (event) => {
                if (abort.signal.aborted)
                  throw new DOMException("Stream interrupted", "AbortError");
                if (event.type === "delta") content += event.text;
                if (event.type === "evidence") evidence = event.evidence;
                if (
                  event.type === "evidence" ||
                  Date.now() - lastSaved >= 1200 ||
                  content.length - lastSavedLength >= 1600
                ) {
                  const saved = await saveMessageProgress(
                    env,
                    user.id,
                    chatId,
                    assistantId,
                    content,
                    evidence,
                  );
                  if (!saved)
                    throw new DOMException("Generation stopped", "AbortError");
                  lastSaved = Date.now();
                  lastSavedLength = content.length;
                }
                emit(event);
              },
            });
            content = result.content;
            evidence = result.evidence;
            const finished = await finishMessage(
              env,
              user.id,
              chatId,
              assistantId,
              content,
              "complete",
              evidence,
            );
            if (!finished)
              throw new DOMException("Generation stopped", "AbortError");
            emit({ type: "done", status: "complete" });
          } catch (error) {
            const failure = error instanceof AgentFailure ? error : null;
            const cancelled =
              abort.signal.aborted ||
              failure?.cancelled ||
              (error instanceof DOMException && error.name === "AbortError");
            if (failure) {
              content = failure.content;
              evidence = failure.evidence;
            }
            await finishMessage(
              env,
              user.id,
              chatId,
              assistantId,
              content,
              cancelled ? "cancelled" : "failed",
              evidence,
            ).catch(() => {
              console.error(
                JSON.stringify({ event: "generation_recovery_write_failed" }),
              );
            });
            emit({
              type: "error",
              error: cancelled
                ? "Response stopped. You can retry your question."
                : "The answer was interrupted. Your question and any partial answer are saved. Please retry.",
              code: cancelled ? "cancelled" : "generation_failed",
            });
            console.error(
              JSON.stringify({
                event: cancelled ? "generation_cancelled" : "generation_failed",
                partialCharacters: content.length,
              }),
            );
          } finally {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        };
        ctx.waitUntil(run());
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof ProductError)
      return productJson(
        { error: error.message, code: error.code },
        error.status,
      );
    console.error(JSON.stringify({ event: "message_submission_failed" }));
    return productJson(
      {
        error: "Your question could not be submitted. Please try again.",
        code: "submission_failed",
      },
      503,
    );
  }
}
