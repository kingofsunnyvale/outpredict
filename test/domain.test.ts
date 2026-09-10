import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { canonicalHomepage } from "../src/site-routing";

const canonical = "https://outpredict.app";
const legacy = "https://outpredict.anywager.workers.dev";
const staging = "https://outpredict-staging.anywager.workers.dev";
const production: Env = {
  ...env,
  ENVIRONMENT: "production",
  AUTH_URL: canonical,
};

function request(url: string, init?: RequestInit<IncomingRequestCfProperties>) {
  return worker.fetch(
    new Request(url, init),
    production,
    createExecutionContext(),
  );
}

describe("canonical production website", () => {
  it.each(["GET", "HEAD"])(
    "redirects only safe legacy homepage %s without forwarding private values",
    async (method) => {
      const assets = vi.fn(async () => new Response("unexpected asset"));
      const result = await worker.fetch(
        new Request(
          `${legacy}/?chat=private-chat&code=private-code&next=https://attacker.example`,
          {
            method,
            headers: {
              Cookie: "private-session",
              Authorization: "Bearer private-token",
            },
          },
        ),
        { ...production, ASSETS: { fetch: assets } as unknown as Fetcher },
        createExecutionContext(),
      );
      expect(result.status).toBe(308);
      expect(result.headers.get("Location")).toBe(`${canonical}/`);
      expect(result.headers.get("Set-Cookie")).toBeNull();
      expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.text()).toBe("");
      expect(assets).not.toHaveBeenCalled();
    },
  );

  it("does not redirect mutations, APIs, health checks, or unrelated hosts", () => {
    for (const [url, method] of [
      [`${legacy}/`, "POST"],
      [`${legacy}/`, "DELETE"],
      [`${legacy}/api/auth/callback/google?code=private-code`, "GET"],
      [`${legacy}/api/chats`, "POST"],
      [`${legacy}/healthz`, "GET"],
      [`${legacy}/privacy`, "GET"],
      [`${canonical}/`, "GET"],
      [`${staging}/`, "GET"],
      ["https://preview.example/", "GET"],
      ["https://outpredict.anywager.workers.dev.attacker.example/", "GET"],
    ] as const) {
      expect(
        canonicalHomepage(new Request(url, { method }), production),
      ).toBeNull();
    }
    expect(
      canonicalHomepage(new Request(`${legacy}/`), {
        ...production,
        ENVIRONMENT: "staging",
      }),
    ).toBeNull();
    expect(
      canonicalHomepage(new Request(`${legacy}/`), {
        ...production,
        AUTH_URL: legacy,
      }),
    ).toBeNull();
  });

  it("keeps legacy API requests closed and health checks available", async () => {
    const health = await request(`${legacy}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      environment: "production",
      status: "ok",
    });
    expect(await (await request(`${legacy}/api/setup`)).json()).toMatchObject({
      googleSignIn: false,
    });
    for (const [path, method] of [
      ["/api/chats", "POST"],
      ["/api/attachments/private", "GET"],
      ["/api/auth/callback/google?code=private", "GET"],
    ]) {
      const response = await request(`${legacy}${path}`, {
        method,
        headers: { Origin: canonical, Cookie: "private-session" },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("serves canonical public pages and requires a new host-bound sign-in", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const response = await request(`${canonical}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain('href="/"');
    }
    expect(
      await (await request(`${canonical}/api/setup`)).json(),
    ).toMatchObject({ googleSignIn: true });
    expect((await request(`${canonical}/api/me`)).status).toBe(401);
  });

  it("constructs the canonical Google callback and rejects legacy mutation origins", async () => {
    const options = {
      method: "POST",
      headers: { Origin: canonical, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        disableRedirect: true,
      }),
    };
    const response = await request(
      `${canonical}/api/auth/sign-in/social`,
      options,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ url: string }>();
    const google = new URL(body.url);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${canonical}/api/auth/callback/google`,
    );
    expect(google.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
    const rejected = await request(`${canonical}/api/auth/sign-in/social`, {
      ...options,
      headers: { ...options.headers, Origin: legacy },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Location")).toBeNull();
  });
});
