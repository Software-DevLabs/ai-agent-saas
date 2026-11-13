/**
 * The where-clause builders every tenant-scoped query is supposed to go
 * through. The filter is an `AND` wrapper rather than a merged object so a
 * caller cannot shadow `tenantId` (or `projectId`) by passing their own key in
 * `where` — the injected clause is always the last one Postgres has to satisfy.
 *
 * `apps/api` hand-rolled this in `services/reads.ts` and `packages/db` had a
 * second copy in `scoped.ts`. One implementation, two callers, is the point.
 */

export function tenantWhere<T extends Record<string, unknown>>(tenantId: string, where: T): Record<string, unknown> {
  return { AND: [where, { tenantId }] };
}

/**
 * Two-level scope. A project id is only ever meaningful inside its own tenant,
 * so both clauses are always carried: a foreign `projectId` from another tenant
 * narrows to zero rows rather than leaking anything.
 */
export function projectWhere<T extends Record<string, unknown>>(
  tenantId: string,
  projectId: string,
  where: T,
): Record<string, unknown> {
  return { AND: [where, { tenantId }, { projectId }] };
}

/**
 * The id of the project that owns everything else in a tenant.
 *
 * The `add_project` migration backfills with `'prj_' || "tenantId"`, so this is
 * the only other place that formula may appear. If the two ever disagree, a
 * fresh database and a migrated one put the same agent in different projects —
 * which is the divergence this helper exists to prevent.
 */
export function defaultProjectId(tenantId: string): string {
  return `prj_${tenantId}`;
}
