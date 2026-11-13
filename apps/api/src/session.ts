import type { PrismaClient } from "@prisma/client";

/**
 * Session resolution before Phase 2 exists.
 *
 * Auth is not built yet, but every console query must be scoped to *some*
 * tenant, and the answer has to come from the database rather than a constant
 * in the code. `CONSOLE_TENANT_ID` pins it; otherwise the oldest user row
 * decides, which after `db:seed` is the demo workspace. Phase 2 replaces this
 * function with a signed session and nothing above it changes.
 */
export async function resolveConsoleTenant(
  db: PrismaClient,
  configured?: string,
): Promise<{ tenantId: string; via: string }> {
  if (configured) {
    const hit = await db.tenant.findFirst({ where: { id: configured }, select: { id: true, name: true } });
    if (!hit) throw new Error(`CONSOLE_TENANT_ID "${configured}" is not a tenant in this database`);
    return { tenantId: hit.id, via: "CONSOLE_TENANT_ID" };
  }
  const user = await db.user.findFirst({ orderBy: { createdAt: "asc" }, select: { tenantId: true, email: true } });
  if (!user) throw new Error("no tenant in the database — run `pnpm db:seed` or set CONSOLE_TENANT_ID");
  return { tenantId: user.tenantId, via: `oldest user ${user.email}` };
}
