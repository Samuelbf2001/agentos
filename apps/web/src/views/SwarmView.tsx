/**
 * Enjambre (US-6, spec B5 §5): lienzo @xyflow SOLO lectura. Un nodo por agente
 * agrupado por capa, halo por estado, tarea actual, tokens y coste de la
 * sesión. Aristas animadas ~3 s cuando hay delegación (task.delegated) — nada
 * decorativo: toda arista nace de un evento persistido.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../lib/api";
import type { Agent, AgentLayer } from "../lib/types";
import { useStore } from "../state/store";
import type { AgentPhase, RunLive } from "../state/reducer";
import { AgentAvatar, EmptyState, fmtCost } from "../components/ui";

type SwarmState = "idle" | "pensando" | "usando_tool" | "bloqueado" | "pausado" | "esperando_turno";

const STATE_STYLE: Record<SwarmState, { ring: string; label: string; pulse: boolean }> = {
  idle: { ring: "ring-slate-200", label: "idle", pulse: false },
  pensando: { ring: "ring-amber-400", label: "pensando", pulse: true },
  usando_tool: { ring: "ring-sky-500", label: "usando tool", pulse: true },
  bloqueado: { ring: "ring-rose-500", label: "bloqueado", pulse: false },
  pausado: { ring: "ring-slate-400", label: "pausado", pulse: false },
  esperando_turno: { ring: "ring-violet-400", label: "esperando turno", pulse: true },
};

const LAYER_ORDER: AgentLayer[] = ["consultoria", "implementacion", "operacion", "meta"];
const LAYER_LABEL: Record<AgentLayer, string> = {
  consultoria: "Consultoría",
  implementacion: "Implementación",
  operacion: "Operación",
  meta: "Meta (QA)",
};

interface AgentNodeData extends Record<string, unknown> {
  agent: Agent;
  state: SwarmState;
  currentTool: string | null;
  taskTitle: string | null;
  tokens: number | null;
  cost: number | null;
  activeRunId: string | null;
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const st = STATE_STYLE[data.state];
  return (
    <div
      className={`w-52 rounded-xl border border-slate-200 bg-white p-3 shadow-sm ring-2 ${st.ring} ${
        st.pulse ? "animate-pulse" : ""
      }`}
      data-testid={`swarm-node-${data.agent.slug}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-300" />
      <div className="flex items-center gap-2">
        <AgentAvatar name={data.agent.name} slug={data.agent.slug} size={8} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{data.agent.name}</p>
          <p className="text-[10px] text-slate-400">{LAYER_LABEL[data.agent.layer]}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] font-medium text-slate-600">
        {st.label}
        {data.currentTool ? <span className="font-mono text-sky-700"> · {data.currentTool}</span> : null}
      </p>
      {data.taskTitle ? (
        <p className="mt-1 truncate text-[10px] text-slate-500" title={data.taskTitle}>
          🗂️ {data.taskTitle}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-slate-400">
        {data.tokens === null ? "tokens: no reportado" : `${data.tokens.toLocaleString("es")} tokens`}
        {" · "}
        {data.cost === null ? "coste: no reportado" : fmtCost(data.cost)}
      </p>
      <Handle type="source" position={Position.Right} className="!bg-slate-300" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };
/** Ventana de animación de una arista de delegación (~3 s). */
const EDGE_TTL_MS = 3_200;

export default function SwarmView() {
  const agents = useStore((s) => s.agents);
  const runsLive = useStore((s) => s.runsLive);
  const boardTasks = useStore((s) => s.board.tasks);
  const edgesRaw = useStore((s) => s.edges);
  const agentStatus = useStore((s) => s.agentStatus);
  const mergeRuns = useStore((s) => s.mergeRuns);
  const openTask = useStore((s) => s.openTask);
  const navigate = useNavigate();
  const [, setTick] = useState(0);

  // Poll de runs: el topic swarm trae cola/cancelaciones, pero el detalle de
  // cada run vive en run:<id>; el snapshot REST completa lo que no vimos.
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const { runs } = await api.runs({ limit: 50 });
        if (alive) mergeRuns(runs);
      } catch {
        /* siguiente ciclo */
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 4_000);
    // Tick para expirar aristas animadas (~3 s).
    const tick = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(tick);
    };
  }, [mergeRuns]);

  const { nodes, edges } = useMemo(() => {
    const byAgent = new Map<string, RunLive[]>();
    for (const r of Object.values(runsLive)) {
      if (!r.agentId) continue;
      const list = byAgent.get(r.agentId) ?? [];
      list.push(r);
      byAgent.set(r.agentId, list);
    }

    const layerCounts = new Map<AgentLayer, number>();
    const nodes: Node<AgentNodeData>[] = [];
    for (const agent of agents) {
      const col = LAYER_ORDER.indexOf(agent.layer);
      const row = layerCounts.get(agent.layer) ?? 0;
      layerCounts.set(agent.layer, row + 1);

      const runs = byAgent.get(agent.id) ?? [];
      const active = runs.find((r) => r.status === "running") ?? runs.find((r) => r.status === "queued");
      const liveStatus = agentStatus[agent.slug] ?? agent.status;

      let state: SwarmState = "idle";
      if (liveStatus !== "active") state = "pausado";
      else if (active?.status === "queued") state = "esperando_turno";
      else if (active) {
        const phase: AgentPhase = active.phase;
        state = phase === "usando_tool" ? "usando_tool" : "pensando";
      } else {
        const blocked = Object.values(boardTasks).find(
          (t) => t.assigneeAgentId === agent.id && t.status === "BLOCKED",
        );
        if (blocked) state = "bloqueado";
      }

      const taskId = active?.taskId ?? null;
      const taskTitle = taskId ? (boardTasks[taskId]?.title ?? `tarea ${taskId.slice(0, 8)}`) : null;

      let tokens: number | null = null;
      let cost: number | null = null;
      for (const r of runs) {
        if (r.tokensIn !== null || r.tokensOut !== null) {
          tokens = (tokens ?? 0) + (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
        }
        if (r.costUsd !== null) cost = (cost ?? 0) + r.costUsd;
      }

      nodes.push({
        id: agent.id,
        type: "agent",
        position: { x: col * 280 + 20, y: row * 170 + 40 },
        data: {
          agent,
          state,
          currentTool: active?.currentTool ?? null,
          taskTitle,
          tokens,
          cost,
          activeRunId: active?.runId ?? null,
        },
        draggable: false,
      });
    }

    const bySlug = new Map(agents.map((a) => [a.slug, a.id]));
    const now = Date.now();
    const edges: Edge[] = edgesRaw
      .filter((e) => now - e.at < EDGE_TTL_MS)
      .map((e) => ({
        id: `${e.id}:${e.at}`,
        source: bySlug.get(e.from) ?? e.from,
        target: bySlug.get(e.to) ?? e.to,
        animated: true,
        label: "delega",
        data: { taskId: e.taskId },
        style: { stroke: "#0ea5e9", strokeWidth: 2 },
      }))
      .filter((e) => e.source !== e.target);

    return { nodes, edges };
  }, [agents, runsLive, boardTasks, edgesRaw, agentStatus]);

  if (agents.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="Sin agentes" hint="¿Está apps/api corriendo con el seed aplicado?" />
      </div>
    );
  }

  return (
    <div className="h-full" data-testid="swarm-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => {
          const runId = (node.data as AgentNodeData).activeRunId;
          if (runId) navigate(`/runs/${runId}`);
        }}
        onEdgeClick={(_, edge) => {
          const taskId = (edge.data as { taskId?: string } | undefined)?.taskId;
          if (taskId) void openTask(taskId);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="#e2e8f0" />
      </ReactFlow>
    </div>
  );
}
