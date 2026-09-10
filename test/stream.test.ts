import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChat, getChat } from "../src/chat-store";
import { handleChatStream } from "../src/chat-stream";

const origin = "https://outpredict-staging.anywager.workers.dev";

afterEach(() => vi.unstubAllGlobals());

async function fixture(replies: unknown[]) {
  const id = crypto.randomUUID();
  const user = { id, name: "Stream applicant", email: `${id}@example.com` };
  await env.DB.prepare(
    'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
  )
    .bind(id, user.name, user.email, Date.now(), Date.now())
    .run();
  const chat = await createChat(env, user.id);
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(JSON.parse(String(init.body)).store).toBe(false);
      calls++;
      if (!replies.length) throw new Error("Provider unavailable");
      const reply = replies.shift();
      return reply instanceof ReadableStream
        ? new Response(reply, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(reply);
    }),
  );
  return {
    user,
    chat,
    bindings: { ...env, OPENAI_API_KEY: "synthetic-openai-test-key" },
    calls: () => calls,
  };
}

function answer(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        ),
      );
      controller.close();
    },
  });
}

function request(chatId: string, body: unknown) {
  return new Request(`${origin}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("persisted streaming boundary", () => {
  it("streams and persists one answer, replays a completed retry without another inference", async () => {
    const item = await fixture([
      { choices: [{ finish_reason: "stop", message: { content: "READY" } }] },
      answer(
        "A useful starting point: describe your role and what you learned.",
      ),
    ]);
    const body = {
      content: "Help me improve an activity description.",
      requestId: crypto.randomUUID(),
    };
    const context = createExecutionContext();
    const response = await handleChatStream(
      request(item.chat.id, body),
      item.bindings,
      item.user,
      context,
    );
    const wire = await response?.text();
    await waitOnExecutionContext(context);
    expect(response?.status).toBe(200);
    expect(wire).toContain('"type":"meta"');
    expect(wire).toContain('"type":"delta"');
    expect(wire).toContain('"status":"complete"');
    const saved = await getChat(env, item.user.id, item.chat.id);
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]?.content).toContain("what you learned");
    expect(saved.chat.generationId).toBeNull();
    const calls = item.calls();
    expect(calls).toBe(2);
    const retryContext = createExecutionContext();
    const retry = await handleChatStream(
      request(item.chat.id, body),
      item.bindings,
      item.user,
      retryContext,
    );
    expect(await retry?.text()).toContain("what you learned");
    await waitOnExecutionContext(retryContext);
    expect(item.calls()).toBe(calls);
    expect(
      (await getChat(env, item.user.id, item.chat.id)).messages,
    ).toHaveLength(2);
  });

  it("keeps provider failures retryable and does not duplicate the question", async () => {
    const item = await fixture([]);
    const body = {
      content: "What should I work on next?",
      requestId: crypto.randomUUID(),
    };
    const context = createExecutionContext();
    const response = await handleChatStream(
      request(item.chat.id, body),
      item.bindings,
      item.user,
      context,
    );
    expect(await response?.text()).toContain('"code":"generation_failed"');
    await waitOnExecutionContext(context);
    const saved = await getChat(env, item.user.id, item.chat.id);
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]?.status).toBe("failed");
    expect(saved.chat.generationId).toBeNull();
  });

  it("rejects cross-user submissions and malformed or cross-origin requests", async () => {
    const item = await fixture([]);
    const stranger = await fixture([]);
    const body = { content: "hello", requestId: crypto.randomUUID() };
    const context = createExecutionContext();
    const foreign = await handleChatStream(
      request(item.chat.id, body),
      item.bindings,
      stranger.user,
      context,
    );
    expect(foreign?.status).toBe(404);
    const malformed = await handleChatStream(
      request(item.chat.id, { content: "hello" }),
      item.bindings,
      item.user,
      context,
    );
    expect(malformed?.status).toBe(400);
    const hostile = request(item.chat.id, body);
    hostile.headers.set("Origin", "https://example.com");
    expect(
      (await handleChatStream(hostile, item.bindings, item.user, context))
        ?.status,
    ).toBe(403);
    expect(item.calls()).toBe(0);
  });
});
