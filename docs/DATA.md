# Reviewed applicant corpus

The initial release `2026-09-10-reviewed-initial` contains **58 reviewed source
accounts and 58 selected account/cycle profiles**, all with numerical GPA and MCAT,
multiple described activity categories, and an explicit acceptance or rejection.
These are self-reported public examples, not verified distinct people, complete
application files, a representative admissions population, or a training dataset
for admissions probabilities.

| Source | Imported source accounts | Collection scope |
|---|---:|---|
| Reddit | 49 | All verified identifiable annual-thread accounts in the September 7 inventory: 16 in 2023–24, 16 in 2024–25, 17 in 2025–26. |
| Student Doctor Network | 7 | The qualifying accounts from the previously drawn 120-account WAMC sample. |
| MDApplicants | 2 | Profiles 80771 and 80749; explicit school rejections, no established acceptance. |

Across sources, selected outcome cycles are 18 profiles in 2023–24, 23 in 2024–25,
and 17 in 2025–26. There are **145 outcome observations**. Observations include
aggregate reports, school observations of the same aggregate, and successive
statuses; they must never be summed as applicants, independent schools, or final
decisions. The query API counts distinct source accounts.

The nine standalone Reddit accounts from the original 58-link Reddit audit remain
outside this initial import. The separate 253-post image-heavy inventory, SDN's
estimated 168 qualifying accounts, unqualified MDApplicants profiles, Admit.org
reported counts, and CycleTrack users are not imported. No count was estimated
or seeded from an inaccessible source.

## Provenance and review

Starting inventory:
`/Users/avneesh/Documents/Workspace/exa-results/premed-outcome-audit-2026-09-07/`.
Reddit annual source pages were retrieved on September 10, 2026, with the web
retrieval tool. Some pages reported cached retrieval ages, so `observedAt` records
collection, not proof that the source was last edited that day. Only comments
belonging to a listed handle were joined. Replies by other authors and deleted
accounts were excluded. The SDN and MDApplicants September 7 cached HTML and
extracted summaries were inspected again; SDN original-poster dates were checked
against the HTML. This is one Codex-assisted review, not independent adjudication.

Each committed profile records canonical source links, field evidence, source
account identity, observation and review dates, a SHA-256 digest, private artifact
key, activity measurement bounds, timing, and review notes. The private artifact
contains the reviewed source text; committed JSON contains normalized facts and
bounded relevant excerpts. Public display uses source handles or profile IDs,
not inferred identities. Cross-site resemblance never merges accounts. Broad
racial/ethnic categories, sex, and inferred socioeconomic identities are not
normalized as recommendation filters.

The original local audit and retrieved source captures remain the reproducible
collection inputs. The one-time normalized release is `data/corpus.json`; runtime
does not scrape sites. Future updates edit or extend this reviewed JSON and pass
the validator before import. A new observation should use a new profile ID and
increment `version`, preserving prior rows; the importer makes only the newest
imported account/cycle version current. Correcting an existing ID updates that
reviewed record idempotently. Excluded/unreviewed records never enter the query
surface.

## Measurement and outcome rules

- GPA uses the reported undergraduate/AMCAS value where distinct values exist.
  Alternate graduate, combined, TMDSAS, AACOMAS, and unconfirmed values stay in
  academic evidence and notes. Do not silently combine them.
- MCAT uses the relevant reported completed attempt. The SDN reapplicant with a
  later 522 is represented by the earlier 516 for the 2024–25 outcome cohort.
- Hours preserve exact reports, approximations, ranges, lower/upper bounds,
  explicit absence, and unreported values. Durations in years are not converted
  into invented hours. Projected work is excluded from completed-hour summaries.
- `retrospective_mixed` identifies two SDN profiles whose later activity snapshots
  describe an earlier outcome cycle. Their hours are excluded from outcome-cohort
  summaries. Other known post-submission additions are specifically excluded or
  recorded in notes. Most public reports still do not establish exact hours at
  primary submission; comparison language must say “reported hours.”
- Accepted, rejected, interview, waitlisted, withdrawn, pending, and unknown are
  distinct. A waitlist followed by withdrawal remains two observations. A combined
  “waitlists/rejections” number is never arbitrarily split. “Accepted: No,” silence,
  and schools lost to a TMDSAS match are not rejection evidence.
- One SDN account reports conditional guaranteed admission to the next intake.
  That observation is marked conditional and assigned to 2025–26; it does not
  satisfy a nonconditional acceptance filter for 2024–25. Its VCU rejection does.
- Reddit date conflicts (notably Eek_meek and Jumpy-Lifeguard-6208) remain flagged.
  Cohort assignment follows the annual thread and primary-submission context;
  conflicting precise dates are not normalized as facts.
- School-specific acceptance observations can overlap aggregate acceptance reports.
  Presence and count kind are explicit. Do not sum them. Outcome extraction is
  sufficient to support included examples, not a comprehensive school history.

## Query contract and visible counts

`src/cohort.ts` exposes `searchCohort(DB, filters)` and `inspectProfile(DB, id)`.
Filters accept GPA/MCAT intervals, cycles, sources, explicit outcome statuses,
activity text, and school text. They are validated and bound as SQL parameters.
Unknown filters fail instead of silently widening a search. Text wildcards are
escaped. When an account has several matching cycles, the latest matching cycle
is selected for display and statistics, keeping one account per count.

Returned counts mean:

| Field | Measured quantity |
|---|---|
| `total` | Distinct reviewed source accounts available in current profile versions. |
| `matched` | Distinct accounts satisfying the supplied filters. |
| `examined` | Full profile records retrieved for the answer, bounded by `limit` (1–20). This is not a claim of model review of every match. |
| `withReportedOutcomes` | Matching accounts with explicit, nonconditional acceptance/rejection evidence in their selected cycle. |
| `summarized` | Matching accounts read for deterministic numerical summaries, at most 1,000. |

The model/answer layer determines **supporting profiles** from the actual profile
citations used in its answer. This count is not fabricated by the cohort module.
Source and cycle coverage describe the matched account set. Summaries report `n`
and excluded/missing denominator separately for each statistic. Hour medians use
only exact numerical reports or explicit zero, excluding estimates, ranges,
projections, and mixed timing. Described roles with unknown hours remain retrievable
and inspectable. Numerical summaries do not establish causality or probabilities.

## Validation and import

Use Node 24.20.0 and the installed project-local Wrangler. Read the Cloudflare and
Wrangler skills before executing provider commands. Apply the corpus migration to
staging first; this change is `backend-state`. Parent release coordination controls
staging and production changes.

```sh
node scripts/validate-corpus.mjs
node scripts/import-corpus.mjs --sql /tmp/outpredict-corpus.sql
npm run db:migrate:staging
node scripts/import-corpus.mjs --env staging --remote --artifacts /tmp/outpredict-corpus-artifacts
```

The importer validates the complete dataset before writing, checks source-artifact
SHA-256 digests, uploads only to `outpredict-staging-data` or `outpredict-data`, then
executes idempotent SQL against the explicit Outpredict environment/config. No
secret value is needed in the data files or emitted by the importer. The optional
artifact directory is the one-time collection handoff; omit it for a repeat import
whose artifacts already exist. Do not expose corpus artifact keys as public bucket
URLs. Source text is private R2 audit material.

Verify staged counts, filter behavior, source inspection, and source-artifact
retrieval before applying the production migration/import. The SQL generation
mode performs no provider mutation. Corpus tests exercise actual D1 SQL, distinct
accounts versus repeated outcomes, missing and mixed-timing hours, exact filter
boundaries, injection-shaped text, and invalid model filters. Before calling this
release shipped, verify the production database and runtime retrieval after merge.
