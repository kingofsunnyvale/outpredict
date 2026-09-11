import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeEvidence, profileEvidence } from "../src/agent";
import {
  type CorpusActivity,
  type CorpusProfile,
  getCorpusStats,
  searchCohort,
  validateCohortFilters,
} from "../src/cohort";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM corpus_active_release").run();
  await env.DB.prepare("DELETE FROM corpus_release_changes").run();
  await env.DB.prepare("DELETE FROM corpus_release_activation").run();
  await env.DB.prepare("DELETE FROM corpus_collection_runs").run();
  await env.DB.prepare("DELETE FROM corpus_imports").run();
  await env.DB.prepare("DELETE FROM corpus_outcomes").run();
  await env.DB.prepare("DELETE FROM corpus_profiles").run();
  await env.DB.prepare("DELETE FROM corpus_accounts").run();
});
function activity(
  value: number | null,
  timing = "source_snapshot",
): CorpusActivity {
  return {
    category: "clinical",
    description: "Hospital volunteer",
    hours: {
      min: value,
      max: value,
      precision: value === null ? "unreported" : "reported",
    },
    timing,
    confidence: "high",
  };
}
function profile(
  id: string,
  changes: Partial<CorpusProfile> = {},
): CorpusProfile {
  return {
    id,
    accountId: `sdn:${id}`,
    source: "sdn",
    sourceAccountId: id,
    publicHandle: id,
    cycle: "unknown",
    gpa: null,
    scienceGpa: null,
    mcat: null,
    residence: null,
    summary: "Synthetic source report",
    activities: [],
    outcomes: [],
    sourceUrls: ["https://forums.studentdoctor.net/threads/synthetic/"],
    observedAt: "2026-09-10T00:00:00Z",
    authoredAt: null,
    reviewStatus: "reviewed",
    extractionConfidence: "mixed",
    reviewedAt: "2026-09-10T00:00:00Z",
    timingStatus: "source_snapshot",
    notes: [],
    academics: {},
    provenance: {
      method: "synthetic",
      sourceContentSha256: "0".repeat(64),
      sourceArtifactKey: "corpus/synthetic",
      auditInventory: "synthetic",
    },
    evidenceTier: "reviewed_profile",
    reviewMethod: "independent_model_review_and_exact_source_validation",
    sourceSnapshotAt: null,
    humanReviewed: false,
    missingFields: ["cycle"],
    categoryHourTotals: {},
    ...changes,
  };
}
function outcome(
  status: CorpusProfile["outcomes"][number]["status"],
  cycle = "unknown",
  school: string | null = "Test school",
) {
  return {
    status,
    cycle,
    school,
    program: "unspecified_medical",
    reportedCount: null,
    countKind: "school",
    evidence: `Actual reported ${status}`,
    sourceUrl: "https://forums.studentdoctor.net/threads/synthetic/",
  };
}
async function insert(p: CorpusProfile) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO corpus_accounts VALUES(?1,?2,?3,?4)",
  )
    .bind(p.accountId, p.source, p.sourceAccountId, p.publicHandle)
    .run();
  await env.DB.prepare(
    "INSERT INTO corpus_profiles(id,account_id,cycle,review_status,observed_at,gpa,science_gpa,mcat,residence,summary,timing_status,activities_json,profile_json,content_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
  )
    .bind(
      p.id,
      p.accountId,
      p.cycle,
      p.reviewStatus,
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
      "INSERT INTO corpus_outcomes(id,profile_id,account_id,cycle,status,program,school,reported_count,count_kind,conditional,source_url,evidence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
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
        o.conditional ? 1 : 0,
        o.sourceUrl,
        o.evidence,
      )
      .run();
}

describe("partial reviewed corpus snapshots", () => {
  it("reports active releases through rollback regardless of import timestamp order", async () => {
    await insert(profile("retained"));
    for (const [release, date] of [
      ["legacy", "2026-09-10T08:00:00Z"],
      ["expansion-a", "2026-09-10T03:00:00Z"],
      ["expansion-b", "2026-09-10T09:00:00Z"],
    ]) {
      await env.DB.prepare("INSERT INTO corpus_imports VALUES(?1,?2,?3,1,1)")
        .bind(release, `hash-${release}`, date)
        .run();
      if (release !== "legacy")
        await env.DB.prepare(
          "INSERT INTO corpus_collection_runs VALUES(?1,?2,'manifest','{}',?2)",
        )
          .bind(release, date)
          .run();
    }
    await env.DB.prepare(
      "INSERT INTO corpus_active_release VALUES(1,'expansion-b','hash-expansion-b')",
    ).run();
    expect((await getCorpusStats(env.DB)).release).toBe("expansion-b");

    // Rollback preserves immutable imports and restores only the active pointer.
    await env.DB.prepare(
      "UPDATE corpus_active_release SET release='expansion-a',content_sha256='hash-expansion-a' WHERE id=1",
    ).run();
    expect(await getCorpusStats(env.DB)).toMatchObject({
      release: "expansion-a",
      totalProfiles: 1,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM corpus_imports").first(
        "n",
      ),
    ).toBe(3);

    // Rolling back the first expansion removes the pointer; retained v2 history
    // must not replace the legacy release that is now serving the corpus.
    await env.DB.prepare("DELETE FROM corpus_active_release").run();
    expect((await getCorpusStats(env.DB)).release).toBe("legacy");
  });
  it("reports no release for an empty corpus without an activation or legacy import", async () => {
    expect(await getCorpusStats(env.DB)).toMatchObject({
      totalProfiles: 0,
      release: null,
      reviewedAt: null,
    });
  });
  it("separates actual A/R, known-cycle A/R, pending and unreported accounts", async () => {
    await insert(profile("partial", { activities: [activity(null)] }));
    await insert(
      profile("unknown-accepted", {
        outcomes: [outcome("accepted")],
        evidenceTier: "reviewed_outcome_report",
        timingStatus: "retrospective_mixed",
      }),
    );
    await insert(
      profile("known-rejected", {
        cycle: "2024-25",
        gpa: 3.7,
        mcat: 510,
        outcomes: [
          outcome("rejected", "2024-25"),
          outcome("rejected", "2024-25", "Second school"),
        ],
        evidenceTier: "reviewed_outcome_report",
        timingStatus: "retrospective_mixed",
      }),
    );
    await insert(
      profile("pending", {
        cycle: "2024-25",
        outcomes: [outcome("pending", "2024-25")],
      }),
    );
    const r = await searchCohort(env.DB, { limit: 2 });
    expect(r.counts).toEqual({
      total: 4,
      matched: 4,
      examined: 2,
      summarized: 4,
      withReportedOutcomes: 1,
      withAnyReportedOutcomes: 2,
      withoutReportedOutcomes: 2,
      withKnownCycle: 2,
      withReportedGpa: 1,
      withReportedMcat: 1,
      withUsableGpa: 1,
      withUsableMcat: 1,
    });
    expect(r.statistics.gpa).toMatchObject({ n: 1, missing: 3, median: 3.7 });
    const stats = await getCorpusStats(env.DB);
    expect(stats).toMatchObject({
      totalProfiles: 4,
      knownOutcomeProfiles: 2,
      alignedOutcomeProfiles: 1,
      profileOnlyCount: 2,
      missingness: {
        gpa: 3,
        scienceGpa: 4,
        mcat: 3,
        cycle: 2,
        activities: 3,
        acceptanceOrRejection: 2,
        applicationTimeActivityHours: 4,
      },
    });
    expect(stats.reviewMethodCoverage).toEqual([
      {
        method: "independent_model_review_and_exact_source_validation",
        profiles: 4,
      },
    ]);
    expect(stats.cycles).toEqual([
      { cycle: "2024-25", profiles: 2 },
      { cycle: "unknown", profiles: 2 },
    ]);
  });
  it("keeps unknown cycle reports searchable without inventing known-cycle alignment", async () => {
    await insert(profile("unknown", { outcomes: [outcome("accepted")] }));
    expect(validateCohortFilters({ cycles: ["unknown"] }).cycles).toEqual([
      "unknown",
    ]);
    const r = await searchCohort(env.DB, {
      outcomes: ["accepted"],
      cycles: ["unknown"],
    });
    expect(r.counts).toMatchObject({
      matched: 1,
      withReportedOutcomes: 0,
      withAnyReportedOutcomes: 1,
    });
    expect(
      (await searchCohort(env.DB, { outcomes: ["rejected"] })).counts.matched,
    ).toBe(0);
    expect(
      (await searchCohort(env.DB, { cycles: ["2024-25"] })).counts.matched,
    ).toBe(0);
  });
  it("selects a known snapshot once per account despite newer unknown snapshot and multiple events", async () => {
    await insert(
      profile("known", {
        accountId: "sdn:one",
        sourceAccountId: "one",
        cycle: "2024-25",
      }),
    );
    await insert(
      profile("undated", {
        accountId: "sdn:one",
        sourceAccountId: "one",
        observedAt: "2026-09-11T00:00:00Z",
        outcomes: [
          outcome("accepted"),
          outcome("accepted", "unknown", "Another"),
        ],
      }),
    );
    const r = await searchCohort(env.DB, {});
    expect(r.counts).toMatchObject({ total: 1, matched: 1, examined: 1 });
    expect(r.profiles[0]?.id).toBe("known");
    expect((await getCorpusStats(env.DB)).cycles).toEqual([
      { cycle: "2024-25", profiles: 1 },
    ]);
    expect(
      (await searchCohort(env.DB, { cycles: ["unknown"] })).profiles[0]?.id,
    ).toBe("undated");
  });
  it("keeps a school and status on the same unconditional cycle event", async () => {
    await insert(
      profile("schools", {
        cycle: "2024-25",
        outcomes: [
          outcome("rejected", "2024-25", "Alpha"),
          outcome("accepted", "2024-25", "Beta"),
          { ...outcome("accepted", "2024-25", "Gamma"), conditional: true },
          outcome("accepted", "unknown", "Delta"),
        ],
      }),
    );
    for (const school of ["Alpha", "Gamma", "Delta"])
      expect(
        (await searchCohort(env.DB, { school, outcomes: ["accepted"] })).counts
          .matched,
      ).toBe(0);
    expect(
      (await searchCohort(env.DB, { school: "Beta", outcomes: ["accepted"] }))
        .counts.matched,
    ).toBe(1);
  });
  it("excludes nonmedical outcomes consistently from filters, counts, and model evidence", async () => {
    const p = profile("programs", {
      cycle: "2024-25",
      outcomes: [
        {
          ...outcome("accepted", "2024-25", "Masters only"),
          program: "Masters",
        },
        { ...outcome("rejected", "unknown", "SMP only"), program: "SMP" },
        { ...outcome("accepted", "2024-25", "Legacy PhD"), program: "MD-PhD" },
        { ...outcome("accepted", "2024-25", "New PhD"), program: "MD_PhD" },
        {
          ...outcome("accepted", "2024-25", "Legacy unknown"),
          program: "unknown",
        },
        outcome("accepted", "2024-25", "Unspecified medical"),
      ],
    });
    await insert(p);
    await insert(
      profile("masters-only", {
        cycle: "2024-25",
        outcomes: [
          {
            ...outcome("accepted", "2024-25", "Masters only"),
            program: "Masters",
          },
        ],
      }),
    );
    for (const school of ["Masters only", "SMP only"])
      expect((await searchCohort(env.DB, { school })).counts.matched).toBe(0);
    for (const school of [
      "Legacy PhD",
      "New PhD",
      "Legacy unknown",
      "Unspecified medical",
    ])
      expect(
        (await searchCohort(env.DB, { school, outcomes: ["accepted"] })).counts
          .matched,
      ).toBe(1);
    expect(
      (await searchCohort(env.DB, { outcomes: ["accepted"] })).counts,
    ).toMatchObject({
      matched: 1,
      withReportedOutcomes: 1,
      withAnyReportedOutcomes: 1,
    });
    const e = profileEvidence(p);
    expect(e.outcomes).toHaveLength(4);
    expect(e.unalignedReportedOutcomes).toEqual([]);
    expect(e.excludedOutcomeEvents).toBe(2);
  });
  it("does not turn first-role hours, overlap, or unknown timing into category totals", async () => {
    await insert(
      profile("roles", {
        activities: [activity(75), { ...activity(500), description: "Scribe" }],
      }),
    );
    await insert(
      profile("unknown-time", {
        activities: [activity(100, "unknown")],
        timingStatus: "unknown",
      }),
    );
    await insert(
      profile("mixed", {
        cycle: "2024-25",
        activities: [activity(200)],
        timingStatus: "retrospective_mixed",
        outcomes: [outcome("accepted", "2024-25")],
        categoryHourTotals: {
          clinical: {
            hours: { min: 200, max: 200, precision: "reported" },
            eligibility: "reviewed_complete_nonoverlapping",
            timing: "application_cycle",
          },
        },
      }),
    );
    const r = await searchCohort(env.DB, {});
    expect(r.statistics.clinicalHours).toEqual({
      n: 0,
      missing: 3,
      min: null,
      max: null,
      median: null,
    });
  });
  it("includes only an explicitly reviewed complete nonoverlapping category total", async () => {
    await insert(
      profile("total", {
        activities: [activity(75), { ...activity(500), description: "Scribe" }],
        categoryHourTotals: {
          clinical: {
            hours: { min: 575, max: 575, precision: "reported" },
            eligibility: "reviewed_complete_nonoverlapping",
            timing: "source_snapshot",
          },
        },
      }),
    );
    await insert(
      profile("missing-role", { activities: [activity(75), activity(null)] }),
    );
    expect(
      (await searchCohort(env.DB, {})).statistics.clinicalHours,
    ).toMatchObject({ n: 1, missing: 1, median: 575 });
  });
  it("preserves new mixed-timing role narratives while separating unknown outcomes", () => {
    const p = profile("narrative", {
      activities: [
        {
          ...activity(200),
          description: "Clinic volunteer, 200 hours; supported patient intake",
        },
        {
          ...activity(null),
          category: "research",
          description: "3 poster presentations; no papers published",
        },
      ],
      timingStatus: "retrospective_mixed",
      outcomes: [outcome("accepted")],
      evidenceTier: "reviewed_outcome_report",
    });
    const e = profileEvidence(p);
    expect(e.outcomes).toEqual([]);
    expect(e.unalignedReportedOutcomes).toHaveLength(1);
    expect(e.outcomeInterpretation).toContain(
      "Application cycle is unreported",
    );
    expect(JSON.stringify(e.activities)).not.toContain("200");
    expect(JSON.stringify(e.activities)).toContain("patient intake");
    expect(JSON.stringify(e.activities)).toContain("3 poster presentations");
    expect(e.summary).not.toContain("unknown applicant");
  });
  it("does not infer no acceptance or missing activity from an empty partial report", () => {
    const e = profileEvidence(
      profile("partial", { activities: [activity(null)] }),
    );
    expect(e.outcomeInterpretation).toContain("do not mean no acceptance");
    expect(e.activities[0]).toMatchObject({
      description: "Hospital volunteer",
      comparisonEligibility: "source_date_report_only_not_application_time",
    });
  });
  it("preserves approximate/range academics without treating them as exact or unreported", async () => {
    const approximate = profile("approx", {
      academicMeasurements: {
        gpa: { min: 3.34, max: 3.34, precision: "approximate" },
        mcat: { min: 510, max: 514, precision: "range" },
      },
      unavailableNumericFields: ["gpa", "mcat"],
    });
    await insert(approximate);
    await insert(profile("exact", { gpa: 3.5, mcat: 512 }));
    await insert(profile("absent"));
    const r = await searchCohort(env.DB, {});
    expect(r.counts).toMatchObject({
      withReportedGpa: 2,
      withReportedMcat: 2,
      withUsableGpa: 1,
      withUsableMcat: 1,
    });
    expect(r.statistics.gpa).toMatchObject({ n: 1, missing: 2, median: 3.5 });
    expect(
      (await searchCohort(env.DB, { gpaMin: 3.3, gpaMax: 3.4 })).counts.matched,
    ).toBe(0);
    expect(await getCorpusStats(env.DB)).toMatchObject({
      missingness: { gpa: 1, mcat: 1 },
      numericEligibility: { gpa: 1, mcat: 1 },
    });
    const evidence = profileEvidence(approximate);
    expect(evidence.gpa).toBeNull();
    expect(evidence.academicMeasurements.gpa).toMatchObject({
      min: 3.34,
      precision: "approximate",
    });
    expect(evidence.academicInterpretation).toContain(
      "instead of calling it unreported or exact",
    );
  });
  it("defensively excludes a scalar if its source measurement is marked approximate", async () => {
    const invalid = profile("invalid-scalar", {
      gpa: 3.34,
      academicMeasurements: {
        gpa: { min: 3.34, max: 3.34, precision: "approximate" },
      },
    });
    await insert(invalid);
    expect((await searchCohort(env.DB, { gpaMin: 3.3 })).counts.matched).toBe(
      0,
    );
    expect((await searchCohort(env.DB, {})).statistics.gpa.n).toBe(0);
    expect(profileEvidence(invalid).gpa).toBeNull();
  });
  it("does not count two cited snapshots from one account as two supporting applicants", () => {
    const e = finalizeEvidence(
      {
        sources: [
          { id: "P1", kind: "profile", title: "Known", applicantId: "sdn:one" },
          {
            id: "P2",
            kind: "profile",
            title: "Undated",
            applicantId: "sdn:one",
          },
        ],
        cohort: {
          totalProfiles: 1,
          matchedProfiles: 1,
          examinedProfiles: 1,
          supportingProfiles: 0,
          profilesWithOutcomes: 0,
          filters: {},
          limitations: [],
        },
      },
      "Both snapshots [P1, P2].",
    );
    expect(e.cohort?.supportingProfiles).toBe(1);
  });
});
