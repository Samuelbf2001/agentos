/**
 * Organigrama del cliente: canvas de roles (React Flow) + panel lateral con
 * funciones, personas y procesos. Se monta la app completa en
 * /proyectos/p1/organigrama, como hacen shell.test.tsx y preview-client.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import App from "../src/App";
import { useStore } from "../src/state/store";
import type { OrgGraph, OrgRoleFull } from "../src/lib/types";
import { agents, makeTask, mockFetch, person, project, type FetchCall } from "./helpers";

const orgProject = { ...project, id: "p1", orgId: "o1" };

const roleDG: OrgRoleFull = {
  id: "r1",
  orgId: "o1",
  unitId: "u1",
  name: "Directora General",
  purpose: null,
  reportsToRoleId: null,
  canvasX: 0,
  canvasY: 0,
  status: "validated",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  agentId: null,
  functions: [],
  people: [{ personId: "pe1", dedicationPct: null }],
  processes: [],
};

const roleVentas: OrgRoleFull = {
  id: "r2",
  orgId: "o1",
  unitId: "u1",
  name: "Jefe de Ventas",
  purpose: null,
  reportsToRoleId: "r1",
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
  processes: [{ processId: "proc1", relation: "participant" }],
};

const roleOps: OrgRoleFull = {
  id: "r3",
  orgId: "o1",
  unitId: "u2",
  name: "Analista de Operaciones",
  purpose: null,
  reportsToRoleId: "r1",
  canvasX: -260,
  canvasY: 170,
  status: "draft",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  agentId: null,
  functions: [],
  people: [{ personId: "pe2", dedicationPct: null }],
  processes: [],
};

const orgGraph: OrgGraph = {
  units: [
    { id: "u1", orgId: "o1", name: "Ventas", parentUnitId: null, description: null, createdAt: 1, updatedAt: 1 },
    { id: "u2", orgId: "o1", name: "Operaciones", parentUnitId: null, description: null, createdAt: 1, updatedAt: 1 },
  ],
  roles: [roleDG, roleVentas, roleOps],
  processes: [{ id: "proc1", name: "Onboarding de clientes", variant: "as_is", status: "draft", ownerPerson: null }],
  people: [
    { id: "pe1", fullName: "Ana Torres", role: "Dirección", isInternal: false },
    { id: "pe2", fullName: "Luis Pérez", role: "Operaciones", isInternal: false },
  ],
};

function baseRoutes() {
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
    { path: "/api/orgs/o1/graph", body: orgGraph },
    {
      path: /^\/api\/roles\/[^/]+\/functions$/,
      method: "PUT",
      body: ({ body }: { body: unknown }) => {
        const functions = (body as { functions: { id?: string; name: string; description?: string | null }[] }).functions;
        return {
          functions: functions.map((f, i) => ({
            id: f.id ?? `f-new-${i}`,
            roleId: "r2",
            name: f.name,
            description: f.description ?? null,
            position: i,
            createdAt: 1,
            updatedAt: 1,
          })),
        };
      },
    },
    {
      path: "/api/orgs/o1/roles",
      method: "POST",
      body: ({ body }: { body: unknown }) => {
        const input = body as { name: string; canvas_x?: number; canvas_y?: number };
        return {
          role: {
            id: "r-new",
            orgId: "o1",
            unitId: null,
            name: input.name,
            purpose: null,
            reportsToRoleId: null,
            canvasX: input.canvas_x ?? null,
            canvasY: input.canvas_y ?? null,
            status: "draft",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
            agentId: null,
            functions: [],
            people: [],
            processes: [],
          },
        };
      },
    },
  ];
}

function renderApp(entry: string, overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
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

describe("organigrama del cliente", () => {
  let calls: FetchCall[] = [];

  beforeEach(() => {
    ({ calls } = mockFetch(baseRoutes()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("pinta 3 nodos con sus nombres y el chip Vacante para el rol sin persona", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`);
    expect(await screen.findByTestId("role-node-r1")).toBeTruthy();
    expect(screen.getByTestId("role-node-r2")).toBeTruthy();
    expect(screen.getByTestId("role-node-r3")).toBeTruthy();
    expect(within(screen.getByTestId("role-node-r1")).getByText("Directora General")).toBeTruthy();
    expect(within(screen.getByTestId("role-node-r2")).getByText("Jefe de Ventas")).toBeTruthy();
    expect(within(screen.getByTestId("role-node-r3")).getByText("Analista de Operaciones")).toBeTruthy();
    expect(within(screen.getByTestId("role-node-r2")).getByText("Vacante")).toBeTruthy();
  });

  it("pinta 2 nodos de área con su nombre y el conteo de roles", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`);
    await screen.findByTestId("role-node-r1");
    const ventas = screen.getByTestId("area-node-u1");
    expect(within(ventas).getByText("Ventas")).toBeTruthy();
    expect(within(ventas).getByText("2 roles")).toBeTruthy();
    const operaciones = screen.getByTestId("area-node-u2");
    expect(within(operaciones).getByText("Operaciones")).toBeTruthy();
    expect(within(operaciones).getByText("1 roles")).toBeTruthy();
  });

  it("pulsar un rol abre el panel con sus funciones y su proceso", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`);
    await screen.findByTestId("role-node-r2");
    clickNode("role-node-r2");
    const panel = await screen.findByTestId("role-panel");
    expect(within(panel).getByDisplayValue("Prospectar clientes")).toBeTruthy();
    expect(within(panel).getByDisplayValue("Cerrar ventas")).toBeTruthy();
    expect(within(panel).getByText("Onboarding de clientes")).toBeTruthy();
  });

  it("'Añadir función' + escribir + blur guarda las 3 funciones", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`);
    await screen.findByTestId("role-node-r2");
    clickNode("role-node-r2");
    const panel = await screen.findByTestId("role-panel");
    fireEvent.click(within(panel).getByText("+ Añadir función"));
    const inputs = within(panel).getAllByPlaceholderText("Nombre de la función");
    expect(inputs).toHaveLength(3);
    const third = inputs[2]!;
    fireEvent.change(third, { target: { value: "Coordinar visitas" } });
    fireEvent.blur(third);

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && /\/api\/roles\/r2\/functions$/.test(c.url));
      expect(put).toBeTruthy();
      const body = put?.body as { functions: { name: string }[] };
      expect(body.functions).toHaveLength(3);
      expect(body.functions[2]?.name).toBe("Coordinar visitas");
    });
  });

  it("'Nuevo rol' crea un rol vía POST /api/orgs/o1/roles", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`);
    await screen.findByTestId("role-node-r1");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo rol" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/orgs/o1/roles"));
      expect(post).toBeTruthy();
    });
  });

  it("en previsualización de cliente no hay edición pero sí nodos y panel de lectura", async () => {
    renderApp(`/proyectos/${orgProject.id}/organigrama`, { previewRole: "sponsor" });
    await screen.findByTestId("role-node-r1");
    expect(screen.queryByRole("button", { name: "Nuevo rol" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nueva área" })).toBeNull();

    clickNode("role-node-r1");
    const panel = await screen.findByTestId("role-panel");
    expect(within(panel).getByDisplayValue("Directora General")).toBeTruthy();
    expect(within(panel).queryByText("+ Añadir función")).toBeNull();
    expect(within(panel).queryByText("Eliminar rol")).toBeNull();
  });
});
