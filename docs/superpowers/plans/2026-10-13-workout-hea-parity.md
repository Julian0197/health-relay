# Workout Export and HEA Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** iPhone configures automations, Watch reads and uploads available local HealthKit data; export complete workouts and implement HEA's documented JSON v1/v2 and CSV contracts, with real-export comparisons tracked separately.

**Architecture:** Keep the existing HealthRecord envelope and receipt-gated anchor. Enrich workout payloads before returning a read page with routes, associated samples, statistics, events and quantity-valued metadata. Pure Core encoders translate these records into HEA data families; unsupported/unavailable platform objects remain explicit, never silently dropped. Native JSON retains original fields. No background workout session, polling timer, or new server is introduced.

**Tech Stack:** Swift 6, HealthKit, CoreLocation, existing HealthRelayCore and XCUITest. iOS 18/watchOS 11 minimum, availability gates for newer objects.

## Task 1: Full workout read path

Files: ios/HealthRelay/HealthKitReader.swift; new shared/WorkoutReader.swift; new packages/HealthRelayCore/Sources/HealthRelayCore/WorkoutExport.swift; ios/HealthRelayTests/WorkoutReaderTests.swift; packages/HealthRelayCore/Tests/HealthRelayCoreTests/WorkoutExportTests.swift; scripts/generate_xcode_project.py generated project; HealthRecord.swift execution capabilities.

- [x] Write failing synthetic tests: associated heart rate/cumulative grouping; all route segments ordered with all CLLocation fields; options disabled omit expensive reads; cancellation/query failure produces no page/anchor; quantity metadata survives; legacy summary remains readable.
- [x] Run `swift test --package-path packages/HealthRelayCore --filter WorkoutExportTests`, confirm the new behavior fails.
- [x] Implement minimal shared read/enrichment helpers. Query samples using workout association, not broad time overlap. Request route/quantity authorization only for selected workout options. Export existing statistics plus standard workout metadata, events, activities and route locations. Check cancellation between/inside queries; query failure must propagate. Preserve source filters.
- [x] Group associated series in seconds/minutes by deterministic timestamp buckets: cumulative quantities sum, discrete quantities average/min/max; heart rate keeps Min/Avg/Max. Preserve original sample IDs/source in native payload.
- [x] Regenerate project, run Core/native focused tests and build both iPhone and Watch. Remove route/metric execution block only after readers and tests pass.
- [x] Review specification compliance then code quality; fix all material findings.

Task 1 evidence: Core 96 passed / 2 skipped; 15 iPhone native synthetic tests and 24 Watch native tests passed. Specification and code-quality review passed. Actual HealthKit store/device acceptance remains pending.

## Task 2: HEA JSON data families and versions

Files: HEAEncoder.swift; new HEAWorkoutEncoder.swift and HEAMetricCatalog.swift; HEACompatibilityTests.swift; HealthRecord.swift; AutomationConfig.swift.

- [x] Add failing contract fixtures for mixed data families, workout v1/v2, routes, time series, blood pressure, special metric metadata, symptoms, cycle records, heart-rate notifications and all explicitly supported metric names. Fixtures must be synthetic and grounded in official HEA documentation or sanitized real observations.
- [x] Run `swift test --package-path packages/HealthRelayCore --filter HEACompatibilityTests`, record initial failure.
- [x] Encode documented data envelopes and optional fields without invented values; v1 and v2 choose their real schemas. Expand explicit mapping to supported HEA metrics; do not mechanically snake-case SDK identifiers. The existing HealthRelay percent-display profile is retained but explicitly unverified against HEA; no new equivalence claim.
- [x] Implement remaining specialized HEA object readers with SDK availability gates where public HealthKit permits (ECG, state of mind, medication). Request only necessary permissions and use separate queries for series.
- [x] Keep deletion rejection/explicit omission and acknowledged pending-batch semantics for every format; test retry body identity and mixed batches.
- [x] Review specification compliance then code quality.

Task 2A native specialized readers: spec and quality review passed. Core 97 passed / 2 skipped; iPhone 31 and Watch 40 native synthetic tests passed. Medication per-object authorization and actual HealthKit store queries still require hardware.

Task 2B evidence: Core 127 passed / 2 skipped; native SDK bridge tests caught and fixed workout location enum values. iPhone 41 native + 1 HEA configuration UI case and Watch 42 native cases passed. Spec and quality reviews passed. Medication and ambiguous categories remain explicit native-format gates.

## Task 3: CSV and real HEA comparison

Files: HEACSVEncoder.swift; HEA compatibility fixtures/tests; docs/implementation-hea.md.

- [ ] Inspect HEA manual export on the user's iPhone using the established iPhone Use channel. Transfer needed files locally with AirDrop; private files stay ignored and are never committed or uploaded to a new service.
- [ ] Compare JSON keys, null/omission rules, units, workout v1/v2 and CSV headers/part names. Record app version and configuration, distinguish observed from inferred.
- [x] Add a synthetic observed-heart-rate fixture and tests, then correct confirmed JSON differences. CSV retains quoting/newlines/formula protection and rejects nonmetric families; its observed layout mismatch remains open.
- [x] Run all Core and receiver tests: 132 Core passes / 2 skips and 11 receiver passes. Real workout, special-family and full CSV/transport parity remain open; no complete-compatibility claim.

## Task 4: Integration and acceptance

Files: ios/HealthRelay/AutomationEditorView.swift; README.md; docs/capabilities.md; docs/contracts.md; docs/implementation-hea.md.

- [x] Expose accurate capability messages and workout options; make iPhone configuration / Watch recent direct upload roles clear. HEA CSV is explicitly experimental with its known layout mismatch.
- [x] Run full Core + receiver regression; native lifecycle + workout tests on both platforms; targeted UI save/reload and export fixture acceptance. Core 132 pass / 2 skip, receiver 11, iPhone 41, Watch 42, targeted HEA UI 1.
- [x] Build combined iPhone+Watch simulator and Release device targets. Hardware HEA 10.0.4 preview and user-provided JSON confirm scoped schema only; actual full-workout and Watch behavior remain open.
- [x] Update progress and remaining acceptance items. Commit da1756c was fast-forwarded into local master; the merged Core regression passed (132 pass / 2 optional external skips). Existing Watch worktree and private artifacts are preserved. No push or new physical-device install. Task 3 capture and compatibility gaps above remain open.

Final integration review: approved. Complete workout means all queryable children at read time. Late child attachment after parent anchor confirmation is not verified; a new date-range backfill re-reads it, while rerunning the original task does not reset its anchor.
