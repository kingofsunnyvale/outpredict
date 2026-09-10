import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleChatApi } from "../src/chat-api";
import {
  beginMessagePair,
  cancelGeneration,
  createChat,
  deleteAttachment,
  deleteChat,
  finishMessage,
  getAttachment,
  getChat,
  getChatContext,
  listChats,
  renewGenerationLease,
  saveMessageProgress,
} from "../src/chat-store";
import {
  type Attachment,
  PRODUCT_LIMITS,
  type VerifiedUser,
} from "../src/product-types";

const origin = "https://outpredict-staging.anywager.workers.dev";

async function account(): Promise<VerifiedUser> {
  const id = crypto.randomUUID();
  const user = { id, name: "Applicant", email: `${id}@example.com` };
  await env.DB.prepare(
    'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
  )
    .bind(id, user.name, user.email, Date.now(), Date.now())
    .run();
  return user;
}

async function api(
  user: VerifiedUser,
  path: string,
  method = "GET",
  body?: BodyInit,
) {
  const response = await handleChatApi(
    new Request(`${origin}${path}`, {
      method,
      body,
      headers: { Origin: origin },
    }),
    env,
    user,
  );
  if (!response) throw new Error("Route was not handled");
  return response;
}

async function upload(
  user: VerifiedUser,
  name = "resume.txt",
  body:
    | string
    | Uint8Array<ArrayBuffer> = "GPA 3.75. MCAT 515. Clinical volunteering: 250 completed hours.",
  chatId?: string,
) {
  const data = new FormData();
  data.set("file", new File([body], name));
  if (chatId) data.set("chatId", chatId);
  const response = await api(user, "/api/attachments", "POST", data);
  return {
    response,
    attachment: (await response.json<{ attachment: Attachment }>()).attachment,
  };
}

describe("private persistent conversations", () => {
  it("creates, lists, reopens, and deletes only the verified owner's chats", async () => {
    const alice = await account();
    const bob = await account();
    const response = await api(
      alice,
      "/api/chats",
      "POST",
      JSON.stringify({ title: "School list", userId: bob.id }),
    );
    expect(response.status).toBe(201);
    const { chat } = await response.json<{ chat: { id: string } }>();
    expect((await api(alice, `/api/chats/${chat.id}`)).status).toBe(200);
    expect((await api(bob, `/api/chats/${chat.id}`)).status).toBe(404);
    expect((await api(bob, `/api/chats/${chat.id}`, "DELETE")).status).toBe(
      404,
    );
    expect(await (await api(bob, "/api/chats")).json()).toEqual({ chats: [] });
    expect((await api(alice, `/api/chats/${chat.id}`, "DELETE")).status).toBe(
      200,
    );
    expect((await api(alice, `/api/chats/${chat.id}`)).status).toBe(404);
  });

  it("requires an exact trusted origin for mutations", async () => {
    const user = await account();
    const response = await handleChatApi(
      new Request(`${origin}/api/chats`, {
        method: "POST",
        body: "{}",
        headers: { Origin: "https://attacker.example" },
      }),
      env,
      user,
    );
    expect(response?.status).toBe(403);
  });

  it("atomically reuses a message pair for concurrent retries and fences cancellation", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const input = {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Help me plan my next year.",
    };
    const pairs = await Promise.all([
      beginMessagePair(env, user.id, input),
      beginMessagePair(env, user.id, input),
    ]);
    expect(pairs[0]?.assistantMessage.id).toBe(pairs[1]?.assistantMessage.id);
    expect(pairs.filter((pair) => pair.created)).toHaveLength(1);
    const pair = pairs[0];
    if (!pair) throw new Error("Missing pair");
    expect((await getChat(env, user.id, chat.id)).messages).toHaveLength(2);
    await expect(
      beginMessagePair(env, user.id, {
        ...input,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      beginMessagePair(env, user.id, {
        ...input,
        content: "Different question",
      }),
    ).rejects.toMatchObject({ code: "request_conflict" });
    expect(
      await saveMessageProgress(
        env,
        user.id,
        chat.id,
        pair.assistantMessage.id,
        "Partial guidance",
      ),
    ).toBe(true);
    await cancelGeneration(env, user.id, chat.id);
    expect(
      await finishMessage(
        env,
        user.id,
        chat.id,
        pair.assistantMessage.id,
        "Late answer",
        "complete",
      ),
    ).toBe(false);
    const reopened = await getChat(env, user.id, chat.id);
    expect(reopened.messages[1]).toMatchObject({
      status: "cancelled",
      content: "Partial guidance",
    });
  });

  it("recovers expired streams and prevents an old writer from changing a new turn", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const old = await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "First question",
    });
    await saveMessageProgress(
      env,
      user.id,
      chat.id,
      old.assistantMessage.id,
      "Saved partial text",
    );
    await env.DB.prepare("UPDATE chat SET lease_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, chat.id)
      .run();
    const reopened = await getChat(env, user.id, chat.id);
    expect(reopened.messages[1]).toMatchObject({
      status: "failed",
      content: "Saved partial text",
    });
    const next = await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Second question",
    });
    expect(
      await renewGenerationLease(
        env,
        user.id,
        chat.id,
        old.assistantMessage.id,
      ),
    ).toBe(false);
    expect(
      await renewGenerationLease(
        env,
        user.id,
        chat.id,
        next.assistantMessage.id,
      ),
    ).toBe(true);
    expect(
      await finishMessage(
        env,
        user.id,
        chat.id,
        old.assistantMessage.id,
        "Stale answer",
        "complete",
      ),
    ).toBe(false);
    expect(
      await finishMessage(
        env,
        user.id,
        chat.id,
        next.assistantMessage.id,
        "Useful answer",
        "complete",
        { sources: [] },
      ),
    ).toBe(true);
  });

  it("enforces daily and conversation limits without resetting usage on deletion", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const day = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare(
      "INSERT INTO daily_usage (user_id,day,requests) VALUES (?,?,?)",
    )
      .bind(user.id, day, PRODUCT_LIMITS.requestsPerDay)
      .run();
    await expect(
      beginMessagePair(env, user.id, {
        chatId: chat.id,
        requestId: crypto.randomUUID(),
        content: "One more question",
      }),
    ).rejects.toMatchObject({ status: 429 });
    await deleteChat(env, user.id, chat.id);
    const next = await createChat(env, user.id);
    await expect(
      beginMessagePair(env, user.id, {
        chatId: next.id,
        requestId: crypto.randomUUID(),
        content: "Still limited",
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect((await getChat(env, user.id, next.id)).messages).toHaveLength(0);
  });

  it("retries a cancelled request without duplicating messages or accepting old writes", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const input = {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Plan my next year",
    };
    const first = await beginMessagePair(env, user.id, input);
    await saveMessageProgress(
      env,
      user.id,
      chat.id,
      first.assistantMessage.id,
      "Old partial",
      { sources: [], notes: ["Old evidence"] },
    );
    await cancelGeneration(env, user.id, chat.id);
    const outcomes = await Promise.all([
      beginMessagePair(env, user.id, { ...input, retry: true }),
      beginMessagePair(env, user.id, { ...input, retry: true }),
    ]);
    expect(outcomes.filter((pair) => pair.created)).toHaveLength(1);
    const retried = outcomes.find((pair) => pair.created);
    expect(retried?.userMessage.id).toBe(first.userMessage.id);
    expect(retried?.assistantMessage.id).not.toBe(first.assistantMessage.id);
    expect(retried?.assistantMessage).toMatchObject({
      content: "",
      status: "running",
      evidence: null,
    });
    expect((await getChat(env, user.id, chat.id)).messages).toHaveLength(2);
    expect(
      await saveMessageProgress(
        env,
        user.id,
        chat.id,
        first.assistantMessage.id,
        "Late first answer",
      ),
    ).toBe(false);
  });
});

describe("generation recovery and fenced cancellation", () => {
  it("reconciles an expired generation before a direct retry with the same request ID", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const input = {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Compare my application",
    };
    const first = await beginMessagePair(env, user.id, input);
    await env.DB.prepare("UPDATE chat SET lease_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, chat.id)
      .run();
    const retry = await beginMessagePair(env, user.id, {
      ...input,
      retry: true,
    });
    expect(retry.created).toBe(true);
    expect(retry.assistantMessage.id).not.toBe(first.assistantMessage.id);
  });

  it("rejects an unfenced stop and ignores a delayed stop from a previous attempt", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const input = {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Help me make a plan",
    };
    const first = await beginMessagePair(env, user.id, input);
    expect(
      (await api(user, `/api/chats/${chat.id}/cancel`, "POST", "{}")).status,
    ).toBe(400);
    await cancelGeneration(env, user.id, chat.id, first.assistantMessage.id);
    const retry = await beginMessagePair(env, user.id, {
      ...input,
      retry: true,
    });
    const delayed = await api(
      user,
      `/api/chats/${chat.id}/cancel`,
      "POST",
      JSON.stringify({ generationId: first.assistantMessage.id }),
    );
    expect(await delayed.json()).toEqual({ cancelled: false });
    expect(
      await renewGenerationLease(
        env,
        user.id,
        chat.id,
        retry.assistantMessage.id,
      ),
    ).toBe(true);
    expect((await getChat(env, user.id, chat.id)).messages.at(-1)?.status).toBe(
      "running",
    );
  });
});

describe("recoverable conversation removal", () => {
  it("retries transient R2 deletion on the next history load and frees the saved-chat slot", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const { attachment } = await upload(user, "resume.txt", undefined, chat.id);
    const original = await getAttachment(env, user.id, attachment.id);
    await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Review this file",
      attachmentIds: [attachment.id],
    });
    await env.DB.batch(
      Array.from({ length: 99 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO chat (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          user.id,
          `Other ${index}`,
          Date.now(),
          Date.now(),
        ),
      ),
    );
    const removal = vi
      .spyOn(env.DATA, "delete")
      .mockRejectedValueOnce(new Error("Temporary R2 failure"));
    try {
      await expect(deleteChat(env, user.id, chat.id)).rejects.toThrow(
        "Temporary R2 failure",
      );
      await expect(getChat(env, user.id, chat.id)).rejects.toMatchObject({
        status: 404,
      });
      const history = await listChats(env, user.id);
      expect(history).toHaveLength(99);
      expect(history.some((item) => item.id === chat.id)).toBe(false);
      expect(await env.DATA.get(original.r2_key)).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM message WHERE chat_id=?",
        )
          .bind(chat.id)
          .first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM attachment WHERE chat_id=?",
        )
          .bind(chat.id)
          .first("n"),
      ).toBe(0);
      await expect(createChat(env, user.id)).resolves.toMatchObject({
        title: "New conversation",
      });
    } finally {
      removal.mockRestore();
    }
  });

  it("surfaces a still-failing removal in history without reopening private content", async () => {
    const user = await account();
    const chat = await createChat(env, user.id, "Remove this conversation");
    await upload(user, "resume.txt", undefined, chat.id);
    const removal = vi
      .spyOn(env.DATA, "delete")
      .mockRejectedValue(new Error("Persistent R2 failure"));
    try {
      await expect(deleteChat(env, user.id, chat.id)).rejects.toThrow();
      const history = await listChats(env, user.id);
      expect(history.find((item) => item.id === chat.id)).toMatchObject({
        deletionPending: true,
        title: "Remove this conversation",
      });
      await expect(getChat(env, user.id, chat.id)).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      removal.mockRestore();
    }
    expect(
      (await listChats(env, user.id)).some((item) => item.id === chat.id),
    ).toBe(false);
  });
});

describe("private optional attachments", () => {
  it("reconciles only stale owned processing uploads while preserving originals and usage", async () => {
    const alice = await account();
    const bob = await account();
    const chat = await createChat(env, alice.id);
    const stale = (await upload(alice, "stale.txt", undefined, chat.id))
      .attachment;
    const recent = (await upload(alice, "recent.txt")).attachment;
    const ready = (await upload(alice, "ready.txt")).attachment;
    const foreign = (await upload(bob)).attachment;
    const past = Date.now() - 180_001;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE attachment SET status = 'processing', extracted_text = NULL, created_at = ? WHERE id IN (?,?)",
      ).bind(past, stale.id, foreign.id),
      env.DB.prepare(
        "UPDATE attachment SET status = 'processing', extracted_text = NULL WHERE id = ?",
      ).bind(recent.id),
    ]);
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS files, SUM(size) AS bytes FROM attachment WHERE user_id = ?",
    )
      .bind(alice.id)
      .first();
    const detail = await api(alice, `/api/chats/${chat.id}`);
    expect(
      (await detail.json<{ attachments: Attachment[] }>()).attachments[0],
    ).toMatchObject({
      id: stale.id,
      status: "failed",
      error: expect.stringContaining("interrupted"),
    });
    const listed = await (await api(alice, "/api/attachments")).json<{
      attachments: Attachment[];
    }>();
    expect(
      listed.attachments.find((file) => file.id === recent.id)?.status,
    ).toBe("processing");
    expect(
      listed.attachments.find((file) => file.id === ready.id)?.status,
    ).toBe("ready");
    expect((await getAttachment(env, bob.id, foreign.id)).status).toBe(
      "processing",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS files, SUM(size) AS bytes FROM attachment WHERE user_id = ?",
      )
        .bind(alice.id)
        .first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
      )
        .bind(alice.id, Math.floor(Date.now() / 86_400_000))
        .first("requests"),
    ).toBe(3);
    expect(
      await (
        await api(alice, `/api/attachments/${stale.id}?download=1`)
      ).text(),
    ).toContain("250 completed hours");
    expect(
      (await getChatContext(env, alice.id, chat.id)).documents,
    ).toHaveLength(0);
    await expect(
      beginMessagePair(env, alice.id, {
        chatId: chat.id,
        requestId: crypto.randomUUID(),
        content: "Use this interrupted upload",
        attachmentIds: [stale.id],
      }),
    ).rejects.toMatchObject({ code: "attachment_unavailable" });
    await api(alice, `/api/attachments/${stale.id}`, "DELETE");
    expect((await api(alice, `/api/attachments/${stale.id}`)).status).toBe(404);
  });

  it.each(["success", "failure"])(
    "does not resurrect or delete a reconciled original after late extraction %s",
    async (outcome) => {
      const user = await account();
      type Conversion = {
        id: string;
        name: string;
        mimeType: string;
        format: "markdown";
        tokens: number;
        data: string;
      };
      let complete!: (value: Conversion) => void;
      let fail!: (error: Error) => void;
      let started!: () => void;
      const readyToReconcile = new Promise<void>((resolve) => {
        started = resolve;
      });
      const deferred = new Promise<Conversion>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      const conversion = vi
        .spyOn(env.AI, "toMarkdown")
        .mockImplementation(async () => {
          started();
          return deferred;
        });
      const pending = upload(
        user,
        "resume.pdf",
        "%PDF-1.7\nsynthetic interrupted PDF",
      );
      const value: Conversion = {
        id: "converted",
        name: "resume.pdf",
        mimeType: "application/pdf",
        format: "markdown",
        tokens: 10,
        data: "Completed clinical volunteering: 250 hours.",
      };
      try {
        await readyToReconcile;
        const row = await env.DB.prepare(
          "SELECT id, r2_key FROM attachment WHERE user_id = ?",
        )
          .bind(user.id)
          .first<{ id: string; r2_key: string }>();
        if (!row) throw new Error("The upload was not reserved");
        await env.DB.prepare(
          "UPDATE attachment SET created_at = ? WHERE id = ?",
        )
          .bind(Date.now() - 180_001, row.id)
          .run();
        const reconciled = await (
          await api(user, `/api/attachments/${row.id}`)
        ).json<{ attachment: Attachment }>();
        expect(reconciled.attachment.status).toBe("failed");
        if (outcome === "success") complete(value);
        else fail(new Error("late provider failure"));
        const result = await pending;
        expect(result.attachment).toMatchObject({
          id: row.id,
          status: "failed",
          error: expect.stringContaining("interrupted"),
        });
        expect(
          (await getAttachment(env, user.id, row.id)).extracted_text,
        ).toBeNull();
        expect(await env.DATA.get(row.r2_key)).not.toBeNull();
        expect(
          await env.DB.prepare(
            "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
          )
            .bind(user.id, Math.floor(Date.now() / 86_400_000))
            .first("requests"),
        ).toBe(1);
      } finally {
        complete(value);
        await pending.catch(() => undefined);
        conversion.mockRestore();
      }
    },
  );

  it("extracts text, keeps originals private, and removes files from future context", async () => {
    const alice = await account();
    const bob = await account();
    const chat = await createChat(env, alice.id);
    const { response, attachment } = await upload(
      alice,
      "resume.txt",
      undefined,
      chat.id,
    );
    expect(response.status).toBe(201);
    expect(attachment.status).toBe("ready");
    expect(
      (await api(bob, `/api/attachments/${attachment.id}?download=1`)).status,
    ).toBe(404);
    expect(
      (await api(bob, `/api/attachments/${attachment.id}`, "DELETE")).status,
    ).toBe(404);
    const original = await api(
      alice,
      `/api/attachments/${attachment.id}?download=1`,
    );
    expect(original.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await original.text()).toContain("250 completed hours");
    const pair = await beginMessagePair(env, alice.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Compare my clinical experience",
      attachmentIds: [attachment.id],
    });
    expect(
      (await getChatContext(env, alice.id, chat.id)).documents[0]?.text,
    ).toContain("MCAT 515");
    const row = await getAttachment(env, alice.id, attachment.id);
    await deleteAttachment(env, alice.id, attachment.id);
    expect(
      (await getChatContext(env, alice.id, chat.id)).documents,
    ).toHaveLength(0);
    expect(await env.DATA.get(row.r2_key)).toBeNull();
    expect(
      await saveMessageProgress(
        env,
        alice.id,
        chat.id,
        pair.assistantMessage.id,
        "Stale file answer",
      ),
    ).toBe(false);
  });

  it("rejects other users' attachments, excessive attachments, and wrong-chat files", async () => {
    const alice = await account();
    const bob = await account();
    const chat = await createChat(env, alice.id);
    const bobFile = await upload(bob);
    await expect(
      beginMessagePair(env, alice.id, {
        chatId: chat.id,
        requestId: crypto.randomUUID(),
        content: "Use these files",
        attachmentIds: [bobFile.attachment.id],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      beginMessagePair(env, alice.id, {
        chatId: chat.id,
        requestId: crypto.randomUUID(),
        content: "Use these files",
        attachmentIds: ["a", "b", "c", "d", "e"],
      }),
    ).rejects.toMatchObject({ code: "attachment_limit" });
    const other = await createChat(env, alice.id);
    const otherFile = await upload(alice, "resume.txt", undefined, other.id);
    await expect(
      beginMessagePair(env, alice.id, {
        chatId: chat.id,
        requestId: crypto.randomUUID(),
        content: "Use these files",
        attachmentIds: [otherFile.attachment.id],
      }),
    ).rejects.toMatchObject({ code: "attachment_unavailable" });
  });

  it("rejects unsupported, forged, empty, oversized, and malformed uploads", async () => {
    const user = await account();
    for (const [name, content, expected] of [
      ["program.exe", "executable", 415],
      ["fake.pdf", "this is not PDF", 415],
      ["empty.txt", "", 400],
    ] as const) {
      expect((await upload(user, name, content)).response.status).toBe(
        expected,
      );
    }
    const response = await api(
      user,
      "/api/attachments",
      "POST",
      "not multipart",
    );
    expect(response.status).toBe(415);
    const tooLarge = await handleChatApi(
      new Request(`${origin}/api/attachments`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "multipart/form-data; boundary=test",
          "Content-Length": String(PRODUCT_LIMITS.fileBytes + 100_000),
        },
        body: "small actual body",
      }),
      env,
      user,
    );
    expect(tooLarge?.status).toBe(413);
  });

  it("detects scanned empty PDFs and stores safe extraction errors without sending private content elsewhere", async () => {
    const user = await account();
    const conversion = vi.spyOn(env.AI, "toMarkdown").mockResolvedValue({
      id: "test",
      name: "scan.pdf",
      mimeType: "application/pdf",
      format: "markdown",
      tokens: 10,
      data: "# scan.pdf\n## Contents\n### Page 1\n ",
    });
    try {
      const result = await upload(
        user,
        "scan.pdf",
        "%PDF-1.7\nsynthetic scanned PDF fixture",
      );
      expect(result.attachment.status).toBe("failed");
      expect(result.attachment.error).toContain("PNG/JPEG");
      const stored = await getAttachment(env, user.id, result.attachment.id);
      expect(stored.extracted_text).toBeNull();
      expect(await env.DATA.get(stored.r2_key)).not.toBeNull();
      await deleteAttachment(env, user.id, result.attachment.id);
      expect(await env.DATA.get(stored.r2_key)).toBeNull();
    } finally {
      conversion.mockRestore();
    }
  });

  it("removes a chat's originals and cascades messages and attachment text", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const { attachment } = await upload(user, "resume.md", undefined, chat.id);
    const stored = await getAttachment(env, user.id, attachment.id);
    await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Analyze my file",
      attachmentIds: [attachment.id],
    });
    await deleteChat(env, user.id, chat.id);
    expect(await env.DATA.get(stored.r2_key)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM message WHERE chat_id = ?",
      )
        .bind(chat.id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM attachment WHERE chat_id = ?",
      )
        .bind(chat.id)
        .first("n"),
    ).toBe(0);
  });

  it("reserves storage atomically and refuses uploads at the user's cap", async () => {
    const user = await account();
    await env.DB.batch(
      Array.from({ length: PRODUCT_LIMITS.filesPerUser }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO attachment (id,user_id,name,type,size,r2_key,status,created_at) VALUES (?,?,?,'text/plain',1,?,'failed',?)",
        ).bind(
          crypto.randomUUID(),
          user.id,
          `old-${i}.txt`,
          `fixture/${user.id}/${i}`,
          Date.now(),
        ),
      ),
    );
    const result = await upload(user);
    expect(result.response.status).toBe(429);
  });

  it("keeps daily upload attempts after repeated file and conversation deletion", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    for (let i = 0; i < PRODUCT_LIMITS.conversionRequestsPerDay; i++) {
      const { response, attachment } = await upload(
        user,
        "resume.txt",
        undefined,
        chat.id,
      );
      expect(response.status).toBe(201);
      await deleteAttachment(env, user.id, attachment.id);
    }
    await deleteChat(env, user.id, chat.id);
    const data = new FormData();
    data.set(
      "file",
      new File(
        ["A valid résumé with completed clinical experience."],
        "resume.txt",
      ),
    );
    const blocked = await api(user, "/api/attachments", "POST", data);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      code: "conversion_usage_limit",
      error: expect.stringContaining("20 file upload attempts"),
    });
    expect(
      await env.DB.prepare(
        "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
      )
        .bind(user.id, Math.floor(Date.now() / 86_400_000))
        .first("requests"),
    ).toBe(PRODUCT_LIMITS.conversionRequestsPerDay);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM attachment WHERE user_id = ?",
      )
        .bind(user.id)
        .first("n"),
    ).toBe(0);
  });

  it("atomically reserves the last daily upload and resets on the next UTC day", async () => {
    const user = await account();
    const now = Date.now();
    const day = Math.floor(now / 86_400_000);
    await env.DB.prepare("INSERT INTO daily_file_usage VALUES (?,?,?)")
      .bind(user.id, day, PRODUCT_LIMITS.conversionRequestsPerDay - 1)
      .run();
    const results = await Promise.all([upload(user), upload(user)]);
    expect(results.map((result) => result.response.status).sort()).toEqual([
      201, 429,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
      )
        .bind(user.id, day)
        .first("requests"),
    ).toBe(PRODUCT_LIMITS.conversionRequestsPerDay);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    try {
      expect((await upload(user)).response.status).toBe(201);
      expect(
        await env.DB.prepare(
          "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
        )
          .bind(user.id, day + 1)
          .first("requests"),
      ).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("charges failed document conversion before provider work and never calls the provider above the limit", async () => {
    const user = await account();
    const day = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare("INSERT INTO daily_file_usage VALUES (?,?,?)")
      .bind(user.id, day, PRODUCT_LIMITS.conversionRequestsPerDay - 1)
      .run();
    const conversion = vi
      .spyOn(env.AI, "toMarkdown")
      .mockImplementation(async () => {
        expect(
          await env.DB.prepare(
            "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
          )
            .bind(user.id, day)
            .first("requests"),
        ).toBe(PRODUCT_LIMITS.conversionRequestsPerDay);
        throw new Error("Synthetic conversion failure");
      });
    try {
      const failed = await upload(
        user,
        "resume.pdf",
        "%PDF-1.7 Synthetic conversion test",
      );
      expect(failed.attachment.status).toBe("failed");
      await deleteAttachment(env, user.id, failed.attachment.id);
      expect(
        (
          await upload(
            user,
            "resume.pdf",
            "%PDF-1.7 Another conversion attempt",
          )
        ).response.status,
      ).toBe(429);
      expect(conversion).toHaveBeenCalledTimes(1);
    } finally {
      conversion.mockRestore();
    }
  });

  it("claims an unattached upload for only one simultaneous conversation", async () => {
    const user = await account();
    const first = await createChat(env, user.id);
    const second = await createChat(env, user.id);
    const { attachment } = await upload(user);
    const outcomes = await Promise.allSettled(
      [first, second].map((chat) =>
        beginMessagePair(env, user.id, {
          chatId: chat.id,
          requestId: crypto.randomUUID(),
          content: "Review this résumé",
          attachmentIds: [attachment.id],
        }),
      ),
    );
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM message m JOIN chat c ON c.id = m.chat_id WHERE c.user_id = ?",
    )
      .bind(user.id)
      .first("n");
    expect(total).toBe(2);
  });

  it("scrubs removed file excerpts before storage cleanup while preserving other sources and answer prose", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const removed = (await upload(user, "remove.txt", undefined, chat.id))
      .attachment;
    const retained = (await upload(user, "keep.txt", undefined, chat.id))
      .attachment;
    const pair = await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Review these documents",
      attachmentIds: [removed.id, retained.id],
    });
    await saveMessageProgress(
      env,
      user.id,
      chat.id,
      pair.assistantMessage.id,
      "Existing answer prose remains until this conversation is deleted.",
      {
        sources: [
          {
            id: "A1",
            kind: "attachment",
            title: "remove.txt",
            attachmentId: removed.id,
            excerpt: "Removed private excerpt",
          },
          {
            id: "A2",
            kind: "attachment",
            title: "keep.txt",
            attachmentId: retained.id,
            excerpt: "Retained private excerpt",
          },
          {
            id: "A3",
            kind: "attachment",
            title: "Legacy file",
            excerpt: "Legacy private excerpt without a stable ID",
          },
          {
            id: "W1",
            kind: "official",
            title: "Public requirements",
            url: "https://aamc.org/",
            excerpt: "Public source excerpt",
          },
        ],
        notes: ["Retain the evidence metadata."],
      },
    );
    const deletion = vi
      .spyOn(env.DATA, "delete")
      .mockRejectedValueOnce(new Error("Synthetic R2 cleanup failure"));
    try {
      await expect(deleteAttachment(env, user.id, removed.id)).rejects.toThrow(
        "Synthetic R2 cleanup failure",
      );
      const context = await getChatContext(env, user.id, chat.id);
      const answer = context.messages.find(
        (message) => message.id === pair.assistantMessage.id,
      );
      expect(answer?.status).toBe("cancelled");
      expect(answer?.content).toContain("Existing answer prose remains");
      expect(answer?.evidence?.sources.map((source) => source.id)).toEqual([
        "A2",
        "W1",
      ]);
      expect(answer?.evidence?.notes).toEqual([
        "Retain the evidence metadata.",
      ]);
      expect(context.documents.map((document) => document.id)).toEqual([
        retained.id,
      ]);
      expect(
        await saveMessageProgress(
          env,
          user.id,
          chat.id,
          pair.assistantMessage.id,
          "Late writer",
          {
            sources: [
              {
                id: "A1",
                kind: "attachment",
                title: "remove.txt",
                attachmentId: removed.id,
                excerpt: "Cannot restore deleted excerpt",
              },
            ],
          },
        ),
      ).toBe(false);
      await deleteAttachment(env, user.id, removed.id);
      expect(
        (await getChat(env, user.id, chat.id)).messages[1]?.evidence?.sources,
      ).toHaveLength(2);
    } finally {
      deletion.mockRestore();
    }
  });

  it("cancels a turn that claims an unused file while deletion is starting", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const { attachment } = await upload(user);
    expect(attachment.chatId).toBeNull();
    const originalBatch = env.DB.batch.bind(env.DB);
    const batch = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        // deleteAttachment has read the unused file. Claim it before the removal
        // transaction to exercise the real interleaving of these two requests.
        const pair = await beginMessagePair(env, user.id, {
          chatId: chat.id,
          requestId: crypto.randomUUID(),
          content: "Review this newly attached file",
          attachmentIds: [attachment.id],
        });
        await saveMessageProgress(
          env,
          user.id,
          chat.id,
          pair.assistantMessage.id,
          "Partial answer",
          {
            sources: [
              {
                id: "A1",
                kind: "attachment",
                title: attachment.name,
                attachmentId: attachment.id,
                excerpt: "Private text from the claimed file",
              },
            ],
          },
        );
        return originalBatch(statements);
      });
    try {
      await deleteAttachment(env, user.id, attachment.id);
      const context = await getChatContext(env, user.id, chat.id);
      expect(context.chat.generationId).toBeNull();
      expect(context.messages[1]?.status).toBe("cancelled");
      expect(context.messages[1]?.evidence?.sources).toEqual([]);
      expect(context.documents).toEqual([]);
    } finally {
      batch.mockRestore();
    }
  });

  it("keeps failed storage cleanup retryable and excludes deleted text immediately", async () => {
    const user = await account();
    const chat = await createChat(env, user.id);
    const { attachment } = await upload(user, "resume.txt", undefined, chat.id);
    await beginMessagePair(env, user.id, {
      chatId: chat.id,
      requestId: crypto.randomUUID(),
      content: "Review this résumé",
      attachmentIds: [attachment.id],
    });
    const stored = await getAttachment(env, user.id, attachment.id);
    const deletion = vi
      .spyOn(env.DATA, "delete")
      .mockRejectedValueOnce(new Error("Synthetic R2 failure"));
    try {
      await expect(
        deleteAttachment(env, user.id, attachment.id),
      ).rejects.toThrow("Synthetic R2 failure");
      expect(
        (await getChatContext(env, user.id, chat.id)).documents,
      ).toHaveLength(0);
      expect(
        (await getAttachment(env, user.id, attachment.id)).extracted_text,
      ).toBeNull();
      await deleteAttachment(env, user.id, attachment.id);
      expect(await env.DATA.get(stored.r2_key)).toBeNull();
    } finally {
      deletion.mockRestore();
    }
  });

  it("persists an honest error when the conversion provider fails", async () => {
    const user = await account();
    const conversion = vi
      .spyOn(env.AI, "toMarkdown")
      .mockRejectedValue(
        new Error("Synthetic provider failure with private diagnostic"),
      );
    try {
      const result = await upload(
        user,
        "resume.pdf",
        "%PDF-1.7 synthetic PDF fixture",
      );
      expect(result.attachment).toMatchObject({ status: "failed" });
      expect(result.attachment.error).toContain("temporarily unavailable");
      expect(result.attachment.error).not.toContain("private diagnostic");
    } finally {
      conversion.mockRestore();
    }
  });
});
