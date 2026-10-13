# HealthRelay service and README migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iOS-first automation and Watch upload goal clear, and bring the existing Cloudflare / Feishu / HTML dashboard pipeline into this repository without personal configuration or data.

**Architecture:** Preserve the five HEA JSON ingestion routes and SQLite Durable Object implementation from the merged watch_monitor revision `97a4d36`. HealthRelay uses its existing `hea.v2` encoder and HTTP-success acknowledgement for supported streams. Signature publication, signed group cards and the read-only HTML display remain separate downstream consumers.

**Tech Stack:** Swift / HealthKit, Node.js 22.13+, Cloudflare Workers / SQLite Durable Objects, React / ECharts, iPhone Use for physical iPhone verification.

## Task 1: Portable service and dashboard

Files: `integrations/hae-webhook/`, `.gitignore`, `scripts/check_public_artifacts.py`.

- [x] Import only the tracked service directory from the merged source revision; exclude local credentials, health exports, deployment artifacts, and historical private documents.
  ```sh
  git -C /path/to/watch_monitor archive 97a4d36 integrations/hae-webhook | tar -x -C /path/to/health-relay
  ```
- [x] Remove `account_id` from both Wrangler configs and rename both services to HealthRelay-specific names. Keep scoring constants, storage semantics, auth and delivery behavior unchanged.
- [x] Make dashboard source labels generic, remove the fixed personal document link, use a configured safe HTTPS reopen link, and sanitize baker comments and tests. Keep the output capability in ignored files with mode 0600.
- [x] Add an isolated service package with pinned Wrangler, unit-test and runtime-smoke commands. Use synthetic fixtures and intercept outbound requests.
- [x] Add a public-artifact check for production tenant URLs, resource identifiers, credential assignments and private artifact paths; inspect matches rather than printing values.
- [x] Verify with `node --test integrations/hae-webhook/*.test.mjs`, dashboard tests/build and the Miniflare runtime smoke. Assert stored facts, duplicate handling, card signing and Base title/cache writes without live external calls.

## Task 2: Automation configuration contract

Files: `examples/watch-monitor/`, `packages/HealthRelayCore/Tests/HealthRelayCoreTests/ServiceAutomationTests.swift`, `integrations/hae-webhook/healthrelay-contract.mjs`.

- [x] Preserve the original five-stream settings as a secret-free declarative profile. Provide importable disabled HealthRelay configs for activity, HRV, heart, sleep segments and workouts. Use the workout encoder merged into App baseline `3fb5857`; keep routes and associated metrics disabled for the initial summary contract.
- [x] Use `https://health.example.com`, `requiredSecretHeaders: ["X-API-Key"]`, Asia/Shanghai, HEA v2, and `http2xx`. Do not export credential values, source-device identities or resource IDs.
- [x] Decode each file through AutomationConfig and assert validation succeeds. Encode synthetic records using the actual Swift encoder; pass resulting payloads and headers through the migrated Worker and durable store. Test retries, minute granularity, raw sleep segments and full-day activity semantics.
- [x] Run `swift test --package-path packages/HealthRelayCore` and the Node service contract test; verify no requests leave the local test boundary.

## Task 3: README, architecture and operational docs

Files: `README.md`, `docs/README.md`, `docs/architecture.md`, `docs/debugging-iphone-use.md`, `docs/services.md`, `docs/automation-profile.md`, `docs/signature-algorithm.md`, `docs/service-migration.md`, `integrations/hae-webhook/dashboard-app/README.md`.

- [x] Rewrite README in this order: project goal and iOS-first / HAE parity path; synthetic app screenshots; current architecture; documentation index; build/debug entry points; migration status and next acceptance steps.
- [x] Inspect existing screenshots before reuse. Add a synthetic dashboard preview if useful; do not use personal health screenshots.
- [x] Document Cloudflare bootstrap, separate ingest/read keys, webhook group binding and signing, optional Base/Miaobi signature publication, display Base permissions, HTML build/bake and local debug.
- [x] Keep iPhone Use setup → READY → UI action → device/server evidence instructions separate from Watch testing. Distinguish build, synthetic runtime, physical device and continuous background acceptance.
- [x] Check local Markdown links, generated HTML rendering, source attribution, public-artifact scan, and independent code/spec review. Preserve the unrelated dirty HAE branch and source worktrees.
