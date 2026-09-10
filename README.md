# Outpredict
Free, data-driven medical-school admissions advice.

[Open Outpredict](https://outpredict.app) ·
[Staging](https://outpredict-staging.anywager.workers.dev)

Sign in with Google and ask a question. Attach a résumé or image when helpful,
inspect the evidence, and continue the conversation later. Comparisons use 58
reviewed public source accounts, with visible counts and missing-data limits.
The service has no subscriptions; account limits keep shared usage bounded.
Admissions evidence comes from the imported student corpus and your own inputs.
The assistant does not search the web or fetch outside information.

The app uses React/Vite, OpenAI GPT-5.6 Sol, Cloudflare Workers, Better Auth, D1,
and private R2. Cloudflare Workers AI extracts supported documents and images.
Use Node 24.20.0 and the pinned npm dependencies. Configure ignored `.dev.vars`
from the example, run `npm ci`, apply local migrations with
`npm run db:migrate:local`, and start `npm run dev`.

See [tooling and deployment](docs/TOOLING.md), [corpus provenance](docs/DATA.md),
[runtime and evidence](docs/RUNTIME.md), [private storage](docs/STORAGE.md),
and [interface verification](docs/INTERFACE.md). Follow [AGENTS.md](AGENTS.md)
for Linear, checks, PRs, and releases.
