# Runtime and evidence

Outpredict uses Workers AI for planning and streamed answers, D1 for the reviewed
applicant corpus and private conversation state, and private R2 for uploads.
The application is free. Authentication and per-user request/file limits protect
the shared service; there are no paid tiers.

## Agent behavior

`src/agent.ts` selects tools according to the question. Ordinary questions and
writing help can receive answers without a corpus search. Comparisons use
`searchCohort`; current school facts use public source discovery followed by a
read of the publisher's page. The bounded tool loop also supports profile
inspection and deterministic arithmetic. A turn permits at most four planning
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

The verified default candidate is `@cf/zai-org/glm-5.3-flash`. Native tool calls
and final streaming worked on the existing Cloudflare account. Model selection
is configured by `AI_MODEL`; check the deployed configuration rather than
assuming every environment has been changed. `gpt-oss-120b` was reachable but
performed poorly on the bounded arithmetic/evidence-quality checks. More
expensive GLM-5.2 did not materially improve those checks. Kimi K2.6 exhausted
the bounded output budget on reasoning without an answer and was not selected.

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
search. Profile, webpage, calculation, and attachment citation numbers are not
recycled. Retained attachments keep the same citation ID across follow-ups.
If a new cohort is retrieved, its supporting count includes only that turn's
latest retrieved cohort. Earlier sources remain available for citations; a
replacement within an answer records an evidence note explaining that counts
and statistics describe the latest search filters. Current attachments are
supplied newest-first; when the document budget excludes older material, the
evidence notes disclose it.

## Public information discovery

When `TAVILY_API_KEY` is configured, the backend uses Tavily basic search.
Otherwise it discovers live links on verified official institution entry pages.
`data/official-sites.json` covers all 176 supported institution/application-system
names, with provenance URLs and a directory-review date. This is scoped official
site discovery, not a broad or exhaustive web search. The directory date verifies
the entry link/host, not every current policy or the reachability of every deep
path. Each search reads at most two entry pages, returns up to five leads, and
can recover a 404/410 entry by reading that same verified host's root once.
Other failures do not trigger that fallback. The publisher page must be read
before policy claims or citations are added. Discovery and reading record actual
observation dates. Directory-verified .org/.com hosts are classified as official.
Blocked/challenge/unreadable responses fail clearly. There is no challenge
bypass, browser impersonation, or repeated probing of blocked endpoints.

Public-search inputs are a finite set of public institutions and admissions
topics. The server constructs the query; model-generated applicant names,
document excerpts, arbitrary query strings, and additional fields are rejected.
The institution list covers a broad range of US MD and DO schools. For an
unrecognized school, the assistant can ask for an official URL while continuing
general advice. Uploaded documents never supply fetch permissions.

Page retrieval requires the exact URL to come from a search result, a historical
public source, or an explicit URL in a user message. It accepts only public HTTPS
addresses, rejects private/local/numeric addresses and credentials, checks
redirects, sends no user cookies, and caps response bytes and text length.
Being on an `.edu` or `.gov` domain alone does not authorize an arbitrary URL.
Search snippets are discovery leads; citations are added after reading the
publisher's page. Both credentialed API and publisher requests use manual
redirect handling; API credentials are never forwarded through a redirect.

On 2026-09-10 UTC, local outbound discovery and publisher retrieval succeeded
for Stanford and UCLA. A subsequent deployed test showed that DuckDuckGo did
not respond from a Cloudflare Worker within 12 seconds; this was a timeout,
not a confirmed verification challenge. That route is no longer the no-key
runtime fallback. A separate temporary Cloudflare Worker successfully read
Stanford, UCLA, AAMC, and LCME official pages using the real bounded reader;
LCME's same-host redirect was handled successfully. Both temporary Workers
were deleted. Full integrated staging research remains a release check.

Research errors distinguish network/timeout, HTTP, redirect, challenge, body,
and parse failures using sanitized categories without logging query text or
secrets. When no official page is read, the assistant asks for an official URL
or pasted policy text instead of substituting remembered requirements.

Cloudflare's experimental Web Search previously returned `account_disabled`.
Gemini 2.5 grounded queries previously returned unavailable-model errors, and
current Gemini 3 grounding is unavailable on the free API tier. Neither failed
path is used as a silent fallback. Bing RSS was excluded because its response
restricts use to personal noncommercial RSS aggregation.

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

`test/agent.test.ts` exercises private-query rejection, URL provenance/redirect
guards, body limits, explicit arithmetic, real tool dispatch, source-account
deduplication, cycle-conditional outcomes, newest-file context, reasoning
suppression, incomplete streams, and lease cancellation. Provider checks use
synthetic applicant documents and real reviewed public corpus records, never
private user records. Credentials are loaded from ignored/secret stores and
are not included in artifacts or logs.

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
- [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily credits](https://docs.tavily.com/documentation/api-credits)
- [AAMC prerequisite directory](https://students-residents.aamc.org/medical-school-admission-requirements/required-premedical-coursework-and-competencies)
- [LCME accredited programs](https://lcme.org/directory/accredited-programs/)
