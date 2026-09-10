#!/usr/bin/env node
/**
 * Deployed API smoke checks using synthetic users, never a real user's session.
 *
 * node scripts/smoke-product.mjs --env staging
 * node scripts/smoke-product.mjs --env staging --storage-only
 * node scripts/smoke-product.mjs --env production --agent
 * node scripts/smoke-product.mjs --env staging --agent --report /tmp/corpus-smoke.json
 * node scripts/smoke-product.mjs --env staging --cleanup /tmp/.../cleanup.json
 * node scripts/smoke-product.mjs --self-test
 *
 * Requires Node 24, the project-local Wrangler login (or CLOUDFLARE_API_TOKEN),
 * and ignored mode-0600 .env.auth-<environment>.json. Apply migrations and deploy
 * the product endpoints first. --storage-only skips the streaming endpoint for
 * the storage release. Default checks do not call AI. --agent retries
 * one synthetic cancelled turn through the real agent and consumes normal usage.
 * --report writes only the resulting answer, evidence, and summarized progress.
 * This verifies signed database sessions; it does not replace a Google OAuth
 * browser round trip. Synthetic history/cancellation fixtures are seeded in D1.
 *
 * Wrangler --file uses bulk import, so smoke setup uses the parameterized D1
 * query API instead. Credentials stay in memory and never enter command args,
 * SQL files, reports, or Wrangler logs. Cleanup is scoped to exact fixture IDs.
 */
import { execFile } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateCorpus } from "./validate-corpus.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const fixturePattern = /^outpredict-smoke-[a-f0-9-]{36}-[ab]$/;
const question =
  "Use the reviewed applicant corpus with no filters. Compare two reported applicants and explain matched, examined, and supporting counts. State the sample limitations. Keep the answer under 200 words.";
const syntheticText =
  "Synthetic test résumé. GPA 3.75. MCAT 515. Clinical volunteering: 250 completed hours. This document contains no real person's information.";
class SmokeFailure extends Error {}
function ensure(value, code) {
  if (!value) throw new SmokeFailure(code);
}
function report(check, details = {}) {
  console.log(JSON.stringify({ check, ...details }));
}

function argumentsFor(argv) {
  const options = { agent: false, storageOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--self-test") options.selfTest = true;
    else if (flag === "--agent") options.agent = true;
    else if (flag === "--storage-only") options.storageOnly = true;
    else if (flag === "--env" || flag === "--cleanup" || flag === "--report") {
      ensure(argv[i + 1] && !argv[i + 1].startsWith("--"), "missing_argument");
      options[flag.slice(2)] = argv[++i];
    } else throw new SmokeFailure("unknown_argument");
  }
  if (!options.help && !options.selfTest)
    ensure(
      ["staging", "production"].includes(options.env),
      "explicit_environment_required",
    );
  ensure(!(options.cleanup && options.agent), "cleanup_cannot_run_agent");
  ensure(
    !(options.storageOnly && options.agent),
    "storage_only_cannot_run_agent",
  );
  ensure(!options.report || options.agent, "report_requires_agent");
  return options;
}

function sessionCookie(token, secret) {
  // Matches Better Auth 1.7.3 and test/auth.test.ts: HMAC-SHA256, base64, URL encoded.
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `__Secure-outpredict.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function boundedText(response, maximum = 1_000_000) {
  ensure(response.body, "missing_response_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      ensure(size <= maximum, "response_size_limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function jsonBody(response) {
  try {
    return JSON.parse(await boundedText(response));
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure("invalid_json_response");
  }
}

async function consumeEvents(response, onEvent = async () => {}) {
  ensure(response.status === 200, `stream_http_${response.status}`);
  ensure(
    response.headers.get("content-type")?.includes("text/event-stream"),
    "stream_content_type",
  );
  ensure(response.body, "missing_stream_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {
    text: "",
    evidence: null,
    meta: null,
    status: null,
    events: 0,
  };
  let buffer = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      ensure(bytes <= 2_000_000, "stream_size_limit");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new SmokeFailure("invalid_stream_event");
        }
        ensure(event && typeof event === "object", "invalid_stream_shape");
        ensure(
          !("reasoning" in event) && !("reasoning_content" in event),
          "reasoning_boundary",
        );
        state.events++;
        if (event.type === "meta") state.meta = event;
        if (event.type === "delta") {
          ensure(typeof event.text === "string", "invalid_delta");
          state.text += event.text;
          ensure(state.text.length <= 120_000, "answer_size_limit");
        }
        if (event.type === "evidence") state.evidence = event.evidence;
        if (event.type === "done") state.status = event.status;
        if (event.type === "error")
          throw new SmokeFailure("agent_stream_failed");
        await onEvent(event);
      }
    }
    ensure(state.meta && state.status, "incomplete_stream");
    return state;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function main(options) {
  ensure(Number(process.versions.node.split(".")[0]) >= 24, "node_24_required");
  const config = JSON.parse(
    await readFile(join(root, "wrangler.jsonc"), "utf8"),
  );
  const selected = config.env?.[options.env];
  const expectedName =
    options.env === "staging" ? "outpredict-staging" : "outpredict";
  const db = selected?.d1_databases?.find((value) => value.binding === "DB");
  const bucket = selected?.r2_buckets?.find(
    (value) => value.binding === "DATA",
  )?.bucket_name;
  const origin = new URL(selected?.vars?.AUTH_URL);
  ensure(
    selected?.name === expectedName &&
      db?.database_name === expectedName &&
      bucket === `${expectedName}-data`,
    "unexpected_environment_resources",
  );
  ensure(
    origin.protocol === "https:" && origin.href === `${origin.origin}/`,
    "invalid_configured_origin",
  );
  ensure(
    /^[a-f0-9]{32}$/.test(config.account_id) &&
      /^[a-f0-9-]{36}$/.test(db.database_id),
    "invalid_resource_ids",
  );
  const runDirectory = await mkdtemp(join(tmpdir(), "outpredict-smoke-"));
  await chmod(runDirectory, 0o700);
  const logPath = join(runDirectory, "wrangler.log");
  // Wrangler logs logger output, including auth-token output. Send it to the
  // platform's null device, while stdout stays captured and is never forwarded.
  await symlink(devNull, logPath);
  const manifestPath = options.cleanup
    ? resolve(options.cleanup)
    : join(runDirectory, "cleanup.json");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let cfHeaders;
  let created = false;
  let clean = false;
  let phase = "configuration";
  let manifest;
  let cookieA;
  let cookieB;
  let failure;
  const knownKeys = new Set();
  const timeout = (ms, cleanup = false) =>
    cleanup
      ? AbortSignal.timeout(ms)
      : AbortSignal.any([AbortSignal.timeout(ms), controller.signal]);

  async function cloudflare(path, init = {}, cleanup = false) {
    return fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.account_id}${path}`,
      {
        ...init,
        headers: { ...cfHeaders, ...init.headers },
        redirect: "error",
        signal: timeout(30_000, cleanup),
      },
    );
  }
  async function query(sql, params = [], cleanup = false) {
    const response = await cloudflare(
      `/d1/database/${db.database_id}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
      cleanup,
    );
    ensure(response.ok, `d1_http_${response.status}`);
    const result = await jsonBody(response);
    ensure(
      result.success &&
        Array.isArray(result.result) &&
        result.result.every((part) => part.success),
      "d1_query_failed",
    );
    return result.result.flatMap((part) => part.results ?? []);
  }
  async function api(
    path,
    cookie,
    { method = "GET", body, headers, expected = 200, stream = false } = {},
  ) {
    const response = await fetch(`${origin.origin}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET" ? { Origin: origin.origin } : {}),
        ...headers,
      },
      body,
      redirect: "error",
      signal: timeout(stream ? 180_000 : 30_000),
    });
    ensure(
      response.status === expected,
      `product_http_${response.status}_expected_${expected}`,
    );
    ensure(
      response.headers.get("cache-control")?.includes("no-store"),
      "private_cache_control",
    );
    return response;
  }
  const post = (path, cookie, value, extra = {}) =>
    api(path, cookie, {
      method: "POST",
      body: JSON.stringify(value),
      headers: { "Content-Type": "application/json" },
      ...extra,
    });
  async function cleanup() {
    if (!created) {
      clean = true;
      return;
    }
    const ids = manifest.userIds;
    ensure(
      ids.length === 2 && ids.every((id) => fixturePattern.test(id)),
      "unsafe_cleanup_ids",
    );
    const placeholders = ids.map(() => "?").join(",");
    await query(
      `UPDATE chat SET generation_id=NULL,lease_expires_at=NULL,deleting_at=? WHERE user_id IN (${placeholders})`,
      [Date.now(), ...ids],
      true,
    );
    // Invalidate the synthetic sessions even if R2 cleanup later needs a retry.
    await query(
      `DELETE FROM "session" WHERE "userId" IN (${placeholders})`,
      ids,
      true,
    );
    const files = await query(
      `SELECT r2_key FROM attachment WHERE user_id IN (${placeholders})`,
      ids,
      true,
    );
    for (const file of files) knownKeys.add(file.r2_key);
    for (const key of knownKeys) {
      ensure(
        ids.some((id) => key.startsWith(`users/${id}/attachments/`)) &&
          /^users\/[a-z0-9-]+\/attachments\/[a-f0-9-]{36}$/.test(key),
        "unsafe_cleanup_key",
      );
      const path = `/r2/buckets/${bucket}/objects/${key}`;
      const removed = await cloudflare(path, { method: "DELETE" }, true);
      ensure(
        removed.ok || removed.status === 404,
        `r2_cleanup_http_${removed.status}`,
      );
      await removed.body?.cancel();
      const checked = await cloudflare(path, {}, true);
      await checked.body?.cancel();
      ensure(checked.status === 404, "r2_cleanup_not_verified");
    }
    await query(`DELETE FROM "user" WHERE id IN (${placeholders})`, ids, true);
    const rows = await query(
      `SELECT COUNT(*) AS n FROM "user" WHERE id IN (${placeholders})`,
      ids,
      true,
    );
    ensure(rows[0]?.n === 0, "synthetic_rows_remain");
    clean = true;
    await rm(manifestPath, { force: true });
    report("cleanup", {
      status: "passed",
      syntheticUsers: 2,
      files: knownKeys.size,
    });
  }

  try {
    if (options.cleanup) {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      ensure(
        manifest.environment === options.env &&
          manifest.databaseId === db.database_id,
        "cleanup_environment_mismatch",
      );
      created = true;
      for (const key of manifest.keys ?? []) knownKeys.add(key);
    }
    phase = "cloudflare_credentials";
    if (process.env.CLOUDFLARE_API_TOKEN)
      cfHeaders = {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      };
    else {
      const result = await execute(
        process.execPath,
        [
          join(root, "node_modules/wrangler/bin/wrangler.js"),
          "auth",
          "token",
          "--json",
          "--config",
          join(root, "wrangler.jsonc"),
          "--env",
          options.env,
        ],
        {
          cwd: root,
          timeout: 60_000,
          maxBuffer: 1_000_000,
          env: {
            ...process.env,
            CI: "true",
            WRANGLER_SEND_METRICS: "false",
            WRANGLER_LOG_PATH: logPath,
          },
        },
      );
      const credentials = JSON.parse(result.stdout);
      if (credentials.token)
        cfHeaders = { Authorization: `Bearer ${credentials.token}` };
      else if (
        credentials.type === "api_key" &&
        credentials.key &&
        credentials.email
      )
        cfHeaders = {
          "X-Auth-Key": credentials.key,
          "X-Auth-Email": credentials.email,
        };
      else throw new SmokeFailure("cloudflare_credentials_unavailable");
    }
    if (options.cleanup) {
      phase = "cleanup";
      return;
    }
    phase = "health_and_schema";
    const health = await jsonBody(await api("/healthz"));
    ensure(
      health.service === "outpredict" &&
        health.environment === options.env &&
        health.status === "ok",
      "health_environment_mismatch",
    );
    const setup = await jsonBody(await api("/api/setup"));
    ensure(
      setup.googleSignIn === true && setup.environment === options.env,
      "authentication_not_configured",
    );
    const tables = await query(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    ensure(
      [
        "user",
        "session",
        "chat",
        "message",
        "attachment",
        "daily_usage",
        "daily_file_usage",
        "corpus_profiles",
      ].every((name) => tables.some((table) => table.name === name)),
      "migrations_not_deployed",
    );
    report(phase, { status: "passed", environment: options.env });

    phase = "synthetic_sessions";
    const secretFile = join(root, `.env.auth-${options.env}.json`);
    ensure(
      ((await stat(secretFile)).mode & 0o077) === 0,
      "auth_secret_file_permissions",
    );
    const { BETTER_AUTH_SECRET: secret } = JSON.parse(
      await readFile(secretFile, "utf8"),
    );
    ensure(
      typeof secret === "string" && secret.length >= 32,
      "auth_secret_unavailable",
    );
    const runId = randomUUID();
    const userIds = ["a", "b"].map(
      (suffix) => `outpredict-smoke-${runId}-${suffix}`,
    );
    manifest = {
      environment: options.env,
      databaseId: db.database_id,
      userIds,
      keys: [],
    };
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    // Mark before the first insert: an uncertain/partial request must still clean up.
    created = true;
    const cookies = [];
    for (const [i, id] of userIds.entries()) {
      const now = Date.now();
      const token = randomBytes(32).toString("hex");
      await query(
        'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
        [
          id,
          "Synthetic smoke applicant",
          `outpredict-smoke-${runId}-${i}@example.invalid`,
          now,
          now,
        ],
      );
      await query(
        'INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
        [randomUUID(), id, token, now + 15 * 60_000, now, now],
      );
      cookies.push(sessionCookie(token, secret));
    }
    [cookieA, cookieB] = cookies;
    for (const [i, cookie] of cookies.entries()) {
      const me = await jsonBody(await api("/api/me", cookie));
      ensure(me.user?.id === userIds[i], "signed_session_identity");
    }
    await api("/api/chats", undefined, { expected: 401 });
    report(phase, { status: "passed", accounts: 2 });

    phase = "corpus_counts";
    const local = JSON.parse(
      await readFile(join(root, "data/corpus.json"), "utf8"),
    );
    const expected = validateCorpus(local);
    const stats = await jsonBody(await api("/api/corpus/stats", cookieA));
    ensure(
      stats.totalProfiles === expected.sourceAccounts,
      "corpus_account_count_mismatch",
    );
    for (const [source, count] of Object.entries(expected.sources))
      ensure(
        stats.sourceCoverage?.find((row) => row.source === source)?.profiles ===
          count,
        "corpus_source_count_mismatch",
      );
    for (const [cycle, count] of Object.entries(expected.cycles))
      ensure(
        stats.cycles?.find((row) => row.cycle === cycle)?.profiles === count,
        "corpus_cycle_count_mismatch",
      );
    report(phase, { status: "passed", sourceAccounts: stats.totalProfiles });

    phase = "chat_and_file_isolation";
    const { chat } = await jsonBody(
      await post(
        "/api/chats",
        cookieA,
        { title: "Synthetic API smoke check" },
        { expected: 201 },
      ),
    );
    ensure(typeof chat?.id === "string", "chat_not_created");
    const path = `/api/chats/${chat.id}`;
    await api(path, cookieB, { expected: 404 });
    await api(path, cookieB, { method: "DELETE", expected: 404 });
    const otherChats = await jsonBody(await api("/api/chats", cookieB));
    ensure(otherChats.chats?.length === 0, "cross_user_chat_list");
    await api("/api/chats", cookieA, {
      method: "POST",
      body: "{}",
      headers: { Origin: "https://untrusted.example.invalid" },
      expected: 403,
    });
    const form = new FormData();
    form.set("chatId", chat.id);
    form.set(
      "file",
      new File([syntheticText], "synthetic-resume.txt", { type: "text/plain" }),
    );
    const { attachment } = await jsonBody(
      await api("/api/attachments", cookieA, {
        method: "POST",
        body: form,
        expected: 201,
      }),
    );
    ensure(attachment?.status === "ready", "text_upload_not_ready");
    const filePath = `/api/attachments/${attachment.id}`;
    knownKeys.add(`users/${userIds[0]}/attachments/${attachment.id}`);
    manifest.keys = [...knownKeys];
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await api(`${filePath}?download=1`, cookieB, { expected: 404 });
    await api(filePath, cookieB, { method: "DELETE", expected: 404 });
    ensure(
      (await boundedText(await api(`${filePath}?download=1`, cookieA))) ===
        syntheticText,
      "private_download_mismatch",
    );
    report(phase, { status: "passed" });

    phase = options.storageOnly
      ? "persistent_history"
      : "persistent_history_and_replay";
    const now = Date.now();
    const completed = {
      user: randomUUID(),
      assistant: randomUUID(),
      request: randomUUID(),
    };
    const previousText = "Synthetic stored history remains available. [A1]";
    const evidence = {
      sources: [
        {
          id: "A1",
          kind: "attachment",
          attachmentId: attachment.id,
          title: "Synthetic résumé",
          excerpt: syntheticText,
        },
      ],
    };
    await query(
      "INSERT INTO message (id,chat_id,role,content,status,client_request_id,created_at,updated_at) VALUES (?,?,'user',?,'complete',?,?,?)",
      [
        completed.user,
        chat.id,
        "Read this synthetic résumé",
        completed.request,
        now,
        now,
      ],
    );
    await query(
      "INSERT INTO message (id,chat_id,role,content,status,reply_to_id,evidence_json,created_at,updated_at) VALUES (?,?,'assistant',?,'complete',?,?,?,?)",
      [
        completed.assistant,
        chat.id,
        previousText,
        completed.user,
        JSON.stringify(evidence),
        now + 1,
        now + 1,
      ],
    );
    await query("UPDATE attachment SET message_id=? WHERE id=? AND user_id=?", [
      completed.user,
      attachment.id,
      userIds[0],
    ]);
    const reopened = await jsonBody(await api(path, cookieA));
    ensure(
      reopened.messages?.length === 2 &&
        reopened.messages[1]?.content === previousText,
      "history_not_persisted",
    );
    if (!options.storageOnly) {
      const replay = await consumeEvents(
        await post(
          `${path}/messages`,
          cookieA,
          {
            content: "Read this synthetic résumé",
            requestId: completed.request,
            retry: true,
          },
          { stream: true },
        ),
      );
      ensure(
        replay.status === "complete" &&
          replay.text === previousText &&
          replay.meta.assistantMessageId === completed.assistant,
        "completed_replay_mismatch",
      );
    }
    await api(filePath, cookieA, { method: "DELETE" });
    await api(filePath, cookieA, { expected: 404 });
    const removed = await jsonBody(await api(path, cookieA));
    ensure(
      removed.messages[1]?.content === previousText &&
        removed.messages[1]?.evidence?.sources.length === 0,
      "removed_file_evidence_retained",
    );
    report(phase, {
      status: "passed",
      fixtureSeededInD1: true,
      replayVerified: !options.storageOnly,
    });

    phase = "generation_cancellation";
    const cancelled = {
      user: randomUUID(),
      assistant: randomUUID(),
      request: randomUUID(),
    };
    const started = Date.now() + 2;
    await query(
      "INSERT INTO message (id,chat_id,role,content,status,client_request_id,created_at,updated_at) VALUES (?,?,'user',?,'complete',?,?,?)",
      [cancelled.user, chat.id, question, cancelled.request, started, started],
    );
    await query(
      "INSERT INTO message (id,chat_id,role,content,status,reply_to_id,created_at,updated_at) VALUES (?,?,'assistant','','running',?,?,?)",
      [cancelled.assistant, chat.id, cancelled.user, started + 1, started + 1],
    );
    await query(
      "UPDATE chat SET generation_id=?,lease_expires_at=? WHERE id=? AND user_id=?",
      [cancelled.assistant, Date.now() + 180_000, chat.id, userIds[0]],
    );
    ensure(
      (
        await jsonBody(
          await post(`${path}/cancel`, cookieA, { generationId: randomUUID() }),
        )
      ).cancelled === false,
      "stale_cancel_not_fenced",
    );
    ensure(
      (
        await jsonBody(
          await post(`${path}/cancel`, cookieA, {
            generationId: cancelled.assistant,
          }),
        )
      ).cancelled === true,
      "cancel_failed",
    );
    const stopped = await jsonBody(await api(path, cookieA));
    ensure(
      stopped.chat.generationId === null &&
        stopped.messages.at(-1)?.status === "cancelled",
      "cancel_not_persisted",
    );
    report(phase, { status: "passed", fixtureSeededInD1: true });

    if (options.agent) {
      phase = "real_agent_retry";
      const progressEvents = [];
      const startedAt = Date.now();
      const progress = setInterval(
        () =>
          report(phase, {
            status: "waiting",
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
          }),
        15_000,
      );
      let result;
      try {
        result = await consumeEvents(
          await post(
            `${path}/messages`,
            cookieA,
            {
              content: question,
              requestId: cancelled.request,
              retry: true,
            },
            { stream: true },
          ),
          async (event) => {
            if (event.type === "progress" && progressEvents.length < 100) {
              progressEvents.push(
                Object.fromEntries(
                  ["stage", "title", "detail"]
                    .filter((key) => typeof event[key] === "string")
                    .map((key) => [key, event[key].slice(0, 1000)]),
                ),
              );
            }
            if (event.type !== "meta") return;
            ensure(
              event.assistantMessageId !== cancelled.assistant,
              "retry_generation_not_rotated",
            );
            ensure(
              (
                await jsonBody(
                  await post(`${path}/cancel`, cookieA, {
                    generationId: cancelled.assistant,
                  }),
                )
              ).cancelled === false,
              "old_cancel_stopped_retry",
            );
          },
        );
      } finally {
        clearInterval(progress);
      }
      if (options.report) {
        // Exclusive creation prevents replacing an existing credential/artifact.
        // No cookies, headers, session IDs, or model metadata are saved.
        await writeFile(
          resolve(options.report),
          JSON.stringify(
            {
              answer: result.text,
              evidence: result.evidence,
              progress: progressEvents,
            },
            null,
            2,
          ),
          { mode: 0o600, flag: "wx" },
        );
      }
      ensure(
        result.status === "complete" && result.text.length >= 20,
        "agent_answer_incomplete",
      );
      {
        ensure(
          result.evidence?.cohort?.totalProfiles === expected.sourceAccounts,
          "agent_corpus_not_used",
        );
        ensure(
          !result.evidence.sources.some((source) =>
            ["official", "web"].includes(source.kind),
          ),
          "agent_unexpected_external_source",
        );
        ensure(
          !progressEvents.some((event) =>
            ["public_search", "fetch_public_page"].includes(event.stage),
          ),
          "agent_unexpected_external_tool",
        );
        const cohort = result.evidence.cohort;
        ensure(
          cohort.matchedProfiles >= cohort.examinedProfiles &&
            cohort.examinedProfiles > 0,
          "agent_cohort_counts_invalid",
        );
        const cited = new Set(
          [...result.text.matchAll(/\[([^\]\n]{1,100})\]/g)].flatMap(
            (match) => match[1].match(/\bP\d+\b/g) ?? [],
          ),
        );
        const supporting = new Set(
          result.evidence.sources
            .filter(
              (source) => source.kind === "profile" && cited.has(source.id),
            )
            .map((source) => source.applicantId),
        );
        ensure(
          supporting.size > 0 && cohort.supportingProfiles === supporting.size,
          "agent_supporting_count_mismatch",
        );
      }
      const saved = await jsonBody(await api(path, cookieA));
      ensure(
        saved.messages.at(-1)?.status === "complete" &&
          saved.messages.at(-1)?.content === result.text &&
          saved.messages.length === 4,
        "agent_retry_not_persisted",
      );
      report(phase, {
        status: "passed",
        characters: result.text.length,
        matched: result.evidence.cohort.matchedProfiles,
        examined: result.evidence.cohort.examinedProfiles,
        supporting: result.evidence.cohort.supportingProfiles,
      });
    }
    phase = "chat_delete";
    await api(path, cookieA, { method: "DELETE" });
    await api(path, cookieA, { expected: 404 });
    ensure(
      (await jsonBody(await api("/api/chats", cookieA))).chats.length === 0,
      "deleted_chat_listed",
    );
    report(phase, { status: "passed" });
  } catch (error) {
    failure = {
      phase,
      code: error instanceof SmokeFailure ? error.message : "operation_failed",
    };
  } finally {
    try {
      await cleanup();
    } catch {
      failure = {
        ...(failure ?? {}),
        cleanup: "failed",
        recoveryManifest: manifestPath,
      };
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (clean) await rm(runDirectory, { recursive: true, force: true });
    else await rm(logPath, { force: true });
    if (failure) {
      report("smoke", {
        status: "failed",
        environment: options.env,
        ...failure,
      });
      process.exitCode = 1;
    } else
      report("smoke", {
        status: "passed",
        environment: options.env,
        realAgent: options.agent,
        storageOnly: options.storageOnly,
      });
  }
}

async function selfTest() {
  ensure(argumentsFor(["--env", "staging", "--agent"]).agent, "arguments_test");
  ensure(
    argumentsFor([
      "--env",
      "staging",
      "--agent",
      "--report",
      "/tmp/report.json",
    ]).report,
    "report_arguments_test",
  );
  ensure(
    argumentsFor(["--env", "staging", "--storage-only"]).storageOnly,
    "storage_only_arguments_test",
  );
  let incompatible = false;
  try {
    argumentsFor(["--env", "staging", "--storage-only", "--agent"]);
  } catch {
    incompatible = true;
  }
  ensure(incompatible, "storage_only_agent_rejected_test");
  let refused = false;
  try {
    argumentsFor([]);
  } catch {
    refused = true;
  }
  ensure(refused, "environment_required_test");
  const secret = "synthetic-test-only-secret-for-format-check";
  const token = "synthetic-test-only-token";
  const value = decodeURIComponent(sessionCookie(token, secret).split("=")[1]);
  const [raw, signature] = value.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  ensure(
    await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "base64"),
      new TextEncoder().encode(raw),
    ),
    "cookie_signature_test",
  );
  const wire = new TextEncoder().encode(
    'data: {"type":"meta","assistantMessageId":"synthetic"}\n\ndata: {"type":"delta","text":"Résumé"}\n\ndata: {"type":"done","status":"complete"}\n\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < wire.length; i += 3)
        controller.enqueue(wire.slice(i, i + 3));
      controller.close();
    },
  });
  const parsed = await consumeEvents(
    new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
  );
  ensure(
    parsed.text === "Résumé" && parsed.status === "complete",
    "chunked_stream_test",
  );
  report("self_test", { status: "passed", networkRequests: 0, mutations: 0 });
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/smoke-product.mjs --env staging|production [--storage-only | --agent] [--report NEW_PATH]\n       node scripts/smoke-product.mjs --env staging|production --cleanup PATH\n       node scripts/smoke-product.mjs --self-test\nCreates only synthetic fixtures and cleans them up. --storage-only skips streaming. Default verifies replay without AI. --agent adds one real corpus comparison retry. --report requires a real-agent mode and writes only answer/evidence/progress to a new mode-0600 file. Real-agent modes cannot be combined with --storage-only. Requires deployed migrations/endpoints, local auth secrets, and Wrangler credentials. Console output omits tokens and answer content.",
    );
  } else if (options.selfTest) await selfTest();
  else await main(options);
} catch (error) {
  report("smoke", {
    status: "failed",
    code:
      error instanceof SmokeFailure ? error.message : "configuration_failed",
  });
  process.exitCode = 1;
}
