# Automation Core Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated protocol task; execute the shared configuration, sync and iOS integration sequentially. Steps below track implementation and acceptance.

**Goal:** Ship mixed-metric aggregation, useful HEA v2 compatibility, independent historical backfills and bounded background scheduling, verified only against the isolated Cloudflare receiver.

**Architecture:** Keep the existing task, journal and HTTP pipeline. Add a HealthKit aggregation reader that consumes anchored changes, remembers affected time windows and queries complete window snapshots. Commit its proposed state with the upload acknowledgement. Historical backfills use a separate durable job ID and sync state; all runs share a serial scheduler and a wake-up deadline.

**Tech Stack:** Swift 6, SwiftUI, HealthKit, AppIntents, BackgroundTasks, URLSession; existing Cloudflare Worker/DO acceptance fixture. No new runtime dependency.

## Scope and invariants

- Existing native raw tasks and saved configuration remain readable.
- Quantity metrics default to their own supported statistics; sleep has a daily session summary. Unsupported categories remain explicit.
- Aggregate window identity is stable. Late samples update the full window; removals trigger correction. No changes means no snapshot queries or HTTP requests.
- Bounded UUID/window and hash caches are optimizations, not correctness dependencies: unknown deletion falls back to a resumable window sweep over the task range.
- HEA v2 uses its documented heart-rate and sleep shape; HEA CSV is explicitly named and multipart. Legacy v1 and special readers stay unsupported.
- HEA cannot propagate deletions: expose an explicit omit/reject policy and log omissions. Native export carries deletions.
- Backfill does not mutate the parent task or its committed checkpoints. Pending backfills resume after restart.
- Global scheduling serializes all task types, coalesces triggers and checks one shared deadline. iOS timing remains best effort.
- No production POST, database binding, signing credential, health sample or test secret in Git.

## Task 1: aggregation contracts and computation

Files: AutomationConfig.swift, HealthRecord.swift, SyncJournal.swift, new Aggregation.swift, AggregationTests.swift, ios/HealthRelay/HealthKitReader.swift.

- [x] Add failing mixed-statistics and window tests. Example: `XCTAssertTrue(task.validationIssues().isEmpty)` for steps(sum) plus heart rate(avg/min/max); DST day must be 23 hours in America/Los_Angeles on 2026-03-08.
- [x] Add failing changed-window tests: first sample -> full-window average; late second sample -> same record ID and corrected value; deletion -> corrected or empty window; no event -> zero snapshot calls. Restart uses the proposed checkpoint only after acknowledgement.
- [x] Add optional per-selection statistics, aggregate state to TypeCheckpoint, and proposed checkpoint to ReadPage. Preserve decoding of existing files.
- [x] Implement calendar buckets and anchored-change-to-window processing with bounded caches. Snapshot values come from HealthKit statistics; sleep merges overlapping intervals and assigns sessions across midnight consistently.
- [x] Run `swift test --package-path packages/HealthRelayCore --filter AggregationTests`, then all Core tests.

## Task 2: HEA protocol (isolated ownership)

Files: HEAEncoder.swift, new HEACSVEncoder.swift, HEARequestMetadata.swift, HEACompatibilityTests.swift. Parent handles BatchEncoder dispatch and configuration UI.

Contract: aggregated HealthRecord is op=upsert, stable recordId, start/end UTC; payload has `aggregation: true`, `unit`, optional `sum/average/minimum/maximum`, `value` preferred statistic. Sleep payload has `totalSleep/asleep/core/deep/rem/awake/inBed` in hours, optional `sleepStart/sleepEnd/inBedStart/inBedEnd` in UTC, and `sleepDate` local yyyy-MM-dd. Raw format unchanged. Empty snapshots are native delete records; parent applies HEA deletion policy before encoding.

- [x] First write failing fixtures verifying HR Min/Avg/Max, HRV qty, daily cumulative qty, daily sleep, timezone and percent conversion.
- [x] Preserve `HEAEncoder.encode(batch,timeZone:)`; add `HEACSVEncoder.encode(batch,timeZone:)` returning EncodedBatch and multipart boundary derived from batch ID. Use CSV file field `file`, explicitly document this selected compatibility profile pending real HEA capture.
- [x] Add `HEARequestMetadata.headers(task:batchID:) -> [String:String]` for automation-name/id/aggregation/period/session-id. ASCII-safe task names use percent encoding for non-ASCII/header control characters.
- [x] Run focused tests and report exact supported compatibility boundary; never fabricate mappings for unknown metrics.

## Task 3: sync, backfill and scheduling

Files: SyncEngine.swift, SyncJournal.swift, HTTPUploader.swift, new BackfillJob.swift and RunCoordinator.swift; corresponding Core tests; AutomationStore.swift.

- [x] Failing tests: interruption after first metric preserves next metric; shared time budget stops between types; two triggers cannot concurrently upload; backfill job ID differs while outbound task ID stays parent ID.
- [x] Persist continuation selection, requested range and proposed aggregate checkpoint. Preserve identical pending body/header/ID across retries. Check deadline between reads and uploads.
- [x] Add durable backfill job configuration with fixed date range and snapshot of task. Separate journal by job UUID; preserve parent outbound task UUID; complete only after all pages are confirmed.
- [x] Add serial FIFO coordinator and automatic-trigger eligibility; differentiate foreground, observer, scheduled and backfill work. Restore unfinished jobs and avoid periodic scans for tasks with neither periodic polling nor a dirty marker.
- [x] HTTP Retry-After accepts seconds and HTTP-date; retain actionable 413 rather than pretending a failed batch was accepted. Any automatic splitting must not move its checkpoint until all pieces are confirmed.
- [x] Run all Core tests, including old crash/retry tests.

## Task 4: native UI and test receiver

Files: AutomationEditorView.swift, TaskExecutionView.swift, AutomationStore.swift, HealthRelayApp.swift, tests/cloudflare/worker.mjs and worker.test.mjs; generated Xcode project.

- [x] Expose per-metric default statistics, sleep daily semantics, format limits and deletion policy; distinguish foreground checks from periodic polling.
- [x] Backfill date picker, start/resume/cancel state, counts and diagnostic export without payloads/credentials. Keep active normal tasks unchanged.
- [x] Test receiver accepts native, HEA v2 and multipart CSV at separate paths; stores batch receipts and limited indexed inspection metadata. Preserve authentication, body limits and same-body idempotency.
- [x] Run Node tests and regenerate the Xcode project; build simulator and signed phone target.
- [ ] Physical-device UI via iphone-use: READY confirmed, then user needed the phone; no new install/configuration performed. Simulator UI and Cloudflare correction checks passed; existing HEA tasks untouched.

## Task 5: acceptance and documentation

- [x] Automated cases: mixed aggregation, DST, sleep midnight/overlap, late/deleted samples, no-change reuse, retry, backfill isolation and scheduling cancellation.
- [x] Cloudflare synthetic cases: HEA HR window correction overwrites prior window, idempotent retry leaves counters unchanged, multipart accepted, bad inputs rejected.
- [ ] Physical device: native aggregate + HEA request + independent backfill and natural background/lockscreen acceptance deferred at user request. Do not equate the old raw-device result with this iteration.
- [x] Update README, capabilities, contracts and gap audit with new implementation and exact remaining boundaries. Check links and diff; no secrets or real samples committed.

Verification commands: `swift test --package-path packages/HealthRelayCore`; `node --test tests/cloudflare/worker.test.mjs`; `python3 scripts/generate_xcode_project.py`; `xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`. Private endpoint and signing settings are loaded from ignored local files, never copied into this plan.
