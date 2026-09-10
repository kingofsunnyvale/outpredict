# Runtime and evidence

Outpredict bases its admissions advice on the scraped student corpus and the
student's own messages and uploads. OpenAI GPT-5.6 Sol handles planning and answers;
D1 stores the reviewed corpus and private conversation state, and private R2
stores uploads. No outside search, webpage retrieval, or external admissions
source is used by the product.
The application is free. Authentication and per-user request/file limits protect
the shared service; there are no paid tiers.

## Agent behavior

`src/agent.ts` selects tools according to the question. Ordinary questions and
writing help can receive answers without a corpus search. Comparisons use
`searchCohort`. The other tools inspect retrieved student profiles and perform
deterministic arithmetic and time-budget calculations. A turn permits at most four planning
rounds and seven tool calls, with individual tool limits and a 150-second overall
deadline. Up to two cohort searches allow one refinement without increasing
the total tool budget. Model/stream waits periodically check the conversation lease so a
cancelled or superseded generation cannot keep producing saved output.

Answers using attachments or a retrieved cohort receive one bounded private
draft and review pass before final streaming. This checks the weekly time budget,
reported versus absent experience, completed versus planned hours, unsupported
hour thresholds, citation support, and entry-year versus submission-year timing.
It is an additional model check, not a guarantee of factual accuracy.
These final answers use high reasoning effort; ordinary answers use low effort.
Tool-planning calls use `reasoning_effort: none`, the verified Chat Completions
configuration for Sol function calls. Weekly schedules use a dedicated tool that multiplies
hours/week by the assumed number of weeks and can calculate a shortfall against
the student's own plan. It never derives a target from corpus medians.
Its `verifiedStatement` supplies readable, precomputed arithmetic; the answer
uses that statement instead of inventing ratios or annualized estimates. A
calendar check automatically evaluates explicitly mentioned future month/year
values in recent user messages and attachments against the current UTC date.
It reports capacity by the start and through the end of that month, and any
shortfall even at month end. These conditional bounds do not assume an exact
submission deadline. A required-weeks result supports duration comparisons.
Source cards display the computed facts and retain inspectable JSON.

Answer text is streamed from actual model deltas. An explicit request for one
to eight sentences is a bounded exception: the short answer is buffered, checked,
and, if necessary, repaired by one additional model call. A verified result is
delivered as one delta; a failed check produces an error instead of an incomplete
or incorrectly formatted successful answer. Writing instructions preserve only
supplied autobiographical facts and prohibit invented duties, frequency, or impact.
`reasoning` and
`reasoning_content` are never forwarded or stored. Provider errors, timeouts,
truncated outputs, and interrupted streams preserve partial text with an error
state. An empty model answer is an error, not a successful response. Retrying and
saving a result are coordinated by the conversation store's generation lease.

The verified model is exactly `gpt-5.6-sol`, configured by `AI_MODEL`.
The server-only transport uses OpenAI Chat Completions, `store: false`, and the
restricted Outpredict project credential. Native function calls and final SSE
streams passed real API checks. There is no fallback to another advice model.
Cloudflare Workers AI remains responsible for document/image conversion.

The adapter accepts only the four local tools, fixes the provider endpoint,
rejects redirects and malformed/incomplete responses, bounds response size and
waits, and propagates cancellation. A final stream requires a successful stop
frame; a truncated stream or content filter retains a retryable partial result.
Provider response bodies, headers, credentials, and private reasoning are not
forwarded into user errors or application logs.

The OpenAI console's feedback, evaluation/fine-tuning, and API input/output
sharing controls were verified disabled without changing organization settings.
`store: false` disables application response storage. Ordinary API abuse-monitoring
retention can still apply for up to 30 days; Zero Data Retention is not configured.

Models can still misinterpret evidence. Tests cover the deterministic boundaries;
live answer review checks interpretation separately. Corpus medians are
descriptive, never admissions thresholds, personal probabilities, or targets.
Recommendations should be conditional on the student's goals, responsibilities,
and available time. Source reports do not establish why an outcome occurred.

## Counts and citations

The corpus module deduplicates source accounts before filtering and counting.
Applicant-school outcomes do not increase the applicant count. Cross-site
identities are not merged by inference.

- Available: reviewed current source accounts in the corpus.
- Matching: accounts meeting the actual query filters.
- Retrieved/examined: bounded profile summaries supplied to the model.
- Supporting: distinct retrieved accounts whose source IDs occur in the answer.
  This measures cited support, not a separate factual-verification pass.
- Reported outcomes: matching accounts with an explicit, unconditional,
  same-cycle acceptance or rejection. Interviews/waitlists remain separate states.

The model receives separate available, matching, retrieved, and numeric-summary
population fields. Supporting is defined only as distinct retrieved source
accounts cited in the final answer; it is never the numeric-summary population
or a statistic's sample size. The backend appends an **Evidence counts** statement
after final citations are known and saves the same values in its calculation
record. The model is instructed to leave this summary to the application. Explicit
sentence-count or recognized word/character/line/bullet limits use the evidence
panel instead of an added count statement.

Deterministic numeric summaries can use up to 1,000 matching accounts, separately
from the smaller retrieved sample. Each statistic records its own included and
excluded counts. Hours exclude ranges, estimates, projections, mixed-cycle
timing, and unreported quantities; explicit zero is retained. An excluded value
does not necessarily mean the applicant provided no information.

Sources and calculations have saved citation IDs, URLs where applicable,
observation dates, and excerpts. Profile sources store both `profileId` for
inspection and `applicantId` for deduplication. A conditional offer for a later
cycle is excluded from the current-cycle profile evidence given to the model.
The original reviewed record remains auditable through profile inspection.
Mixed-timing activity totals are also withheld from the model's cycle snapshot
because the amount completed before that application is unknown. Narrative-only
categories such as publications retain their exact reported text and reporting
status without a misleading null hour measurement. A report of no publications
with a thesis/poster is distinct from unreported publications; anticipated
manuscripts are not treated as completed publications. Null hours for an activity
do not mean the activity itself was unreported.

Follow-ups retain bounded historical source context without claiming a new
corpus query. Profile, calculation, and attachment citation numbers are not
recycled. Retained attachments keep the same citation ID across follow-ups.
If a new cohort is retrieved, its supporting count includes only that turn's
latest retrieved cohort. Earlier sources remain available for citations; a
replacement within an answer records an evidence note explaining that counts
and statistics describe the latest search filters. Current attachments are
supplied newest-first; when the document budget excludes older material, the
evidence notes disclose it.

## Evidence boundary

The product's only admissions evidence is the reviewed scraped student corpus
and information supplied by the student. Its four tools are `cohort_search`,
`profile_inspect`, `weekly_time_budget`, and `calculate`. There is no browser,
search provider, public-page reader, or API credential for outside research.
A URL in a message or document remains text; the agent does not open it.
Original student-post links are retained only for corpus provenance and inspection.

Historical student reports cannot verify current or future school requirements,
deadlines, tuition, eligibility, or official rules. The answer must say when the
available data cannot establish a requested fact. It must not substitute remembered
policies, outside citations, or claims about what most schools require. Student-
supplied text can be discussed as their input without claiming it was independently
verified. Legacy answers backed by outside sources are excluded from future model
context, and their source evidence is not carried into new answers.

## Attachments

The product accepts text/Markdown, text PDFs, DOCX, PNG, and JPEG within the
configured file/account limits. Text files decode locally. Cloudflare's
`AI.toMarkdown` converts documents/images through the AI binding.

Each account can start 20 accepted upload attempts per UTC day, across all
formats including local TXT/Markdown extraction. An atomic reservation precedes
R2 writes and conversion. Failed conversions consume the attempt; deleting a
file does not restore it. The limit resets at the next UTC midnight. Invalid
formats and storage-cap rejections do not start an attempt. A quota response
uses HTTP 429 with `conversion_usage_limit` and the limit/reset details.

Actual synthetic-résumé tests on 2026-09-10 UTC verified PDF, DOCX, PNG, and JPEG
extraction. GPA, MCAT, activity hours, dates, and planned/completed distinctions
were preserved. The PDF/DOCX/PNG batch took about 11 seconds; JPEG took about
13 seconds. Images are interpreted by a model, so important extracted details
should be reviewed rather than assumed exact.

An image-only PDF returned only page headings with a successful HTTP status.
The optional PDF embedded-image conversion produced an inaccurate description
in a clean synthetic scan test, so it is disabled. Empty meaningful text is
treated as extraction failure. Users can upload individual PNG/JPEG pages or
a text PDF instead. A provider's supported-format catalog is not treated as
proof of extraction success.

Uploads are private and owned by the authenticated user. Attachment evidence
stores `attachmentId` so deleting material can scrub its raw excerpt and remove
it from future context, along with private file storage and extracted text.

## Verification and references

`test/agent.test.ts` exercises the closed corpus/input tool boundary, rejection
of removed outside tools, explicit arithmetic, real tool dispatch, source-account
deduplication, cycle-conditional outcomes, newest-file context, reasoning
suppression, incomplete streams, and lease cancellation. Provider checks use
synthetic applicant documents and real reviewed public corpus records, never
private user records. Credentials are loaded from ignored/secret stores and
are not included in artifacts or logs.

The Sol migration was checked against the actual proposed adapter and a disposable
local D1 containing the reviewed 58-account baseline. Real API cases covered a
synthetic résumé, a two-hour follow-up, two-applicant comparison, and a current
Stanford policy question. All 14 API requests completed successfully; cases took
approximately 30, 26, 20, and 14 seconds respectively. The policy answer said it
could not verify current requirements and used no outside research tool.

The résumé and follow-up preserved 160 clinical, 450 research, 120 food-bank, and
35 shadowing hours as completed, separately from 200 planned clinical hours.
Calendar calculations from 2026-09-10 correctly capped four hours/week at 168
hours through June 2027, and two hours/week at 84 hours. A separate exact UI
question completed in approximately 46 seconds: its three-hour clinical and
one-hour application allocation stayed within the four-hour budget and explicitly
recognized that clinical time alone would be less than 168 hours. This corrected
an overbooked suggestion observed with the previous GLM model.

The comparison retained 58 available/matching, two retrieved, and two cited
supporting accounts. It distinguished no publications from a thesis/poster and
future manuscripts. One initial answer incorrectly ranked reported nonclinical
hours against an unquantified report. A narrow comparison rule was added; the
targeted 22-second recheck explicitly said the numeric comparison was unavailable,
preserving the narrative and correct counts. Exact word limits remain
model-enforced; these representative checks do not guarantee every answer.

Transport tests cover the fixed endpoint, private headers, allowed tools,
`store: false`, timeouts, aborts, provider errors, response bounds, and SSE
completion. The preexisting sentence-count repair and evidence/calculation tests
remain regression checks. Deployment evidence is recorded in TOOLING.md and OUT-12.

- [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [Markdown conversion binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Markdown conversion behavior](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)
