import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const MAX_OBJECT_BYTES = 300 * 1024 * 1024;
const MAX_TRANSCRIPT_BUNDLE_BYTES = 64 * 1024 * 1024;
export async function immutableWrite(path, bytes) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.deepEqual(
      await readFile(path),
      Buffer.from(bytes),
      "Immutable artifact changed",
    );
  }
}

/** Each JSONL record is the exact UTF-8 transcript, including its newline. */
export async function bundleTranscripts(
  data,
  sourceDirectory,
  outputDirectory,
  maxBytes = 4 * 1024 * 1024,
) {
  assert.ok(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= MAX_TRANSCRIPT_BUNDLE_BYTES,
  );
  const result = structuredClone(data);
  const objects = [];
  let entries = [];
  let size = 0;
  const flush = async () => {
    if (!entries.length) return;
    const plaintext = Buffer.concat(entries.map((entry) => entry.bytes));
    const compressed = gzipSync(plaintext, { level: 9, mtime: 0 });
    const hash = sha256(compressed);
    const key = `corpus/out11-2026-09-10/transcripts/${hash}.jsonl.gz`;
    const file = join(resolve(outputDirectory), `${hash}.jsonl.gz`);
    await immutableWrite(file, compressed);
    objects.push({
      key,
      file,
      sha256: hash,
      bytes: compressed.length,
      contentType: "application/gzip",
      kind: "transcript_bundle",
      records: entries.length,
      uncompressedBytes: plaintext.length,
    });
    let offset = 0;
    for (const entry of entries) {
      Object.assign(entry.profile.provenance, {
        sourceArtifactKey: key,
        sourceArtifactSha256: hash,
        sourceArtifactFormat: "gzip_jsonl_v1",
        sourceArtifactRecordId: entry.profile.provenance.sourceContentSha256,
        sourceArtifactByteOffset: offset,
        sourceArtifactByteLength: entry.bytes.length,
      });
      offset += entry.bytes.length;
    }
    entries = [];
    size = 0;
  };
  for (const profile of result.profiles.filter((p) => p.evidenceTier)) {
    const bytes = await readFile(
      join(sourceDirectory, `${profile.provenance.sourceContentSha256}.json`),
    );
    assert.equal(
      sha256(bytes),
      profile.provenance.sourceContentSha256,
      `Transcript checksum: ${profile.id}`,
    );
    assert.equal(bytes.at(-1), 10, "Transcript record must end with newline");
    assert.ok(
      bytes.length <= MAX_TRANSCRIPT_BUNDLE_BYTES,
      "Oversized transcript",
    );
    assert.equal(
      JSON.parse(bytes).accountId,
      profile.accountId,
      "Transcript account mismatch",
    );
    if (size && size + bytes.length > maxBytes) await flush();
    entries.push({ profile, bytes });
    size += bytes.length;
  }
  await flush();
  return { data: result, manifest: { version: 1, objects } };
}

export function resolveTranscript(profile, bytes) {
  const proof = profile.provenance;
  if (!proof.sourceArtifactFormat) {
    assert.equal(
      sha256(bytes),
      proof.sourceContentSha256,
      `Legacy artifact checksum: ${profile.id}`,
    );
    return { bytes, legacy: true };
  }
  assert.equal(proof.sourceArtifactFormat, "gzip_jsonl_v1");
  assert.equal(
    sha256(bytes),
    proof.sourceArtifactSha256,
    "Bundle object checksum",
  );
  assert.equal(
    proof.sourceArtifactRecordId,
    proof.sourceContentSha256,
    "Record identity checksum",
  );
  const plaintext = gunzipSync(bytes, {
    maxOutputLength: MAX_TRANSCRIPT_BUNDLE_BYTES,
  });
  const offset = proof.sourceArtifactByteOffset,
    length = proof.sourceArtifactByteLength;
  assert.ok(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(length) &&
      length > 1 &&
      offset + length <= plaintext.length,
    "Invalid bundle locator",
  );
  assert.ok(
    offset === 0 || plaintext[offset - 1] === 10,
    "Locator does not start at record boundary",
  );
  const recordBytes = plaintext.subarray(offset, offset + length);
  assert.equal(
    recordBytes.at(-1),
    10,
    "Locator does not end at record boundary",
  );
  assert.equal(
    sha256(recordBytes),
    proof.sourceContentSha256,
    "Transcript record checksum",
  );
  const transcript = JSON.parse(recordBytes.toString("utf8"));
  assert.equal(
    transcript.accountId,
    profile.accountId,
    "Transcript belongs to another account",
  );
  for (const span of profile.evidenceSpans) {
    const post = transcript.posts.find(
      (p) =>
        p.postId === span.postId &&
        p.sourceArtifactSha256 === span.sourceArtifactSha256 &&
        p.sourceUrl === span.sourceUrl,
    );
    assert.ok(post, "Evidence post absent from transcript");
    assert.equal(
      Array.from(post.text).slice(span.start, span.end).join(""),
      span.quote,
      "Evidence source span mismatch",
    );
  }
  return { bytes: recordBytes, transcript, legacy: false };
}

/** Verify all profiles before any upload or SQL; optional extra manifest includes raw audit bundles. */
export async function verifyArtifacts(data, directory, extraManifest) {
  const byKey = new Map();
  if (!extraManifest && data.rawArtifactIndex)
    extraManifest = JSON.parse(
      await readFile(
        join(resolve(directory), basename(data.rawArtifactIndex.key)),
        "utf8",
      ),
    );
  const extras = extraManifest?.objects ?? [];
  for (const object of extras) {
    assert.ok(object.key.startsWith("corpus/") && !object.key.includes(".."));
    assert.match(object.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      object.key.includes(object.sha256),
      "Artifact keys must contain object SHA",
    );
    const file = object.file
      ? resolve(object.file)
      : join(resolve(directory), basename(object.key));
    const bytes = await readFile(file);
    assert.ok(bytes.length <= MAX_OBJECT_BYTES);
    assert.equal(sha256(bytes), object.sha256, "Audit artifact checksum");
    byKey.set(object.key, { ...object, file });
  }
  const verifiedRaw = new Set();
  let collectionVerified = false;
  if (data.rawArtifactIndex) {
    const indexPath = join(
      resolve(directory),
      basename(data.rawArtifactIndex.key),
    );
    const indexBytes = await readFile(indexPath);
    assert.equal(
      sha256(indexBytes),
      data.rawArtifactIndex.sha256,
      "Raw artifact index checksum",
    );
    const index = JSON.parse(indexBytes);
    assert.equal(
      index.collectionManifestSha256,
      data.collectionManifestSha256,
      "Collection manifest identity",
    );
    for (const object of index.objects) {
      const known = byKey.get(object.key);
      assert.ok(
        known && known.sha256 === object.sha256,
        "Raw bundle absent from upload manifest",
      );
      const plain = gunzipSync(await readFile(known.file), {
        maxOutputLength: 256 * 1024 * 1024,
      });
      for (const record of index.records.filter(
        (r) => r.bundleKey === object.key,
      )) {
        assert.equal(record.bundleSha256, object.sha256);
        const { byteOffset: offset, byteLength: length } = record;
        assert.ok(
          Number.isSafeInteger(offset) &&
            offset >= 0 &&
            Number.isSafeInteger(length) &&
            length > 1 &&
            offset + length <= plain.length,
          "Raw locator bounds",
        );
        assert.ok(
          offset === 0 || plain[offset - 1] === 10,
          "Raw record boundary",
        );
        const bytes = plain.subarray(offset, offset + length);
        assert.equal(bytes.at(-1), 10);
        assert.equal(sha256(bytes), record.recordSha256, "Raw record checksum");
        if (object.kind === "collection_manifest") {
          assert.equal(record.recordId, data.collectionManifestSha256);
          assert.equal(sha256(bytes), data.collectionManifestSha256);
          collectionVerified = true;
        } else if (object.kind === "raw") {
          const raw = JSON.parse(bytes);
          const source = Buffer.from(raw.contentBase64, "base64");
          assert.equal(source.length, raw.sourceBytes);
          assert.equal(sha256(source), record.recordId);
          assert.equal(raw.sourceSha256, record.recordId);
          verifiedRaw.add(record.recordId);
        }
      }
    }
    assert.ok(collectionVerified, "Collection manifest record unverified");
    assert.equal(
      verifiedRaw.size,
      index.rawArtifactCount,
      "Raw archive coverage count mismatch",
    );
    byKey.set(data.rawArtifactIndex.key, {
      key: data.rawArtifactIndex.key,
      file: indexPath,
      sha256: data.rawArtifactIndex.sha256,
      bytes: indexBytes.length,
      kind: "raw_index",
    });
  }
  const cache = new Map();
  for (const profile of data.profiles) {
    const key = profile.provenance.sourceArtifactKey;
    const file =
      byKey.get(key)?.file ?? join(resolve(directory), basename(key));
    if (!cache.has(key)) cache.set(key, await readFile(file));
    const bytes = cache.get(key);
    assert.ok(bytes.length <= MAX_OBJECT_BYTES);
    resolveTranscript(profile, bytes);
    if (profile.evidenceTier) {
      assert.ok(
        data.rawArtifactIndex,
        "Expanded profiles require a durable raw provenance index",
      );
      for (const span of profile.evidenceSpans)
        assert.ok(
          verifiedRaw.has(span.sourceArtifactSha256),
          "Cited raw source absent from verified archive",
        );
    }
    if (!byKey.has(key))
      byKey.set(key, {
        key,
        file,
        sha256: sha256(bytes),
        bytes: bytes.length,
        kind: profile.provenance.sourceArtifactFormat
          ? "transcript_bundle"
          : "legacy_individual",
      });
  }
  return [...byKey.values()];
}
