import { type BetterAuthOptions, betterAuth } from "better-auth";

type AuthConfiguration = Pick<
  Env,
  | "AUTH_URL"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "BETTER_AUTH_SECRET"
>;

export function authIsConfigured(env: AuthConfiguration): boolean {
  return Boolean(
    env.AUTH_URL &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.BETTER_AUTH_SECRET?.length >= 32,
  );
}

export function authOptions(env: AuthConfiguration) {
  return {
    appName: "Outpredict",
    baseURL: env.AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.AUTH_URL],
    onAPIError: { errorURL: `${env.AUTH_URL}/` },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        includeGrantedScopes: false,
        accessType: "online",
      },
    },
    session: { cookieCache: { enabled: false } },
    account: { encryptOAuthTokens: true, storeStateStrategy: "database" },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    advanced: {
      cookiePrefix: "outpredict",
      useSecureCookies: env.AUTH_URL.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Migrations are verified in tests and applied before release. Avoid schema
      // introspection on every request-scoped auth instance in Workers.
      database: { validateSchema: false },
    },
    logger: { disabled: true },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env) {
  // Bindings and auth context stay within the current Worker request.
  return betterAuth({ ...authOptions(env), database: env.DB });
}
