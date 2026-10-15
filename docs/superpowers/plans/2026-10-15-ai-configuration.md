# AI-friendly automation configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let an AI discover the supported automation contract, generate and validate portable JSON, and let the user preview/import it on iPhone and reuse it for Watch.

**Architecture:** Extend the existing Core model and portable credential boundary. Use one inspection API for a local Swift CLI and the iOS import preview. Keep task execution and Watch transport unchanged; create disabled copies with new IDs on import and device duplication.

**Tech Stack:** Swift 6, Swift Package Manager, Foundation, SwiftUI, JSON Schema. No new dependencies or AI/network service.

## Task 1: Portable configuration contract and local tool

Files: `packages/HealthRelayCore/Sources/HealthRelayCore/ConfigurationExchange.swift`, `Resources/automation.schema.json`, `Sources/HealthRelayConfigCLI/main.swift`, `Package.swift`, `Tests/HealthRelayCoreTests/ConfigurationExchangeTests.swift`.

- [x] Write failing behavior tests for malformed JSON, nested unknown fields, wrong enums/types, unsupported schema versions, semantic validation, single task and bundle round trips, duplicate IDs, limits, removal of credentials, default disabled import, Watch availability and independent copy IDs.
- [x] Implement `ConfigurationExchange.inspect(_:systemMajorVersion:) -> ConfigurationInspection`, with `valid`, sanitized `tasks`, and structured `issues` (`severity`, `code`, JSON Pointer `path`, `message`). Structural/decode errors must identify their field without echoing input values. Semantic and execution capability checks must reuse existing validators. Missing local authentication is a warning, not invalid portable configuration. The report is configuration validation, not proof of HealthKit access or upload success.
- [x] Accept existing single-task JSON and a bundle `{ "schemaVersion": 1, "kind": "healthrelay.automations", "tasks": [...] }`. Enforce 1 MiB and 1–100 tasks, reject duplicate IDs and unknown fields. Support one complete Markdown JSON fence for chat copy/paste. Export every task through the portable sanitizer; preserve legacy Authorization requirements when removing local credential references.
- [x] Implement `export(_ tasks:)`, `template(device:)`, `schema()`, and `copiesForImport(_ inspection:)` plus `watchCopy(_ task:)`. Import copies always have fresh IDs/revision 1 and are disabled. Watch copies are validated for Watch before returning; do not change an existing task's device or ownership.
- [x] Publish JSON Schema for the full current configuration, defaults/enum constraints, and both file shapes. CLI commands: `schema`, `catalog [--device iPhone|watch]`, `template [--device iPhone|watch]`, `validate FILE|-`, `watch FILE|-`. CLI reads bounded local input, emits JSON, uses exit 2 for invalid configuration/arguments, and never reads HealthKit/Keychain or writes to a device. `watch` outputs validated disabled copies, using existing Watch snapshot constraints for the prospective task set.
- [x] Run `swift test --package-path packages/HealthRelayCore`; exercise the actual executable with valid and invalid fixtures. Review spec compliance, then code quality.

Example acceptance assertions:

```swift
let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([task]))
#expect(report.valid)
#expect(report.tasks.allSatisfy { !$0.enabled && $0.destination.credentialRef == nil })
let copies = try ConfigurationExchange.copiesForImport(report)
#expect(copies[0].id != task.id)
let watch = try ConfigurationExchange.watchCopy(task)
#expect(watch.device == .watch && !watch.enabled && watch.id != task.id)
```

## Task 2: iPhone import, sharing, and Watch reuse

Files: `ios/HealthRelay/AutomationListView.swift`, `ConfigurationImportView.swift`, `AutomationStore.swift`, `ios/HealthRelayUITests/ConfigurationUITests.swift`, project generation output.

- [x] Add an isolated UI test: open Paste JSON, fill a synthetic valid task, inspect preview, import as a new disabled task, reopen after launch and verify persisted task. Add invalid JSON/unknown-field case ensuring no save and a visible error. Use only `--ui-testing` storage and synthetic endpoints.
- [x] Add Paste JSON and file import through the common inspector; show device, metrics, interval, destination host, authentication requirements, errors and warnings before any save. Input is never uploaded to an AI service. Keep existing single-task edit/update flow available after inspection, so missing fields or credentials can be fixed locally.
- [x] Add export-all portable bundle and shareable AI configuration guide (schema, catalog/template access and constraints). Add a context action to copy an iPhone task to a disabled Watch task for review in the editor. Surface Watch limitations before saving.
- [x] Add atomic `importConfigurations(_ inspection:)`: validate first, append fresh disabled copies in one repository save, then update memory/observers. Never partially save a batch or overwrite existing IDs; keep protected-data checks and existing pending-batch/Watch ownership safeguards.
- [x] Run Core and native tests, the focused simulator UI tests, and iPhone/Watch simulator builds. Review spec compliance, then code quality.

## Task 3: Integration and evidence

Files: `docs/ai-configuration.md`, minimal README link.

- [x] Document schema/catalog/template/validate/watch examples, error paths, defaults, disabled imports, local credentials, and the phone→Watch review/sync/authorization flow. Explicitly distinguish configuration validation, compilation, UI acceptance, and hardware background acceptance.
- [x] Integrate only scoped changes after checking the live source against the snapshot baseline; preserve the other chat's Watch changes and dirty files. No device install, configuration replacement, production writes, commit, push, or deployment as part of this configuration task.
- [x] Run public-artifact scan and diff whitespace check; report verified delivery state and remaining physical-device boundaries.
