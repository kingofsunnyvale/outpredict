import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCorpus } from "./validate-corpus.mjs";

export function corpusSql(data) {
  const counts = validateCorpus(data);
  const quote = (x) =>
    x === null || x === undefined
      ? "NULL"
      : typeof x === "number"
        ? String(x)
        : `'${String(x).replaceAll("'", "''")}'`;
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const statements = [];
  if (data.version === 2)
    statements.push(
      "INSERT INTO corpus_release_guard(release,valid) VALUES(" +
        quote(data.release) +
        ",CASE WHEN EXISTS(SELECT 1 FROM corpus_imports WHERE release=" +
        quote(data.release) +
        ") AND NOT EXISTS(SELECT 1 FROM corpus_active_release WHERE id=1 AND release=" +
        quote(data.release) +
        " AND content_sha256=" +
        quote(sha(JSON.stringify(data))) +
        ") THEN 0 ELSE 1 END) ON CONFLICT(release) DO UPDATE SET valid=excluded.valid;",
    );

  if (data.version === 2)
    statements.push(
      `INSERT INTO corpus_release_activation(release,previous_release) VALUES(${quote(data.release)},(SELECT release FROM corpus_active_release WHERE id=1)) ON CONFLICT(release) DO NOTHING;`,
    );
  for (const p of data.profiles) {
    if (data.version === 2)
      statements.push(
        `INSERT INTO corpus_release_changes(release,profile_id,previous_current_id) VALUES(${quote(data.release)},${quote(p.id)},(SELECT id FROM corpus_profiles WHERE account_id=${quote(p.accountId)} AND cycle=${quote(p.cycle)} AND is_current=1)) ON CONFLICT(release,profile_id) DO NOTHING;`,
      );
    statements.push(
      `INSERT INTO corpus_accounts(id,source,source_account_id,public_handle) VALUES(${[p.accountId, p.source, p.sourceAccountId, p.publicHandle].map(quote)}) ON CONFLICT(id) DO UPDATE SET public_handle=excluded.public_handle;`,
    );
    statements.push(
      `UPDATE corpus_profiles SET is_current=0 WHERE account_id=${quote(p.accountId)} AND cycle=${quote(p.cycle)} AND id<>${quote(p.id)};`,
    );
    const values = [
      p.id,
      p.accountId,
      p.cycle,
      p.version ?? 1,
      1,
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
      sha(JSON.stringify(p)),
    ];
    statements.push(
      `INSERT INTO corpus_profiles(id,account_id,cycle,version,is_current,review_status,observed_at,gpa,science_gpa,mcat,residence,summary,timing_status,activities_json,profile_json,content_sha256) VALUES(${values.map(quote)}) ON CONFLICT(id) DO UPDATE SET is_current=1,review_status=excluded.review_status,observed_at=excluded.observed_at,gpa=excluded.gpa,science_gpa=excluded.science_gpa,mcat=excluded.mcat,residence=excluded.residence,summary=excluded.summary,timing_status=excluded.timing_status,activities_json=excluded.activities_json,profile_json=excluded.profile_json,content_sha256=CASE WHEN corpus_profiles.content_sha256=excluded.content_sha256 THEN corpus_profiles.content_sha256 ELSE NULL END;`,
    );
    statements.push(
      `DELETE FROM corpus_outcomes WHERE profile_id=${quote(p.id)};`,
    );
    p.outcomes.forEach((o, i) => {
      statements.push(
        `INSERT INTO corpus_outcomes(id,profile_id,account_id,cycle,status,program,school,reported_count,count_kind,conditional,source_url,evidence) VALUES(${[`${p.id}:${i}`, p.id, p.accountId, o.cycle, o.status, o.program, o.school, o.reportedCount, o.countKind, o.conditional ? 1 : 0, o.sourceUrl, o.evidence].map(quote)});`,
      );
    });
  }
  statements.push(
    `INSERT INTO corpus_imports(release,content_sha256,imported_at,profile_count,account_count) VALUES(${[
      data.release,
      sha(JSON.stringify(data)),
      data.collectionAsOf ??
        data.profiles
          .map((p) => p.reviewedAt ?? p.observedAt)
          .sort()
          .at(-1),
      counts.profiles,
      counts.sourceAccounts,
    ].map(
      quote,
    )}) ON CONFLICT(release) DO UPDATE SET content_sha256=CASE WHEN corpus_imports.content_sha256=excluded.content_sha256 THEN corpus_imports.content_sha256 ELSE NULL END;`,
  );
  if (data.version === 2) {
    if (!data.collectionReport || !data.collectionManifestSha256)
      throw new Error(
        "Version2 requires a frozen collection report and manifest SHA",
      );
    statements.push(
      `INSERT INTO corpus_collection_runs(release,as_of,manifest_sha256,report_json,imported_at) VALUES(${[data.release, data.collectionAsOf, data.collectionManifestSha256, JSON.stringify(data.collectionReport), data.collectionAsOf].map(quote)}) ON CONFLICT(release) DO UPDATE SET manifest_sha256=CASE WHEN corpus_collection_runs.manifest_sha256=excluded.manifest_sha256 THEN corpus_collection_runs.manifest_sha256 ELSE NULL END;`,
    );
  }
  if (data.version === 2)
    statements.push(
      `INSERT INTO corpus_active_release(id,release,content_sha256) VALUES(1,${quote(data.release)},${quote(sha(JSON.stringify(data)))}) ON CONFLICT(id) DO UPDATE SET release=excluded.release,content_sha256=excluded.content_sha256;`,
    );
  if (data.version === 2)
    statements.push(
      "INSERT INTO corpus_release_guard(release,valid) VALUES(" +
        quote(data.release) +
        ",CASE WHEN EXISTS(SELECT 1 FROM corpus_profiles p WHERE p.is_current=1 AND NOT EXISTS(SELECT 1 FROM corpus_release_changes c WHERE c.release=" +
        quote(data.release) +
        " AND c.profile_id=p.id)) THEN 0 ELSE 1 END) ON CONFLICT(release) DO UPDATE SET valid=excluded.valid;",
    );
  for (const statement of statements)
    if (Buffer.byteLength(statement, "utf8") >= 100000)
      throw new Error("SQL statement exceeds D1 100KB limit");
  return `${statements.join("\n")}\n`;
}

import { readFileSync } from "node:fs";
import {
  immutableWrite,
  sha256,
  verifyArtifacts,
} from "./corpus-artifacts.mjs";

const baselineIds = new Set(
  Object.keys(
    JSON.parse(
      readFileSync(
        new URL("../data/corpus-baseline-v1-sha256.json", import.meta.url),
        "utf8",
      ),
    ).profiles,
  ),
);
const sqlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
/** Release-scoped deactivation; never restore the whole D1 holding user data. */
export function rollbackSql(data) {
  validateCorpus(data);
  if (data.version !== 2)
    return "-- Baseline rollback is deliberately not generated.\n";
  const release = sqlQuote(data.release),
    hash = sqlQuote(sha256(JSON.stringify(data)));
  const guard = `EXISTS(SELECT 1 FROM corpus_active_release WHERE id=1 AND release=${release} AND content_sha256=${hash})`;
  const statements = [];
  for (const p of data.profiles.filter((p) => !baselineIds.has(p.id))) {
    statements.push(
      `UPDATE corpus_profiles SET is_current=0 WHERE id=${sqlQuote(p.id)} AND content_sha256=${sqlQuote(sha256(JSON.stringify(p)))} AND ${guard};`,
    );
    statements.push(
      `UPDATE corpus_profiles SET is_current=1 WHERE id=(SELECT previous_current_id FROM corpus_release_changes WHERE release=${release} AND profile_id=${sqlQuote(p.id)}) AND ${guard};`,
    );
  }
  // Keep the immutable import/audit history. Change only the active pointer.
  statements.push(
    `UPDATE corpus_active_release SET release=(SELECT previous_release FROM corpus_release_activation WHERE release=${release}),content_sha256=(SELECT content_sha256 FROM corpus_imports WHERE release=(SELECT previous_release FROM corpus_release_activation WHERE release=${release})) WHERE ${guard} AND (SELECT previous_release FROM corpus_release_activation WHERE release=${release}) IS NOT NULL;`,
  );
  statements.push(
    `DELETE FROM corpus_active_release WHERE ${guard} AND (SELECT previous_release FROM corpus_release_activation WHERE release=${release}) IS NULL;`,
  );
  return statements.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dataPath = resolve(flag("--data") ?? join(root, "data/corpus.json"));
  const dataBytes = await readFile(dataPath);
  const data = JSON.parse(dataBytes);
  const counts = validateCorpus(data),
    sql = corpusSql(data),
    sqlHash = sha256(sql),
    datasetHash = sha256(dataBytes);
  const environment = flag("--env"),
    remote = args.includes("--remote");
  if (flag("--sql")) {
    await immutableWrite(resolve(flag("--sql")), Buffer.from(sql));
    if (flag("--rollback"))
      await immutableWrite(
        resolve(flag("--rollback")),
        Buffer.from(rollbackSql(data)),
      );
    console.log(
      JSON.stringify({
        written: resolve(flag("--sql")),
        sqlSha256: sqlHash,
        datasetSha256: datasetHash,
        ...counts,
      }),
    );
  } else {
    if (!["staging", "production"].includes(environment))
      throw new Error(
        "Use --env staging|production, or --sql PATH for offline preparation.",
      );
    if (environment === "production" && !remote)
      throw new Error("Production requires explicit --remote.");
    if (
      data.version === 2 &&
      !args.includes("--activate-v2") &&
      !args.includes("--upload-only")
    )
      throw new Error(
        "Verify compatible deployed runtime first, then pass --activate-v2.",
      );
    const directory = resolve(
      flag("--receipts") ??
        join(
          root,
          ".local",
          "corpus-import",
          environment,
          remote ? "remote" : "local",
          datasetHash,
        ),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sqlPath = join(directory, `${sqlHash}.sql`);
    await immutableWrite(sqlPath, Buffer.from(sql));
    await immutableWrite(
      join(directory, `${sqlHash}.rollback.sql`),
      Buffer.from(rollbackSql(data)),
    );
    const run = (argv, capture = false) => {
      const r = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/wrangler/bin/wrangler.js"),
          ...argv,
          "--config",
          join(root, "wrangler.jsonc"),
        ],
        {
          cwd: root,
          stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
          encoding: capture ? "utf8" : undefined,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (r.status !== 0)
        throw new Error(
          "Corpus provider command failed; no success receipt written.",
        );
      return r.stdout;
    };
    const bucket =
      environment === "production"
        ? "outpredict-data"
        : "outpredict-staging-data";
    if (flag("--artifacts")) {
      const manifest = flag("--manifest")
        ? JSON.parse(await readFile(resolve(flag("--manifest")), "utf8"))
        : undefined;
      const objects = await verifyArtifacts(
        data,
        resolve(flag("--artifacts")),
        manifest,
      );
      const upload = objects.map((o) => ({ key: o.key, file: o.file }));
      const uploadPath = join(
        directory,
        `${sha256(JSON.stringify(upload))}.upload.json`,
      );
      await immutableWrite(
        uploadPath,
        Buffer.from(JSON.stringify(upload, null, 2) + "\n"),
      );
      if (remote)
        run([
          "r2",
          "bulk",
          "put",
          bucket,
          "--filename",
          uploadPath,
          "--remote",
          "--concurrency",
          "4",
          "--force",
        ]);
      else
        for (const o of objects)
          run([
            "r2",
            "object",
            "put",
            `${bucket}/${o.key}`,
            "--file",
            o.file,
            "--local",
          ]);
      // Native bulk progress precedes completion; exit0 plus byte readback is required.
      for (const object of objects) {
        const file = join(directory, `${object.sha256}.verify`);
        run([
          "r2",
          "object",
          "get",
          `${bucket}/${object.key}`,
          "--file",
          file,
          remote ? "--remote" : "--local",
        ]);
        if (sha256(await readFile(file)) !== object.sha256)
          throw new Error("Uploaded artifact readback checksum failed");
        await rm(file);
      }
      await immutableWrite(
        join(directory, "artifacts-verified.json"),
        Buffer.from(
          JSON.stringify(
            {
              environment,
              remote,
              datasetSha256: datasetHash,
              collectionManifestSha256: data.collectionManifestSha256,
              rawEvidenceVerified: data.version === 2,
              objects: objects.map(({ key, sha256: hash, bytes }) => ({
                key,
                sha256: hash,
                bytes,
              })),
            },
            null,
            2,
          ) + "\n",
        ),
      );
    } else if (data.version === 2) {
      const receipt = JSON.parse(
        await readFile(
          resolve(
            flag("--artifact-receipt") ??
              join(directory, "artifacts-verified.json"),
          ),
          "utf8",
        ),
      );
      if (
        receipt.environment !== environment ||
        receipt.remote !== remote ||
        receipt.datasetSha256 !== datasetHash
      )
        throw new Error(
          "Artifact receipt does not match target dataset/environment",
        );
      if (
        data.version === 2 &&
        (!receipt.rawEvidenceVerified ||
          receipt.collectionManifestSha256 !== data.collectionManifestSha256 ||
          !receipt.objects.some(
            (o) =>
              o.key === data.rawArtifactIndex?.key &&
              o.sha256 === data.rawArtifactIndex?.sha256,
          ))
      )
        throw new Error("Raw evidence verification missing from receipt");
      for (const p of data.profiles)
        if (
          !receipt.objects.some(
            (o) =>
              o.key === p.provenance.sourceArtifactKey &&
              o.sha256 ===
                (p.provenance.sourceArtifactSha256 ??
                  p.provenance.sourceContentSha256),
          )
        )
          throw new Error("Artifact receipt missing a profile source");
    }
    if (!args.includes("--upload-only")) {
      run([
        "d1",
        "execute",
        "DB",
        "--env",
        environment,
        remote ? "--remote" : "--local",
        "--file",
        sqlPath,
        "--yes",
      ]);
      const query = `SELECT release,content_sha256,profile_count,account_count FROM corpus_imports WHERE release=${sqlQuote(data.release)}; SELECT COUNT(*) AS profiles,COUNT(DISTINCT account_id) AS accounts FROM corpus_profiles WHERE is_current=1 AND review_status='reviewed'; SELECT COUNT(*) AS outcomes FROM corpus_outcomes o JOIN corpus_profiles p ON p.id=o.profile_id WHERE p.is_current=1; PRAGMA foreign_key_check;`;
      const output = run(
        [
          "d1",
          "execute",
          "DB",
          "--env",
          environment,
          remote ? "--remote" : "--local",
          "--command",
          query,
          "--json",
        ],
        true,
      );
      const check = JSON.parse(output);
      const rows = check.flatMap((entry) => entry.results ?? []);
      if (
        !rows.some(
          (r) =>
            r.release === data.release &&
            r.content_sha256 === sha256(JSON.stringify(data)) &&
            r.profile_count === counts.profiles &&
            r.account_count === counts.sourceAccounts,
        ) ||
        !rows.some(
          (r) =>
            r.profiles === counts.profiles &&
            r.accounts === counts.sourceAccounts,
        ) ||
        !rows.some((r) => r.outcomes === counts.outcomeObservations) ||
        check.at(-1)?.results?.length
      )
        throw new Error(
          "D1 release readback mismatch; inspect provider state before retry",
        );
      await immutableWrite(
        join(directory, "import-verified.json"),
        Buffer.from(
          JSON.stringify(
            {
              environment,
              remote,
              datasetSha256: datasetHash,
              sqlSha256: sqlHash,
              ...counts,
            },
            null,
            2,
          ) + "\n",
        ),
      );
    }
    console.log(
      JSON.stringify({
        environment,
        remote,
        uploadOnly: args.includes("--upload-only"),
        datasetSha256: datasetHash,
        sqlSha256: sqlHash,
        receipts: directory,
        ...counts,
      }),
    );
  }
}
