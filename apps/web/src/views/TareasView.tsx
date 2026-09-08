/**
 * Tareas: la base transversal (PLAN-v1.5 §Navegación nueva; MODELO-TENANCY-v1.4
 * §El tenant de agencia es el Notion de Sixteam).
 *
 * "No tengo que entrar a cada módulo o cada cliente para ver las tareas."
 * Entonces esta vista es el reemplazo de la base de tareas de Notion para el
 * trabajo diario de Sixteam: TODAS las tareas de TODOS los clientes y
 * proyectos en una sola lista, con dos modos —tabla y tablero por estado—,
 * agrupación y filtros combinables, y creación rápida sin salir de aquí.
 *
 * El cliente y el proyecto son columnas por las que se filtra y desde las que
 * se salta al contexto, nunca puertas que haya que cruzar antes de ver el
 * trabajo. "Mis tareas" es uno de esos filtros (atajo `m`), no otra pantalla.
 *
 * Se lee de `GET /api/tasks` sin `project_id`: la API ya devuelve la base
 * entera con sus responsables, así que los filtros se cruzan en el navegador y
 * ninguna combinación cuesta una ida y vuelta.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronsUpDown, Search, SlidersHorizontal } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useStore } from "../state/store";
import { api } from "../lib/api";
import { paths } from "../lib/paths";
import { ActionButton, Card } from "../components/system";
import {
  DuePill,
  EmptyState,
  ErrorBox,
  PersonAvatar,
  PriorityDot,
  Spinner,
  STATUS_LABELS,
  STATUS_TONES,
  StatusPill,
} from "../components/ui";
import {
  HUMAN_TRANSITIONS,
  TASK_STATUSES,
  getTaskLabels,
  isTerminalStatus,
  type Task,
  type TaskStatus,
} from "../lib/types";
import {
  AGRUPACIONES,
  AGRUPACION_LABELS,
  COLUMNAS,
  COLUMNA_LABELS,
  FILTROS_VACIOS,
  VENCIMIENTOS,
  VENCIMIENTO_LABELS,
  VISTAS,
  VISTA_LABELS,
  YO,
  agrupar,
  chipsActivos,
  clienteLabel,
  clientesDe,
  filtrar,
  filtrosAParams,
  guardarProyectoReciente,
  leerProyectoReciente,
  ordenar,
  orgIdOf,
  parseAgrupacion,
  parseFiltros,
  parseOrden,
  parseVista,
  personName,
  projectOf,
  responsablePrincipal,
  type Agrupacion,
  type Columna,
  type Contexto,
  type Filtros,
  type Vista,
} from "../lib/tareas";
import { CreateTaskDialog } from "./CreateTaskDialog";

const selectClass =
  "min-h-8 rounded-tight border border-line bg-surface px-2 py-1 text-small text-ink-2 focus:border-link focus:outline-none focus:ring-2 focus:ring-link";

/**
 * Tope de render (I2): con miles de tareas la base entera se pide de una
 * sola vez, pero pintar todas las filas de golpe cuesta. Filtros y contadores
 * siguen viendo el total; sólo la tabla/tablero se sirve por páginas.
 */
const RENDER_STEP = 200;

// ── Estado en línea: el motor puede decir que no, y entonces se revierte ────

/**
 * Un solo camino para cambiar de estado desde esta vista: lo usan el
 * desplegable de la fila y el arrastre entre columnas del tablero. Pinta el
 * destino ya (optimista) y manda `expected_version`; si el motor rechaza —
 * transición ilegal, falta de evidencia, conflicto de versión— se revierte la
 * tarea a como estaba y se abre la ficha con el mensaje real, en vez de dejar
 * un error mudo. La máquina de estados no se replica aquí: manda la API.
 */
function useMoverTarea(onChanged: (task: Task) => void) {
  const pushToast = useStore((s) => s.pushToast);
  const openTask = useStore((s) => s.openTask);
  return useCallback(
    async (task: Task, to: TaskStatus): Promise<boolean> => {
      if (to === task.status) return true;
      onChanged({ ...task, status: to });
      try {
        const { task: updated } = await api.moveTask(task.id, {
          to,
          expected_version: task.version,
        });
        onChanged(updated);
        return true;
      } catch (err) {
        onChanged(task);
        const message = err instanceof Error ? err.message : "La API rechazó la transición";
        pushToast("error", message);
        void openTask(task.id);
        return false;
      }
    },
    [onChanged, openTask, pushToast],
  );
}

function StatusSelect({
  task,
  onChanged,
}: {
  task: Task;
  onChanged: (task: Task) => void;
}) {
  const mover = useMoverTarea(onChanged);
  const [busy, setBusy] = useState(false);
  const tone = STATUS_TONES[task.status];
  const toneClass =
    tone === "work"
      ? "bg-work-bg text-work border-work-line"
      : tone === "decide"
        ? "bg-decide-bg text-decide border-decide-line"
        : tone === "broken"
          ? "bg-broken-bg text-broken border-broken-line"
          : tone === "done"
            ? "bg-done-bg text-done border-done-line"
            : "bg-surface text-muted border-line";

  async function move(to: TaskStatus): Promise<void> {
    if (to === task.status) return;
    setBusy(true);
    try {
      // La regla anti-teatro (ningún REVIEW/DONE sin evidencia) se resuelve en
      // la ficha, no aquí: `useMoverTarea` la abre en vez de dejar un error
      // mudo en la fila.
      await mover(task, to);
    } finally {
      setBusy(false);
    }
  }

  // Sólo se ofrecen las transiciones humanas válidas desde el estado actual
  // (I4); en un estado terminal (DONE/CANCELLED) el desplegable se deshabilita.
  const terminal = isTerminalStatus(task.status);
  const options = [task.status, ...HUMAN_TRANSITIONS[task.status]];

  return (
    <select
      aria-label={`Estado de ${task.title}`}
      data-testid={`tarea-estado-${task.id}`}
      data-status={task.status}
      disabled={busy || terminal}
      value={task.status}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => void move(event.target.value as TaskStatus)}
      className={`min-h-[22px] appearance-none rounded-[6px] border px-1.5 py-0.5 text-label font-semibold focus:outline-none focus:ring-2 focus:ring-link disabled:opacity-50 ${toneClass}`}
    >
      {options.map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

// ── Título en línea ─────────────────────────────────────────────────────────

function TitleCell({ task, onChanged }: { task: Task; onChanged: (task: Task) => void }) {
  const openTask = useStore((s) => s.openTask);
  const pushToast = useStore((s) => s.pushToast);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setValue(task.title);
  }, [task.title, editing]);

  async function save(): Promise<void> {
    const title = value.trim();
    setEditing(false);
    if (!title || title === task.title) return;
    setBusy(true);
    try {
      const { task: updated } = await api.updateTask(task.id, {
        expected_version: task.version,
        title,
      });
      onChanged(updated);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "No se pudo renombrar la tarea");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        data-testid={`tarea-titulo-input-${task.id}`}
        aria-label={`Título de ${task.title}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") void save();
          if (event.key === "Escape") {
            setValue(task.title);
            setEditing(false);
          }
        }}
        className="min-h-6 w-full rounded-tight border border-link bg-surface px-1.5 py-0.5 text-small text-ink focus:outline-none"
      />
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <PriorityDot priority={task.priority} />
      <button
        type="button"
        data-testid={`tarea-abrir-${task.id}`}
        onClick={(event) => {
          event.stopPropagation();
          void openTask(task.id);
        }}
        className={`min-w-0 max-w-[15rem] flex-1 truncate text-left text-small font-medium text-ink hover:text-link ${busy ? "opacity-50" : ""}`}
      >
        {task.title}
      </button>
      <button
        type="button"
        title="Renombrar aquí mismo"
        aria-label={`Renombrar ${task.title}`}
        data-testid={`tarea-renombrar-${task.id}`}
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
        className="press shrink-0 rounded-tight px-1 text-label text-faint opacity-0 hover:text-ink-2 group-hover:opacity-100"
      >
        <span aria-hidden="true">✎</span>
      </button>
    </span>
  );
}

// ── Fila de la tabla ────────────────────────────────────────────────────────

function TaskRow({
  task,
  ctx,
  selected,
  onChanged,
}: {
  task: Task;
  ctx: Contexto;
  selected: boolean;
  onChanged: (task: Task) => void;
}) {
  const openTask = useStore((s) => s.openTask);
  const project = projectOf(task, ctx.projects);
  const orgId = orgIdOf(task, ctx.projects);
  const labels = getTaskLabels(task);
  const responsable = responsablePrincipal(task);
  const overdue = task.status !== "DONE" && task.status !== "CANCELLED" && (task.dueAt ?? task.due_at ?? Number.POSITIVE_INFINITY) < Date.now();

  const cell = "border-b border-line-soft px-1.5 py-1 align-middle";

  return (
    <tr
      data-testid={`tarea-fila-${task.id}`}
      data-selected={selected ? "true" : undefined}
      aria-selected={selected}
      onClick={() => void openTask(task.id)}
      className={`group h-8 cursor-pointer transition-colors hover:bg-canvas-deep/40 ${
        selected ? "bg-link-bg" : ""
      } ${overdue ? "late" : ""}`}
    >
      <td className={`${cell} w-full`}>
        <TitleCell task={task} onChanged={onChanged} />
      </td>
      <td className={`${cell} max-w-[11rem] truncate text-small`}>
        {orgId ? (
          <Link
            to={paths.tareas({ cliente: orgId })}
            onClick={(event) => event.stopPropagation()}
            className="block max-w-[8rem] truncate text-link hover:underline"
          >
            {clienteLabel(orgId, ctx)}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className={`${cell} max-w-[11rem] truncate text-small`}>
        {project ? (
          <Link
            to={paths.proyecto(project.id, "ruta")}
            title="Ir a la Ruta del proyecto"
            onClick={(event) => event.stopPropagation()}
            className="block max-w-[8rem] truncate text-ink-2 hover:text-link hover:underline"
          >
            {project.name}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <StatusSelect task={task} onChanged={onChanged} />
      </td>
      <td className={`${cell} max-w-[9rem] truncate text-small text-ink-2`}>
        {responsable ? (
          <span className="flex items-center gap-1.5">
            <PersonAvatar name={personName(responsable, ctx.people)} size={5} />
            <span className="max-w-[6rem] truncate">{personName(responsable, ctx.people)}</span>
          </span>
        ) : (
          <span className="text-faint">Sin responsable</span>
        )}
      </td>
      <td className={`${cell} max-w-[9rem]`}>
        <span className="flex max-w-[5rem] gap-1 overflow-hidden">
          {labels.length === 0 ? <span className="text-label text-faint">—</span> : null}
          {labels.map((label) => (
            <Link
              key={label}
              to={paths.tareas({ etiqueta: label })}
              onClick={(event) => event.stopPropagation()}
              className="shrink-0 rounded-full bg-link-bg px-1.5 py-0.5 text-label text-link"
            >
              {label}
            </Link>
          ))}
        </span>
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <span className="block max-w-[8.25rem] truncate">
          <DuePill task={task} />
        </span>
      </td>
      <td className={`${cell} whitespace-nowrap text-label text-muted`}>
        {task.priority === "urgent"
          ? "Urgente"
          : task.priority === "high"
            ? "Alta"
            : task.priority === "low"
              ? "Baja"
              : "Normal"}
      </td>
    </tr>
  );
}

// ── Tablero por estado ──────────────────────────────────────────────────────

/**
 * La misma tarea de la tabla, en tarjeta: título, de quién es el trabajo
 * (cliente · proyecto), quién responde, cuándo vence y con qué prioridad. Se
 * arrastra a otra columna para cambiarle el estado y se abre con un clic; no
 * se edita en línea (para eso está la tabla o la ficha).
 */
function TareaTarjeta({ task, ctx }: { task: Task; ctx: Contexto }) {
  const openTask = useStore((s) => s.openTask);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });
  const project = projectOf(task, ctx.projects);
  const orgId = orgIdOf(task, ctx.projects);
  const responsable = responsablePrincipal(task);
  const responsableNombre = personName(responsable, ctx.people);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      data-testid={`tarea-tarjeta-${task.id}`}
      data-status={task.status}
      aria-label={`${task.title}. ${clienteLabel(orgId, ctx)}. ${STATUS_LABELS[task.status]}`}
      onClick={() => {
        if (!isDragging) void openTask(task.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openTask(task.id);
        }
      }}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30 }
          : undefined
      }
      className={`group min-w-0 cursor-grab rounded-panel border border-line bg-surface p-2.5 text-left shadow-rest transition-shadow hover:shadow-raise focus:outline-none focus:ring-2 focus:ring-link ${
        isDragging ? "opacity-70 shadow-float" : ""
      }`}
    >
      <span className="flex items-start gap-1.5">
        <PriorityDot priority={task.priority} />
        <span className="min-w-0 flex-1 text-small font-medium leading-snug text-ink">
          {task.title}
        </span>
      </span>
      <p className="mt-1 truncate text-label text-muted">
        {clienteLabel(orgId, ctx)}
        {project ? ` · ${project.name}` : ""}
      </p>
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        {responsable ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={responsableNombre}>
            <PersonAvatar name={responsableNombre} size={5} />
            <span className="max-w-[7rem] truncate text-label text-muted">{responsableNombre}</span>
          </span>
        ) : (
          <span className="text-label text-faint">Sin responsable</span>
        )}
        <span className="ml-auto shrink-0">
          <DuePill task={task} />
        </span>
      </div>
    </div>
  );
}

function ColumnaEstado({
  status,
  tasks,
  ctx,
}: {
  status: TaskStatus;
  tasks: Task[];
  ctx: Contexto;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { status } });
  return (
    <section
      data-testid={`tareas-columna-${status}`}
      className="flex w-[16rem] shrink-0 flex-col rounded-panel border border-line bg-canvas-deep/40"
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-2.5 py-2">
        <StatusPill status={status} />
        <span
          data-testid={`tareas-conteo-${status}`}
          className="ml-auto rounded-full bg-surface px-1.5 py-px text-label tabular-nums text-muted"
        >
          {tasks.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-24 flex-1 space-y-2 p-2 transition-colors ${
          isOver ? "bg-link-bg ring-1 ring-link" : ""
        }`}
      >
        {tasks.map((task) => (
          <TareaTarjeta key={task.id} task={task} ctx={ctx} />
        ))}
        {tasks.length === 0 ? (
          <p className="px-1 py-1.5 text-label text-faint">Sin tareas aquí</p>
        ) : null}
      </div>
    </section>
  );
}

// ── La vista ────────────────────────────────────────────────────────────────

export default function TareasView() {
  const projects = useStore((s) => s.projects);
  const loadProjects = useStore((s) => s.loadProjects);
  const people = useStore((s) => s.people);
  const loadPeople = useStore((s) => s.loadPeople);
  const labelCatalog = useStore((s) => s.labelCatalog);
  const loadLabels = useStore((s) => s.loadLabels);
  const me = useStore((s) => s.person);
  const createTask = useStore((s) => s.createTask);
  const openTask = useStore((s) => s.openTask);
  const detailTask = useStore((s) => s.taskDetail?.task ?? null);
  const taskDetailId = useStore((s) => s.taskDetailId);

  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [quickTitle, setQuickTitle] = useState("");
  const [quickProject, setQuickProject] = useState<string>(() => leerProyectoReciente() ?? "");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  // El panel de filtros es un plegable local: no viaja en la URL, así que un
  // enlace compartido no arrastra si el que lo abrió lo tenía desplegado.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Arrastrar sólo empieza tras 6 px: un clic en la tarjeta sigue siendo un
  // clic que abre la ficha (mismo umbral que el tablero del proyecto).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const filtros = useMemo(() => parseFiltros(params), [params]);
  const agrupacion = useMemo(() => parseAgrupacion(params), [params]);
  const orden = useMemo(() => parseOrden(params), [params]);
  const vista = useMemo(() => parseVista(params), [params]);

  const ctx = useMemo<Contexto>(
    () => ({ projects, people, meId: me?.id ?? null }),
    [projects, people, me],
  );

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      // Sin `project_id`: la base es una sola y cruza todos los clientes.
      const result = await api.tasks({});
      setTasks(result.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las tareas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
    void loadProjects();
    void loadPeople();
    // El catálogo global (sin proyecto) es el correcto: la vista cruza proyectos.
    void loadLabels(undefined);
  }, [cargar, loadProjects, loadPeople, loadLabels]);

  // Lo que se edita en la ficha se ve en la fila sin recargar la base entera.
  useEffect(() => {
    if (!detailTask) return;
    setTasks((prev) =>
      prev ? prev.map((task) => (task.id === detailTask.id ? detailTask : task)) : prev,
    );
  }, [detailTask]);

  useEffect(() => {
    if (!quickProject && projects.length > 0) setQuickProject(projects[0]!.id);
  }, [projects, quickProject]);

  // El nombre del cliente ya no cuesta una petición por proyecto: `orgName`
  // viene en `GET /api/projects` y `clienteLabel` lo lee de ahí. Los proyectos
  // importados de Notion no tienen recibo de launch, así que pedirlo dejaba a
  // media base con "Cliente 01a074" a cambio de 34 llamadas al montar.

  function aplicar(
    next: Filtros,
    extra?: { agrupacion?: Agrupacion; orden?: typeof orden; vista?: Vista },
  ): void {
    setParams(
      filtrosAParams(next, {
        agrupacion: extra?.agrupacion ?? agrupacion,
        orden: extra?.orden ?? orden,
        vista: extra?.vista ?? vista,
      }),
      { replace: true },
    );
    setCursor(-1);
  }

  function setFiltro<K extends keyof Filtros>(key: K, value: Filtros[K]): void {
    aplicar({ ...filtros, [key]: value });
  }

  const visibles = useMemo(() => {
    if (!tasks) return [];
    return ordenar(filtrar(tasks, filtros, ctx), orden.columna, orden.direccion, ctx);
  }, [tasks, filtros, ctx, orden]);

  // El tope de render vuelve a 200 cuando cambian filtros, agrupación u
  // orden: si no, "Mostrar más" de una vista anterior se arrastraría a otra.
  useEffect(() => {
    setRenderLimit(RENDER_STEP);
  }, [filtros, agrupacion, orden, vista]);

  const visiblesRender = useMemo(() => visibles.slice(0, renderLimit), [visibles, renderLimit]);

  /**
   * En tablero la agrupación elegida se ignora —el tablero YA agrupa por
   * estado—, así que los grupos se calculan por estado: eso mantiene el
   * recorrido del teclado en el mismo orden en que se ven las columnas.
   */
  const grupos = useMemo(
    () => agrupar(visiblesRender, vista === "tablero" ? "estado" : agrupacion, ctx),
    [visiblesRender, vista, agrupacion, ctx],
  );

  /**
   * Columnas del tablero. El paginado es el mismo que el de la tabla y por la
   * misma razón: se reparte `visiblesRender` (los primeros `renderLimit` de la
   * base ya filtrada y ordenada) entre las columnas, y "Mostrar más" sube el
   * tope para todas a la vez. Con 1232 tareas reales, repartir el tope global
   * es lo único que mantiene un solo contador honesto: "Mostrando N de M".
   */
  const porEstado = useMemo(() => {
    const cells = new Map<TaskStatus, Task[]>();
    for (const status of TASK_STATUSES) cells.set(status, []);
    for (const task of visiblesRender) cells.get(task.status)?.push(task);
    return cells;
  }, [visiblesRender]);
  /** Orden de recorrido del teclado: el mismo que se ve, grupo a grupo. */
  const recorrido = useMemo(() => grupos.flatMap((grupo) => grupo.tasks), [grupos]);
  const chips = useMemo(() => chipsActivos(filtros, ctx), [filtros, ctx]);
  // El texto vive en el buscador, siempre visible: el badge de "Filtros"
  // cuenta sólo lo que está dentro del panel plegable.
  const filtrosPanelCount = useMemo(() => chips.filter((chip) => chip.key !== "texto").length, [chips]);
  const clientes = useMemo(() => clientesDe(ctx), [ctx]);
  const proyectosDelCliente = useMemo(
    () => (filtros.cliente ? projects.filter((p) => p.orgId === filtros.cliente) : projects),
    [projects, filtros.cliente],
  );
  const mine = filtros.responsable === YO;

  const onChanged = useCallback((updated: Task) => {
    setTasks((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
  }, []);
  const mover = useMoverTarea(onChanged);

  /**
   * Soltar en otra columna es un cambio de estado y nada más: la legalidad de
   * la transición la decide el motor, y si dice que no, `useMoverTarea`
   * revierte la tarjeta a su columna.
   */
  function onDragEnd(event: DragEndEvent): void {
    const task = event.active.data.current?.task as Task | undefined;
    const to = (event.over?.data.current as { status?: TaskStatus } | undefined)?.status;
    if (!task || !to || to === task.status) return;
    void mover(task, to);
  }

  // Teclado: `j`/`k` recorren, Enter abre, Esc suelta, `/` busca, `m` es mío.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Con la ficha abierta, el teclado es suyo: nada de mover el cursor de
      // la lista ni de reinterpretar "m" por debajo (M8).
      if (taskDetailId) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((c) => Math.min(recorrido.length - 1, c + 1));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (event.key === "Enter") {
        const task = recorrido[cursor];
        if (task) {
          event.preventDefault();
          void openTask(task.id);
        }
      } else if (event.key === "Escape") {
        setCursor(-1);
      } else if (event.key === "m") {
        event.preventDefault();
        aplicar({ ...filtros, responsable: mine ? null : YO });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /** Un chip es un filtro puesto: quitarlo lo devuelve a su valor neutro. */
  function quitarChip(key: keyof Filtros): void {
    if (key === "texto") aplicar({ ...filtros, texto: "" });
    else if (key === "cerradas") aplicar({ ...filtros, cerradas: false });
    else aplicar({ ...filtros, [key]: null });
  }

  function ordenarPor(columna: Columna): void {
    const direccion: "asc" | "desc" =
      orden.columna === columna && orden.direccion === "asc" ? "desc" : "asc";
    aplicar(filtros, { orden: { columna, direccion } });
  }

  async function crearRapido(): Promise<void> {
    const title = quickTitle.trim();
    const project = projects.find((p) => p.id === quickProject);
    if (!title || !project) return;
    const task = await createTask({ project_id: project.id, title, stage: project.stage });
    if (task) {
      setQuickTitle("");
      guardarProyectoReciente(project.id);
      setTasks((prev) => (prev ? [task, ...prev] : [task]));
    }
  }

  const total = tasks?.length ?? 0;
  const sinFiltros = chips.length === 0;

  return (
    <div className="density-operar mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-display text-ink">Tareas</h1>
          <p className="mt-1.5 max-w-[68ch] text-body text-muted">
            Todo el trabajo de Sixteam en una sola base: todos los clientes, todos los proyectos. El
            cliente y el proyecto son filtros, no puertas que haya que cruzar.
          </p>
        </div>
      </div>

      {/* ── Buscar, filtrar y agrupar: todo en una fila ───────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <label htmlFor="tareas-buscar" className="sr-only">
            Buscar entre todas las tareas
          </label>
          <Search
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            id="tareas-buscar"
            ref={searchRef}
            type="search"
            data-testid="tareas-buscar"
            value={filtros.texto}
            onChange={(event) => setFiltro("texto", event.target.value)}
            placeholder="Buscar en todas las tareas…"
            className="min-h-8 w-full rounded-full bg-surface pl-8 pr-8 py-1 text-small shadow-rest focus:outline-none focus:ring-2 focus:ring-link"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line bg-canvas-deep px-1 font-sans text-label text-faint">
            /
          </kbd>
        </div>

        <button
          type="button"
          data-testid="tareas-mias"
          aria-pressed={mine}
          title="Sólo lo asignado a ti (m)"
          onClick={() => setFiltro("responsable", mine ? null : YO)}
          className={`press inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1 text-small font-semibold ${
            mine ? "bg-link text-surface" : "bg-surface text-muted shadow-rest"
          }`}
        >
          Mis tareas
          <kbd className="rounded border border-line bg-canvas-deep px-1 font-sans text-label text-faint">m</kbd>
        </button>

        {/* La misma base, en dos formas. El modo viaja en la URL (`vista`). */}
        <div
          role="group"
          aria-label="Modo de vista"
          className="inline-flex items-center gap-0.5 rounded-full bg-surface p-0.5 shadow-rest"
        >
          {VISTAS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`tareas-vista-${value}`}
              aria-pressed={vista === value}
              onClick={() => aplicar(filtros, { vista: value })}
              className={`press inline-flex min-h-10 items-center rounded-full px-3 text-small font-semibold focus:outline-none focus:ring-2 focus:ring-link ${
                vista === value ? "bg-link text-surface" : "text-muted hover:text-ink-2"
              }`}
            >
              {VISTA_LABELS[value]}
            </button>
          ))}
        </div>

        <div className="relative">
          <label className="sr-only" htmlFor="tareas-agrupar">
            Agrupar por
          </label>
          <select
            id="tareas-agrupar"
            data-testid="tareas-agrupar"
            value={agrupacion}
            // En tablero la agrupación no manda: el tablero ya agrupa por
            // estado. Se deshabilita y se dice por qué, en vez de dejar un
            // selector que miente sobre lo que se está viendo.
            disabled={vista === "tablero"}
            aria-describedby={vista === "tablero" ? "tareas-agrupar-nota" : undefined}
            onChange={(event) => aplicar(filtros, { agrupacion: event.target.value as Agrupacion })}
            className={`min-h-8 appearance-none rounded-full bg-surface py-1 pl-3 pr-7 text-small text-ink-2 shadow-rest focus:outline-none focus:ring-2 focus:ring-link ${
              vista === "tablero" ? "opacity-45" : ""
            }`}
          >
            {AGRUPACIONES.map((value) => (
              <option key={value} value={value}>
                {value === "ninguna" ? "Sin agrupar" : `Agrupar: ${AGRUPACION_LABELS[value]}`}
              </option>
            ))}
          </select>
          <ChevronsUpDown
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
        </div>

        {vista === "tablero" ? (
          <span id="tareas-agrupar-nota" data-testid="tareas-agrupar-nota" className="text-label text-faint">
            El tablero ya agrupa por estado
          </span>
        ) : null}

        <button
          type="button"
          data-testid="tareas-filtros-toggle"
          aria-expanded={filtersOpen}
          aria-pressed={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
          className={`press inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 py-1 text-small font-semibold ${
            filtersOpen ? "bg-link-bg text-link" : "bg-surface text-muted shadow-rest"
          }`}
        >
          <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
          Filtros
          {filtrosPanelCount > 0 ? (
            <span
              data-testid="tareas-filtros-badge"
              className="rounded-full bg-link px-1.5 text-label text-surface"
            >
              {filtrosPanelCount}
            </span>
          ) : null}
        </button>
      </div>

      {/* ── Panel plegable: los seis selects + cerradas, ocultos por defecto ─ */}
      {filtersOpen ? (
        <Card className="mt-2 p-4" data-testid="tareas-filtros-panel">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-label text-muted" htmlFor="tareas-cliente">
                Cliente
              </label>
              <select
                id="tareas-cliente"
                data-testid="tareas-filtro-cliente"
                value={filtros.cliente ?? ""}
                onChange={(event) => setFiltro("cliente", event.target.value || null)}
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Todos los clientes</option>
                {clientes.map((cliente) => (
                  <option key={cliente.id} value={cliente.id}>
                    {cliente.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-label text-muted" htmlFor="tareas-proyecto">
                Proyecto
              </label>
              <select
                id="tareas-proyecto"
                data-testid="tareas-filtro-proyecto"
                value={filtros.proyecto ?? ""}
                onChange={(event) => setFiltro("proyecto", event.target.value || null)}
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Todos los proyectos</option>
                {proyectosDelCliente.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-label text-muted" htmlFor="tareas-responsable">
                Responsable
              </label>
              <select
                id="tareas-responsable"
                data-testid="tareas-filtro-responsable"
                value={filtros.responsable ?? ""}
                onChange={(event) => setFiltro("responsable", event.target.value || null)}
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Cualquier responsable</option>
                <option value={YO}>Yo</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name || person.fullName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-label text-muted" htmlFor="tareas-estado">
                Estado
              </label>
              <select
                id="tareas-estado"
                data-testid="tareas-filtro-estado"
                value={filtros.estado ?? ""}
                onChange={(event) => setFiltro("estado", (event.target.value || null) as TaskStatus | null)}
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Cualquier estado</option>
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-label text-muted" htmlFor="tareas-etiqueta">
                Etiqueta
              </label>
              <select
                id="tareas-etiqueta"
                data-testid="tareas-filtro-etiqueta"
                value={filtros.etiqueta ?? ""}
                onChange={(event) => setFiltro("etiqueta", event.target.value || null)}
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Cualquier etiqueta</option>
                {labelCatalog.map((usage) => (
                  <option key={usage.label} value={usage.label}>
                    {usage.label} ({usage.count})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-label text-muted" htmlFor="tareas-vencimiento">
                Vencimiento
              </label>
              <select
                id="tareas-vencimiento"
                data-testid="tareas-filtro-vencimiento"
                value={filtros.vencimiento ?? ""}
                onChange={(event) =>
                  setFiltro("vencimiento", (event.target.value || null) as Filtros["vencimiento"])
                }
                className={`${selectClass} mt-1 w-full`}
              >
                <option value="">Cualquier vencimiento</option>
                {VENCIMIENTOS.map((value) => (
                  <option key={value} value={value}>
                    {VENCIMIENTO_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <label className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 self-end text-label text-muted">
              <input
                type="checkbox"
                data-testid="tareas-incluir-cerradas"
                checked={filtros.cerradas}
                onChange={(event) => setFiltro("cerradas", event.target.checked)}
                className="h-4 w-4 rounded border-line accent-[var(--color-link)]"
              />
              Incluir cerradas
            </label>
          </div>
        </Card>
      ) : null}

      {/* ── Lo filtrado se ve y se puede quitar ───────────────────────────── */}
      {chips.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="tareas-chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              data-testid={`tareas-chip-${chip.key}`}
              onClick={() => quitarChip(chip.key)}
              className="press inline-flex items-center gap-1.5 rounded-full border border-link bg-link-bg px-2 py-0.5 text-label font-semibold text-link"
            >
              {chip.label}: {chip.value}
              <span aria-hidden="true">×</span>
              <span className="sr-only">Quitar este filtro</span>
            </button>
          ))}
          <button
            type="button"
            data-testid="tareas-limpiar"
            onClick={() => aplicar(FILTROS_VACIOS)}
            className="press text-label font-semibold text-muted hover:text-ink-2"
          >
            Limpiar todo
          </button>
        </div>
      ) : null}

      {/* ── Creación rápida: una línea, sin salir de aquí ─────────────────── */}
      <form
        data-testid="tareas-alta-rapida"
        onSubmit={(event) => {
          event.preventDefault();
          void crearRapido();
        }}
        className="mt-3 flex flex-wrap items-center gap-2 rounded-full bg-surface px-3.5 py-2 shadow-rest"
      >
        <span aria-hidden="true" className="text-title leading-none text-faint">
          +
        </span>
        <label htmlFor="tareas-alta-titulo" className="sr-only">
          Título de la tarea nueva
        </label>
        <input
          id="tareas-alta-titulo"
          data-testid="tareas-alta-titulo"
          value={quickTitle}
          onChange={(event) => setQuickTitle(event.target.value)}
          placeholder="Añade una tarea y pulsa Enter…"
          className="min-h-8 min-w-48 flex-1 rounded-tight border border-transparent bg-transparent px-1.5 py-1 text-small text-ink focus:border-line focus:outline-none"
        />
        <label htmlFor="tareas-alta-proyecto" className="sr-only">
          Proyecto de la tarea nueva
        </label>
        <select
          id="tareas-alta-proyecto"
          data-testid="tareas-alta-proyecto"
          value={quickProject}
          onChange={(event) => setQuickProject(event.target.value)}
          className={selectClass}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <ActionButton
          type="submit"
          variant="primary"
          disabled={!quickTitle.trim() || !quickProject}
          data-testid="tareas-alta-enviar"
        >
          Añadir
        </ActionButton>
        <button
          type="button"
          data-testid="tareas-alta-mas"
          disabled={!quickProject}
          onClick={() => setDialogOpen(true)}
          className="press text-small font-semibold text-link hover:underline disabled:opacity-45"
        >
          Más campos…
        </button>
      </form>

      {/* ── Cuerpo ───────────────────────────────────────────────────────── */}
      <div className="mt-4">
        {loading && !tasks ? <Spinner label="Leyendo la base de tareas…" /> : null}
        {error ? <ErrorBox message={error} onRetry={() => void cargar()} /> : null}

        {!error && tasks && visibles.length === 0 ? (
          <EmptyState
            title={sinFiltros ? "Todavía no hay tareas" : "Nada coincide con estos filtros"}
            hint={
              sinFiltros
                ? "Escribe arriba el primer título, elige el proyecto y pulsa Enter: la tarea nace en el tablero de ese cliente."
                : "Prueba a quitar un filtro. También puedes limpiarlos todos y volver a la base completa."
            }
            {...(sinFiltros
              ? {}
              : {
                  action: (
                    <ActionButton onClick={() => aplicar(FILTROS_VACIOS)}>Limpiar los filtros</ActionButton>
                  ),
                })}
          />
        ) : null}

        {!error && visibles.length > 0 && vista === "tablero" ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <div className="overflow-x-auto pb-2" data-testid="tareas-tablero">
              <div className="flex items-start gap-2">
                {TASK_STATUSES.map((status) => (
                  <ColumnaEstado
                    key={status}
                    status={status}
                    tasks={porEstado.get(status) ?? []}
                    ctx={ctx}
                  />
                ))}
              </div>
            </div>
          </DndContext>
        ) : null}

        {!error && visibles.length > 0 && vista === "tabla" ? (
          <div className="space-y-5">
            {grupos.map((grupo) => {
              let indexBase = 0;
              for (const previo of grupos) {
                if (previo.key === grupo.key) break;
                indexBase += previo.tasks.length;
              }
              return (
                <section key={grupo.key} data-testid={`tareas-grupo-${grupo.key}`}>
                  <Card className="overflow-hidden">
                    {agrupacion !== "ninguna" ? (
                      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
                        <h2 className="text-title text-ink">
                          {agrupacion === "estado" ? (
                            <StatusPill status={grupo.key as TaskStatus} />
                          ) : (
                            grupo.label
                          )}
                        </h2>
                        <span className="rounded-full bg-canvas-deep px-1.5 py-px text-label tabular-nums text-muted">
                          {grupo.tasks.length}
                        </span>
                      </div>
                    ) : null}
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[58rem] border-collapse text-left">
                        <thead>
                          <tr>
                            {COLUMNAS.map((columna) => (
                              <th
                                key={columna}
                                scope="col"
                                aria-sort={
                                  orden.columna === columna
                                    ? orden.direccion === "asc"
                                      ? "ascending"
                                      : "descending"
                                    : "none"
                                }
                                className={`border-b border-line-soft px-2.5 py-1.5 text-label text-muted ${
                                  columna === "titulo" ? "w-full" : "whitespace-nowrap"
                                }`}
                              >
                                <button
                                  type="button"
                                  data-testid={`tareas-orden-${columna}`}
                                  onClick={() => ordenarPor(columna)}
                                  className="press inline-flex items-center gap-1 text-muted hover:text-ink-2"
                                >
                                  {COLUMNA_LABELS[columna]}
                                  {orden.columna === columna ? (
                                    <span aria-hidden="true">{orden.direccion === "asc" ? "↑" : "↓"}</span>
                                  ) : null}
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grupo.tasks.map((task, index) => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              ctx={ctx}
                              selected={cursor === indexBase + index}
                              onChanged={onChanged}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </section>
              );
            })}
          </div>
        ) : null}

        {!error && visibles.length > renderLimit ? (
          <div className="mt-3 flex items-center gap-2 text-small text-muted" data-testid="tareas-mostrar-mas">
            <span>
              Mostrando {visiblesRender.length} de {visibles.length}
            </span>
            <button
              type="button"
              onClick={() => setRenderLimit((n) => Math.min(n + RENDER_STEP, visibles.length))}
              className="press font-semibold text-link hover:underline"
            >
              Mostrar más
            </button>
          </div>
        ) : null}
      </div>

      <p className="mt-5 flex flex-wrap items-center gap-2 text-small text-muted">
        <span data-testid="tareas-resumen">
          {visibles.length} de {total} tareas
          {projects.length > 0
            ? ` · ${new Set(visibles.map((t) => t.projectId)).size} proyectos · ${
                new Set(visibles.map((t) => orgIdOf(t, projects)).filter(Boolean)).size
              } clientes`
            : ""}
        </span>
        <span className="text-faint">
          j / k para moverte, Enter abre la ficha, m alterna tus tareas, / busca.
        </span>
        <Link to={paths.proyectos()} className="press font-semibold text-link hover:underline">
          Ver los proyectos
        </Link>
      </p>

      {quickProject ? (
        <CreateTaskDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) void cargar();
          }}
          projectId={quickProject}
          initialTitle={quickTitle}
          defaultStage={projects.find((p) => p.id === quickProject)?.stage ?? "ENTENDER"}
        />
      ) : null}
    </div>
  );
}
