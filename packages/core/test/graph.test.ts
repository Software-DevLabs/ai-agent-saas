import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_NODES,
  MAX_JOINED_INPUT,
  MAX_SUBAGENTS,
  MAX_SUBAGENT_STEPS,
  activationBlockers,
  analyseGraph,
  channelDirection,
  dependenciesOf,
  joinInputs,
  readGraph,
  topoOrder,
  type AgentRef,
  type ChannelRef,
  type GraphDefinition,
  type GraphEdge,
  type GraphNode,
  type IssueCode,
} from "../src/graph.ts";

const agent = (key: string, agentId = "agt_1", label?: string): GraphNode => ({
  key,
  kind: "AGENT",
  ...(label === undefined ? {} : { label }),
  position: { x: 0, y: 0 },
  config: { agentId },
});

const inbound = (key: string, integrationId = "int_in", label?: string): GraphNode => ({
  key,
  kind: "INBOUND",
  ...(label === undefined ? {} : { label }),
  position: { x: 0, y: 0 },
  config: { integrationId },
});

const outbound = (key: string, integrationId = "int_out", label?: string): GraphNode => ({
  key,
  kind: "OUTBOUND",
  ...(label === undefined ? {} : { label }),
  position: { x: 0, y: 0 },
  config: { integrationId },
});

const edge = (from: string, to: string): GraphEdge => ({ from, to });

const graph = (nodes: GraphNode[], edges: GraphEdge[]): GraphDefinition => ({ nodes, edges });

const agents: AgentRef[] = [
  { id: "agt_1", name: "Support triage", projectId: "prj_one" },
  { id: "agt_2", name: "Elsewhere", projectId: "prj_other" },
  { id: "agt_3", name: "Second in project", projectId: "prj_one" },
];

const channels: ChannelRef[] = [
  { id: "int_in", name: "Telegram bot", type: "TELEGRAM_IN", projectId: "prj_one", status: "CONNECTED" },
  { id: "int_out", name: "Reply webhook", type: "WEBHOOK_OUT", projectId: "prj_one", status: "CONNECTED" },
  { id: "int_other", name: "Other sheet", type: "SHEETS_OUT", projectId: "prj_other", status: "CONNECTED" },
  { id: "int_revoked", name: "Dead bot", type: "TELEGRAM_IN", projectId: "prj_one", status: "REVOKED" },
];

const context = (over: Partial<Parameters<typeof analyseGraph>[1]> = {}) => ({
  projectId: "prj_one",
  agents,
  channels,
  ...over,
});

const codes = (definition: GraphDefinition, over: Partial<Parameters<typeof analyseGraph>[1]> = {}): IssueCode[] =>
  analyseGraph(definition, context(over)).issues.map((issue) => issue.code);

const valid = graph([inbound("in"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]);

describe("readGraph", () => {
  it("accepts a well-formed definition and keeps only the id each kind uses", () => {
    const parsed = readGraph({
      nodes: [
        { key: "in", kind: "INBOUND", position: { x: 10, y: 20 }, config: { integrationId: "int_in" } },
        { key: "a", kind: "AGENT", label: "Triage", position: { x: 1, y: 2 }, config: { agentId: "agt_1" } },
      ],
      edges: [{ from: "in", to: "a" }],
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.graph?.nodes[1]).toEqual({
      key: "a",
      kind: "AGENT",
      label: "Triage",
      position: { x: 1, y: 2 },
      config: { agentId: "agt_1" },
    });
  });

  it("names the field when the shape is wrong instead of guessing", () => {
    const parsed = readGraph({
      nodes: [
        { key: "in", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: "int_in" } },
        { key: "a", kind: "AGENT", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    expect(parsed.graph).toBeNull();
    expect(parsed.issues[0]).toMatchObject({ code: "malformed", path: "nodes.1.config.agentId", level: "error" });
    expect(parsed.issues[0]?.message).toContain("agentId is required");
  });

  it("rejects a duplicate key, a NaN position and an unknown kind", () => {
    expect(readGraph({ nodes: [{ key: "a", kind: "AGENT", position: { x: 0, y: 0 }, config: { agentId: "x" } }, { key: "a", kind: "AGENT", position: { x: 0, y: 0 }, config: { agentId: "y" } }], edges: [] }).issues[0]?.code).toBe("duplicate_key");
    expect(readGraph({ nodes: [{ key: "a", kind: "AGENT", position: { x: Number.NaN, y: 0 }, config: { agentId: "x" } }], edges: [] }).issues[0]?.path).toBe("nodes.0.position");
    expect(readGraph({ nodes: [{ key: "a", kind: "SINK", position: { x: 0, y: 0 }, config: {} }], edges: [] }).issues[0]?.path).toBe("nodes.0.kind");
    expect(readGraph("nope").issues[0]?.code).toBe("malformed");
    expect(readGraph({ nodes: "nope", edges: "nope" }).issues.map((issue) => issue.path)).toEqual(["nodes", "edges"]);
  });

  it("holds the size caps so a save stays inside the body limit", () => {
    const wide = {
      nodes: Array.from({ length: 61 }, (_, index) => ({ key: `n${index}`, kind: "AGENT", position: { x: 0, y: 0 }, config: { agentId: "a" } })),
      edges: Array.from({ length: 141 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    };
    const paths = readGraph(wide).issues.map((issue) => issue.path);
    expect(paths).toContain("nodes");
    expect(paths).toContain("edges");
  });
});

describe("analyseGraph", () => {
  it("passes a wired channel → agent → sink and orders it", () => {
    const report = analyseGraph(valid, context());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.order).toEqual(["in", "a", "out"]);
    expect(report.entryKeys).toEqual(["in"]);
  });

  it("reports an edge that points at a node the canvas no longer has", () => {
    const report = analyseGraph(graph([inbound("in"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "ghost")]), context());
    expect(codes(graph([inbound("in"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "ghost")]), context())).toContain("edge_endpoint_missing");
    expect(report.issues.find((issue) => issue.code === "edge_endpoint_missing")?.path).toBe("edges.1.to");
  });

  it("refuses a cycle, including a node wired to itself", () => {
    const loop = graph([inbound("in"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out"), edge("out", "a")]);
    const report = analyseGraph(loop, context());
    expect(report.ok).toBe(false);
    expect(report.order).toEqual([]);
    expect(report.issues.find((issue) => issue.code === "cycle")?.message).toContain("a → out");
    expect(codes(graph([agent("a"), outbound("out")], [edge("a", "a"), edge("a", "out")]), context())).toContain("cycle");
  });

  it("requires an entry, and requires it to reach an agent", () => {
    expect(codes(graph([agent("a"), outbound("out")], [edge("a", "out")]), context())).toContain("no_entry");
    expect(codes(graph([inbound("in"), outbound("out")], [edge("in", "out")]), context())).toContain("entry_unreachable");
  });

  it("requires every agent to reach a sink", () => {
    expect(codes(graph([inbound("in"), agent("a")], [edge("in", "a")]), context())).toContain("agent_no_sink");
  });

  it("tells a deleted row apart from one owned by another project", () => {
    expect(codes(graph([inbound("in"), agent("a", "agt_gone"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context())).toContain("agent_missing");
    expect(
      codes(graph([inbound("in"), agent("a", "agt_2"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context()),
    ).toContain("agent_outside_project");
    expect(
      codes(graph([inbound("in", "int_other"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context()),
    ).toContain("channel_outside_project");
    expect(
      codes(graph([inbound("in", "int_gone"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context()),
    ).toContain("channel_missing");
  });

  it("derives direction from the channel type, not from the node", () => {
    expect(channelDirection("TELEGRAM_IN")).toBe("INPUT");
    expect(channelDirection("WEBHOOK_OUT")).toBe("OUTPUT");
    expect(channelDirection("SLACK")).toBeNull();
    // An inbound node aimed at a sink, and an outbound node aimed at a channel.
    expect(
      codes(graph([inbound("in", "int_out"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context()),
    ).toContain("channel_direction_mismatch");
    expect(
      codes(graph([inbound("in"), agent("a"), outbound("out", "int_in")], [edge("in", "a"), edge("a", "out")]), context()),
    ).toContain("channel_direction_mismatch");
    expect(
      analyseGraph(graph([inbound("in"), agent("a"), outbound("out", "int_in")], [edge("in", "a"), edge("a", "out")]), context()).issues.find(
        (issue) => issue.code === "channel_direction_mismatch",
      )?.message,
    ).toContain("cannot act as an outbound sink");
  });

  it("refuses to activate a graph whose channel is revoked", () => {
    const report = analyseGraph(graph([inbound("in", "int_revoked"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]), context());
    expect(codes(graph([inbound("in", "int_revoked"), agent("a"), outbound("out")], [edge("in", "a"), edge("a", "out")]))).toContain("channel_not_connected");
    expect(report.ok).toBe(false);
  });

  it("caps the agent nodes a single run may bill for", () => {
    const nodes = [inbound("in"), outbound("out"), ...Array.from({ length: MAX_AGENT_NODES + 1 }, (_, index) => agent(`a${index}`))];
    const edges = nodes.filter((node) => node.kind === "AGENT").flatMap((node) => [edge("in", node.key), edge(node.key, "out")]);
    expect(codes(graph(nodes, edges), context())).toContain("too_many_agents");
  });

  it("warns about an island without blocking activation", () => {
    const report = analyseGraph(
      graph([inbound("in"), agent("a"), outbound("out"), outbound("spare", "int_out")], [edge("in", "a"), edge("a", "out")]),
      context(),
    );
    const orphan = report.issues.find((issue) => issue.code === "orphan_node");
    expect(orphan?.level).toBe("warning");
    expect(orphan?.nodeKey).toBe("spare");
    expect(activationBlockers(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("notices when the stored reference index drifts from the graph", () => {
    const stored = dependenciesOf(valid);
    expect(codes(valid, context({ dependencies: stored }))).not.toContain("dependency_drift");
    expect(codes(valid, context({ dependencies: [{ kind: "AGENT", refId: "agt_3" }] }))).toContain("dependency_drift");
  });
});

describe("topoOrder", () => {
  it("is deterministic whatever order the arrays happen to be in", () => {
    const nodes = [inbound("in"), agent("b"), agent("a"), outbound("z"), outbound("y")];
    const edges = [edge("a", "y"), edge("in", "b"), edge("b", "z"), edge("in", "a"), edge("a", "z")];
    const shuffled = [...nodes].reverse();
    const edgesShuffled = [...edges].reverse();
    expect(topoOrder(graph(nodes, edges)).order).toEqual(topoOrder(graph(shuffled, edgesShuffled)).order);
    // Ties break by key, so "a" runs before "b" even though "in" fans out to
    // "b" first in the edge list.
    expect(topoOrder(graph(nodes, edges)).order).toEqual(["in", "a", "b", "y", "z"]);
  });

  it("lists the nodes a cycle trapped rather than hiding them", () => {
    const { order, cyclic } = topoOrder(graph([agent("a"), agent("b"), agent("c")], [edge("a", "b"), edge("b", "a")]));
    expect(order).toEqual(["c"]);
    expect(cyclic).toEqual(["a", "b"]);
  });
});

describe("joinInputs", () => {
  it("joins a fan-in with a blank line and drops silence", () => {
    expect(joinInputs(["first", "  ", "second"])).toEqual({ text: "first\n\nsecond", truncated: false });
  });

  it("cuts at the cap and says it did", () => {
    const long = "x".repeat(MAX_JOINED_INPUT + 10);
    const joined = joinInputs([long, "tail"]);
    expect(joined.text.length).toBe(MAX_JOINED_INPUT);
    expect(joined.truncated).toBe(true);

    // The separators are part of the budget, so four characters with two left
    // to hold them arrive cut, and the cut is reported instead of hidden.
    const second = joinInputs(["y".repeat(MAX_JOINED_INPUT - 5), "tail"]);
    expect(second.text.length).toBe(MAX_JOINED_INPUT);
    expect(second.text.endsWith("tai")).toBe(true);
    expect(second.truncated).toBe(true);

    expect(joinInputs(["short", "again"]).truncated).toBe(false);
  });
});

describe("dependenciesOf", () => {
  it("lists each referenced row once, sorted", () => {
    const refs = dependenciesOf(
      graph([inbound("i1", "int_in"), inbound("i2", "int_in"), agent("a1"), agent("a2", "agt_3"), outbound("o", "int_out")], [edge("i1", "a1")]),
    );
    expect(refs).toEqual([
      { kind: "AGENT", refId: "agt_1" },
      { kind: "AGENT", refId: "agt_3" },
      { kind: "INTEGRATION", refId: "int_in" },
      { kind: "INTEGRATION", refId: "int_out" },
    ]);
  });

  it("counts the orchestrator and every declared subagent as real references", () => {
    const refs = dependenciesOf(
      graph(
        [
          inbound("in"),
          orchestrator("orch", "agt_1", [
            { agentId: "agt_3", role: "writer" },
            { agentId: "agt_3", role: "reviewer" },
          ]),
          outbound("out"),
        ],
        [edge("in", "orch"), edge("orch", "out")],
      ),
    );
    expect(refs).toEqual([
      { kind: "AGENT", refId: "agt_1" },
      { kind: "AGENT", refId: "agt_3" },
      { kind: "INTEGRATION", refId: "int_in" },
      { kind: "INTEGRATION", refId: "int_out" },
    ]);
  });
});

const orchestrator = (
  key: string,
  agentId = "agt_1",
  subagents: { agentId: string; role: string; maxSteps?: number }[] = [{ agentId: "agt_3", role: "writer" }],
): GraphNode => ({
  key,
  kind: "ORCHESTRATOR",
  position: { x: 0, y: 0 },
  config: { agentId, subagents },
});

const orchestrated = (subagents = [{ agentId: "agt_3", role: "writer" }]): GraphDefinition =>
  graph([inbound("in"), orchestrator("orch", "agt_1", subagents), outbound("out")], [edge("in", "orch"), edge("orch", "out")]);

describe("orchestrator nodes", () => {
  it("parses an orchestrator and keeps only agentId, role and maxSteps per subagent", () => {
    const parsed = readGraph({
      nodes: [
        {
          key: "orch",
          kind: "ORCHESTRATOR",
          position: { x: 0, y: 0 },
          config: {
            agentId: "agt_1",
            subagents: [{ agentId: "agt_3", role: "writer", maxSteps: 2, subagents: [{ agentId: "agt_1", role: "nested" }] }],
          },
        },
      ],
      edges: [],
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.graph?.nodes[0]).toEqual({
      key: "orch",
      kind: "ORCHESTRATOR",
      position: { x: 0, y: 0 },
      // Delegation is depth 1 by construction: an inner `subagents` tree has no
      // field to land in, so it cannot become depth 2.
      config: { agentId: "agt_1", subagents: [{ agentId: "agt_3", role: "writer", maxSteps: 2 }] },
    });
  });

  it("rejects a missing subagent list and a step count past the cap", () => {
    const missing = readGraph({
      nodes: [{ key: "orch", kind: "ORCHESTRATOR", position: { x: 0, y: 0 }, config: { agentId: "agt_1" } }],
      edges: [],
    });
    expect(missing.graph).toBeNull();
    expect(missing.issues[0]).toMatchObject({ code: "malformed", path: "nodes.0.config.subagents" });

    const tooSteppy = readGraph({
      nodes: [
        {
          key: "orch",
          kind: "ORCHESTRATOR",
          position: { x: 0, y: 0 },
          config: { agentId: "agt_1", subagents: [{ agentId: "agt_3", role: "writer", maxSteps: MAX_SUBAGENT_STEPS + 1 }] },
        },
      ],
      edges: [],
    });
    expect(tooSteppy.issues[0]).toMatchObject({ path: "nodes.0.config.subagents.0.maxSteps" });
  });

  it("passes a wired inbound → orchestrator → sink and orders it like any other agent", () => {
    const report = analyseGraph(orchestrated(), context());
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.order).toEqual(["in", "orch", "out"]);
  });

  it("allows an orchestrator with no declared subagents — it is then a plain turn", () => {
    expect(codes(orchestrated([]), context())).toEqual([]);
  });

  it("tells a missing orchestrator agent from one in another project", () => {
    const missing = graph([inbound("in"), orchestrator("orch", "agt_gone"), outbound("out")], [edge("in", "orch"), edge("orch", "out")]);
    expect(codes(missing, context())).toContain("orchestrator_missing");
    const foreign = graph([inbound("in"), orchestrator("orch", "agt_2"), outbound("out")], [edge("in", "orch"), edge("orch", "out")]);
    expect(codes(foreign, context())).toContain("orchestrator_outside_project");
  });

  it("refuses a delegation that could not resolve: missing, foreign, self, duplicated or badly named", () => {
    expect(codes(orchestrated([{ agentId: "agt_gone", role: "writer" }]), context())).toContain("subagent_missing");
    expect(codes(orchestrated([{ agentId: "agt_2", role: "writer" }]), context())).toContain("subagent_outside_project");
    expect(codes(orchestrated([{ agentId: "agt_1", role: "writer" }]), context())).toContain("subagent_self");
    expect(
      codes(
        orchestrated([
          { agentId: "agt_3", role: "writer" },
          { agentId: "agt_3", role: "writer" },
        ]),
        context(),
      ),
    ).toContain("subagent_duplicate");
    expect(codes(orchestrated([{ agentId: "agt_3", role: "Writer!" }]), context())).toContain("subagent_role_invalid");
  });

  it("caps the declared subagents one orchestrator may fan out to", () => {
    const tooMany = Array.from({ length: MAX_SUBAGENTS + 1 }, (_, index) => ({ agentId: "agt_3", role: `role_${index}` }));
    expect(codes(orchestrated(tooMany), context())).toContain("subagent_too_many");
  });

  it("requires a sink downstream of the orchestrator", () => {
    const noSink = graph([inbound("in"), orchestrator("orch"), outbound("spare", "int_out")], [edge("in", "orch")]);
    expect(codes(noSink, context())).toContain("orchestrator_no_sink");
  });

  it("permits one orchestrator per graph and spends the agent-node budget on it", () => {
    const two = graph(
      [inbound("in"), orchestrator("o1"), orchestrator("o2", "agt_3"), outbound("out")],
      [edge("in", "o1"), edge("o1", "out"), edge("in", "o2"), edge("o2", "out")],
    );
    expect(codes(two, context())).toContain("orchestrator_too_many");

    const agents = Array.from({ length: MAX_AGENT_NODES }, (_, index) => agent(`a${index}`));
    const edges = [
      edge("in", "orch"),
      edge("orch", "out"),
      ...agents.flatMap((row) => [edge("in", row.key), edge(row.key, "out")]),
    ];
    const crowded = graph([inbound("in"), orchestrator("orch", "agt_1", []), outbound("out"), ...agents], edges);
    expect(codes(crowded, context())).toContain("too_many_agents");
  });

  it("marks a stale reference index that forgets a subagent", () => {
    const stored = dependenciesOf(orchestrated()).filter((dep) => dep.refId !== "agt_3");
    expect(codes(orchestrated(), context({ dependencies: stored }))).toContain("dependency_drift");
  });
});
