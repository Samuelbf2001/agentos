/**
 * Papelera de Tareas: la vista «Desactivadas» de `/tareas?vista=desactivadas`.
 *
 * Eliminar una tarea no la borra: pasa aquí, se puede restaurar durante 90
 * días y después la API la borra para siempre. Por eso la columna que importa
 * es la cuenta atrás («Se borra en N días»), resaltada cuando quedan 7 o menos.
 *
 * Lee de `GET /api/tasks/deleted` (con el cliente y el proyecto filtrados en la
 * barra de la vista) y la búsqueda se cruza en el navegador, igual que la base
 * activa: son pocas filas y así escribir no cuesta una petición por tecla.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { Card } from "../components/system";
import { EmptyState, ErrorBox, fmtDate, Spinner } from "../components/ui";
import { diasParaBorrado, isTaskDeleted, taskPurgeAt, type Task } from "../lib/types";
import {
  clienteLabel,
  normalizar,
  orgIdOf,
  projectOf,
  quienDesactivo,
  textoBorrado,
  type Contexto,
  type Filtros,
} from "../lib/tareas";

/** Con 7 días o menos la cuenta atrás se pinta en rojo: queda poco margen. */
export const DIAS_AVISO_BORRADO = 7;

export function TareasDesactivadas({ filtros, ctx }: { filtros: Filtros; ctx: Contexto }) {
  const openTask = useStore((s) => s.openTask);
  const restoreTask = useStore((s) => s.restoreTask);
  const taskChange = useStore((s) => s.taskChange);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listDeletedTasks({
        ...(filtros.proyecto ? { project_id: filtros.proyecto } : {}),
        ...(filtros.cliente ? { org_id: filtros.cliente } : {}),
      });
      setTasks(result.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las tareas desactivadas");
    } finally {
      setLoading(false);
    }
  }, [filtros.proyecto, filtros.cliente]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Restaurar desde la ficha (banner) o eliminar con esta vista abierta: la
  // fila sale o entra sin recargar.
  useEffect(() => {
    if (!taskChange) return;
    const changed = taskChange.task;
    setTasks((prev) => {
      if (!prev) return prev;
      const rest = prev.filter((task) => task.id !== changed.id);
      return isTaskDeleted(changed) ? [changed, ...rest] : rest;
    });
  }, [taskChange]);

  const visibles = useMemo(() => {
    if (!tasks) return [];
    const texto = normalizar(filtros.texto.trim());
    const filtradas = texto ? tasks.filter((task) => normalizar(task.title).includes(texto)) : tasks;
    // Desc por fecha de desactivación: lo último eliminado, arriba.
    return [...filtradas].sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0));
  }, [tasks, filtros.texto]);

  async function restaurar(task: Task): Promise<void> {
    setRestoring(task.id);
    try {
      const restored = await restoreTask(task.id);
      if (restored) setTasks((prev) => (prev ? prev.filter((t) => t.id !== task.id) : prev));
    } finally {
      setRestoring(null);
    }
  }

  const now = Date.now();
  const hayFiltro = Boolean(filtros.texto.trim() || filtros.cliente || filtros.proyecto);

  return (
    <div data-testid="tareas-desactivadas">
      {loading && !tasks ? <Spinner label="Leyendo las tareas desactivadas…" /> : null}
      {error ? <ErrorBox message={error} onRetry={() => void cargar()} /> : null}

      {!error && tasks ? (
        <p data-testid="desactivadas-contador" className="mb-3 text-small text-muted">
          {visibles.length} {visibles.length === 1 ? "tarea desactivada" : "tareas desactivadas"} · se
          pueden restaurar durante 90 días; después se borran para siempre.
        </p>
      ) : null}

      {!error && tasks && visibles.length === 0 ? (
        <EmptyState
          title={hayFiltro ? "Ninguna tarea desactivada coincide" : "No hay tareas desactivadas"}
          hint={
            hayFiltro
              ? "Prueba con otra búsqueda o quita el filtro de cliente o proyecto."
              : "Cuando elimines una tarea aparecerá aquí durante 90 días, por si necesitas restaurarla."
          }
        />
      ) : null}

      {!error && visibles.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-left">
              <thead>
                <tr>
                  {["Título", "Cliente · proyecto", "Desactivada por", "Fecha", "Borrado", ""].map((label, index) => (
                    <th
                      key={index}
                      scope="col"
                      className={`border-b border-line-soft px-2.5 py-1.5 text-label text-muted ${
                        index === 0 ? "w-full" : "whitespace-nowrap"
                      }`}
                    >
                      {label || <span className="sr-only">Acciones</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibles.map((task) => {
                  const project = projectOf(task, ctx.projects);
                  const orgId = orgIdOf(task, ctx.projects);
                  const purgeAt = taskPurgeAt(task);
                  const dias = purgeAt === null ? null : diasParaBorrado(purgeAt, now);
                  const urgente = dias !== null && dias <= DIAS_AVISO_BORRADO;
                  const cell = "border-b border-line-soft px-2.5 py-1.5 align-middle text-small";
                  return (
                    <tr key={task.id} data-testid={`desactivada-fila-${task.id}`} className="h-10">
                      <td className={`${cell} w-full`}>
                        <button
                          type="button"
                          data-testid={`desactivada-abrir-${task.id}`}
                          onClick={() => void openTask(task.id)}
                          className="block max-w-[22rem] truncate text-left font-medium text-ink-2 hover:text-link"
                        >
                          {task.title}
                        </button>
                      </td>
                      <td className={`${cell} max-w-[14rem] truncate text-muted`}>
                        {clienteLabel(orgId, ctx)}
                        {project ? ` · ${project.name}` : ""}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-ink-2`}>
                        {quienDesactivo(task.deleted_by, ctx.people)}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-muted`}>{fmtDate(task.deleted_at)}</td>
                      <td className={`${cell} whitespace-nowrap`}>
                        {dias === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          <span
                            data-testid={`desactivada-borrado-${task.id}`}
                            data-urgente={urgente ? "true" : undefined}
                            title={purgeAt ? `Borrado definitivo: ${fmtDate(purgeAt)}` : undefined}
                            className={`rounded-full px-2 py-0.5 text-label tabular-nums ${
                              urgente ? "bg-broken-bg font-semibold text-broken" : "bg-canvas-deep text-muted"
                            }`}
                          >
                            {textoBorrado(dias)}
                          </span>
                        )}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-right`}>
                        <button
                          type="button"
                          data-testid={`desactivada-restaurar-${task.id}`}
                          aria-label={`Restaurar ${task.title}`}
                          disabled={restoring === task.id}
                          onClick={() => void restaurar(task)}
                          className="press inline-flex min-h-8 items-center gap-1.5 rounded-tight border border-line bg-surface px-2.5 py-1 text-small font-semibold text-ink-2 hover:text-link focus:outline-none focus:ring-2 focus:ring-link disabled:opacity-50"
                        >
                          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                          Restaurar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
