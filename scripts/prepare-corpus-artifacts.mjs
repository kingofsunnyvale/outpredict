import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  bundleTranscripts,
  immutableWrite,
  sha256,
  verifyArtifacts,
} from "./corpus-artifacts.mjs";
import { validateCorpus } from "./validate-corpus.mjs";

const args = process.argv.slice(2);
const flag = (key) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
for (const name of ["--data", "--transcripts", "--artifacts", "--output"])
  if (!flag(name)) throw new Error(`Required ${name}`);
const source = JSON.parse(await readFile(resolve(flag("--data")), "utf8"));
validateCorpus(source);
const { data, manifest } = await bundleTranscripts(
  source,
  resolve(flag("--transcripts")),
  resolve(flag("--artifacts")),
);
if (flag("--extra-manifest")) {
  const extra = JSON.parse(
    await readFile(resolve(flag("--extra-manifest")), "utf8"),
  );
  manifest.objects.push(...extra.objects);
  const index = {
    version: extra.version,
    collectionManifestSha256: extra.collectionManifestSha256,
    rawArtifactCount: extra.rawArtifactCount,
    objects: extra.objects.map(({ file, ...record }) => record),
    records: extra.records,
  };
  const indexBytes = Buffer.from(JSON.stringify(index) + "\n"),
    hash = sha256(indexBytes),
    key = `corpus/out11-2026-09-10/raw-index/${hash}.json`;
  await immutableWrite(
    join(resolve(flag("--artifacts")), `${hash}.json`),
    indexBytes,
  );
  data.rawArtifactIndex = { key, sha256: hash };
  manifest.objects.push({
    key,
    file: join(resolve(flag("--artifacts")), `${hash}.json`),
    sha256: hash,
    bytes: indexBytes.length,
    kind: "raw_index",
  });
}
validateCorpus(data);
await verifyArtifacts(data, resolve(flag("--artifacts")), manifest);
const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n");
await immutableWrite(resolve(flag("--output")), bytes);
await immutableWrite(
  join(resolve(flag("--artifacts")), `${sha256(bytes)}-manifest.json`),
  Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
);
console.log(
  JSON.stringify({
    datasetSha256: sha256(bytes),
    output: resolve(flag("--output")),
    objects: manifest.objects.length,
    ...validateCorpus(data),
  }),
);
