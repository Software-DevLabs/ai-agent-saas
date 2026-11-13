import { describe, expect, it } from "vitest";
import { jsonSafe } from "../src/json.ts";

describe("jsonSafe", () => {
  it("converts BigInt to string so JSON never corrupts a token balance", () => {
    const out = jsonSafe({ tokenBalance: 9007199254740993n }) as { tokenBalance: string };
    expect(out.tokenBalance).toBe("9007199254740993");
    expect(JSON.parse(JSON.stringify(out)).tokenBalance).toBe("9007199254740993");
  });

  it("flattens Decimal-shaped objects to numbers", () => {
    const decimal = { toNumber: () => 0.0042, s: "0.0042" };
    const out = jsonSafe({ cost: decimal }) as { cost: number };
    expect(out.cost).toBe(0.0042);
  });

  it("walks arrays and nested objects, converting Dates to ISO", () => {
    const out = jsonSafe({
      rows: [{ cost: { toNumber: () => 1 } }, { when: new Date("2026-10-30T00:00:00Z") }],
      deep: { balance: 5n },
    }) as { rows: [{ cost: number }, { when: string }]; deep: { balance: string } };
    expect(out.rows[0]!.cost).toBe(1);
    expect(out.rows[1]!.when).toBe("2026-10-30T00:00:00.000Z");
    expect(out.deep.balance).toBe("5");
  });

  it("passes through primitives untouched", () => {
    expect(jsonSafe(null)).toBeNull();
    expect(jsonSafe(undefined)).toBeUndefined();
    expect(jsonSafe("text")).toBe("text");
    expect(jsonSafe(42)).toBe(42);
    expect(jsonSafe(true)).toBe(true);
  });
});
