import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const stableJson = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const baseline = JSON.parse(
  readFileSync(
    new URL("../data/corpus-baseline-v1-sha256.json", import.meta.url),
    "utf8",
  ),
);
const activityCategories = new Set([
  "clinical",
  "research",
  "nonclinical",
  "shadowing",
  "teaching_leadership",
  "paid_nonclinical",
  "other",
]);
const programs = new Set(["MD", "DO", "MD_PhD", "unspecified_medical"]);
const methods = new Set([
  "model_extraction_and_exact_source_validation",
  "independent_model_review_and_exact_source_validation",
]);
function cycleValid(value, partial = false) {
  return (
    (partial && value === "unknown") ||
    (/^20\d{2}-\d{2}$/.test(value) &&
      Number(value.slice(5)) === (Number(value.slice(0, 4)) + 1) % 100)
  );
}
function measurementValid(h) {
  assert.ok(
    h &&
      [
        "reported",
        "approximate",
        "explicit_absence",
        "unreported",
        "range",
        "lower_bound",
        "upper_bound",
      ].includes(h.precision),
    "Invalid measurement precision",
  );
  for (const value of [h.min, h.max])
    assert.ok(
      value === null || (Number.isFinite(value) && value >= 0),
      "Invalid measurement bound",
    );
  assert.ok(
    h.min === null || h.max === null || h.min <= h.max,
    "Reversed measurement interval",
  );
  if (h.precision === "unreported")
    assert.ok(
      h.min === null && h.max === null,
      "Unknown measurement has numeric value",
    );
  if (["reported", "approximate", "explicit_absence"].includes(h.precision))
    assert.ok(h.min !== null && h.min === h.max, "Invalid point measurement");
  if (h.precision === "explicit_absence") assert.equal(h.min, 0);
  if (h.precision === "range") assert.ok(h.min !== null && h.max !== null);
  if (h.precision === "lower_bound")
    assert.ok(h.min !== null && h.max === null);
  if (h.precision === "upper_bound")
    assert.ok(h.min === null && h.max !== null);
}

const statuses = new Set([
  "accepted",
  "rejected",
  "interview",
  "waitlisted",
  "withdrawn",
  "pending",
  "unknown",
]);
const domains = {
  reddit: "www.reddit.com",
  sdn: "forums.studentdoctor.net",
  mdapplicants: "www.mdapplicants.com",
};
export function validateCorpus(data) {
  assert.ok([1, 2].includes(data.version), "Unsupported corpus format");
  assert.ok(
    Array.isArray(data.profiles) && data.profiles.length > 0,
    "Empty corpus",
  );
  const ids = new Set();
  const accountCycles = new Set();
  for (const p of data.profiles) {
    const isBaseline = Object.hasOwn(baseline.profiles, p.id);
    const partial = data.version === 2 && !isBaseline;
    if (isBaseline)
      assert.equal(
        createHash("sha256").update(stableJson(p)).digest("hex"),
        baseline.profiles[p.id],
        `Baseline record changed: ${p.id}`,
      );
    if (isBaseline)
      assert.equal(
        createHash("sha256").update(JSON.stringify(p)).digest("hex"),
        baseline.serializedProfiles[p.id],
        "Baseline serialization changed: " + p.id,
      );
    assert.ok(
      typeof p.id === "string" && /^[a-z0-9_-]+$/.test(p.id),
      "Invalid profile ID",
    );
    assert.ok(!ids.has(p.id), `Duplicate profile ${p.id}`);
    ids.add(p.id);
    const key = `${p.accountId}:${p.cycle}`;
    assert.ok(
      !accountCycles.has(key),
      `Duplicate applicant/cycle/version ${key}`,
    );
    accountCycles.add(key);
    assert.ok(Object.hasOwn(domains, p.source), "Unsupported source");
    assert.equal(
      p.accountId,
      `${p.source}:${p.sourceAccountId.toLowerCase()}`,
      "Account identity mismatch",
    );
    assert.ok(cycleValid(p.cycle, partial), "Invalid cycle");
    if (p.version !== undefined)
      assert.ok(
        Number.isSafeInteger(p.version) && p.version > 0,
        "Invalid profile version",
      );
    assert.equal(
      p.reviewStatus,
      "reviewed",
      "Unreviewed records cannot enter this release",
    );
    assert.ok(
      ["high", "mixed"].includes(p.extractionConfidence),
      "Missing extraction confidence",
    );
    assert.ok(
      (partial
        ? ["cycle_report", "retrospective_mixed", "source_snapshot"]
        : ["cycle_report", "retrospective_mixed"]
      ).includes(p.timingStatus),
    );
    if (partial) {
      assert.ok(
        ["reviewed_outcome_report", "reviewed_profile"].includes(
          p.evidenceTier,
        ),
      );
      assert.ok(methods.has(p.reviewMethod), "Review method missing");
      assert.equal(
        p.humanReviewed,
        false,
        "Machine-reviewed dataset must not claim human review",
      );
      assert.ok(
        Array.isArray(p.missingFields) &&
          Array.isArray(p.unavailableNumericFields),
      );
      assert.ok(
        p.categoryHourTotals &&
          typeof p.categoryHourTotals === "object" &&
          !Array.isArray(p.categoryHourTotals),
      );
      for (const [category, total] of Object.entries(p.categoryHourTotals)) {
        assert.ok(activityCategories.has(category), "Invalid category total");
        assert.equal(total.eligibility, "reviewed_complete_nonoverlapping");
        assert.ok(
          ["application_cycle", "source_snapshot"].includes(total.timing),
        );
        assert.equal(
          p.timingStatus,
          total.timing === "application_cycle"
            ? "cycle_report"
            : "source_snapshot",
          "Category total lacks comparable profile timing",
        );
        measurementValid(total.hours);
      }
      assert.equal(
        p.missingFields.includes("cycle"),
        p.cycle === "unknown",
        "Cycle missingness mismatch",
      );
      assert.equal(
        p.missingFields.includes("activities"),
        p.activities.length === 0,
        "Activity missingness mismatch",
      );
      assert.equal(
        p.missingFields.includes("acceptance_or_rejection"),
        !p.outcomes.some(
          (o) => ["accepted", "rejected"].includes(o.status) && !o.conditional,
        ),
        "Outcome missingness mismatch",
      );
      for (const field of ["gpa", "scienceGpa", "mcat"]) {
        const h = p.academicMeasurements?.[field];
        measurementValid(h);
        for (const value of [h.min, h.max])
          if (value !== null)
            assert.ok(
              field === "mcat"
                ? Number.isInteger(value) && value >= 472 && value <= 528
                : value >= 0 && value <= 4,
              "Academic measurement outside domain",
            );
        assert.equal(
          p.unavailableNumericFields.includes(field),
          h.precision !== "reported",
          "Academic numeric eligibility mismatch",
        );
        if (h.precision === "reported")
          assert.equal(
            p[field],
            h.min,
            "Exact academic scalar disagrees with measurement",
          );
        else
          assert.equal(
            p[field],
            null,
            "Nonexact academic measurement must not populate exact scalar",
          );
        assert.equal(
          p.missingFields.includes(field),
          h.precision === "unreported",
          "Academic missingness mismatch",
        );
      }
      assert.ok(Array.isArray(p.evidenceSpans) && p.evidenceSpans.length > 0);
      for (const span of p.evidenceSpans) {
        assert.ok(typeof span.quote === "string" && span.quote.length > 0);
        assert.ok(
          Number.isSafeInteger(span.start) &&
            Number.isSafeInteger(span.end) &&
            span.start >= 0 &&
            span.end > span.start,
        );
        assert.match(span.sourceArtifactSha256, /^[a-f0-9]{64}$/);
        assert.ok(p.sourceUrls.includes(span.sourceUrl));
      }
      assert.ok(
        p.activities.length ||
          p.outcomes.length ||
          Object.values(p.academicMeasurements).some(
            (h) => h.precision !== "unreported",
          ),
        "No useful supported facts",
      );
    }
    for (const key of ["gpa", "scienceGpa"])
      assert.ok(
        p[key] === null ||
          (Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 4),
        `Invalid ${key}`,
      );
    assert.ok(
      p.mcat === null ||
        (Number.isInteger(p.mcat) && p.mcat >= 472 && p.mcat <= 528),
      "Invalid MCAT",
    );
    assert.ok(p.sourceUrls.length > 0);
    for (const link of p.sourceUrls) {
      const url = new URL(link);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, domains[p.source]);
    }
    assert.match(p.provenance.sourceContentSha256, /^[a-f0-9]{64}$/);
    assert.ok(p.provenance.sourceArtifactKey.startsWith("corpus/"));
    assert.ok(
      Array.isArray(p.notes) && p.notes.every((x) => typeof x === "string"),
    );
    assert.ok(
      partial || p.activities.length >= 2,
      "Multiple activity categories required",
    );
    for (const a of p.activities) {
      assert.ok(typeof a.description === "string" && a.description.length > 0);
      const h = a.hours;
      if (partial) {
        assert.ok(
          activityCategories.has(a.category),
          "Invalid activity category",
        );
        assert.ok(
          ["source_snapshot", "projected", "unknown"].includes(a.timing),
          "Invalid activity timing",
        );
        measurementValid(h);
      }
      for (const bound of [h.min, h.max])
        assert.ok(bound === null || (Number.isFinite(bound) && bound >= 0));
      assert.ok(
        h.min === null || h.max === null || h.min <= h.max,
        "Reversed hour interval",
      );
      if (h.precision === "explicit_absence")
        assert.ok(h.min === 0 && h.max === 0);
      if (h.precision === "unreported")
        assert.ok(h.min === null && h.max === null);
      assert.ok(
        [
          "reported",
          "approximate",
          "explicit_absence",
          "unreported",
          "range",
          "lower_bound",
          "upper_bound",
        ].includes(h.precision),
      );
    }
    assert.ok(
      partial ||
        p.outcomes.some(
          (o) =>
            (o.status === "accepted" || o.status === "rejected") &&
            o.evidence.length > 0,
        ),
      "Explicit A/R evidence required",
    );
    for (const o of p.outcomes) {
      assert.ok(statuses.has(o.status), "Unsupported outcome status");
      if (partial) {
        assert.ok(programs.has(o.program), "Unsupported medical program");
        assert.equal(
          typeof o.conditional,
          "boolean",
          "Outcome conditional flag required",
        );
        assert.ok(
          ["aggregate", "school_observation"].includes(o.countKind),
          "Invalid outcome count kind",
        );
      }
      assert.ok(
        o.reportedCount === null ||
          (Number.isInteger(o.reportedCount) && o.reportedCount > 0),
      );
      assert.ok(typeof o.evidence === "string" && o.evidence.length > 0);
      assert.ok(
        p.sourceUrls.includes(o.sourceUrl),
        "Outcome source is not attached to profile",
      );
      assert.ok(cycleValid(o.cycle, partial), "Invalid outcome cycle");
    }
    if (partial)
      assert.equal(
        p.evidenceTier === "reviewed_outcome_report",
        p.outcomes.some(
          (o) => ["accepted", "rejected"].includes(o.status) && !o.conditional,
        ),
        "Evidence tier mismatch",
      );
  }
  for (const id of Object.keys(baseline.profiles))
    assert.ok(ids.has(id), `Baseline record missing: ${id}`);
  const count = (field) =>
    Object.fromEntries(
      [...new Set(data.profiles.map((p) => p[field]))]
        .sort()
        .map((value) => [
          value,
          new Set(
            data.profiles
              .filter((p) => p[field] === value)
              .map((p) => p.accountId),
          ).size,
        ]),
    );
  return {
    profiles: ids.size,
    sourceAccounts: new Set(data.profiles.map((p) => p.accountId)).size,
    sources: count("source"),
    cycles: count("cycle"),
    outcomeObservations: data.profiles.reduce(
      (n, p) => n + p.outcomes.length,
      0,
    ),
    mixedTiming: data.profiles.filter(
      (p) => p.timingStatus === "retrospective_mixed",
    ).length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(
    await readFile(new URL("../data/corpus.json", import.meta.url), "utf8"),
  );
  console.log(JSON.stringify(validateCorpus(data), null, 2));
}
