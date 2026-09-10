import { readBoundedBody, uploadAttachment } from "./attachments";
import {
  type AttachmentRow,
  attachmentMetadata,
  cancelGeneration,
  createChat,
  deleteAttachment,
  deleteChat,
  getAttachment,
  getChat,
  listChats,
} from "./chat-store";
import { ProductError, type VerifiedUser } from "./product-types";

export function productJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readProductJson(
  request: Request,
  maximum = 32_000,
): Promise<unknown> {
  try {
    const bytes = await readBoundedBody(request, maximum);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ProductError)
      throw new ProductError(
        error.status,
        "This request is too large. Please shorten it and retry.",
        "request_too_large",
      );
    throw new ProductError(400, "Send a valid JSON request.", "invalid_json");
  }
}

/** Authentication is performed by the caller; supplied identity must be verified. */
export async function handleChatApi(
  request: Request,
  env: Env,
  user: VerifiedUser,
): Promise<Response | null> {
  const url = new URL(request.url);
  const chatMatch = /^\/api\/chats\/([^/]+)(\/cancel)?$/.exec(url.pathname);
  const fileMatch = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
  if (
    url.pathname !== "/api/chats" &&
    url.pathname !== "/api/attachments" &&
    !chatMatch &&
    !fileMatch
  )
    return null;
  try {
    if (url.origin !== env.AUTH_URL)
      throw new ProductError(
        403,
        "Use the configured Outpredict website.",
        "untrusted_origin",
      );
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("Origin") !== env.AUTH_URL
    )
      throw new ProductError(
        403,
        "Untrusted request origin.",
        "untrusted_origin",
      );
    if (url.pathname === "/api/chats") {
      if (request.method === "GET")
        return productJson({ chats: await listChats(env, user.id) });
      if (request.method === "POST") {
        const data = await readProductJson(request);
        if (
          !data ||
          Array.isArray(data) ||
          typeof data !== "object" ||
          ("title" in data && typeof data.title !== "string")
        )
          throw new ProductError(
            400,
            "Enter a valid conversation title.",
            "invalid_title",
          );
        const title = "title" in data ? (data.title as string) : undefined;
        return productJson(
          { chat: await createChat(env, user.id, title) },
          201,
        );
      }
    }
    if (chatMatch?.[1]) {
      if (chatMatch[2] && request.method === "POST") {
        const data = await readProductJson(request);
        if (
          !data ||
          typeof data !== "object" ||
          !("generationId" in data) ||
          typeof data.generationId !== "string" ||
          data.generationId.length > 100
        )
          throw new ProductError(
            400,
            "Choose the response to stop.",
            "invalid_generation",
          );
        const cancelled = await cancelGeneration(
          env,
          user.id,
          chatMatch[1],
          data.generationId,
        );
        return productJson({ cancelled });
      }
      if (!chatMatch[2] && request.method === "GET")
        return productJson(await getChat(env, user.id, chatMatch[1]));
      if (!chatMatch[2] && request.method === "DELETE") {
        await deleteChat(env, user.id, chatMatch[1]);
        return productJson({ deleted: true });
      }
    }
    if (url.pathname === "/api/attachments") {
      if (request.method === "POST")
        return productJson(
          { attachment: await uploadAttachment(request, env, user.id) },
          201,
        );
      if (request.method === "GET") {
        const files = await env.DB.prepare(
          "SELECT * FROM attachment WHERE user_id = ? ORDER BY created_at DESC LIMIT 40",
        )
          .bind(user.id)
          .all<AttachmentRow>();
        return productJson({
          attachments: files.results.map(attachmentMetadata),
        });
      }
    }
    if (fileMatch?.[1]) {
      if (request.method === "DELETE") {
        await deleteAttachment(env, user.id, fileMatch[1]);
        return productJson({ deleted: true });
      }
      if (request.method === "GET") {
        const file = await getAttachment(env, user.id, fileMatch[1]);
        if (url.searchParams.get("download") !== "1")
          return productJson({ attachment: attachmentMetadata(file) });
        const object = await env.DATA.get(file.r2_key);
        if (!object)
          throw new ProductError(
            404,
            "The stored file is unavailable. Please upload it again.",
            "file_missing",
          );
        return new Response(object.body, {
          headers: {
            "Content-Type": file.type,
            "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
            "Content-Length": String(file.size),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      }
    }
    return productJson(
      { error: "Method not allowed.", code: "method_not_allowed" },
      405,
    );
  } catch (error) {
    if (error instanceof ProductError)
      return productJson(
        { error: error.message, code: error.code },
        error.status,
      );
    console.error(
      JSON.stringify({
        event: "chat_request_failed",
        method: request.method,
        route: fileMatch ? "attachment" : "chat",
      }),
    );
    return productJson(
      {
        error: "This request could not be completed. Please try again.",
        code: "request_failed",
      },
      503,
    );
  }
}
