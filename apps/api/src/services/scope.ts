import type { PrismaClient, Project, Workflow } from "@prisma/client";
import { tenantWhere } from "@saas/db";
import { notFound } from "../http-error.ts";

/**
 * Existence guards — the choke point for scope.
 *
 * Every route that takes an id from the URL resolves it here first, so "this
 * row belongs to the session tenant" is decided in one place instead of at each
 * call site. The answer for a foreign id is a 404 that repeats nothing but the
 * id it was given: a 403, or an error naming the row, would confirm that
 * somebody else's project exists.
 */

export async function requireProject(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
): Promise<Pick<Project, "id" | "tenantId" | "name" | "isDefault">> {
  const row = await db.project.findFirst({
    where: tenantWhere(tenantId, { id: projectId }),
    select: { id: true, tenantId: true, name: true, isDefault: true },
  });
  if (!row) throw notFound("project_not_found", `project ${projectId} is not in this tenant`);
  return row;
}

/**
 * What a project still holds. Only the delete path needs the numbers, so they
 * are deliberately not carried on every project read.
 */
export async function projectContents(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
): Promise<{ agents: number; integrations: number; workflows: number }> {
  const row = await db.project.findFirstOrThrow({
    where: tenantWhere(tenantId, { id: projectId }),
    select: { _count: { select: { agents: true, integrations: true, workflows: true } } },
  });
  return row._count;
}

/**
 * A workflow row, with the graph document included because every mutation of a
 * graph has to read it anyway — the version for the concurrency check, the
 * definition for validation, the projectId for the ownership rule.
 */
export async function requireWorkflow(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
): Promise<Pick<Workflow, "id" | "tenantId" | "projectId" | "name" | "status" | "version" | "definition">> {
  const row = await db.workflow.findFirst({
    where: tenantWhere(tenantId, { id: workflowId }),
    select: { id: true, tenantId: true, projectId: true, name: true, status: true, version: true, definition: true },
  });
  if (!row) throw notFound("workflow_not_found", `workflow ${workflowId} is not in this tenant`);
  return row;
}

/**
 * The name of an ACTIVE workflow that still references a row, through the
 * derived index. This is the guardrail that lets `WorkflowDependency.refId` stay
 * foreign-key-less: deleting an agent must not rewrite a graph, so instead the
 * delete is refused while a live graph depends on it. A DRAFT or PAUSED graph
 * may dangle — validation reports it and activation is blocked.
 */
export async function activeWorkflowUsing(
  db: PrismaClient,
  tenantId: string,
  kind: "AGENT" | "INTEGRATION",
  refId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await db.workflowDependency.findFirst({
    where: { tenantId, kind, refId, workflow: { status: "ACTIVE", tenantId } },
    select: { workflow: { select: { id: true, name: true } } },
  });
  return row ? row.workflow : null;
}
