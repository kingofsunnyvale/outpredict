import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  assert.equal(data.version, 1, "Unsupported corpus format");
  assert.ok(
    Array.isArray(data.profiles) && data.profiles.length > 0,
    "Empty corpus",
  );
  const ids = new Set();
  const accountCycles = new Set();
  for (const p of data.profiles) {
    assert.ok(
      typeof p.id === "string" && /^[a-z0-9_-]+$/.test(p.id),
      "Invalid profile ID",
    );
    assert.ok(!ids.has(p.id), `Duplicate profile ${p.id}`);
    ids.add(p.id);
    const key = `${p.accountId}:${p.cycle}:${p.version ?? 1}`;
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
    assert.ok(/^20\d{2}-\d{2}$/.test(p.cycle), "Invalid cycle");
    assert.equal(
      Number(p.cycle.slice(5)),
      (Number(p.cycle.slice(0, 4)) + 1) % 100,
      "Invalid cycle end",
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
    assert.ok(["cycle_report", "retrospective_mixed"].includes(p.timingStatus));
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
      p.activities.length >= 2,
      "Multiple activity categories required",
    );
    for (const a of p.activities) {
      assert.ok(typeof a.description === "string" && a.description.length > 0);
      const h = a.hours;
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
      p.outcomes.some(
        (o) =>
          (o.status === "accepted" || o.status === "rejected") &&
          o.evidence.length > 0,
      ),
      "Explicit A/R evidence required",
    );
    for (const o of p.outcomes) {
      assert.ok(statuses.has(o.status), "Unsupported outcome status");
      assert.ok(
        o.reportedCount === null ||
          (Number.isInteger(o.reportedCount) && o.reportedCount > 0),
      );
      assert.ok(typeof o.evidence === "string" && o.evidence.length > 0);
      assert.ok(
        p.sourceUrls.includes(o.sourceUrl),
        "Outcome source is not attached to profile",
      );
      assert.match(o.cycle, /^20\d{2}-\d{2}$/);
    }
  }
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
