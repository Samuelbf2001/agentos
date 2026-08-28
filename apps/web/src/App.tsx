/**
 * Shell (spec B5 §2): sidebar con navegación + badges, header con selector de
 * proyecto, indicador de kill switch (banner rojo) y botón Pausar/Reanudar
 * agentes (US-11). Rutas de las 8 vistas.
 */
import { useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useStore } from "./state/store";
import { Spinner, Toasts } from "./components/ui";
import LoginView from "./views/LoginView";
import ChatView from "./views/ChatView";
import BoardView from "./views/BoardView";
import SwarmView from "./views/SwarmView";
import RunsView from "./views/RunsView";
import RunDetailView from "./views/RunDetailView";
import WaitingView from "./views/WaitingView";
import ContextView from "./views/ContextView";
import AdminView from "./views/AdminView";
import { TaskDrawer } from "./views/TaskDrawer";

const NAV = [
  { to: "/chat", label: "Chat", icon: "💬" },
  { to: "/board", label: "Tablero", icon: "🗂️" },
  { to: "/swarm", label: "Enjambre", icon: "🕸️" },
  { to: "/runs", label: "Runs", icon: "🛰️" },
  { to: "/waiting", label: "Esperando por ti", icon: "✋" },
  { to: "/context", label: "Contexto", icon: "📚" },
  { to: "/admin", label: "Admin", icon: "⚙️" },
];

function Badge({ count, tone }: { count: number; tone: "rose" | "amber" }) {
  if (count <= 0) return null;
  const cls = tone === "rose" ? "bg-rose-600" : "bg-amber-500";
  return (
    <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${cls}`}>
      {count}
    </span>
  );
}

function Shell() {
  const person = useStore((s) => s.person);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const killSwitch = useStore((s) => s.killSwitch);
  const setKillSwitch = useStore((s) => s.setKillSwitch);
  const approvalsCount = useStore((s) => s.approvals.length);
  const failedRuns = useStore((s) => s.failedRunsCount);
  const wsStatus = useStore((s) => s.wsStatus);
  const refreshBadges = useStore((s) => s.refreshBadges);
  const logout = useStore((s) => s.logout);
  const location = useLocation();

  useEffect(() => {
    const t = setInterval(() => void refreshBadges(), 15_000);
    return () => clearInterval(t);
  }, [refreshBadges]);

  return (
    <div className="flex h-full flex-col">
      {killSwitch ? (
        <div className="flex items-center justify-center gap-3 bg-rose-600 px-4 py-1.5 text-sm font-medium text-white">
          ⛔ Kill switch activo: los agentes están pausados y no arrancan runs nuevos.
          <button
            onClick={() => void setKillSwitch(false)}
            className="rounded bg-white/20 px-2 py-0.5 text-xs font-semibold hover:bg-white/30"
          >
            Reanudar agentes
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-bold tracking-tight">AgentOS</p>
            <p className="text-[11px] text-slate-400">Sixteam · Entender → Construir → Operar</p>
          </div>
          <nav className="flex-1 space-y-0.5 p-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                    isActive
                      ? "bg-slate-900 font-medium text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                <span aria-hidden>{item.icon}</span>
                {item.label}
                {item.to === "/waiting" ? <Badge count={approvalsCount} tone="rose" /> : null}
                {item.to === "/runs" ? <Badge count={failedRuns} tone="amber" /> : null}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
            <p className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  wsStatus === "open" ? "bg-emerald-500" : wsStatus === "connecting" ? "bg-amber-400" : "bg-rose-500"
                }`}
              />
              WS {wsStatus === "open" ? "en vivo" : wsStatus === "connecting" ? "conectando…" : "desconectado"}
            </p>
            <p className="mt-1 truncate font-medium text-slate-700">{person?.full_name}</p>
            <button onClick={logout} className="mt-1 text-slate-400 underline hover:text-slate-600">
              Cerrar sesión
            </button>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
            <label className="text-xs text-slate-500" htmlFor="project-select">
              Proyecto
            </label>
            <select
              id="project-select"
              value={activeProjectId ?? ""}
              onChange={(e) => void setActiveProject(e.target.value || null)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              {projects.length === 0 ? <option value="">(sin proyectos)</option> : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.stage}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-400">{location.pathname}</span>
            <div className="ml-auto flex items-center gap-2">
              {!killSwitch ? (
                <button
                  onClick={() => void setKillSwitch(true)}
                  className="rounded-md border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                >
                  ⏸ Pausar agentes
                </button>
              ) : (
                <button
                  onClick={() => void setKillSwitch(false)}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  ▶ Reanudar agentes
                </button>
              )}
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/board" element={<BoardView />} />
              <Route path="/swarm" element={<SwarmView />} />
              <Route path="/runs" element={<RunsView />} />
              <Route path="/runs/:runId" element={<RunDetailView />} />
              <Route path="/waiting" element={<WaitingView />} />
              <Route path="/context" element={<ContextView />} />
              <Route path="/admin" element={<AdminView />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </main>
        </div>
      </div>
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
