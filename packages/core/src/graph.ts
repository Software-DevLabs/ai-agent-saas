/**
 * The workflow graph, as data.
 *
 * This module is deliberately pure: no Prisma, no Fastify, no `reply`. It takes
 * a parsed definition plus the database rows the graph points at and answers one
 * question — would running this graph do what the canvas shows? The API and the
 * worker both call it, which is the only way "the console said it was valid" and
 * "the worker ran it" can be the same fact rather than two opinions.
 */

export type NodeKind = "INBOUND" | "AGENT" | "OUTBOUND" | "ORCHESTRATOR";

export interface NodePosition {
  x: number;
  y: number;
}

interface NodeBase {
  /** Canvas-stable key the edges refer to. Never a database id. */
  key: string;
  label?: string;
  position: NodePosition;
}

export interface InboundNode extends NodeBase {
  kind: "INBOUND";
  config: { integrationId: string };
}

export interface AgentNode extends NodeBase {
  kind: "AGENT";
  config: { agentId: string };
}

export interface OutboundNode extends NodeBase {
  kind: "OUTBOUND";
  config: { integrationId: string };
}

/**
 * A declared subagent an orchestrator may delegate to. `role` is the name the
 * model sees in its `subagent` tool, so it must be stable and unique per node.
 */
export interface OrchestratorSubagent {
  agentId: string;
  role: string;
  maxSteps?: number;
}

/**
 * One agent that may call declared subagents through the `subagent` tool. The
 * delegation is depth 1 by construction: subagents are agent ids, never other
 * orchestrators, so a run cannot fan out without bound.
 */
export interface OrchestratorNode extends NodeBase {
  kind: "ORCHESTRATOR";
  config: { agentId: string; subagents: OrchestratorSubagent[] };
}

export type GraphNode = InboundNode | AgentNode | OutboundNode | OrchestratorNode;

export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
}

export interface GraphDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The rows a graph references, widened to the whole tenant so that "this row is
 * gone" and "this row belongs to another project" stay distinguishable — they
 * need different fixes and the user can only see one of them.
 */
export interface AgentRef {
  id: string;
  name: string;
  projectId: string;
}

export interface ChannelRef {
  id: string;
  name: string;
  type: string;
  projectId: string;
  status: string;
}

export interface DependencyRef {
  kind: "AGENT" | "INTEGRATION";
  refId: string;
}

export interface GraphContext {
  projectId: string;
  agents: AgentRef[];
  channels: ChannelRef[];
  /** The stored `WorkflowDependency` index, when there is one to compare with. */
  dependencies?: DependencyRef[];
}

export type IssueLevel = "error" | "warning";

export type IssueCode =
  | "malformed"
  | "duplicate_key"
  | "edge_endpoint_missing"
  | "cycle"
  | "no_entry"
  | "entry_unreachable"
  | "agent_no_sink"
  | "agent_missing"
  | "agent_outside_project"
  | "orchestrator_missing"
  | "orchestrator_outside_project"
  | "orchestrator_no_sink"
  | "orchestrator_too_many"
  | "subagent_missing"
  | "subagent_outside_project"
  | "subagent_duplicate"
  | "subagent_self"
  | "subagent_role_invalid"
  | "subagent_too_many"
  | "channel_missing"
  | "channel_outside_project"
  | "channel_direction_mismatch"
  | "channel_not_connected"
  | "too_many_agents"
  | "orphan_node"
  | "dependency_drift";

export interface GraphIssue {
  code: IssueCode;
  level: IssueLevel;
  /** Dotted path into the definition, so the console can point at the field. */
  path?: string;
  nodeKey?: string;
  message: string;
}

export interface GraphReport {
  ok: boolean;
  issues: GraphIssue[];
  /** Node keys in execution order; empty when the graph contains a cycle. */
  order: string[];
  entryKeys: string[];
}

export const MAX_NODES = 60;
export const MAX_EDGES = 140;
/** Five model calls is already a slow, expensive graph, and the lease arithmetic
 *  behind D7 is sized around this cap — it is a limit, not a suggestion. */
export const MAX_AGENT_NODES = 5;
/** One orchestrator per graph: each turn fans out, and two of them in a row
 *  multiplies the bill without adding a capability. */
export const MAX_ORCHESTRATORS = 1;
/** Delegation is depth 1 and each declared subagent is a real agent call. */
export const MAX_SUBAGENTS = 6;
export const MAX_SUBAGENT_STEPS = 4;
/** The model sees this as the tool name, so it has to look like one. */
export const SUBAGENT_ROLE_PATTERN = /^[a-z][a-z0-9_-]{1,30}$/;
/** A joined fan-in prompt is capped so one chatty upstream cannot swallow the
 *  model's context window. The truncation is reported, never silent. */
export const MAX_JOINED_INPUT = 4_000;

const KINDS: readonly NodeKind[] = ["INBOUND", "AGENT", "OUTBOUND", "ORCHESTRATOR"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type Reject = (path: string, message: string) => void;

/**
 * Structural parse of an orchestrator's declared subagents. Shape problems are
 * `malformed` (nothing semantic can be judged); semantic problems — role syntax,
 * duplicates, a missing agent — are reported by `analyseGraph` with their own
 * codes. The count cap is also left to `analyseGraph` so the console gets the
 * specific `subagent_too_many` code rather than a parse failure.
 */
function readSubagents(raw: unknown, path: string, reject: Reject): OrchestratorSubagent[] | null {
  if (!Array.isArray(raw)) {
    reject(path, "subagents must be an array of { agentId, role, maxSteps? }");
    return null;
  }
  const subagents: OrchestratorSubagent[] = [];
  for (const [index, entry] of raw.entries()) {
    const subPath = `${path}.${index}`;
    if (!isRecord(entry)) {
      reject(subPath, "each subagent must be an object with agentId and role");
      return null;
    }
    const agentId = typeof entry.agentId === "string" ? entry.agentId.trim() : "";
    if (agentId === "") {
      reject(`${subPath}.agentId`, "agentId is required");
      return null;
    }
    const role = typeof entry.role === "string" ? entry.role.trim() : "";
    if (role === "") {
      reject(`${subPath}.role`, "role is required");
      return null;
    }
    let maxSteps: number | undefined;
    if (entry.maxSteps !== undefined) {
      if (!finiteNumber(entry.maxSteps) || !Number.isInteger(entry.maxSteps) || entry.maxSteps < 1 || entry.maxSteps > MAX_SUBAGENT_STEPS) {
        reject(`${subPath}.maxSteps`, `maxSteps must be a whole number from 1 to ${MAX_SUBAGENT_STEPS}`);
        return null;
      }
      maxSteps = entry.maxSteps;
    }
    subagents.push(maxSteps === undefined ? { agentId, role } : { agentId, role, maxSteps });
  }
  return subagents;
}

/**
 * The trusted re-parse of the `definition` Json column. The API's zod schema
 * guards the request body; this guards everything already in the database,
 * written by an older build or edited by hand. It collects every problem rather
 * than stopping at the first, because a half-explained graph is worse than a
 * fully rejected one.
 */
export function readGraph(raw: unknown): { graph: GraphDefinition | null; issues: GraphIssue[] } {
  const issues: GraphIssue[] = [];
  const reject = (path: string, message: string) => {
    issues.push({ code: "malformed", level: "error", path, message });
  };

  if (!isRecord(raw)) {
    reject("", "the definition must be an object with nodes and edges");
    return { graph: null, issues };
  }

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes)) {
    reject("nodes", "nodes must be an array");
  } else {
    if (rawNodes.length > MAX_NODES) reject("nodes", `a graph holds at most ${MAX_NODES} nodes, this one has ${rawNodes.length}`);
    rawNodes.forEach((entry, index) => {
      const path = `nodes.${index}`;
      if (!isRecord(entry)) {
        reject(path, "each node must be an object");
        return;
      }
      const key = entry.key;
      if (typeof key !== "string" || key.trim() === "") {
        reject(`${path}.key`, "a node needs a non-empty key the edges can refer to");
        return;
      }
      if (key.length > 60) reject(`${path}.key`, "a node key is at most 60 characters");
      if (seen.has(key)) {
        issues.push({ code: "duplicate_key", level: "error", path: `${path}.key`, nodeKey: key, message: `node key "${key}" is used twice` });
        return;
      }
      seen.add(key);

      const kind = entry.kind;
      if (typeof kind !== "string" || !KINDS.includes(kind as NodeKind)) {
        reject(`${path}.kind`, `kind must be one of ${KINDS.join(", ")}`);
        return;
      }
      const position = entry.position;
      if (!isRecord(position) || !finiteNumber(position.x) || !finiteNumber(position.y)) {
        reject(`${path}.position`, "position needs finite x and y");
        return;
      }
      const config = entry.config;
      if (!isRecord(config)) {
        reject(`${path}.config`, "config must be an object");
        return;
      }
      // The id a node carries is decided by its kind, so an inbound node cannot
      // also claim an agentId that a later reader might prefer.
      const wanted = kind === "AGENT" || kind === "ORCHESTRATOR" ? "agentId" : "integrationId";
      const ref = config[wanted];
      if (typeof ref !== "string" || ref.trim() === "") {
        reject(`${path}.config.${wanted}`, `${wanted} is required`);
        return;
      }
      const label = typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label : undefined;
      const placed = { x: position.x, y: position.y };

      if (kind === "ORCHESTRATOR") {
        const subagents = readSubagents(config.subagents, `${path}.config.subagents`, reject);
        if (subagents === null) return;
        nodes.push({ key, kind: "ORCHESTRATOR", label, position: placed, config: { agentId: ref, subagents } });
        return;
      }
      nodes.push(
        kind === "AGENT"
          ? { key, kind: "AGENT", label, position: placed, config: { agentId: ref } }
          : {
              key,
              kind: kind === "INBOUND" ? "INBOUND" : "OUTBOUND",
              label,
              position: placed,
              config: { integrationId: ref },
            },
      );
    });
  }

  const edges: GraphEdge[] = [];
  const rawEdges = raw.edges;
  if (!Array.isArray(rawEdges)) {
    reject("edges", "edges must be an array");
  } else {
    if (rawEdges.length > MAX_EDGES) reject("edges", `a graph holds at most ${MAX_EDGES} edges, this one has ${rawEdges.length}`);
    rawEdges.forEach((entry, index) => {
      const path = `edges.${index}`;
      if (!isRecord(entry)) {
        reject(path, "each edge must be an object");
        return;
      }
      const from = typeof entry.from === "string" ? entry.from.trim() : "";
      const to = typeof entry.to === "string" ? entry.to.trim() : "";
      if (from === "" || to === "") {
        reject(path, "an edge needs both a from and a to node key");
        return;
      }
      const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined;
      edges.push(id === undefined ? { from, to } : { id, from, to });
    });
  }

  if (issues.length > 0) return { graph: null, issues };
  return { graph: { nodes, edges }, issues };
}

/** Direction comes from the channel type's own name, so a new connector cannot
 *  arrive without one — an unrecognised suffix is reported, not assumed. */
export function channelDirection(type: string): "INPUT" | "OUTPUT" | null {
  if (type.endsWith("_IN")) return "INPUT";
  if (type.endsWith("_OUT")) return "OUTPUT";
  return null;
}

/**
 * Kahn's algorithm, with the ready list kept sorted by node key. The sort is the
 * point: without it the order depends on insertion, which depends on how the
 * canvas happened to be dragged, and two visually identical graphs would run
 * their agents in different sequences.
 */
export function topoOrder(graph: GraphDefinition): { order: string[]; cyclic: string[] } {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.key, 0);
    outgoing.set(node.key, []);
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift() as string;
    order.push(key);
    for (const next of outgoing.get(key) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
    ready.sort();
  }
  const done = new Set(order);
  return { order, cyclic: [...indegree.keys()].filter((key) => !done.has(key)).sort() };
}

/** Every node reachable from `start` over outgoing edges, `start` included. */
function downstreamOf(graph: GraphDefinition, start: string): Set<string> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      if (frontier.includes(edge.from) && !seen.has(edge.to)) {
        seen.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return seen;
}

const displayName = (node: GraphNode | undefined, key: string): string => node?.label ?? node?.key ?? key;

/**
 * The full rule set. `level` separates "this graph can never run" from "this
 * part is unfinished", which is what lets a draft save while activation is
 * still refused.
 */
export function analyseGraph(graph: GraphDefinition, context: GraphContext): GraphReport {
  const issues: GraphIssue[] = [];
  const push = (issue: GraphIssue) => issues.push(issue);

  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));

  // --- structure -----------------------------------------------------------
  graph.edges.forEach((edge, index) => {
    if (!byKey.has(edge.from)) {
      push({
        code: "edge_endpoint_missing",
        level: "error",
        path: `edges.${index}.from`,
        message: `edge ${index} starts at "${edge.from}", which is not a node in this graph`,
      });
    }
    if (!byKey.has(edge.to)) {
      push({
        code: "edge_endpoint_missing",
        level: "error",
        path: `edges.${index}.to`,
        message: `edge ${index} ends at "${edge.to}", which is not a node in this graph`,
      });
    }
    if (edge.from === edge.to) {
      push({
        code: "cycle",
        level: "error",
        nodeKey: edge.from,
        path: `edges.${index}`,
        message: `"${displayName(byKey.get(edge.from), edge.from)}" cannot feed itself`,
      });
    }
  });

  const { order, cyclic } = topoOrder(graph);
  if (cyclic.length > 0 && !issues.some((issue) => issue.code === "cycle")) {
    push({
      code: "cycle",
      level: "error",
      message: `these nodes form a loop, and a loop cannot run: ${cyclic.join(" → ")}. Each node runs once per run.`,
    });
  }

  // --- references ----------------------------------------------------------
  const agentsById = new Map(context.agents.map((agent) => [agent.id, agent]));
  const channelsById = new Map(context.channels.map((channel) => [channel.id, channel]));
  let agentNodes = 0;
  let orchestrators = 0;

  graph.nodes.forEach((node, index) => {
    const path = `nodes.${index}`;
    if (node.kind === "AGENT" || node.kind === "ORCHESTRATOR") {
      // An orchestrator is a model call too, so it spends the same budget.
      agentNodes += 1;
      const agent = agentsById.get(node.config.agentId);
      if (node.kind === "ORCHESTRATOR") {
        orchestrators += 1;
        if (!agent) {
          push({
            code: "orchestrator_missing",
            level: "error",
            path: `${path}.config.agentId`,
            nodeKey: node.key,
            message: `orchestrator "${displayName(node, node.key)}" points at an agent that no longer exists`,
          });
        } else if (agent.projectId !== context.projectId) {
          push({
            code: "orchestrator_outside_project",
            level: "error",
            path: `${path}.config.agentId`,
            nodeKey: node.key,
            message: `agent "${agent.name}" belongs to another project, so this graph may not run it`,
          });
        }
        if (node.config.subagents.length > MAX_SUBAGENTS) {
          push({
            code: "subagent_too_many",
            level: "error",
            path: `${path}.config.subagents`,
            nodeKey: node.key,
            message: `${node.config.subagents.length} declared subagents is past the limit of ${MAX_SUBAGENTS} per orchestrator`,
          });
        }
        const roles = new Set<string>();
        node.config.subagents.forEach((sub, subIndex) => {
          const subPath = `${path}.config.subagents.${subIndex}`;
          if (!SUBAGENT_ROLE_PATTERN.test(sub.role)) {
            push({
              code: "subagent_role_invalid",
              level: "error",
              path: `${subPath}.role`,
              nodeKey: node.key,
              message: `role "${sub.role}" must be 2–31 lowercase letters, digits, "_" or "-", starting with a letter`,
            });
          } else if (roles.has(sub.role)) {
            push({
              code: "subagent_duplicate",
              level: "error",
              path: `${subPath}.role`,
              nodeKey: node.key,
              message: `role "${sub.role}" is declared twice, so the model could not tell the two delegations apart`,
            });
          }
          roles.add(sub.role);
          if (sub.agentId === node.config.agentId) {
            push({
              code: "subagent_self",
              level: "error",
              path: `${subPath}.agentId`,
              nodeKey: node.key,
              message: `"${displayName(node, node.key)}" lists itself as subagent "${sub.role}" — delegation is depth 1 and never into itself`,
            });
          } else {
            const subAgent = agentsById.get(sub.agentId);
            if (!subAgent) {
              push({
                code: "subagent_missing",
                level: "error",
                path: `${subPath}.agentId`,
                nodeKey: node.key,
                message: `subagent "${sub.role}" points at an agent that no longer exists`,
              });
            } else if (subAgent.projectId !== context.projectId) {
              push({
                code: "subagent_outside_project",
                level: "error",
                path: `${subPath}.agentId`,
                nodeKey: node.key,
                message: `subagent "${sub.role}" (${subAgent.name}) belongs to another project`,
              });
            }
          }
        });
        return;
      }
      if (!agent) {
        push({
          code: "agent_missing",
          level: "error",
          path: `${path}.config.agentId`,
          nodeKey: node.key,
          message: `agent node "${displayName(node, node.key)}" points at an agent that no longer exists`,
        });
      } else if (agent.projectId !== context.projectId) {
        push({
          code: "agent_outside_project",
          level: "error",
          path: `${path}.config.agentId`,
          nodeKey: node.key,
          message: `agent "${agent.name}" belongs to another project, so this graph may not run it`,
        });
      }
      return;
    }

    const channel = channelsById.get(node.config.integrationId);
    if (!channel) {
      push({
        code: "channel_missing",
        level: "error",
        path: `${path}.config.integrationId`,
        nodeKey: node.key,
        message: `"${displayName(node, node.key)}" points at a connection that no longer exists`,
      });
      return;
    }
    if (channel.projectId !== context.projectId) {
      push({
        code: "channel_outside_project",
        level: "error",
        path: `${path}.config.integrationId`,
        nodeKey: node.key,
        message: `connection "${channel.name}" belongs to another project`,
      });
      return;
    }

    const direction = channelDirection(channel.type);
    const expected = node.kind === "INBOUND" ? "INPUT" : "OUTPUT";
    if (direction === null) {
      push({
        code: "channel_direction_mismatch",
        level: "error",
        path: `${path}.config.integrationId`,
        nodeKey: node.key,
        message: `connection type "${channel.type}" does not say whether it receives or sends`,
      });
    } else if (direction !== expected) {
      push({
        code: "channel_direction_mismatch",
        level: "error",
        path: `${path}.kind`,
        nodeKey: node.key,
        message: `"${channel.name}" ${direction === "INPUT" ? "receives messages" : "is written to"}, so it cannot act as ${node.kind === "INBOUND" ? "an inbound trigger" : "an outbound sink"}`,
      });
    }

    if (channel.status !== "CONNECTED") {
      push({
        code: "channel_not_connected",
        level: "error",
        nodeKey: node.key,
        message: `"${channel.name}" is ${channel.status.toLowerCase()}, so nothing would actually arrive or leave through it`,
      });
    }
  });

  if (agentNodes > MAX_AGENT_NODES) {
    push({
      code: "too_many_agents",
      level: "error",
      message: `${agentNodes} agent nodes is past the limit of ${MAX_AGENT_NODES} per graph`,
    });
  }

  if (orchestrators > MAX_ORCHESTRATORS) {
    push({
      code: "orchestrator_too_many",
      level: "error",
      message: `${orchestrators} orchestrators in one graph is past the limit of ${MAX_ORCHESTRATORS}: each turn fans out, so several multiply the bill without adding a capability`,
    });
  }

  // --- wiring --------------------------------------------------------------
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const node of graph.nodes) {
    incoming.set(node.key, 0);
    outgoing.set(node.key, 0);
  }
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const entryKeys = graph.nodes
    .filter((node) => node.kind === "INBOUND" && (incoming.get(node.key) ?? 0) === 0)
    .map((node) => node.key);

  if (graph.nodes.length > 0 && entryKeys.length === 0) {
    push({
      code: "no_entry",
      level: "error",
      message: "nothing triggers this graph: it needs an inbound channel node with no wires coming into it",
    });
  }

  for (const node of graph.nodes) {
    if ((incoming.get(node.key) ?? 0) + (outgoing.get(node.key) ?? 0) === 0) {
      push({ code: "orphan_node", level: "warning", nodeKey: node.key, message: `"${displayName(node, node.key)}" is not wired to anything` });
    }
  }

  for (const node of graph.nodes) {
    if (node.kind === "INBOUND") {
      const reachable = downstreamOf(graph, node.key);
      const feedsAgent = graph.nodes.some(
        (other) => (other.kind === "AGENT" || other.kind === "ORCHESTRATOR") && other.key !== node.key && reachable.has(other.key),
      );
      if (!feedsAgent) {
        push({
          code: "entry_unreachable",
          level: "error",
          nodeKey: node.key,
          message: `"${displayName(node, node.key)}" has no agent downstream of it, so a message arriving here would be dropped`,
        });
      }
    }
    if (node.kind === "AGENT" || node.kind === "ORCHESTRATOR") {
      const reachable = downstreamOf(graph, node.key);
      const feedsSink = graph.nodes.some((other) => other.kind === "OUTBOUND" && other.key !== node.key && reachable.has(other.key));
      if (!feedsSink) {
        push(
          node.kind === "ORCHESTRATOR"
            ? {
                code: "orchestrator_no_sink",
                level: "error",
                nodeKey: node.key,
                message: `"${displayName(node, node.key)}" has no outbound node downstream of it, so its answer would go nowhere`,
              }
            : {
                code: "agent_no_sink",
                level: "error",
                nodeKey: node.key,
                message: `"${displayName(node, node.key)}" has no outbound node downstream of it, so its reply would go nowhere`,
              },
        );
      }
    }
  }

  // --- the derived index ---------------------------------------------------
  if (context.dependencies) {
    const expected = new Set(dependenciesOf(graph).map((dep) => `${dep.kind}:${dep.refId}`));
    const stored = new Set(context.dependencies.map((dep) => `${dep.kind}:${dep.refId}`));
    const missing = [...expected].filter((key) => !stored.has(key));
    const stale = [...stored].filter((key) => !expected.has(key));
    if (missing.length > 0 || stale.length > 0) {
      push({
        code: "dependency_drift",
        level: "error",
        message: `the stored reference index no longer matches the graph${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}${stale.length > 0 ? ` (stale ${stale.join(", ")})` : ""}. Saving the graph again rebuilds it.`,
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.level === "warning"),
    issues,
    order: cyclic.length > 0 ? [] : order,
    entryKeys,
  };
}

/** The rows that belong in `WorkflowDependency` for this definition. */
export function dependenciesOf(graph: GraphDefinition): DependencyRef[] {
  const refs = new Map<string, DependencyRef>();
  for (const node of graph.nodes) {
    if (node.kind === "AGENT") {
      refs.set(`AGENT:${node.config.agentId}`, { kind: "AGENT", refId: node.config.agentId });
    } else if (node.kind === "ORCHESTRATOR") {
      // The orchestrator agent and every declared subagent are real references:
      // deleting one must show up as drift, not as a run that fails later.
      refs.set(`AGENT:${node.config.agentId}`, { kind: "AGENT", refId: node.config.agentId });
      for (const sub of node.config.subagents) {
        refs.set(`AGENT:${sub.agentId}`, { kind: "AGENT", refId: sub.agentId });
      }
    } else {
      refs.set(`INTEGRATION:${node.config.integrationId}`, { kind: "INTEGRATION", refId: node.config.integrationId });
    }
  }
  return [...refs.values()].sort((a, b) => `${a.kind}:${a.refId}`.localeCompare(`${b.kind}:${b.refId}`));
}

export interface JoinedInput {
  text: string;
  truncated: boolean;
}

/** A fan-in node sees every upstream output. The cap covers the separators too,
 *  so the joined text is never longer than the limit it was given, and
 *  `truncated` says out loud that something was cut rather than losing it
 *  quietly. */
export function joinInputs(chunks: string[], limit = MAX_JOINED_INPUT): JoinedInput {
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const chunk of chunks) {
    const body = chunk.trim();
    if (body === "") continue;
    const separator = kept.length > 0 ? 2 : 0;
    const room = limit - used - separator;
    if (room <= 0) {
      truncated = true;
      continue;
    }
    if (body.length > room) {
      kept.push(body.slice(0, room));
      truncated = true;
      break;
    }
    kept.push(body);
    used += separator + body.length;
  }
  return { text: kept.join("\n\n"), truncated };
}

/** The issues that stop a graph from being activated. */
export const activationBlockers = (report: GraphReport): GraphIssue[] =>
  report.issues.filter((issue) => issue.level === "error");
