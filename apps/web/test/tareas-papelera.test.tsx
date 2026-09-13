/**
 * Papelera de tareas: «Eliminar» no borra.
 *
 * La promesa que se prueba: eliminar pide confirmación y explica los 90 días;
 * al confirmar se manda DELETE con `expected_version`, la tarea (y sus
 * subtareas) sale de la vista y de los contadores, la ficha se cierra y el
 * aviso ofrece «Deshacer», que restaura. Un 409 revierte y dice por qué. La
 * vista «Desactivadas» lista, cuenta los días que faltan y restaura; una ficha
 * desactivada abierta por enlace se lee pero no se edita.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import TareasView from "../src/views/TareasView";
import { TaskDrawer } from "../src/views/TaskDrawer";
import { Toasts } from "../src/components/ui";
import { TEXTO_PAPELERA } from "../src/views/task/DeleteTaskButton";
import { useStore } from "../src/state/store";
import { emptyEventState, reduceEvent } from "../src/state/reducer";
import {
  parseVista,
  quienDesactivo,
  sinDesactivadas,
  textoBorrado,
} from "../src/lib/tareas";
import { diasParaBorrado, isTaskDeleted, taskPurgeAt, type Project } from "../src/lib/types";
import {
  domainEvent,
  makeTask,
  mockFetch,
  person,
  personB,
  project,
  projectB,
  type FetchCall,
} from "./helpers";

const DIA = 86_400_000;
type Wire = { method: string; body: unknown; url: string };

const projectConOrg: Project = { ...project, orgName: "ACME S.A." };
const projectBConOrg: Project = { ...projectB, orgName: "Delta Logística" };

/** Base activa: dos clientes, una tarea con subtarea y una cerrada. */
function base() {
  return [
    makeTask({ id: "t-madre", projectId: project.id, title: "Zanjar el mapa SIPOC", status: "READY", version: 5 }),
    makeTask({ id: "t-hija", projectId: project.id, parentTaskId: "t-madre", title: "Validar el SIPOC con ventas", status: "BACKLOG" }),
    makeTask({ id: "t-otra", projectId: project.id, title: "Entrevistar a operaciones", status: "IN_PROGRESS" }),
    makeTask({ id: "t-beta", projectId: projectB.id, title: "Ajustar la cadencia semanal", status: "READY" }),
    makeTask({ id: "t-cerrada", projectId: projectB.id, title: "Cerrar el trimestre", status: "DONE" }),
  ];
}

function setState() {
  useStore.setState({
    person,
    token: "tok",
    projects: [projectConOrg, projectBConOrg],
    people: [person, personB],
    activeProjectId: null,
    labelCatalog: [],
    taskDetail: null,
    taskDetailId: null,
    taskDetailLoading: false,
    taskDetailError: null,
    taskMutationError: null,
    taskConflict: null,
    taskChange: null,
    taskSaving: false,
    blockedMove: null,
    copilotOpen: false,
    board: { projectId: null, tasks: {} },
    toasts: [],
  });
}

function renderTareas(entry = "/tareas?vista=tabla") {
  setState();
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TareasView />
      <TaskDrawer />
      <Toasts />
      <Ubicacion />
    </MemoryRouter>,
  );
}

function Ubicacion() {
  const location = useLocation();
  return <span data-testid="ubicacion">{location.search}</span>;
}

/** Rutas comunes; las de escritura van primero porque el mock casa por orden. */
function rutas(opts: { deleteStatus?: number; deleted?: unknown[] } = {}) {
  return [
    {
      method: "DELETE",
      path: "/api/tasks/t-madre",
      statusFn: () => opts.deleteStatus ?? 200,
      body: () =>
        (opts.deleteStatus ?? 200) === 409
          ? { error: { code: "conflict", message: "Está en ejecución: detenla antes de eliminarla" } }
          : {
              task: makeTask({
                id: "t-madre",
                projectId: project.id,
                title: "Zanjar el mapa SIPOC",
                version: 6,
                deleted_at: Date.now(),
                deleted_by: `person:${person.id}`,
                purge_at: Date.now() + 90 * DIA,
              }),
            },
    },
    {
      method: "POST",
      path: /^\/api\/tasks\/[^/]+\/restore$/,
      body: ({ url }: Wire) => {
        const id = url.split("/api/tasks/")[1]?.split("/")[0] ?? "";
        const titles: Record<string, string> = {
          "t-madre": "Zanjar el mapa SIPOC",
          "t-vieja": "Revisar contrato viejo",
          "t-reciente": "Preparar la demo",
        };
        return {
          task: makeTask({ id, projectId: project.id, title: titles[id] ?? id, version: 7, deleted_at: null, purge_at: null }),
        };
      },
    },
    { method: "GET", path: "/api/tasks/deleted", body: { tasks: opts.deleted ?? [] } },
    { method: "GET", path: "/api/tasks", body: { tasks: base() } },
    { path: "/api/projects", body: { projects: [projectConOrg, projectBConOrg] } },
    { path: "/api/auth/people", body: { people: [person, personB] } },
    { path: "/api/labels", body: { labels: [] } },
    { path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: "org-1", people: [person] } },
    {
      method: "GET",
      path: /^\/api\/tasks\/[^/]+$/,
      body: ({ url }: Wire) => {
        const id = url.split("/api/tasks/")[1]?.split("?")[0] ?? "";
        const task = base().find((t) => t.id === id) ?? makeTask({ id });
        return { task, events: [], artifacts: [], runs: [] };
      },
    },
  ];
}

async function abrirFicha(id: string) {
  await waitFor(() => expect(screen.getByTestId(`tarea-fila-${id}`)).toBeTruthy());
  fireEvent.click(screen.getByTestId(`tarea-abrir-${id}`));
  await waitFor(() => expect(screen.getByTestId("task-eliminar")).toBeTruthy());
}

// ── Lógica pura ─────────────────────────────────────────────────────────────

describe("papelera (puro)", () => {
  it("sinDesactivadas quita las desactivadas y sus subtareas a cualquier nivel", () => {
    const tasks = [
      makeTask({ id: "a", deleted_at: 1 }),
      makeTask({ id: "b", parentTaskId: "a" }),
      makeTask({ id: "c", parentTaskId: "b" }),
      makeTask({ id: "d" }),
    ];
    expect(sinDesactivadas(tasks).map((t) => t.id)).toEqual(["d"]);
    // Sin desactivadas devuelve la misma base, sin copiar.
    const activas = [makeTask({ id: "x" })];
    expect(sinDesactivadas(activas)).toBe(activas);
  });

  it("cuenta los días que faltan para el borrado y los dice en una frase", () => {
    const now = 1_000_000_000_000;
    expect(diasParaBorrado(now + 3 * DIA - 1000, now)).toBe(3);
    expect(diasParaBorrado(now + DIA, now)).toBe(1);
    expect(diasParaBorrado(now - DIA, now)).toBe(0);
    expect(textoBorrado(0)).toBe("Se borra hoy");
    expect(textoBorrado(1)).toBe("Se borra en 1 día");
    expect(textoBorrado(12)).toBe("Se borra en 12 días");
    // Sin purge_at de la API, la fecha es deleted_at + 90 días.
    expect(taskPurgeAt({ deleted_at: now, purge_at: null })).toBe(now + 90 * DIA);
    expect(taskPurgeAt({ deleted_at: null, purge_at: null })).toBeNull();
    expect(isTaskDeleted(makeTask())).toBe(false);
  });

  it("traduce quién la desactivó y acepta «desactivadas» como vista de la URL", () => {
    expect(quienDesactivo("person:p-jorge", [person, personB])).toBe("Jorge");
    expect(quienDesactivo("p-ernesto", [person, personB])).toBe("Ernesto");
    expect(quienDesactivo(null, [])).toBe("—");
    expect(parseVista(new URLSearchParams("vista=desactivadas"))).toBe("desactivadas");
  });

  it("el evento de cambio de tarea con deleted_at saca la tarjeta y sus hijas del tablero", () => {
    const madre = makeTask({ id: "t-madre" });
    const hija = makeTask({ id: "t-hija", parentTaskId: "t-madre" });
    const otra = makeTask({ id: "t-otra" });
    const state = {
      ...emptyEventState(),
      board: { projectId: project.id, tasks: { [madre.id]: madre, [hija.id]: hija, [otra.id]: otra } },
    };
    const { state: next, effects } = reduceEvent(
      state,
      domainEvent(`board:${project.id}`, 1, "task.updated", { task: { ...madre, deleted_at: 5, purge_at: 10 } }),
    );
    expect(Object.keys(next.board.tasks)).toEqual(["t-otra"]);
    expect(effects).toContainEqual({ kind: "refetch_task", taskId: "t-madre" });
  });
});

// ── Eliminar desde la ficha ─────────────────────────────────────────────────

describe("eliminar desde la ficha", () => {
  let calls: FetchCall[];
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  beforeEach(() => {
    calls = mockFetch(rutas()).calls;
  });

  it("pide confirmación, manda DELETE con expected_version, quita la tarea y «Deshacer» la restaura", async () => {
    renderTareas();
    await abrirFicha("t-madre");
    expect(screen.getByTestId("tareas-contador").textContent).toContain("4 tareas");

    fireEvent.click(screen.getByTestId("task-eliminar"));
    const dialogo = await screen.findByTestId("task-eliminar-dialogo");
    expect(dialogo.getAttribute("role")).toBe("dialog");
    expect(within(dialogo).getByText(TEXTO_PAPELERA)).toBeTruthy();
    expect(TEXTO_PAPELERA).toBe(
      "La tarea pasa a Desactivadas. Puedes restaurarla durante 90 días; después se borra para siempre.",
    );
    // Dice cuántas subtareas se van con ella.
    await waitFor(() =>
      expect(within(dialogo).getByTestId("task-eliminar-subtareas").textContent).toBe(
        "Tiene 1 subtarea: también pasa a Desactivadas.",
      ),
    );
    // Abrir la confirmación no borra nada.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialogo).getByTestId("task-eliminar-confirmar"));

    // Optimista: la fila y su subtarea salen ya, y la ficha se cierra.
    expect(screen.queryByTestId("tarea-fila-t-madre")).toBeNull();
    expect(screen.queryByTestId("tarea-fila-t-hija")).toBeNull();
    expect(screen.queryByTestId("task-peek")).toBeNull();
    expect(screen.getByTestId("tarea-fila-t-otra")).toBeTruthy();

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const borrado = calls.find((c) => c.method === "DELETE");
    expect(borrado?.url).toContain("/api/tasks/t-madre");
    expect(borrado?.body).toEqual({ expected_version: 5 });

    // El contador no cuenta las desactivadas.
    expect(screen.getByTestId("tareas-contador").textContent).toContain("2 tareas");
    // 5 en la base − la madre y su hija desactivadas = 3 (una de ellas, cerrada).
    expect(screen.getByTestId("tareas-resumen").textContent).toContain("2 de 3 tareas");
    expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("1 terminadas ocultas");

    const deshacer = await screen.findByTestId("toast-accion");
    expect(deshacer.textContent).toBe("Deshacer");
    expect(screen.getByText("«Zanjar el mapa SIPOC» pasó a Desactivadas")).toBeTruthy();

    fireEvent.click(deshacer);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/tasks/t-madre/restore"))).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-madre")).toBeTruthy());
    expect(screen.getByTestId("tarea-fila-t-hija")).toBeTruthy();
    expect(screen.getByTestId("tareas-contador").textContent).toContain("4 tareas");
  });

  it("cancelar cierra la confirmación sin llamar a la API", async () => {
    renderTareas();
    await abrirFicha("t-madre");
    fireEvent.click(screen.getByTestId("task-eliminar"));
    fireEvent.click(await screen.findByTestId("task-eliminar-cancelar"));
    await waitFor(() => expect(screen.queryByTestId("task-eliminar-dialogo")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByTestId("tarea-fila-t-madre")).toBeTruthy();
    expect(screen.getByTestId("task-peek")).toBeTruthy();
  });
});

describe("eliminar con 409", () => {
  let calls: FetchCall[];
  beforeEach(() => {
    calls = mockFetch(rutas({ deleteStatus: 409 })).calls;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revierte: la tarea vuelve, la ficha se reabre y el aviso dice por qué", async () => {
    renderTareas();
    await abrirFicha("t-madre");
    fireEvent.click(screen.getByTestId("task-eliminar"));
    fireEvent.click(await screen.findByTestId("task-eliminar-confirmar"));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-madre")).toBeTruthy());
    expect(screen.getByTestId("tarea-fila-t-hija")).toBeTruthy();
    expect(await screen.findByText("Está en ejecución: detenla antes de eliminarla")).toBeTruthy();
    // Sin «Deshacer»: no hay nada que deshacer.
    expect(screen.queryByTestId("toast-accion")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("task-peek")).toBeTruthy());
    expect(screen.getByTestId("tareas-contador").textContent).toContain("4 tareas");
  });
});

// ── Vista «Desactivadas» ────────────────────────────────────────────────────

describe("vista Desactivadas", () => {
  let calls: FetchCall[];
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function desactivadas() {
    const now = Date.now();
    return [
      makeTask({
        id: "t-reciente",
        projectId: project.id,
        title: "Preparar la demo",
        deleted_at: now - DIA,
        deleted_by: "person:p-jorge",
        purge_at: now + 60 * DIA - 1000,
      }),
      makeTask({
        id: "t-vieja",
        projectId: projectB.id,
        title: "Revisar contrato viejo",
        deleted_at: now - 87 * DIA,
        deleted_by: "person:p-ernesto",
        purge_at: now + 3 * DIA - 1000,
      }),
    ];
  }

  it("se elige desde el conmutador, viaja en la URL, lista, cuenta días y restaura", async () => {
    calls = mockFetch(rutas({ deleted: desactivadas() })).calls;
    renderTareas("/tareas?vista=tabla");
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-madre")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tareas-vista-desactivadas"));
    expect(screen.getByTestId("tareas-vista-desactivadas").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ubicacion").textContent).toContain("vista=desactivadas");
    await waitFor(() => expect(screen.getByTestId("desactivada-fila-t-vieja")).toBeTruthy());
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/api/tasks/deleted"))).toBe(true);

    // La base activa no se pinta aquí, ni sus contadores.
    expect(screen.queryByTestId("tarea-fila-t-madre")).toBeNull();
    expect(screen.queryByTestId("tareas-contador")).toBeNull();

    const reciente = screen.getByTestId("desactivada-fila-t-reciente");
    expect(within(reciente).getByText("Jorge")).toBeTruthy();
    expect(reciente.textContent).toContain("ACME S.A. · ACME assessment");
    const diasReciente = screen.getByTestId("desactivada-borrado-t-reciente");
    expect(diasReciente.textContent).toBe("Se borra en 60 días");
    expect(diasReciente.getAttribute("data-urgente")).toBeNull();

    const diasVieja = screen.getByTestId("desactivada-borrado-t-vieja");
    expect(diasVieja.textContent).toBe("Se borra en 3 días");
    expect(diasVieja.getAttribute("data-urgente")).toBe("true");

    // Búsqueda: la misma caja de la vista.
    fireEvent.change(screen.getByTestId("tareas-buscar"), { target: { value: "contrato" } });
    expect(screen.queryByTestId("desactivada-fila-t-reciente")).toBeNull();
    expect(screen.getByTestId("desactivada-fila-t-vieja")).toBeTruthy();

    fireEvent.click(screen.getByTestId("desactivada-restaurar-t-vieja"));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/tasks/t-vieja/restore"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId("desactivada-fila-t-vieja")).toBeNull());
    expect(await screen.findByText("Ninguna tarea desactivada coincide")).toBeTruthy();
  });

  it("sin nada desactivado muestra un vacío claro", async () => {
    calls = mockFetch(rutas({ deleted: [] })).calls;
    renderTareas("/tareas?vista=desactivadas");
    expect(await screen.findByText("No hay tareas desactivadas")).toBeTruthy();
    expect(
      screen.getByText("Cuando elimines una tarea aparecerá aquí durante 90 días, por si necesitas restaurarla."),
    ).toBeTruthy();
  });

  it("filtra por cliente en la API", async () => {
    calls = mockFetch(rutas({ deleted: [] })).calls;
    renderTareas("/tareas?vista=desactivadas&cliente=org-2");
    expect(await screen.findByText("Ninguna tarea desactivada coincide")).toBeTruthy();
    const pedido = calls.find((c) => c.url.includes("/api/tasks/deleted"));
    expect(pedido?.url).toContain("org_id=org-2");
    // Los cortes de la base activa no aplican en la papelera.
    expect(screen.queryByTestId("tareas-mias")).toBeNull();
    expect(screen.queryByTestId("tareas-agrupar")).toBeNull();
  });
});

// ── Ficha de una tarea desactivada ──────────────────────────────────────────

describe("ficha de una tarea desactivada", () => {
  let calls: FetchCall[];
  beforeEach(() => {
    calls = mockFetch(rutas()).calls;
    setState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("muestra el banner con la fecha de borrado, deja todo en solo lectura y restaura", async () => {
    const purgeAt = new Date("2026-12-12T10:00:00").getTime();
    const task = makeTask({
      id: "t-madre",
      projectId: project.id,
      title: "Zanjar el mapa SIPOC",
      deleted_at: purgeAt - 90 * DIA,
      purge_at: purgeAt,
    });
    act(() => {
      useStore.setState({ taskDetail: { task, events: [], artifacts: [], runs: [], project }, taskDetailId: task.id });
    });
    render(
      <MemoryRouter>
        <TaskDrawer />
        <Toasts />
      </MemoryRouter>,
    );

    const banner = screen.getByTestId("task-desactivada-banner");
    expect(banner.textContent).toContain("Desactivada");
    expect(banner.textContent).toContain(
      `se borra el ${new Date(purgeAt).toLocaleDateString("es", { day: "numeric", month: "short" })}`,
    );
    // Solo lectura: el cuerpo es inerte, el título no se edita y no se ofrece eliminar otra vez.
    expect(screen.getByTestId("task-body-contenido").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("task-title").getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByTestId("task-eliminar")).toBeNull();

    // Aunque algo llegara a pedir guardar, el store no manda el PATCH.
    await act(async () => {
      await useStore.getState().updateTask("t-madre", { title: "otro" });
    });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    fireEvent.click(screen.getByTestId("task-restaurar"));
    await waitFor(() => expect(screen.queryByTestId("task-desactivada-banner")).toBeNull());
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/tasks/t-madre/restore"))).toBe(true);
    expect(screen.getByTestId("task-body-contenido").hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("task-title").getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("task-eliminar")).toBeTruthy();
  });
});
