/**
 * Procesos del cliente como flujograma editable: lista + cabecera + React
 * Flow con carriles por responsable. Se monta la app completa en
 * /proyectos/p1/contexto/procesos, como hace orgchart.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import type { OrgGraph, OrgRoleFull, ProcessEntity } from "../src/lib/types";
import { agents, makeTask, mockFetch, person, project, type FetchCall } from "./helpers";

const procProject = { ...project, id: "p1", orgId: "o1" };

function makeRole(overrides: Partial<OrgRoleFull>): OrgRoleFull {
  return {
    id: "r",
    orgId: "o1",
    unitId: null,
    name: "Rol",
    purpose: null,
    reportsToRoleId: null,
    canvasX: null,
    canvasY: null,
    status: "draft",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    agentId: null,
    functions: [],
    people: [],
    processes: [],
    ...overrides,
  };
}

const proc1: ProcessEntity = {
  id: "proc1",
  orgId: "o1",
  name: "Onboarding de clientes",
  ownerPerson: "Directora General",
  variant: "as_is",
  steps: [
    { step: "Recibir solicitud", responsible: "Jefe de Ventas", system: "CRM" },
    { step: "Validar documentos", responsible: "Jefe de Ventas" },
    { step: "Activar cuenta", responsible: "Analista de Operaciones", system: "ERP" },
  ],
  systems: ["CRM", "ERP"],
  painPoints: ["Demora en validación"],
  isoRefs: [],
  sourceDocIds: [],
  status: "draft",
  createdAt: 1,
  updatedAt: 1,
};

const proc2: ProcessEntity = {
  id: "proc2",
  orgId: "o1",
  name: "Facturación",
  ownerPerson: null,
  variant: "to_be",
  steps: [],
  systems: [],
  painPoints: [],
  isoRefs: [],
  sourceDocIds: [],
  status: "validated",
  createdAt: 1,
  updatedAt: 1,
};

const orgGraph: OrgGraph = {
  units: [],
  roles: [
    makeRole({ id: "r1", name: "Directora General", status: "validated" }),
    makeRole({ id: "r2", name: "Jefe de Ventas" }),
    makeRole({ id: "r3", name: "Analista de Operaciones" }),
  ],
  processes: [],
  people: [],
};

function applyWireBody(base: ProcessEntity, body: Record<string, unknown>): ProcessEntity {
  return {
    ...base,
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.variant !== undefined ? { variant: body.variant as ProcessEntity["variant"] } : {}),
    ...(body.owner_person !== undefined ? { ownerPerson: body.owner_person as string | null } : {}),
    ...(body.steps !== undefined ? { steps: body.steps as ProcessEntity["steps"] } : {}),
    ...(body.systems !== undefined ? { systems: body.systems as string[] } : {}),
    ...(body.pain_points !== undefined ? { painPoints: body.pain_points as string[] } : {}),
    ...(body.iso_refs !== undefined ? { isoRefs: body.iso_refs as string[] } : {}),
    ...(body.status !== undefined ? { status: body.status as ProcessEntity["status"] } : {}),
  };
}

function baseRoutes() {
  return [
    { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
    { path: "/api/runs", body: { runs: [] } },
    { path: "/api/projects", body: { projects: [procProject] } },
    { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
    { path: /^\/api\/projects\/[^/]+\/launches$/, body: { launches: [] } },
    { path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: "o1", people: [person] } },
    { path: /^\/api\/board\/[^/]+$/, body: { project: procProject, board_seq: 1, total: 1, columns: { READY: [makeTask()] }, cells: {} } },
    { path: "/api/labels", body: { labels: [] } },
    { path: "/api/tasks", body: { tasks: [] } },
    { path: "/api/auth/people", body: { people: [person] } },
    { path: "/api/brain/overview", body: { generated_at: null, core: { counts: {}, people: [] }, agents: { items: [], tree: null, health: [] }, sources: [], modules: [] } },
    { path: "/api/knowledge", body: { docs: [] } },
    { path: /^\/api\/projects\/[^/]+\/sources$/, body: { sources: [] } },
    { path: "/api/processes", body: { processes: [proc1, proc2] } },
    { path: "/api/orgs/o1/graph", body: orgGraph },
    {
      path: "/api/orgs/o1/processes",
      method: "POST",
      body: ({ body }: { body: unknown }) => {
        const input = body as { name: string; steps?: ProcessEntity["steps"] };
        return {
          process: {
            id: "proc-new",
            orgId: "o1",
            name: input.name,
            ownerPerson: null,
            variant: "as_is",
            steps: input.steps ?? [],
            systems: [],
            painPoints: [],
            isoRefs: [],
            sourceDocIds: [],
            status: "draft",
            createdAt: 1,
            updatedAt: 1,
          },
        };
      },
    },
    {
      path: /^\/api\/processes\/[^/]+$/,
      method: "PATCH",
      body: ({ body, url }: { body: unknown; url: string }) => {
        const id = url.match(/\/api\/processes\/([^/?]+)/)?.[1];
        const base = id === "proc2" ? proc2 : proc1;
        return { process: applyWireBody(base, body as Record<string, unknown>) };
      },
    },
  ];
}

function renderApp(entry: string, overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({
    person,
    token: "tok",
    bootstrapped: true,
    projects: [procProject],
    activeProjectId: procProject.id,
    agents,
    approvals: [],
    reviewTasks: [],
    failedRunsCount: 0,
    board: { projectId: procProject.id, tasks: {} },
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

function clickStep(index: number) {
  const node = screen.getByTestId(`step-node-${index}`);
  const wrapper = node.closest(".react-flow__node") ?? node;
  fireEvent.click(wrapper);
}

describe("procesos del cliente", () => {
  let calls: FetchCall[] = [];

  beforeEach(() => {
    ({ calls } = mockFetch(baseRoutes()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("pinta la lista con 2 procesos, el primero seleccionado, y el flujograma con 3 pasos y 2 carriles", async () => {
    renderApp(`/proyectos/${procProject.id}/contexto/procesos`);
    expect(await screen.findByText("Onboarding de clientes")).toBeTruthy();
    expect(screen.getByText("Facturación")).toBeTruthy();
    expect(await screen.findByTestId("step-node-0")).toBeTruthy();
    expect(screen.getByTestId("step-node-1")).toBeTruthy();
    expect(screen.getByTestId("step-node-2")).toBeTruthy();
    expect(screen.getByTestId("lane-node-0")).toBeTruthy();
    expect(screen.getByTestId("lane-node-1")).toBeTruthy();
  });

  it("pulsar un paso abre el panel con su texto y su responsable", async () => {
    renderApp(`/proyectos/${procProject.id}/contexto/procesos`);
    await screen.findByTestId("step-node-0");
    clickStep(0);
    const panel = await screen.findByTestId("step-panel");
    expect(within(panel).getByDisplayValue("Recibir solicitud")).toBeTruthy();
    expect(within(panel).getByDisplayValue("Jefe de Ventas")).toBeTruthy();
  });

  it("editar el texto del paso y salir del campo llama PATCH /api/processes/:id con los 3 pasos", async () => {
    renderApp(`/proyectos/${procProject.id}/contexto/procesos`);
    await screen.findByTestId("step-node-0");
    clickStep(0);
    const panel = await screen.findByTestId("step-panel");
    const textarea = within(panel).getByDisplayValue("Recibir solicitud");
    fireEvent.change(textarea, { target: { value: "Recibir solicitud por WhatsApp" } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && /\/api\/processes\/proc1$/.test(c.url));
      expect(patch).toBeTruthy();
      const body = patch?.body as { steps: { step: string }[] };
      expect(body.steps).toHaveLength(3);
      expect(body.steps[0]?.step).toBe("Recibir solicitud por WhatsApp");
    });
  });

  it("'Nuevo proceso' crea un proceso vía POST /api/orgs/o1/processes", async () => {
    renderApp(`/proyectos/${procProject.id}/contexto/procesos`);
    await screen.findByText("Onboarding de clientes");
    fireEvent.click(screen.getByRole("button", { name: "Nuevo proceso" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/orgs/o1/processes"));
      expect(post).toBeTruthy();
    });
  });

  it("en previsualización de cliente no hay botones de edición pero sí el flujograma", async () => {
    renderApp(`/proyectos/${procProject.id}/contexto/procesos`, { previewRole: "sponsor" });
    await screen.findByTestId("step-node-0");
    expect(screen.queryByRole("button", { name: "Nuevo proceso" })).toBeNull();
  });
});
