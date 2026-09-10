# Interface and browser verification

The interface follows the actual authenticated LightReel experience inspected
on September 9, 2026 (America/Los_Angeles), using Outpredict's admissions content.
Reference inspection covered new chat, prompt suggestions, sidebar/history,
composer, attachment controls, live progress, answer typography, evidence panels,
follow-ups, account controls, and a 390 × 844 mobile viewport.

The desktop layout uses a 240px pale sidebar, white conversation canvas, a
580px new-chat composer, restrained borders, and system sans-serif typography.
The answer column expands when evidence is closed. On mobile, navigation and
evidence open as full-screen dialogs with keyboard focus management and close
controls. There are no subscription or premium-mode controls.

## Interaction behavior

- A freeform draft survives Google sign-in. No intake form is required.
- The composer grows with the draft; Enter submits and Shift+Enter adds a line.
- Uploads display processing, ready, and actionable failure states. Your files
  can recover unused ready uploads for a later question.
- Progress comes from actual server tool events; answer text uses live deltas.
- Stop cancels the specific generation. Retry reuses the question and creates a
  new answer attempt. Reopening or refreshing restores saved messages/evidence.
- Citation buttons open the exact source. Grouped citations remain individually
  inspectable. Profile cards fetch the reviewed profile, including activities,
  timing, outcomes, and missing information.
- Count definitions are in RUNTIME.md. Admissions evidence uses the imported
  student-profile corpus and the student's own inputs. General questions need no
  profile counter. The runtime does not search or retrieve outside webpages.
- History and file-manager deletions have explicit confirmation and storage-error
  recovery. Removing an unsent attachment from the composer removes its upload.
  Sign-out clears private client state and fences outstanding asynchronous reads.
- A failed initial asset load displays reload guidance instead of an empty page.

## Verification record

Local browser checks exercised real Google login, preserved drafts, ordinary
questions, PDF extraction, a résumé-based plan, changed time-budget follow-ups,
profile inspection, saved history after refresh, cancellation/retry, and desktop
and 390px mobile navigation/evidence/composer layouts. An unreadable synthetic
scan displayed the text-PDF or PNG/JPEG alternative. Provider checks separately
verified synthetic DOCX, PNG, and JPEG extraction.

Screenshots were compared with the captured LightReel screens. These private
verification artifacts stay outside Git because account UI can contain identity
details. Final staging and production evidence is recorded in TOOLING.md and the
linked Linear issues. API ownership/deletion checks complement browser checks.
