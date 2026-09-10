# Runtime and evidence

Outpredict bases its admissions advice on the scraped student corpus and the
student's own messages and uploads. Workers AI handles planning and answers;
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
These final answers use higher reasoning effort; planning and ordinary answers
retain lower effort. Weekly schedules use a dedicated tool that multiplies
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

The verified model is `@cf/zai-org/glm-5.3-flash`, configured by `AI_MODEL`.
Native tool calls and final streaming worked on the existing Cloudflare account.

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
because the amount completed before that application is unknown.

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
of removed outside tools without network access, explicit arithmetic, real tool dispatch, source-account
deduplication, cycle-conditional outcomes, newest-file context, reasoning
suppression, incomplete streams, and lease cancellation. Provider checks use
synthetic applicant documents and real reviewed public corpus records, never
private user records. Credentials are loaded from ignored/secret stores and
are not included in artifacts or logs.

A live corpus-only boundary check asked for current Stanford requirements and
included a webpage URL. The answer correctly said it could not open the page or
verify current/upcoming policy from student reports, made no requirements claims,
and returned no sources. It completed in approximately eight seconds without an
outside research tool call.

The final targeted synthetic résumé check completed in approximately 42 seconds.
It reserved three hours for clinical activity and one for application work within
the stated four-hour weekly budget, labeling this an illustrative, conditional
allocation. It preserved completed hours, GPA, and MCAT with attachment citations,
kept the planned 200 hours conditional, and correctly showed at most 168 available
hours through the end of June 2027 from 2026-09-10. The preceding two-hour follow-up
correctly computed 84 hours through month end and 100 weeks for a 200-hour plan.
The final response redundantly asked to confirm the already-specified submission
month/year; advice quality remains a sampled check, not a factual guarantee.

A real two-sentence clinic rewrite initially produced one sentence, triggering
the bounded format repair. The resulting two-sentence answer preserved the
supplied clinic/appointment facts without adding frequency, duties, or outcomes.
This check completed in approximately 30 seconds. No private user records were
used in these model checks.

- [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [Markdown conversion binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Markdown conversion behavior](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
- [GLM-5.3-Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/)
