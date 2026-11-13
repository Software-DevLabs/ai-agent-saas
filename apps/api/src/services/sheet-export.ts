import type { PrismaClient } from "@prisma/client";
import type { Keyring } from "@saas/shared";
import { tenantWhere } from "@saas/db";
import { badRequest, conflict, HttpError } from "../http-error.ts";
import { getSheet, type SheetDetailDto } from "./sheets.ts";

/**
 * The Google Sheets sink, as an explicit action on one sheet.
 *
 * The in-app rows are the source of truth. A push copies them into a spreadsheet
 * and records what happened on the sheet row: `exportedAt` on success, `exportError`
 * on failure. Nothing here edits, deletes or re-reads the stored table, so a Google
 * outage can never cost the operator the data the agent produced.
 *
 * The credential is a Keyring-encrypted OAuth client JSON pasted into the project's
 * Connections tab — `{ clientId, clientSecret, refreshToken }` — and it is decrypted
 * only for the token exchange. Both endpoints are fixed Google URLs, so no user
 * input can redirect the request; the spreadsheet id is the only caller-controlled
 * path segment and is validated against Google's id alphabet before it is used.
 */

export interface SheetExportInput {
  integrationId?: string;
  /** A spreadsheet id or a docs.google.com URL; the connection's externalId is the fallback. */
  spreadsheetId?: string;
  sheetName?: string;
}

export interface SheetExportResult {
  sheet: SheetDetailDto;
  spreadsheetId: string;
  sheetName: string;
  /** Data rows appended below the header — the header itself is not counted. */
  rowsAppended: number;
  url: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEOUT_MS = 10_000;
const MAX_REASON_CHARS = 500;
const MAX_DETAIL_CHARS = 240;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;

interface SheetsCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** A reason that belongs on the sheet row; the message is safe to show an operator. */
class ExportFailure extends Error {}

function cap(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Google's own wording when it gives one, capped and never including the request. */
function googleDetail(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message !== "") return `: ${cap(message, MAX_DETAIL_CHARS)}`;
  }
  if (typeof error === "string" && error !== "") return `: ${cap(error, MAX_DETAIL_CHARS)}`;
  if (typeof payload.error_description === "string" && payload.error_description !== "") {
    return `: ${cap(payload.error_description, MAX_DETAIL_CHARS)}`;
  }
  return "";
}

/**
 * The credential is read at push time rather than validated at save time, because
 * the only question that matters is whether Google accepts it. A row that cannot be
 * parsed says how to replace it instead of reporting a connection that looks healthy.
 */
function credentialOf(blob: string, keyring: Keyring): SheetsCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keyring.decrypt(blob));
  } catch {
    throw new HttpError(
      422,
      "sheets_credential_invalid",
      "this Google Sheets connection does not hold a readable OAuth credential — replace it in Connections with {\"clientId\":\"…\",\"clientSecret\":\"…\",\"refreshToken\":\"…\"}",
    );
  }
  const entry = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { clientId, clientSecret, refreshToken } = entry;
  if (
    typeof clientId !== "string" ||
    clientId === "" ||
    typeof clientSecret !== "string" ||
    clientSecret === "" ||
    typeof refreshToken !== "string" ||
    refreshToken === ""
  ) {
    throw new HttpError(
      422,
      "sheets_credential_invalid",
      "this Google Sheets connection is missing part of the OAuth client — it needs clientId, clientSecret and refreshToken",
    );
  }
  return { clientId, clientSecret, refreshToken: refreshToken as string };
}

function spreadsheetIdOf(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value);
  const id = fromUrl?.[1] ?? value;
  return SPREADSHEET_ID.test(id) ? id : null;
}

function tabNameOf(raw: string | undefined): string {
  const name = (raw ?? "").trim() || "Sheet1";
  if (name.length > 100) throw badRequest("sheets_tab_invalid", "a tab name is at most 100 characters");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw badRequest("sheets_tab_invalid", "a tab name cannot contain control characters");
  return name;
}

/** A1 range, always quoted so a tab name with spaces or punctuation is one token. */
function rangeOf(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'!A1`;
}

async function accessToken(credential: SheetsCredential, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await jsonOf(response);
  if (!response.ok) {
    throw new ExportFailure(
      `Google refused the connection's token (HTTP ${response.status}${googleDetail(payload)}) — reconnect the Google Sheets connection`,
    );
  }
  const token = payload.access_token;
  if (typeof token !== "string" || token === "") {
    throw new ExportFailure("Google's token endpoint answered without an access token");
  }
  return token;
}

/**
 * Append the header and every stored row, then record the outcome on the sheet.
 * A preflight refusal (no connection, no target) never touches the row, because
 * nothing was attempted; only a Google call that started and failed does.
 */
export async function pushSheetToSheets(
  db: PrismaClient,
  keyring: Keyring,
  tenantId: string,
  sheetId: string,
  input: SheetExportInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SheetExportResult> {
  const sheet = await getSheet(db, tenantId, sheetId);

  const connections = await db.integration.findMany({
    where: tenantWhere(tenantId, {
      projectId: sheet.projectId,
      type: "SHEETS_OUT",
      ...(input.integrationId === undefined ? {} : { id: input.integrationId }),
    }),
    orderBy: { createdAt: "desc" },
    select: { id: true, externalId: true, status: true, credentialsEncrypted: true },
  });
  if (connections.length === 0) {
    throw conflict(
      "sheets_not_connected",
      input.integrationId === undefined
        ? "this project has no Google Sheets connection — add one in the project's Connections tab"
        : `this project has no Google Sheets connection with the id "${input.integrationId}"`,
    );
  }
  const connected = connections.filter((connection) => connection.status === "CONNECTED");
  if (connected.length === 0) {
    throw conflict("sheets_not_connected", "the project's Google Sheets connection is not connected — check it in Connections");
  }
  if (input.integrationId === undefined && connected.length > 1) {
    throw conflict(
      "sheets_connection_ambiguous",
      `this project has ${connected.length} Google Sheets connections — choose which one this sheet is pushed to`,
      { connections: connected.map((connection) => connection.id) },
    );
  }
  const connection = connected[0]!;
  const credential = credentialOf(connection.credentialsEncrypted, keyring);

  const rawTarget = input.spreadsheetId ?? connection.externalId;
  const spreadsheetId = spreadsheetIdOf(rawTarget);
  if (spreadsheetId === null) {
    throw badRequest(
      "sheets_target_missing",
      rawTarget === null || rawTarget === ""
        ? "no spreadsheet was named — pass a spreadsheet id or URL, or set one on the connection"
        : `"${cap(rawTarget, 80)}" is not a Google spreadsheet id or docs.google.com URL`,
    );
  }
  const sheetName = tabNameOf(input.sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  const values: (string | number | boolean)[][] = [
    sheet.columns,
    ...sheet.rows.map((row) => sheet.columns.map((_, index) => row.cells[index] ?? "")),
  ];

  try {
    const token = await accessToken(credential, fetchImpl);
    const appendUrl = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(rangeOf(sheetName))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    let response: Response;
    try {
      response = await fetchImpl(appendUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ majorDimension: "ROWS", values }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExportFailure(
        `could not reach Google Sheets (${cap(error instanceof Error ? error.message : "the request failed", MAX_DETAIL_CHARS)})`,
      );
    }
    const payload = await jsonOf(response);
    if (!response.ok) {
      throw new ExportFailure(`Google refused the append (HTTP ${response.status}${googleDetail(payload)})`);
    }
    const updates = payload.updates;
    const updatedRows = typeof updates === "object" && updates !== null ? (updates as Record<string, unknown>).updatedRows : undefined;
    // Google reporting fewer rows than were sent is a partial write. The in-app sheet
    // is untouched, so the honest outcome is a failure on the row, not "exported".
    if (typeof updatedRows === "number" && updatedRows !== values.length) {
      throw new ExportFailure(
        `Google appended ${updatedRows} of ${values.length} row(s) (header included) — check the spreadsheet; the in-app sheet is unchanged`,
      );
    }

    await db.sheet.updateMany({
      where: tenantWhere(tenantId, { id: sheet.id }),
      data: {
        exportedAt: new Date(),
        externalSpreadsheetId: spreadsheetId,
        externalSheetName: sheetName,
        externalUrl: url,
        exportError: null,
      },
    });
    return { sheet: await getSheet(db, tenantId, sheet.id), spreadsheetId, sheetName, rowsAppended: sheet.rows.length, url };
  } catch (error) {
    const reason = cap(error instanceof Error ? error.message : "the push failed", MAX_REASON_CHARS);
    await db.sheet
      .updateMany({ where: tenantWhere(tenantId, { id: sheet.id }), data: { exportError: reason } })
      .catch(() => undefined);
    throw new HttpError(502, "sheets_export_failed", reason, { sheetId: sheet.id });
  }
}
