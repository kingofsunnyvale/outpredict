const PRODUCTION_ORIGIN = "https://outpredict.app";
const LEGACY_ORIGIN = "https://outpredict.anywager.workers.dev";

/** Move only safe homepage navigation; never proxy credentials or API bodies. */
export function canonicalHomepage(
  request: Request,
  env: { ENVIRONMENT: string; AUTH_URL: string },
): Response | null {
  const url = new URL(request.url);
  if (
    env.ENVIRONMENT !== "production" ||
    env.AUTH_URL !== PRODUCTION_ORIGIN ||
    url.origin !== LEGACY_ORIGIN ||
    url.pathname !== "/" ||
    !["GET", "HEAD"].includes(request.method)
  )
    return null;
  return new Response(null, {
    status: 308,
    headers: {
      // A fixed destination drops queries, including old chat and OAuth values.
      Location: `${PRODUCTION_ORIGIN}/`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
