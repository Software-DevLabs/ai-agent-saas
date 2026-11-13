/**
 * The single conversion point between Postgres types and JSON.
 * BigInt loses precision through `JSON.stringify` and Decimal arrives as a
 * class instance, so anything crossing the API edge passes through here.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  // Prisma's Decimal (and anything shaped like it) — number keeps usage charts simple.
  const maybe = value as { toNumber?: unknown; s?: unknown };
  if (typeof maybe.toNumber === "function") return (maybe.toNumber as () => number)();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}
