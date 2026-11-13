import type { PrismaClient } from "@prisma/client";

/**
 * Tenant isolation at the query layer. Route code gets a `ScopedDb` instead
 * of the raw client: every read/write on a tenant-scoped model is forced to
 * carry the session's tenantId, and cross-tenant models (Plan, Tenant) are
 * simply not exposed.
 *
 * The project-scoped half of the new models is NOT enforced here — this
 * wrapper's only job is the tenant clause. `apps/api` adds the project clause
 * in its own where-helpers, because it still injects the raw client today.
 *
 * Unique-by-id operations are deliberately unsupported — `findUnique({id})`
 * is exactly how a tenant leak happens when someone pastes another tenant's
 * cuid into a URL. The scoped `findFirst` carries the injected filter.
 *
 * A model joins this list because it declares a `tenantId` column, and
 * `test/scoped.test.ts` reads schema.prisma to prove nobody forgets the next
 * one. Two families stay out on purpose: `webhookEventLog`, whose `tenantId`
 * is nullable because an inbound request can be logged before its channel
 * resolves to a tenant, and the child tables that carry no tenant column and
 * are reachable only through their parent — `agentRunStep` under its run,
 * `skillVersion` under its skill, `sheetRow` under its sheet.
 */

const TENANT_SCOPED_MODELS = [
  "user",
  "agent",
  "integration",
  "conversation",
  "conversationMessage",
  "usageEvent",
  "project",
  "workflow",
  "workflowDependency",
  "workflowRun",
  "workflowNodeRun",
  "agentRun",
  "skill",
  "agentCapability",
  "knowledgeDoc",
  "knowledgeChunk",
  "site",
  "sitePage",
  "embed",
  "embedMessage",
  "embedFeedback",
  "sheet",
] as const;
export type ScopedModelName = (typeof TENANT_SCOPED_MODELS)[number];

export class TenantScopeError extends Error {}

/**
 * The filter is an `AND` wrapper rather than a merged object so a caller
 * cannot shadow `tenantId` by passing their own `where.tenantId`.
 */
function withTenant(tenantId: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...args, where: { AND: [(args.where as Record<string, unknown> | undefined) ?? {}, { tenantId }] } };
}

function dataFor(tenantId: string, data: Record<string, unknown>): Record<string, unknown> {
  if (data.tenantId !== undefined && data.tenantId !== tenantId) {
    throw new TenantScopeError("create data carries a foreign tenantId");
  }
  return { ...data, tenantId };
}

function delegateOf(db: PrismaClient, model: ScopedModelName): Record<string, Function> {
  const d = (db as unknown as Record<string, Record<string, Function> | undefined>)[model];
  if (!d) throw new TenantScopeError(`model ${model} is missing from the client — regenerate prisma types`);
  return d;
}

function wrapModel(db: PrismaClient, model: ScopedModelName, tenantId: string) {
  const d = delegateOf(db, model);
  return {
    findMany: (args?: Record<string, unknown>) => d.findMany!(withTenant(tenantId, args)),
    findFirst: (args?: Record<string, unknown>) => d.findFirst!(withTenant(tenantId, args)),
    findFirstOrThrow: (args?: Record<string, unknown>) => d.findFirstOrThrow!(withTenant(tenantId, args)),
    count: (args?: Record<string, unknown>) => d.count!(withTenant(tenantId, args)),
    create: (args: Record<string, unknown> & { data: Record<string, unknown> }) =>
      d.create!({ ...args, data: dataFor(tenantId, args.data) }),
    createMany: (args: Record<string, unknown> & { data: Record<string, unknown>[] }) =>
      d.createMany!({ ...args, data: args.data.map((row) => dataFor(tenantId, row)) }),
    updateMany: (args: Record<string, unknown>) => d.updateMany!(withTenant(tenantId, args)),
    deleteMany: (args?: Record<string, unknown>) => d.deleteMany!(withTenant(tenantId, args)),
    findUnique: () => {
      throw new TenantScopeError("findUnique is not available on a scoped client — use findFirst");
    },
    findUniqueOrThrow: () => {
      throw new TenantScopeError("findUniqueOrThrow is not available on a scoped client — use findFirstOrThrow");
    },
  };
}

export type ScopedModel = ReturnType<typeof wrapModel>;

export interface ScopedDb {
  tenantId: string;
  user: ScopedModel;
  agent: ScopedModel;
  integration: ScopedModel;
  conversation: ScopedModel;
  conversationMessage: ScopedModel;
  usageEvent: ScopedModel;
  project: ScopedModel;
  workflow: ScopedModel;
  workflowDependency: ScopedModel;
  workflowRun: ScopedModel;
  workflowNodeRun: ScopedModel;
  agentRun: ScopedModel;
  skill: ScopedModel;
  agentCapability: ScopedModel;
  knowledgeDoc: ScopedModel;
  knowledgeChunk: ScopedModel;
  site: ScopedModel;
  sitePage: ScopedModel;
  embed: ScopedModel;
  embedMessage: ScopedModel;
  embedFeedback: ScopedModel;
  sheet: ScopedModel;
  $transaction: PrismaClient["$transaction"];
}

export function tenantScoped(db: PrismaClient, tenantId: string): ScopedDb {
  const models = Object.fromEntries(
    TENANT_SCOPED_MODELS.map((model) => [model, wrapModel(db, model, tenantId)]),
  ) as Record<ScopedModelName, ScopedModel>;
  return { tenantId, ...models, $transaction: db.$transaction.bind(db) };
}
