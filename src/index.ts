export default {
  fetch(request, env): Response {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/healthz") {
      return Response.json(
        {
          service: "outpredict",
          status: "ok",
          environment: env.ENVIRONMENT,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
