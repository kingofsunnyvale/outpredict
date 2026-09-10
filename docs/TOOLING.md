# Development tooling

Verified on 2026-09-09 (America/Los_Angeles). This repository contains a health-only
Worker to exercise the development and release workflow. Product implementation
and applicant data collection are separate future work.

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
  native PR linking is separate from those settings. Team automation is PR open →
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
npm run build
npm run deploy:staging
npm run deploy:production
```

`dev` uses local emulated staging bindings. `build` bundles both environments without
publishing. `cf-typegen` regenerates `worker-configuration.d.ts` after binding changes.
Dependencies and the lockfile are pinned. The scoped Sharp override fixes a vulnerable
transitive Miniflare dependency; remove it once upstream includes the fixed version.
Clean install, zero-vulnerability npm audit, lint, typecheck, both dry-runs, and local
HTTP checks passed. GitHub Actions runs install, lint, typecheck, and build for PRs/main.

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

Deployment and GitHub CI verification are in progress in OUT-5.

## Other verified capabilities and deferred work

- Git, `curl`, and `jq` passed authenticated/HTTPS/JSON checks.
- `uv` 0.10.8 ran Python 3.12.11; JSON and SQLite checks passed.
- Interactive browser navigation, clicking, and screenshots work. Manual browser
  verification is the current workflow; no Playwright dependency or test suite is required.
- Cloudflare Vectorize, Queues, and Workers AI catalog reads passed. No Outpredict
  resources or model inference are provisioned for them yet.
- Initial data collection will be a later one-time Codex pass. OpenAI API access is
  not a prerequisite for that collection; the previously present API credential
  returned 401 and was not repaired or used for inference.
- The product is free, so Stripe is excluded. Email and a custom domain remain
  future feature decisions. Docker is not required; its local engine is not running.

Credentials stay in credential/secret stores and ignored local files. Recheck
access in a future environment rather than assuming it inherits this machine's login.
