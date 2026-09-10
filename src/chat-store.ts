import {
  type Attachment,
  type Chat,
  type Evidence,
  type Message,
  type MessageStatus,
  PRODUCT_LIMITS,
  ProductError,
} from "./product-types";

type ChatRow = {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  generation_id: string | null;
  lease_expires_at: number | null;
  deleting_at: number | null;
};
type MessageRow = {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  client_request_id: string | null;
  reply_to_id: string | null;
  evidence_json: string | null;
  created_at: number;
  updated_at: number;
};
export type AttachmentRow = {
  id: string;
  user_id: string;
  chat_id: string | null;
  message_id: string | null;
  name: string;
  type: string;
  size: number;
  r2_key: string;
  extracted_text: string | null;
  status: Attachment["status"];
  error: string | null;
  created_at: number;
};

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generationId: row.generation_id,
    ...(row.deleting_at === null ? {} : { deletionPending: true }),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    status: row.status,
    requestId: row.client_request_id,
    replyToId: row.reply_to_id,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function attachmentMetadata(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    name: row.name,
    type: row.type,
    size: row.size,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function ownedChat(env: Env, userId: string, chatId: string) {
  const chat = await env.DB.prepare(
    "SELECT * FROM chat WHERE id = ? AND user_id = ? AND deleting_at IS NULL",
  )
    .bind(chatId, userId)
    .first<ChatRow>();
  if (!chat)
    throw new ProductError(404, "Conversation not found.", "not_found");
  return chat;
}

export async function createChat(
  env: Env,
  userId: string,
  title = "New conversation",
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO chat (id,user_id,title,created_at,updated_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM chat WHERE user_id = ?) < ?",
  )
    .bind(
      id,
      userId,
      title.trim().slice(0, 100) || "New conversation",
      now,
      now,
      userId,
      PRODUCT_LIMITS.chatsPerUser,
    )
    .run();
  if (!result.meta.changes)
    throw new ProductError(
      429,
      "You have reached 100 saved conversations. Delete one to start another.",
      "chat_limit",
    );
  return toChat(await ownedChat(env, userId, id));
}

/** Called on reads and before a new turn; interrupted requests retain partial text. */
export async function reconcileExpiredGenerations(env: Env, userId: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE message SET status = 'failed', updated_at = ? WHERE status IN ('pending','running') AND id IN (SELECT generation_id FROM chat WHERE user_id = ? AND lease_expires_at <= ?)",
    ).bind(now, userId, now),
    env.DB.prepare(
      "UPDATE chat SET generation_id = NULL, lease_expires_at = NULL WHERE user_id = ? AND lease_expires_at <= ?",
    ).bind(userId, now),
  ]);
}

export async function listChats(env: Env, userId: string) {
  await reconcileExpiredGenerations(env, userId);
  await retryPendingChatDeletions(env, userId);
  const result = await env.DB.prepare(
    "SELECT * FROM chat WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
  )
    .bind(userId, PRODUCT_LIMITS.chatsPerUser)
    .all<ChatRow>();
  return result.results.map(toChat);
}

/** Retry a bounded number of failed R2 removals. Pending rows stay visible as
 * removal controls, while ownedChat continues to block reading their content. */
async function retryPendingChatDeletions(env: Env, userId: string) {
  const pending = await env.DB.prepare(
    "SELECT id FROM chat WHERE user_id = ? AND deleting_at IS NOT NULL ORDER BY deleting_at LIMIT 10",
  )
    .bind(userId)
    .all<{ id: string }>();
  await Promise.all(
    pending.results.map(async ({ id }) => {
      try {
        await deleteChat(env, userId, id);
      } catch {
        console.warn(
          JSON.stringify({ event: "chat_removal_retry_failed", chatId: id }),
        );
      }
    }),
  );
}

export async function getChat(env: Env, userId: string, chatId: string) {
  await reconcileExpiredGenerations(env, userId);
  const chat = await ownedChat(env, userId, chatId);
  const [messages, attachments] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM message WHERE chat_id = ? ORDER BY created_at, rowid",
    )
      .bind(chatId)
      .all<MessageRow>(),
    env.DB.prepare(
      "SELECT * FROM attachment WHERE chat_id = ? AND user_id = ? ORDER BY created_at",
    )
      .bind(chatId, userId)
      .all<AttachmentRow>(),
  ]);
  return {
    chat: toChat(chat),
    messages: messages.results.map(toMessage),
    attachments: attachments.results.map(attachmentMetadata),
  };
}

export async function deleteChat(env: Env, userId: string, chatId: string) {
  const chat = await env.DB.prepare(
    "SELECT id FROM chat WHERE id = ? AND user_id = ?",
  )
    .bind(chatId, userId)
    .first();
  if (!chat)
    throw new ProductError(404, "Conversation not found.", "not_found");
  // Cancel active generation before deleting its files. R2 failures leave rows so
  // deletion can be retried without losing the keys needed for cleanup.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE message SET status = 'cancelled', updated_at = ? WHERE status IN ('pending','running') AND id = (SELECT generation_id FROM chat WHERE id = ? AND user_id = ?)",
    ).bind(Date.now(), chatId, userId),
    env.DB.prepare(
      "UPDATE chat SET generation_id = NULL, lease_expires_at = NULL, deleting_at = ? WHERE id = ? AND user_id = ?",
    ).bind(Date.now(), chatId, userId),
  ]);
  const files = await env.DB.prepare(
    "SELECT r2_key FROM attachment WHERE chat_id = ? AND user_id = ?",
  )
    .bind(chatId, userId)
    .all<{ r2_key: string }>();
  if (files.results.length)
    await env.DATA.delete(files.results.map((file) => file.r2_key));
  await env.DB.prepare("DELETE FROM chat WHERE id = ? AND user_id = ?")
    .bind(chatId, userId)
    .run();
}

export async function getAttachment(
  env: Env,
  userId: string,
  attachmentId: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM attachment WHERE id = ? AND user_id = ?",
  )
    .bind(attachmentId, userId)
    .first<AttachmentRow>();
  if (!row) throw new ProductError(404, "Attachment not found.", "not_found");
  return row;
}

export async function deleteAttachment(
  env: Env,
  userId: string,
  attachmentId: string,
) {
  const file = await getAttachment(env, userId, attachmentId);
  // Resolve the current chat inside this transaction: another request may have
  // claimed a previously unused file after getAttachment returned.
  const attachmentChat =
    "SELECT chat_id FROM attachment WHERE id = ? AND user_id = ?";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE attachment SET status = 'failed', extracted_text = NULL, error = 'Removal in progress.' WHERE id = ? AND user_id = ?",
    ).bind(attachmentId, userId),
    // Keep the answer's prose, but remove stored source excerpts for this file.
    // Legacy attachment sources without a stable file ID are removed as well.
    env.DB.prepare(
      `UPDATE message SET evidence_json = json_set(evidence_json, '$.sources', json((SELECT json_group_array(json(source.value)) FROM json_each(message.evidence_json, '$.sources') source WHERE json_extract(source.value, '$.kind') IS NOT 'attachment' OR (json_extract(source.value, '$.attachmentId') IS NOT NULL AND json_extract(source.value, '$.attachmentId') <> ?)))), updated_at = ? WHERE chat_id = (${attachmentChat}) AND evidence_json IS NOT NULL AND EXISTS (SELECT 1 FROM chat WHERE id = message.chat_id AND user_id = ?)`,
    ).bind(attachmentId, now, attachmentId, userId, userId),
    env.DB.prepare(
      `UPDATE message SET status = 'cancelled', updated_at = ? WHERE status IN ('pending','running') AND id = (SELECT generation_id FROM chat WHERE id = (${attachmentChat}) AND user_id = ?)`,
    ).bind(now, attachmentId, userId, userId),
    env.DB.prepare(
      `UPDATE chat SET generation_id = NULL, lease_expires_at = NULL WHERE id = (${attachmentChat}) AND user_id = ?`,
    ).bind(attachmentId, userId, userId),
  ]);
  await env.DATA.delete(file.r2_key);
  await env.DB.prepare("DELETE FROM attachment WHERE id = ? AND user_id = ?")
    .bind(attachmentId, userId)
    .run();
}

export type BeginMessageInput = {
  chatId: string;
  requestId: string;
  content: string;
  attachmentIds?: string[];
  retry?: boolean;
};

async function existingPair(env: Env, chatId: string, requestId: string) {
  const user = await env.DB.prepare(
    "SELECT * FROM message WHERE chat_id = ? AND client_request_id = ? AND role = 'user'",
  )
    .bind(chatId, requestId)
    .first<MessageRow>();
  if (!user) return null;
  const assistant = await env.DB.prepare(
    "SELECT * FROM message WHERE reply_to_id = ?",
  )
    .bind(user.id)
    .first<MessageRow>();
  if (!assistant)
    throw new ProductError(
      503,
      "Conversation recovery is needed. Please start a new conversation.",
      "incomplete_turn",
    );
  return {
    created: false,
    userMessage: toMessage(user),
    assistantMessage: toMessage(assistant),
  };
}

export async function beginMessagePair(
  env: Env,
  userId: string,
  input: BeginMessageInput,
) {
  const { chatId, requestId } = input;
  const content = input.content.trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
    throw new ProductError(
      400,
      "Use a valid request ID.",
      "invalid_request_id",
    );
  if (!content || content.length > PRODUCT_LIMITS.messageCharacters)
    throw new ProductError(
      400,
      "Enter a question of up to 20,000 characters.",
      "invalid_message",
    );
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length > PRODUCT_LIMITS.attachmentsPerMessage)
    throw new ProductError(
      400,
      "Attach at most four files to a question.",
      "attachment_limit",
    );
  await ownedChat(env, userId, chatId);
  await reconcileExpiredGenerations(env, userId);
  const existing = await existingPair(env, chatId, requestId);
  if (existing) {
    if (existing.userMessage.content !== content)
      throw new ProductError(
        409,
        "This request ID already belongs to a different question.",
        "request_conflict",
      );
    if (
      input.retry &&
      ["failed", "cancelled"].includes(existing.assistantMessage.status)
    ) {
      return retryMessagePair(env, userId, input, existing);
    }
    return existing;
  }
  for (const id of attachmentIds) {
    const file = await getAttachment(env, userId, id);
    if (
      file.status !== "ready" ||
      file.message_id ||
      (file.chat_id && file.chat_id !== chatId)
    )
      throw new ProductError(
        400,
        "Choose ready, unused attachments from this conversation.",
        "attachment_unavailable",
      );
  }
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      "UPDATE chat SET generation_id = ?, lease_expires_at = ?, updated_at = ?, title = CASE WHEN NOT EXISTS (SELECT 1 FROM message WHERE chat_id = chat.id) THEN ? ELSE title END WHERE id = ? AND user_id = ? AND generation_id IS NULL AND deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM message WHERE chat_id = ? AND client_request_id = ?) AND (SELECT COUNT(*) FROM message WHERE chat_id = ?) < ? AND COALESCE((SELECT requests FROM daily_usage WHERE user_id = ? AND day = ?),0) < ?" +
        attachmentIds
          .map(
            () =>
              " AND EXISTS (SELECT 1 FROM attachment WHERE id = ? AND user_id = ? AND status = 'ready' AND message_id IS NULL AND (chat_id IS NULL OR chat_id = ?))",
          )
          .join(""),
    ).bind(
      assistantMessageId,
      now + PRODUCT_LIMITS.generationLeaseMs,
      now,
      content.slice(0, 100),
      chatId,
      userId,
      chatId,
      requestId,
      chatId,
      PRODUCT_LIMITS.messagesPerChat,
      userId,
      day,
      PRODUCT_LIMITS.requestsPerDay,
      ...attachmentIds.flatMap((id) => [id, userId, chatId]),
    ),
    env.DB.prepare(
      "INSERT INTO message (id,chat_id,role,content,status,client_request_id,created_at,updated_at) SELECT ?,?,'user',?,'complete',?,?,? WHERE EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ?)",
    ).bind(
      userMessageId,
      chatId,
      content,
      requestId,
      now,
      now,
      chatId,
      userId,
      assistantMessageId,
    ),
    env.DB.prepare(
      "INSERT INTO message (id,chat_id,role,content,status,reply_to_id,created_at,updated_at) SELECT ?,?,'assistant','','running',?,?,? WHERE EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ?)",
    ).bind(
      assistantMessageId,
      chatId,
      userMessageId,
      now,
      now,
      chatId,
      userId,
      assistantMessageId,
    ),
    env.DB.prepare(
      "INSERT INTO daily_usage (user_id,day,requests) SELECT ?,?,1 WHERE EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ?) ON CONFLICT(user_id,day) DO UPDATE SET requests = requests + 1",
    ).bind(userId, day, chatId, userId, assistantMessageId),
  ];
  for (const id of attachmentIds)
    statements.push(
      env.DB.prepare(
        "UPDATE attachment SET chat_id = ?, message_id = ? WHERE id = ? AND user_id = ? AND status = 'ready' AND message_id IS NULL AND (chat_id IS NULL OR chat_id = ?) AND EXISTS (SELECT 1 FROM chat WHERE id = ? AND generation_id = ?)",
      ).bind(
        chatId,
        userMessageId,
        id,
        userId,
        chatId,
        chatId,
        assistantMessageId,
      ),
    );
  const results = await env.DB.batch(statements);
  const pair = await existingPair(env, chatId, requestId);
  if (!results[0]?.meta.changes) {
    if (pair) {
      if (pair.userMessage.content !== content)
        throw new ProductError(
          409,
          "This request ID already belongs to a different question.",
          "request_conflict",
        );
      return pair;
    }
    const chat = await ownedChat(env, userId, chatId);
    if (chat.generation_id)
      throw new ProductError(
        409,
        "An answer is already in progress in this conversation.",
        "generation_running",
      );
    for (const id of attachmentIds) {
      const file = await getAttachment(env, userId, id);
      if (
        file.status !== "ready" ||
        file.message_id ||
        (file.chat_id && file.chat_id !== chatId)
      )
        throw new ProductError(
          409,
          "An attachment is no longer available for this question.",
          "attachment_unavailable",
        );
    }
    throw new ProductError(
      429,
      "You have reached the conversation or daily usage limit. Try a new conversation or return tomorrow.",
      "usage_limit",
    );
  }
  if (!pair)
    throw new ProductError(503, "Could not save the question. Please retry.");
  return { ...pair, created: true };
}

async function retryMessagePair(
  env: Env,
  userId: string,
  input: BeginMessageInput,
  previous: NonNullable<Awaited<ReturnType<typeof existingPair>>>,
) {
  await reconcileExpiredGenerations(env, userId);
  const latest = await env.DB.prepare(
    "SELECT id FROM message WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(input.chatId)
    .first<{ id: string }>();
  if (latest?.id !== previous.assistantMessage.id) {
    const concurrent = await existingPair(env, input.chatId, input.requestId);
    if (concurrent && latest?.id === concurrent.assistantMessage.id)
      return concurrent;
    throw new ProductError(
      409,
      "Only the latest answer can be retried. Send a follow-up question instead.",
      "retry_not_latest",
    );
  }
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  const newId = crypto.randomUUID();
  // Rotate the assistant row ID as a fencing token. A late writer from the
  // previous attempt must never overwrite the newly running answer.
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE chat SET generation_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND generation_id IS NULL AND deleting_at IS NULL AND COALESCE((SELECT requests FROM daily_usage WHERE user_id = ? AND day = ?),0) < ? AND EXISTS (SELECT 1 FROM message WHERE id = ? AND chat_id = ? AND status IN ('failed','cancelled'))",
    ).bind(
      newId,
      now + PRODUCT_LIMITS.generationLeaseMs,
      now,
      input.chatId,
      userId,
      userId,
      day,
      PRODUCT_LIMITS.requestsPerDay,
      previous.assistantMessage.id,
      input.chatId,
    ),
    env.DB.prepare(
      "UPDATE message SET id = ?, content = '', evidence_json = NULL, status = 'running', updated_at = ? WHERE id = ? AND chat_id = ? AND status IN ('failed','cancelled') AND EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ?)",
    ).bind(
      newId,
      now,
      previous.assistantMessage.id,
      input.chatId,
      input.chatId,
      userId,
      newId,
    ),
    env.DB.prepare(
      "INSERT INTO daily_usage (user_id,day,requests) SELECT ?,?,1 WHERE EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ?) ON CONFLICT(user_id,day) DO UPDATE SET requests = requests + 1",
    ).bind(userId, day, input.chatId, userId, newId),
  ]);
  const pair = await existingPair(env, input.chatId, input.requestId);
  if (!result[0]?.meta.changes) {
    if (pair && pair.assistantMessage.id !== previous.assistantMessage.id)
      return pair;
    const chat = await ownedChat(env, userId, input.chatId);
    if (chat.generation_id)
      throw new ProductError(
        409,
        "An answer is already in progress.",
        "generation_running",
      );
    throw new ProductError(
      429,
      "You have reached today's usage limit. Please return tomorrow.",
      "usage_limit",
    );
  }
  if (!pair)
    throw new ProductError(503, "Could not retry the answer. Please reload.");
  return { ...pair, created: true };
}

/** Fences late writers after cancellation, expiry, deletion, or a newer turn. */
export async function saveMessageProgress(
  env: Env,
  userId: string,
  chatId: string,
  messageId: string,
  content: string,
  evidence?: Evidence,
) {
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE message SET content = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ? AND chat_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ? AND lease_expires_at > ?)",
  )
    .bind(
      content.slice(0, 120_000),
      evidence ? JSON.stringify(evidence) : null,
      now,
      messageId,
      chatId,
      chatId,
      userId,
      messageId,
      now,
    )
    .run();
  return Boolean(result.meta.changes);
}

export async function renewGenerationLease(
  env: Env,
  userId: string,
  chatId: string,
  messageId: string,
) {
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE chat SET lease_expires_at = ? WHERE id = ? AND user_id = ? AND generation_id = ? AND lease_expires_at > ?",
  )
    .bind(
      now + PRODUCT_LIMITS.generationLeaseMs,
      chatId,
      userId,
      messageId,
      now,
    )
    .run();
  return Boolean(result.meta.changes);
}

export async function finishMessage(
  env: Env,
  userId: string,
  chatId: string,
  messageId: string,
  content: string,
  status: "complete" | "failed" | "cancelled",
  evidence?: Evidence,
) {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE message SET content = ?, status = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ? AND chat_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND generation_id = ? AND lease_expires_at > ?)",
    ).bind(
      content.slice(0, 120_000),
      status,
      evidence ? JSON.stringify(evidence) : null,
      now,
      messageId,
      chatId,
      chatId,
      userId,
      messageId,
      now,
    ),
    env.DB.prepare(
      "UPDATE chat SET generation_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND generation_id = ? AND EXISTS (SELECT 1 FROM message WHERE id = ? AND status = ?)",
    ).bind(now, chatId, userId, messageId, messageId, status),
  ]);
  return Boolean(result[0]?.meta.changes);
}

export async function cancelGeneration(
  env: Env,
  userId: string,
  chatId: string,
  expectedGenerationId?: string,
) {
  await ownedChat(env, userId, chatId);
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE message SET status = 'cancelled', updated_at = ? WHERE status IN ('pending','running') AND id = (SELECT generation_id FROM chat WHERE id = ? AND user_id = ? AND (? IS NULL OR generation_id = ?))",
    ).bind(
      now,
      chatId,
      userId,
      expectedGenerationId ?? null,
      expectedGenerationId ?? null,
    ),
    env.DB.prepare(
      "UPDATE chat SET generation_id = NULL, lease_expires_at = NULL WHERE id = ? AND user_id = ? AND (? IS NULL OR generation_id = ?)",
    ).bind(
      chatId,
      userId,
      expectedGenerationId ?? null,
      expectedGenerationId ?? null,
    ),
  ]);
  return Boolean(result[0]?.meta.changes);
}

export async function getChatContext(env: Env, userId: string, chatId: string) {
  const conversation = await getChat(env, userId, chatId);
  // Fetch present rows each turn. Removed files never remain in future context.
  const files = await env.DB.prepare(
    "SELECT * FROM attachment WHERE chat_id = ? AND user_id = ? AND status = 'ready' AND message_id IS NOT NULL ORDER BY created_at",
  )
    .bind(chatId, userId)
    .all<AttachmentRow>();
  return {
    ...conversation,
    documents: files.results.map((file) => ({
      ...attachmentMetadata(file),
      text: file.extracted_text ?? "",
    })),
  };
}
