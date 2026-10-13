import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const here = dirname(fileURLToPath(import.meta.url));
export async function buildDashboard({ write = true } = {}) {
  const result = await build({
    absWorkingDir: here,
    entryPoints: ["src/main.jsx"],
    outfile: "dist/app.js",
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
    jsx: "automatic",
    loader: { ".svg": "dataurl" },
    target: ["es2022"],
    legalComments: "inline",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const css = result.outputFiles.find((f) => f.path.endsWith(".css")).text;
  const packed = gzipSync(js, { level: 9 }).toString("base64");
  const boot = readFileSync(join(here, "boot.js"), "utf8");
  const notices = [
    "react/LICENSE",
    "react-dom/LICENSE",
    "scheduler/LICENSE",
    "@ambientcss/css/LICENSE",
    "@ambientcss/components/LICENSE",
    "echarts/LICENSE",
    "echarts/NOTICE",
    "zrender/LICENSE",
    "tslib/LICENSE.txt",
  ]
    .map(
      (path) =>
        `\n===== ${path} =====\n${readFileSync(join(here, "node_modules", path), "utf8")}`,
    )
    .join("\n");
  let html = readFileSync(join(here, "dashboard.html"), "utf8");
  html = html
    .replace(
      "<!-- DASHBOARD_STYLES -->",
      () => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`,
    )
    .replace(
      "<!-- DASHBOARD_APP -->",
      () =>
        `<script id="dashboard-bundle" type="application/gzip">${packed}</script>\n<script>${boot}</script>\n<!-- Third-party licenses\n${notices.replace(/-->/g, "-- >")}\n-->`,
    );
  if (Buffer.byteLength(html) > 500_000) {
    throw new Error("Dashboard HTML exceeds the 500 kB publishing budget");
  }
  if (write) {
    mkdirSync(join(here, "dist"), { recursive: true });
    writeFileSync(join(here, "dist/dashboard.html"), html);
    writeFileSync(join(here, "dist/licenses.txt"), notices);
  }
  return { html, bytes: Buffer.byteLength(html) };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await buildDashboard();
  console.log(
    `Built dist/dashboard.html (${result.bytes.toLocaleString()} bytes, self-contained)`,
  );
}
