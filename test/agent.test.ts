import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import corpus from "../data/corpus.json";
import {
  type AgentEvent,
  AgentFailure,
  calculate,
  finalizeEvidence,
  parseModelReply,
  parseStreamEvent,
  profileEvidence,
  runAgent,
  weeklyTimeBudget,
} from "../src/agent";
import type { CorpusProfile } from "../src/cohort";
import type { Evidence } from "../src/product-types";
import {
  buildPublicQuery,
  extractHtmlText,
  fetchPublicPage,
  parseSearchLinks,
  publicSearch,
  readBoundedText,
  validatePublicUrl,
  validateSearchQuery,
} from "../src/research";

function stream(events: unknown[], done = true): ReadableStream<Uint8Array> {
  const wire =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  const bytes = new TextEncoder().encode(wire);
  return new ReadableStream({
    start(controller) {
      // Exercise split JSON/SSE frames, including multibyte UTF-8 boundaries.
      for (let offset = 0; offset < bytes.length; offset += 7)
        controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  });
}

function scriptedAI(replies: unknown[], requests: unknown[]): Ai {
  const ai: Ai = Object.create(env.AI);
  Object.defineProperty(ai, "run", {
    value: async (_model: unknown, request: unknown) => {
      requests.push(structuredClone(request));
      if (!replies.length) throw new Error("Unexpected model request");
      return replies.shift();
    },
  });
  return ai;
}

describe("model evidence and stream boundaries", () => {
  it("never presents a conditional next-cycle offer as a current acceptance", () => {
    const profile = corpus.profiles.find(
      (profile) => profile.accountId === "sdn:1104271",
    ) as CorpusProfile;
    const evidence = profileEvidence(profile);
    expect(
      evidence.outcomes.some((outcome) => outcome.status === "accepted"),
    ).toBe(false);
    expect(evidence.excludedOutcomeEvents).toBe(1);
    expect(evidence.outcomeInterpretation).toContain("NO explicit acceptance");
  });
  it("does not give the model later activity totals as a selected-cycle snapshot", () => {
    const profile = corpus.profiles.find(
      (profile) => profile.accountId === "sdn:1158635",
    ) as CorpusProfile;
    const evidence = profileEvidence(profile);
    expect(evidence.summary).toContain(
      "amount completed before this application is not known",
    );
    expect(JSON.stringify(evidence.activities)).not.toContain("3200");
    expect(JSON.stringify(evidence.activities)).not.toContain("3,200");
    expect(evidence.activities[0]).toMatchObject({
      category: "clinical",
      cycleHours: null,
    });
  });
  it("strips reasoning, preserves UTF-8 answer text, and detects incomplete streams", () => {
    expect(
      parseStreamEvent(
        JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: "private reasoning",
                reasoning: "private reasoning",
              },
            },
          ],
        }),
      ).text,
    ).toBe("");
    expect(
      parseStreamEvent(
        JSON.stringify({ choices: [{ delta: { content: "Résumé ✓" } }] }),
      ).text,
    ).toBe("Résumé ✓");
    expect(
      parseStreamEvent(
        JSON.stringify({ choices: [{ finish_reason: "length" }] }),
      ).truncated,
    ).toBe(true);
    expect(parseStreamEvent("[DONE]").done).toBe(true);
    expect(() => parseStreamEvent('{"error":"provider error"}')).toThrow();
    expect(
      parseModelReply({
        result: {
          choices: [
            { message: { content: "answer", reasoning_content: "hidden" } },
          ],
        },
      }),
    ).toEqual({ content: "answer", calls: [] });
  });

  it("counts distinct cited applicants, excluding computations and uncited retrieved profiles", () => {
    const evidence: Evidence = {
      sources: [
        {
          id: "P1",
          kind: "profile",
          title: "cycle one",
          applicantId: "same-account",
        },
        {
          id: "P2",
          kind: "profile",
          title: "cycle two",
          applicantId: "same-account",
        },
        { id: "P3", kind: "profile", title: "uncited", applicantId: "other" },
        { id: "C1", kind: "calculation", title: "median" },
      ],
      cohort: {
        totalProfiles: 58,
        matchedProfiles: 30,
        examinedProfiles: 2,
        supportingProfiles: 0,
        profilesWithOutcomes: 20,
        filters: {},
        limitations: [],
      },
    };
    expect(
      finalizeEvidence(
        evidence,
        "Examples [P1] [P2]. Median [C1]. Unknown [P99].",
      ).cohort?.supportingProfiles,
    ).toBe(1);
    expect(
      finalizeEvidence(
        evidence,
        "Historical example [P1], current example [P3].",
        new Set(["P3"]),
      ).cohort?.supportingProfiles,
    ).toBe(1);
  });

  it("computes schedules reproducibly and rejects unsafe arithmetic", () => {
    expect(weeklyTimeBudget({ hoursPerWeek: 2, weeks: 52 })).toMatchObject({
      hoursPerWeek: 2,
      weeks: 52,
      totalAvailableHours: 104,
    });
    expect(
      weeklyTimeBudget({ hoursPerWeek: 2, weeks: 52, plannedHours: 200 })
        .planComparison,
    ).toEqual({
      plannedHours: 200,
      additionalHoursNeeded: 96,
      fitsWithinTimeBudget: false,
    });
    expect(
      weeklyTimeBudget({ hoursPerWeek: 2, weeks: 52, plannedHours: 200 })
        .verifiedStatement,
    ).toBe(
      "At 2 hours per week for 52 weeks, your available time totals 104 hours. A plan requiring 200 hours exceeds this budget by 96 hours.",
    );
    expect(() => weeklyTimeBudget({ hoursPerWeek: -2, weeks: 52 })).toThrow();
    expect(() =>
      weeklyTimeBudget({ hoursPerWeek: 2, weeks: 52, operation: "sum" }),
    ).toThrow();
    expect(calculate({ operation: "sum", values: [160, 200, 40] }).result).toBe(
      400,
    );
    expect(calculate({ operation: "product", values: [4, 50] }).result).toBe(
      200,
    );
    expect(
      calculate({ operation: "median", values: [900, 400, 500] }).result,
    ).toBe(500);
    expect(() => calculate({ operation: "eval", values: [1] })).toThrow();
    expect(() =>
      calculate({ operation: "sum", values: [Number.NaN] }),
    ).toThrow();
    expect(() => calculate({ operation: "sum", values: [] })).toThrow();
  });

  it("answers a general question without forcing corpus or web tools", async () => {
    const requests: unknown[] = [];
    const events: AgentEvent[] = [];
    const result = await runAgent({
      env: {
        ...env,
        AI: scriptedAI(
          [
            { choices: [{ message: { content: "READY" } }] },
            stream([
              {
                choices: [
                  { delta: { reasoning_content: "should not escape" } },
                ],
              },
              {
                choices: [
                  { delta: { content: "Résumé wording can be clearer." } },
                ],
              },
            ]),
          ],
          requests,
        ),
      },
      messages: [{ role: "user", content: "How do I write a clear sentence?" }],
      onEvent: async (event) => {
        events.push(event);
      },
      checkpoint: async () => true,
    });
    expect(result.content).toBe("Résumé wording can be clearer.");
    expect(result.evidence.sources).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("should not escape");
  });

  it("runs a real validated tool call and includes its result in final inference", async () => {
    const requests: unknown[] = [];
    const result = await runAgent({
      env: {
        ...env,
        AI: scriptedAI(
          [
            {
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "call1",
                        type: "function",
                        function: {
                          name: "calculate",
                          arguments: JSON.stringify({
                            operation: "sum",
                            values: [160, 200],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ message: { content: "READY" } }] },
            stream([
              {
                choices: [
                  {
                    delta: {
                      content:
                        "That would be 360 completed hours if the plan is finished. [C1]",
                    },
                  },
                ],
              },
            ]),
          ],
          requests,
        ),
      },
      messages: [{ role: "user", content: "What is 160 plus 200?" }],
      onEvent: async () => {},
    });
    expect(result.evidence.sources[0]?.kind).toBe("calculation");
    expect(result.evidence.sources[0]?.excerpt).toContain('"result":360');
    expect(JSON.stringify(requests[2])).toContain('\\"result\\":360');
    expect(result.evidence.cohort).toBeUndefined();
  });

  it("keeps supporting counts scoped to the latest of two disjoint cohort searches", async () => {
    for (const profile of corpus.profiles.filter((profile) =>
      ["reddit:aphrodisiac_donut", "sdn:1158635"].includes(profile.accountId),
    )) {
      await env.DB.prepare("INSERT INTO corpus_accounts VALUES(?1,?2,?3,?4)")
        .bind(
          profile.accountId,
          profile.source,
          profile.sourceAccountId,
          profile.publicHandle,
        )
        .run();
      await env.DB.prepare(
        "INSERT INTO corpus_profiles(id,account_id,cycle,review_status,observed_at,gpa,science_gpa,mcat,residence,summary,timing_status,activities_json,profile_json,content_sha256) VALUES(?1,?2,?3,'reviewed',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
      )
        .bind(
          profile.id,
          profile.accountId,
          profile.cycle,
          profile.observedAt,
          profile.gpa,
          profile.scienceGpa,
          profile.mcat,
          profile.residence,
          profile.summary,
          profile.timingStatus,
          JSON.stringify(profile.activities),
          JSON.stringify(profile),
          profile.provenance.sourceContentSha256,
        )
        .run();
    }
    const cohortCall = (source: string) => ({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: `cohort-${source}`,
                type: "function",
                function: {
                  name: "cohort_search",
                  arguments: JSON.stringify({ sources: [source], limit: 1 }),
                },
              },
            ],
          },
        },
      ],
    });
    const requests: unknown[] = [];
    const result = await runAgent({
      env: {
        ...env,
        AI: scriptedAI(
          [
            cohortCall("reddit"),
            cohortCall("sdn"),
            { choices: [{ message: { content: "READY" } }] },
            {
              choices: [
                {
                  message: {
                    content: "Earlier profile [P1]; latest profile [P2].",
                  },
                },
              ],
            },
            stream([
              {
                choices: [
                  {
                    delta: {
                      content: "Earlier profile [P1]; latest profile [P2].",
                    },
                  },
                ],
              },
            ]),
          ],
          requests,
        ),
      },
      messages: [
        {
          role: "user",
          content: "Compare Reddit applicants, then refine to SDN applicants.",
        },
      ],
      onEvent: async () => {},
    });
    expect(result.evidence.cohort).toMatchObject({
      totalProfiles: 2,
      matchedProfiles: 1,
      examinedProfiles: 1,
      supportingProfiles: 1,
      filters: { sources: "sdn" },
    });
    expect(
      result.evidence.sources
        .filter((source) => source.kind === "profile")
        .map((source) => source.id),
    ).toEqual(["P1", "P2"]);
    expect(result.evidence.notes?.join(" ")).toContain("latest search filters");
    expect(requests).toHaveLength(5);
  });

  it("includes the newest resume after four older uploads and keeps historical citations stable", async () => {
    const requests: unknown[] = [];
    const events: AgentEvent[] = [];
    const result = await runAgent({
      env: {
        ...env,
        AI: scriptedAI(
          [
            { choices: [{ message: { content: "READY" } }] },
            { choices: [{ message: { content: "Private draft to review." } }] },
            stream([
              {
                choices: [{ delta: { content: "I read the newest resume." } }],
              },
            ]),
          ],
          requests,
        ),
      },
      messages: [
        {
          role: "assistant",
          content: "An older deleted attachment was cited here [A12].",
          evidence: { sources: [] },
        },
        {
          role: "assistant",
          content: "Previously computed [C8].",
          evidence: {
            sources: [
              {
                id: "C8",
                kind: "calculation",
                title: "Prior schedule",
                excerpt: "200 hours",
              },
              {
                id: "A8",
                kind: "attachment",
                attachmentId: "3",
                title: "Retained attachment",
                excerpt: "stale extracted text",
              },
              {
                id: "A9",
                kind: "attachment",
                attachmentId: "deleted",
                title: "Deleted attachment",
                excerpt: "deleted private text",
              },
            ],
          },
        },
        { role: "user", content: "Read the new resume." },
      ],
      documents: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        name: `resume-${i}`,
        text: `document-contents-${i}${" x".repeat(12_000)}`,
      })),
      onEvent: async (event) => {
        events.push(event);
      },
    });
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain("document-contents-4");
    expect(sent).not.toContain("document-contents-0");
    expect(sent).not.toContain("deleted private text");
    expect(sent).not.toContain("stale extracted text");
    expect(
      result.evidence.sources.find((source) => source.attachmentId === "3")?.id,
    ).toBe("A8");
    expect(
      result.evidence.sources.find((source) => source.attachmentId === "4")?.id,
    ).toBe("A13");
    expect(
      result.evidence.sources.find((source) => source.attachmentId === "4")
        ?.excerpt,
    ).toContain("document-contents-4");
    expect(result.evidence.sources.some((source) => source.id === "C8")).toBe(
      true,
    );
    expect(result.evidence.cohort).toBeUndefined();
    expect(result.evidence.notes?.join(" ")).toContain("four most recent");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).toContain(
      "TOTAL available weekly time",
    );
    expect(JSON.stringify(events)).not.toContain("Private draft to review");
    expect(events).toContainEqual({
      type: "progress",
      stage: "reviewing",
      title: "Checking the plan against your evidence",
    });
  });

  it("preserves partial answers on provider interruption and obeys lease cancellation", async () => {
    const partial = runAgent({
      env: {
        ...env,
        AI: scriptedAI(
          [
            { choices: [{ message: { content: "READY" } }] },
            stream(
              [{ choices: [{ delta: { content: "Partial advice." } }] }],
              false,
            ),
          ],
          [],
        ),
      },
      messages: [{ role: "user", content: "Help me plan." }],
      onEvent: async () => {},
    });
    await expect(partial).rejects.toMatchObject({
      name: "AgentFailure",
      content: "Partial advice.",
      cancelled: false,
    });
    await expect(
      runAgent({
        env,
        messages: [],
        onEvent: async () => {},
        checkpoint: async () => false,
      }),
    ).rejects.toMatchObject({ name: "AgentFailure", cancelled: true });
    expect(AgentFailure).toBeDefined();
  });

  it("consumes a provider rejection when cancellation happens before the wait starts", async () => {
    const abort = new AbortController();
    const ai: Ai = Object.create(env.AI);
    Object.defineProperty(ai, "run", {
      value: async () => {
        abort.abort();
        throw new Error("Provider rejected after cancellation");
      },
    });
    await expect(
      runAgent({
        env: { ...env, AI: ai },
        signal: abort.signal,
        messages: [{ role: "user", content: "Help me write." }],
        onEvent: async () => {},
      }),
    ).rejects.toMatchObject({ name: "AgentFailure", cancelled: true });
  });
});

describe("bounded public research", () => {
  it("constructs searches solely from public topics and rejects private names and forged URLs", async () => {
    expect(
      buildPublicQuery({
        institution: "Stanford",
        topic: "academic requirements and prerequisites",
      }),
    ).toBe(
      "Stanford medical school admissions academic requirements and prerequisites",
    );
    expect(() =>
      buildPublicQuery({
        institution: "Jane Smith Eastside Clinic",
        topic: "academic requirements and prerequisites",
      }),
    ).toThrow();
    expect(() =>
      buildPublicQuery({
        institution: "Stanford",
        topic: "academic requirements and prerequisites",
        query: "Jane Smith",
      }),
    ).toThrow();
    await expect(
      fetchPublicPage(
        "https://aamc.org/?applicant=Jane%20Smith",
        new Set(),
        undefined,
        async () => {
          throw new Error("Must never fetch");
        },
      ),
    ).rejects.toThrow("Search for");
  });
  it("blocks private addresses, credentials, ports, and private applicant searches", () => {
    for (const url of [
      "http://stanford.edu",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://2130706433/",
      "https://user:secret@stanford.edu/",
      "https://stanford.edu:8443/",
      "https://metadata.google.internal/",
      "https://127.0.0.1.nip.io/",
    ])
      expect(() => validatePublicUrl(url)).toThrow();
    expect(
      validatePublicUrl("https://med.stanford.edu/admissions#requirements")
        .href,
    ).toBe("https://med.stanford.edu/admissions");
    for (const query of [
      "my 3.7 GPA at Stanford",
      "Alex@example.com applicant",
      "MCAT 512 school list",
      "my resume research",
    ])
      expect(() => validateSearchQuery(query)).toThrow();
    expect(
      validateSearchQuery("Stanford MD admission requirements 2027"),
    ).toContain("Stanford");
  });

  it("discovers public publisher links without reproducing search snippets", () => {
    const rows = parseSearchLinks(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmed.stanford.edu%2Fmd-admissions.html&amp;rut=x">Search service headline</a><a class="result__a" href="https://127.0.0.1/private">Bad</a>',
    );
    expect(rows).toEqual([
      {
        title: "med.stanford.edu",
        url: "https://med.stanford.edu/md-admissions.html",
        content: "",
      },
    ]);
  });

  it("reads official HTML, strips executable/navigation content, and blocks unsafe redirects", async () => {
    const html =
      "<html><title>Official requirements</title><script>bad instruction()</script><nav>Navigation</nav><main><p>Applicants should review the following medical school admissions requirements for the coming application cycle.</p><p>Contact admissions for individual circumstances.</p></main></html>";
    const page = await fetchPublicPage(
      "https://med.stanford.edu/md-admissions.html",
      new Set(["https://med.stanford.edu/md-admissions.html"]),
      undefined,
      async () =>
        new Response(html, { headers: { "Content-Type": "text/html" } }),
    );
    expect(page.text).toContain("Applicants should review");
    expect(page.text).not.toContain("bad instruction");
    expect(extractHtmlText(html).title).toBe("Official requirements");
    await expect(
      fetchPublicPage(
        "https://med.stanford.edu/md-admissions.html",
        new Set(["https://med.stanford.edu/md-admissions.html"]),
        undefined,
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data" },
          }),
      ),
    ).rejects.toThrow();
    await expect(
      fetchPublicPage(
        "https://unverified.example.com/",
        new Set(),
        undefined,
        async () => new Response(html),
      ),
    ).rejects.toThrow();
  });

  it("enforces body limits and treats provider blocks as failures instead of empty evidence", async () => {
    await expect(
      readBoundedText(new Response("too large"), 3),
    ).rejects.toThrow();
    await expect(
      publicSearch(
        undefined,
        "Stanford MD requirements",
        undefined,
        async () => new Response("challenge required", { status: 202 }),
      ),
    ).rejects.toThrow();
    await expect(
      publicSearch(
        "test-key",
        "Stanford MD requirements",
        undefined,
        async () => new Response("rate limited", { status: 429 }),
      ),
    ).rejects.toThrow();
  });
});
