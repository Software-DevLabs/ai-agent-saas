import { createContext } from "react";
import type { Edge, Node } from "@xyflow/react";
import type {
  GraphDefinition,
  GraphNode,
  IssueLevel,
  NodeKind,
  OrchestratorSubagent,
  WorkflowNodeRun,
} from "./domain";

/**
 * The seam between the stored document and what the canvas renders.
 *
 * A node's flow id IS its graph key, and an edge's flow id IS the id written
 * back into the document, so a round trip through the editor cannot invent or
 * lose an identity — which is the only way a server message about
 * `nodes.2.config.agentId` can be pointed at the box on screen.
 *
 * Display names are deliberately NOT stored on the node. They are looked up when
 * the node paints, through the context below, so a renamed agent reads correctly
 * the moment the project's rows reload instead of keeping whatever string was
 * copied into the canvas at load time.
 */

/**
 * A type alias, not an interface: React Flow constrains `Node.data` to
 * `Record<string, unknown>`, and an interface has no implicit index signature,
 * so declaring this one with the `interface` keyword fails that constraint.
 */
export type FlowNodeData = {
  kind: NodeKind;
  /** The agentId or integrationId this node references. Never a display string. */
  refId: string;
  /** What the user typed as a label. Empty means "show the row's own name". */
  label: string;
  /**
   * ORCHESTRATOR only: the declared specialists, held here so an autosave round
   * trip cannot drop them. Empty for every other kind.
   */
  subagents: OrchestratorSubagent[];
};

/**
 * React Flow's `Node.data` is an open record, so the shape is pinned here rather
 * than cast at every read. The custom node component still reads it through
 * `readFlowData`, because it is handed the generic `NodeProps`.
 */
export type FlowNode = Node<FlowNodeData>;

export interface RefInfo {
  name: string;
  meta: string;
  channelType: string | null;
}

export interface CanvasContextValue {
  /** Null when the id points at a row this tenant no longer has. */
  ref: (refId: string, kind: NodeKind) => RefInfo | null;
  /** The worst level reported for a node key, or null when nothing named it. */
  level: (key: string) => IssueLevel | null;
  /** This key's row in the run the console is watching, or null outside a run. */
  runNode: (key: string) => WorkflowNodeRun | null;
}

export const CanvasContext = createContext<CanvasContextValue>({
  ref: () => null,
  level: () => null,
  runNode: () => null,
});

export function readFlowData(node: FlowNode): FlowNodeData {
  return node.data;
}

export function toFlow(graph: GraphDefinition): FlowNode[] {
  return graph.nodes.map((node) => {
    const data: FlowNodeData = {
      kind: node.kind,
      refId:
        node.kind === "INBOUND" || node.kind === "OUTBOUND" ? node.config.integrationId : node.config.agentId,
      label: node.label ?? "",
      subagents: node.kind === "ORCHESTRATOR" ? node.config.subagents.map((sub) => ({ ...sub })) : [],
    };
    return { id: node.key, type: "saas", position: { x: node.position.x, y: node.position.y }, data };
  });
}

/** The document's cables, drawn as the port's own bezier edges. */
export function toFlowEdges(graph: GraphDefinition): Edge[] {
  return graph.edges.map((edge, index) => ({
    id: edge.id ?? `e_${edge.from}_${edge.to}_${index}`,
    source: edge.from,
    target: edge.to,
    type: "flow",
  }));
}

/** The document as the API wants it: keys, kinds, ids, positions — nothing else. */
export function toDefinition(nodes: FlowNode[], edges: Edge[]): GraphDefinition {
  return {
    nodes: nodes.map((node): GraphNode => {
      const data = readFlowData(node);
      const label = data.label.trim() === "" ? undefined : data.label.trim();
      const position = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
      if (data.kind === "AGENT") {
        return { key: node.id, kind: "AGENT", label, position, config: { agentId: data.refId } };
      }
      if (data.kind === "ORCHESTRATOR") {
        return {
          key: node.id,
          kind: "ORCHESTRATOR",
          label,
          position,
          config: {
            agentId: data.refId,
            subagents: data.subagents.map((sub) => ({
              agentId: sub.agentId,
              role: sub.role,
              ...(sub.maxSteps === undefined ? {} : { maxSteps: sub.maxSteps }),
            })),
          },
        };
      }
      return { key: node.id, kind: data.kind, label, position, config: { integrationId: data.refId } };
    }),
    edges: edges.map((edge) => ({ id: edge.id, from: edge.source, to: edge.target })),
  };
}

/**
 * Keys are readable and unique by prefix — `agent-3` inside a validation message
 * is a box the user can find, which a cuid would not be.
 */
export function nextNodeKey(nodes: FlowNode[], kind: NodeKind): string {
  const prefix =
    kind === "AGENT" ? "agent" : kind === "INBOUND" ? "in" : kind === "ORCHESTRATOR" ? "orch" : "out";
  let highest = 0;
  for (const node of nodes) {
    if (readFlowData(node).kind !== kind) continue;
    const suffix = Number.parseInt(node.id.slice(prefix.length + 1), 10);
    if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
  }
  return `${prefix}-${highest + 1}`;
}

/**
 * An edge id is `from`+`to`, so a second cable between the same pair collides.
 * That is the behaviour the canvas wants: two identical cables would claim a
 * graph runs one node twice, which the schema's own `@@unique([runId, nodeKey])`
 * says it cannot do.
 */
export function edgeId(from: string, to: string): string {
  return `e_${from}_${to}`;
}

export const KIND_LABEL: Record<NodeKind, string> = {
  INBOUND: "Channel in",
  AGENT: "Agent",
  OUTBOUND: "Channel out",
  ORCHESTRATOR: "Orchestrator",
};
