import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import corpus from "../data/corpus.json";
import {
  getCorpusStats,
  inspectProfile,
  numericSummary,
  searchCohort,
  validateCohortFilters,
} from "../src/cohort";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM corpus_outcomes").run();
  await env.DB.prepare("DELETE FROM corpus_profiles").run();
  await env.DB.prepare("DELETE FROM corpus_accounts").run();
  // A genuine subset exercises missingness, partial/repeated outcomes, and sample limits.
  await insertProfiles([
    "reddit:aphrodisiac_donut",
    "sdn:1158635",
    "mdapplicants:80749",
  ]);
});

async function insertProfiles(accountIds: string[]) {
  for (const p of corpus.profiles.filter((x) =>
    accountIds.includes(x.accountId),
  )) {
    await env.DB.prepare("INSERT INTO corpus_accounts VALUES(?1,?2,?3,?4)")
      .bind(p.accountId, p.source, p.sourceAccountId, p.publicHandle)
      .run();
    await env.DB.prepare(
      "INSERT INTO corpus_profiles(id,account_id,cycle,review_status,observed_at,gpa,science_gpa,mcat,residence,summary,timing_status,activities_json,profile_json,content_sha256) VALUES(?1,?2,?3,'reviewed',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
    )
      .bind(
        p.id,
        p.accountId,
        p.cycle,
        p.observedAt,
        p.gpa,
        p.scienceGpa,
        p.mcat,
        p.residence,
        p.summary,
        p.timingStatus,
        JSON.stringify(p.activities),
        JSON.stringify(p),
        p.provenance.sourceContentSha256,
      )
      .run();
    for (const [i, o] of p.outcomes.entries())
      await env.DB.prepare(
        "INSERT INTO corpus_outcomes(id,profile_id,account_id,cycle,status,program,school,reported_count,count_kind,source_url,evidence,conditional) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
      )
        .bind(
          `${p.id}:${i}`,
          p.id,
          p.accountId,
          o.cycle,
          o.status,
          o.program,
          o.school,
          o.reportedCount,
          o.countKind,
          o.sourceUrl,
          o.evidence,
          "conditional" in o && o.conditional ? 1 : 0,
        )
        .run();
  }
}

describe("reviewed cohort retrieval", () => {
  it("reports actual database coverage rather than a hardcoded corpus inventory", async () => {
    const stats = await getCorpusStats(env.DB);
    expect(stats.totalProfiles).toBe(3);
    expect(stats.sourceCoverage).toEqual([
      { source: "mdapplicants", profiles: 1 },
      { source: "reddit", profiles: 1 },
      { source: "sdn", profiles: 1 },
    ]);
    expect(stats.cycles).toEqual([
      { cycle: "2024-25", profiles: 2 },
      { cycle: "2023-24", profiles: 1 },
    ]);
  });
  it("counts accounts, separates retrieval from summary, and never treats missing hours as zero", async () => {
    const r = await searchCohort(env.DB, { limit: 1 });
    expect(r.counts).toEqual({
      total: 3,
      matched: 3,
      examined: 1,
      withReportedOutcomes: 3,
      withAnyReportedOutcomes: 3,
      withoutReportedOutcomes: 0,
      withKnownCycle: 3,
      withReportedGpa: 3,
      withReportedMcat: 3,
      withUsableGpa: 3,
      withUsableMcat: 3,
      summarized: 3,
    });
    expect(r.statistics.clinicalHours).toEqual({
      n: 0,
      missing: 3,
      min: null,
      max: null,
      median: null,
    });
    expect(r.statistics.mcat.median).toBe(506);
  });
  it("filters explicit rejection without counting applicant-school outcomes as people", async () => {
    const r = await searchCohort(env.DB, {
      outcomes: ["rejected"],
      cycles: ["2023-24"],
    });
    expect(r.counts.matched).toBe(1);
    expect(r.profiles[0]?.accountId).toBe("sdn:1158635");
    expect(r.statistics.clinicalHours.n).toBe(0);
  });
  it("binds a school and outcome to the same unconditional event in the selected cycle", async () => {
    await insertProfiles(["sdn:1162521", "sdn:1104271"]);
    expect(
      (
        await searchCohort(env.DB, {
          school: "Quinnipiac",
          outcomes: ["accepted"],
        })
      ).counts.matched,
    ).toBe(0);
    const rejected = await searchCohort(env.DB, {
      school: "Quinnipiac",
      outcomes: ["rejected"],
    });
    expect(rejected.profiles.map((p) => p.accountId)).toEqual(["sdn:1162521"]);
    expect(
      (
        await searchCohort(env.DB, {
          school: "Arizona College",
          outcomes: ["accepted"],
        })
      ).profiles.map((p) => p.accountId),
    ).toEqual(["sdn:1162521"]);
    expect(
      (
        await searchCohort(env.DB, { school: "George Washington University" })
      ).profiles.some((p) => p.accountId === "sdn:1104271"),
    ).toBe(false);
    // Preserve the conditional flag while moving the future event into the
    // selected cycle to independently verify both SQL restrictions.
    await env.DB.prepare(
      "UPDATE corpus_outcomes SET cycle = '2024-25' WHERE profile_id = 'sdn-1104271-2024-25' AND conditional = 1",
    ).run();
    expect(
      (
        await searchCohort(env.DB, { school: "George Washington University" })
      ).profiles.some((p) => p.accountId === "sdn:1104271"),
    ).toBe(false);
  });
  it("keeps exact boundaries and SQL text literal", async () => {
    expect(
      (
        await searchCohort(env.DB, {
          gpaMin: 3.97,
          gpaMax: 3.97,
          mcatMin: 505,
          mcatMax: 505,
        })
      ).counts.matched,
    ).toBe(1);
    expect(
      (await searchCohort(env.DB, { activity: "%' OR 1=1 --" })).counts.matched,
    ).toBe(0);
    expect(
      (await searchCohort(env.DB, { school: "Georgetown" })).counts.matched,
    ).toBe(2);
  });
  it("rejects invalid model filters instead of silently widening a cohort", () => {
    for (const input of [
      { limit: 0 },
      { limit: 21 },
      { mcatMin: 520, mcatMax: 510 },
      { cycles: ["2025-27"] },
      { gpaMin: NaN },
      { outcomes: ["no_acceptance"] },
      { madeUp: true },
    ])
      expect(() => validateCohortFilters(input)).toThrow();
  });
  it("preserves source evidence and validates inspection IDs", async () => {
    const p = await inspectProfile(env.DB, "mdapplicants-80749-2024-25");
    expect(p?.outcomes.filter((o) => o.status === "rejected")).toHaveLength(2);
    expect(
      p?.activities.find((a) => a.category === "clinical")?.hours.precision,
    ).toBe("unreported");
    expect(await inspectProfile(env.DB, "missing-profile")).toBeNull();
    await expect(inspectProfile(env.DB, "' OR 1=1")).rejects.toThrow();
  });
  it("computes reproducible medians with explicit zero", () => {
    expect(numericSummary([100, null, 0, 300])).toEqual({
      n: 3,
      missing: 1,
      min: 0,
      max: 300,
      median: 100,
    });
    expect(numericSummary([10, 30])).toEqual({
      n: 2,
      missing: 0,
      min: 10,
      max: 30,
      median: 20,
    });
  });
});
