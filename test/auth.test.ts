import { env, SELF } from "cloudflare:test";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import worker from "../src/index";

const origin = "https://outpredict-staging.anywager.workers.dev";

async function signedSession(email: string, expired = false) {
  const context = await createAuth(env).$context;
  const user = await context.internalAdapter.createUser(
    {
      name: email.split("@")[0] ?? "Applicant",
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { method: "oauth", oauth: { providerId: "google", profile: { email } } },
  );
  const session = await context.internalAdapter.createSession(user.id);
  if (!session) throw new Error("Session fixture was not created");
  if (expired) {
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?')
      .bind(Date.now() - 60_000, session.id)
      .run();
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(session.token),
  );
  const value = `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
  return {
    user,
    session,
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(value)}`,
  };
}

describe("hosting and setup", () => {
  it("preserves health and API routes even for browser navigation requests", async () => {
    const health = await SELF.fetch(`${origin}/healthz`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(await health.json()).toEqual({
      service: "outpredict",
      status: "ok",
      environment: "staging",
    });
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    const missing = await SELF.fetch(`${origin}/api/missing`, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toContain("application/json");
  });

  it("serves the React shell and its actual built asset", async () => {
    const response = await SELF.fetch(`${origin}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Outpredict</title>");
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(asset).toBeDefined();
    const script = await SELF.fetch(`${origin}${asset}`);
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toContain("javascript");
  });

  it("fails closed when setup is missing or request uses an unregistered preview origin", async () => {
    const missing = { ...env, GOOGLE_CLIENT_SECRET: "" };
    const setup = await worker.fetch(
      new Request(`${origin}/api/setup`),
      missing,
    );
    expect(await setup.json()).toMatchObject({ googleSignIn: false });
    const login = await worker.fetch(
      new Request(`${origin}/api/auth/sign-in/social`, { method: "POST" }),
      missing,
    );
    expect(login.status).toBe(503);
    const preview = await SELF.fetch("https://preview.example/api/setup");
    expect(await preview.json()).toMatchObject({ googleSignIn: false });
    expect((await SELF.fetch("https://preview.example/api/me")).status).toBe(
      403,
    );
  });
});

describe("database sessions", () => {
  it("has a migration matching every configured Better Auth table and index", async () => {
    const migration = await getMigrations(createAuth(env).options);
    expect(migration.toBeCreated).toEqual([]);
    expect(migration.toBeAdded).toEqual([]);
    expect(migration.toBeAddedIndexes).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
  });

  it("requires a valid signed unexpired session", async () => {
    expect((await SELF.fetch(`${origin}/api/me`)).status).toBe(401);
    expect(
      (
        await SELF.fetch(`${origin}/api/me`, {
          headers: { cookie: "__Secure-outpredict.session_token=forged" },
        })
      ).status,
    ).toBe(401);
    const expired = await signedSession("expired@example.com", true);
    expect(
      (
        await SELF.fetch(`${origin}/api/me`, {
          headers: { cookie: expired.cookie },
        })
      ).status,
    ).toBe(401);
  });

  it("keeps each account tied to its cookie despite another supplied user ID", async () => {
    const alice = await signedSession("alice@example.com");
    const bob = await signedSession("bob@example.com");
    const aliceResponse = await SELF.fetch(
      `${origin}/api/me?userId=${bob.user.id}`,
      {
        headers: { cookie: alice.cookie, "X-User-Id": bob.user.id },
      },
    );
    expect(aliceResponse.status).toBe(200);
    expect(aliceResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(await aliceResponse.json()).toEqual({
      user: { id: alice.user.id, name: "alice", email: "alice@example.com" },
    });
    const bobResponse = await SELF.fetch(`${origin}/api/me`, {
      headers: { cookie: bob.cookie },
    });
    expect(await bobResponse.json()).toMatchObject({
      user: { id: bob.user.id },
    });
  });

  it("revokes only the authenticated session on sign-out", async () => {
    const alice = await signedSession("signout-alice@example.com");
    const bob = await signedSession("signout-bob@example.com");
    const logout = await SELF.fetch(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: alice.cookie,
        origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(
      (
        await SELF.fetch(`${origin}/api/me`, {
          headers: { cookie: alice.cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(`${origin}/api/me`, {
          headers: { cookie: bob.cookie },
        })
      ).status,
    ).toBe(200);
  });

  it("returns refreshed cookies when a valid session is renewed", async () => {
    const account = await signedSession("renewal@example.com");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(
      'UPDATE "session" SET "updatedAt" = ?, "expiresAt" = ? WHERE "id" = ?',
    )
      .bind(
        twoDaysAgo,
        twoDaysAgo + 7 * 24 * 60 * 60 * 1000,
        account.session.id,
      )
      .run();
    const response = await SELF.fetch(`${origin}/api/me`, {
      headers: { cookie: account.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain(
      "__Secure-outpredict.session_token",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("Google OAuth boundaries", () => {
  it("returns failed or expired OAuth callbacks to the sign-in screen", async () => {
    for (const query of [
      "code=unused",
      "code=unused&state=expired-or-invalid",
    ]) {
      const response = await SELF.fetch(
        `${origin}/api/auth/callback/google?${query}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      const destination = new URL(
        response.headers.get("Location") ?? "",
        origin,
      );
      expect(destination.origin).toBe(origin);
      expect(destination.pathname).toBe("/");
      expect(destination.searchParams.has("error")).toBe(true);
    }
  });

  it("constructs the exact Google callback, uses identity scopes, and sets a secure state cookie", async () => {
    const response = await SELF.fetch(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/",
        disableRedirect: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ url: string }>();
    const authorization = new URL(body.url);
    expect(authorization.hostname).toBe("accounts.google.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/google`,
    );
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects malicious origins and redirect destinations", async () => {
    for (const [requestOrigin, callbackURL] of [
      ["https://attacker.example", "/"],
      [origin, "https://attacker.example"],
    ]) {
      const response = await SELF.fetch(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          origin: requestOrigin ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google", callbackURL }),
      });
      expect(response.status).toBe(403);
    }
  });
});
