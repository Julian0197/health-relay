# HealthRelay dashboard

A React dashboard built as one self-contained HTML file for a Feishu/Lark
Miaobi HTMLBox. It reads a dedicated display Base through the host-provided
Magic SDK. The Worker prepares the display data; the browser does not call the
Worker or receive an ingestion API key.

## Build and preview

Use Node.js 22 or later and npm. From the repository root:

```sh
cd integrations/hae-webhook/dashboard-app
npm ci
npm test
npm run build
npm run preview
```

Open <http://127.0.0.1:8769>. The preview binds to loopback and injects only
synthetic data with a visible demo banner. It needs no account, credentials,
Base access, or external asset requests after dependencies are installed.
Set `DASHBOARD_PREVIEW_PORT` to change the port.

The build writes `dist/dashboard.html` and `dist/licenses.txt`. The HTML bundles
React, Ambient CSS, ECharts, CSS, and dependency license notices; compressed
JavaScript is decoded with the browser's `DecompressionStream`. The build fails
above 500,000 bytes. The production build contains placeholders, not demo data
or an embedded Magic SDK implementation. A normal browser without the host SDK
cannot read a real Base.

## Prepare a private HTML copy

Provision a dedicated display Base containing a record with text fields
`payload_24h` and `payload_7d`. Each field contains a JSON `dashboard-v1` DTO
written by the service. Obtain a Magic SDK initialization code scoped to that
**read-only display Base** and save it in a private local file outside Git.

From this directory, with your resource IDs supplied through local variables:

```sh
node bake-release.mjs \
  --base "$DISPLAY_BASE_TOKEN" \
  --table "$DISPLAY_TABLE_ID" \
  --record "$DISPLAY_RECORD_ID" \
  --init-code-file /absolute/private/path/magic-init-code \
  --out /absolute/private/path/dashboard.deploy.html
```

The baker checks the record through `lark-cli` on `PATH` before writing. Use
`--lark-cli /absolute/path/to/lark-cli` for another installation. `--input`
selects another built HTML file; it defaults to `dist/dashboard.html`.
`--no-verify` skips the read check for offline preparation and therefore cannot
confirm that the configured record exists. Baking does not publish the HTML.

Optionally add `--reopen-url 'https://example.com/your-dashboard'`. This URL is
shown only after an expired session. Only absolute HTTPS URLs without embedded
username/password credentials are accepted. Omit it to leave the recovery
link absent; retry remains available. The same validation applies at render
time to `window.__HEALTH_DASHBOARD_CONFIG__.reopenUrl`. This URL is visible to
readers, so use a non-secret destination without tokens in its query or fragment.

The baked HTML contains a capability that readers can extract. It must never
be committed or shared more broadly than the display data. The baker writes
mode `0600` and accepts only a canonical destination outside Git or explicitly
ignored by Git. Output symlinks and tracked files are rejected; an existing
output is replaced atomically without changing other links to its old contents.
Use a separate display Base with the
Miaobi app granted view-only access, never the private configuration/signature
Base. Keep Worker credentials and API keys on the server. Resource IDs and
init codes are configured locally; this directory does not load `.env` files.

## Data flow and behavior

```text
Apple Watch → Apple Health → HealthRelay or HAE
  → Worker / Durable Object → display DTO → read-only display Base
  → Magic SDK → HTML dashboard
```

- `src/client.mjs` reads both display windows in one Base request. It applies a
  15-second deadline, checks every two minutes while visible, retains marked
  cache on transient errors, and clears cached health data on known permission
  failures. An expired runtime gets one reinitialization attempt.
- `src/App.jsx`, `src/model.mjs`, and `src/charts.jsx` render the overview,
  pressure, heart/HRV, sleep, activity, workouts, and source notes. Missing data
  stays missing. Sleep and workouts use the weekly payload; monthly workouts
  require the additive `workoutHistory` field.
- `fixtures.mjs` and `preview.mjs` provide the offline demo. `build.mjs` and
  `boot.js` package and load the single HTML; `bake-release.mjs` supplies private
  resource configuration separately.

Tests cover data interpretation, rendered empty/error states, SDK lifecycle,
self-contained build size and licenses, safe reopen URLs, and private baking.
They use synthetic data and a synthetic CLI executable. Passing them does not
establish another account's access permissions or acceptance in a published
HTMLBox; verify those separately in your own deployment.
