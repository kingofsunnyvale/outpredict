import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentOptions, parseStreamEvent, runAgent } from "../src/agent";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI completion integration", () => {
  it("requires an actual successful finish instead of treating the transport marker as success", () => {
    expect(parseStreamEvent("[DONE]")).toEqual({
      text: "",
      done: false,
      truncated: false,
    });
    expect(
      parseStreamEvent('{"choices":[{"delta":{},"finish_reason":"stop"}]}')
        .done,
    ).toBe(true);
    expect(
      parseStreamEvent('{"choices":[{"delta":{},"finish_reason":"length"}]}')
        .truncated,
    ).toBe(true);
    expect(() =>
      parseStreamEvent(
        '{"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
      ),
    ).toThrow("could not finish");
  });

  it("runs the real agent through function-free planning and assistant-only native SSE", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "READY" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"not an answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"Hello there."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const deltas: string[] = [];
    const result = await runAgent({
      env: {
        AI_MODEL: "gpt-5.6-sol",
        OPENAI_API_KEY: "synthetic-test-key",
        DB: {},
      } as unknown as AgentOptions["env"],
      messages: [{ role: "user", content: "Say hello." }],
      onEvent: async (event) => {
        if (event.type === "delta") deltas.push(event.text);
      },
    });
    expect(result.content).toBe("Hello there.");
    expect(deltas).toEqual(["Hello there."]);
    const planning = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    const final = JSON.parse(String(fetcher.mock.calls[1]?.[1].body));
    expect(planning.reasoning_effort).toBe("none");
    expect(
      planning.tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual([
      "cohort_search",
      "profile_inspect",
      "weekly_time_budget",
      "calculate",
    ]);
    expect(final.reasoning_effort).toBe("low");
    expect(final).not.toHaveProperty("tools");
    expect([planning.store, final.store]).toEqual([false, false]);
  });

  it.each(["length", "content_filter", null])(
    "keeps a partial %s stream retryable",
    async (reason) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "READY" },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            `data: {"choices":[{"delta":{"content":"Partial answer."},"finish_reason":null}]}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      vi.stubGlobal("fetch", fetcher);
      await expect(
        runAgent({
          env: {
            AI_MODEL: "gpt-5.6-sol",
            OPENAI_API_KEY: "synthetic-test-key",
            DB: {},
          } as unknown as AgentOptions["env"],
          messages: [{ role: "user", content: "Say hello." }],
          onEvent: async () => {},
        }),
      ).rejects.toMatchObject({
        name: "AgentFailure",
        content: "Partial answer.",
        cancelled: false,
      });
    },
  );
});
