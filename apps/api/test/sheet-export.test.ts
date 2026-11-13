import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Keyring } from "@saas/shared";
import { pushSheetToSheets } from "../src/services/sheet-export.ts";

/**
 * The Google Sheets sink, against a stand-in for Google's two endpoints.
 *
 * A real push needs a real OAuth client and spreadsheet, which this environment
 * does not have; what is proven here is everything on our side of the wire — the
 * credential is decrypted and exchanged, the append carries the stored header and
 * rows, and every outcome is written onto the sheet row. A Google refusal or a
 * partial append leaves `exportedAt` untouched and stores the reason, because the
 * in-app table is the source of truth and must not be marked sent when it was not.
 */

const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 9) });
const SPREADSHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 12, minute));

type Row = Record<string, unknown>;

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  const clause = where as Record<string, unknown>;
  return Object.entries(clause).every(([key, value]) => {
    if (key === "AND") return (value as unknown[]).every((entry) => matches(row, entry));
    if (value !== null && typeof value === "object" && "in" in value) {
      return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

const credential = (over: Row = {}) =>
  keyring.encrypt(JSON.stringify({ clientId: "client_1", clientSecret: "secret_1", refreshToken: "refresh_1", ...over }));

const sheetSeed = (over: Row = {}): Row => ({
  id: "sht_1",
  tenantId: "tnt_one",
  projectId: "prj_one",
  agentId: "agt_1",
  agentName: "Support agent",
  title: "Refunds",
  columns: ["Order", "Reason", "Refund"],
  rowCount: 2,
  createdAt: at(0),
  exportedAt: null,
  externalSpreadsheetId: null,
  externalSheetName: null,
  externalUrl: null,
  exportError: null,
  ...over,
});

const integrationSeed = (over: Row = {}): Row => ({
  id: "int_1",
  tenantId: "tnt_one",
  projectId: "prj_one",
  type: "SHEETS_OUT",
  status: "CONNECTED",
  externalId: null,
  credentialsEncrypted: credential(),
  createdAt: at(0),
  ...over,
});

const rowSeed = (sheetId: string, rowIndex: number, cells: unknown[]): Row => ({ sheetId, rowIndex, cells });

function fakeDb(seed: { sheets?: Row[]; rows?: Row[]; integrations?: Row[] } = {}) {
  const sheets = (seed.sheets ?? [sheetSeed()]).map((sheet) => ({ ...sheet }));
  const rows = seed.rows ?? [
    rowSeed("sht_1", 0, ["A-1", "damaged", 24.5]),
    rowSeed("sht_1", 1, ["A-2", null, false]),
  ];
  const integrations = seed.integrations ?? [integrationSeed()];
  const updates: Row[] = [];

  const selected = (sheet: Row) => ({ ...sheet, agent: { name: sheet.agentName } });

  const db = {
    sheet: {
      findFirst: async ({ where }: { where: unknown }) => {
        const sheet = sheets.find((entry) => matches(entry, where));
        return sheet === undefined ? null : selected(sheet);
      },
      updateMany: async ({ where, data }: { where: unknown; data: Row }) => {
        const sheet = sheets.find((entry) => matches(entry, where));
        if (sheet === undefined) return { count: 0 };
        Object.assign(sheet, data);
        updates.push({ id: sheet.id, ...data });
        return { count: 1 };
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
    integration: {
      findMany: async ({ where }: { where: unknown }) =>
        integrations
          .filter((entry) => matches(entry, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .map((entry) => ({
            id: entry.id,
            externalId: entry.externalId,
            status: entry.status,
            credentialsEncrypted: entry.credentialsEncrypted,
          })),
    },
  };
  return { db: db as unknown as PrismaClient, updates, sheets };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; init: RequestInit };

function scriptedFetch(handlers: { token?: () => Response; append?: () => Response }) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return (handlers.token ?? (() => json({ access_token: "at_123" })))();
    }
    if (url.startsWith("https://sheets.googleapis.com/v4/spreadsheets/")) {
      return (handlers.append ?? (() => json({ updates: { updatedRows: 3 } })))();
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("pushSheetToSheets", () => {
  it("exchanges the Keyring credential and appends the stored header and rows", async () => {
    const { db, updates } = fakeDb();
    const { impl, calls } = scriptedFetch({});

    const result = await pushSheetToSheets(
      db,
      keyring,
      "tnt_one",
      "sht_1",
      { spreadsheetId: `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit#gid=0` },
      impl,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = calls[0]!.init.body as URLSearchParams;
    expect(tokenBody.get("grant_type")).toBe("refresh_token");
    expect(tokenBody.get("refresh_token")).toBe("refresh_1");
    expect(tokenBody.get("client_id")).toBe("client_1");
    expect(tokenBody.get("client_secret")).toBe("secret_1");

    expect(decodeURIComponent(calls[1]!.url)).toContain(`/v4/spreadsheets/${SPREADSHEET}/values/'Sheet1'!A1:append`);
    expect(calls[1]!.url).toContain("valueInputOption=RAW");
    expect(calls[1]!.url).toContain("insertDataOption=INSERT_ROWS");
    expect(calls[1]!.init.headers).toMatchObject({ authorization: "Bearer at_123" });
    const body = JSON.parse(calls[1]!.init.body as string) as { values: unknown[][] };
    expect(body.values).toEqual([
      ["Order", "Reason", "Refund"],
      ["A-1", "damaged", 24.5],
      ["A-2", "", false],
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "sht_1",
      externalSpreadsheetId: SPREADSHEET,
      externalSheetName: "Sheet1",
      externalUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET}/edit`,
      exportError: null,
    });
    expect(updates[0]!.exportedAt).toBeInstanceOf(Date);
    expect(result.rowsAppended).toBe(2);
    expect(result.sheet.export.exportedAt).not.toBeNull();
    expect(result.sheet.export.error).toBeNull();
  });

  it("falls back to the connection's spreadsheet and quotes a tab name with an apostrophe", async () => {
    const { db } = fakeDb({ integrations: [integrationSeed({ externalId: SPREADSHEET })] });
    const { impl, calls } = scriptedFetch({});

    await pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { sheetName: "Q3 '26" }, impl);

    expect(decodeURIComponent(calls[1]!.url)).toContain(`values/'Q3 ''26'!A1:append`);
  });

  it("records a Google refusal on the sheet row and does not mark it exported", async () => {
    const { db, updates } = fakeDb();
    const { impl } = scriptedFetch({
      append: () => json({ error: { message: "The caller does not have permission" } }, 403),
    });

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toMatchObject({
      code: "sheets_export_failed",
      status: 502,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.exportError).toContain("403");
    expect(updates[0]!.exportError).toContain("does not have permission");
    expect(updates[0]).not.toHaveProperty("exportedAt");
  });

  it("treats a partial append as a failure rather than a success", async () => {
    const { db, updates } = fakeDb();
    const { impl } = scriptedFetch({ append: () => json({ updates: { updatedRows: 2 } }) });

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toThrow(
      /appended 2 of 3 row/,
    );
    expect(updates[0]!.exportError).toContain("2 of 3");
    expect(updates[0]).not.toHaveProperty("exportedAt");
  });

  it("records a token refusal without ever calling the append endpoint", async () => {
    const { db, updates } = fakeDb();
    const { impl, calls } = scriptedFetch({ token: () => json({ error: "invalid_grant" }, 400) });

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toThrow(
      /invalid_grant/,
    );
    expect(calls).toHaveLength(1);
    expect(updates[0]!.exportError).toContain("invalid_grant");
  });

  it("refuses before contacting Google when the project has no Sheets connection", async () => {
    const { db, updates } = fakeDb({ integrations: [] });
    const { impl, calls } = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toMatchObject({
      code: "sheets_not_connected",
    });
    expect(calls).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("refuses to guess between two connections, and uses the chosen one when named", async () => {
    const second = integrationSeed({ id: "int_2", createdAt: at(2), externalId: SPREADSHEET, credentialsEncrypted: credential({ refreshToken: "refresh_2" }) });
    const { db } = fakeDb({ integrations: [integrationSeed(), second] });
    const ambiguous = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", {}, ambiguous.impl)).rejects.toMatchObject({
      code: "sheets_connection_ambiguous",
    });
    expect(ambiguous.calls).toEqual([]);

    const chosen = scriptedFetch({});
    const result = await pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { integrationId: "int_2" }, chosen.impl);
    expect((chosen.calls[0]!.init.body as URLSearchParams).get("refresh_token")).toBe("refresh_2");
    expect(result.spreadsheetId).toBe(SPREADSHEET);
  });

  it("refuses a connection whose credential is not the OAuth client JSON", async () => {
    const { db } = fakeDb({
      integrations: [integrationSeed({ credentialsEncrypted: keyring.encrypt("1//a-plain-refresh-token") })],
    });
    const { impl, calls } = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toMatchObject({
      code: "sheets_credential_invalid",
      status: 422,
    });
    expect(calls).toEqual([]);
  });

  it("refuses a target that is neither an id nor a docs.google.com URL", async () => {
    const { db } = fakeDb();
    const { impl, calls } = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: "my spreadsheet" }, impl)).rejects.toMatchObject({
      code: "sheets_target_missing",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a sheet that is not in this tenant before reading any connection", async () => {
    const { db, updates } = fakeDb();
    const { impl, calls } = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_foreign", {}, impl)).rejects.toMatchObject({
      code: "sheet_not_found",
      status: 404,
    });
    expect(calls).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("ignores another project's connection", async () => {
    const { db } = fakeDb({ integrations: [integrationSeed({ projectId: "prj_other" })] });
    const { impl, calls } = scriptedFetch({});

    await expect(pushSheetToSheets(db, keyring, "tnt_one", "sht_1", { spreadsheetId: SPREADSHEET }, impl)).rejects.toMatchObject({
      code: "sheets_not_connected",
    });
    expect(calls).toEqual([]);
  });
});
