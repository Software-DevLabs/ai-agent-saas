import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getToolSpec, toolKeys, type ToolContext } from "../src/capability/registry.ts";
import { buildMakeSheetTool, makeSheetSpec, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "../src/sheets/tools.ts";

/**
 * `make_sheet`, tested where it is decided: what the model proposed becomes what the
 * database stored, or nothing does.
 *
 * The acceptance test the plan asks for is here — the number in the tool's reply is
 * compared with the rows the fake client received and with the `rowCount` written in
 * the same transaction. The refusal tests all assert zero writes, because a sheet
 * that silently dropped rows would be a table with a wrong number on it.
 */

type Row = Record<string, unknown>;

function fakeDb(options: { agent?: Row | null } = {}) {
  const writes = { sheets: [] as Row[], rows: [] as Row[], updates: [] as Row[] };
  const db: Record<string, unknown> = {
    agent: {
      findFirst: async () => (options.agent === null ? null : (options.agent ?? { projectId: "prj_1" })),
    },
    sheet: {
      create: async ({ data }: { data: Row }) => {
        writes.sheets.push(data);
        return { id: "sheet_1" };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        writes.updates.push({ where, data });
        return { id: where.id };
      },
    },
    sheetRow: {
      createMany: async ({ data }: { data: Row[] }) => {
        writes.rows.push(...data);
        return { count: data.length };
      },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  return { db: db as unknown as PrismaClient, writes };
}

function toolWith(db: PrismaClient) {
  const ctx: ToolContext = {
    db,
    tenantId: "tnt_1",
    agentId: "agt_1",
    skills: new Map(),
    knowledge: { docIds: [], titles: [] },
  };
  const built = makeSheetSpec.build(ctx, () => undefined);
  expect(built).not.toBeNull();
  return built!;
}

describe("the make_sheet registry entry", () => {
  it("is an explicit write grant, not something a knowledge or site grant derives", () => {
    const spec = getToolSpec("make_sheet");
    expect(spec).not.toBeNull();
    expect(spec!.key).toBe("make_sheet");
    expect(spec!.effect).toBe("write");
    expect(spec!.requires).toEqual([]);
    expect(toolKeys()).toContain("make_sheet");
  });
});

describe("make_sheet writes", () => {
  it("stores every proposed row and reports the count it actually stored", async () => {
    const { db, writes } = fakeDb();
    const tool = toolWith(db);

    const result = await tool.execute({
      title: "  Refund triage  ",
      columns: ["Order", "Reason", "Refund"],
      rows: [
        ["A-1001", "damaged in transit", 24.5],
        ["A-1002", "wrong size", null],
        ["A-1003", "changed mind", true],
      ],
    });

    expect(writes.sheets).toHaveLength(1);
    expect(writes.sheets[0]).toMatchObject({
      tenantId: "tnt_1",
      projectId: "prj_1",
      agentId: "agt_1",
      title: "Refund triage",
      columns: ["Order", "Reason", "Refund"],
      rowCount: 0,
    });
    expect(writes.rows.map((row) => row.rowIndex)).toEqual([0, 1, 2]);
    expect(writes.rows[2]).toMatchObject({ sheetId: "sheet_1", cells: ["A-1003", "changed mind", true] });

    // The accepted test: the reply's number is the stored number, three ways.
    const claimed = Number(/— (\d+) row\(s\)/.exec(result)?.[1]);
    expect(claimed).toBe(3);
    expect(claimed).toBe(writes.rows.length);
    expect(writes.updates.at(-1)?.data).toEqual({ rowCount: 3 });
    expect(result).toContain("SHEET_CREATED: \"Refund triage\"");
    expect(result).toContain("sheet_1");
    expect(result).toContain("A-1001 | damaged in transit | 24.5");
  });

  it("accepts exactly 500 rows and 24 columns", async () => {
    const { db, writes } = fakeDb();
    const tool = toolWith(db);
    const columns = Array.from({ length: MAX_SHEET_COLUMNS }, (_, index) => `C${index}`);
    const rows = Array.from({ length: MAX_SHEET_ROWS }, (_, index) =>
      columns.map((_, column) => (column === 0 ? `row-${index}` : index)),
    );

    const result = await tool.execute({ title: "At the cap", columns, rows });

    expect(writes.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(writes.updates.at(-1)?.data).toEqual({ rowCount: MAX_SHEET_ROWS });
    expect(result).toContain(`${MAX_SHEET_ROWS} row(s) × ${MAX_SHEET_COLUMNS} column(s)`);
  });

  it("stores an empty sheet as zero rows rather than refusing the headers", async () => {
    const { db, writes } = fakeDb();
    const tool = toolWith(db);

    const result = await tool.execute({ title: "Empty plan", columns: ["Task"], rows: [] });

    expect(writes.sheets).toHaveLength(1);
    expect(writes.rows).toEqual([]);
    expect(writes.updates.at(-1)?.data).toEqual({ rowCount: 0 });
    expect(result).toContain("0 row(s) × 1 column(s)");
  });
});

describe("make_sheet refusals", () => {
  async function refused(values: Record<string, unknown>, pattern: RegExp) {
    const { db, writes } = fakeDb();
    const tool = toolWith(db);
    await expect(tool.execute(values)).rejects.toThrow(pattern);
    expect(writes.sheets).toEqual([]);
    expect(writes.rows).toEqual([]);
    expect(writes.updates).toEqual([]);
  }

  it("refuses 501 rows instead of truncating, and says nothing was stored", async () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, index) => [`row-${index}`]);
    await refused({ title: "Too long", columns: ["Name"], rows }, /501 rows were proposed and the limit is 500/);
  });

  it("refuses 25 columns", async () => {
    const columns = Array.from({ length: MAX_SHEET_COLUMNS + 1 }, (_, index) => `C${index}`);
    await refused({ title: "Too wide", columns, rows: [] }, /25 columns were proposed and the limit is 24/);
  });

  it("refuses a ragged row and names it", async () => {
    await refused(
      { title: "Ragged", columns: ["A", "B", "C"], rows: [["1", "2", "3"], ["4", "5"]] },
      /row 2 has 2 cell\(s\) but there are 3 columns/,
    );
  });

  it("refuses a blank title, a blank header and duplicate headers", async () => {
    await refused({ title: "   ", columns: ["A"], rows: [] }, /"title" is required/);
    await refused({ title: "T", columns: ["A", ""], rows: [] }, /column 2 has no name/);
    await refused({ title: "T", columns: ["Amount", "amount"], rows: [] }, /two columns are named "amount"/);
  });

  it("refuses a cell that is not text, a finite number, a boolean or empty", async () => {
    await refused(
      { title: "T", columns: ["A", "B"], rows: [["ok", { nested: true }]] },
      /row 1, column "B" is an object/,
    );
    await refused({ title: "T", columns: ["A"], rows: [[Number.NaN]] }, /row 1, column "A" is NaN/);
  });

  it("refuses an oversized cell instead of cutting it", async () => {
    await refused(
      { title: "T", columns: ["Notes"], rows: [["x".repeat(2_001)]] },
      /holds 2001 characters and the cell limit is 2000/,
    );
  });

  it("refuses when the agent row is gone, because the sheet would have no project", async () => {
    const { db, writes } = fakeDb({ agent: null });
    const tool = buildMakeSheetTool(db, "tnt_1", "agt_1");
    await expect(tool.execute({ title: "T", columns: ["A"], rows: [["1"]] })).rejects.toThrow(
      /agent agt_1 is not in this tenant/,
    );
    expect(writes.sheets).toEqual([]);
  });
});
