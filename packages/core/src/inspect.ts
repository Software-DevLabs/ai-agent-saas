import type { PrismaClient } from "@prisma/client";
import { activationBlockers, analyseGraph, readGraph, type GraphContext, type GraphDefinition, type GraphIssue, type GraphReport } from "./graph.ts";

/**
 * The one place a stored graph is judged, shared by the console and the worker.
 *
 * It re-reads the `definition` column through `readGraph` rather than trusting
 * what is in it, because that column can hold a document written by an older
 * build, and it compares the derived reference index against what the graph now
 * says it needs. "The console said it was valid" and "the worker ran it" are one
 * fact decided here — two implementations of that judgement is how a graph
 * starts passing on screen and failing in the queue.
 */

export interface Inspection {
  /** Null when the stored document is not readable at all. */
  graph: GraphDefinition | null;
  report: GraphReport;
  /** The subset of `report.issues` that makes the graph un-runnable. */
  blockers: GraphIssue[];
}

/** The workflow row, narrowed to what judging a graph actually needs. */
export interface WorkflowRow {
  id: string;
  projectId: string;
  definition: unknown;
}

/**
 * The rows `analyseGraph` needs. Read tenant-wide rather than project-scoped on
 * purpose: a project-scoped query would make "this agent belongs to another
 * project" indistinguishable from "this agent was deleted", and those two need
 * different fixes.
 */
export async function graphContext(db: PrismaClient, tenantId: string, projectId: string): Promise<GraphContext> {
  const [agents, integrations] = await Promise.all([
    db.agent.findMany({ where: { tenantId }, select: { id: true, name: true, projectId: true }, orderBy: { name: "asc" } }),
    db.integration.findMany({
      where: { tenantId },
      select: { id: true, type: true, externalId: true, projectId: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return {
    projectId,
    agents,
    channels: integrations.map((row) => ({
      id: row.id,
      name: row.externalId ? `${row.type} · ${row.externalId}` : row.type,
      type: row.type,
      projectId: row.projectId,
      status: row.status,
    })),
  };
}

export async function inspectWorkflow(db: PrismaClient, tenantId: string, workflow: WorkflowRow): Promise<Inspection> {
  const parsed = readGraph(workflow.definition);
  // Everything `readGraph` rejects is an error by construction: a document that
  // cannot be parsed has no warnings to soften it.
  if (!parsed.graph) {
    return { graph: null, report: { ok: false, issues: parsed.issues, order: [], entryKeys: [] }, blockers: parsed.issues };
  }
  const [context, stored] = await Promise.all([
    graphContext(db, tenantId, workflow.projectId),
    db.workflowDependency.findMany({
      where: { AND: [{ workflowId: workflow.id }, { tenantId }] },
      select: { kind: true, refId: true },
    }),
  ]);
  const analysed = analyseGraph(parsed.graph, {
    ...context,
    dependencies: stored.map((row) => ({ kind: row.kind, refId: row.refId })),
  });
  return {
    graph: parsed.graph,
    report: { ok: analysed.ok, issues: analysed.issues, order: analysed.order, entryKeys: analysed.entryKeys },
    blockers: activationBlockers(analysed),
  };
}
