# Runtime model calls in omp session transcripts

Since commit `e7ed7a2f32` (2026-10-26, fork branch `wesley/dev` only), every omp model call writes a full copy of the conversation it sent into the session transcript, so `/export` can show what was sent. Those copies are now 77.8% of all transcript bytes on this machine, make long sessions grow about 36 times faster, cost over 1 GB of memory to reopen the largest sessions, and made five sessions too large for Paseo to read.

Start with [the Baseline / Ideal / Delta analysis](research/runtime-model-calls-in-session-transcripts-baseline-ideal-delta.md), then [the raw evidence](research/evidence-2026-10-29.md). The three design sketches from the Design-It-Twice pass are in [design/design-it-twice/](design/design-it-twice/).

Status (2026-10-29): planning only. No code changed. The delta choice is with Wesley. Nothing here is live: omp runs from the main checkout, and any fix goes live only after it merges to `wesley/dev` and the main checkout is updated.

Folder layout: oh-my-pi had no plan or design folder, so this follows the cc-workflows-plugin `docs/features/<timestamp>-<slug>/` convention.
