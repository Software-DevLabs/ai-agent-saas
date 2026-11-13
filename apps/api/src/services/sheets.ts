import type { PrismaClient } from "@prisma/client";
import { MAX_SHEET_ROWS } from "@saas/core";
import { tenantWhere } from "@saas/db";
import { notFound } from "../http-error.ts";

/**
 * Sheets, as the console reads them.
 *
 * A sheet is written by the agent's own `make_sheet` tool, never by this API: the
 * console can look and export, but it cannot compose a table the model did not
 * produce. `rowCount` is the number the tool recorded from the insert, and the
 * detail view reads the rows by index — so the count on the list and the rows in
 * the table come from the same write instead of from two stories about it.
 */

export type SheetCell = string | number | boolean | null;

/** The last Google Sheets push, as the console reports it. */
export interface SheetExportState {
  exportedAt: string | null;
  spreadsheetId: string | null;
  sheetName: string | null;
  url: string | null;
  /** Why the last push failed, kept until a push succeeds. */
  error: string | null;
}

export interface SheetSummaryDto {
  id: string;
  projectId: string;
  agentId: string;
  /** The agent that made the table, because a project can hold several. */
  agentName: string;
  title: string;
  columns: string[];
  rowCount: number;
  createdAt: string;
  export: SheetExportState;
}

export interface SheetRowDto {
  rowIndex: number;
  cells: SheetCell[];
}

export interface SheetDetailDto extends SheetSummaryDto {
  rows: SheetRowDto[];
}

const LIST_LIMIT = 50;

const sheetSelect = {
  id: true,
  projectId: true,
  agentId: true,
  title: true,
  columns: true,
  rowCount: true,
  createdAt: true,
  exportedAt: true,
  externalSpreadsheetId: true,
  externalSheetName: true,
  externalUrl: true,
  exportError: true,
  agent: { select: { name: true } },
} as const;

type SheetRow = {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  columns: unknown;
  rowCount: number;
  createdAt: Date;
  exportedAt: Date | null;
  externalSpreadsheetId: string | null;
  externalSheetName: string | null;
  externalUrl: string | null;
  exportError: string | null;
  agent: { name: string };
};

function columnsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Cells are validated at write time, but a JSON column is `unknown` on the way out.
 * Anything that is not a JSON primitive is rendered as empty rather than as
 * "[object Object]" — the console may not invent a value any more than the agent may.
 */
function cellsOf(value: unknown): SheetCell[] {
  if (!Array.isArray(value)) return [];
  return value.map((cell) =>
    cell === null ||
    typeof cell === "string" ||
    typeof cell === "boolean" ||
    (typeof cell === "number" && Number.isFinite(cell))
      ? (cell as SheetCell)
      : null,
  );
}

function summary(row: SheetRow): SheetSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    agentName: row.agent.name,
    title: row.title,
    columns: columnsOf(row.columns),
    rowCount: row.rowCount,
    createdAt: row.createdAt.toISOString(),
    export: {
      exportedAt: row.exportedAt === null ? null : row.exportedAt.toISOString(),
      spreadsheetId: row.externalSpreadsheetId,
      sheetName: row.externalSheetName,
      url: row.externalUrl,
      error: row.exportError,
    },
  };
}

/** Newest first, capped: a project that has generated hundreds of tables still loads. */
export async function listProjectSheets(db: PrismaClient, tenantId: string, projectId: string): Promise<SheetSummaryDto[]> {
  const rows = (await db.sheet.findMany({
    where: tenantWhere(tenantId, { projectId }),
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: sheetSelect,
  })) as SheetRow[];
  return rows.map(summary);
}

/**
 * One sheet with its rows. The row read happens only after the sheet itself was
 * found under this tenant, so a cuid from another workspace returns `404` before
 * any child row is touched.
 */
export async function getSheet(db: PrismaClient, tenantId: string, sheetId: string): Promise<SheetDetailDto> {
  const row = (await db.sheet.findFirst({
    where: tenantWhere(tenantId, { id: sheetId }),
    select: sheetSelect,
  })) as SheetRow | null;
  if (row === null) throw notFound("sheet_not_found", `sheet ${sheetId} is not in this tenant`);

  const rows = await db.sheetRow.findMany({
    where: { sheetId: row.id },
    orderBy: { rowIndex: "asc" },
    // Matches the write cap, so the read can never show fewer rows than were stored.
    take: MAX_SHEET_ROWS,
    select: { rowIndex: true, cells: true },
  });
  return {
    ...summary(row),
    rows: rows.map((entry) => ({ rowIndex: entry.rowIndex, cells: cellsOf(entry.cells) })),
  };
}
