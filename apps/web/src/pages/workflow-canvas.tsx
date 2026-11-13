import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, NodeChange, EdgeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CanvasFrame } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { QueryState } from "@/components/ui/states";
import { EDGE_TYPES } from "@/components/workflow/flow-edge";
import { Inspector } from "@/components/workflow/inspector";
import { IssuesPanel } from "@/components/workflow/issues";
import { Palette, DRAG_MIME, buildPalette } from "@/components/workflow/palette";
import type { PaletteItem } from "@/components/workflow/palette";
import { NODE_TYPES } from "@/components/workflow/flow-node";
import { Toolbar } from "@/components/workflow/toolbar";
import { ZoomSlider } from "@/components/workflow/zoom-slider";
import {
  CanvasContext,
  edgeId,
  nextNodeKey,
  readFlowData,
  toDefinition,
  toFlow,
  toFlowEdges,
} from "@/lib/graph-flow";
import type { FlowNode, FlowNodeData } from "@/lib/graph-flow";
import { ApiError, errorDetails } from "@/lib/api";
import {
  useProject,
  useProjectAgents,
  useProjectIntegrations,
  useRun,
  useSaveGraph,
  useSaveWorkflow,
  useStartRun,
  useSetWorkflowStatus,
  useValidateWorkflow,
  useWorker,
  useWorkflow,
} from "@/lib/queries";
import type { GraphIssue, NodeKind, WorkerState, WorkflowRun, WorkflowStatus, WorkflowValidation } from "@/lib/domain";

/** The drag payload is this app's own JSON; anything else is ignored. */
function readPayload(raw: string): PaletteItem | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.refId !== "string" || typeof item.kind !== "string" || typeof item.name !== "string") return null;
    return item as unknown as PaletteItem;
  } catch {
    return null;
  }
}

/** Below `lg` the rails are sheets, so a picked box opens the inspector itself. */
const isNarrow = () => window.matchMedia("(max-width: 1023px)").matches;

/**
 * The canvas. `ReactFlowProvider` has to wrap it because the palette drops nodes
 * at a position converted from screen coordinates, which needs the flow store.
 *
 * Nothing here decides whether a graph is legal. The document is sent to the API
 * and `packages/core` answers; this file only keeps the drawing, the version
 * number the next save must present, and the server's own report on screen.
 */
function Board() {
  const { projectId, workflowId } = useParams<{ projectId: string; workflowId: string }>();
  const project = useProject(projectId);
  const workflow = useWorkflow(workflowId);
  const agents = useProjectAgents(projectId);
  const integrations = useProjectIntegrations(projectId);

  const [nodes, setNodes, applyNodeChanges] = useNodesState<FlowNode>([]);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<Edge>([]);
  const [dirty, setDirty] = useState(false);
  const [report, setReport] = useState<WorkflowValidation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** Sheets replace the two rails below `lg`; on desktop they are never opened. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const saveGraph = useSaveGraph();
  /** The graph this console is watching move, if any. */
  const [runId, setRunId] = useState<string | null>(null);
  const run = useRun(runId ?? undefined);
  const startRun = useStartRun(workflowId ?? "");
  const worker = useWorker();
  const validate = useValidateWorkflow();
  const changeStatus = useSetWorkflowStatus();
  const rename = useSaveWorkflow();

  const { fitView, screenToFlowPosition } = useReactFlow<FlowNode, Edge>();
  const board = useRef<HTMLDivElement | null>(null);
  /** The version this canvas loaded, advanced by every save it makes itself. */
  const baseVersion = useRef(0);
  /** Bumped by every edit, so a save that started earlier cannot clear a later one. */
  const revision = useRef(0);
  /** Saves are serialized: two in flight at once would both claim the same version. */
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  /** Load once per workflow id — see the note on StrictMode below. */
  const seededFor = useRef<string | null>(null);

  const palette = useMemo(
    () => buildPalette(agents.data ?? [], integrations.data ?? []),
    [agents.data, integrations.data],
  );

  useEffect(() => {
    const row = workflow.data;
    if (!row || seededFor.current === row.id) return;
    // The guard is a ref, not state: `StrictMode` mounts this component twice, and
    // a boolean in state would let the second mount re-seed the canvas over
    // whatever the user had already dragged during the first.
    seededFor.current = row.id;
    baseVersion.current = row.version;
    setNodes(toFlow(row.definition));
    setEdges(toFlowEdges(row.definition));
    setDirty(false);
    setReport(null);
    setConflicted(false);
    setNotice(null);
    void fitView({ padding: 0.18, duration: 260 });
  }, [workflow.data, setNodes, setEdges, fitView]);

  const canvas = useMemo(
    () => ({
      ref: (refId: string, kind: NodeKind) => {
        if (kind === "AGENT" || kind === "ORCHESTRATOR") {
          const agent = (agents.data ?? []).find((row) => row.id === refId);
          return agent ? { name: agent.name, meta: `${agent.modelProvider}/${agent.modelName}`, channelType: null } : null;
        }
        const item = [...palette.inbound, ...palette.outbound].find((row) => row.refId === refId);
        return item ? { name: item.name, meta: item.meta, channelType: item.channelType } : null;
      },
      level: (key: string) => {
        if (!report) return null;
        const mine = report.issues.filter((issue) => issue.nodeKey === key);
        if (mine.some((issue) => issue.level === "error")) return "error";
        return mine.length > 0 ? "warning" : null;
      },
      // The last run's rows, so the board shows what actually happened rather
      // than only what the graph means to do.
      runNode: (key: string) => run.data?.nodes?.find((row) => row.nodeKey === key) ?? null,
    }),
    [agents.data, palette, report, run.data],
  );

  /**
   * Cables are stored plain; what is drawn carries the source box's state from
   * the watched run, so a cable that carried work turns solid. The raw array
   * stays the document this console saves.
   */
  const displayEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "flow",
        data: { status: run.data?.nodes?.find((row) => row.nodeKey === edge.source)?.status ?? null },
      })),
    [edges, run.data],
  );

  /** A content change makes the last report stale; a rename or a drag does not. */
  const markChanged = useCallback(() => {
    revision.current += 1;
    setDirty(true);
    setReport(null);
    setNotice(null);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      applyNodeChanges(changes);
      // Selection and measurement arrive as changes too, and neither one is an
      // edit the user could lose.
      if (changes.some((change) => change.type !== "select" && change.type !== "dimensions")) setDirty(true);
    },
    [applyNodeChanges],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      applyEdgeChanges(changes);
      if (changes.some((change) => change.type !== "select")) setDirty(true);
    },
    [applyEdgeChanges],
  );

  /** The board's centre in flow coordinates, which the added-box grid is built around. */
  const boardCentre = useCallback(() => {
    const rect = board.current?.getBoundingClientRect();
    return rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
  }, [screenToFlowPosition]);

  /**
   * Add a box. A dropped one goes where the pointer let go; one added from the
   * palette takes the next slot in a grid centred on the board. Cables run from a
   * box's bottom edge to the next one's top edge, so the grid descends in short
   * columns — four boxes down, then a new column to the right.
   *
   * That slot is worked out from the array inside the updater, not from a
   * `nodes.length` captured when the callback was made: two quick clicks arrive
   * in the same render, and reading the stale length stacks both boxes on the
   * same pixel — where their handles cover each other and no cable can be drawn.
   */
  const addAt = useCallback(
    (item: PaletteItem, position?: { x: number; y: number }) => {
      const origin = boardCentre();
      setNodes((current) => {
        const key = nextNodeKey(current, item.kind);
        const data: FlowNodeData = { kind: item.kind, refId: item.refId, label: "", subagents: [] };
        const col = Math.floor(current.length / 4);
        const row = current.length % 4;
        const at = position ?? { x: origin.x - 137 + col * 340, y: origin.y - 304 + row * 152 };
        return [...current, { id: key, type: "saas", position: { x: Math.round(at.x), y: Math.round(at.y) }, data }];
      });
      markChanged();
    },
    [setNodes, markChanged, boardCentre],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      const id = edgeId(source, target);
      // One cable per pair: a second identical edge would claim the same node
      // runs twice in a single pass, which the run schema's unique constraint
      // already says is impossible.
      setEdges((current) =>
        current.some((edge) => edge.id === id)
          ? current
          : addEdge({ ...connection, id, type: "flow" }, current),
      );
      markChanged();
    },
    [setEdges, markChanged],
  );

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    setNodes((current) => current.filter((node) => node.id !== selected));
    setEdges((current) => current.filter((edge) => edge.source !== selected && edge.target !== selected));
    setSelected(null);
    setInspectorOpen(false);
    markChanged();
  }, [selected, setNodes, setEdges, markChanged]);

  const setReference = useCallback(
    (refId: string) => {
      if (!selected) return;
      setNodes((current) =>
        current.map((node) =>
          node.id === selected ? { ...node, data: { ...readFlowData(node), refId } } : node,
        ),
      );
      markChanged();
    },
    [selected, setNodes, markChanged],
  );

  const setLabel = useCallback(
    (label: string) => {
      if (!selected) return;
      setNodes((current) =>
        current.map((node) =>
          node.id === selected ? { ...node, data: { ...readFlowData(node), label } } : node,
        ),
      );
      // A label cannot break a graph, so the report stays on screen.
      setDirty(true);
    },
    [selected, setNodes],
  );

  const setSubagents = useCallback(
    (subagents: FlowNodeData["subagents"]) => {
      if (!selected) return;
      setNodes((current) =>
        current.map((node) =>
          node.id === selected ? { ...node, data: { ...readFlowData(node), subagents } } : node,
        ),
      );
      // Every subagent edit changes what the server will judge on activation.
      markChanged();
    },
    [selected, setNodes, markChanged],
  );

  /**
   * Point the board at the box a validation message named. The selection is set
   * on the node itself because this canvas owns its node array — that is the only
   * way React Flow reports it back through `onSelectionChange`.
   */
  const focusNode = useCallback(
    (key: string) => {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === key })));
      setSelected(key);
      void fitView({ nodes: [{ id: key }], padding: 0.4, minZoom: 0.6, duration: 260 });
    },
    [setNodes, fitView],
  );

  /**
   * Validation, activation and any save all speak to the *stored* graph, so an
   * edit that has not landed yet is saved first. Asking the server about a
   * document it does not have would report on something other than what is on
   * the screen.
   */
  const withStoredGraph = useCallback(
    (then: () => void) => {
      if (!workflowId) return;
      if (!dirty) {
        then();
        return;
      }
      const sent = revision.current;
      const definition = toDefinition(nodes, edges);
      pendingSave.current = pendingSave.current.then(async () => {
        try {
          const saved = await saveGraph.mutateAsync({ id: workflowId, definition, expectedVersion: baseVersion.current });
          baseVersion.current = saved.version;
          // An edit that arrived while this save was in flight bumped the
          // revision: clearing `dirty` here would drop it until the next click.
          if (revision.current === sent) setDirty(false);
          then();
        } catch (error) {
          if (error instanceof ApiError && error.code === "graph_version") setConflicted(true);
          setNotice(error instanceof Error ? error.message : "the save failed");
        }
      });
    },
    [workflowId, dirty, saveGraph, nodes, edges],
  );

  const saveNow = useCallback(() => withStoredGraph(() => undefined), [withStoredGraph]);

  const runValidate = useCallback(() => {
    if (!workflowId) return;
    validate.mutate(workflowId, {
      onSuccess: (result) => setReport(result),
      onError: (error) => setNotice(error instanceof Error ? error.message : "validation failed"),
    });
  }, [workflowId, validate]);

  const activate = useCallback(
    (status: WorkflowStatus) => {
      if (!workflowId) return;
      withStoredGraph(() =>
        changeStatus.mutate(
          { id: workflowId, status },
          {
            // The refusal carries the full report, so the panel shows the same
            // list the server worked out rather than a paraphrase of it.
            onSuccess: () => setNotice(null),
            onError: (error) => {
              const issues = errorDetails<{ issues?: GraphIssue[] }>(error)?.issues;
              if (Array.isArray(issues)) setReport({ ok: false, issues, order: [], entryKeys: [] });
              setNotice(error instanceof Error ? error.message : "the status change failed");
            },
          },
        ),
      );
    },
    [workflowId, withStoredGraph, changeStatus],
  );

  /** Autosave, one and a half seconds after the canvas goes quiet. */
  useEffect(() => {
    if (!dirty || conflicted || saveGraph.isPending) return;
    const timer = setTimeout(saveNow, 1_500);
    return () => clearTimeout(timer);
  }, [dirty, conflicted, saveGraph.isPending, saveNow]);

  const selectedNode = useMemo(() => {
    const found = nodes.find((node) => node.id === selected);
    return found ? { key: found.id, ...readFlowData(found) } : null;
  }, [nodes, selected]);

  const options: PaletteItem[] = !selectedNode
    ? []
    : selectedNode.kind === "AGENT" || selectedNode.kind === "ORCHESTRATOR"
      ? palette.agents
      : selectedNode.kind === "INBOUND"
        ? palette.inbound
        : palette.outbound;

  return (
    <CanvasFrame>
      <div className="flex h-full flex-col">
        <QueryState error={workflow.error} pending={workflow.isPending}>
          <Toolbar
            project={project.data ?? null}
            workflow={workflow.data ?? null}
            worker={worker.data ?? null}
            dirty={dirty}
            saving={saveGraph.isPending}
            validating={validate.isPending}
            statusBusy={changeStatus.isPending}
            error={notice ?? (rename.isError && rename.error instanceof Error ? rename.error.message : null)}
            conflicted={conflicted}
            onSave={saveNow}
            onValidate={() => withStoredGraph(runValidate)}
            onStatus={activate}
            onRename={(name) => workflowId && rename.mutate({ id: workflowId, name, description: workflow.data?.description ?? null })}
            onReload={() => {
              seededFor.current = null;
              setNotice(null);
              setConflicted(false);
              void workflow.refetch();
            }}
          />

          {/* Below `lg` the two rails become sheets; this strip is their way in. */}
          <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 lg:hidden">
            <Button size="sm" variant="outline" onClick={() => setPaletteOpen(true)}>
              Add node
            </Button>
            <Button size="sm" variant="outline" disabled={selectedNode === null} onClick={() => setInspectorOpen(true)}>
              Inspector
            </Button>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {selectedNode ? selectedNode.key : "Select a node to edit it"}
            </span>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="hidden h-full w-[236px] shrink-0 border-r border-border lg:block">
              <Palette
                agents={agents.data ?? []}
                integrations={integrations.data ?? []}
                onAdd={(item) => addAt(item)}
                className="h-full"
              />
            </div>

            <div
              ref={board}
              className="relative min-w-0 flex-1"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const item = readPayload(event.dataTransfer.getData(DRAG_MIME));
                if (!item) return;
                addAt(item, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
              }}
            >
              <CanvasContext.Provider value={canvas}>
                <ReactFlow
                  nodes={nodes}
                  edges={displayEdges}
                  nodeTypes={NODE_TYPES}
                  edgeTypes={EDGE_TYPES}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onSelectionChange={({ nodes: picked }) => {
                    const key = picked[0]?.id ?? null;
                    setSelected(key);
                    if (key !== null && isNarrow()) setInspectorOpen(true);
                  }}
                  onNodesDelete={markChanged}
                  onEdgesDelete={markChanged}
                  deleteKeyCode={["Backspace", "Delete"]}
                  fitView
                  className="bg-background"
                >
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
                  <ZoomSlider />
                </ReactFlow>
              </CanvasContext.Provider>

              {nodes.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <p className="max-w-xs rounded-lg border border-dashed border-border bg-card/80 px-4 py-3 text-center text-[12px] leading-relaxed text-muted-foreground">
                    Drag a channel in, an agent, and a channel out from the palette to start. On a phone, use Add node.
                    The board is empty because nothing has been saved to it yet.
                  </p>
                </div>
              )}

              <RunPanel
                status={workflow.data?.status}
                worker={worker.data ?? null}
                run={run.data}
                busy={startRun.isPending || run.data?.status === "RUNNING"}
                error={startRun.error instanceof Error ? startRun.error.message : null}
                onRun={(message) =>
                  void startRun
                    .mutateAsync(message)
                    .then((started) => setRunId(started.runId))
                    .catch(() => undefined)
                }
              />
            </div>

            <div className="hidden h-full w-[264px] shrink-0 border-l border-border lg:block">
              <Inspector
                node={selectedNode}
                options={options}
                onChangeRef={setReference}
                onChangeLabel={setLabel}
                onChangeSubagents={setSubagents}
                onDelete={deleteSelected}
                className="h-full"
              />
            </div>
          </div>

          <div className="max-h-[210px] shrink-0 overflow-y-auto border-t border-border bg-card px-4 py-2.5">
            <IssuesPanel
              report={report}
              pending={validate.isPending}
              onPick={(issue) => issue.nodeKey && focusNode(issue.nodeKey)}
              highlighted={selected ?? undefined}
            />
          </div>

          <Sheet open={paletteOpen} onClose={() => setPaletteOpen(false)} side="top" title="Add to canvas">
            <Palette
              agents={agents.data ?? []}
              integrations={integrations.data ?? []}
              onAdd={(item) => {
                addAt(item);
                setPaletteOpen(false);
              }}
            />
          </Sheet>

          <Sheet open={inspectorOpen} onClose={() => setInspectorOpen(false)} side="bottom" title="Inspector">
            <Inspector
              node={selectedNode}
              options={options}
              onChangeRef={setReference}
              onChangeLabel={setLabel}
              onChangeSubagents={setSubagents}
              onDelete={deleteSelected}
              idPrefix="sheet-"
            />
          </Sheet>
        </QueryState>
      </div>
    </CanvasFrame>
  );
}

export default function WorkflowCanvasPage() {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}

/**
 * The producer, stated in plain words.
 *
 * No channel can trigger a graph yet (there is no Telegram or WhatsApp adapter),
 * so this is the one honest way to run one: a real message, through the real
 * queue, answered by the real provider. The card refuses to offer the button
 * while the graph is not ACTIVE or no worker is alive, because either state means
 * the message would sit in a table and nothing would answer it.
 */
function RunPanel({
  status,
  worker,
  run,
  busy,
  error,
  onRun,
}: {
  status: WorkflowStatus | undefined;
  worker: WorkerState | null;
  run: WorkflowRun | undefined;
  busy: boolean;
  error: string | null;
  onRun: (message: string) => void;
}) {
  const [message, setMessage] = useState("");
  const ready = status === "ACTIVE" && worker?.alive === true;
  return (
    <div className="absolute bottom-3 left-3 z-10 w-[calc(100%-1.5rem)] max-w-[320px] rounded-xl border border-border bg-card/95 p-3 shadow-card backdrop-blur">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Test run</p>
      {status !== "ACTIVE" && (
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          {status === undefined
            ? "Loading this workflow\u2026"
            : `This graph is ${status.toLowerCase()}. Activate it and a message sent here is answered for real.`}
        </p>
      )}
      {status === "ACTIVE" && worker?.alive !== true && (
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          No worker is running, so a message would queue and nothing would answer. Start one with pnpm dev:worker —
          the badge above updates within a few seconds.
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <Input
          value={message}
          maxLength={8_000}
          disabled={!ready}
          placeholder="Message to send through the graph"
          aria-label="Message to send through the graph"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ready && message.trim() !== "") onRun(message.trim());
          }}
        />
        <Button
          size="sm"
          loading={busy}
          disabled={!ready || busy || message.trim() === ""}
          onClick={() => onRun(message.trim())}
        >
          Run
        </Button>
      </div>
      {error !== null && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
      {run !== undefined && (
        <div className="mt-2 space-y-1 border-t border-border pt-2 text-[11px]">
          <p className="text-muted-foreground">
            {run.triggerSource} · {run.status.toLowerCase()} · {run.tokensUsed} tokens
            {run.durationMs === null ? "" : ` · ${(run.durationMs / 1000).toFixed(1)}s`}
          </p>
          {(run.nodes ?? []).map((node) => (
            <div key={node.nodeKey}>
              <p className="flex justify-between gap-2">
                <span className="truncate text-muted-foreground">{node.label ?? node.nodeKey}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase">
                  {node.status.toLowerCase()}
                  {node.tokensUsed > 0 ? ` · ${node.tokensUsed} t` : ""}
                </span>
              </p>
              {node.trace.map((step, index) => (
                <p
                  key={`${node.nodeKey}-trace-${index}`}
                  className="flex justify-between gap-2 pl-2 font-mono text-[10px] text-muted-foreground"
                  title={`${step.argsPreview}\n→ ${step.resultPreview}`}
                >
                  <span className="truncate">
                    {step.tool} · step {step.index}
                  </span>
                  <span className={step.ok ? "text-muted-foreground" : "text-destructive"}>
                    {step.ok ? "ok" : "error"} · {step.inputTokens + step.outputTokens} t
                  </span>
                </p>
              ))}
            </div>
          ))}
          {run.output !== null && (
            <p className="line-clamp-3 border-t border-border pt-1 text-muted-foreground">{run.output}</p>
          )}
          {run.error !== null && <p className="border-t border-border pt-1 text-destructive">{run.error}</p>}
        </div>
      )}
    </div>
  );
}
