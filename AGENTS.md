# Outpredict

Free, data-driven medical-school admissions advice for students.

## Branches, Linear, deploys

- Use Linear for Avneesh's visibility: one issue per meaningful feature/fix,
  with acceptance criteria, current status, blockers, and linked PRs/previews.
- Use Linear team Outpredict (`OUT`) and project Outpredict. Create the issue
  first, use its generated branch name, and include `Fixes OUT-<number>` in the PR.
- During an authorized build, carry work through implementation, verification,
  PR creation, merging, and deployment without asking again for routine steps.
- Self-review the diff. Merge only after required checks pass; honor branch
  protections and required reviews. Verify deployment before marking work shipped.
- Keep Linear updated at meaningful transitions. If its connection fails, record
  progress locally and continue independent work; never invent successful updates.

## Tools and checks

- GitHub via `gh`; Linear via MCP. Current setup and verified commands live in
  `docs/TOOLING.md`; keep it accurate as infrastructure changes.
- Use project-local npm tools and pinned dependencies. Use `uv` for Python work.
- Run configured lint, typecheck, build, and relevant tests before committing
  code. Verify user-flow changes in a browser. For docs-only edits, check the diff.
- Run Wrangler from the directory containing Outpredict's config, or pass an
  explicit config path. Read the applicable Cloudflare/Wrangler skills first.

## Environments

- Keep staging and production resources separate. Test migrations and backfills
  in staging before production; do not modify AnyWager's resources.
- Store credentials in ignored local files or secret stores, never in Git,
  command output, Linear issues, or PR descriptions.
- Once merge-to-main deployment is configured, a merge is a release: check its
  result and resolve failed deployments rather than marking them complete.
