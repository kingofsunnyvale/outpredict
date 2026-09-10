import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  for (const p of data.profiles) {
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
      `INSERT INTO corpus_profiles(id,account_id,cycle,version,is_current,review_status,observed_at,gpa,science_gpa,mcat,residence,summary,timing_status,activities_json,profile_json,content_sha256) VALUES(${values.map(quote)}) ON CONFLICT(id) DO UPDATE SET is_current=1,review_status=excluded.review_status,observed_at=excluded.observed_at,gpa=excluded.gpa,science_gpa=excluded.science_gpa,mcat=excluded.mcat,residence=excluded.residence,summary=excluded.summary,timing_status=excluded.timing_status,activities_json=excluded.activities_json,profile_json=excluded.profile_json,content_sha256=excluded.content_sha256;`,
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
    `INSERT INTO corpus_imports(release,content_sha256,imported_at,profile_count,account_count) VALUES(${[data.release, sha(JSON.stringify(data)), new Date().toISOString(), counts.profiles, counts.sourceAccounts].map(quote)}) ON CONFLICT(release) DO UPDATE SET content_sha256=excluded.content_sha256,imported_at=excluded.imported_at,profile_count=excluded.profile_count,account_count=excluded.account_count;`,
  );
  return `${statements.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const environment = flag("--env");
  const output = flag("--sql");
  const artifacts = flag("--artifacts");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const data = JSON.parse(
    await readFile(join(root, "data/corpus.json"), "utf8"),
  );
  const sql = corpusSql(data);
  if (output) {
    await writeFile(resolve(output), sql);
    console.log(
      JSON.stringify({ written: resolve(output), ...validateCorpus(data) }),
    );
  } else {
    if (!["staging", "production"].includes(environment))
      throw new Error(
        "Use --env staging|production, or --sql PATH to generate reviewable SQL.",
      );
    const remote = args.includes("--remote");
    if (environment === "production" && !remote)
      throw new Error("Production import must explicitly specify --remote.");
    const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
    const run = (argv) => {
      const result = spawnSync(
        process.execPath,
        [wrangler, ...argv, "--config", join(root, "wrangler.jsonc")],
        { cwd: root, stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error("Corpus import command failed.");
    };
    if (artifacts) {
      const verified = [];
      for (const p of data.profiles) {
        const file = join(
          resolve(artifacts),
          p.provenance.sourceArtifactKey.split("/").at(-1),
        );
        const bytes = await readFile(file);
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          p.provenance.sourceContentSha256
        )
          throw new Error(`Artifact checksum mismatch: ${p.id}`);
        verified.push({ p, file });
      }
      for (const { p, file } of verified) {
        const bucket =
          environment === "production"
            ? "outpredict-data"
            : "outpredict-staging-data";
        run([
          "r2",
          "object",
          "put",
          `${bucket}/${p.provenance.sourceArtifactKey}`,
          "--file",
          file,
          "--content-type",
          "text/plain;charset=utf-8",
          remote ? "--remote" : "--local",
        ]);
      }
    }
    const directory = join(tmpdir(), "outpredict-corpus-import");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${environment}.sql`);
    await writeFile(file, sql);
    run([
      "d1",
      "execute",
      "DB",
      "--env",
      environment,
      remote ? "--remote" : "--local",
      "--file",
      file,
      "--yes",
    ]);
    console.log(
      JSON.stringify({ environment, remote, ...validateCorpus(data) }),
    );
  }
}
