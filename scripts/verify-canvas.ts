/**
 * Phase C, driven through the real console against the real API and the real
 * database.
 *
 * Nothing here is a stub. The workflow row, its version, its node positions and
 * its validation report are read back from `GET /workflows/:id` after the browser
 * saved them; the cables are drawn with mouse events over React Flow's own
 * handles; the activation refusal is the server's own sentence. Anything the
 * board cannot do yet has to say so on screen, and this script fails if it finds
 * a claim it cannot back up.
 *
 * Usage: `pnpm dev:api` and `pnpm dev:web` running, then
 * `WEB_PORT=5177 pnpm exec tsx scripts/verify-canvas.ts`, and once with
 * `THEME=dark` — shot with the OS asking for light, which is the combination
 * React Flow's own stylesheet gets wrong.
 *
 * It creates two connections in the default project if the tenant has none, and
 * leaves them behind: there is no `DELETE /integrations/:id`, so removing them
 * would mean writing to the database from a browser script, which is the one
 * thing this repo does not do.
 */
/// <reference lib="dom" />
import { mkdirSync } from "node:fs";
import puppeteer from "../../../project/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT = new URL("../.shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WEB = `http://localhost:${process.env.WEB_PORT ?? "5173"}`;
const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const SUFFIX = THEME === "dark" ? "-dark" : "";
const NAME = "Canvas check";

interface Point {
  x: number;
  y: number;
}

interface Stored {
  id: string;
  version: number;
  status: string;
  definition: {
    nodes: Array<{ key: string; kind: string; position: Point; config: Record<string, string> }>;
    edges: Array<{ id: string; from: string; to: string }>;
  };
  dependencies: Array<{ kind: string; refId: string; name: string | null }>;
}

const problems: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 980 },
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
await page.evaluateOnNewDocument((theme: string) => localStorage.setItem("theme", theme), THEME);
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
page.on("console", (message) => {
  // The page deliberately provokes a 409 (activation with no worker, and the
  // stale-version probe) and Chrome logs every 4xx fetch. Those are the refusals
  // this run asserts on, not failures.
  if (message.type() === "error" && !/Failed to load resource.*409/.test(message.text())) {
    problems.push(`console: ${message.text()}`);
  }
});
page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));

/** Clicks the first button whose text starts with `label`. */
async function clickText(label: string): Promise<boolean> {
  return page.evaluate((wanted: string) => {
    const hit = (Array.from(document.querySelectorAll("button")) as HTMLElement[]).find((element) =>
      (element.textContent ?? "").trim().startsWith(wanted),
    );
    if (!hit) return false;
    hit.click();
    return true;
  }, label);
}

const bodyText = () => page.evaluate(() => document.body.innerText);

async function waitForText(needle: string, timeout = 15_000): Promise<boolean> {
  try {
    await page.waitForFunction((wanted: string) => document.body.innerText.includes(wanted), { timeout }, needle);
    return true;
  } catch {
    return false;
  }
}

const count = (selector: string) => page.evaluate((css: string) => document.querySelectorAll(css).length, selector);

/**
 * The palette's rail headings carry Tailwind's `uppercase`, and `innerText`
 * applies that transform while `textContent` does not — so the rail names are
 * read from the DOM here rather than matched against the body's rendered text.
 */
const railTitles = () =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll("section h3"))
        .map((element) => (element.textContent ?? "").trim())
        .filter((text) => text.length > 0),
  );

/**
 * The board's own fit-view control, clicked through the DOM rather than the
 * mouse: pressing on the board anywhere else would pan it. Clicking a validation
 * issue zooms the board onto one box, and every gesture below needs the socket
 * to be the thing Chrome would hit there.
 */
async function fitAll(): Promise<void> {
  await page.evaluate(() => {
    const button = document.querySelector("[data-canvas='fit']");
    if (button) (button as HTMLElement).click();
  });
  await wait(700);
}

/**
 * Autosave is debounced, so the script waits for the toolbar to stop reporting
 * unsaved changes rather than guessing at a duration. It returns false when the
 * canvas never settled, which the version check right after it then reports.
 */
async function waitForSettled(timeout = 20_000): Promise<boolean> {
  try {
    await page.waitForFunction(() => !document.body.innerText.includes("unsaved changes"), { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * The toolbar going quiet is not proof the server holds the graph: two cables can
 * queue two saves, and the first one reports "saved" with only its own edge in
 * it. This polls the stored document until it says what the canvas should now
 * say, and returns the last thing the server actually answered with — so a
 * failure below names the document as it really is, not an assumed one.
 */
async function awaitStored(edges: number, afterVersion: number, timeout = 25_000): Promise<Stored> {
  let last = (await api<Stored>(`/workflows/${workflowId}`)).body;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !(last.definition.edges.length >= edges && last.version > afterVersion)) {
    await wait(500);
    last = (await api<Stored>(`/workflows/${workflowId}`)).body;
  }
  return last;
}

/**
 * An ACTIVE row refuses deletion by design, which would otherwise strand the
 * leftover of an interrupted run on the inbound channel forever: the next run
 * could neither delete it nor activate its own graph.
 */
async function removeWorkflow(id: string): Promise<number> {
  await api(`/workflows/${id}/status`, { method: "PATCH", body: { status: "PAUSED" } });
  return (await api<unknown>(`/workflows/${id}`, { method: "DELETE" })).status;
}

/**
 * A point, and what Chrome says is actually on top of it. A press only reaches a
 * socket when nothing covers it, and the board has three things that can — the
 * minimap, the controls and the box's own label — so this reports the real
 * recipient instead of guessing from the socket's own rectangle. Boxes are
 * addressed by position in the array, which is the order the palette added them
 * and the order the saved document lists them, so `0` here and `in-1` in the
 * database are the same box.
 */
interface Hit {
  x: number;
  y: number;
  /** True when the element on top is the one the gesture was aimed at. */
  clear: boolean;
  top: string;
}

/** Press, travel in steps, release. Chrome's own input pipeline, not a synthetic event. */
async function glide(from: Point, to: Point, steps: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
    await wait(14);
  }
  await page.mouse.up();
  await wait(150);
}

/**
 * The centre of one box's socket, and what Chrome says is on top there. Cables
 * leave a box's bottom edge and land on the next box's top edge. The sockets are
 * invisible until the box is hovered, but opacity does not affect hit testing, so
 * the point below still names the handle Chrome would press.
 */
async function socketPoint(index: number, side: "top" | "bottom"): Promise<Hit | null> {
  return page.evaluate((slot: number, cls: string) => {
    const node = (Array.from(document.querySelectorAll(".react-flow__node")) as HTMLElement[])[slot];
    const handle = node?.querySelector(cls) as HTMLElement | undefined;
    if (!handle) return null;
    const rect = handle.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      clear: top === handle || handle.contains(top),
      top: top === null ? "nothing" : `${top.tagName}.${typeof top.className === "string" ? top.className : ""}`.slice(0, 60),
    };
  }, index, `.react-flow__handle-${side}`);
}

/** The middle of a box's body — the spot a node drag must press on. */
async function bodyPoint(index: number): Promise<Hit | null> {
  return page.evaluate((slot: number) => {
    const node = (Array.from(document.querySelectorAll(".react-flow__node")) as HTMLElement[])[slot];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      clear: top !== null && node.contains(top) && top.closest("button") === null,
      top: top === null ? "nothing" : `${top.tagName}.${typeof top.className === "string" ? top.className : ""}`.slice(0, 60),
    };
  }, index);
}

/**
 * A drag target that stays inside the board. A release outside it is a selection
 * rectangle rather than a move, so the version check would report a failure that
 * is really the script pushing the box off the canvas.
 */
async function dragSlot(index: number, dx: number, dy: number): Promise<{ from: Point; to: Point } | null> {
  return page.evaluate((slot: number, x: number, y: number) => {
    const node = (Array.from(document.querySelectorAll(".react-flow__node")) as HTMLElement[])[slot];
    const board = document.querySelector(".react-flow");
    if (!node || !board) return null;
    const box = node.getBoundingClientRect();
    const area = board.getBoundingClientRect();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const to = { x: from.x + x, y: from.y + y };
    if (to.x < area.left + 8 || to.x > area.right - 8 || to.y < area.top + 8 || to.y > area.bottom - 8) return null;
    return { from, to };
  }, index, dx, dy);
}

/** Press on a source socket, travel to a target socket, release: a cable. */
async function connect(source: number, target: number, edges: number): Promise<boolean> {
  await fitAll();
  const from = await socketPoint(source, "bottom");
  const to = await socketPoint(target, "top");
  if (!from || !to) {
    console.log(`  cable ${source}->${target}: no socket on that box`);
    return false;
  }
  if (!from.clear || !to.clear) {
    console.log(`  cable ${source}->${target}: covered — press lands on ${from.top}, release on ${to.top}`);
    return false;
  }
  await glide({ x: from.x, y: from.y }, { x: to.x, y: to.y }, 20);
  try {
    await page.waitForFunction(
      (wanted: number) => document.querySelectorAll(".react-flow__edge").length === wanted,
      { timeout: 8_000 },
      edges,
    );
    return true;
  } catch {
    console.log(`  cable ${source}->${target}: the drag reached nothing (edges ${await count(".react-flow__edge")})`);
    return false;
  }
}

let workflowId = "";
try {
  const projects = await api<Array<{ id: string; name: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  // A connection is only ever created into the default project, so the canvas has
  // to be that project's or the channel rails would honestly be empty.
  const channels = await api<Array<{ id: string; type: string }>>("/integrations");
  for (const entry of [
    { type: "TELEGRAM_IN", credentials: "canvas-check-token", externalId: "canvas-bot" },
    { type: "WEBHOOK_OUT", credentials: "https://example.invalid/hook", externalId: "canvas-sink" },
  ]) {
    if (channels.body.some((row) => row.type === entry.type)) continue;
    const created = await api<{ id: string }>("/integrations", { method: "POST", body: entry });
    if (created.status !== 201) throw new Error(`could not create ${entry.type}: ${JSON.stringify(created.body)}`);
    console.log(`setup: created ${entry.type} ${created.body.id}`);
  }

  // Re-running must not collide with the leftovers of the last one.
  const listed = await api<Array<{ id: string; name: string }>>(`/projects/${project.id}/workflows`);
  for (const row of listed.body.filter((entry) => entry.name === NAME)) {
    await removeWorkflow(row.id);
  }
  const agents = await api<Array<{ id: string; name: string }>>(`/projects/${project.id}/agents`);
  check("the project has an agent to wire up", agents.body.length >= 1, `${agents.body.length} agent(s)`);

  // ---- the row is created through the console, then drawn on ----
  await page.goto(`${WEB}/projects/${project.id}`, { waitUntil: "networkidle2", timeout: 45_000 });
  // The tab strip renders before React has attached its handlers on a slow first
  // paint, so a single click can land on a dead element; keep pressing until the
  // tab reports itself selected.
  await page.waitForFunction(
    () => {
      const tab = (Array.from(document.querySelectorAll('[role="tab"]')) as HTMLElement[]).find((element) =>
        (element.textContent ?? "").trim().startsWith("Workflows"),
      );
      if (!tab) return false;
      if (tab.getAttribute("aria-selected") === "true") return true;
      tab.click();
      return false;
    },
    { timeout: 20_000, polling: 400 },
  );
  await wait(800);
  await page.screenshot({ path: `${OUT}project-workflows${SUFFIX}.png`, fullPage: true });
  check("the workflows tab offers a way in", await clickText("New workflow"));

  await page.waitForSelector("#workflow-name", { timeout: 10_000 });
  await page.type("#workflow-name", NAME);
  await clickText("Create and open");
  await page.waitForSelector(".react-flow", { timeout: 25_000 });
  await wait(1_200);
  const path = new URL(page.url()).pathname;
  workflowId = path.split("/").pop() ?? "";
  const opened = await api<{ id: string; name: string }>(`/workflows/${workflowId}`);
  check(
    "creating one opened that workflow's canvas",
    path === `/projects/${project.id}/workflows/${workflowId}` && opened.status === 200 && opened.body.id === workflowId,
    `${path} -> ${opened.status} ${opened.body?.name ?? ""}`,
  );

  const blank = await bodyText();
  check("the toolbar reports the worker from its heartbeat, not a guess",
    blank.includes("no worker — nothing would run") || blank.includes("worker alive"),
    blank.includes("no worker — nothing would run") ? "no worker" : "worker alive");
  const rails = await railTitles();
  check(
    "all three rails are named",
    rails.includes("Channels in") && rails.includes("Agents") && rails.includes("Channels out"),
    rails.join(" / "),
  );
  check("an empty board is described, not faked", blank.includes("Drag a channel in"));
  check("the board carries its own zoom panel", (await count("[data-canvas=fit]")) === 1);
  await page.screenshot({ path: `${OUT}workflow-canvas-empty${SUFFIX}.png`, fullPage: true });

  // The plus button in each rail, in rail order: a channel in, an agent, a channel
  // out. This is the keyboard route, so the drag is not the only way to draw.
  const added = await page.evaluate(() => {
    const rails = ["Channels in", "Agents", "Channels out"];
    let clicks = 0;
    for (const section of Array.from(document.querySelectorAll("section")) as HTMLElement[]) {
      const title = (section.querySelector("h3")?.textContent ?? "").trim();
      if (!rails.includes(title)) continue;
      const button = section.querySelector("button[aria-label^='Add ']") as HTMLElement | null;
      if (button) {
        button.click();
        clicks += 1;
      }
    }
    return clicks;
  });
  check("each rail added one box", added === 3, `${added} clicks`);
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 3, { timeout: 10_000 });
  await waitForText("unsaved changes");
  check("the canvas settled after the add", await waitForSettled());

  const drawn = await api<Stored>(`/workflows/${workflowId}`);
  check("the three boxes were saved", drawn.body.definition.nodes.length === 3, `v${drawn.body.version}`);
  check(
    "the keys are the readable ones a report can quote",
    drawn.body.definition.nodes.map((node) => node.key).join(",") === "in-1,agent-1,out-1",
    drawn.body.definition.nodes.map((node) => node.key).join(","),
  );
  // Every reference the boxes hold must be a row this project actually owns, in
  // the direction that row's own type declares. That is the plan's central rule
  // — a canvas can only wire up what its project has — checked against the API
  // rather than against what the browser was given to click.
  const projectChannels = await api<Array<{ id: string; type: string }>>(`/projects/${project.id}/integrations`);
  const owned = (key: string, prefix: "_IN" | "_OUT") => {
    const refId = drawn.body.definition.nodes.find((node) => node.key === key)?.config.integrationId ?? "";
    return projectChannels.body.find((row) => row.id === refId && row.type.endsWith(prefix))?.type ?? "";
  };
  const wiredAgent = drawn.body.definition.nodes.find((node) => node.key === "agent-1")?.config.agentId ?? "";
  check(
    "each box holds a row this project owns",
    owned("in-1", "_IN") !== "" && owned("out-1", "_OUT") !== "" && agents.body.some((row) => row.id === wiredAgent),
    `in=${owned("in-1", "_IN")} agent=${wiredAgent ? "mine" : "none"} out=${owned("out-1", "_OUT")}`,
  );
  check("nothing is wired yet", drawn.body.definition.edges.length === 0);

  // ---- an unfinished graph must be reported as unfinished ----
  await clickText("Validate");
  await waitForText("entry_unreachable");
  const report = await bodyText();
  check("it names the channel that reaches nothing", report.includes("entry_unreachable"));
  check("it names the agent with no sink", report.includes("agent_no_sink"));
  check("it names the boxes with no cables", report.includes("orphan_node"));

  const picked = await page.evaluate((wanted: string) => {
    const row = (Array.from(document.querySelectorAll("button")) as HTMLButtonElement[]).find((element) =>
      (element.textContent ?? "").includes(wanted),
    );
    if (!row || row.disabled) return false;
    row.click();
    return true;
  }, "agent_no_sink");
  check("an issue row is clickable", picked);
  await wait(900);
  const rail = await page.evaluate(() => {
    const select = document.querySelector("#node-ref") as HTMLSelectElement | null;
    return select ? { value: select.value, showsKey: document.body.innerText.includes("agent-1") } : null;
  });
  check("clicking it opened that box in the inspector", rail !== null && rail.showsKey);
  check(
    "the inspector shows the reference the graph holds",
    rail !== null && rail.value === (drawn.body.definition.nodes.find((node) => node.key === "agent-1")?.config.agentId ?? ""),
    rail?.value ?? "no select",
  );
  await page.screenshot({ path: `${OUT}workflow-canvas-issues${SUFFIX}.png`, fullPage: true });

  // ---- cables, drawn with the mouse over React Flow's own sockets ----
  check("the first cable was drawn", await connect(0, 1, 1));
  check("the second cable was drawn", await connect(1, 2, 2));

  check("the canvas settled after the cables", await waitForSettled());
  const saved = await awaitStored(2, drawn.body.version);
  check("the save bumped the version", saved.version > drawn.body.version, `v${drawn.body.version} -> v${saved.version}`);
  check("the toolbar agrees with the server", (await bodyText()).includes(`v${saved.version} ·`));
  check(
    "both cables landed in the document",
    saved.definition.edges.map((edge) => `${edge.from}->${edge.to}`).join(",") === "in-1->agent-1,agent-1->out-1",
    JSON.stringify(saved.definition.edges.map((edge) => `${edge.from}->${edge.to}`)),
  );
  check(
    "the reference index names all three rows",
    saved.dependencies.length === 3 && saved.dependencies.every((row) => Boolean(row.name)),
    saved.dependencies.map((row) => `${row.refId}=${row.name ?? "null"}`).join(" "),
  );

  // ---- dragging a box is a saved position, not a screen-only move ----
  await fitAll();
  const before = saved.definition.nodes.find((node) => node.key === "out-1")?.position;
  const grip = await bodyPoint(2);
  const slot = await dragSlot(2, -60, 120);
  if (grip && !grip.clear) console.log(`  drag: the box's own centre is covered by ${grip.top}`);
  if (grip?.clear && slot) await glide({ x: grip.x, y: grip.y }, slot.to, 14);
  check("the board had a clear spot to press on", Boolean(grip?.clear && slot), grip?.top ?? "no box");
  check("the canvas settled after the drag", await waitForSettled());
  const dragged = await api<Stored>(`/workflows/${workflowId}`);
  const after = dragged.body.definition.nodes.find((node) => node.key === "out-1")?.position;
  check(
    "dragging a box moved it, and the move was saved",
    Boolean(before && after && after.y > before.y && dragged.body.version > saved.version),
    `y ${before?.y ?? "?"} -> ${after?.y ?? "?"} at v${dragged.body.version}`,
  );
  check("the cables survived the drag", dragged.body.definition.edges.length === 2);

  // ---- the finished graph must now read clean ----
  await clickText("Validate");
  await waitForText("No issues.");
  const clean = await bodyText();
  check("it passes every rule", clean.includes("No issues. Every rule the server checks passes."));
  check("and it states the order it would run in", clean.includes("runs in-1"), clean.match(/runs [^\n]*/)?.[0] ?? "no order line");
  await page.screenshot({ path: `${OUT}workflow-canvas-valid${SUFFIX}.png`, fullPage: true });

  // ---- activation tells the truth about the worker either way ----
  // The gate is the worker's own heartbeat, so this check has two honest
  // outcomes: accepted while one is alive, refused in the server's words when
  // none is. Which one is correct is read from the API, not assumed.
  const workerNow = await api<{ alive: boolean; workerId: string | null }>("/worker");
  await clickText("Activate");
  if (workerNow.body.alive) {
    check("activation is accepted while a worker is alive", await waitForText("Pause"));
  } else {
    check("activation is refused, not faked", await waitForText("no worker has checked in within"));
  }
  const status = await api<{ status: string }>(`/workflows/${workflowId}`);
  check(
    workerNow.body.alive ? "the row became ACTIVE" : "the row stayed a draft",
    status.body.status === (workerNow.body.alive ? "ACTIVE" : "DRAFT"),
    status.body.status,
  );
  if (!workerNow.body.alive) {
    check("the refusal on screen is the server's own sentence", (await bodyText()).includes("Start one with pnpm dev:worker"));
  }

  // ---- a stale canvas is refused by the compare-and-swap ----
  // The body is the graph it already holds, not an empty one: this probe exists
  // to prove a refusal, and if the guard ever regressed an empty document would
  // quietly wipe the drawing the checks below still read.
  const stale = await api<{ error: string; message: string }>(`/workflows/${workflowId}/graph`, {
    method: "PATCH",
    body: { expectedVersion: 1, definition: dragged.body.definition },
  });
  check("a write claiming version 1 gets 409", stale.status === 409 && stale.body.error === "graph_version", `${stale.status} ${stale.body.error}`);
  check("the refusal names the version to reload", stale.body.message.includes(`version ${dragged.body.version}`), stale.body.message);
  const untouched = await api<Stored>(`/workflows/${workflowId}`);
  check(
    "the refused write changed nothing",
    untouched.body.definition.edges.length === 2 && untouched.body.version === dragged.body.version,
    `${untouched.body.definition.edges.length} edge(s) at v${untouched.body.version}`,
  );

  // ---- and the drawing is in the database, not in React state ----
  await page.goto(`${WEB}/projects`, { waitUntil: "networkidle2", timeout: 45_000 });
  await page.goto(`${WEB}/projects/${project.id}/workflows/${workflowId}`, { waitUntil: "networkidle2", timeout: 45_000 });
  await page.waitForSelector(".react-flow__edge", { timeout: 20_000 });
  await wait(1_200);
  check("reopening restored three boxes", (await count(".react-flow__node")) === 3);
  check("reopening restored both cables", (await count(".react-flow__edge")) === 2);
  const named = agents.body.find((row) => row.id === wiredAgent)?.name ?? "";
  check(
    "the restored board names the row it points at",
    named !== "" && (await bodyText()).includes(named),
    named || "the graph references an agent this project no longer has",
  );
  await page.screenshot({ path: `${OUT}workflow-canvas${SUFFIX}.png`, fullPage: true });

  // ---- the same board at phone width: both rails are sheets ----
  await page.setViewport({ width: 390, height: 844 });
  await wait(700);
  const phone = await bodyText();
  check("the phone layout offers its palette", phone.includes("Add node"));
  check("the phone layout hides the rails behind sheets", !phone.includes("Add to canvas"));
  await page.screenshot({ path: `${OUT}workflow-canvas-mobile${SUFFIX}.png` });
  if (await clickText("Add node")) {
    await wait(900);
    // Section headings are uppercased by CSS, so read their textContent — the
    // same way the desktop rails are read — instead of matching rendered case.
    const sheetRails = await railTitles();
    check(
      "the palette sheet lists every rail",
      sheetRails.includes("Channels in") && sheetRails.includes("Agents") && sheetRails.includes("Channels out"),
      sheetRails.join(" / "),
    );
    await page.screenshot({ path: `${OUT}workflow-canvas-mobile-palette${SUFFIX}.png` });
  } else {
    check("the palette sheet lists every rail", false, "Add node was not on screen");
  }

  // ---- an orchestrator box must round-trip through the same canvas ----
  // The server is the judge; this only proves the drawing, the serializer and the
  // inspector agree with the kind it accepts.
  await page.setViewport({ width: 1440, height: 980 });
  const otherAgent = agents.body.find((row) => row.id !== wiredAgent);
  const inboundRef = drawn.body.definition.nodes.find((node) => node.key === "in-1")?.config.integrationId ?? "";
  const outboundRef = drawn.body.definition.nodes.find((node) => node.key === "out-1")?.config.integrationId ?? "";
  if (otherAgent) {
    const current = await api<Stored>(`/workflows/${workflowId}`);
    const orchGraph = {
      nodes: [
        { key: "in-1", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: inboundRef } },
        {
          key: "orch-1",
          kind: "ORCHESTRATOR",
          position: { x: 260, y: 0 },
          config: { agentId: wiredAgent, subagents: [{ agentId: otherAgent.id, role: "writer" }] },
        },
        { key: "out-1", kind: "OUTBOUND", position: { x: 520, y: 0 }, config: { integrationId: outboundRef } },
      ],
      edges: [
        { from: "in-1", to: "orch-1" },
        { from: "orch-1", to: "out-1" },
      ],
    };
    const orchSaved = await api<Stored>(`/workflows/${workflowId}/graph`, {
      method: "PATCH",
      body: { expectedVersion: current.body.version, definition: orchGraph },
    });
    check(
      "the server accepts a graph with an orchestrator box",
      orchSaved.status === 200 && orchSaved.body.definition.nodes.some((node) => node.kind === "ORCHESTRATOR"),
      `v${orchSaved.body.version}`,
    );
    await page.goto(`${WEB}/projects/${project.id}/workflows/${workflowId}`, { waitUntil: "networkidle2", timeout: 45_000 });
    const drawnOrch = await waitForText("1 subagent");
    const orchText = await bodyText();
    // The kind badge is uppercased by CSS; the subagent count line is the proof
    // that this is a real orchestrator and not an agent box with a new icon.
    check("the canvas draws it with its declared subagent count", drawnOrch && /orchestrator/i.test(orchText));
    const box = await page.evaluate(() => {
      const node = (Array.from(document.querySelectorAll(".react-flow__node")) as HTMLElement[]).find((element) =>
        (element.textContent ?? "").includes("1 subagent"),
      );
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + 24 };
    });
    if (box) await page.mouse.click(box.x, box.y);
    check("the inspector offers the subagent editor", await waitForText("The model sees each role as one delegation"));
    await page.screenshot({ path: `${OUT}workflow-canvas-orchestrator${SUFFIX}.png`, fullPage: true });
  } else {
    check("the project has a second agent to delegate to", false, "only one agent");
  }
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  if (workflowId) {
    console.log(`cleanup: remove /workflows/${workflowId} -> ${await removeWorkflow(workflowId)}`);
  }
  await browser.close();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 20)) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`\nclean — shots in ${OUT}`);
