# Development and release tooling

Outpredict uses React/Vite, a Cloudflare Worker, Better Auth Google sessions, D1,
private R2, OpenAI GPT-5.6 Sol for advice, and Workers AI for file extraction.
Google authentication, the reviewed corpus, and private
conversation/file storage are merged and verified in staging and production.
OUT-9 adds verified streamed advice grounded in the scraped student corpus. The
product scope excludes outside web search and official-policy retrieval. The
OUT-10 interface is deployed in both environments. OUT-13 verified the canonical
production domain, Google login/logout, attachments, conversation and mobile flows.

Detailed contracts and limitations live in [DATA.md](DATA.md),
[STORAGE.md](STORAGE.md), and [RUNTIME.md](RUNTIME.md).

## Accounts and release workflow

- GitHub: `kingofsunnyvale/outpredict`, default branch `main`. The configured `gh`
  login is `kingofsunnyvale`, with repository admin access and the `workflow` scope.
- Linear: [Outpredict workspace](https://linear.app/outpredict), team **Outpredict**
  (`OUT`), [Outpredict project](https://linear.app/outpredict/project/outpredict-c7ce4c02b8a4).
  Linear MCP is configured at `https://mcp.linear.app/mcp`.
- Create one issue per meaningful change, use its generated branch, and include
  `Fixes OUT-<number>` in the PR. Record acceptance criteria, blockers, checks, and
  PR/deployment links. Linear's merge automation marks issues Done; separately
  verify deployment and reopen/update the issue if release fails.
- Main requires a PR, the `checks` status, an up-to-date branch, and resolved
  conversations, including for admins. The recorded configuration does not require
  a human review. Recheck branch protection and CI on the actual release commit.
- State/schema/ingestion changes use `backend-state`. Verify the issue branch in
  staging before merge, coordinate shared staging, and record the tested commit.

The product build is tracked in OUT-7 (corpus), OUT-8 (conversations/files),
OUT-9 (agent/evidence), and OUT-10 (interface), following the OUT-5/OUT-6 setup.
[OUT-11](https://linear.app/outpredict/issue/OUT-11/expand-the-reviewed-student-forum-corpus-across-accessible-public)
tracks the active public-forum collection and reviewed-corpus expansion. It has
no numerical target or artificial record cap. Raw collection is kept separate
from reviewed/queryable records; current progress and access boundaries are in
the issue. OUT-12 tracks the Sol migration and OUT-13 the final outpredict.app release.

## Local development and checks

Use Node **24.20.0**, npm, and the pinned project dependencies. This machine can
also invoke Node 24 with `npm exec --yes --package=node@24.20.0 -- node ...`.
Use `uv` for Python and `gh` for GitHub. Read the Cloudflare/Wrangler skills before
provider operations and run project-local Wrangler from this directory.

```sh
npm ci
npm run db:migrate:local
npm run dev
npm run lint
npm run typecheck
node scripts/validate-corpus.mjs
npm run test:corpus-pipeline
npm run test:collection
node scripts/smoke-product.mjs --self-test
npm test
npm run build
```

Copy `.dev.vars.example` to ignored `.dev.vars`, supplying the staging Google
client and a development-only auth secret. `dev` uses `http://localhost:8787`,
local staging D1/R2, and a local `AUTH_URL` override. Import the reviewed corpus
locally with `node scripts/import-corpus.mjs --env staging` when testing retrieval.
Advice calls use the server-only `OPENAI_API_KEY`; provide it in ignored
`.dev.vars` for local generation. Document conversion still uses remote Cloudflare AI.

`build` bundles both environments without publishing; `cf-typegen` regenerates
binding types. CI runs installation, dependency audit, lint, typecheck, corpus and
smoke validation, Workers integration tests, and builds. Verify changed user flows
in a browser. Remove the pinned Sharp override when Miniflare's upstream is fixed.

## Cloudflare resources and deployment

Cloudflare account: `8b1ada8b10e9e8e5664ec10bd9d3c370`. Project-local Wrangler is
**4.130.0**. Resource IDs and explicit environment bindings are in `wrangler.jsonc`.

| Environment | Worker | D1 `DB` | Private R2 `DATA` |
|---|---|---|---|
| Staging | `outpredict-staging` | `outpredict-staging` | `outpredict-staging-data` |
| Production | `outpredict` | `outpredict` | `outpredict-data` |

The shared hostname ends in `anywager.workers.dev`; Outpredict resources are
separate. Do not modify AnyWager resources. Initial D1/R2 CRUD checks passed.

The canonical production origin is `https://outpredict.app`, a managed Worker
custom domain in zone `b18c8480dd80a0ebce8e060dd440272f`. Staging keeps its
`workers.dev` origin. The legacy production homepage redirects safe GET/HEAD
navigation to the canonical homepage, dropping query parameters. Private API
requests are never redirected or proxied; sign in again on the new domain to
access the same account and saved conversations. Legacy health checks stay usable.
The domain is bound and TLS verified before switching the configured auth origin.
Do not override an existing DNS record or another Worker's domain binding.

Workers Builds connects both Workers to GitHub with a Cloudflare-managed token.
Main merges trigger deployment; production branch previews are disabled. Staging
versions share staging D1/R2. Use the stable staging origin for authentication;
arbitrary version-preview origins cannot authenticate.

The migration sequence is `0001_auth.sql`, `0002_corpus.sql`, then
`0003_conversations.sql`; all three are applied in both environments.
Migrations never run automatically. Apply reviewed additive migrations in staging,
deploy compatible branch code, then import and verify the frozen dataset. For the
v2 corpus rollout, production must receive compatible code before new profiles
become current:

```sh
npm run db:migrate:staging
npm run deploy:staging
# Import the frozen reviewed dataset, then run API and browser checks.
npm run db:migrate:production
# Additive migration only; upload private artifacts without activating profiles.
# Merge after CI and staging acceptance; verify both automatic deployments.
# Import the identical frozen production dataset and verify its release marker.
```

Use one immutable, idempotent SQL file with its release marker for each data
activation. The import temporarily makes D1 unavailable; measure this in staging.
An uncertain client result requires reading the marker before retrying the same
file. Reimporting a smaller baseline does not deactivate added profiles. Rollback
must target the release's exact introduced IDs and prior current versions; avoid
whole-database restore because D1 also holds private chats and authentication.

`npm run deploy:production` supports coordinated direct releases/recovery. A merge
is a release: inspect deployment and resolve failures before calling it shipped.

## Google authentication and credentials

Google Cloud project: `outpredict-20260909` (`930855311603`). Always pass
`--project=outpredict-20260909` to Google CLI commands; this machine's default
project belongs to another application. No Google billing account was linked.
Outpredict uses an external OAuth audience with only `openid`, `email`, and
`profile` scopes. Staging and production have separate Google clients and auth
secrets. OUT-6 authentication was verified in staging and production. Repeat the
sign-in and sign-out flows when verifying the final OUT-10 interface.

| Environment | Application origin | Google redirect URI |
|---|---|---|
| Local | `http://localhost:8787` | `http://localhost:8787/api/auth/callback/google` |
| Staging | `https://outpredict-staging.anywager.workers.dev` | `https://outpredict-staging.anywager.workers.dev/api/auth/callback/google` |
| Production | `https://outpredict.app` | `https://outpredict.app/api/auth/callback/google` |

The production Google client retains its previous `workers.dev` origin/callback
for rollback and also includes `outpredict.app`; the latter is an authorized
OAuth domain. Public branding links use the canonical homepage, `/privacy`, and
`/terms` after HTTPS verification. Staging uses its separate client throughout.

Worker secrets are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`BETTER_AUTH_SECRET`, and `OPENAI_API_KEY`. Auth copies are ignored mode-0600 `.env.auth-staging.json`
and `.env.auth-production.json`; development uses `.dev.vars`. Credentials belong
in secret stores or ignored private files, never Git, output, Linear, or PRs.

The restricted OpenAI key belongs to the Outpredict project. Its permissions are
model listing (read) and Chat Completions (request). The ignored mode-0600
`.env.openai-worker.json` contains only the Worker key; `.env.openai-runtime.json`
also records the project ID. A coordinated deployment can supply the private
Worker file with `--secrets-file`; Wrangler preserves other existing secrets.
Install the production secret before merging code that requires it. Never pass
the key as a command argument or include it in a deployment report.

`AUTH_URL` is fixed per environment. `/api/setup` reports readiness; `/api/me` uses
the verified server session. Private APIs enforce ownership, disable caching, and
require trusted origins for mutations. Recheck `gh`, Wrangler, and Linear logins
when moving environments.

## Corpus, runtime, and service limits

The corpus has **58 source accounts**: 49 Reddit, 7 SDN, and 2 MDApplicants across
2023–24 through 2025–26. Its 145 outcome observations are not applicant counts.
D1 retrieval separates available, matched, retrieved, and cited accounts. These
self-selected reports cannot establish personal odds or causal effects.

`data/corpus.json` contains reviewed facts and provenance; full source text stays
in private R2. The idempotent importer validates records and artifact hashes:

```sh
node scripts/import-corpus.mjs --sql /tmp/outpredict-corpus.sql
node scripts/import-corpus.mjs --env staging --remote --artifacts /path/to/reviewed-source-artifacts
```

`--artifacts` names a local directory containing the reviewed source files whose
SHA-256 digests and object keys appear in `data/corpus.json`. The initial release's
objects are already imported into both private buckets; routine re-imports may
omit the option when those matching objects exist. Preserve source artifacts in
private storage, not a `/tmp` directory as a durable dependency. Verify staging
before an explicit production import. See DATA.md for scope and limitations.

The configured advice model is exactly **`gpt-5.6-sol`**. OUT-12 replaces the
previous GLM runtime, keeping Cloudflare file conversion. Actual OpenAI API access,
function calls, native SSE, résumé/calendar facts, follow-up context, count and
publication semantics, and the corpus-only policy boundary passed sampled checks.
See RUNTIME.md for the evidence and limitations. OUT-9 records the preceding
staging/production runtime verification; OUT-12 records the model migration release.
Private reasoning is not exposed; interrupted answers retain partial text and
retry state. Up to two cohort searches permit one refinement. The application
finalizes supporting counts after citations are known and reports the actual
available, matching, and retrieved counts for the latest cohort. Numeric-summary
populations remain separate from cited supporting accounts.

Student-source records are the product's research evidence. Retrieval searches and
inspects the reviewed D1 corpus; it does not search the web or fetch outside policy
pages. Optional user documents supply personal context and remain private. The
agent must state when the available reports do not support a requested conclusion,
keep unknown outcomes distinct, and avoid filling missing evidence from general
model knowledge. Source links identify the forum material behind retrieved facts;
they are not an additional live research service.

Expanded collection is running under OUT-11. Its resumable inventory and progress
are recorded in the issue; inventory entries are not qualifying imported records.
The workstream collects as much accessible public forum material as practical,
preserve raw reviewed source coverage separately from the queryable corpus, and
report exact visited/parsed/reviewed/imported/excluded counts and missingness.
Current quality and explicit-outcome requirements must not be silently relaxed.
Supporting incomplete profiles requires deliberate schema, query, UI-count, and
missingness work with staging checks. Use resumable, rate-compliant collection
and verify each backfill in staging before
production. Neither inventory size nor a user's estimate is an imported count.

TXT/Markdown decode locally; PDF, DOCX, PNG, and JPEG use Cloudflare conversion.
Synthetic format checks passed; unreadable scans receive alternatives. Limits:
8 MiB/file, 40 retained files/64 MiB/account, four attachments/message, 20 accepted
uploads/UTC day, 100 conversations, 200 messages/conversation, and 50 generation
attempts/UTC day. Started uploads/generations count even on failure; deletion
does not reset daily usage.
File deletion removes originals, extracted text, and source excerpts; existing
answer prose remains until chat deletion. See STORAGE.md. There are no paid tiers.

## Deployed verification and release record

```sh
node scripts/smoke-product.mjs --env staging --storage-only
node scripts/smoke-product.mjs --env staging
node scripts/smoke-product.mjs --env staging --agent
node scripts/smoke-product.mjs --env staging --agent --report /tmp/outpredict-corpus-review.json
node scripts/smoke-product.mjs --env production --agent
```

`--storage-only` supports OUT-8 before streaming ships. Default adds stored-answer
replay without AI; `--agent` adds one real retry and citation-count checks.
`--report` optionally saves only answer/evidence/progress from the synthetic
corpus scenario in a new mode-0600 file. Two synthetic sessions
exercise ownership/history/files/cancellation and clean up exact R2/D1 fixtures.
Tokens and answer content are never printed to the console. Failed cleanup can be
retried with `--env <same-environment> --cleanup <reported-manifest-path>`. Also
verify Google sign-in and desktop/mobile flows in a browser.

The following merged checkpoints are verified in both environments. Final
interface deployment and browser evidence is recorded with OUT-10.

| Issue | Merge/release evidence |
|---|---|
| OUT-6 | [PR #3](https://github.com/kingofsunnyvale/outpredict/pull/3), merge `b3b071fc22c1845aa13ddc19b7628a5af0816c6d`; authentication/hosting verified in staging and production. |
| OUT-7 | [PR #4](https://github.com/kingofsunnyvale/outpredict/pull/4), merge `635de31940acda38a6cb9c0d9331a3debb73b2c8`; 58 reviewed accounts and private source artifacts verified in both environments. |
| OUT-8 | [PR #5](https://github.com/kingofsunnyvale/outpredict/pull/5), merge `c44b89be46dd4f21d0028ff86aa532ee34bd3ec6`; private storage APIs and synthetic cleanup verified in both environments. |
| OUT-9 | [PR #6](https://github.com/kingofsunnyvale/outpredict/pull/6), merge `420a509a2a2592df188af482825a7758288302c9`; 72 tests and required checks pass. Staging branch `58c3f3a` / version `5dcccc68-a195-42c2-be33-0dbca3c9a97f` passed real-agent and private-storage smoke. Automatic main deployments passed: staging `55e674ec-ea98-4041-afcd-09b57483ad29`, production `fe0d16b6-e58e-4607-8518-958187f5c5fc`. Production smoke and manual answer review passed: 58 matching, 12 retrieved, two cited supporting accounts, saved evidence/calculations consistent, exact synthetic cleanup complete. |
| OUT-10 | [PR #7](https://github.com/kingofsunnyvale/outpredict/pull/7), merge `46e5765e494a1c4a3377861141adb5f5afd71e98`; 72 tests and required checks pass. Exact branch `ad6ab18` passed staging at `b62b91f1-b6d5-4cf9-a5c3-bf73842015ca`: Google draft, PDF plan/follow-up, profile/evidence inspection, saved history and mobile. Automatic main staging `797045dd-d1f9-42a3-b461-3276525eda52` and production `a578b61e-4afc-42cd-bbbe-18431e39dfdb` passed. Production Google draft and saved conversation confirmed. Model answer-quality corrections and final domain flows continue in OUT-12/13. |
| OUT-12 | [PR #8](https://github.com/kingofsunnyvale/outpredict/pull/8), merge `0261fe43b842a9b045fe0e628c811e57fbf50690`; 90 tests, lint, typecheck, both builds and required CI pass. Exact branch `afbec405` passed staging `80edf5f0-1aa6-4949-b545-208388c6cea6`, including the browser résumé/time-budget follow-up. Automatic main staging `ce9779c1-5cd9-46ed-8e54-9bd7f4eefabc` and production `23b2ccfd-af34-41c6-bdb5-4f706b231ef8` passed. Real production agent/storage/cancellation/replay/deletion smoke and manual answer review passed: 58 matched, 2 retrieved, 2 cited accounts with accurate publication and missing-hours distinctions; exact synthetic cleanup complete. |
| OUT-13 | [PR #9](https://github.com/kingofsunnyvale/outpredict/pull/9), merge `90fa8337fdf13866d843f0fbf1744fb6e1795f66`; 96 tests and required CI pass. Exact branch `d4ce8d1` passed staging `1021f5c4-f03b-40f1-8c63-eaf4d5c903c9`. Automatic staging `3e646bf7-e72b-4bc9-b6f4-8593891a75fe` and production `3a53d53c-3525-410f-99f3-76944a7b43fe` passed. Canonical HTTPS, public pages, safe legacy redirect, actual Google draft/login/logout, PDF/PNG extraction, accurate time-budget follow-up, 58 available/13 matched/2 retrieved/2 cited counts, profile inspection, reload and 390px mobile flows passed. One interrupted answer recovered through retry. Canonical API ownership/cancellation/replay/delete smoke and exact synthetic cleanup also passed. |
