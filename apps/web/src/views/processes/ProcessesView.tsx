/**
 * Procesos del cliente como flujograma editable: lista a la izquierda,
 * cabecera del proceso + flujograma (React Flow, un nodo por paso, carriles
 * por responsable) a la derecha, con puntos de dolor y sistemas debajo.
 */
import { useEffect, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ActionButton, Card, Chip, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";
import { api } from "../../lib/api";
import type { ProcessEntity, ProcessStep } from "../../lib/types";
import { LaneNode, type LaneNodeData } from "./LaneNode";
import { StepNode, type StepNodeData } from "./StepNode";
import StepPanel from "./StepPanel";
import { useProcesses } from "./useProcesses";

const nodeTypes = { step: StepNode, lane: LaneNode };
type FlowNode = Node<StepNodeData> | Node<LaneNodeData>;

const STEP_COLUMN_GAP = 300;
const STEP_CARD_WIDTH = 240;
const STEP_CARD_HEIGHT = 120;
const LANE_ROW_GAP = 180;
const LANE_MARGIN = 16;
const LANE_LABEL_SPACE = 28;
const SIN_RESPONSABLE = "__sin_responsable__";

/** Un nodo por paso (x = índice · 300) más un carril de fondo por cada
 * responsable distinto (y = índice del responsable · 180), igual patrón que
 * las áreas del organigrama. */
function computeStepLayout(
  steps: ProcessStep[],
  selectedIndex: number | null,
): { stepNodes: Node<StepNodeData>[]; laneNodes: Node<LaneNodeData>[] } {
  const laneIndexByKey = new Map<string, number>();
  let nextLane = 0;
  const stepNodes: Node<StepNodeData>[] = steps.map((s, i) => {
    const key = s.responsible?.trim() || SIN_RESPONSABLE;
    if (!laneIndexByKey.has(key)) laneIndexByKey.set(key, nextLane++);
    const lane = laneIndexByKey.get(key) as number;
    return {
      id: `step-${i}`,
      type: "step",
      position: { x: i * STEP_COLUMN_GAP, y: lane * LANE_ROW_GAP },
      draggable: false,
      selectable: true,
      connectable: false,
      selected: i === selectedIndex,
      data: {
        index: i,
        text: s.step,
        responsible: s.responsible ?? null,
        system: s.system ?? null,
      },
    };
  });

  const laneNodes: Node<LaneNodeData>[] = [];
  for (const [key, lane] of laneIndexByKey) {
    const nodesInLane = stepNodes.filter((n) => n.position.y === lane * LANE_ROW_GAP);
    const left = Math.min(...nodesInLane.map((n) => n.position.x)) - LANE_MARGIN;
    const top = lane * LANE_ROW_GAP - LANE_MARGIN - LANE_LABEL_SPACE;
    const right = Math.max(...nodesInLane.map((n) => n.position.x + STEP_CARD_WIDTH)) + LANE_MARGIN;
    const bottom = lane * LANE_ROW_GAP + STEP_CARD_HEIGHT + LANE_MARGIN;
    laneNodes.push({
      id: `lane-${lane}`,
      type: "lane",
      position: { x: left, y: top },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: -1,
      style: { width: right - left, height: bottom - top, pointerEvents: "none" },
      data: { laneIndex: lane, label: key === SIN_RESPONSABLE ? "Sin responsable" : key },
    });
  }
  return { stepNodes, laneNodes };
}

/** Lista editable de textos como chips con X, con "+ Añadir" al final. */
function ChipListEditor({
  processId,
  label,
  items,
  readOnly,
  placeholder,
  onSave,
}: {
  processId: string;
  label: string;
  items: string[];
  readOnly: boolean;
  placeholder: string;
  onSave(next: string[]): void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(""), [processId]);

  return (
    <Card className="p-4">
      <SectionHead label={label} count={items.length} />
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <Chip key={`${item}-${i}`} tone="quiet">
            {item}
            {!readOnly ? (
              <button
                type="button"
                aria-label={`Quitar ${item}`}
                onClick={() => onSave(items.filter((_, j) => j !== i))}
                className="press"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </Chip>
        ))}
      </div>
      {!readOnly ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = draft.trim();
            if (!trimmed) return;
            onSave([...items, trimmed]);
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 rounded-tight border border-line bg-surface px-2 py-1 text-small text-ink focus:border-link focus:outline-none"
          />
          <button type="submit" className="press text-small font-semibold text-link">
            + Añadir
          </button>
        </form>
      ) : null}
    </Card>
  );
}

export default function ProcessesView({
  orgId,
  readOnly,
}: {
  orgId: string;
  projectId: string;
  readOnly: boolean;
}) {
  const { processes, loading, error, reload, createProcess, updateProcess } = useProcesses(orgId);
  const [searchParams, setSearchParams] = useSearchParams();
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .orgGraph(orgId)
      .then((g) => {
        if (!cancelled) setRoleNames(g.roles.map((r) => r.name));
      })
      .catch(() => {
        // El selector de responsable queda vacío (solo "Sin responsable"); no
        // es bloqueante para ver o editar los procesos.
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const requestedId = searchParams.get("proceso");
  const selectedProcess: ProcessEntity | null = processes
    ? (processes.find((p) => p.id === requestedId) ?? processes[0] ?? null)
    : null;

  useEffect(() => {
    setSelectedStepIndex(null);
  }, [selectedProcess?.id]);

  const [nameDraft, setNameDraft] = useState(selectedProcess?.name ?? "");
  useEffect(() => setNameDraft(selectedProcess?.name ?? ""), [selectedProcess?.id, selectedProcess?.name]);

  function selectProcess(id: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("proceso", id);
      return next;
    });
  }

  async function handleCreate() {
    const created = await createProcess();
    if (created) selectProcess(created.id);
  }

  if (loading && !processes) return <Spinner label="Cargando los procesos…" />;
  if (error && !processes) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (!processes) return null;

  if (processes.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay procesos mapeados"
        hint="Créalo a mano o deja que los agentes lo extraigan de las entrevistas."
        action={
          !readOnly ? (
            <ActionButton variant="primary" onClick={() => void handleCreate()}>
              Nuevo proceso
            </ActionButton>
          ) : undefined
        }
      />
    );
  }

  const steps = selectedProcess?.steps ?? [];
  const { stepNodes, laneNodes } = computeStepLayout(steps, selectedStepIndex);
  const flowNodes: FlowNode[] = [...laneNodes, ...stepNodes];
  const flowEdges: Edge[] = steps.slice(1).map((_, i) => ({
    id: `step-${i}->step-${i + 1}`,
    source: `step-${i}`,
    target: `step-${i + 1}`,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-faint)" },
    style: { stroke: "var(--color-faint)", strokeWidth: 1.5 },
  }));

  function commitName() {
    if (!selectedProcess) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === selectedProcess.name) {
      setNameDraft(selectedProcess.name);
      return;
    }
    void updateProcess(selectedProcess.id, { name: trimmed });
  }

  function toggleVariant() {
    if (!selectedProcess) return;
    void updateProcess(selectedProcess.id, { variant: selectedProcess.variant === "as_is" ? "to_be" : "as_is" });
  }

  function toggleStatus() {
    if (!selectedProcess) return;
    void updateProcess(selectedProcess.id, { status: selectedProcess.status === "validated" ? "draft" : "validated" });
  }

  function commitSteps(next: ProcessStep[]) {
    if (!selectedProcess) return;
    void updateProcess(selectedProcess.id, { steps: next });
  }

  function updateStepAt(index: number, patch: Partial<ProcessStep>) {
    const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    commitSteps(next);
  }

  function insertStepAfter(index: number) {
    const next = [...steps.slice(0, index + 1), { step: "" }, ...steps.slice(index + 1)];
    commitSteps(next);
    setSelectedStepIndex(index + 1);
  }

  function moveStepBefore(index: number) {
    if (index <= 0) return;
    const next = [...steps];
    const prev = next[index - 1] as ProcessStep;
    next[index - 1] = next[index] as ProcessStep;
    next[index] = prev;
    commitSteps(next);
    setSelectedStepIndex(index - 1);
  }

  function moveStepAfter(index: number) {
    if (index >= steps.length - 1) return;
    const next = [...steps];
    const cur = next[index] as ProcessStep;
    next[index] = next[index + 1] as ProcessStep;
    next[index + 1] = cur;
    commitSteps(next);
    setSelectedStepIndex(index + 1);
  }

  function deleteStepAt(index: number) {
    commitSteps(steps.filter((_, i) => i !== index));
    setSelectedStepIndex(null);
  }

  return (
    <div className="lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-4">
      <Card className="p-3">
        {!readOnly ? (
          <ActionButton variant="primary" className="mb-3 w-full" onClick={() => void handleCreate()}>
            Nuevo proceso
          </ActionButton>
        ) : null}
        <ul className="space-y-1">
          {processes.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => selectProcess(p.id)}
                className={`block w-full rounded-tight px-2.5 py-2 text-left ${
                  selectedProcess?.id === p.id ? "bg-link-bg" : "hover:bg-canvas-deep"
                }`}
              >
                <p className="truncate text-small font-semibold text-ink">{p.name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Chip tone="quiet">{p.variant === "as_is" ? "Tal como es" : "Como debería ser"}</Chip>
                  <Chip tone={p.status === "validated" ? "done" : "work"}>
                    {p.status === "validated" ? "Validado" : "Borrador"}
                  </Chip>
                </div>
                <p className="mt-1 text-small text-muted">
                  {(p.steps ?? []).length} pasos · responsable: {p.ownerPerson ?? "sin responsable"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {selectedProcess ? (
        <div className="mt-4 min-w-0 lg:mt-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={nameDraft}
              disabled={readOnly}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="min-w-0 flex-1 border-0 bg-transparent text-title font-semibold text-ink focus:outline-none disabled:opacity-100"
            />
            <button type="button" disabled={readOnly} onClick={toggleVariant} className="press">
              <Chip tone="quiet">{selectedProcess.variant === "as_is" ? "Tal como es" : "Como debería ser"}</Chip>
            </button>
            <button type="button" disabled={readOnly} onClick={toggleStatus} className="press">
              <Chip tone={selectedProcess.status === "validated" ? "done" : "work"}>
                {selectedProcess.status === "validated" ? "Validado" : "Borrador"}
              </Chip>
            </button>
            <label className="flex items-center gap-1.5 text-small text-muted">
              Responsable
              <select
                value={selectedProcess.ownerPerson ?? ""}
                disabled={readOnly}
                onChange={(e) => void updateProcess(selectedProcess.id, { owner_person: e.target.value || null })}
                className="rounded-tight border border-line bg-surface px-2 py-1 text-small text-ink disabled:opacity-70"
              >
                <option value="">Sin responsable</option>
                {roleNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-4 md:flex-row">
            <div
              key={selectedProcess.id}
              className="h-[520px] min-w-0 flex-1 overflow-hidden rounded-panel bg-surface shadow-rest"
            >
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodeClick={(_, node) => {
                  if (node.type !== "step") return;
                  setSelectedStepIndex(Number(node.id.replace("step-", "")));
                }}
                onPaneClick={() => setSelectedStepIndex(null)}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background color="var(--color-line)" />
                <Controls />
              </ReactFlow>
            </div>

            {selectedStepIndex !== null && steps[selectedStepIndex] ? (
              <StepPanel
                step={steps[selectedStepIndex] as ProcessStep}
                index={selectedStepIndex}
                total={steps.length}
                readOnly={readOnly}
                roleNames={roleNames}
                onClose={() => setSelectedStepIndex(null)}
                onCommit={(patch) => updateStepAt(selectedStepIndex, patch)}
                onInsertAfter={() => insertStepAfter(selectedStepIndex)}
                onMoveBefore={() => moveStepBefore(selectedStepIndex)}
                onMoveAfter={() => moveStepAfter(selectedStepIndex)}
                onDelete={() => deleteStepAt(selectedStepIndex)}
              />
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <ChipListEditor
              processId={selectedProcess.id}
              label="Puntos de dolor"
              items={selectedProcess.painPoints ?? []}
              readOnly={readOnly}
              placeholder="Nuevo punto de dolor…"
              onSave={(next) => void updateProcess(selectedProcess.id, { pain_points: next })}
            />
            <ChipListEditor
              processId={selectedProcess.id}
              label="Sistemas"
              items={selectedProcess.systems ?? []}
              readOnly={readOnly}
              placeholder="Nuevo sistema…"
              onSave={(next) => void updateProcess(selectedProcess.id, { systems: next })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
