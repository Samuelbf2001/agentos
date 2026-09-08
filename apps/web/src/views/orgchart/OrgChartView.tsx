/**
 * Organigrama del cliente (canvas editable). El rol es el centro del grafo:
 * pertenece a un área, reporta a otro rol, lo ocupan personas, tiene
 * funciones y participa en procesos. Al pulsar un rol se abre RolePanel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useParams } from "react-router-dom";
import { ActionButton } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";
import { InlinePopover, PopoverSearch } from "../../components/ui/InlinePopover";
import type { OrgUnit } from "../../lib/types";
import { AreaNode, type AreaNodeData } from "./AreaNode";
import { layoutRoles } from "./layout";
import { RoleNode, type RoleNodeData } from "./RoleNode";
import RolePanel from "./RolePanel";
import { useOrgGraph } from "./useOrgGraph";

const nodeTypes = { role: RoleNode, area: AreaNode };

/** Nodo que puede vivir en el canvas: rol (interactivo) o área (fondo). */
type CanvasNode = Node<RoleNodeData> | Node<AreaNodeData>;

/** Seis tonos fijos, todos tokens existentes; sin área usa bg-faint aparte. */
const AREA_COLORS = ["bg-link", "bg-done", "bg-work", "bg-decide", "bg-broken", "bg-ink-2"];
/** Mismo orden que AREA_COLORS: fondo translúcido del rectángulo de área. */
const AREA_BG_TINT = ["bg-link/10", "bg-done/10", "bg-work/10", "bg-decide/10", "bg-broken/10", "bg-ink-2/10"];
/** Mismo orden que AREA_COLORS: color de texto de la etiqueta del área. */
const AREA_TEXT_COLORS = ["text-link", "text-done", "text-work", "text-decide", "text-broken", "text-ink-2"];

function colorForUnit(units: OrgUnit[], unitId: string | null): string {
  if (!unitId) return "bg-faint";
  const idx = units.findIndex((u) => u.id === unitId);
  return idx === -1 ? "bg-faint" : (AREA_COLORS[idx % AREA_COLORS.length] ?? "bg-faint");
}

// Caja envolvente de cada área a partir de las posiciones absolutas de sus
// roles: 220px de ancho de tarjeta, alto medido por React Flow o 120px por
// defecto, 24px de margen y 36px extra arriba para la etiqueta.
const AREA_MARGIN = 24;
const AREA_LABEL_SPACE = 36;
const ROLE_CARD_WIDTH = 220;
const ROLE_CARD_DEFAULT_HEIGHT = 120;

function computeAreaNodes(
  roleNodes: Node<RoleNodeData>[],
  units: OrgUnit[],
  highlightUnitId: string | null,
): Node<AreaNodeData>[] {
  const areas: Node<AreaNodeData>[] = [];
  units.forEach((unit, i) => {
    const rolesInUnit = roleNodes.filter((n) => n.data.role.unitId === unit.id);
    if (rolesInUnit.length === 0) return;
    const left = Math.min(...rolesInUnit.map((n) => n.position.x)) - AREA_MARGIN;
    const top = Math.min(...rolesInUnit.map((n) => n.position.y)) - AREA_MARGIN - AREA_LABEL_SPACE;
    const right = Math.max(...rolesInUnit.map((n) => n.position.x + ROLE_CARD_WIDTH)) + AREA_MARGIN;
    const bottom =
      Math.max(...rolesInUnit.map((n) => n.position.y + (n.measured?.height ?? ROLE_CARD_DEFAULT_HEIGHT))) +
      AREA_MARGIN;
    areas.push({
      id: `area-${unit.id}`,
      type: "area",
      position: { x: left, y: top },
      draggable: false,
      selectable: false,
      connectable: false,
      zIndex: -1,
      style: { width: right - left, height: bottom - top, pointerEvents: "none" },
      data: {
        unitId: unit.id,
        name: unit.name,
        roleCount: rolesInUnit.length,
        bgClass: AREA_BG_TINT[i % AREA_BG_TINT.length] ?? "bg-faint/10",
        textClass: AREA_TEXT_COLORS[i % AREA_TEXT_COLORS.length] ?? "text-faint",
        dimmed: highlightUnitId !== null && highlightUnitId !== unit.id,
      },
    });
  });
  return areas;
}

export default function OrgChartView({ orgId, readOnly = false }: { orgId: string; readOnly?: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  const {
    graph,
    loading,
    error,
    reload,
    createUnit,
    createRole,
    updateRole,
    deleteRole,
    setFunctions,
    setPeople,
    setProcesses,
    applyRole,
  } = useOrgGraph(orgId);

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [highlightUnitId, setHighlightUnitId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<RoleNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [newAreaOpen, setNewAreaOpen] = useState(false);
  const [newAreaName, setNewAreaName] = useState("");

  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);

  // Reconstruye nodos/aristas cada vez que cambia el grafo, la selección o el
  // filtro de área. No toca el estado durante un arrastre en curso: eso pasa
  // solo dentro de React Flow (onNodesChange) hasta que se persiste.
  useEffect(() => {
    if (!graph) return;
    const layout = layoutRoles(graph.roles);
    const peopleById = new Map(graph.people.map((p) => [p.id, p]));

    const nextNodes: Node<RoleNodeData>[] = graph.roles.map((role) => {
      const pos =
        role.canvasX !== null && role.canvasY !== null
          ? { x: role.canvasX, y: role.canvasY }
          : (layout.get(role.id) ?? { x: 0, y: 0 });
      const unit = role.unitId ? (graph.units.find((u) => u.id === role.unitId) ?? null) : null;
      return {
        id: role.id,
        type: "role",
        position: pos,
        selected: role.id === selectedRoleId,
        draggable: !readOnly,
        connectable: !readOnly,
        data: {
          role,
          areaName: unit?.name ?? null,
          areaColor: colorForUnit(graph.units, role.unitId),
          people: role.people
            .map((rp) => peopleById.get(rp.personId))
            .filter((p): p is NonNullable<typeof p> => Boolean(p))
            .map((p) => ({ id: p.id, fullName: p.fullName })),
          dimmed: highlightUnitId !== null && role.unitId !== highlightUnitId,
        },
      };
    });
    setNodes(nextNodes);

    const nextEdges: Edge[] = graph.roles
      .filter((r) => r.reportsToRoleId)
      .map((r) => ({
        id: `${r.reportsToRoleId}->${r.id}`,
        source: r.reportsToRoleId as string,
        target: r.id,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-faint)" },
        style: { stroke: "var(--color-faint)", strokeWidth: 1.5 },
      }));
    setEdges(nextEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, selectedRoleId, highlightUnitId, readOnly]);

  // Supr con un rol seleccionado: confirma y elimina. Se ignora si el foco
  // está en un campo de edición (la ficha también usa Supr para borrar texto).
  useEffect(() => {
    if (readOnly) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete") return;
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (!selectedRoleId) return;
      if (!window.confirm("¿Eliminar este rol? Esta acción no se puede deshacer.")) return;
      void deleteRole(selectedRoleId);
      setSelectedRoleId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRoleId, readOnly, deleteRole]);

  // Los rectángulos de área son derivados: se recalculan a partir de las
  // posiciones absolutas de los roles cada vez que cambian (arrastre
  // incluido), nunca se persisten y nunca entran al estado de nodos de rol.
  const areaNodes = useMemo<Node<AreaNodeData>[]>(
    () => (graph ? computeAreaNodes(nodes, graph.units, highlightUnitId) : []),
    [nodes, graph, highlightUnitId],
  );
  const canvasNodes = useMemo<CanvasNode[]>(() => [...areaNodes, ...nodes], [areaNodes, nodes]);

  if (loading && !graph) return <Spinner label="Cargando el organigrama…" />;
  if (error && !graph) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (!graph) return null;

  const selectedRole = graph.roles.find((r) => r.id === selectedRoleId) ?? null;
  const vacantCount = graph.roles.filter((r) => r.people.length === 0).length;

  async function createRoleAt(position: { x: number; y: number }) {
    const role = await createRole({ name: "Nuevo rol", canvasX: position.x, canvasY: position.y });
    if (role) setSelectedRoleId(role.id);
  }

  function centerOfViewport(): { x: number; y: number } {
    const instance = instanceRef.current;
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!instance || !bounds) return { x: 0, y: 0 };
    return instance.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  }

  function onConnect(connection: Connection) {
    if (readOnly || !connection.source || !connection.target) return;
    void updateRole(connection.target, { reports_to_role_id: connection.source });
  }

  // Los nodos de área no forman parte del estado de roles (se derivan en el
  // useMemo de arriba): se descartan aquí los cambios que React Flow reporta
  // para ellos (p. ej. medición de tamaño) antes de aplicar el resto sobre
  // los roles.
  function handleNodesChange(changes: NodeChange<CanvasNode>[]) {
    const roleIds = new Set(nodes.map((n) => n.id));
    const roleChanges = changes.filter((c) => "id" in c && roleIds.has(c.id));
    onNodesChange(roleChanges as NodeChange<Node<RoleNodeData>>[]);
  }

  function onNodeDragStop(_: unknown, node: Node) {
    if (readOnly) return;
    void updateRole(node.id, { canvas_x: node.position.x, canvas_y: node.position.y });
  }

  function onEdgesDelete(deleted: Edge[]) {
    if (readOnly) return;
    for (const edge of deleted) void updateRole(edge.target, { reports_to_role_id: null });
  }

  function onPaneDoubleClick(event: React.MouseEvent) {
    if (readOnly) return;
    const target = event.target as HTMLElement;
    if (target.closest(".react-flow__node")) return;
    const instance = instanceRef.current;
    const position = instance
      ? instance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: 0, y: 0 };
    void createRoleAt(position);
  }

  if (graph.roles.length === 0) {
    return (
      <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-5 sm:px-5">
        <EmptyState
          title="Todavía no hay organigrama"
          hint="Crea el primer rol o dibuja el área de dirección. Los agentes lo completarán a partir de las entrevistas."
          action={
            !readOnly ? (
              <ActionButton variant="primary" onClick={() => void createRoleAt({ x: 0, y: 0 })}>
                Nuevo rol
              </ActionButton>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-5 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <ActionButton variant="primary" onClick={() => void createRoleAt(centerOfViewport())}>
            Nuevo rol
          </ActionButton>
        ) : null}
        {!readOnly ? (
          <InlinePopover
            open={newAreaOpen}
            onOpenChange={setNewAreaOpen}
            label="Nueva área"
            trigger={<ActionButton variant="quiet">Nueva área</ActionButton>}
          >
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newAreaName.trim();
                if (!name) return;
                void createUnit(name);
                setNewAreaName("");
                setNewAreaOpen(false);
              }}
            >
              <PopoverSearch
                value={newAreaName}
                onChange={setNewAreaName}
                label="Nombre del área"
                placeholder="Nombre del área…"
              />
              <ActionButton variant="primary" type="submit">
                Crear
              </ActionButton>
            </form>
          </InlinePopover>
        ) : null}

        <div className="flex flex-wrap items-center gap-2.5">
          {graph.units.map((u, i) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setHighlightUnitId((cur) => (cur === u.id ? null : u.id))}
              className={`press inline-flex items-center gap-1.5 text-label ${
                highlightUnitId === null || highlightUnitId === u.id ? "text-muted" : "text-faint"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${AREA_COLORS[i % AREA_COLORS.length]}`} aria-hidden="true" />
              {u.name}
            </button>
          ))}
        </div>

        <div className="ml-auto text-small text-muted">
          {graph.roles.length} roles · {vacantCount} vacantes
        </div>
      </div>

      <div className="flex flex-col gap-4 md:flex-row">
        <div
          ref={wrapperRef}
          onDoubleClick={onPaneDoubleClick}
          className="h-[calc(100vh-8rem)] min-h-[520px] min-w-0 flex-1 overflow-hidden rounded-panel bg-surface shadow-rest"
        >
          <ReactFlow<CanvasNode, Edge>
            nodes={canvasNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={readOnly ? undefined : handleNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onNodeDragStop={readOnly ? undefined : onNodeDragStop}
            onEdgesDelete={readOnly ? undefined : onEdgesDelete}
            onNodeClick={(_, node) => setSelectedRoleId(node.id)}
            onPaneClick={() => setSelectedRoleId(null)}
            onInit={(instance) => {
              instanceRef.current = instance;
            }}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--color-line)" />
            <Controls />
            <MiniMap pannable />
          </ReactFlow>
        </div>

        {selectedRole ? (
          <RolePanel
            role={selectedRole}
            graph={graph}
            readOnly={readOnly}
            projectId={projectId ?? ""}
            onClose={() => setSelectedRoleId(null)}
            updateRole={updateRole}
            deleteRole={deleteRole}
            setFunctions={setFunctions}
            setPeople={setPeople}
            setProcesses={setProcesses}
            applyRole={applyRole}
          />
        ) : null}
      </div>
    </div>
  );
}
