import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  bundleTranscripts,
  immutableWrite,
  resolveTranscript,
  sha256,
  verifyArtifacts,
} from "./corpus-artifacts.mjs";
import { corpusSql, rollbackSql } from "./import-corpus.mjs";
import { validateCorpus } from "./validate-corpus.mjs";

const allProfiles = JSON.parse(
  await readFile(new URL("../data/corpus.json", import.meta.url)),
).profiles;
const baselineManifest = JSON.parse(
  await readFile(
    new URL("../data/corpus-baseline-v1-sha256.json", import.meta.url),
  ),
);
const baseline = {
  version: 1,
  release: baselineManifest.release,
  profiles: allProfiles.filter((p) =>
    Object.hasOwn(baselineManifest.profiles, p.id),
  ),
};
const timestamp = "2026-09-10T03:03:00Z";
function sample(id = "900000001") {
  const text =
    "Research 🔬 project. GPA approximately 3.5. No outcomes reported.";
  const start = Array.from(text).indexOf("G");
  const quote = "GPA approximately 3.5.";
  const span = {
    field: "academics:0",
    postId: "synthetic-1",
    sourceUrl:
      "https://forums.studentdoctor.net/threads/synthetic.1/#synthetic-1",
    sourceArtifactSha256: "a".repeat(64),
    start,
    end: start + Array.from(quote).length,
    quote,
  };
  const transcript = Buffer.from(
    JSON.stringify({
      accountId: `sdn:${id}`,
      posts: [
        {
          postId: span.postId,
          text,
          sourceUrl: span.sourceUrl,
          sourceArtifactSha256: span.sourceArtifactSha256,
        },
      ],
    }) + "\n",
  );
  const empty = { min: null, max: null, precision: "unreported" };
  return {
    transcript,
    profile: {
      id: `sdn-${id}-unknown`,
      accountId: `sdn:${id}`,
      source: "sdn",
      sourceAccountId: id,
      publicHandle: "Synthetic",
      cycle: "unknown",
      version: 1,
      gpa: null,
      scienceGpa: null,
      mcat: null,
      residence: null,
      summary: "Reported approximate GPA.",
      activities: [],
      outcomes: [],
      sourceUrls: [span.sourceUrl],
      observedAt: timestamp,
      reviewedAt: timestamp,
      authoredAt: null,
      reviewStatus: "reviewed",
      extractionConfidence: "mixed",
      timingStatus: "source_snapshot",
      notes: ["Synthetic fixture"],
      academics: {},
      provenance: {
        method: "model_extraction_and_exact_source_validation",
        sourceContentSha256: sha256(transcript),
        sourceArtifactKey: `corpus/${sha256(transcript)}.json`,
      },
      evidenceTier: "reviewed_profile",
      reviewMethod: "model_extraction_and_exact_source_validation",
      humanReviewed: false,
      missingFields: [
        "scienceGpa",
        "mcat",
        "cycle",
        "activities",
        "acceptance_or_rejection",
      ],
      unavailableNumericFields: ["gpa", "scienceGpa", "mcat"],
      academicMeasurements: {
        gpa: { min: 3.5, max: 3.5, precision: "approximate" },
        scienceGpa: empty,
        mcat: empty,
      },
      evidenceSpans: [span],
      categoryHourTotals: {},
    },
  };
}
function dataset(profile) {
  return {
    ...baseline,
    version: 2,
    release: "synthetic-v2",
    collectionAsOf: timestamp,
    collectionReport: { scope: "synthetic", newImportedAccounts: 0 },
    collectionManifestSha256: "b".repeat(64),
    profiles: [...baseline.profiles, profile],
  };
}
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), "outpredict-pipeline-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bundled records roundtrip exact bytes and Unicode source spans; baseline objects unchanged", () =>
  temporary(async (dir) => {
    const a = sample(),
      b = sample("900000002");
    for (const r of [a, b])
      await writeFile(join(dir, `${sha256(r.transcript)}.json`), r.transcript);
    const input = {
      ...dataset(a.profile),
      profiles: [...baseline.profiles, a.profile, b.profile],
    };
    const out = await bundleTranscripts(input, dir, dir, 100000);
    assert.deepEqual(out.data.profiles.slice(0, 58), baseline.profiles);
    assert.equal(out.manifest.objects.length, 1);
    const bytes = await readFile(out.manifest.objects[0].file);
    for (const [i, r] of [a, b].entries())
      assert.deepEqual(
        resolveTranscript(out.data.profiles[58 + i], bytes).bytes,
        r.transcript,
      );
    const again = await bundleTranscripts(input, dir, dir, 100000);
    assert.deepEqual(again, out);
    await assert.rejects(
      () =>
        verifyArtifacts(
          { profiles: out.data.profiles.slice(58) },
          dir,
          out.manifest,
        ),
      /raw provenance index/,
    );
  }));

test("wrong offset, record hash, quote, source identity and truncated bundle fail", () =>
  temporary(async (dir) => {
    const a = sample();
    await writeFile(join(dir, `${sha256(a.transcript)}.json`), a.transcript);
    const out = await bundleTranscripts({ profiles: [a.profile] }, dir, dir);
    const p = out.data.profiles[0];
    const bytes = await readFile(out.manifest.objects[0].file);
    for (const mutate of [
      (x) => x.provenance.sourceArtifactByteOffset++,
      (x) => (x.provenance.sourceContentSha256 = "0".repeat(64)),
      (x) => (x.evidenceSpans[0].quote = "wrong"),
      (x) => (x.accountId = "sdn:other"),
      (x) => (x.evidenceSpans[0].sourceArtifactSha256 = "c".repeat(64)),
    ]) {
      const bad = structuredClone(p);
      mutate(bad);
      assert.throws(() => resolveTranscript(bad, bytes));
    }
    assert.throws(() =>
      resolveTranscript(p, bytes.subarray(0, bytes.length - 5)),
    );
  }));

test("legacy individual artifact verification remains unchanged", () => {
  const bytes = Buffer.from("legacy source\n");
  const p = {
    id: "legacy",
    provenance: { sourceContentSha256: sha256(bytes) },
  };
  assert.equal(resolveTranscript(p, bytes).legacy, true);
  assert.throws(() => resolveTranscript(p, Buffer.from("wrong")));
});

test("immutable files cannot be silently replaced", () =>
  temporary(async (dir) => {
    const path = join(dir, "f");
    await immutableWrite(path, Buffer.from("one"));
    await immutableWrite(path, Buffer.from("one"));
    await assert.rejects(() => immutableWrite(path, Buffer.from("two")));
  }));

test("v2 validation preserves baseline, unknowns, exact-only academics and one activation per cycle", () => {
  const data = dataset(sample().profile);
  assert.equal(validateCorpus(data).profiles, 59);
  for (const mutate of [
    (x) => (x.profiles[0].gpa = 1),
    (x) => x.profiles.pop(),
    (x) => (x.profiles.at(-1).gpa = 3.5),
    (x) => (x.profiles.at(-1).academicMeasurements.gpa.max = 9),
    (x) =>
      x.profiles.push({
        ...x.profiles.at(-1),
        id: "duplicate-current",
        version: 2,
      }),
    (x) =>
      x.profiles.at(-1).outcomes.push({
        status: "accepted",
        program: "Masters",
        cycle: "unknown",
        reportedCount: null,
        sourceUrl: x.profiles.at(-1).sourceUrls[0],
        evidence: "Masters acceptance",
      }),
  ]) {
    const bad = structuredClone(data);
    mutate(bad);
    if (bad.profiles.length === 58) bad.profiles.shift();
    assert.throws(() => validateCorpus(bad));
  }
});

test("whole-file activation is deterministic and failed release mutation rolls back; rollback preserves baseline and private rows", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../migrations/0002_corpus.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    await readFile(
      new URL("../migrations/0004_corpus_collection_runs.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    "CREATE TABLE private_chat(id TEXT PRIMARY KEY,body TEXT); INSERT INTO private_chat VALUES('sentinel','private');",
  );
  const execute = (sql) => {
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  execute(corpusSql(baseline));
  const data = dataset(sample().profile);
  const sql = corpusSql(data);
  assert.equal(sql, corpusSql(data));
  assert.ok(!/\b(?:BEGIN|COMMIT)\b/.test(sql));
  execute(sql);
  execute(sql);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM corpus_profiles WHERE is_current=1")
      .get().n,
    59,
  );
  const bad = structuredClone(data);
  bad.profiles.at(-1).summary = "Changed immutable release";
  assert.throws(() => execute(corpusSql(bad)));
  assert.equal(
    JSON.parse(
      db
        .prepare("SELECT profile_json FROM corpus_profiles WHERE id=?")
        .get(data.profiles.at(-1).id).profile_json,
    ).summary,
    data.profiles.at(-1).summary,
  );
  execute(rollbackSql(data));
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM corpus_profiles WHERE is_current=1")
      .get().n,
    58,
  );
  assert.equal(
    db.prepare("SELECT body FROM private_chat").get().body,
    "private",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM corpus_imports WHERE release=?")
      .get(baseline.release).n,
    1,
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});

test("rollback cannot deactivate a different release hash", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../migrations/0002_corpus.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    await readFile(
      new URL("../migrations/0004_corpus_collection_runs.sql", import.meta.url),
      "utf8",
    ),
  );
  const data = dataset(sample().profile);
  db.exec("BEGIN");
  db.exec(corpusSql(data));
  db.exec("COMMIT");
  const wrong = structuredClone(data);
  wrong.collectionReport.scope = "different";
  db.exec(rollbackSql(wrong));
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM corpus_profiles WHERE is_current=1")
      .get().n,
    59,
  );
  db.close();
});

test("old release rollback cannot alter newer membership; latest rollback restores prior current snapshot", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../migrations/0002_corpus.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    await readFile(
      new URL("../migrations/0004_corpus_collection_runs.sql", import.meta.url),
      "utf8",
    ),
  );
  const apply = (sql) => {
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const a = dataset(sample().profile);
  apply(corpusSql(a));
  const b = { ...a, release: "synthetic-v2-later" };
  apply(corpusSql(b));
  apply(rollbackSql(a));
  assert.equal(
    db
      .prepare("SELECT is_current FROM corpus_profiles WHERE id=?")
      .get(a.profiles.at(-1).id).is_current,
    1,
  );
  const revised = structuredClone(a.profiles.at(-1));
  revised.id += "-next";
  revised.version = 2;
  revised.summary = "New reviewed observation";
  const c = dataset(revised);
  c.release = "synthetic-v2-revision";
  apply(corpusSql(c));
  assert.equal(
    db
      .prepare("SELECT is_current FROM corpus_profiles WHERE id=?")
      .get(a.profiles.at(-1).id).is_current,
    0,
  );
  apply(rollbackSql(c));
  assert.equal(
    db
      .prepare("SELECT is_current FROM corpus_profiles WHERE id=?")
      .get(a.profiles.at(-1).id).is_current,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT is_current FROM corpus_profiles WHERE id=?")
      .get(revised.id).is_current,
    0,
  );
  assert.equal(
    db.prepare("SELECT release FROM corpus_active_release").get().release,
    b.release,
  );
  db.close();
});

test("existing snapshot ID cannot silently change supported facts under a new release", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../migrations/0002_corpus.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    await readFile(
      new URL("../migrations/0004_corpus_collection_runs.sql", import.meta.url),
      "utf8",
    ),
  );
  const a = dataset(sample().profile);
  db.exec("BEGIN");
  db.exec(corpusSql(a));
  db.exec("COMMIT");
  const b = structuredClone(a);
  b.release = "other";
  b.profiles.at(-1).summary = "Altered facts";
  db.exec("BEGIN");
  assert.throws(() => db.exec(corpusSql(b)));
  db.exec("ROLLBACK");
  assert.equal(
    db.prepare("SELECT release FROM corpus_active_release").get().release,
    a.release,
  );
  db.close();
});

test("v2 category measurements and missingness cannot silently imply comparable totals", () => {
  for (const mutate of [
    (p) =>
      p.activities.push({
        category: "clinical",
        description: "role",
        timing: "source_snapshot",
        hours: { min: 5, max: 8, precision: "reported" },
      }),
    (p) =>
      (p.categoryHourTotals.clinical = {
        hours: { min: 5, max: 5, precision: "reported" },
        timing: "application_cycle",
        eligibility: "reviewed_complete_nonoverlapping",
      }),
    (p) =>
      (p.categoryHourTotals.clinical = {
        hours: { min: 5, max: null, precision: "reported" },
        timing: "source_snapshot",
        eligibility: "reviewed_complete_nonoverlapping",
      }),
    (p) => (p.missingFields = p.missingFields.filter((k) => k !== "cycle")),
  ]) {
    const data = dataset(sample().profile);
    mutate(data.profiles.at(-1));
    assert.throws(() => validateCorpus(data));
  }
});

test("raw archive index must resolve cited raw bytes and original collection manifest", () =>
  temporary(async (dir) => {
    const raw = Buffer.from("<article>Synthetic raw source</article>");
    const rawHash = sha256(raw);
    const a = sample();
    a.profile.evidenceSpans[0].sourceArtifactSha256 = rawHash;
    const t = JSON.parse(a.transcript);
    t.posts[0].sourceArtifactSha256 = rawHash;
    a.transcript = Buffer.from(JSON.stringify(t) + "\n");
    a.profile.provenance.sourceContentSha256 = sha256(a.transcript);
    await writeFile(join(dir, sha256(a.transcript) + ".json"), a.transcript);
    const { data, manifest } = await bundleTranscripts(
      { profiles: [a.profile] },
      dir,
      dir,
    );
    const sourceLine = Buffer.from(
      JSON.stringify({
        sourceSha256: rawHash,
        sourceBytes: raw.length,
        contentBase64: raw.toString("base64"),
      }) + "\n",
    );
    const collection = Buffer.from('{"version":1,"tables":{}}\n');
    data.collectionManifestSha256 = sha256(collection);
    const index = {
      version: 1,
      collectionManifestSha256: sha256(collection),
      rawArtifactCount: 1,
      objects: [],
      records: [],
    };
    for (const [kind, id, line] of [
      ["raw", rawHash, sourceLine],
      ["collection_manifest", sha256(collection), collection],
    ]) {
      const bytes = gzipSync(line),
        hash = sha256(bytes),
        key = "corpus/" + hash + ".jsonl.gz",
        file = join(dir, hash + ".jsonl.gz");
      await writeFile(file, bytes);
      const object = { key, file, sha256: hash, bytes: bytes.length, kind };
      manifest.objects.push(object);
      index.objects.push((({ file, ...rest }) => rest)(object));
      index.records.push({
        recordId: id,
        bundleKey: key,
        bundleSha256: hash,
        byteOffset: 0,
        byteLength: line.length,
        recordSha256: sha256(line),
      });
    }
    const indexBytes = Buffer.from(JSON.stringify(index) + "\n");
    data.rawArtifactIndex = {
      key: "corpus/" + sha256(indexBytes) + ".json",
      sha256: sha256(indexBytes),
    };
    await writeFile(join(dir, sha256(indexBytes) + ".json"), indexBytes);
    await verifyArtifacts(data, dir, manifest);
    const missing = structuredClone(manifest);
    missing.objects = missing.objects.filter((o) => o.kind !== "raw");
    await assert.rejects(
      () => verifyArtifacts(data, dir, missing),
      /Raw bundle absent/,
    );
    const wrong = structuredClone(data);
    wrong.profiles[0].evidenceSpans[0].sourceArtifactSha256 = "f".repeat(64);
    await assert.rejects(() => verifyArtifacts(wrong, dir, manifest));
    await writeFile(
      join(dir, sha256(indexBytes) + ".json"),
      Buffer.from("tampered"),
    );
    await assert.rejects(
      () => verifyArtifacts(data, dir, manifest),
      /Raw artifact index checksum/,
    );
  }));

test("omitted active accounts and historical release replay fail within the import transaction", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../migrations/0002_corpus.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    await readFile(
      new URL("../migrations/0004_corpus_collection_runs.sql", import.meta.url),
      "utf8",
    ),
  );
  const apply = (sql) => {
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const a = dataset(sample().profile);
  apply(corpusSql(a));
  const other = sample("900000002").profile;
  const b = { ...a, release: "release-b", profiles: [...a.profiles, other] };
  apply(corpusSql(b));
  const omitted = { ...a, release: "release-omitting-b" };
  assert.throws(() => apply(corpusSql(omitted)));
  assert.equal(
    db.prepare("SELECT release FROM corpus_active_release").get().release,
    b.release,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM corpus_profiles WHERE is_current=1")
      .get().n,
    60,
  );
  assert.throws(() => apply(corpusSql(a)));
  assert.equal(
    db.prepare("SELECT release FROM corpus_active_release").get().release,
    b.release,
  );
  db.close();
});
