import { authIsConfigured, createAuth } from "./auth";
import { handleChatApi } from "./chat-api";
import { handleChatStream } from "./chat-stream";
import { getCorpusStats, inspectProfile } from "./cohort";
import { publicPage } from "./public-pages";
import { canonicalHomepage } from "./site-routing";

function json(data: unknown, status = 200, headers = new Headers()): Response {
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, {
    status,
    headers,
  });
}

const authRoutes = new Map([
  ["/api/auth/sign-in/social", "POST"],
  ["/api/auth/callback/google", "GET"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/sign-out", "POST"],
]);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const redirect = canonicalHomepage(request, env);
    if (redirect) return redirect;
    const { pathname, origin } = new URL(request.url);

    if (request.method === "GET") {
      const page = publicPage(pathname);
      if (page) return page;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      return json({
        service: "outpredict",
        status: "ok",
        environment: env.ENVIRONMENT,
      });
    }

    if (request.method === "GET" && pathname === "/api/setup") {
      return json({
        googleSignIn: authIsConfigured(env) && origin === env.AUTH_URL,
        environment: env.ENVIRONMENT,
      });
    }

    if (pathname.startsWith("/api/corpus/")) {
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      try {
        if (pathname === "/api/corpus/stats")
          return json(await getCorpusStats(env.DB));
        const match = pathname.match(/^\/api\/corpus\/profiles\/([^/]+)$/);
        if (!match) return json({ error: "Not found" }, 404);
        if (!authIsConfigured(env) || origin !== env.AUTH_URL)
          return json(
            { error: "Sign in on the configured Outpredict website." },
            401,
          );
        const session = await createAuth(env).api.getSession({
          headers: request.headers,
        });
        if (!session) return json({ error: "Sign in to continue." }, 401);
        const profile = await inspectProfile(
          env.DB,
          decodeURIComponent(match[1] ?? ""),
        );
        return profile
          ? json({ profile })
          : json({ error: "Profile not found." }, 404);
      } catch {
        console.error(JSON.stringify({ event: "corpus_request_failed" }));
        return json(
          {
            error:
              "Applicant evidence is temporarily unavailable. Please try again.",
          },
          503,
        );
      }
    }

    if (
      pathname === "/api/chats" ||
      pathname.startsWith("/api/chats/") ||
      pathname === "/api/attachments" ||
      pathname.startsWith("/api/attachments/")
    ) {
      if (!authIsConfigured(env))
        return json({ error: "Sign-in is temporarily unavailable." }, 503);
      if (origin !== env.AUTH_URL)
        return json({ error: "Use the configured Outpredict website." }, 403);
      try {
        const { response: session, headers: sessionHeaders } = await createAuth(
          env,
        ).api.getSession({ headers: request.headers, returnHeaders: true });
        if (!session)
          return json({ error: "Sign in to continue." }, 401, sessionHeaders);
        const user = {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        };
        const response =
          (await handleChatStream(request, env, user, ctx)) ??
          (await handleChatApi(request, env, user));
        if (!response) return json({ error: "Not found" }, 404);
        const headers = new Headers(response.headers);
        for (const cookie of sessionHeaders.getSetCookie())
          headers.append("Set-Cookie", cookie);
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch {
        console.error(
          JSON.stringify({ event: "product_authentication_failed" }),
        );
        return json(
          {
            error: "This request is temporarily unavailable. Please try again.",
          },
          503,
        );
      }
    }

    if (pathname === "/api/me" || pathname.startsWith("/api/auth/")) {
      if (!authIsConfigured(env)) {
        return json({ error: "Google sign-in is not configured yet." }, 503);
      }
      if (origin !== env.AUTH_URL) {
        return json(
          { error: "Use the configured Outpredict website to sign in." },
          403,
        );
      }
      try {
        if (pathname === "/api/me") {
          if (request.method !== "GET")
            return json({ error: "Method not allowed" }, 405);
          const { response: session, headers } = await createAuth(
            env,
          ).api.getSession({
            headers: request.headers,
            returnHeaders: true,
          });
          if (!session)
            return json({ error: "Sign in to continue." }, 401, headers);
          // Identity comes exclusively from the verified server session. Never
          // accept a user ID supplied in a query, header, or request body.
          return json(
            {
              user: {
                id: session.user.id,
                name: session.user.name,
                email: session.user.email,
              },
            },
            200,
            headers,
          );
        }
        const method = authRoutes.get(pathname);
        if (!method) return json({ error: "Not found" }, 404);
        if (request.method !== method)
          return json({ error: "Method not allowed" }, 405);
        if (
          method === "POST" &&
          request.headers.get("Origin") !== env.AUTH_URL
        ) {
          return json({ error: "Untrusted request origin" }, 403);
        }
        const response = await createAuth(env).handler(request);
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch {
        console.error(
          JSON.stringify({
            event: "authentication_request_failed",
            route: pathname,
          }),
        );
        return json(
          { error: "Sign-in is temporarily unavailable. Please try again." },
          503,
        );
      }
    }

    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/healthz"
    ) {
      return json({ error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
