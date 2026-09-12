/**
 * La base transversal de tareas (PLAN-v1.5 §Navegación nueva, entrada Tareas).
 *
 * Lo que se prueba es exactamente la promesa del producto: una sola base que
 * cruza clientes y proyectos, filtros que se combinan entre sí, orden por
 * columna, "Mis tareas" como filtro y no como pantalla, y creación rápida sin
 * salir de la vista.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../src/App";
import TareasView from "../src/views/TareasView";
import { useStore } from "../src/state/store";
import {
  FILTROS_VACIOS,
  YO,
  agrupar,
  chipsActivos,
  clienteLabel,
  extractoDescripcion,
  filtrar,
  filtrosAParams,
  insertarEnCursor,
  ordenar,
  parseFiltros,
  parseVista,
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
import { TASK_STATUSES, type Project, type TaskStatus } from "../src/lib/types";

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
  it("el nombre real del cliente sale de orgName, y sólo sin él se deduce", () => {
    // (1) `orgName` de `/api/projects` manda sobre todo lo demás: es lo único
    // que tienen las tareas importadas de Notion.
    expect(
      clienteLabel("org-1", { projects: [{ ...project, orgName: "ACME S.A." }] }),
    ).toBe("ACME S.A.");
    // Basta con que UN proyecto de esa organización lo traiga.
    expect(
      clienteLabel("org-1", {
        projects: [
          { ...project, id: "a", orgName: null },
          { ...project, id: "b", orgName: "ACME S.A." },
        ],
      }),
    ).toBe("ACME S.A.");
    // (4) Sin orgName ni proyectos legibles, el id: nunca un nombre inventado.
    expect(clienteLabel("01a074aa-bb", { projects: [] })).toBe("Cliente 01a074");
    expect(
      clienteLabel("01a074aa-bb", {
        projects: [
          { ...project, id: "a", orgId: "01a074aa-bb", name: "X" },
          { ...project, id: "b", orgId: "01a074aa-bb", name: "Y" },
        ],
      }),
    ).toBe("Cliente 01a074");
  });

  it("sin orgName se deduce del recibo o de los proyectos", () => {
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

  it("el tablero es el modo por defecto y sólo la tabla viaja en la query", () => {
    expect(parseVista(new URLSearchParams(""))).toBe("tablero");
    expect(parseVista(new URLSearchParams("vista=tabla"))).toBe("tabla");
    // Un valor inventado no rompe la vista: vuelve al default.
    expect(parseVista(new URLSearchParams("vista=grafo"))).toBe("tablero");
    expect(filtrosAParams(FILTROS_VACIOS, { vista: "tablero" }).toString()).toBe("");
    expect(filtrosAParams(FILTROS_VACIOS, { vista: "tabla" }).get("vista")).toBe("tabla");
  });
});

// ── Texto de la tarjeta y escritura en el cursor (puros) ────────────────────

describe("extractoDescripcion (puro)", () => {
  it("deja prosa: sin imágenes, sin sintaxis y con el texto de los enlaces", () => {
    const markdown = [
      "## Objetivo",
      "",
      "Mapear el **proceso** de cobranza con [el brief](https://x.test/brief).",
      "",
      "![Diagrama](https://img.test/a.png)",
      "",
      "- primer paso",
    ].join("\n");
    const extracto = extractoDescripcion(markdown);
    expect(extracto).toBe("Objetivo Mapear el proceso de cobranza con el brief. primer paso");
    expect(extracto).not.toContain("![");
    expect(extracto).not.toContain("https://");
  });

  it("recorta con puntos suspensivos y aguanta vacío o nulo", () => {
    expect(extractoDescripcion(null)).toBe("");
    expect(extractoDescripcion("")).toBe("");
    const largo = extractoDescripcion("palabra ".repeat(60), 40);
    expect(largo.length).toBeLessThanOrEqual(41);
    expect(largo.endsWith("…")).toBe(true);
  });

  it("tira los bloques de código enteros: en dos líneas no cabe un programa", () => {
    expect(extractoDescripcion("Antes\n\n```js\nconst a = 1;\n```\n\nDespués")).toBe("Antes Después");
  });
});

describe("insertarEnCursor (puro)", () => {
  it("escribe en la posición y devuelve dónde queda el cursor", () => {
    const { value, cursor } = insertarEnCursor("hola", 4, "X");
    expect(value).toBe("hola\n\nX");
    expect(cursor).toBe(value.length);
  });

  it("separa con líneas en blanco cuando cae pegado a otro contenido", () => {
    const { value, cursor } = insertarEnCursor("uno\ndos", 3, "![a](u)");
    expect(value).toBe("uno\n\n![a](u)\ndos");
    expect(value.slice(0, cursor).endsWith("![a](u)")).toBe(true);
  });

  it("acota una posición imposible en vez de romper el texto", () => {
    expect(insertarEnCursor("abc", 99, "Z").value).toBe("abc\n\nZ");
    expect(insertarEnCursor("abc", -5, "Z").value).toBe("Z\n\nabc");
  });
});

// ── La vista ────────────────────────────────────────────────────────────────

type Wire = { method: string; body: unknown; url: string };

/**
 * Los proyectos tal como los sirve `GET /api/projects`: con `orgName`, el
 * nombre real de la organización. Es lo único que tienen los 1232 registros
 * importados de Notion, que nunca pasaron por un launch.
 */
const projectConOrg: Project = { ...project, orgName: "ACME S.A." };
const projectBConOrg: Project = { ...projectB, orgName: "Delta Logística" };

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
  { path: "/api/projects", body: { projects: [projectConOrg, projectBConOrg] } },
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

/** Deja ver la query real: el modo de vista y los filtros viven en la URL. */
function Ubicacion() {
  const location = useLocation();
  return <span data-testid="ubicacion">{location.search}</span>;
}

/**
 * La vista arranca en TABLERO desde el rediseño; los tests de la tabla piden
 * la tabla en la URL, igual que hace un humano al pulsar el conmutador.
 */
function renderTareas(entry = "/tareas?vista=tabla") {
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
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TareasView />
      <Ubicacion />
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

  it("«Tablero» es un modo de esta base, no un enlace al tablero de un proyecto", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    // El conmutador es un botón de la propia vista: Tareas sigue siendo
    // transversal y no manda a nadie al tablero de un proyecto concreto.
    expect(screen.getByTestId("tareas-vista-tablero").tagName).toBe("BUTTON");
    expect(screen.queryByRole("link", { name: "Tablero" })).toBeNull();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((href) => /\/proyectos\/[^/]+\/tablero/.test(href))).toBe(false);
  });

  it("no pide un recibo de launch por proyecto: el nombre del cliente viene con los proyectos", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    // 34 proyectos en producción eran 34 peticiones al montar para nada: los
    // proyectos importados de Notion no tienen recibo.
    expect(calls.some((c) => c.url.includes("/launches"))).toBe(false);
    // Y el nombre real (orgName) se ve como cabecera del grupo de cliente.
    const grupo = await screen.findByTestId("tareas-grupo-org-1");
    expect(within(grupo).getByRole("heading", { level: 2 }).textContent).toContain("ACME S.A.");
  });

  it("cruza dos filtros y deja los chips visibles y borrables", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    // Los selects viven en el panel plegable: hay que abrirlo primero.
    fireEvent.click(screen.getByTestId("tareas-filtros-toggle"));
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
    // Sin agrupar: el orden de columna se ve en la lista entera, no partido
    // en cabeceras de grupo (que además repetirían el testid del botón).
    renderTareas("/tareas?agrupar=ninguna&vista=tabla");
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

  it("por defecto agrupa por cliente: el nombre del cliente aparece como cabecera de grupo", async () => {
    renderTareas();
    const grupoAcme = await screen.findByTestId("tareas-grupo-org-1");
    const grupoBeta = await screen.findByTestId("tareas-grupo-org-2");
    // El label real puede tardar (llega del recibo de launch, async); lo que
    // importa aquí es que cada grupo tiene una cabecera con el nombre del
    // cliente, no que ya haya resuelto ese nombre real.
    expect(within(grupoAcme).getByRole("heading", { level: 2 }).textContent?.trim()).toBeTruthy();
    expect(within(grupoBeta).getByRole("heading", { level: 2 }).textContent?.trim()).toBeTruthy();
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
    renderTareas("/tareas?responsable=yo&vista=tabla");
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull();
    expect(screen.getByTestId("tareas-chip-responsable").textContent).toContain("Yo");
  });

  it("«Nueva tarea» abre el modal, deja elegir proyecto y crea", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tareas-nueva"));

    const dialog = await screen.findByTestId("create-task-dialog");
    // El proyecto de partida trae su cliente puesto; para irse a otro cliente
    // se cambia el cliente primero, que es justo lo que filtra los proyectos.
    fireEvent.change(within(dialog).getByTestId("new-task-client"), {
      target: { value: projectBConOrg.orgId },
    });
    fireEvent.change(within(dialog).getByTestId("new-task-project"), {
      target: { value: projectB.id },
    });
    fireEvent.change(within(dialog).getByTestId("new-task-title"), {
      target: { value: "Llamar al sponsor" },
    });
    fireEvent.click(within(dialog).getByTestId("new-task-submit"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/tasks"));
      expect(post).toBeTruthy();
      expect(post!.body).toMatchObject({
        project_id: projectB.id,
        title: "Llamar al sponsor",
        // La etapa acompaña al proyecto elegido, no a la del proyecto de partida.
        stage: projectB.stage,
      });
    });
    // El proyecto elegido se recuerda para la próxima alta.
    expect(localStorage.getItem("agentos_tareas_ultimo_proyecto")).toBe(projectB.id);
  });

  it("la tecla n abre el alta sin tocar el ratón", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    expect(screen.queryByTestId("create-task-dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "n" });
    expect(await screen.findByTestId("create-task-dialog")).toBeTruthy();
  });

  it("el cliente filtra los proyectos que ofrece el alta", async () => {
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tareas-nueva"));
    const dialog = await screen.findByTestId("create-task-dialog");
    const proyecto = within(dialog).getByTestId("new-task-project") as HTMLSelectElement;
    const opciones = () => [...proyecto.querySelectorAll("option")].map((o) => o.value);
    // El proyecto de partida trae su cliente puesto: sólo se ven los suyos.
    expect(opciones()).toContain(project.id);
    expect(opciones()).not.toContain(projectB.id);

    // "Todos los clientes" devuelve la base entera, agrupada por cliente.
    fireEvent.change(within(dialog).getByTestId("new-task-client"), { target: { value: "" } });
    expect(opciones()).toContain(projectB.id);
    expect([...proyecto.querySelectorAll("optgroup")].map((g) => g.label)).toContain("ACME S.A.");

    // Y elegir el otro cliente recorta a sus proyectos.
    fireEvent.change(within(dialog).getByTestId("new-task-client"), {
      target: { value: projectBConOrg.orgId },
    });
    expect(opciones()).toContain(projectB.id);
    expect(opciones()).not.toContain(project.id);
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
    fireEvent.click(screen.getByTestId("tareas-filtros-toggle"));
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

// ── Modo tablero ────────────────────────────────────────────────────────────

/**
 * jsdom no mide nada: todos los rectángulos son 0×0 en (0,0), así que dnd-kit
 * no puede decidir sobre qué columna se soltó. Se le dan medidas sintéticas
 * —una fila de columnas de 260 px separadas 300— derivadas del data-testid, y
 * con eso la detección de colisión resuelve igual que en el navegador.
 */
const ANCHO_COLUMNA = 300;

function medirColumnas(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const columna = this.closest?.("[data-testid^='tareas-columna-']");
    if (!columna) return original.call(this);
    const status = columna.getAttribute("data-testid")!.replace("tareas-columna-", "");
    const indice = TASK_STATUSES.indexOf(status as TaskStatus);
    // La tarjeta es un rectángulo pequeño dentro de su columna; la columna, la
    // caja alta sobre la que se suelta.
    const tarjeta = this !== columna;
    const left = indice * ANCHO_COLUMNA + (tarjeta ? 10 : 0);
    const width = tarjeta ? 240 : 260;
    const height = tarjeta ? 60 : 400;
    const top = tarjeta ? 10 : 0;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Arrastra una tarjeta desde su columna hasta la columna destino. */
async function arrastrar(card: HTMLElement, desde: TaskStatus, hasta: TaskStatus): Promise<void> {
  const delta = (TASK_STATUSES.indexOf(hasta) - TASK_STATUSES.indexOf(desde)) * ANCHO_COLUMNA;
  const x0 = TASK_STATUSES.indexOf(desde) * ANCHO_COLUMNA + 130;
  const y0 = 40;
  fireEvent.pointerDown(card, { button: 0, isPrimary: true, clientX: x0, clientY: y0 });
  // El primer movimiento supera el umbral de 6 px y arranca el arrastre; el
  // segundo llega cuando dnd-kit ya midió las columnas y decide el destino.
  fireEvent.pointerMove(document, { clientX: x0 + delta, clientY: y0 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.pointerMove(document, { clientX: x0 + delta, clientY: y0 + 1 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.pointerUp(document, { clientX: x0 + delta, clientY: y0 + 1 });
}

describe("TareasView (tablero)", () => {
  let calls: FetchCall[];
  let restaurarMedidas: () => void;

  beforeEach(() => {
    calls = mockFetch(viewRoutes).calls;
    restaurarMedidas = medirColumnas();
  });
  afterEach(() => {
    restaurarMedidas();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("el tablero es el modo por defecto y la tabla es la que deja rastro en la URL", async () => {
    const { unmount } = renderTareas("/tareas");
    // Sin el parámetro vista en la query se abre el TABLERO.
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());
    expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull();
    expect(screen.getByTestId("tareas-vista-tablero").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("tareas-vista-tabla"));
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());
    // La tabla se va: son dos modos de la misma base, no dos listas a la vez.
    expect(screen.queryByTestId("tareas-tablero")).toBeNull();
    expect(screen.getByTestId("ubicacion").textContent).toContain("vista=tabla");
    unmount();

    // El mismo enlace, abierto de cero: arranca en tabla.
    renderTareas("/tareas?vista=tabla");
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    // Y volver al tablero limpia la URL: el tablero es el default.
    fireEvent.click(screen.getByTestId("tareas-vista-tablero"));
    await waitFor(() => expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy")).toBeTruthy());
    expect(screen.getByTestId("ubicacion").textContent).not.toContain("vista=");
  });

  it("el «+» de una columna abre el alta con ese estado inicial", async () => {
    renderTareas("/tareas");
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tareas-nueva-en-READY"));
    const dialog = await screen.findByTestId("create-task-dialog");
    expect((within(dialog).getByTestId("new-task-status") as HTMLSelectElement).value).toBe("READY");
  });

  it("hay una columna por estado, con su conteo, y las tarjetas respetan el filtro", async () => {
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());

    // Las siete columnas de la máquina de estados, en su orden.
    const columnas = [...document.querySelectorAll("[data-testid^='tareas-columna-']")].map((el) =>
      el.getAttribute("data-testid")!.replace("tareas-columna-", ""),
    );
    expect(columnas).toEqual(TASK_STATUSES);

    const conteo = (status: TaskStatus) => screen.getByTestId(`tareas-conteo-${status}`).textContent;
    expect(conteo("BACKLOG")).toBe("1");
    expect(conteo("READY")).toBe("2");
    expect(conteo("IN_PROGRESS")).toBe("1");
    expect(conteo("REVIEW")).toBe("0");
    // La cerrada no está: el tablero filtra lo mismo que la tabla.
    expect(conteo("DONE")).toBe("0");
    expect(screen.queryByTestId("tarea-tarjeta-t-beta-cerrada")).toBeNull();

    // Cada tarjeta dice de quién es el trabajo, con el nombre real del cliente.
    const tarjeta = screen.getByTestId("tarea-tarjeta-t-acme-hoy");
    expect(tarjeta.textContent).toContain("Zanjar el mapa SIPOC");
    expect(tarjeta.textContent).toContain("ACME S.A.");
    expect(tarjeta.textContent).toContain(project.name);
    // Los responsables van como avatares apilados: el nombre está en el título
    // del grupo, no repetido en el texto de la tarjeta.
    expect(within(tarjeta).getAllByTitle(/Jorge/).length).toBeGreaterThan(0);

    // "Mis tareas" recorta el tablero igual que recorta la tabla.
    fireEvent.click(screen.getByTestId("tareas-mias"));
    await waitFor(() => expect(conteo("READY")).toBe("1"));
    expect(screen.queryByTestId("tarea-tarjeta-t-acme-hoy")).toBeNull();
    expect(screen.getByTestId("tarea-tarjeta-t-beta-semana")).toBeTruthy();
    expect(conteo("IN_PROGRESS")).toBe("1");
    expect(conteo("BACKLOG")).toBe("0");
  });

  it("en tablero el selector «Agrupar» se deshabilita y dice por qué", async () => {
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());
    const agrupar = screen.getByTestId("tareas-agrupar") as HTMLSelectElement;
    expect(agrupar.disabled).toBe(true);
    expect(screen.getByTestId("tareas-agrupar-nota").textContent).toContain("agrupa por estado");
    expect(agrupar.getAttribute("aria-describedby")).toBe("tareas-agrupar-nota");
  });

  it("el tablero también capa el render y «Mostrar más» reparte el resto (I2)", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      makeTask({ id: `t-many-${i}`, projectId: project.id, title: `Tarea generada ${i}`, status: "READY" }),
    );
    mockFetch([{ method: "GET", path: "/api/tasks", body: { tasks: many } }, ...viewRoutes]);
    renderTareas("/tareas?vista=tablero");

    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());
    expect(screen.getAllByTestId(/^tarea-tarjeta-/).length).toBe(200);
    expect(screen.getByTestId("tareas-conteo-READY").textContent).toBe("200");
    const bar = screen.getByTestId("tareas-mostrar-mas");
    expect(bar.textContent).toContain("Mostrando 200 de 250");

    fireEvent.click(within(bar).getByText("Mostrar más"));
    await waitFor(() => expect(screen.getAllByTestId(/^tarea-tarjeta-/).length).toBe(250));
  });

  it("arrastrar una tarjeta a otra columna manda el move con su expected_version", async () => {
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy")).toBeTruthy());

    await arrastrar(screen.getByTestId("tarea-tarjeta-t-acme-hoy"), "READY", "IN_PROGRESS");

    await waitFor(() => {
      const move = calls.find(
        (c) => c.method === "POST" && c.url.includes("/api/tasks/t-acme-hoy/move"),
      );
      expect(move).toBeTruthy();
      expect(move!.body).toMatchObject({ to: "IN_PROGRESS", expected_version: 3 });
    });
    // Y la tarjeta se queda en su columna nueva.
    await waitFor(() =>
      expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy").getAttribute("data-status")).toBe(
        "IN_PROGRESS",
      ),
    );
  });

  it("si el motor rechaza el arrastre, la tarjeta vuelve a su columna y se dice por qué", async () => {
    calls = mockFetch([
      {
        method: "POST",
        path: "/api/tasks/t-acme-hoy/move",
        status: 409,
        body: { error: { code: "version_conflict", message: "La tarea cambió de versión" } },
      },
      ...viewRoutes,
    ]).calls;
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy")).toBeTruthy());

    await arrastrar(screen.getByTestId("tarea-tarjeta-t-acme-hoy"), "READY", "IN_PROGRESS");

    await waitFor(() =>
      expect(
        useStore
          .getState()
          .toasts.some((t) => t.kind === "error" && t.text.includes("La tarea cambió de versión")),
      ).toBe(true),
    );
    expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy").getAttribute("data-status")).toBe("READY");
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
    // La redirección lleva a la vista en su modo por defecto: el tablero.
    await waitFor(() => expect(screen.getByTestId("tarea-tarjeta-t-acme-vencida")).toBeTruthy());
    // Es el filtro por responsable el que manda: nada de otra persona.
    expect(screen.queryByTestId("tarea-tarjeta-t-acme-hoy")).toBeNull();
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

// ── El filtro por defecto deja de ser invisible ──────────────────────────────

/**
 * En producción el filtro por defecto esconde 1005 de 1232 tareas sin decirlo:
 * el humano mira la vista y concluye que "le faltan tareas". Aquí la misma
 * situación en pequeño —terminadas repartidas entre los dos clientes— para
 * poder comprobar que el número que se anuncia es el correcto y que respeta
 * los demás filtros.
 */
function baseConCerradas() {
  return [
    ...base(),
    makeTask({
      id: "t-acme-cerrada",
      projectId: project.id,
      title: "Acta del kick-off firmada",
      status: "DONE",
      dueAt: null,
    }),
    makeTask({
      id: "t-acme-cancelada",
      projectId: project.id,
      title: "Taller que no se hizo",
      status: "CANCELLED",
      dueAt: null,
    }),
  ];
}

/** Las rutas de la vista, pero con esa base más ancha. */
function rutasConCerradas() {
  return [{ method: "GET", path: "/api/tasks", body: { tasks: baseConCerradas() } }, ...viewRoutes];
}

describe("TareasView (las terminadas ocultas se anuncian)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("dice cuántas terminadas está escondiendo, y el número las muestra y las vuelve a esconder", async () => {
    mockFetch(rutasConCerradas());
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());

    // Cuatro pendientes a la vista; tres terminadas escondidas y contadas.
    expect(screen.getByTestId("tareas-contador").textContent).toContain("4 tareas");
    const aviso = screen.getByTestId("tareas-cerradas-ocultas");
    expect(aviso.textContent).toBe("3 terminadas ocultas");
    expect(screen.queryByTestId("tarea-fila-t-acme-cerrada")).toBeNull();

    // El número es el botón: un clic y están.
    fireEvent.click(aviso);
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-cerrada")).toBeTruthy());
    expect(screen.getByTestId("tarea-fila-t-acme-cancelada")).toBeTruthy();
    expect(screen.getByTestId("tarea-fila-t-beta-cerrada")).toBeTruthy();
    expect(screen.getByTestId("tareas-contador").textContent).toContain("7 tareas");
    expect(screen.getByTestId("ubicacion").textContent).toContain("cerradas=1");
    expect(screen.queryByTestId("tareas-cerradas-ocultas")).toBeNull();

    // Y al revés: el mismo sitio las vuelve a esconder.
    const incluidas = screen.getByTestId("tareas-cerradas-incluidas");
    expect(incluidas.textContent).toBe("3 terminadas incluidas");
    fireEvent.click(incluidas);
    await waitFor(() => expect(screen.queryByTestId("tarea-fila-t-acme-cerrada")).toBeNull());
    expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("3 terminadas ocultas");
    expect(screen.getByTestId("ubicacion").textContent).not.toContain("cerradas=1");
  });

  it("el número de ocultas cuenta sobre la base ya filtrada, no sobre el total", async () => {
    mockFetch(rutasConCerradas());
    // ACME tiene dos de las tres terminadas; con su filtro puesto, el aviso
    // tiene que hablar de ESE cliente y no de la base entera.
    renderTareas(`/tareas?cliente=${project.orgId}&vista=tabla`);
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());

    expect(screen.getByTestId("tareas-contador").textContent).toContain("2 tareas");
    expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("2 terminadas ocultas");

    // El texto también recorta: sólo una de las dos terminadas de ACME es un acta.
    fireEvent.change(screen.getByTestId("tareas-buscar"), { target: { value: "acta" } });
    await waitFor(() =>
      expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("1 terminadas ocultas"),
    );

    // Y con el otro cliente, la única terminada suya.
    fireEvent.change(screen.getByTestId("tareas-buscar"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("tareas-filtro-cliente"), {
      target: { value: projectB.orgId },
    });
    await waitFor(() =>
      expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("1 terminadas ocultas"),
    );
  });

  it("en tablero avisa igual y el número reparte las terminadas por columna", async () => {
    mockFetch(rutasConCerradas());
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());

    expect(screen.getByTestId("tareas-contador").textContent).toContain("4 tareas");
    expect(screen.getByTestId("tareas-cerradas-ocultas").textContent).toBe("3 terminadas ocultas");
    expect(screen.getByTestId("tareas-conteo-DONE").textContent).toBe("0");
    expect(screen.getByTestId("tareas-conteo-CANCELLED").textContent).toBe("0");

    fireEvent.click(screen.getByTestId("tareas-cerradas-ocultas"));
    await waitFor(() => expect(screen.getByTestId("tareas-conteo-DONE").textContent).toBe("2"));
    expect(screen.getByTestId("tareas-conteo-CANCELLED").textContent).toBe("1");
    expect(screen.getByTestId("tarea-tarjeta-t-acme-cerrada")).toBeTruthy();
    // Y sigue siendo el tablero: no se ha cambiado de modo por el camino. El
    // tablero es el default, así que su rastro es la AUSENCIA del parámetro.
    expect(screen.getByTestId("ubicacion").textContent).not.toContain("vista=tabla");
    expect(screen.getByTestId("tareas-tablero")).toBeTruthy();
  });
});

// ── Filtros rápidos: responsable, cliente y vencimiento en la barra ──────────

describe("TareasView (filtros rápidos en la barra)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("están a la mano, sin desplegar el panel, y escriben la misma query que el panel", async () => {
    mockFetch(viewRoutes);
    renderTareas();
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-hoy")).toBeTruthy());

    // No hace falta abrir nada: el panel sigue cerrado.
    expect(screen.queryByTestId("tareas-filtros-panel")).toBeNull();
    for (const testid of [
      "tareas-filtro-responsable",
      "tareas-filtro-cliente",
      "tareas-filtro-vencimiento",
    ]) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }

    // Cliente: filtra la lista y deja en la URL exactamente lo que escribiría
    // `filtrosAParams` para ese mismo filtro. Es el mismo filtro, no otro.
    fireEvent.change(screen.getByTestId("tareas-filtro-cliente"), {
      target: { value: projectB.orgId },
    });
    await waitFor(() => expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull());
    expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy();
    expect(screen.getByTestId("ubicacion").textContent).toBe(
      `?${filtrosAParams({ ...FILTROS_VACIOS, cliente: projectB.orgId }, { vista: "tabla" }).toString()}`,
    );

    // Responsable: se combina con el anterior, no lo reemplaza.
    fireEvent.change(screen.getByTestId("tareas-filtro-responsable"), { target: { value: YO } });
    await waitFor(() => expect(screen.queryByTestId("tarea-fila-t-beta-sin-fecha")).toBeNull());
    expect(screen.getByTestId("tarea-fila-t-beta-semana")).toBeTruthy();
    expect(screen.getByTestId("ubicacion").textContent).toBe(
      `?${filtrosAParams({
        ...FILTROS_VACIOS,
        cliente: projectB.orgId,
        responsable: YO,
      }, { vista: "tabla" }).toString()}`,
    );

    // Vencimiento: los mismos cortes de siempre.
    fireEvent.change(screen.getByTestId("tareas-filtro-vencimiento"), {
      target: { value: "sin-fecha" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("ubicacion").textContent).toBe(
        `?${filtrosAParams({
          ...FILTROS_VACIOS,
          cliente: projectB.orgId,
          responsable: YO,
          vencimiento: "sin-fecha",
        }, { vista: "tabla" }).toString()}`,
      ),
    );
    expect(screen.queryByTestId("tarea-fila-t-beta-semana")).toBeNull();

    // Y los chips siguen siendo los de siempre: quitar uno vacía su control.
    fireEvent.click(screen.getByTestId("tareas-chip-cliente"));
    await waitFor(() =>
      expect((screen.getByTestId("tareas-filtro-cliente") as HTMLSelectElement).value).toBe(""),
    );
  });

  it("reflejan al montar lo que venga en la URL (enlace compartido)", async () => {
    mockFetch(viewRoutes);
    renderTareas(`/tareas?cliente=${project.orgId}&responsable=yo&vencimiento=vencidas&vista=tabla`);
    await waitFor(() => expect(screen.getByTestId("tarea-fila-t-acme-vencida")).toBeTruthy());

    expect((screen.getByTestId("tareas-filtro-cliente") as HTMLSelectElement).value).toBe(
      project.orgId,
    );
    expect((screen.getByTestId("tareas-filtro-responsable") as HTMLSelectElement).value).toBe(YO);
    expect((screen.getByTestId("tareas-filtro-vencimiento") as HTMLSelectElement).value).toBe(
      "vencidas",
    );
    // Y la lista es la de ese enlace, no la base entera.
    expect(screen.queryByTestId("tarea-fila-t-acme-hoy")).toBeNull();
    expect(screen.queryByTestId("tarea-fila-t-beta-semana")).toBeNull();
  });

  it("en tablero son los mismos tres controles y recortan las columnas", async () => {
    mockFetch(viewRoutes);
    renderTareas("/tareas?vista=tablero");
    await waitFor(() => expect(screen.getByTestId("tareas-tablero")).toBeTruthy());

    fireEvent.change(screen.getByTestId("tareas-filtro-cliente"), {
      target: { value: project.orgId },
    });
    await waitFor(() => expect(screen.queryByTestId("tarea-tarjeta-t-beta-semana")).toBeNull());
    expect(screen.getByTestId("tarea-tarjeta-t-acme-hoy")).toBeTruthy();
    expect(screen.getByTestId("tareas-conteo-READY").textContent).toBe("1");
    expect(screen.getByTestId("tareas-conteo-BACKLOG").textContent).toBe("0");
    // El tablero es el default: no deja rastro, la tabla sí lo dejaría.
    expect(screen.getByTestId("ubicacion").textContent).not.toContain("vista=tabla");
    expect(screen.getByTestId("ubicacion").textContent).toContain(`cliente=${project.orgId}`);
  });
});
