import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

/**
 * Sheets over HTTP against a fake that behaves like the two tables it reads.
 *
 * The invariants are the ones a rendered table can hide: the list is one project's
 * and nothing else's, the rows come back in the stored order, and the `rowCount` the
 * console prints is the number of rows the detail actually returned. A JSON column
 * is narrowed to primitives, so a hand-edited row can never render "[object Object]".
 */

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

type Row = Record<string, unknown>;

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  const clause = where as Record<string, unknown>;
  return Object.entries(clause).every(([key, value]) => {
    if (key === "AND") return (value as unknown[]).every((entry) => matches(row, entry));
    if (key === "OR") return (value as unknown[]).some((entry) => matches(row, entry));
    if (value !== null && typeof value === "object" && "in" in value) {
      return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

function fakeDb(seed: { sheets?: Row[]; rows?: Row[]; projects?: Row[] } = {}) {
  const projects = seed.projects ?? [{ id: "prj_one", tenantId: "tnt_one", name: "Shop", isDefault: true }];
  const sheets = seed.sheets ?? [];
  const rows = seed.rows ?? [];

  const selected = (sheet: Row) => ({
    id: sheet.id,
    projectId: sheet.projectId,
    agentId: sheet.agentId,
    title: sheet.title,
    columns: sheet.columns,
    rowCount: sheet.rowCount,
    createdAt: sheet.createdAt,
    exportedAt: sheet.exportedAt ?? null,
    externalSpreadsheetId: sheet.externalSpreadsheetId ?? null,
    externalSheetName: sheet.externalSheetName ?? null,
    externalUrl: sheet.externalUrl ?? null,
    exportError: sheet.exportError ?? null,
    agent: { name: sheet.agentName },
  });

  const db = {
    project: {
      findFirst: async ({ where }: { where: unknown }) => projects.find((entry) => matches(entry, where)) ?? null,
    },
    sheet: {
      findMany: async ({ where, take }: { where: unknown; take?: number }) =>
        sheets
          .filter((entry) => matches(entry, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .slice(0, take ?? sheets.length)
          .map(selected),
      findFirst: async ({ where }: { where: unknown }) => {
        const sheet = sheets.find((entry) => matches(entry, where));
        return sheet === undefined ? null : selected(sheet);
      },
    },
    sheetRow: {
      findMany: async ({ where, take }: { where: { sheetId: string }; take?: number }) =>
        rows
          .filter((entry) => entry.sheetId === where.sheetId)
          .sort((a, b) => (a.rowIndex as number) - (b.rowIndex as number))
          .slice(0, take ?? rows.length)
          .map((entry) => ({ rowIndex: entry.rowIndex, cells: entry.cells })),
    },
  };
  return db as unknown as PrismaClient;
}

function appWith(db: PrismaClient) {
  const routes: RouteDeps = {
    db,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue: {
      enqueue: async () => ({ id: "job_1", duplicate: false }),
      claim: async () => null,
      heartbeat: async () => true,
      attachRun: async () => {},
      succeed: async () => {},
      retry: async () => {},
      dead: async () => {},
      release: async () => {},
      counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
    },
    workerStaleMs: 30_000,
  };
  return createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 11, minute));

const sheetRow = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: "tnt_one",
  projectId: "prj_one",
  agentId: "agt_1",
  agentName: "Support agent",
  title: `Sheet ${id}`,
  columns: ["Name", "Qty"],
  rowCount: 0,
  createdAt: at(0),
  ...over,
});

const cellRow = (sheetId: string, rowIndex: number, cells: unknown[]): Row => ({ sheetId, rowIndex, cells });

describe("project sheets", () => {
  it("lists only this project's sheets, newest first, with the agent that made each", async () => {
    const db = fakeDb({
      sheets: [
        sheetRow("sht_1", { createdAt: at(1), rowCount: 2 }),
        sheetRow("sht_2", { title: "Billing summary", agentName: "Billing agent", createdAt: at(3), rowCount: 7 }),
        sheetRow("sht_other", { projectId: "prj_other", createdAt: at(4) }),
      ],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/projects/prj_one/sheets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sheets.map((sheet: { id: string }) => sheet.id)).toEqual(["sht_2", "sht_1"]);
    expect(body.sheets[0]).toMatchObject({ title: "Billing summary", agentName: "Billing agent", rowCount: 7 });
    expect(body.sheets[1]).toMatchObject({ columns: ["Name", "Qty"], agentName: "Support agent" });
    await app.close();
  });

  it("is an empty list — not an error — for a project with no sheets", async () => {
    const app = appWith(fakeDb({ sheets: [] }));
    const res = await app.inject({ method: "GET", url: "/projects/prj_one/sheets" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sheets: [] });
    await app.close();
  });

  it("refuses a project that is not in this tenant", async () => {
    const app = appWith(fakeDb());
    const res = await app.inject({ method: "GET", url: "/projects/prj_foreign/sheets" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    await app.close();
  });
});

describe("one sheet", () => {
  it("returns the rows in stored order, and the row count equals the rows returned", async () => {
    const db = fakeDb({
      sheets: [sheetRow("sht_1", { columns: ["Name", "Qty", "Notes"], rowCount: 3 })],
      rows: [
        cellRow("sht_1", 2, ["C", 3, "third"]),
        cellRow("sht_1", 0, ["A", 1, null]),
        cellRow("sht_1", 1, ["B", 2, true]),
        cellRow("sht_other", 0, ["not mine"]),
      ],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/sheets/sht_1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: "sht_1", title: "Sheet sht_1", agentName: "Support agent" });
    expect(body.rows.map((row: { rowIndex: number }) => row.rowIndex)).toEqual([0, 1, 2]);
    expect(body.rows[1].cells).toEqual(["B", 2, true]);
    // The accepted property: the number on the sheet is the number of rows read.
    expect(body.rowCount).toBe(3);
    expect(body.rowCount).toBe(body.rows.length);
    await app.close();
  });

  it("renders a cell that is not a JSON primitive as empty rather than inventing text", async () => {
    const db = fakeDb({
      sheets: [sheetRow("sht_1", { rowCount: 1 })],
      rows: [cellRow("sht_1", 0, ["A", { nested: true }, false, null, 2])],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/sheets/sht_1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].cells).toEqual(["A", null, false, null, 2]);
    await app.close();
  });

  it("refuses a sheet that is not in this tenant", async () => {
    const app = appWith(fakeDb({ sheets: [sheetRow("sht_1")] }));
    const res = await app.inject({ method: "GET", url: "/sheets/sht_foreign" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("sheet_not_found");
    await app.close();
  });

  it("reports the last Google Sheets outcome it stored, and nulls when none was attempted", async () => {
    const db = fakeDb({
      sheets: [
        sheetRow("sht_1", {
          exportedAt: new Date("2026-10-31T12:00:00.000Z"),
          externalSpreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
          externalSheetName: "Sheet1",
          externalUrl: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
          exportError: null,
        }),
      ],
      rows: [cellRow("sht_1", 0, ["A", 1])],
    });
    const app = appWith(db);

    const pushed = await app.inject({ method: "GET", url: "/sheets/sht_1" });
    expect(pushed.json().export).toEqual({
      exportedAt: "2026-10-31T12:00:00.000Z",
      spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      sheetName: "Sheet1",
      url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
      error: null,
    });

    const never = appWith(fakeDb({ sheets: [sheetRow("sht_1")] }));
    const untouched = await never.inject({ method: "GET", url: "/sheets/sht_1" });
    expect(untouched.json().export).toEqual({
      exportedAt: null,
      spreadsheetId: null,
      sheetName: null,
      url: null,
      error: null,
    });
    await app.close();
    await never.close();
  });

  it("validates the export body before touching the sheet", async () => {
    const app = appWith(fakeDb({ sheets: [sheetRow("sht_1")] }));
    const res = await app.inject({
      method: "POST",
      url: "/sheets/sht_1/export",
      payload: { integrationId: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    await app.close();
  });
});
