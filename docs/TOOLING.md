# Development tooling

Verified on 2026-09-09 (America/Los_Angeles). The setup foundation uses React/Vite
static assets on the existing Cloudflare Worker, with Google login through Better
Auth and D1 sessions. Full chat, attachments, applicant data collection, and evidence
analysis remain future product work. This foundation is tracked in
[OUT-6](https://linear.app/outpredict/issue/OUT-6/configure-frontend-hosting-google-login-and-runtime-prerequisites).

## Accounts and issue tracking

- GitHub: `kingofsunnyvale/outpredict`, default branch `main`; `gh` is authenticated
  as `kingofsunnyvale` with repository admin access and the `workflow` OAuth scope.
- Linear workspace: [outpredict](https://linear.app/outpredict). Team **Outpredict**
  uses **OUT**; project [Outpredict](https://linear.app/outpredict/project/outpredict-c7ce4c02b8a4).
  Setup is tracked in [OUT-5](https://linear.app/outpredict/issue/OUT-5/prepare-autonomous-development-tooling).
- Linear MCP is authenticated at `https://mcp.linear.app/mcp`; live reads and project/
  issue writes passed. Newly configured MCP tools may require a fresh Codex session.
- The existing Linear Code GitHub App is installed specifically for this repository.
  Use the issue-generated `username/identifier-title` branch and `Fixes OUT-<number>`
  in the PR body. Public GitHub comments and GitHub issue duplication are disabled;
  native PR linking is separate from those settings. PR #1 attached automatically
  to OUT-5; no manual attachment was added. Team automation is PR open →
  In Progress, review activity → In Review, and PR merge → Done. Verify deployment
  separately; reopen/update the issue if a release fails.

## Local commands

Use Node **24.20.0** from `.node-version` and npm. On this machine, Node 24 is also
available through `npm exec --yes --package=node@24.20.0 -- <command>`.

```sh
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run deploy:staging
npm run deploy:production
```

`dev` serves the frontend and Worker at `http://localhost:8787` with local staging
storage and a local `AUTH_URL` override. Copy `.dev.vars.example` to ignored
`.dev.vars` and supply the staging Google client credentials and a development-only
auth secret. Apply local auth tables with `npm run db:migrate:local` first. The AI
binding is remote if later code calls it; the setup page performs no inference.
`build` builds Vite assets and bundles both environments without publishing.
Label state/schema/ingestion changes `backend-state` and deploy the issue
branch to staging before merge. Staging is shared between branches; record the tested
commit in Linear. Labels do not create environments. `cf-typegen` regenerates `worker-configuration.d.ts` after binding changes.
Dependencies and the lockfile are pinned. The scoped Sharp override fixes a vulnerable
transitive Miniflare dependency; remove it once upstream includes the fixed version.
GitHub Actions runs install, dependency audit, lint, typecheck, Workers integration
tests, and build for PRs/main. Tests exercise the real local D1 migration, signed
sessions, isolation, expiry/revocation, OAuth origins/redirects, and built assets.
The setup PR passed its first CI run. Main requires the GitHub Actions `checks` status,
up-to-date branches, a PR, and resolved conversations, including for admins. There is
no required human review, so an authorized agent can merge after checking the diff.

## Cloudflare resources

Account: `8b1ada8b10e9e8e5664ec10bd9d3c370`. Local Wrangler OAuth works.
Project-local Wrangler is **4.130.0**; use `npx wrangler` in this directory.

| Environment | Worker | D1 binding `DB` | R2 binding `DATA` |
|---|---|---|---|
| Staging | `outpredict-staging` | `outpredict-staging` | `outpredict-staging-data` |
| Production | `outpredict` | `outpredict` | `outpredict-data` |

Resource IDs are in `wrangler.jsonc`. R2 activation was explicitly approved and
completed. Both databases passed remote create/insert/read/drop checks, and both
buckets passed upload/download/compare/delete checks; temporary artifacts were removed.
Buckets are private. AnyWager resources are separate and were not modified.

Both Workers were deployed successfully using Wrangler; their `/healthz` routes
returned HTTP 200 with the correct environment. The shared account subdomain is
`anywager.workers.dev`; the Worker and storage resources themselves are separate.

Cloudflare Workers Builds is connected to `kingofsunnyvale/outpredict` for both
Workers, using the existing Cloudflare-managed build token (no token was copied
into this repository or GitHub). Build runtime is Node 24.20.0. The build command
runs lint, typecheck, and build; the environment-specific npm deploy command runs
on `main`. Production branch previews are disabled. Other branches upload preview
versions with `npx wrangler versions upload --env staging`; these share staging
D1/R2, so coordinate state-changing tests between branches.

Automatic staging preview build passed for setup commit `d3d771e`. Current build,
merge, and deployment evidence is recorded in [OUT-5](https://linear.app/outpredict/issue/OUT-5/prepare-autonomous-development-tooling)
and [PR #1](https://github.com/kingofsunnyvale/outpredict/pull/1). Always inspect the
checks for the latest commit and verify health after merging.

## Other verified capabilities and deferred work

- Git, `curl`, and `jq` passed authenticated/HTTPS/JSON checks.
- `uv` 0.10.8 ran Python 3.12.11; JSON and SQLite checks passed.
- Interactive browser navigation, clicking, and screenshots work. Manual browser
  verification complements the Workers integration tests; Playwright is not required.
- Cloudflare Vectorize and Queues catalog reads passed; no product resources exist
  for them yet. Workers AI is bound as `AI`, with `AI_MODEL` set to
  `@cf/openai/gpt-oss-120b`. An authenticated, bounded model request returned HTTP 200
  and the expected response. No public inference endpoint is exposed.
- Initial data collection will be a later one-time Codex pass. OpenAI API access is
  not a prerequisite for that collection; the previously present API credential
  returned 401 and was not repaired or used for inference.
- The product is free, so Stripe is excluded. Email and a custom domain remain
  future feature decisions. Docker is not required; its local engine is not running.

Credentials stay in credential/secret stores and ignored local files. Recheck
access in a future environment rather than assuming it inherits this machine's login.

## Authentication configuration

Setup checkpoint: the Google app identity and staging OAuth client exist and the
staging auth migration has been applied. Local checks (11 tests, lint, typecheck,
both dry-run builds, and dependency audit) were independently rechecked and passed
on September 9. Desktop/mobile setup inspection passed in the earlier checkpoint.
The staging client secret has not been saved in the local environment files;
Google no longer reveals existing secrets. The production client form is prepared
with the exact origin/callback below and awaits the browser-required confirmation.
Actual Google login, staging deployment, and production release remain unverified.

Google Cloud project: `outpredict-20260909` (number `930855311603`). Use an explicit
`--project=outpredict-20260909` in Google CLI commands; the machine's default project
belongs to another app. No billing account was linked. OAuth branding uses
**Outpredict**, an external audience, and only basic sign-in identity scopes:
`openid`, `email`, and `profile`.

| Environment | Application origin | Google redirect URI |
|---|---|---|
| Local | `http://localhost:8787` | `http://localhost:8787/api/auth/callback/google` |
| Staging | `https://outpredict-staging.anywager.workers.dev` | `https://outpredict-staging.anywager.workers.dev/api/auth/callback/google` |
| Production | `https://outpredict.anywager.workers.dev` | `https://outpredict.anywager.workers.dev/api/auth/callback/google` |

`AUTH_URL` is fixed per environment. Staging and production need separate Google
clients and independently generated `BETTER_AUTH_SECRET` values; local development
uses the staging client with its registered localhost callback. Worker secrets are
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET`. Never put actual
values in Wrangler configuration, documentation, GitHub, or Linear.

Before deploying code that needs auth tables, run `npm run db:migrate:staging`,
verify the issue branch in staging, then run `npm run db:migrate:production` before
merging. Migrations are not executed during requests or automatically by deploy.
Version preview URLs intentionally disable login: use the stable staging origin
for OAuth tests. `/api/setup` reports whether login is configured for that origin;
`/api/me` returns only the identity from a valid server session. Unauthenticated
requests receive 401; missing configuration receives 503. Auth responses are not
cached, and state-changing auth requests require the configured Origin header.

## Live search readiness

Live search is **not yet verified**. Cloudflare's experimental native Web Search
returned `account_disabled` (7078), despite the local OAuth token having
`websearch.run`. Its CLI has no enable command and no verified self-service
activation path was found. Cloudflare AI Search is a separate retrieval product.

An Outpredict-only Google public-search service account and API key were prepared
as a possible fallback. The key is restricted to `generativelanguage.googleapis.com`
and stored only in ignored `.env.search-setup` (mode 0600). Billing remains disabled.
Both Gemini 2.5 Flash and Flash-Lite grounded query tests returned HTTP 404 because
those models are no longer available to new users. No paid fallback was invoked,
and this credential has not been deployed to the Worker. Free-tier Google services
must not receive confidential applicant documents or chat context; any future
use needs a separate, sanitized public-information query.

Actual Cloudflare Markdown conversion was tested with synthetic PDF, DOCX, and
PNG résumés: all reproduced GPA, MCAT, activities, dates, and planned hours.
A scanned PDF returned empty content despite a success status; the product must
detect insufficient extracted text and request page images or a text-based PDF.
The experimental PDF image-conversion option produced an inaccurate description
and is not a verified fallback. The selected main model is text-only.

The full build is tracked in OUT-7 (reviewed corpus), OUT-8 (conversations/files),
OUT-9 (agent/evidence), and OUT-10 (reference interface). These capabilities are not
part of the foundation release until their own checks and live verification pass.
