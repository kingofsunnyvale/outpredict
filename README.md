# outpredict
Data driven med-school advice

The product is free. Initial applicant data will be collected and reviewed by
Codex in a one-time pass when requested; an OpenAI API integration is not required
for that collection. Browser verification is manual for now.

See [AGENTS.md](AGENTS.md) for the development workflow and
[tooling status](docs/TOOLING.md) for service access and setup checks.

Use Node 24.20.0, then `npm ci` and `npm run dev`. The bootstrap exposes
`GET /healthz`; it contains no applicant data or product UI yet.

- [Staging health](https://outpredict-staging.anywager.workers.dev/healthz)
- [Production health](https://outpredict.anywager.workers.dev/healthz)
