import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { tenantScoped, TenantScopeError } from "../src/scoped.ts";

/** A Prisma-shaped fake that records the args each operation receives. */
function fakeDb() {
  const calls: { op: string; model: string; args: unknown }[] = [];
  const recorder = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => (args: unknown) => {
          calls.push({ op, model, args });
          return Promise.resolve({ ok: true });
        },
      },
    );
  return {
    calls,
    user: recorder("user"),
    agent: recorder("agent"),
    integration: recorder("integration"),
    conversation: recorder("conversation"),
    conversationMessage: recorder("conversationMessage"),
    usageEvent: recorder("usageEvent"),
    project: recorder("project"),
    workflow: recorder("workflow"),
    workflowDependency: recorder("workflowDependency"),
    workflowRun: recorder("workflowRun"),
    workflowNodeRun: recorder("workflowNodeRun"),
    agentRun: recorder("agentRun"),
    skill: recorder("skill"),
    agentCapability: recorder("agentCapability"),
    knowledgeDoc: recorder("knowledgeDoc"),
    knowledgeChunk: recorder("knowledgeChunk"),
    site: recorder("site"),
    sitePage: recorder("sitePage"),
    embed: recorder("embed"),
    embedMessage: recorder("embedMessage"),
    embedFeedback: recorder("embedFeedback"),
    sheet: recorder("sheet"),
    $transaction: () => Promise.resolve([]),
  };
}

/** The fake satisfies only the slice `tenantScoped` touches. */
type FakeDb = ReturnType<typeof fakeDb>;
const asClient = (db: FakeDb) => db as unknown as import("@prisma/client").PrismaClient;

describe("tenantScoped", () => {
  const tenantId = "tnt_A";

  it("injects tenantId into reads even when the caller passes no where", () => {
    const db = fakeDb();
    const scoped = tenantScoped(asClient(db), tenantId);
    void scoped.agent.findMany();
    expect(db.calls[0]!.args).toMatchObject({ where: { AND: [{}, { tenantId }] } });
  });

  it("cannot be shadowed by a caller-supplied where.tenantId", () => {
    const db = fakeDb();
    const scoped = tenantScoped(asClient(db), tenantId);
    void scoped.agent.findFirst({ where: { tenantId: "tnt_VICTIM", id: "age_1" } });
    const where = (db.calls[0]!.args as { where: { AND: Record<string, unknown>[] } }).where;
    expect(where.AND).toEqual([{ tenantId: "tnt_VICTIM", id: "age_1" }, { tenantId }]);
    // AND intersection: VICTIM ∧ A can never both hold, so no row is readable.
  });

  it("stamps create data and rejects a foreign tenantId outright", () => {
    const db = fakeDb();
    const scoped = tenantScoped(asClient(db), tenantId);
    void scoped.usageEvent.create({ data: { kind: "MODEL_CALL", tokensUsed: 5 } });
    expect(db.calls[0]!.args).toMatchObject({ data: { tenantId } });
    expect(() => scoped.usageEvent.create({ data: { tenantId: "tnt_VICTIM" } })).toThrow(TenantScopeError);
  });

  it("makes findUnique impossible, not accidentally unscoped", () => {
    const scoped = tenantScoped(asClient(fakeDb()), tenantId);
    expect(() => scoped.agent.findUnique()).toThrow(/use findFirst/);
    expect(() => scoped.agent.findUniqueOrThrow()).toThrow(/use findFirstOrThrow/);
  });

  it("hides models that are not tenant-scoped", () => {
    const scoped = tenantScoped(asClient(fakeDb()), tenantId) as unknown as Record<string, unknown>;
    expect(scoped.plan).toBeUndefined();
    expect(scoped.tenant).toBeUndefined();
  });

  /**
   * The list is a claim about the schema, so it is checked against the schema
   * rather than against someone's memory of it. A new tenant-owned model that
   * misses the list would otherwise surface as a route that can read another
   * tenant's rows — the exact failure this wrapper exists to prevent.
   */
  it("scopes every model that declares a tenantId column", () => {
    const schema = readFileSync(
      fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const declared = modelsWithTenantColumn(schema);
    const scoped = scopedNames(tenantScoped(asClient(fakeDb()), tenantId));

    const missing = declared.filter((model) => !scoped.has(model) && !(model in UNSCOPPED_BY_DESIGN));
    expect(missing, `add to TENANT_SCOPED_MODELS: ${missing.join(", ")}`).toEqual([]);

    // The reverse direction too: a scoped model without a tenant column would
    // make every query on it fail at the database, not leak.
    const foreign = [...scoped].filter((model) => !declared.includes(model));
    expect(foreign, `no tenantId column to inject: ${foreign.join(", ")}`).toEqual([]);
  });
});

/** Models that carry tenantId but must not go through the wrapper, and why. */
const UNSCOPPED_BY_DESIGN: Record<string, string> = {
  webhookEventLog:
    "tenantId is nullable — an inbound request can be logged before its channel resolves to a tenant, and a forced clause would hide those rows from every read",
};

function scopedNames(db: ReturnType<typeof tenantScoped>): Set<string> {
  return new Set(
    Object.keys(db as unknown as Record<string, unknown>).filter((key) => key !== "tenantId" && key !== "$transaction"),
  );
}

function modelsWithTenantColumn(prisma: string): string[] {
  const found: string[] = [];
  for (const block of prisma.split(/\nmodel\s+/).slice(1)) {
    const open = block.indexOf("{");
    const model = block.slice(0, open).trim();
    // The delegate Prisma generates is the model name with a lowercase first
    // letter — `model WebhookEventLog` is reached as `db.webhookEventLog`, and
    // that is the key `TENANT_SCOPED_MODELS` has to carry.
    const delegate = `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
    if (/^\s+tenantId\s+String/m.test(block.slice(open))) found.push(delegate);
  }
  return found;
}
