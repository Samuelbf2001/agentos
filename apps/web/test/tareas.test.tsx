/**
 * La base transversal de tareas (PLAN-v1.5 §Navegación nueva, entrada Tareas).
 *
 * Lo que se prueba es exactamente la promesa del producto: una sola base que
 * cruza clientes y proyectos, filtros que se combinan entre sí, orden por
 * columna, "Mis tareas" como filtro y no como pantalla, y creación rápida sin
 * salir de la vista.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import TareasView from "../src/views/TareasView";
import { useStore } from "../src/state/store";
import {
  FILTROS_VACIOS,
  YO,
  agrupar,
  chipsActivos,
  clienteLabel,
  filtrar,
  filtrosAParams,
  ordenar,
  parseFiltros,
  type Contexto,
} from "../src/lib/tareas";
import {
  agents,
  makeTask,
  mockFetch,
  person,
  personB,
  project,
  projectB,
  type FetchCall,
} from "./helpers";

const ctx: Contexto = {
  projects: [project, projectB],
  people: [person, personB],
  meId: person.id,
};

const AHORA = new Date("2026-09-05T12:00:00").getTime();

/** Base pequeña pero transversal: dos clientes, dos proyectos, dos personas. */
function base() {
  return [
    makeTask({
      id: "t-acme-vencida",
      projectId: project.id,
      title: "Entrevistar a operaciones",
      status: "IN_PROGRESS",
      priority: "urgent",
      dueAt: AHORA - 86_400_000,
      labels: ["cliente"],
      assignees: [{ personId: person.id, isPrimary: true }],
    }),
    makeTask({
      id: "t-acme-hoy",
      projectId: project.id,
      title: "Zanjar el mapa SIPOC",
      status: "READY",
      priority: "normal",
      dueAt: AHORA + 3_600_000,
      labels: ["urgente"],
      assignees: [{ personId: personB.id, isPrimary: true }],
    }),
    makeTask({
      id: "t-beta-semana",
      projectId: projectB.id,
      title: "Ajustar la cadencia semanal",
      status: "READY",
      priority: "high",
      dueAt: AHORA + 3 * 86_400_000,
      labels: ["cliente", "ops"],
      assignees: [{ personId: person.id, isPrimary: true }],
    }),
    makeTask({
      id: "t-beta-sin-fecha",
      projectId: projectB.id,
      title: "Archivar el informe anterior",
      status: "BACKLOG",
      priority: "low",
      dueAt: null,
    }),
    makeTask({
      id: "t-beta-cerrada",
      projectId: projectB.id,
      title: "Cerrar el trimestre",
      status: "DONE",
      dueAt: null,
    }),
  ];
}

// ── Lógica pura ─────────────────────────────────────────────────────────────

describe("filtros (puros)", () => {
  it("por defecto muestra la base entera de todos los clientes, menos las cerradas", () => {
    const visible = filtrar(base(), FILTROS_VACIOS, ctx, AHORA);
    expect(visible.map((t) => t.id)).toEqual([
      "t-acme-vencida",
      "t-acme-hoy",
      "t-beta-semana",
      "t-beta-sin-fecha",
    ]);
    // Es transversal: hay tareas de más de un proyecto y de más de un cliente.
    expect(new Set(visible.map((t) => t.projectId)).size).toBe(2);
  });

  it("combina cliente, estado y vencimiento a la vez", () => {
    const visible = filtrar(
      base(),
      { ...FILTROS_VACIOS, cliente: "org-1", estado: "READY", vencimiento: "hoy" },
      ctx,
      AHORA,
    );
    expect(visible.map((t) => t.id)).toEqual(["t-acme-hoy"]);
  });

  it("combina responsable con etiqueta sin quedarse en un solo proyecto", () => {
    const visible = filtrar(
      base(),
      { ...FILTROS_VACIOS, responsable: YO, etiqueta: "cliente" },
      ctx,
      AHORA,
    );
    expect(visible.map((t) => t.id)).toEqual(["t-acme-vencida", "t-beta-semana"]);
    expect(new Set(visible.map((t) => t.projectId)).size).toBe(2);
  });

  it("«sin-fecha» y «vencidas» son cortes distintos, y las cerradas sólo si se piden", () => {
    expect(
      filtrar(base(), { ...FILTROS_VACIOS, vencimiento: "sin-fecha" }, ctx, AHORA).map((t) => t.id),
    ).toEqual(["t-beta-sin-fecha"]);
    expect(
      filtrar(base(), { ...FILTROS_VACIOS, vencimiento: "vencidas" }, ctx, AHORA).map((t) => t.id),
    ).toEqual(["t-acme-vencida"]);
    expect(
      filtrar(base(), { ...FILTROS_VACIOS, cerradas: true, vencimiento: "sin-fecha" }, ctx, AHORA)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["t-beta-cerrada", "t-beta-sin-fecha"]);
  });

  it("filtrar por un estado cerrado lo muestra aunque «cerradas» no esté marcado (I3)", () => {
    const visible = filtrar(base(), { ...FILTROS_VACIOS, estado: "DONE" }, ctx, AHORA);
    expect(visible.map((t) => t.id)).toEqual(["t-beta-cerrada"]);
  });

  it("el texto busca también por nombre de proyecto y por etiqueta, sin tildes", () => {
    expect(filtrar(base(), { ...FILTROS_VACIOS, texto: "beta" }, ctx, AHORA)).toHaveLength(2);
    expect(filtrar(base(), { ...FILTROS_VACIOS, texto: "ZANJAR" }, ctx, AHORA)).toHaveLength(1);
    // Las tildes no cambian el resultado: se escribe rápido y se busca igual.
    expect(filtrar(base(), { ...FILTROS_VACIOS, texto: "cadéncia" }, ctx, AHORA)).toHaveLength(1);
    expect(filtrar(base(), { ...FILTROS_VACIOS, texto: "cadencia" }, ctx, AHORA)).toHaveLength(1);
    // Y la etiqueta cuenta como texto: se busca por lo que se ve en la fila.
    expect(
      filtrar(base(), { ...FILTROS_VACIOS, texto: "urgente" }, ctx, AHORA).map((t) => t.id),
    ).toEqual(["t-acme-hoy"]);
  });

  it("«responsable=yo» sin sesión resuelta no cuela la base entera", () => {
    const sinSesion = { ...ctx, meId: null };
    expect(filtrar(base(), { ...FILTROS_VACIOS, responsable: YO }, sinSesion, AHORA)).toHaveLength(0);
  });
});

describe("orden por columna (puro)", () => {
  const tasks = () => filtrar(base(), FILTROS_VACIOS, ctx, AHORA);

  it("ordena por título en ambos sentidos", () => {
    expect(ordenar(tasks(), "titulo", "asc", ctx).map((t) => t.id)).toEqual([
      "t-beta-semana",
      "t-beta-sin-fecha",
      "t-acme-vencida",
      "t-acme-hoy",
    ]);
    expect(ordenar(tasks(), "titulo", "desc", ctx)[0]!.id).toBe("t-acme-hoy");
  });

  it("por vencimiento, «sin fecha» va al final y nunca entre las que vencen", () => {
    expect(ordenar(tasks(), "vencimiento", "asc", ctx).map((t) => t.id)).toEqual([
      "t-acme-vencida",
      "t-acme-hoy",
      "t-beta-semana",
      "t-beta-sin-fecha",
    ]);
  });

  it("por prioridad va de urgente a baja, no por orden alfabético", () => {
    expect(ordenar(tasks(), "prioridad", "asc", ctx).map((t) => t.priority)).toEqual([
      "urgent",
      "high",
      "normal",
      "low",
    ]);
  });

  it("por proyecto y por responsable usa el nombre legible, no el id", () => {
    expect(ordenar(tasks(), "proyecto", "asc", ctx)[0]!.projectId).toBe(project.id);
    // Dos tareas de Ernesto: entre ellas manda el título, no el orden de llegada.
    expect(ordenar(tasks(), "responsable", "asc", ctx).map((t) => t.id)).toEqual([
      "t-beta-semana",
      "t-acme-vencida",
      "t-acme-hoy",
      "t-beta-sin-fecha",
    ]);
  });
});

describe("agrupación (pura)", () => {
  const tasks = () => filtrar(base(), FILTROS_VACIOS, ctx, AHORA);

  it("por cliente reparte entre las dos organizaciones", () => {
    const grupos = agrupar(tasks(), "cliente", ctx, AHORA);
    expect(grupos.map((g) => g.key)).toEqual(["org-1", "org-2"]);
    expect(grupos.map((g) => g.label)).toEqual([project.name, projectB.name]);
    expect(grupos[0]!.tasks).toHaveLength(2);
    expect(grupos[1]!.tasks).toHaveLength(2);
  });

  it("por responsable deja «Sin responsable» al final", () => {
    const grupos = agrupar(tasks(), "responsable", ctx, AHORA);
    expect(grupos.at(-1)!.key).toBe("sin-responsable");
    expect(grupos.map((g) => g.label)).toContain("Ernesto");
  });

  it("por etiqueta, una tarea con dos etiquetas aparece en las dos", () => {
    const grupos = agrupar(tasks(), "etiqueta", ctx, AHORA);
    const cliente = grupos.find((g) => g.key === "cliente")!;
    const ops = grupos.find((g) => g.key === "ops")!;
    expect(cliente.tasks.map((t) => t.id)).toEqual(["t-acme-vencida", "t-beta-semana"]);
    expect(ops.tasks.map((t) => t.id)).toEqual(["t-beta-semana"]);
    expect(grupos.at(-1)!.key).toBe("sin-etiqueta");
  });

  it("por vencimiento respeta el orden vencidas → hoy → semana → sin fecha", () => {
    expect(agrupar(tasks(), "vencimiento", ctx, AHORA).map((g) => g.key)).toEqual([
      "overdue",
      "today",
      "week",
      "none",
    ]);
  });

  it("sin agrupar devuelve un único grupo con todo", () => {
    expect(agrupar(tasks(), "ninguna", ctx, AHORA)).toHaveLength(1);
  });
});

describe("cliente y query", () => {
  it("el nombre real del cliente manda; sin recibo se deduce de sus proyectos", () => {
    // Con recibo de launch: el nombre de la empresa, tal cual.
    expect(
      clienteLabel("org-1", { ...ctx, clientNames: new Map([["org-1", "ACME S.A."]]) }),
    ).toBe("ACME S.A.");
    // Sin recibo: un proyecto presta su nombre; varios, el prefijo común.
    expect(clienteLabel("org-1", ctx)).toBe(project.name);
    expect(
      clienteLabel("org-9", {
        projects: [
          { ...project, id: "a", orgId: "org-9", name: "Gamma assessment" },
          { ...project, id: "b", orgId: "org-9", name: "Gamma operación" },
        ],
      }),
    ).toBe("Gamma");
    expect(clienteLabel(null, ctx)).toBe("Sin cliente");
  });

  it("los filtros viajan en la query y vuelven idénticos", () => {
    const filtros = {
      ...FILTROS_VACIOS,
      cliente: "org-2",
      estado: "READY" as const,
      responsable: YO,
      texto: "cadencia",
    };
    const params = filtrosAParams(filtros);
    expect(params.get("cliente")).toBe("org-2");
    expect(parseFiltros(params)).toEqual(filtros);
  });

  it("cada filtro puesto produce un chip que se puede quitar", () => {
    const chips = chipsActivos(
      { ...FILTROS_VACIOS, cliente: "org-2", responsable: YO, vencimiento: "vencidas" },
      ctx,
    );
    expect(chips.map((c) => c.key)).toEqual(["cliente", "responsable", "vencimiento"]);
    expect(chips.map((c) => c.value)).toEqual([projectB.name, "Yo", "Vencidas"]);
    // Y con el nombre real del cliente, el chip lo usa sin tocar nada más.
    expect(
      chipsActivos(
        { ...FILTROS_VACIOS, cliente: "org-2" },
        { ...ctx, clientNames: new Map([["org-2", "Delta Logística"]]) },
      )[0]!.value,
    ).toBe("Delta Logística");
  });
});

// ── La vista ────────────────────────────────────────────────────────────────

type Wire = { method: string; body: unknown; url: string };

const viewRoutes = [
  // Las rutas de escritura van antes: el mock casa por orden y la de lectura
  // no declara método, así que atraparía también el POST.
  {
    method: "POST",
    path: "/api/tasks",
    body: ({ body }: Wire) => {
      const input = body as { project_id: string; title: string };
      return {
        task: makeTask({ id: "t-nueva", projectId: input.project_id, title: input.title }),
      };
    },
  },
  {
    method: "PATCH",
    path: "/api/tasks/t-acme-hoy",
    body: ({ body }: Wire) => ({
      task: makeTask({
        id: "t-acme-hoy",
        projectId: project.id,
        title: (body as { title: string }).title,
      }),
    }),
  },
  {
    method: "POST",
    path: "/api/tasks/t-acme-hoy/move",
    body: ({ body }: Wire) => ({
      task: makeTask({
        id: "t-acme-hoy",
        projectId: project.id,
        status: (body as { to: "IN_PROGRESS" }).to,
      }),
    }),
  },
  { path: "/api/tasks", body: { tasks: base() } },
  { path: "/api/projects", body: { projects: [project, projectB] } },
  { path: "/api/auth/people", body: { people: [person, personB] } },
  { path: "/api/labels", body: { labels: [{ label: "cliente", count: 2 }, { label: "ops", count: 1 }] } },
  {
    path: /^\/api\/projects\/[^/]+\/launches$/,
    body: ({ url }: Wire) => {
      const projectId = url.split("/api/projects/")[1]?.split("/")[0];
      const org = projectId === projectB.id ? projectB.orgId : project.orgId;
      const empresa = projectId === projectB.id ? "Delta Logística" : "ACME S.A.";
      return { launches: [{ org_id: org, project_id: projectId, inputs: { empresa } }] };
    },
  },
  { path: /^\/api\/tasks\/[^/]+$/, body: { task: makeTask(), events: [], artifacts: [], runs: [] } },
];

function renderTareas(entry = "/tareas") {
  useStore.setState({
    person,
    token: "tok",
    projects: [project, projectB],
    people: [person, personB],
    activeProjectId: null,
    labelCatalog: [],
    taskDetail: null,
    taskDetailId: null,
    taskDetailLoading: false,
    taskDetailError: null,
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TareasView />
    </MemoryRouter>,
  );
}

describe("TareasView (render)", () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = mockFetch(viewRoutes).calls;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("pide la base entera (sin project_id) y muestra tareas de más de un proyecto a la vez", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());

    // Una sola llamada, sin proyecto: no se navega cliente por cliente.
    const listado = calls.filter((c) => c.method === "GET" && c.url.includes("/api/tasks"));
    expect(listado.some((c) => c.url.includes("project_id"))).toBe(false);

    expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy();
    // Los dos clientes conviven en la misma lista, sin cambiar de pantalla.
    expect(screen.getAllByText(project.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(projectB.name).length).toBeGreaterThan(0);
    expect(screen.getByTestId("tareas-resumen").textContent).toContain("2 proyectos");
    expect(screen.getByTestId("tareas-resumen").textContent).toContain("2 clientes");
  });

  it("cruza dos filtros y deja los chips visibles y borrables", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    fireEvent.change(screen.getByTestId("tareas-filtro-cliente"), { target: { value: "org-1" } });
    fireEvent.change(screen.getByTestId("tareas-filtro-estado"), { target: { value: "READY" } });

    await waitFor(() => expect(screen.queryByTestId("tarea-fila-t-beta-semana")).toBeNull());
    expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy();
    expect(screen.queryByTestId("tarea-fila-t-acme-vencida")).toBeNull();

    const chips = screen.getByTestId("tareas-chips");
    expect(within(chips).getByTestId("tareas-chip-cliente")).toBeTruthy();
    expect(within(chips).getByTestId("tareas-chip-estado")).toBeTruthy();

    // Quitar un chip devuelve sólo ese filtro; el otro sigue puesto.
    fireEvent.click(screen.getByTestId("tareas-chip-estado"));
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    expect(screen.queryByTestId("tarea-fila-t-beta-semana")).toBeNull();

    fireEvent.click(screen.getByTestId("tareas-limpiar"));
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy());
    expect(screen.queryByTestId("tareas-chips")).toBeNull();
  });

  it("agrupa por cliente y por vencimiento sin dejar de ser la misma base", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    fireEvent.change(screen.getByTestId("tareas-agrupar"), { target: { value: "cliente" } });
    await waitFor(() => expect(screen.getByTestId("tareas-grupo-org-1")).toBeTruthy());
    expect(screen.getByTestId("tareas-grupo-org-2")).toBeTruthy();

    fireEvent.change(screen.getByTestId("tareas-agrupar"), { target: { value: "vencimiento" } });
    await waitFor(() => expect(screen.getByTestId("tareas-grupo-overdue")).toBeTruthy());
    expect(screen.getByTestId("tareas-grupo-none")).toBeTruthy();
  });

  it("la cabecera ordena por su columna y alterna el sentido", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    const ids = () =>
      [...document.querySelectorAll("[data-testid^='tarea-fila-']")].map((el) =>
        el.getAttribute("data-testid"),
      );

    // El orden por defecto es el vencimiento: primero lo vencido.
    expect(ids()[0]).toBe("tarea-fila-t-acme-vencida");

    fireEvent.click(screen.getByTestId("tareas-orden-titulo"));
    await waitFor(() => expect(ids()[0]).toBe("tarea-fila-t-beta-semana"));

    fireEvent.click(screen.getByTestId("tareas-orden-titulo"));
    await waitFor(() => expect(ids()[0]).toBe("tarea-fila-t-acme-hoy"));
  });

  it("«Mis tareas» es un filtro con botón y atajo, no otra pantalla", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tareas-mias"));
    await waitFor(() => expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull());
    expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy();
    expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy();
    expect(screen.getByTestId("tareas-mias").getAttribute("aria-pressed")).toBe("true");

    // `m` lo quita: el mismo filtro, desde el teclado.
    fireEvent.keyDown(window, { key: "m" });
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());
  });

  it("con la ficha abierta, los atajos de teclado de la lista no actúan (M8)", async () => {
    renderTareas();
    const row = await screen.findByTestId("tarea-fila-t-acme-hoy");
    fireEvent.click(row);
    await waitFor(() => expect(useStore.getState().taskDetailId).toBe("t-acme-hoy"));

    // "m" no debe filtrar por "mis tareas" mientras la ficha está abierta.
    fireEvent.keyDown(window, { key: "m" });
    expect(screen.getByTestId("tareas-mias").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy();

    // "j"/"Enter" tampoco mueven el cursor de la lista ni reabren otra ficha.
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(useStore.getState().taskDetailId).toBe("t-acme-hoy");
  });

  it("arranca con el filtro ya puesto cuando viene en la query", async () => {
    renderTareas("/tareas?responsable=yo");
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull();
    expect(screen.getByTestId("tareas-chip-responsable").textContent).toContain("Yo");
  });

  it("la creación rápida manda título y proyecto, y recuerda el último usado", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tareas-alta-titulo")).toBeTruthy());
    fireEvent.change(screen.getByTestId("tareas-alta-titulo"), {
      target: { value: "Llamar al sponsor" },
    });
    fireEvent.change(screen.getByTestId("tareas-alta-proyecto"), { target: { value: projectB.id } });
    fireEvent.click(screen.getByTestId("tareas-alta-enviar"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/tasks"));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({
        project_id: projectB.id,
        title: "Llamar al sponsor",
        stage: projectB.stage,
      });
    });
    expect(localStorage.getItem("agentos_tareas_ultimo_proyecto")).toBe(projectB.id);
    // La tarea recién creada entra en la base sin recargar la vista.
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-nueva")).toBeTruthy());
  });

  it("«Más campos…» abre el diálogo completo con el título ya escrito", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tareas-alta-titulo")).toBeTruthy());
    fireEvent.change(screen.getByTestId("tareas-alta-titulo"), { target: { value: "Preparar acta" } });
    fireEvent.click(screen.getByTestId("tareas-alta-mas"));

    const dialog = await screen.findByTestId("create-task-dialog");
    expect((within(dialog).getByLabelText(/Título/) as HTMLInputElement).value).toBe("Preparar acta");
  });

  it("desde cada fila se salta al proyecto (Ruta) y al cliente, sin salir del trabajo", async () => {
    renderTareas();
    const row = await screen.findByTestId("tarea-fila-t-beta-semana");
    const links = within(row).getAllByRole("link");
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`/proyectos/${projectB.id}/ruta`);
    expect(hrefs).toContain(`/tareas?cliente=${projectB.orgId}`);
  });

  it("abrir una fila pide la ficha sin cambiar de pantalla", async () => {
    renderTareas();
    const row = await screen.findByTestId("tarea-fila-t-acme-hoy");
    fireEvent.click(row);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/api/tasks/t-acme-hoy"))).toBe(true),
    );
    // Seguimos en la vista: la base no se ha ido a ninguna parte.
    expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy();
  });

  it("el estado se edita en línea desde la fila", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-estado-t-acme-hoy")).toBeTruthy());
    fireEvent.change(screen.getByTestId("tarea-estado-t-acme-hoy"), {
      target: { value: "IN_PROGRESS" },
    });
    await waitFor(() => {
      const move = calls.find((c) => c.url.includes("/api/tasks/t-acme-hoy/move"));
      expect(move).toBeTruthy();
      expect(move!.body).toMatchObject({ to: "IN_PROGRESS" });
    });
  });

  it("desde BACKLOG el desplegable sólo ofrece los destinos humanos válidos (I4)", async () => {
    renderTareas();
    const select = await screen.findByTestId("tarea-estado-t-beta-sin-fecha");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    // BACKLOG->READY y BACKLOG->CANCELLED son las únicas transiciones humanas;
    // el resto de la matriz (IN_PROGRESS, REVIEW, BLOCKED, DONE) no aparece.
    expect(options).toEqual(["BACKLOG", "READY", "CANCELLED"]);
  });

  it("una tarea DONE no ofrece cambios de estado (I4)", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());
    // Los cerrados sólo aparecen si se piden: filtrar por "Terminada" (I3) los trae.
    fireEvent.change(screen.getByTestId("tareas-filtro-estado"), { target: { value: "DONE" } });
    const select = await screen.findByTestId("tarea-estado-t-beta-cerrada");
    expect(select.hasAttribute("disabled")).toBe(true);
  });

  it("move envía expected_version y un 409 no revierte en silencio (I4)", async () => {
    calls = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t-acme-hoy/move",
        status: 409,
        body: { error: { code: "version_conflict", message: "La tarea cambió de versión" } },
      },
      ...viewRoutes,
    ]).calls;
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-estado-t-acme-hoy")).toBeTruthy());

    fireEvent.change(screen.getByTestId("tarea-estado-t-acme-hoy"), {
      target: { value: "IN_PROGRESS" },
    });

    await waitFor(() => {
      const move = calls.find((c) => c.method === "POST" && c.url.includes("/api/tasks/t-acme-hoy/move"));
      expect(move).toBeTruthy();
      expect(move!.body).toMatchObject({ to: "IN_PROGRESS", expected_version: 3 });
    });

    // El mensaje real llega al usuario y la ficha se abre; no hay reversión muda.
    await waitFor(() => {
      const toasts = useStore.getState().toasts;
      expect(
        toasts.some((t) => t.kind === "error" && t.text.includes("La tarea cambió de versión")),
      ).toBe(true);
    });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/tasks/t-acme-hoy"))).toBe(true),
    );
    expect(screen.getByTestId("tarea-estado-t-acme-hoy").getAttribute("data-status")).toBe("READY");
  });

  it("el título se renombra en línea, sin abrir la ficha", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tarea-renombrar-t-acme-hoy"));
    const input = await screen.findByTestId("tarea-titulo-input-t-acme-hoy");
    fireEvent.change(input, { target: { value: "Zanjar el mapa SIPOC con ventas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/api/tasks/t-acme-hoy"));
      expect(patch).toBeTruthy();
      expect(patch!.body).toMatchObject({ title: "Zanjar el mapa SIPOC con ventas", expected_version: 3 });
    });
    // La fila se queda donde estaba: renombrar no es navegar.
    await waitFor(() =>
      expect(screen.getByTestId("tarea-abrir-t-acme-hoy").textContent).toBe(
        "Zanjar el mapa SIPOC con ventas",
      ),
    );
  });

  it("con muchas tareas capa el render a 200 y «Mostrar más» revela el resto, sin tocar los contadores (I2)", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      makeTask({ id: `t-many-${i}`, projectId: project.id, title: `Tarea generada ${i}`, status: "READY" }),
    );
    mockFetch([{ method: "GET", path: "/api/tasks", body: { tasks: many } }, ...viewRoutes]);
    renderTareas();

    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-many-0")).toBeTruthy());
    expect(screen.getAllByTestId(/^tarea-fila-/).length).toBe(200);
    // Los contadores del resumen siguen viendo el total, no el tope de render.
    expect(screen.getByTestId("tareas-resumen").textContent).toContain("250 de 250 tareas");

    const bar = screen.getByTestId("tareas-mostrar-mas");
    expect(bar.textContent).toContain("Mostrando 200 de 250");
    fireEvent.click(within(bar).getByText("Mostrar más"));

    await waitFor(() => expect(screen.getAllByTestId(/^tarea-fila-/).length).toBe(250));
    expect(screen.queryByTestId("tareas-mostrar-mas")).toBeNull();
  });

  it("sin coincidencias lo dice y ofrece volver a la base completa", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());
    fireEvent.change(screen.getByTestId("tareas-buscar"), { target: { value: "zzz-no-existe" } });
    await waitFor(() => expect(screen.getByText("Nada coincide con estos filtros")).toBeTruthy());
    fireEvent.click(screen.getByText("Limpiar los filtros"));
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());
  });
});

// ── Navegación ──────────────────────────────────────────────────────────────

describe("Tareas en la navegación global", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderApp(entry: string) {
    useStore.setState({
      person,
      token: "tok",
      bootstrapped: true,
      projects: [project, projectB],
      people: [person, personB],
      activeProjectId: null,
      agents,
      approvals: [],
      reviewTasks: [],
      failedRunsCount: 0,
      labelCatalog: [],
      taskDetail: null,
      taskDetailId: null,
      taskDetailLoading: false,
      taskDetailError: null,
      toasts: [],
    });
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>,
    );
  }

  it("«/my-tasks» y «/mis-tareas» redirigen al filtro, no a una vista aparte", async () => {
    mockFetch([
      ...viewRoutes,
      { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
      { path: "/api/runs", body: { runs: [] } },
    ]);

    const { unmount } = renderApp("/my-tasks");
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    // Es el filtro por responsable el que manda: nada de otra persona.
    expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull();
    expect(screen.getByTestId("tareas-chip-responsable")).toBeTruthy();
    unmount();

    renderApp("/mis-tareas");
    await waitFor(() => expect(screen.getByTestId("tareas-chip-responsable")).toBeTruthy());
  });

  it("Tareas es una entrada global y «/» busca dentro de la vista, no en el overlay", async () => {
    mockFetch([
      ...viewRoutes,
      { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
      { path: "/api/runs", body: { runs: [] } },
    ]);

    renderApp("/tareas");
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(within(nav).getByRole("link", { name: "Tareas" }).getAttribute("href")).toBe("/tareas");

    await waitFor(() => expect(screen.getByTestId("tareas-buscar")).toBeTruthy());
    fireEvent.keyDown(window, { key: "/" });
    // El overlay global no se abre encima de la caja que ya está en la vista.
    expect(screen.queryByTestId("task-search")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("tareas-buscar"));
  });
});
