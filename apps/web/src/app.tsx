import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import {
  AgentDetailPage,
  AgentsPage,
  BillingPage,
  ConnectionsPage,
  NotFoundPage,
  OverviewPage,
  PlaygroundPage,
  ProjectDetailPage,
  ProjectsPage,
  RunsPage,
  SettingsPage,
  SkillsPage,
  UsagePage,
  WorkflowCanvasPage,
} from "@/lib/page-loaders";

/**
 * Routes only. Every page is a `lazy()` component from `page-loaders`, so this
 * module stays tiny and the shell paints immediately; the shared Suspense
 * fallback lives inside `AppShell`, beside the `Outlet` it replaces.
 */
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:projectId/workflows/:workflowId" element={<WorkflowCanvasPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
