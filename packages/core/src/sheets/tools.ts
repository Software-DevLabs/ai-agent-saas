import type { PrismaClient } from "@prisma/client";
import type { AgentTool } from "../agent-run.ts";
import type { ToolSpec } from "../capability/registry.ts";

/**
 * `make_sheet` — the one tool that writes an operator-facing table.
 *
 * The model proposes a title, a header and rows; every value is re-read and
 * re-validated here, because a tool argument is untrusted model output and a stored
 * table is something a person will act on. The limits are refusals, not truncations:
 * a sheet that quietly dropped rows 501 to 800 would still display a number, and
 * that number would be a lie. A refusal says how many rows were proposed, the cap,
 * and that nothing was stored, so the model can split the work and try again.
 *
 * The row count in the result is read from what the transaction inserted rather
 * than from the model's own claim, which is what lets the console assert that the
 * count on screen is the count in the database.
 */

export const MAX_SHEET_ROWS = 500;
export const MAX_SHEET_COLUMNS = 24;
export const MAX_SHEET_TITLE_CHARS = 160;
export const MAX_SHEET_COLUMN_CHARS = 80;
export const MAX_SHEET_CELL_CHARS = 2_000;

export type SheetCell = string | number | boolean | null;

export interface SheetDraft {
  title: string;
  columns: string[];
  rows: SheetCell[][];
}

function refuse(why: string): never {
  throw new Error(`SHEET_REFUSED: ${why}`);
}

function describe(value: unknown): string {
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * Turn the model's arguments into a draft that is safe to store, or refuse.
 * Everything is checked before the transaction opens, so a refused sheet leaves no
 * half-written table behind.
 */
export function readSheetArguments(values: Record<string, unknown>): SheetDraft {
  const title = typeof values.title === "string" ? values.title.trim() : "";
  if (title === "") refuse('"title" is required — the operator needs a name to find the sheet by.');
  if (!Array.isArray(values.columns) || values.columns.length === 0) {
    refuse('"columns" must be a non-empty list of header names.');
  }
  if (values.columns.length > MAX_SHEET_COLUMNS) {
    refuse(
      `${values.columns.length} columns were proposed and the limit is ${MAX_SHEET_COLUMNS} — split the table into two sheets rather than dropping columns.`,
    );
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of values.columns.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      refuse(`column ${index + 1} has no name — every column needs a header.`);
    }
    const name = entry.trim();
    if (name.length > MAX_SHEET_COLUMN_CHARS) {
      refuse(`column ${index + 1} ("${name.slice(0, 40)}…") is longer than ${MAX_SHEET_COLUMN_CHARS} characters.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) refuse(`two columns are named "${name}" — header names must be distinct.`);
    seen.add(key);
    columns.push(name);
  }

  if (!Array.isArray(values.rows)) refuse('"rows" must be a list of rows, each an array of cells in column order.');
  if (values.rows.length > MAX_SHEET_ROWS) {
    refuse(
      `${values.rows.length} rows were proposed and the limit is ${MAX_SHEET_ROWS} — nothing was stored. Split the table into sheets of ${MAX_SHEET_ROWS} or fewer; dropping rows silently is not an option.`,
    );
  }
  const rows: SheetCell[][] = values.rows.map((entry, rowIndex) => {
    if (!Array.isArray(entry)) refuse(`row ${rowIndex + 1} is ${describe(entry)} rather than a list of cells.`);
    if (entry.length !== columns.length) {
      refuse(
        `row ${rowIndex + 1} has ${entry.length} cell(s) but there are ${columns.length} columns — every row must line up with the header.`,
      );
    }
    return entry.map((cell, columnIndex) => {
      const where = `row ${rowIndex + 1}, column "${columns[columnIndex] ?? columnIndex + 1}"`;
      if (cell === null || typeof cell === "boolean") return cell;
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) refuse(`${where} is ${String(cell)} — cells must be finite numbers, text, true/false or empty.`);
        return cell;
      }
      if (typeof cell === "string") {
        if (cell.length > MAX_SHEET_CELL_CHARS) {
          refuse(
            `${where} holds ${cell.length} characters and the cell limit is ${MAX_SHEET_CELL_CHARS} — shorten it rather than expecting it to be cut.`,
          );
        }
        return cell;
      }
      refuse(`${where} is ${describe(cell)} — cells must be text, numbers, true/false or empty.`);
    });
  });

  return { title: title.slice(0, MAX_SHEET_TITLE_CHARS), columns, rows };
}

/** What the model reads back: the count that is actually in the database. */
export function formatSheetResult(title: string, sheetId: string, columns: string[], rows: SheetCell[][], storedCount: number): string {
  const cellText = (cell: SheetCell): string => (cell === null ? "" : String(cell));
  const preview = rows.slice(0, 3).map((cells) => cells.map(cellText).join(" | "));
  return [
    `SHEET_CREATED: "${title}" — ${storedCount} row(s) × ${columns.length} column(s), stored as sheet ${sheetId}. It is on the project's Sheets tab and can be exported as CSV there.`,
    `Columns: ${columns.map((name) => `"${name}"`).join(" | ")}`,
    ...(preview.length > 0 ? [`First rows:\n${preview.join("\n")}`] : []),
    `Say what the table shows and cite ${storedCount} row(s) — that is the number stored, not an estimate.`,
  ].join("\n");
}

/** The tool body, split out so a test can hand it a fake client and read the writes. */
export function buildMakeSheetTool(db: PrismaClient, tenantId: string, agentId: string): AgentTool {
  return {
    name: "make_sheet",
    description: `Create a table in the console from rows you have assembled — up to ${MAX_SHEET_ROWS} rows and ${MAX_SHEET_COLUMNS} columns. Use it when the operator asks for a table, a comparison, a checklist or something to export. Every row you pass is stored; a table over the limit is refused and nothing is stored, so split it into smaller sheets instead of dropping rows.`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short name the operator will find the sheet by." },
        columns: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_SHEET_COLUMNS,
          description: "Header names, in order. Every row must carry one cell per column.",
        },
        rows: {
          type: "array",
          items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
          maxItems: MAX_SHEET_ROWS,
          description: "The rows, each an array of cells in column order.",
        },
      },
      required: ["title", "columns", "rows"],
    },
    execute: async (values) => {
      const draft = readSheetArguments(values);
      // The sheet belongs to the agent's own project. Resolved from the agent row
      // rather than taken from the caller, so a turn cannot file a table somewhere
      // the operator would not look for it.
      const agent = await db.agent.findFirst({
        where: { AND: [{ id: agentId }, { tenantId }] },
        select: { projectId: true },
      });
      if (agent === null) refuse(`agent ${agentId} is not in this tenant, so the sheet has no project to belong to.`);

      const stored = await db.$transaction(async (tx) => {
        const sheet = await tx.sheet.create({
          data: {
            tenantId,
            projectId: agent.projectId,
            agentId,
            title: draft.title,
            columns: draft.columns,
            rowCount: 0,
          },
          select: { id: true },
        });
        const created =
          draft.rows.length === 0
            ? { count: 0 }
            : await tx.sheetRow.createMany({
                data: draft.rows.map((cells, rowIndex) => ({ sheetId: sheet.id, rowIndex, cells })),
              });
        // Written from the insert, not from `draft.rows.length`: the two agree when
        // validation passed, and if they ever did not, the database would win.
        await tx.sheet.update({ where: { id: sheet.id }, data: { rowCount: created.count } });
        return { id: sheet.id, count: created.count };
      });

      return formatSheetResult(draft.title, stored.id, draft.columns, draft.rows, stored.count);
    },
  };
}

export const makeSheetSpec: ToolSpec = {
  key: "make_sheet",
  label: "Create a table (sheet)",
  summary:
    "Stores a table the model assembled as Sheet + SheetRow rows in the agent's project, so the console can render and export it. The server re-validates every header and cell; over 500 rows or 24 columns the call is refused rather than truncated, and the stored count is read back from the insert.",
  effect: "write",
  requires: [],
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      columns: { type: "array", items: { type: "string" }, maxItems: MAX_SHEET_COLUMNS },
      rows: { type: "array", items: { type: "array" }, maxItems: MAX_SHEET_ROWS },
    },
    required: ["title", "columns", "rows"],
  },
  build(ctx) {
    return buildMakeSheetTool(ctx.db, ctx.tenantId, ctx.agentId);
  },
};
