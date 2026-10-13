import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { buildDashboard } from "./build.mjs";
import { makeFixture } from "./fixtures.mjs";
const port = Number(process.env.DASHBOARD_PREVIEW_PORT ?? 8769);
await buildDashboard();
createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  if (req.url !== "/" && !req.url?.startsWith("/?")) {
    res.writeHead(404);
    return res.end();
  }
  const html = readFileSync(
    new URL("./dist/dashboard.html", import.meta.url),
    "utf8",
  );
  const now = Date.now(),
    fields = {
      payload_24h: JSON.stringify(makeFixture("24h", now)),
      payload_7d: JSON.stringify(makeFixture("7d", now)),
    };
  const fixture = JSON.stringify(fields).replace(/</g, "\\u003c");
  const demo = `<script>window.__HEALTH_DASHBOARD_DEMO__=true;window.magic={base_records_get:async()=>({code:0,data:{records:[{fields:${fixture}}]}}),updateHeight(){}};</script>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    html.replace('<!-- DASHBOARD_APP_PREVIEW -->', demo),
  );
}).listen(port, "127.0.0.1", () =>
  console.log(`Synthetic preview: http://127.0.0.1:${port}`),
);
