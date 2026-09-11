# Public student corpus collection

OUT-11 uses a finite public-source snapshot, separate from the runtime advice
agent. There is no numeric collection target. The frozen creation window starts
May 1, 2023 and ends September 10, 2026 at 03:03 UTC; relevant later original-author
updates and current public MDApplicants profiles are retained.

## Actual collection coverage

Recovery status: the first run's unreleased state was lost when temporary storage
was cleared after the interrupted session. The counts below document that first
run, not currently imported records. The original 302-file source audit survives;
recovery reuses it and refreshes accessible public pages into durable ignored
`.local/out11-recovery/` storage. Its final manifest and review report will record
the new capture dates and actual released coverage. Production retains the 58
previously verified profiles until the recovery release passes staging.

The accessible frontier finished on September 10, 2026. There are **3,153 parsed
source accounts in scope: 3,105 SDN and 48 MDApplicants**. Source accounts are not
verified distinct people. Nine already belong to the original 58-profile release.
Parsed, extracted, reviewed, normalized and imported counts are separate; the
frozen normalized release and collection report determine what is queryable.

| Source | Captured resources | Parsed accounts in scope | Boundary |
|---|---:|---:|---|
| SDN | 3,530 thread pages and 78 index pages | 3,105 | One missing resource; 376 discoveries outside the creation window. Eighteen older cached accounts remain outside the in-scope count. |
| MDApplicants | 48 profile pages and six public listing responses | 48 | Followed observed public listing pagination to exhaustion. |
| Reddit | 0 new resources | 0 | Twelve known resources blocked by robots before a post request; existing reviewed records remain. |

There are 3,663 immutable raw capture revisions. SDN original-poster identity uses
the site's numeric account ID; deleted handles have an explicitly weaker source
identity. Cross-site handles never merge accounts. Quoted replies are not
applicant-authored facts. If an academic reply depends on an excluded quoted
question, the original-HTML context gate omits the ambiguous number instead of
assigning another author's context as an applicant fact.

The collector follows robots, same-host public paths, pagination, Retry-After,
content type, byte limits, backoff and finite retries. It identifies itself as
Outpredict, uses one source worker, and never logs in or solves challenges. SDN
stated no crawl-delay/request-rate rule at capture time; this run used a
self-imposed 1.5-second request-start interval. Host policy can require longer
waits. Checkpoint sizes control resumability, not a total record cap.

## Reusable local workflow

Use Python 3.13.5 through uv 0.10.8; there are no external Python dependencies.
Keep state and credentials outside Git, in durable private directories such as
the ignored `.local/out11-recovery/` directory. Do not put collection state,
paid model outputs, audit archives, or import receipts in `/tmp`; they must
survive session interruption and temporary-file cleanup. Network/API execution requires explicit
flags. Seed, parse, validate, revalidate and archive are offline.

    uv run --no-project --python 3.13.5 python scripts/collection/collector.py --state /private/corpus-state seed --audit /private/original-audit --baseline data/corpus.json --start-date 2023-05-01 --as-of 2026-09-10T03:03:00Z
    uv run --no-project --python 3.13.5 python scripts/collection/collector.py --state /private/corpus-state status
    uv run --no-project --python 3.13.5 python scripts/collection/collector.py --state /private/corpus-state fetch --source sdn --allow-network --interval 1.5 --batch 100 --until-idle
    uv run --no-project --python 3.13.5 python scripts/collection/review.py --state /private/corpus-state
    uv run --no-project --python 3.13.5 python scripts/collection/run_annotation.py --state /private/corpus-state --credentials /private/openai-runtime.json --allow-api --workers 16 --checkpoint-size 64 --until-idle
    uv run --no-project --python 3.13.5 python scripts/collection/revalidate.py --state /private/corpus-state

Do not repeat the completed crawl to reproduce an import. Reuse immutable
captures and cached model outputs. The original audit path is in [DATA.md](DATA.md).
Frontier state records canonical URL, discovery source, source account,
observation time, response status and digest. A newer capture cannot be silently
replaced by older cached HTML.

Extraction uses exact gpt-5.6-sol, store:false, strict structured output, a fixed
HTTPS endpoint and no redirects. The private key is read from the explicit
ignored credential file. Original responses remain immutable. Witness repairs
are saved separately and logged; a missing post index can be recovered only from
a uniquely occurring exact source quote. A verbatim span alone never qualifies
unsupported numbers, program identity, outcome status or timing.

Outcomes, multi-update records, conflicts and flags require independent semantic
review. Targeted source overrides bind the account/content digest to exact source
proof. Revalidation reuses cached calls and makes no API request. Punctuation-only
or exact deleted/removed placeholders receive explicit no-content exclusions;
meaningful short profiles are not excluded by length.

A local SQLite ledger reserves conservative cost atomically before each call,
then records measured usage. Uncertain failures retain reservations and are not
blindly retried. This run's authorized ceiling is $95 from existing credit; the
ledger is not an account-balance API. Fresh ledgers default to $85 and need an
explicit authorized change to increase it. Failed, unresolved and excluded
records remain in the private audit with their reasons.

Missing academics, activities, cycles and outcomes remain independent. Approximate
academics retain measurements with null exact scalars. Completed and anticipated
hours are not summed. An explicitly labeled completed/current component is used
only when source and units establish it. Repeated roles remain separate
observations, not additive totals. Category totals require separate coverage,
overlap and timing review; OUT-11 does not invent them.

## Private artifacts and activation

Raw captures use gzip JSONL with exact original bytes, SHA-256 and member
locators. A read transaction freezes a consistent collection manifest. Review
packs, original/repaired extractions, semantic decisions, overrides and the cost
ledger are preserved in private audit bundles. No credential file is archived.

    uv run --no-project --python 3.13.5 python scripts/collection/archive.py --state /private/corpus-state --output /private/corpus-artifacts
    uv run --no-project --python 3.13.5 python scripts/collection/normalize.py --state /private/corpus-state --baseline /private/baseline-corpus.json --output /private/corpus-candidate.json
    uv run --no-project --python 3.13.5 python scripts/collection/archive_reviews.py --state /private/corpus-state --output /private/corpus-artifacts --raw-manifest /private/corpus-artifacts/raw-artifact-manifest.json
    node scripts/prepare-corpus-artifacts.mjs --data /private/corpus-candidate.json --transcripts /private/corpus-state/private-transcripts --artifacts /private/corpus-artifacts --extra-manifest /private/corpus-artifacts/release-artifact-manifest.json --output /private/corpus-release.json
    node scripts/import-corpus.mjs --data /private/corpus-release.json --sql /private/release.sql --rollback /private/release.rollback.sql

Run normalization after the raw archive step: it attaches the frozen collection manifest hash and the collection/annotation checkpoint report. Freeze review archives only after the annotation queue has finished.

The artifact directory also contains the original 58 individual source artifacts
with their original keys and bytes. New transcript provenance retains individual
content hash, bundle hash, member ID and UTF-8 offset/length. Every source excerpt
must roundtrip its Unicode code-point span. Every cited HTML digest must resolve
through the raw index. Pinned fingerprints protect the original 58 objects,
including JSON serialization order.

Apply migration 0004 after 0001–0003 in coordinated staging first. Uploads target
only the explicit Outpredict bucket. Pinned Wrangler bulk upload is followed by
complete byte/hash readback; progress text alone is not a success receipt.

    node scripts/import-corpus.mjs --data /private/corpus-release.json --env staging --remote --artifacts /private/corpus-artifacts --manifest /private/corpus-artifacts/DATASET_HASH-manifest.json --activate-v2

Preparation writes the actual dataset-hash-prefixed manifest filename; substitute
that filename above. SQL and receipts are environment/dataset/hash-specific and
immutable. A retry uses the identical frozen data/SQL. Without local artifacts,
v2 requires a matching verified artifact receipt.

Verify the full staged import and new runtime before production activation.
Production may receive the additive migration and an --upload-only artifact run
before merging, but activate v2 rows only after compatible runtime deployment.
[TOOLING.md](TOOLING.md) records the release sequence.

One measured D1 SQL file publishes profiles, outcomes, membership and release
marker in the import transaction, without nested BEGIN/COMMIT. Changed facts under
an existing immutable ID fail. Full-release omissions and inactive historical
release replay fail inside the transaction. New observations require new IDs and
explicitly incremented versions; new OUT-11 accounts start at version 1.

Rollback checks the active release hash, deactivates its introduced snapshots and
restores the previous current snapshot per account/cycle. Baseline, authentication
and chats remain. Audit history is retained. An old release cannot roll back a
newer active release. Never use a whole-D1 restore as corpus rollback.

## Verification

    npm run test:corpus-pipeline
    PYTHONDONTWRITEBYTECODE=1 uv run --no-project --python 3.13.5 python -m unittest discover -s scripts/collection -p 'test_*.py'

CI covers source identity, boundaries, exact numerics, status/program semantics,
witness repair, timing, quantity, cost, redirects, archive roundtrips and
activation/rollback with synthetic fixtures. Private source-pilot tests run against
preserved local state and skip when those uncommitted inputs are absent. A frozen
dataset still needs independent source checks and staged runtime verification;
passing tests alone does not establish semantic correctness.
