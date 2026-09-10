import {
  type AttachmentRow,
  attachmentMetadata,
  ownedChat,
} from "./chat-store";
import { PRODUCT_LIMITS, ProductError } from "./product-types";

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Worker termination can skip catch/finally. Reconcile at most one user's
 * storage cap, after a grace period longer than the extraction deadline. */
export async function reconcileStaleAttachments(env: Env, userId: string) {
  const result = await env.DB.prepare(
    "UPDATE attachment SET status = 'failed', extracted_text = NULL, error = ? WHERE user_id = ? AND status = 'processing' AND id IN (SELECT id FROM attachment WHERE user_id = ? AND status = 'processing' AND created_at <= ? ORDER BY created_at LIMIT ?)",
  )
    .bind(
      "Processing was interrupted. Download the original if available, then remove this file and upload it again or paste the text.",
      userId,
      userId,
      Date.now() - 180_000,
      PRODUCT_LIMITS.filesPerUser,
    )
    .run();
  if (result.meta.changes)
    console.warn(
      JSON.stringify({
        event: "attachment_processing_reconciled",
        count: result.meta.changes,
      }),
    );
  return result.meta.changes;
}

async function currentAttachment(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM attachment WHERE id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .first<AttachmentRow>();
  return row ? attachmentMetadata(row) : null;
}

/** Checks streamed bytes as well as Content-Length; chunked uploads are bounded. */
export async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > maximum)
    throw new ProductError(
      413,
      "The upload is too large. Each file must be 8 MiB or smaller.",
      "file_too_large",
    );
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ProductError(
          413,
          "The upload is too large. Each file must be 8 MiB or smaller.",
          "file_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeName(name: string) {
  return (
    Array.from(name)
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 ||
          code === 127 ||
          character === "/" ||
          character === "\\"
          ? "_"
          : character;
      })
      .join("")
      .slice(0, 160) || "attachment"
  );
}

function validateFile(file: File, bytes: Uint8Array): string {
  if (!file.size)
    throw new ProductError(400, "This file is empty.", "empty_file");
  if (file.size > PRODUCT_LIMITS.fileBytes)
    throw new ProductError(
      413,
      "Each file must be 8 MiB or smaller.",
      "file_too_large",
    );
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = MIME_TYPES[extension];
  if (!type)
    throw new ProductError(
      415,
      "Use a PDF, DOCX, TXT, Markdown, PNG, or JPEG file.",
      "unsupported_file",
    );
  const start = new TextDecoder().decode(bytes.slice(0, 1024));
  const valid =
    extension === "pdf"
      ? start.includes("%PDF-")
      : extension === "docx"
        ? bytes[0] === 0x50 && bytes[1] === 0x4b
        : extension === "png"
          ? [137, 80, 78, 71, 13, 10, 26, 10].every(
              (byte, i) => bytes[i] === byte,
            )
          : extension === "jpg" || extension === "jpeg"
            ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            : true;
  if (!valid)
    throw new ProductError(
      415,
      "This file does not match its extension. Export it again and retry.",
      "invalid_file",
    );
  return type;
}

async function extractText(
  env: Env,
  name: string,
  type: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  let text: string;
  if (type.startsWith("text/")) {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      );
    } catch {
      throw new ProductError(
        422,
        "Save the document as UTF-8 text, PDF, or DOCX and retry.",
        "extraction_failed",
      );
    }
    if (text.includes("\0"))
      throw new ProductError(
        422,
        "This appears to be a binary file. Export it as text or PDF.",
        "extraction_failed",
      );
  } else {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        env.AI.toMarkdown(
          { name, blob: new Blob([bytes], { type }) },
          {
            conversionOptions: {
              pdf: { metadata: false },
              image: { descriptionLanguage: "en" },
            },
          },
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new ProductError(
                  504,
                  "Document extraction took too long. Try a smaller file or paste the text.",
                  "extraction_timeout",
                ),
              ),
            60_000,
          );
        }),
      ]);
      if (result.format === "error")
        throw new ProductError(
          422,
          "We could not read this file. Try a text PDF, DOCX, or individual page image.",
          "extraction_failed",
        );
      text = result.data;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  // Image-only PDFs can return successful conversion with only page headings.
  const content = text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  if (content.length < 15)
    throw new ProductError(
      422,
      "No readable text was found. For scanned PDFs, upload each page as a PNG/JPEG or use a text-based PDF.",
      "empty_extraction",
    );
  if (text.length > PRODUCT_LIMITS.extractedCharacters)
    throw new ProductError(
      422,
      "This document is too long to analyze in one upload. Split it into smaller files.",
      "extraction_too_large",
    );
  return text.trim();
}

export async function uploadAttachment(
  request: Request,
  env: Env,
  userId: string,
) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data"))
    throw new ProductError(
      415,
      "Upload the file using multipart form data.",
      "invalid_upload",
    );
  const body = await readBoundedBody(
    request,
    PRODUCT_LIMITS.fileBytes + 64 * 1024,
  );
  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new ProductError(
      400,
      "The upload could not be read. Choose the file again.",
      "invalid_upload",
    );
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File))
    throw new ProductError(400, "Upload one file at a time.", "invalid_upload");
  const file = files[0];
  const chatValue = form.get("chatId");
  if (chatValue !== null && typeof chatValue !== "string")
    throw new ProductError(400, "Invalid conversation.", "invalid_chat");
  const chatId = chatValue || null;
  if (chatId) await ownedChat(env, userId, chatId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = validateFile(file, bytes);
  const name = safeName(file.name);
  const id = crypto.randomUUID();
  const key = `users/${userId}/attachments/${id}`;
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  // Claim storage and today's attempt in one transaction before R2/AI work.
  // The persistent request counter is deliberately independent of file rows.
  const reservation = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO attachment (id,user_id,chat_id,name,type,size,r2_key,status,created_at) SELECT ?,?,?,?,?,?,?,'processing',? WHERE (SELECT COUNT(*) FROM attachment WHERE user_id = ?) < ? AND (SELECT COALESCE(SUM(size),0) FROM attachment WHERE user_id = ?) + ? <= ? AND (? IS NULL OR EXISTS (SELECT 1 FROM chat WHERE id = ? AND user_id = ? AND deleting_at IS NULL)) AND COALESCE((SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?),0) < ?",
    ).bind(
      id,
      userId,
      chatId,
      name,
      type,
      file.size,
      key,
      now,
      userId,
      PRODUCT_LIMITS.filesPerUser,
      userId,
      file.size,
      PRODUCT_LIMITS.storageBytes,
      chatId,
      chatId,
      userId,
      userId,
      day,
      PRODUCT_LIMITS.conversionRequestsPerDay,
    ),
    env.DB.prepare(
      "INSERT INTO daily_file_usage (user_id,day,requests) SELECT ?,?,1 WHERE EXISTS (SELECT 1 FROM attachment WHERE id = ? AND user_id = ?) ON CONFLICT(user_id,day) DO UPDATE SET requests = requests + 1",
    ).bind(userId, day, id, userId),
  ]);
  if (!reservation[0]?.meta.changes) {
    const used = await env.DB.prepare(
      "SELECT requests FROM daily_file_usage WHERE user_id = ? AND day = ?",
    )
      .bind(userId, day)
      .first<number>("requests");
    if ((used ?? 0) >= PRODUCT_LIMITS.conversionRequestsPerDay)
      throw new ProductError(
        429,
        `You have reached today's limit of ${PRODUCT_LIMITS.conversionRequestsPerDay} file upload attempts. Failed conversions count, and deleting files does not reset the limit. Try again after midnight UTC or paste your text into the chat.`,
        "conversion_usage_limit",
      );
    throw new ProductError(
      429,
      "Your upload storage is full (40 files or 64 MiB). Remove older files to continue.",
      "storage_limit",
    );
  }
  let stored = false;
  try {
    await env.DATA.put(key, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { ownerId: userId, attachmentId: id },
    });
    stored = true;
    const text = await extractText(env, name, type, bytes);
    const saved = await env.DB.prepare(
      "UPDATE attachment SET extracted_text = ?, status = 'ready' WHERE id = ? AND user_id = ? AND status = 'processing'",
    )
      .bind(text, id, userId)
      .run();
    if (!saved.meta.changes) {
      const current = await currentAttachment(env, userId, id);
      if (current) return current;
      await env.DATA.delete(key);
      throw new ProductError(
        409,
        "This upload was removed before extraction finished.",
        "upload_removed",
      );
    }
    console.info(
      JSON.stringify({
        event: "attachment_ready",
        attachmentId: id,
        bytes: file.size,
        type,
      }),
    );
    return attachmentMetadata({
      id,
      user_id: userId,
      chat_id: chatId,
      message_id: null,
      name,
      type,
      size: file.size,
      r2_key: key,
      extracted_text: text,
      status: "ready",
      error: null,
      created_at: now,
    });
  } catch (error) {
    const failure =
      error instanceof ProductError
        ? error
        : new ProductError(
            503,
            "Document extraction is temporarily unavailable. Try again or paste the text.",
            "extraction_failed",
          );
    if (!stored)
      await env.DB.prepare(
        "DELETE FROM attachment WHERE id = ? AND user_id = ?",
      )
        .bind(id, userId)
        .run();
    else {
      const failed = await env.DB.prepare(
        "UPDATE attachment SET status = 'failed', error = ?, extracted_text = NULL WHERE id = ? AND user_id = ? AND status = 'processing'",
      )
        .bind(failure.message, id, userId)
        .run();
      if (!failed.meta.changes) {
        const current = await currentAttachment(env, userId, id);
        if (current) return current;
        await env.DATA.delete(key);
        throw new ProductError(
          409,
          "This upload was removed before extraction finished.",
          "upload_removed",
        );
      }
    }
    console.warn(
      JSON.stringify({
        event: "attachment_failed",
        attachmentId: id,
        code: failure.code,
        type,
      }),
    );
    if (stored && failure.code !== "upload_removed")
      return attachmentMetadata({
        id,
        user_id: userId,
        chat_id: chatId,
        message_id: null,
        name,
        type,
        size: file.size,
        r2_key: key,
        extracted_text: null,
        status: "failed",
        error: failure.message,
        created_at: now,
      });
    throw failure;
  }
}
