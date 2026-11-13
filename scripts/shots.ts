/**
 * Shoots every console route against the live API and fails on any console
 * error or 5xx response. Dev-only tool: it needs the Vite server, on :5173
 * unless WEB_PORT says otherwise.
 */
import { mkdirSync } from "node:fs";
import puppeteer from "../../../project/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = new URL("../.shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BASE = `http://localhost:${process.env.WEB_PORT ?? "5173"}`;
// Dark is the console's default; THEME=light shoots the same routes inverted and
// names them so a comparison is a filename away.
const THEME = process.env.THEME === "light" ? "light" : "dark";
const SUFFIX = THEME === "dark" ? "" : "-light";

const ROUTES = [
  "/", "/projects", "/agents", "/connections", "/runs", "/usage", "/playground", "/billing", "/settings",
];

/**
 * Text a page shows while a query is still in flight. A screenshot taken on one
 * of these would report "no data" for a page that has data, so the pass waits
 * them out (and still shoots them if they never resolve — that is a real
 * failure worth seeing).
 */
const PLACEHOLDERS = [
  "Reading the last turns…",
  "Reading the provider catalog…",
];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 980 },
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const problems: string[] = [];
const page = await browser.newPage();

/**
 * Opens a detail page, clicks one tab and shoots it. The new tabs (capabilities,
 * knowledge, site, insights, sheets, embed) only render their content after the
 * click, so a shot of the landing tab would not see them at all.
 */
async function shootTab(path: string, label: string, name: string, width = 1440) {
  await page.setViewport({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 980 });
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 45_000 });
  await page.waitForFunction(() => !document.querySelector("main .animate-pulse"), { timeout: 10_000 }).catch(() => {});
  // The detail pages render their tab bar only after the query resolves, so a
  // click straight after navigation can miss a tab that appears a beat later.
  await page
    .waitForFunction(
      (wanted: string) =>
        Array.from(document.querySelectorAll("main button")).some((element) =>
          (element.textContent ?? "").trim().startsWith(wanted),
        ),
      { timeout: 15_000, polling: 200 },
      label,
    )
    .catch(() => {});
  const clicked = await page.evaluate((wanted: string) => {
    const button = Array.from(document.querySelectorAll("main button")).find((element) =>
      (element.textContent ?? "").trim().startsWith(wanted),
    ) as HTMLElement | undefined;
    if (!button) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) problems.push(`tab "${label}" missing on ${path}`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await page.screenshot({ path: `${OUT}${name}${SUFFIX}.png`, fullPage: true });
  console.log(`${name}: ${clicked ? "ok" : "missing tab"}`);
}
await page.evaluateOnNewDocument((theme: string) => localStorage.setItem("theme", theme), THEME);
// The console themes off a class, never the OS. Forcing the OS to ask for light
// means a THEME=dark run proves dark came from the class, not from
// prefers-color-scheme — the failure mode xyflow's own stylesheet falls into.
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
// The unknown-project route is a deliberate 404: Chrome logs the failed
// resource as a console error, and the script would otherwise report the very
// check it is there to prove.
let expectingNotFound = false;
page.on("console", (message) => {
  if (message.type() === "error" && !expectingNotFound) problems.push(`console: ${message.text()}`);
});
page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));

for (const route of ROUTES) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 45_000 });
  // A skeleton in the shot would misrepresent the page as empty; wait for the
  // queries to settle (a failure still screenshots its error state on timeout).
  await page.waitForFunction(() => !document.querySelector("main .animate-pulse"), { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(
    (keys: string[]) => !keys.some((key) => document.body.innerText.includes(key)),
    { timeout: 12_000, polling: 400 },
    PLACEHOLDERS,
  ).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  const name = route === "/" ? "overview" : route.slice(1);
  await page.screenshot({ path: `${OUT}${name}${SUFFIX}.png`, fullPage: true });
  const text = await page.$eval("main", (element) => element.textContent ?? "");
  console.log(`${name}: ${(text ?? "").replace(/\s+/g, " ").trim().slice(0, 110)}`);
}

const agentId = await page.evaluate(async () => {
  const response = await fetch("/api/agents");
  const rows = (await response.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? "";
});
if (agentId) {
  await page.goto(`${BASE}/agents/${agentId}`, { waitUntil: "networkidle2", timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: `${OUT}agent-detail${SUFFIX}.png`, fullPage: true });
  console.log("agent-detail: ok");

  // The Activity tab is the mount for this agent's persisted turns. Shooting it
  // after the click — not the default tab — is the only way to see the rows.
  const tabbed = await page.evaluate((label: string) => {
    const button = Array.from(document.querySelectorAll("main button"))
      .find((element) => (element.textContent ?? "").trim().startsWith(label)) as HTMLElement | undefined;
    if (!button) return false;
    button.click();
    return true;
  }, "Activity");
  if (!tabbed) problems.push("the agent detail page has no Activity tab");
  await new Promise((resolve) => setTimeout(resolve, 900));
  await page.screenshot({ path: `${OUT}agent-activity${SUFFIX}.png`, fullPage: true });
  console.log(`agent-activity: ${tabbed ? "ok" : "missing tab"}`);

  for (const label of ["Capabilities", "Knowledge", "Site", "Embed"]) {
    await shootTab(`/agents/${agentId}`, label, `agent-${label.toLowerCase()}`);
  }
}

// The run drawer, over a row the API actually returned. `verify-activity.ts`
// writes one, so an empty table here is a real failure rather than a blank shot.
await page.goto(`${BASE}/runs?tab=agent-runs`, { waitUntil: "networkidle2", timeout: 45_000 });
await page.waitForFunction(() => !document.querySelector("main .animate-pulse"), { timeout: 15_000 }).catch(() => {});
const rowOpened = await page.evaluate(() => {
  const row = document.querySelector("tbody tr[role=\"button\"]") as HTMLElement | undefined;
  if (!row) return false;
  row.click();
  return true;
});
if (!rowOpened) {
  problems.push("no persisted agent run row to open on /runs");
} else {
  await page
    .waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Agent run"]') !== null, { timeout: 15_000 })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 800));
  const drawerText = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="Agent run"]');
    return (panel?.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  if (!drawerText.includes("Tokens")) problems.push(`run drawer did not render its stats: ${drawerText.slice(0, 120)}`);
  await page.screenshot({ path: `${OUT}run-drawer${SUFFIX}.png` });
  console.log(`run-drawer: ${drawerText.slice(0, 90)}`);
  await page.keyboard.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// The first project the API returns is the tenant's own, so the detail page is
// shot with real counts rather than a hand-written id.
const projectId = await page.evaluate(async () => {
  const response = await fetch("/api/projects");
  const rows = (await response.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? "";
});
if (projectId) {
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2", timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: `${OUT}project-detail${SUFFIX}.png`, fullPage: true });
  console.log("project-detail: ok");

  for (const label of ["Insights", "Sheets"]) {
    await shootTab(`/projects/${projectId}`, label, `project-${label.toLowerCase()}`);
  }
}

// Responsive pass: the shell, the lists and the canvas at phone, tablet and
// desktop widths. Same pages, same data — the point is that nothing is clipped
// and no rail is pretending to fit.
if (projectId) {
  const workflows = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/projects/${id}/workflows`);
    return (await response.json()) as Array<{ id: string }>;
  }, projectId);
  const workflow = workflows[0];
  for (const [width, height, label] of [
    [390, 844, "390"],
    [768, 1024, "768"],
    [1440, 980, "1440"],
  ] as const) {
    await page.setViewport({ width, height });
    for (const [route, name] of [
      ["/", "overview"],
      ["/projects", "projects"],
      ["/runs", "runs"],
    ] as const) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 45_000 });
      await page.waitForFunction(() => !document.querySelector("main .animate-pulse"), { timeout: 10_000 }).catch(() => {});
      await page.waitForFunction(
        (keys: string[]) => !keys.some((key) => document.body.innerText.includes(key)),
        { timeout: 12_000, polling: 400 },
        PLACEHOLDERS,
      ).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      await page.screenshot({ path: `${OUT}responsive-${name}-${label}${SUFFIX}.png`, fullPage: true });
    }
    if (workflow) {
      await page.goto(`${BASE}/projects/${projectId}/workflows/${workflow.id}`, { waitUntil: "networkidle2", timeout: 45_000 });
      await page.waitForSelector(".react-flow", { timeout: 20_000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 900));
      await page.screenshot({ path: `${OUT}responsive-canvas-${label}${SUFFIX}.png` });
    }
    if (agentId) {
      for (const tab of ["Capabilities", "Knowledge", "Site", "Embed"]) {
        await shootTab(`/agents/${agentId}`, tab, `responsive-agent-${tab.toLowerCase()}-${label}`, width);
      }
    }
    for (const tab of ["Insights", "Sheets"]) {
      await shootTab(`/projects/${projectId}`, tab, `responsive-project-${tab.toLowerCase()}-${label}`, width);
    }
    console.log(`responsive ${label}: ok`);
  }
  await page.setViewport({ width: 1440, height: 980 });
}

// A project id from another tenant must render the API's own refusal, not a
// spinner and not somebody else's rows.
expectingNotFound = true;
await page.goto(`${BASE}/projects/prj_does_not_exist`, { waitUntil: "networkidle2", timeout: 45_000 });
await new Promise((resolve) => setTimeout(resolve, 700));
await page.screenshot({ path: `${OUT}project-missing${SUFFIX}.png`, fullPage: true });
const missingText = (await page.$eval("main", (element) => element.textContent ?? "")).replace(/\s+/g, " ");
expectingNotFound = false;
if (!missingText.includes("is not in this tenant")) {
  problems.push(`unknown project did not show the API refusal: ${missingText.slice(0, 160)}`);
}
console.log("project-missing: ok");

await browser.close();
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 20)) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`\nclean — shots in ${OUT}`);
