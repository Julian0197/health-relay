# Watch companion implementation plan

> **For agentic workers:** Use subagent-driven-development for implementation and separate specification/quality review. Preserve the source iOS checkout and use the Watch worktree only.

**Goal:** Add a configurable watchOS companion to HealthRelay so a worn, unlocked Watch can read locally available HealthKit data and send it directly to the configured HTTPS endpoint while the phone is locked.

**Architecture:** Keep `ios/` and `watch/` in this repository and share the existing Swift core and HealthKit reader. iPhone edits and transfers task configuration using WatchConnectivity. Watch owns its own checkpoints and persistent pending batches; a file-backed background URLSession owns network transport. No required backend, fixed metric list, fake workout, or production health uploads.

**Tech stack:** Swift 6, SwiftUI, HealthKit, WatchConnectivity, WatchKit background refresh, URLSession, Keychain, existing project generator. Minimum watchOS 11; validate SDK availability explicitly rather than comparing watchOS version to iOS version.

## Task 1: End-to-end Watch execution

Files: `packages/HealthRelayCore/{Package.swift,Sources/HealthRelayCore,Tests/HealthRelayCoreTests}`, `ios/HealthRelay/{AutomationStore,AutomationEditorView,AutomationListView,HealthRelayApp}.swift`, shared Apple-platform sources, `watch/HealthRelayWatch/`, `scripts/generate_xcode_project.py` and generated project/schemes.

- [x] Add backward-compatible execution-device selection (old JSON defaults to iPhone). iPhone must not execute Watch-owned tasks, including manual/backfill/observer paths. Changing ownership/configuration with a pending batch must be blocked until safely resolved. Returning a transferred task to iPhone must wait for an acknowledged Watch removal/disable snapshot so both devices cannot run simultaneously.
- [x] Add test-first deferred preparation and journal confirmation APIs. Preparing an upload must not send or advance committed checkpoints. Confirmation must match task, batch ID, fingerprint and receipt; stale/duplicate/failing callbacks must never acknowledge a different batch. Reuse existing encoding, aggregation and HTTP acknowledgement validation.
- [x] Implement paired configuration transfer with explicit iPhone UI action. Transfer only sanitized Watch-owned configurations over WatchConnectivity using the ordinary export redaction rules. Never read or transmit iPhone Keychain values or references. Bind required credential headers locally on Watch using secure input and Watch Keychain; do not enable tasks until required values are bound. Reject invalid/unsupported configurations as a whole. Local Watch activation follows HealthKit authorization. Surface pending/delivered configuration status honestly and avoid silently retaining removed tasks.
- [x] Reuse the generic HealthKit reader on Watch, adapting platform availability from the installed public SDK. Expose unsupported capabilities instead of silently dropping selections. Keep UUIDs, source information, raw/aggregate modes and existing HEA profiles.
- [x] Implement a small Watch UI with task name, metric count, destination host, authorization/activation, manual run and last result. Clear labels distinguish queued upload from server-confirmed success.
- [x] Persist each background transfer against the exact prepared batch. Reconnect sessions after relaunch; commit only after the response validates. Retry retained batches with bounded backoff; no overlapping sends of one batch, no shared global anchor, and no deletion of other transfers' files. Protect local data and bound response data. Apple background URLSession always follows redirects; require a direct HTTPS ingestion URL and reject unexpected final URLs for acknowledgement, without claiming this prevents redirect disclosure.
- [x] Use HealthKit changes, foreground activation and best-effort scheduled refresh. Finish system background tasks after required work, with expiration/cancellation handling. Avoid tight polling, unlimited backfills and workaround workout sessions. Honor disabled tasks and expected minimum intervals.
- [x] Add the companion target and shared scheme in the existing iOS Xcode project. Keep project generation repeatable. Build both iOS and watchOS simulator targets; do not use the user's devices.

Acceptance examples (synthetic records only):

```swift
// Existing engine is still the only batch encoder/query/checkpoint owner.
// A prepared pending batch must survive reconstruction of SyncJournal.
#expect(state.pending != nil)
#expect(state.checkpoints.isEmpty)
// A callback for an old transfer must leave the newer batch untouched.
#expect(reloaded.pending?.batchID == newerBatchID)
```

Commands:

```sh
swift test --package-path packages/HealthRelayCore
python3 scripts/generate_xcode_project.py
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelayWatch -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Task 2: Review, documentation and acceptance

- [x] Separate specification review from quality review; resolve findings before delivery.
- [x] Update README and `docs/implementation-watch.md` with setup, ownership/duplicate handling, local Watch credential binding, background scheduling and unsupported types.
- [x] Record exact test/build evidence. A simulator build does not prove natural background delivery, phone-lock behavior or battery impact; those require paired physical-device acceptance later.
- [x] Verify this work edited only the independent worktree, preserve concurrent changes in the primary iOS checkout, and require `git diff --check` to pass. Keep work on the new local branch; do not merge, push or deploy production.

Implementation scope adjustment: iPhone-to-Watch secret transfer was rejected by automatic approval review. Use configuration-only sync plus local Watch credential entry; do not implement a hidden transfer channel or live credential access.

## Verification record

2026-10-13: 77 Core tests passed including both opt-in isolated Cloudflare integrations; 5 receiver tests and 1 native iOS configuration/persistence UI regression passed. Signed combined iOS/Watch build passed. Native Watch simulator file-backed background upload returned HTTP 200, committed one checkpoint, cleared pending and transfer files, and stored exactly one synthetic record in the isolated receiver. Relaunch retained the checkpoint and produced noData. Separate spec and quality reviewers passed after capability, transient receipt-write recovery, acceptance endpoint isolation, and implicit legacy Authorization fixes. Physical WatchConnectivity delivery, natural wakeups, phone-lock behavior and energy remain deferred to the physical-device checklist.
