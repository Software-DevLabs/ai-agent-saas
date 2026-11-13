import { lazy } from "react";

/**
 * One map from route to dynamic import, shared by the router and the prefetcher.
 *
 * Every page is split into its own chunk; the canvas chunk is the only one that
 * carries React Flow, so opening the overview no longer pays for the editor.
 * `prefetchRoute` warms the chunk on nav hover/focus — by the time the click
 * lands, the module is already in memory.
 */
export const pageLoaders = {
  overview: () => import("@/pages/overview"),
  projects: () => import("@/pages/projects"),
  projectDetail: () => import("@/pages/project-detail"),
  workflowCanvas: () => import("@/pages/workflow-canvas"),
  agents: () => import("@/pages/agents"),
  agentDetail: () => import("@/pages/agent-detail"),
  skills: () => import("@/pages/skills"),
  connections: () => import("@/pages/connections"),
  runs: () => import("@/pages/runs"),
  usage: () => import("@/pages/usage"),
  playground: () => import("@/pages/playground"),
  billing: () => import("@/pages/billing"),
  settings: () => import("@/pages/settings"),
  notFound: () => import("@/pages/not-found"),
} as const;

export const OverviewPage = lazy(pageLoaders.overview);
export const ProjectsPage = lazy(pageLoaders.projects);
export const ProjectDetailPage = lazy(pageLoaders.projectDetail);
export const WorkflowCanvasPage = lazy(pageLoaders.workflowCanvas);
export const AgentsPage = lazy(pageLoaders.agents);
export const AgentDetailPage = lazy(pageLoaders.agentDetail);
export const SkillsPage = lazy(pageLoaders.skills);
export const ConnectionsPage = lazy(pageLoaders.connections);
export const RunsPage = lazy(pageLoaders.runs);
export const UsagePage = lazy(pageLoaders.usage);
export const PlaygroundPage = lazy(pageLoaders.playground);
export const BillingPage = lazy(pageLoaders.billing);
export const SettingsPage = lazy(pageLoaders.settings);
export const NotFoundPage = lazy(pageLoaders.notFound);

/** The chunk a path will need, without loading it twice when the click follows. */
export function prefetchRoute(pathname: string): void {
  const [root, second, third] = pathname.split("/").filter(Boolean);
  if (!root) return void pageLoaders.overview();
  if (root === "projects") {
    if (second && third === "workflows") return void pageLoaders.workflowCanvas();
    return void (second ? pageLoaders.projectDetail() : pageLoaders.projects());
  }
  if (root === "agents") return void (second ? pageLoaders.agentDetail() : pageLoaders.agents());
  if (root === "skills") return void pageLoaders.skills();
  if (root === "connections") return void pageLoaders.connections();
  if (root === "runs") return void pageLoaders.runs();
  if (root === "usage") return void pageLoaders.usage();
  if (root === "playground") return void pageLoaders.playground();
  if (root === "billing") return void pageLoaders.billing();
  if (root === "settings") return void pageLoaders.settings();
  return void pageLoaders.notFound();
}
