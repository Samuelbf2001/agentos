/**
 * Convertir un rol en agente desde el organigrama: diálogo de alcance,
 * activación y accesos. Se monta la app completa en
 * /proyectos/p1/organigrama, como hace orgchart.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import type { OrgGraph, OrgRoleFull } from "../src/lib/types";
import { agents, makeTask, mockFetch, person, project, type FetchCall } from "./helpers";

const orgProject = { ...project, id: "p1", orgId: "o1" };

const roleVentas: OrgRoleFull = {
  id: "r2",
  orgId: "o1",
  unitId: "u1",
  name: "Jefe de Ventas",
  purpose: null,
  reportsToRoleId: null,
  canvasX: 260,
  canvasY: 170,
  status: "draft",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  agentId: null,
  functions: [
    { id: "f1", roleId: "r2", name: "Prospectar clientes", description: null, position: 0, createdAt: 1, updatedAt: 1 },
    { id: "f2", roleId: "r2", name: "Cerrar ventas", description: null, position: 1, createdAt: 1, updatedAt: 1 },
  ],
  people: [],
  processes: [],
};

const roleConAgente: OrgRoleFull = {
  id: "r4",
  orgId: "o1",
  unitId: "u1",
  name: "Analista de Datos",
  purpose: null,
  reportsToRoleId: null,
  canvasX: 0,
  canvasY: 300,
  status: "draft",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  agentId: "ag-existente",
  functions: [],
  people: [],
  processes: [],
};

const toolCatalog = {
  tools: [
    { name: "tasks.list", description: "Lista tareas del proyecto", read_only: true, external_effect: false, requires_approval: false },
    { name: "knowledge.search", description: "Busca en la wiki del cliente", read_only: true, external_effect: false, requires_approval: false },
    { name: "tasks.create", description: "Crea una tarea", read_only: false, external_effect: true, requires_approval: true },
    { name: "processes.update", description: "Actualiza un proceso", read_only: false, external_effect: false, requires_approval: false },
  ],
};

function orgGraphWith(roles: OrgRoleFull[]): OrgGraph {
  return {
    units: [{ id: "u1", orgId: "o1", name: "Ventas", parentUnitId: null, description: null, createdAt: 1, updatedAt: 1 }],
    roles,
    processes: [],
    people: [],
  };
}

function baseRoutes(roles: OrgRoleFull[]) {
  return [
    { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
    { path: "/api/runs", body: { runs: [] } },
    { path: "/api/projects", body: { projects: [orgProject] } },
    { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
    { path: /^\/api\/projects\/[^/]+\/launches$/, body: { launches: [] } },
    { path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: "o1", people: [person] } },
    { path: /^\/api\/board\/[^/]+$/, body: { project: orgProject, board_seq: 1, total: 1, columns: { READY: [makeTask()] }, cells: {} } },
    { path: "/api/labels", body: { labels: [] } },
    { path: "/api/tasks", body: { tasks: [] } },
    { path: "/api/auth/people", body: { people: [person] } },
    { path: "/api/brain/overview", body: { generated_at: null, core: { counts: {}, people: [] }, agents: { items: [], tree: null, health: [] }, sources: [], modules: [] } },
    { path: "/api/knowledge", body: { docs: [] } },
    { path: /^\/api\/projects\/[^/]+\/sources$/, body: { sources: [] } },
    { path: "/api/processes", body: { processes: [] } },
    { path: "/api/orgs/o1/graph", body: orgGraphWith(roles) },
    { path: "/api/tools/catalog", body: toolCatalog },
    {
      path: /^\/api\/roles\/[^/]+\/agent$/,
      method: "POST",
      body: ({ body }: { body: unknown }) => {
        const input = body as { function_ids: string[]; autonomy: string; activate: boolean; tools_allowlist: string[]; name?: string };
        const role = roles[0] as OrgRoleFull;
        return {
          agent: {
            id: "ag-new",
            slug: "jefe-de-ventas",
            name: input.name ?? "Agente",
            status: input.activate ? "active" : "paused",
            autonomy: input.autonomy,
          },
          role: { ...role, agentId: "ag-new" },
          prompt_version: 1,
        };
      },
    },
  ];
}

function renderApp(entry: string, roles: OrgRoleFull[], overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({
    person,
    token: "tok",
    bootstrapped: true,
    projects: [orgProject],
    activeProjectId: orgProject.id,
    agents,
    approvals: [],
    reviewTasks: [],
    failedRunsCount: 0,
    board: { projectId: orgProject.id, tasks: {} },
    toasts: [],
    previewRole: null,
    ...overrides,
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
}

function clickNode(testId: string) {
  const node = screen.getByTestId(testId);
  const wrapper = node.closest(".react-flow__node") ?? node;
  fireEvent.click(wrapper);
}

describe("convertir un rol en agente", () => {
  let calls: FetchCall[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("abre el diálogo con las funciones y las herramientas de lectura marcadas", async () => {
    ({ calls } = mockFetch(baseRoutes([roleVentas])));
    renderApp(`/proyectos/${orgProject.id}/organigrama`, [roleVentas]);
    await screen.findByTestId("role-node-r2");
    clickNode("role-node-r2");
    const panel = await screen.findByTestId("role-panel");
    fireEvent.click(within(panel).getByRole("button", { name: "Convertir en agente" }));

    const dialog = await screen.findByTestId("convert-role-dialog");
    expect(within(dialog).getByText("Convertir «Jefe de Ventas» en agente")).toBeTruthy();

    const f1 = within(dialog).getByText("Prospectar clientes").closest("label")?.querySelector("input") as HTMLInputElement;
    const f2 = within(dialog).getByText("Cerrar ventas").closest("label")?.querySelector("input") as HTMLInputElement;
    expect(f1.checked).toBe(true);
    expect(f2.checked).toBe(true);

    await waitFor(() => {
      expect(within(dialog).getByText("tasks.list")).toBeTruthy();
    });
    const readOnly1 = within(dialog).getByText("tasks.list").closest("label")?.querySelector("input") as HTMLInputElement;
    const readOnly2 = within(dialog).getByText("knowledge.search").closest("label")?.querySelector("input") as HTMLInputElement;
    const external = within(dialog).getByText("tasks.create").closest("label")?.querySelector("input") as HTMLInputElement;
    expect(readOnly1.checked).toBe(true);
    expect(readOnly2.checked).toBe(true);
    expect(external.checked).toBe(false);
    expect(within(dialog).getByText("requiere aprobación")).toBeTruthy();
  });

  it("crear agente envía function_ids, autonomy, activate y tools_allowlist; el panel pasa a 'Tiene agente'", async () => {
    ({ calls } = mockFetch(baseRoutes([roleVentas])));
    renderApp(`/proyectos/${orgProject.id}/organigrama`, [roleVentas]);
    await screen.findByTestId("role-node-r2");
    clickNode("role-node-r2");
    const panel = await screen.findByTestId("role-panel");
    fireEvent.click(within(panel).getByRole("button", { name: "Convertir en agente" }));

    const dialog = await screen.findByTestId("convert-role-dialog");
    await waitFor(() => expect(within(dialog).getByText("tasks.list")).toBeTruthy());

    const f2Input = within(dialog).getByText("Cerrar ventas").closest("label")?.querySelector("input") as HTMLInputElement;
    fireEvent.click(f2Input);

    fireEvent.click(within(dialog).getByTestId("convert-role-submit"));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && /\/api\/roles\/r2\/agent$/.test(c.url));
      expect(post).toBeTruthy();
      const body = post?.body as {
        function_ids: string[];
        autonomy: string;
        activate: boolean;
        tools_allowlist: string[];
      };
      expect(body.function_ids).toEqual(["f1"]);
      expect(body.autonomy).toBe("supervised");
      expect(body.activate).toBe(false);
      expect(body.tools_allowlist.sort()).toEqual(["knowledge.search", "tasks.list"]);
    });

    await waitFor(() => {
      expect(within(screen.getByTestId("role-panel")).getByText("Tiene agente")).toBeTruthy();
    });
  });

  it("un rol con agentId muestra 'Tiene agente' y no el botón de convertir", async () => {
    ({ calls } = mockFetch(baseRoutes([roleConAgente])));
    renderApp(`/proyectos/${orgProject.id}/organigrama`, [roleConAgente]);
    await screen.findByTestId("role-node-r4");
    clickNode("role-node-r4");
    const panel = await screen.findByTestId("role-panel");
    expect(within(panel).getByText("Tiene agente")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Convertir en agente" })).toBeNull();
  });

  it("en previsualización de cliente no aparece el botón de convertir", async () => {
    ({ calls } = mockFetch(baseRoutes([roleVentas])));
    renderApp(`/proyectos/${orgProject.id}/organigrama`, [roleVentas], { previewRole: "sponsor" });
    await screen.findByTestId("role-node-r2");
    clickNode("role-node-r2");
    const panel = await screen.findByTestId("role-panel");
    expect(within(panel).queryByRole("button", { name: "Convertir en agente" })).toBeNull();
    expect(within(panel).getByText("Sin agente")).toBeTruthy();
  });
});
