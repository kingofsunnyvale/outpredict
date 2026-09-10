# Conversations and private files

Google sessions determine ownership on the server. Request bodies never select
the acting user. D1 stores conversations, messages, citations, extracted text,
file metadata, and daily usage. R2 originals are private and downloaded only
through an authenticated ownership check. Separate staging and production
bindings are in `wrangler.jsonc`.

Apply `0003_conversations.sql` in staging with `npm run db:migrate:staging`, deploy
the issue branch, and run the deployed checks before applying it in production.
Migrations are additive and are never run in a request handler.

## Uploads and deletion

Supported uploads are TXT, text-based PDF, DOCX, PNG, and JPEG. MIME types,
file signatures, sizes, and extracted content are checked. TXT is decoded locally;
other supported files use Cloudflare Markdown conversion. Empty/scanned PDFs
receive an extraction error directing the user to a text PDF or page image.
Conversion has a timeout, and failures remain visible for removal or replacement.

Limits are 8 MiB per file, 64 MiB and 40 retained files per account, four attachments
per message, 20 attempted uploads per UTC day, 100 saved conversations, 200 messages
per conversation, and 50 generated turns per UTC day. Atomic reservations prevent
concurrent requests from exceeding limits. Failed conversions count; deleting
files or conversations does not reset daily usage.

File removal deletes its original and extracted text and scrubs attachment-source
excerpts from saved evidence. It fences active generation so a stale request cannot
restore that content. Information already written in an answer remains until the
conversation is deleted. Conversation removal blocks further reads/writes before
removing associated originals and D1 rows. If R2 deletion fails, history retries a
bounded number of pending removals and retains an explicit retry row on continued
failure. Data is never reported deleted while storage cleanup is incomplete.

## Reliable turns

A client request ID identifies a user/assistant pair. Replaying a completed request
does not generate a duplicate answer. Only the latest failed/cancelled turn can be
retried; it keeps the user message but receives a fresh assistant generation ID.
Every partial/final write checks the active generation ID. Cancellation requires
that same ID, so a delayed Stop cannot cancel a newer answer. A renewable lease
allows an interrupted generation to become retryable while retaining partial text.

The runtime streaming handler is delivered separately in OUT-9. The storage-only
release exposes chat/file CRUD and cancellation but does not generate answers.

## Verification

`npm test` exercises real local D1 migrations, ownership, quotas, concurrent
reservations, duplicate/retried turns, stale cancellation, expired leases, and
storage failure recovery. The deployed smoke script uses two short-lived synthetic
accounts and signed sessions, then cleans up their exact files and records:

```sh
node scripts/smoke-product.mjs --env staging --storage-only
node scripts/smoke-product.mjs --env production --storage-only
```

After the runtime is deployed, omit `--storage-only` to test replay and add
`--agent` for one real streamed answer. A protected cleanup manifest supports
resuming cleanup after interruption. The script never uses a real user's session
or prints credentials. These API checks complement actual Google login and UI
verification; they do not substitute for those flows.
