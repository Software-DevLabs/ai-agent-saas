/**
 * Bundle budget, measured on the real build output.
 *
 * The numbers are the two things a console user pays for on a cold load: the
 * JavaScript that must arrive before the first page paints (everything Vite
 * modulepreloads for the entry), and the chunk the workflow canvas pulls when
 * opened. A route nobody visited must not be in the first number — that is what
 * the lazy imports are for — so the initial set is read from `index.html`'s
 * `modulepreload` links rather than guessed from file names.
 *
 * Baseline at the start of the console overhaul (2026-10-30, light build,
 * `pnpm --filter @saas/web build`):
 *   initial  index 41.61 + react 53.36 + motion 41.39 + query 12.52 + icons 12.70 = 161.58 kB gz
 *   canvas   workflow-canvas 7.91 + xyflow 60.12 = 68.03 kB gz
 *
 * Run from the repo root after a build: `tsx scripts/bundle-budget.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = join(import.meta.dirname, "..", "apps", "web", "dist");
const INITIAL_BUDGET_GZ = 200 * 1024;
const CANVAS_BUDGET_GZ = 130 * 1024;
/** The widget a stranger's page loads is one file by contract — no shared chunks to amortise it. */
const EMBED_BUDGET_GZ = 40 * 1024;

const SIZE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const kb = (bytes: number) => `${SIZE.format(bytes / 1024)} kB`;

function gzipSize(file: string): number {
  return gzipSync(readFileSync(join(DIST, "assets", file))).byteLength;
}

const html = readFileSync(join(DIST, "index.html"), "utf8");
const initial = new Set<string>();
for (const match of html.matchAll(/<script type="module"[^>]*src="\/assets\/([^"]+)"/g)) initial.add(match[1]!);
for (const match of html.matchAll(/<link rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)) initial.add(match[1]!);

const chunks = readdirSync(join(DIST, "assets")).filter((name) => name.endsWith(".js"));
if (initial.size === 0 || chunks.length === 0) {
  console.error("no build output found — run `pnpm --filter @saas/web build` first");
  process.exit(1);
}

const rows = chunks
  .map((name) => ({ name, gz: gzipSize(name), initial: initial.has(name) }))
  .sort((a, b) => a.gz - b.gz);

for (const row of rows) {
  console.log(`${row.initial ? "initial " : "lazy    "} ${row.name.padEnd(40)} ${kb(row.gz).padStart(10)} gz`);
}

const initialGz = rows.filter((row) => row.initial).reduce((sum, row) => sum + row.gz, 0);
const canvasChunks = rows.filter((row) => /^workflow-canvas-.+\.js$/.test(row.name));
const canvasGz = canvasChunks.reduce((sum, row) => sum + row.gz, 0) + (rows.find((row) => /^xyflow-.+\.js$/.test(row.name))?.gz ?? 0);

// The widget bundle lives outside `assets/` because its own build owns that
// directory. Read through the manifest, which is what the API's snippet uses.
let embedGz: number | null = null;
try {
  const manifest = JSON.parse(readFileSync(join(DIST, "embed", "manifest.json"), "utf8")) as { file: string };
  embedGz = gzipSync(readFileSync(join(DIST, "embed", manifest.file))).byteLength;
} catch {
  embedGz = null;
}

console.log("");
console.log(`initial load: ${kb(initialGz)} / ${kb(INITIAL_BUDGET_GZ)} gz`);
console.log(`canvas:       ${kb(canvasGz)} / ${kb(CANVAS_BUDGET_GZ)} gz`);
console.log(`embed widget: ${embedGz === null ? "missing" : kb(embedGz)} / ${kb(EMBED_BUDGET_GZ)} gz`);

let failed = false;
if (initialGz > INITIAL_BUDGET_GZ) {
  console.error(`budget: initial load exceeds by ${kb(initialGz - INITIAL_BUDGET_GZ)} gz`);
  failed = true;
}
if (canvasChunks.length === 0) {
  console.error("budget: no workflow-canvas chunk in the build — the canvas is no longer split");
  failed = true;
} else if (canvasGz > CANVAS_BUDGET_GZ) {
  console.error(`budget: canvas exceeds by ${kb(canvasGz - CANVAS_BUDGET_GZ)} gz`);
  failed = true;
}
if (embedGz === null) {
  console.error("budget: no embed widget bundle — run `pnpm --filter @saas/web build:embed`");
  failed = true;
} else if (embedGz > EMBED_BUDGET_GZ) {
  console.error(`budget: embed widget exceeds by ${kb(embedGz - EMBED_BUDGET_GZ)} gz`);
  failed = true;
}
process.exit(failed ? 1 : 0);
