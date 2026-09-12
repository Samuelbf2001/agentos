/**
 * Shell con menú lateral (estilo GoHighLevel/HubSpot) y cambio de perspectiva
 * Sixteam (agencia) ↔ cliente.
 *
 * El proyecto es el objeto raíz cuando se trabaja dentro de un cliente, pero la
 * puerta de entrada del trabajo diario de Sixteam es Hoy más Tareas.
 * `perspectiveFor(location.pathname)` decide qué menú (`agencyNav` o
 * `clientNav`) se pinta en el `Sidebar`; en móvil se abre como cajón. La
 * `Topbar` sólo lleva la miga de pan y las acciones globales.
 *
 * En escritorio el menú lateral se puede ocultar (botón de la cabecera o
 * Ctrl+B) y se recuerda en `localStorage`; el cajón móvil no cambia. Una
 * vista puede además pedir el modo inmersivo (`useShell`): sin menú ni
 * cabecera, todo el ancho y alto para el contenido (el lienzo de Notas).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { useStore } from "./state/store";
import { useShell } from "./state/shell";
import { esAtajoMenuLateral, guardarSidebarColapsado, leerSidebarColapsado } from "./lib/shell";
import { Spinner, Toasts } from "./components/ui";
import { Sidebar } from "./components/shell/Sidebar";
import { Topbar } from "./components/shell/Topbar";
import { paths } from "./lib/paths";
import { useCapabilities } from "./lib/capabilities";
import { agencyNav, clientNav, perspectiveFor } from "./lib/nav";
import LoginView from "./views/LoginView";
import HoyView from "./views/HoyView";
import TareasView from "./views/TareasView";
import ProjectsView from "./views/ProjectsView";
import ProjectLayout from "./views/ProjectLayout";
import SystemLayout from "./views/SystemLayout";
import BrainView from "./views/BrainView";
import BrainMeetingsView from "./views/BrainMeetingsView";
import ConversacionesView from "./views/brain/ConversacionesView";
import NotasVozView from "./views/brain/NotasVozView";
import GrabadoraView from "./views/brain/GrabadoraView";
import VideosView from "./views/brain/VideosView";
import GrafoView from "./views/brain/GrafoView";
import AgenteView from "./views/brain/AgenteView";
import NotasView from "./views/NotasView";
import AssetView from "./views/AssetView";
import RunDetailView from "./views/RunDetailView";
import NewProjectWizard from "./views/NewProjectWizard";
import SearchOverlay from "./views/SearchOverlay";
import { TaskDrawer } from "./views/TaskDrawer";

/**
 * Redirección legacy que conserva la query string: un `?tarea=<id>` (deep
 * link a una ficha) no puede perderse solo porque la ruta vieja cambió de
 * sitio.
 */
function RedirectKeepSearch({ to }: { to: string }) {
  const location = useLocation();
  // `to` puede traer su propia query (p. ej. paths.misTareas() = "/tareas?responsable=yo"):
  // se combina con la de la URL de origen en vez de descartar una de las dos.
  const [pathname, toSearch = ""] = to.split("?");
  const params = new URLSearchParams(location.search);
  for (const [key, value] of new URLSearchParams(toSearch)) params.set(key, value);
  const search = params.toString();
  return <Navigate to={{ pathname, search: search ? `?${search}` : "" }} replace />;
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
  const killSwitch = useStore((s) => s.killSwitch);
  const setKillSwitch = useStore((s) => s.setKillSwitch);
  const decisionsCount = useStore((s) => s.approvals.length + s.reviewTasks.length);
  const failedRuns = useStore((s) => s.failedRunsCount);
  const refreshBadges = useStore((s) => s.refreshBadges);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const previewRole = useStore((s) => s.previewRole);
  const setPreviewRole = useStore((s) => s.setPreviewRole);
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const inmersivo = useShell((s) => s.inmersivo);
  // Menú lateral ocultable (escritorio): se lee al montar y cada cambio se
  // escribe. Es estado del shell, no del store: ninguna vista depende de él.
  const [sidebarColapsado, setSidebarColapsado] = useState(() => leerSidebarColapsado());
  const toggleSidebar = useCallback(() => setSidebarColapsado((prev) => !prev), []);
  useEffect(() => {
    guardarSidebarColapsado(sidebarColapsado);
  }, [sidebarColapsado]);
  const caps = useCapabilities();
  useTaskDeepLink();

  useEffect(() => {
    const t = setInterval(() => void refreshBadges(), 15_000);
    return () => clearInterval(t);
  }, [refreshBadges]);

  // Ctrl+B alterna el menú lateral desde cualquier pantalla (también con el
  // foco en un campo: es el mismo gesto que en VS Code). `/` abre la búsqueda
  // de tareas, salvo mientras se escribe en un campo.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (esAtajoMenuLateral(event)) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
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
    [caps, toggleSidebar],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const badges = useMemo(
    () => ({ decisions: decisionsCount, failed: failedRuns }),
    [decisionsCount, failedRuns],
  );

  const perspective = useMemo(
    () => perspectiveFor(location.pathname, location.search),
    [location.pathname, location.search],
  );

  // La previsualización "ver como cliente" es local a un proyecto: si el
  // usuario navega fuera de /proyectos/:id/* o /hoy?proyecto=<id>, se apaga
  // sola en vez de arrastrarse a otra pantalla de agencia.
  useEffect(() => {
    if (previewRole === "sponsor" && perspective.kind !== "client") setPreviewRole(null);
  }, [perspective, previewRole, setPreviewRole]);

  const groups = useMemo(() => {
    const raw = perspective.kind === "client" ? clientNav(perspective.projectId) : agencyNav();
    return raw
      .map((group) => ({ ...group, items: group.items.filter((item) => !item.cap || caps.has(item.cap)) }))
      .filter((group) => group.items.length > 0);
  }, [perspective, caps]);

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      {/* Escritorio: colapsado o en modo inmersivo el menú no se pinta y el
          contenido ocupa todo el ancho. El cajón móvil de abajo no cambia. */}
      {!sidebarColapsado && !inmersivo ? (
        <div id="menu-lateral" className="hidden md:block">
          <Sidebar perspective={perspective} groups={groups} badges={badges} />
        </div>
      ) : null}

      {drawerOpen ? (
        <>
          <div
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-ink/35 md:hidden"
          />
          <div className="fixed left-0 top-0 z-50 h-full w-[248px] shadow-float md:hidden">
            <Sidebar
              perspective={perspective}
              groups={groups}
              badges={badges}
              onNavigate={() => setDrawerOpen(false)}
            />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Cerrar menú"
              className="press absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-tight text-ink-2 hover:bg-canvas-deep"
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {!inmersivo ? (
          <Topbar
            perspective={perspective}
            caps={caps}
            killSwitch={killSwitch}
            onToggleKillSwitch={(next) => void setKillSwitch(next)}
            onSearch={() => setSearchOpen(true)}
            onOpenMenu={() => setDrawerOpen(true)}
            sidebarColapsado={sidebarColapsado}
            onToggleSidebar={toggleSidebar}
          />
        ) : null}

        {killSwitch && !inmersivo ? (
          <div className="flex flex-wrap items-center justify-center gap-3 bg-broken-bg px-4 py-1.5 text-small text-broken">
            <span className="font-semibold">
              Los agentes están pausados: no arrancan runs nuevos. Reanúdalos desde el botón de la cabecera.
            </span>
          </div>
        ) : null}

        {/* El side peek empuja el contenido en escritorio ancho (§3.1). */}
        <main className="min-h-0 flex-1 overflow-auto" style={{ paddingRight: "var(--task-peek-inset, 0px)" }}>
          <Routes>
            <Route path="/" element={<RedirectKeepSearch to={paths.hoy()} />} />
            <Route path="/hoy" element={<HoyView />} />
            <Route path="/tareas" element={<TareasView />} />
            <Route path="/mis-tareas" element={<RedirectKeepSearch to={paths.misTareas()} />} />
            <Route path="/proyectos" element={<ProjectsView />} />
            <Route path="/proyectos/:projectId" element={<ProjectLayout />} />
            <Route path="/proyectos/:projectId/:tab" element={<ProjectLayout />} />
            <Route path="/proyectos/:projectId/:tab/:sub" element={<ProjectLayout />} />
            <Route path="/nuevo-proyecto" element={<NewProjectWizard />} />
            <Route path="/sistema" element={<RedirectKeepSearch to={paths.sistema("ahora")} />} />
            <Route path="/sistema/actividad/:runId" element={<RunDetailView />} />
            <Route path="/sistema/salud" element={<RedirectKeepSearch to={paths.sistema("fuentes")} />} />
            <Route path="/sistema/ajustes" element={<RedirectKeepSearch to={paths.sistema("configuracion")} />} />
            <Route path="/sistema/:tab" element={<SystemLayout />} />
            <Route path="/activo" element={<AssetView />} />
            <Route path="/2brain" element={<BrainView />} />
            <Route path="/2brain/reuniones" element={<BrainMeetingsView />} />
            <Route path="/2brain/conversaciones" element={<ConversacionesView />} />
            <Route path="/2brain/notas-voz" element={<NotasVozView />} />
            <Route path="/2brain/grabadora" element={<GrabadoraView />} />
            <Route path="/2brain/videos" element={<VideosView />} />
            <Route path="/2brain/grafo" element={<GrafoView />} />
            <Route path="/2brain/agente" element={<AgenteView />} />
            <Route path="/notas" element={<NotasView />} />

            {/* Rutas anteriores: se conservan como redirección, no como destino. */}
            <Route path="/waiting" element={<RedirectKeepSearch to="/hoy" />} />
            <Route path="/my-tasks" element={<RedirectKeepSearch to={paths.misTareas()} />} />
            <Route path="/brain" element={<RedirectKeepSearch to={paths.sistema("fuentes")} />} />
            <Route path="/swarm" element={<RedirectKeepSearch to={paths.sistema("ahora")} />} />
            <Route path="/admin" element={<RedirectKeepSearch to={paths.sistema("configuracion")} />} />
            <Route path="/runs" element={<RedirectKeepSearch to={paths.sistema("actividad")} />} />
            <Route path="/runs/:runId" element={<LegacyRun />} />
            <Route path="/board" element={<RedirectKeepSearch to={paths.proyectos()} />} />
            <Route path="/chat" element={<RedirectKeepSearch to={paths.proyectos()} />} />
            <Route path="/context" element={<RedirectKeepSearch to={paths.proyectos()} />} />
            <Route path="/meetings" element={<RedirectKeepSearch to={paths.brainReuniones()} />} />
            <Route path="*" element={<RedirectKeepSearch to="/hoy" />} />
          </Routes>
        </main>
      </div>

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
