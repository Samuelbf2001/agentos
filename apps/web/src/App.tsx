/**
 * Shell (PLAN-v1.5 §Navegación nueva).
 *
 * El proyecto es el objeto raíz cuando se trabaja dentro de un cliente, pero la
 * puerta de entrada del trabajo diario de Sixteam es Hoy más Tareas. Cinco
 * entradas globales —Hoy, Tareas, Proyectos, Sistema y Activo Sixteam— y un
 * segundo nivel de pestañas dentro del proyecto.
 * Desaparecen el selector de proyecto del header, los emoji como icono de
 * navegación y la impresión de `location.pathname`.
 *
 * La barra superior flota: es translúcida con desenfoque y el contenido pasa
 * por debajo, encontrándose con ella en un degradado y no en una línea de un
 * píxel. `prefers-reduced-transparency` la vuelve sólida y
 * `prefers-reduced-motion` cambia el desplazamiento por un fundido.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useStore } from "./state/store";
import { Spinner, Toasts } from "./components/ui";
import { paths } from "./lib/paths";
import { useCapabilities, type GlobalEntry } from "./lib/capabilities";
import LoginView from "./views/LoginView";
import HoyView from "./views/HoyView";
import TareasView from "./views/TareasView";
import ProjectsView from "./views/ProjectsView";
import ProjectLayout from "./views/ProjectLayout";
import SystemLayout from "./views/SystemLayout";
import AssetView from "./views/AssetView";
import RunDetailView from "./views/RunDetailView";
import NewProjectWizard from "./views/NewProjectWizard";
import SearchOverlay from "./views/SearchOverlay";
import { TaskDrawer } from "./views/TaskDrawer";

interface NavEntry {
  entry: GlobalEntry;
  to: string;
  label: string;
  isActive: (pathname: string) => boolean;
  badge?: "decisions" | "failed";
}

const GLOBAL_NAV: NavEntry[] = [
  {
    entry: "hoy",
    to: paths.hoy(),
    label: "Hoy",
    isActive: (p) => p === "/" || p.startsWith("/hoy"),
    badge: "decisions",
  },
  { entry: "tareas", to: paths.tareas(), label: "Tareas", isActive: (p) => p.startsWith("/tareas") },
  {
    entry: "proyectos",
    to: paths.proyectos(),
    label: "Proyectos",
    isActive: (p) => p.startsWith("/proyectos") || p.startsWith("/nuevo-proyecto"),
  },
  {
    entry: "sistema",
    to: paths.sistema(),
    label: "Sistema",
    isActive: (p) => p.startsWith("/sistema"),
    badge: "failed",
  },
  { entry: "activo", to: paths.activo(), label: "Activo Sixteam", isActive: (p) => p.startsWith("/activo") },
];

function NavBadge({ count, tone }: { count: number; tone: "decide" | "broken" }) {
  if (count <= 0) return null;
  return (
    <span
      className={`ml-1 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-label font-bold tabular-nums ${
        tone === "decide" ? "bg-decide text-surface" : "bg-broken text-surface"
      }`}
    >
      {count}
    </span>
  );
}

/**
 * La ficha de tarea vive en la URL como query global `?tarea=<id>` (§4.1):
 * funciona desde las ocho vistas sin reescribir rutas. URL → store al montar
 * o al navegar (Atrás cierra, recargar reabre); store → URL al abrir o cerrar
 * desde la interfaz, con `replace:false` para que Atrás deshaga cada paso.
 */
export function useTaskDeepLink(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskDetailId = useStore((s) => s.taskDetailId);
  const openTask = useStore((s) => s.openTask);
  const closeTask = useStore((s) => s.closeTask);
  const urlTask = searchParams.get("tarea");
  const lastUrlTask = useRef<string | null>(null);
  const lastStoreTask = useRef<string | null>(null);

  // Un solo efecto que decide quién manda según qué lado cambió: dos efectos
  // separados se pisaban con closures viejas y entraban en bucle.
  useEffect(() => {
    const urlChanged = urlTask !== lastUrlTask.current;
    const storeChanged = taskDetailId !== lastStoreTask.current;
    lastUrlTask.current = urlTask;
    lastStoreTask.current = taskDetailId;
    if (urlTask === taskDetailId) return;
    if (urlChanged || !storeChanged) {
      // Navegación (montaje, Atrás, enlace): la URL manda.
      if (urlTask) void openTask(urlTask);
      else closeTask();
      return;
    }
    // Abierta o cerrada desde la interfaz: la URL sigue al store.
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (taskDetailId) next.set("tarea", taskDetailId);
        else next.delete("tarea");
        return next;
      },
      { replace: false },
    );
    // Sólo reacciona a los dos valores que compara: las funciones cambian de
    // identidad con cada navegación y volverían a evaluar con datos a medias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTask, taskDetailId]);
}

/** Redirección de las rutas viejas: ningún enlace guardado se rompe. */
function LegacyRun() {
  const { runId } = useParams<{ runId: string }>();
  return <Navigate to={runId ? paths.run(runId) : paths.sistema("actividad")} replace />;
}

function Shell() {
  const person = useStore((s) => s.person);
  const killSwitch = useStore((s) => s.killSwitch);
  const setKillSwitch = useStore((s) => s.setKillSwitch);
  const decisionsCount = useStore((s) => s.approvals.length + s.reviewTasks.length);
  const failedRuns = useStore((s) => s.failedRunsCount);
  const wsStatus = useStore((s) => s.wsStatus);
  const refreshBadges = useStore((s) => s.refreshBadges);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const logout = useStore((s) => s.logout);
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const caps = useCapabilities();
  useTaskDeepLink();

  useEffect(() => {
    const t = setInterval(() => void refreshBadges(), 15_000);
    return () => clearInterval(t);
  }, [refreshBadges]);

  // `/` abre la búsqueda de tareas desde cualquier pantalla, salvo mientras se
  // escribe en un campo.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!caps.has("buscar")) return;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      // En Tareas la búsqueda ya está integrada en la vista: abrir el overlay
      // encima sería una segunda caja para lo mismo.
      if (pathnameRef.current.startsWith("/tareas")) return;
      event.preventDefault();
      setSearchOpen(true);
    },
    [caps],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const badges = useMemo(
    () => ({ decisions: decisionsCount, failed: failedRuns }),
    [decisionsCount, failedRuns],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {killSwitch ? (
        <div className="flex flex-wrap items-center justify-center gap-3 bg-broken-bg px-4 py-1.5 text-small text-broken">
          <span className="font-semibold">
            Los agentes están pausados: no arrancan runs nuevos. Reanúdalos desde el botón de la cabecera.
          </span>
        </div>
      ) : null}

      <header className="chrome sticky top-0 z-40 shrink-0">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-3 px-4 py-2.5 sm:gap-4 sm:px-5">
          <span className="flex items-center gap-2.5 font-semibold tracking-tight">
            <span
              aria-hidden="true"
              className="block h-[22px] w-[22px] rounded-[7px] bg-gradient-to-br from-ink to-muted"
            />
            AgentOS
          </span>
          <nav aria-label="Navegación principal" className="flex gap-0.5 rounded-[11px] bg-canvas-deep p-[3px]">
            {GLOBAL_NAV.filter((item) => caps.has(`nav:${item.entry}`)).map((item) => {
              const active = item.isActive(location.pathname);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={`press inline-flex min-h-8 items-center rounded-tight px-3 py-1.5 text-small font-semibold ${
                    active ? "bg-surface text-ink shadow-rest" : "text-muted hover:text-ink-2"
                  }`}
                >
                  {item.label}
                  {item.badge ? (
                    <NavBadge
                      count={badges[item.badge]}
                      tone={item.badge === "decisions" ? "decide" : "broken"}
                    />
                  ) : null}
                </NavLink>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {caps.has("buscar") ? (
              <button
                onClick={() => setSearchOpen(true)}
                className="press hidden min-h-8 items-center gap-2 rounded-tight border border-line bg-surface px-2.5 py-1 text-small text-muted sm:inline-flex"
              >
                Buscar tareas
                <kbd className="rounded border border-line bg-canvas-deep px-1 font-sans text-label text-faint">/</kbd>
              </button>
            ) : null}
            {caps.has("agentes:pausar") ? (
              killSwitch ? (
                <button
                  onClick={() => void setKillSwitch(false)}
                  className="press min-h-8 rounded-tight border border-done-line bg-done-bg px-2.5 py-1 text-small font-semibold text-done"
                >
                  Reanudar agentes
                </button>
              ) : (
                <button
                  onClick={() => void setKillSwitch(true)}
                  className="press min-h-8 rounded-tight border border-line bg-surface px-2.5 py-1 text-small font-semibold text-muted"
                >
                  Pausar agentes
                </button>
              )
            ) : null}
            <span className="hidden items-center gap-2 border-l border-line pl-3 text-small text-muted lg:flex">
              <span
                title={
                  wsStatus === "open"
                    ? "Conexión en vivo"
                    : wsStatus === "connecting"
                      ? "Conectando"
                      : "Sin conexión en vivo"
                }
                className={`inline-block h-2 w-2 rounded-full ${
                  wsStatus === "open" ? "bg-done" : wsStatus === "connecting" ? "bg-work" : "bg-broken"
                }`}
              />
              <span className="max-w-32 truncate font-medium text-ink-2">{person?.full_name}</span>
              <button onClick={logout} className="press text-small text-faint hover:text-muted">
                Salir
              </button>
            </span>
          </div>
        </div>
      </header>
      <div className="scroll-edge sticky top-[52px] z-30 shrink-0" aria-hidden="true" />

      {/* El side peek empuja el contenido en escritorio ancho (§3.1). */}
      <main className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: "var(--task-peek-inset, 0px)" }}>
        <Routes>
          <Route path="/" element={<Navigate to={paths.hoy()} replace />} />
          <Route path="/hoy" element={<HoyView />} />
          <Route path="/tareas" element={<TareasView />} />
          <Route path="/mis-tareas" element={<Navigate to={paths.misTareas()} replace />} />
          <Route path="/proyectos" element={<ProjectsView />} />
          <Route path="/proyectos/:projectId" element={<ProjectLayout />} />
          <Route path="/proyectos/:projectId/:tab" element={<ProjectLayout />} />
          <Route path="/proyectos/:projectId/:tab/:sub" element={<ProjectLayout />} />
          <Route path="/nuevo-proyecto" element={<NewProjectWizard />} />
          <Route path="/sistema" element={<Navigate to={paths.sistema("ahora")} replace />} />
          <Route path="/sistema/actividad/:runId" element={<RunDetailView />} />
          <Route path="/sistema/salud" element={<Navigate to={paths.sistema("fuentes")} replace />} />
          <Route path="/sistema/ajustes" element={<Navigate to={paths.sistema("configuracion")} replace />} />
          <Route path="/sistema/:tab" element={<SystemLayout />} />
          <Route path="/activo" element={<AssetView />} />

          {/* Rutas anteriores: se conservan como redirección, no como destino. */}
          <Route path="/waiting" element={<Navigate to="/hoy" replace />} />
          <Route path="/my-tasks" element={<Navigate to={paths.misTareas()} replace />} />
          <Route path="/brain" element={<Navigate to={paths.sistema("fuentes")} replace />} />
          <Route path="/swarm" element={<Navigate to={paths.sistema("ahora")} replace />} />
          <Route path="/admin" element={<Navigate to={paths.sistema("configuracion")} replace />} />
          <Route path="/runs" element={<Navigate to={paths.sistema("actividad")} replace />} />
          <Route path="/runs/:runId" element={<LegacyRun />} />
          <Route path="/board" element={<Navigate to={paths.proyectos()} replace />} />
          <Route path="/chat" element={<Navigate to={paths.proyectos()} replace />} />
          <Route path="/context" element={<Navigate to={paths.proyectos()} replace />} />
          <Route path="/meetings" element={<Navigate to={paths.sistema("fuentes")} replace />} />
          <Route path="*" element={<Navigate to="/hoy" replace />} />
        </Routes>
      </main>

      <SearchOverlay
        open={searchOpen}
        onOpenChange={setSearchOpen}
        {...(activeProjectId ? { projectId: activeProjectId } : {})}
      />
      <TaskDrawer />
    </div>
  );
}

export default function App() {
  const bootstrapped = useStore((s) => s.bootstrapped);
  const token = useStore((s) => s.token);
  const init = useStore((s) => s.init);

  useEffect(() => {
    void init();
    // init es idempotente para el ciclo de vida del SPA
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bootstrapped) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Arrancando AgentOS…" />
      </div>
    );
  }
  if (!token) {
    return (
      <>
        <LoginView />
        <Toasts />
      </>
    );
  }
  return (
    <>
      <Shell />
      <Toasts />
    </>
  );
}
