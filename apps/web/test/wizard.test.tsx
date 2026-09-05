/**
 * Wizard "Nuevo proyecto" (CA-M2.1): formulario GENERADO desde la definición
 * del módulo, validación en vivo por preview (missing ⇒ botón deshabilitado y
 * lista de faltantes), resumen desde el plan del preview y Disparar con
 * idempotency_key estable que navega al tablero del proyecto creado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useStore } from "../src/state/store";
import NewProjectWizard from "../src/views/NewProjectWizard";
import { mockFetch, person, project, type FetchCall } from "./helpers";
import type { CadenceProposal, ModuleDetail, ModuleSummary, PreviewResult } from "../src/lib/types";

const moduleSummary: ModuleSummary = {
  slug: "consultoria",
  version: 1,
  name: "Consultoría (Assessment 14 días)",
  phase: "ENTENDER",
  project_type: "assessment",
  status: "active",
  methodology: { slug: "assessment-14d", version: null },
  templates_count: 8,
  blueprint_hash: "hash-1",
};

const moduleDetail: ModuleDetail = {
  ...moduleSummary,
  inputs: [
    { key: "empresa", label: "Nombre de la empresa", type: "text", required: true },
    { key: "alias", label: "Nombre corto del cliente", type: "text", default_from: "empresa" },
    { key: "empleados", label: "Tamaño (número de empleados)", type: "number", required: true, min: 1 },
    { key: "objetivo", label: "Objetivo del engagement", type: "textarea", required: true, max_len: 600 },
    {
      key: "areas",
      label: "Áreas a entrevistar",
      type: "multi_select",
      required: true,
      min_items: 2,
      options: ["direccion", "operaciones", "ventas"],
    },
    { key: "procesos_core", label: "Procesos core a mapear", type: "list_text", min_items: 1 },
    { key: "fecha_objetivo", label: "Fecha objetivo de entrega", type: "date", required: true },
  ],
  toggles: [
    { key: "iso9001", label: "Preparación ISO 9001", default: false, methodology_add: "iso9001-prep" },
  ],
  budget: { phase_usd: 15, per_run_usd: 2, warning_thresholds_pct: [70, 90, 100] },
  project: { name_tpl: "Assessment {{cliente}}", workspace_tpl: "workspaces/assessment-{{cliente}}" },
  body_md: "Assessment de 14 días para pymes industriales.\n\nMás detalle del módulo.",
};

const moduleInfo = {
  id: "pm-1",
  slug: "consultoria",
  version: 1,
  name: moduleSummary.name,
  phase: "ENTENDER",
  projectType: "assessment",
  status: "active",
};

/** Única cadencia propuesta por el módulo fixture (CA-M3.4 — M6a). */
const cadenceProposal: CadenceProposal = {
  key: "reporte_semanal",
  title: "Reporte semanal a ACME",
  description: null,
  activityType: "report",
  role: "orquestador",
  periodDays: 7,
};

/** Preview dinámico: refleja lo que el wizard mandó (como el backend real),
 *  incluida `cadences_confirmed` (M6a): confirmar la cadencia agrega su
 *  primera instancia al plan, igual que hace el backend real. */
function previewFor(body: unknown): PreviewResult {
  const b = body as { inputs?: Record<string, unknown>; cadences_confirmed?: string[] };
  const inputs = (b?.inputs ?? {}) as Record<string, unknown>;
  const confirmed = new Set(b?.cadences_confirmed ?? []);
  const missing: string[] = [];
  if (!inputs["empresa"]) missing.push("empresa");
  if (!inputs["empleados"]) missing.push("empleados");
  if (!inputs["objetivo"]) missing.push("objetivo");
  const areas = inputs["areas"];
  if (!Array.isArray(areas) || areas.length < 2) missing.push("areas");
  if (!inputs["fecha_objetivo"]) missing.push("fecha_objetivo");
  if (missing.length > 0) {
    return {
      ok: false,
      module: moduleInfo,
      missing,
      issues: missing.map((k) => ({ code: "input_required_missing", path: `inputs.${k}` })),
      plan: null,
    };
  }
  const cadenceConfirmed = confirmed.has("reporte_semanal");
  return {
    ok: true,
    module: moduleInfo,
    missing: [],
    issues: [],
    plan: {
      projectName: "Assessment ACME",
      workspacePath: "workspaces/assessment-acme",
      tasks: [
        {
          key: "kickoff",
          templateKey: "kickoff",
          fanOutValue: null,
          title: "Kickoff con ACME",
          description: null,
          definitionOfDone: "Minuta publicada",
          stage: "ENTENDER",
          activityType: "meeting",
          priority: "high",
          role: "orquestador",
          assigneeAgentSlug: "alex",
          assigneeAgentId: "a-alex",
          dependsOn: [],
          produces: [],
          gate: null,
          requiresApproval: false,
          status: "READY",
          dueAt: Date.parse("2026-09-01T00:00:00Z"),
        },
        {
          key: "entrevista:direccion",
          templateKey: "entrevista",
          fanOutValue: "direccion",
          title: "Entrevista a direccion",
          description: null,
          definitionOfDone: "Notas en el Context Hub",
          stage: "ENTENDER",
          activityType: "interview",
          priority: "normal",
          role: "diagnostico",
          assigneeAgentSlug: "sam",
          assigneeAgentId: "a-sam",
          dependsOn: ["kickoff"],
          produces: ["interview"],
          gate: null,
          requiresApproval: false,
          status: "BACKLOG",
          dueAt: null,
        },
        ...(cadenceConfirmed
          ? [
              {
                key: "reporte_semanal#1",
                templateKey: "reporte_semanal",
                fanOutValue: null,
                title: "Reporte semanal a ACME",
                description: null,
                definitionOfDone: null,
                stage: "ENTENDER",
                activityType: "report",
                priority: "normal",
                role: "orquestador",
                assigneeAgentSlug: "alex",
                assigneeAgentId: "a-alex",
                dependsOn: [],
                produces: [],
                gate: null,
                requiresApproval: false,
                status: "READY" as const,
                dueAt: Date.parse("2026-09-08T00:00:00Z"),
              },
            ]
          : []),
      ],
      gates: [
        { name: "cierre_entender", when: "phase_close", fedBy: ["informe"], blocksNextStage: "CONSTRUIR" },
      ],
      deliverables: [
        { kind: "resumen_ejecutivo", source: "knowledge_doc", min: 1, producedBy: "informe" },
      ],
      methodology: { slug: "assessment-14d", version: null, adds: [] },
      budget: { phaseUsd: 15, perRunUsd: 2, warningThresholdsPct: [70, 90, 100] },
      toggles: { iso9001: false },
      cadenceExcluded: cadenceConfirmed ? [] : ["reporte_semanal"],
      cadencesConfirmed: cadenceConfirmed ? ["reporte_semanal"] : [],
      cadenceProposals: [cadenceProposal],
    },
  };
}

const createdProject = { ...project, id: "proj-9", name: "Assessment ACME" };

function wizardRoutes() {
  return [
    { path: "/api/modules", body: { modules: [moduleSummary] } },
    { path: "/api/modules/consultoria", body: { module: moduleDetail } },
    {
      method: "POST",
      path: "/api/modules/consultoria/preview",
      body: ({ body }: { body: unknown }) => previewFor(body),
    },
    {
      method: "POST",
      path: "/api/modules/consultoria/launch",
      status: 201,
      body: {
        launch: { id: "l-1", projectId: "proj-9" },
        project: createdProject,
        organization: { id: "org-9", name: "ACME" },
        tasks_count: 2,
        idempotent: false,
      },
    },
    { path: "/api/projects", body: { projects: [createdProject] } },
    {
      path: "/api/board/proj-9",
      body: { project: createdProject, board_seq: 0, total: 0, columns: {}, cells: {} },
    },
  ];
}

function ui() {
  return render(
    <MemoryRouter initialEntries={["/new-project"]}>
      <Routes>
        <Route path="/new-project" element={<NewProjectWizard />} />
        {/* Tras disparar, el wizard entra al tablero DEL proyecto creado. */}
        <Route path="/proyectos/:projectId/tablero" element={<div>BOARD_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Paso 1 → paso 2 (elige el módulo de la card). */
async function openForm() {
  fireEvent.click(await screen.findByTestId("module-card-consultoria"));
  await screen.findByLabelText(/Nombre de la empresa/);
}

/** Rellena el formulario completo (válido para el preview dinámico). */
function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/Nombre de la empresa/), { target: { value: "ACME" } });
  fireEvent.change(screen.getByLabelText(/Tamaño \(número de empleados\)/), {
    target: { value: "40" },
  });
  fireEvent.change(screen.getByLabelText(/Objetivo del engagement/), {
    target: { value: "Ordenar operaciones" },
  });
  fireEvent.click(screen.getByLabelText("direccion"));
  fireEvent.click(screen.getByLabelText("operaciones"));
  fireEvent.change(screen.getByLabelText(/Procesos core a mapear/), {
    target: { value: "ventas\nfacturacion" },
  });
  fireEvent.change(screen.getByLabelText(/Fecha objetivo de entrega/), {
    target: { value: "2026-09-15" },
  });
}

describe("wizard Nuevo proyecto (CA-M2.1)", () => {
  beforeEach(() => {
    useStore.setState({
      person,
      token: "tok",
      projects: [],
      activeProjectId: null,
      toasts: [],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paso 1 pinta la card del módulo y el formulario se genera con los tipos correctos", async () => {
    mockFetch(wizardRoutes());
    ui();

    // Card: nombre, fase, nº de plantillas y descripción del body.
    expect(await screen.findByText("Consultoría (Assessment 14 días)")).toBeTruthy();
    expect(screen.getByText(/8 plantillas/)).toBeTruthy();
    expect(await screen.findByText(/Assessment de 14 días para pymes/)).toBeTruthy();

    await openForm();

    // Tipos generados desde la definición: text, number, date, textarea,
    // multi_select como checkboxes y list_text como textarea por líneas.
    expect((screen.getByLabelText(/Nombre de la empresa/) as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText(/Tamaño \(número de empleados\)/) as HTMLInputElement).type).toBe(
      "number",
    );
    expect((screen.getByLabelText(/Fecha objetivo de entrega/) as HTMLInputElement).type).toBe(
      "date",
    );
    expect((screen.getByLabelText(/Objetivo del engagement/) as HTMLTextAreaElement).tagName).toBe(
      "TEXTAREA",
    );
    const check = screen.getByLabelText("direccion") as HTMLInputElement;
    expect(check.type).toBe("checkbox");
    expect(screen.getByLabelText("operaciones")).toBeTruthy();
    expect((screen.getByLabelText(/Procesos core a mapear/) as HTMLTextAreaElement).tagName).toBe(
      "TEXTAREA",
    );
    // Toggle como switch con label.
    expect((screen.getByRole("switch", { name: /Preparación ISO 9001/ }) as HTMLInputElement).type).toBe(
      "checkbox",
    );
  });

  it("con inputs incompletos lista los campos faltantes y deshabilita Continuar", async () => {
    mockFetch(wizardRoutes());
    ui();
    await openForm();

    // El preview con el form vacío llega con missing ⇒ lista de faltantes.
    expect(await screen.findByText("Campos faltantes:", {}, { timeout: 2000 })).toBeTruthy();
    // La lista de faltantes usa las ETIQUETAS de los inputs (no las keys).
    expect(screen.getByText("Nombre de la empresa", { selector: "li" })).toBeTruthy();
    expect(screen.getByText("Áreas a entrevistar", { selector: "li" })).toBeTruthy();
    expect(screen.getByText("Fecha objetivo de entrega", { selector: "li" })).toBeTruthy();
    const continuar = screen.getByText("Continuar →") as HTMLButtonElement;
    expect(continuar.disabled).toBe(true);
  });

  it("con el form completo el resumen pinta las tareas, gates, presupuesto y cadencia del preview", async () => {
    mockFetch(wizardRoutes());
    ui();
    await openForm();
    fillValidForm();

    // Preview ok ⇒ Continuar habilitado.
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));

    // Resumen: tareas con título renderizado, asignado, deps y estado.
    expect(await screen.findByText("Assessment ACME")).toBeTruthy();
    expect(screen.getByText("Kickoff con ACME")).toBeTruthy();
    expect(screen.getByText("alex")).toBeTruthy();
    expect(screen.getByText("Entrevista a direccion")).toBeTruthy();
    expect(screen.getByText("kickoff")).toBeTruthy(); // dependencia visible
    expect(screen.getByText("BACKLOG")).toBeTruthy();
    // Gates y entregables de cierre.
    expect(screen.getByText("cierre_entender")).toBeTruthy();
    expect(screen.getByText("resumen_ejecutivo")).toBeTruthy();
    // Presupuesto con thresholds.
    expect(screen.getByText(/70%, 90%, 100%/)).toBeTruthy();
    // Cadencia propuesta: checkbox marcable, sin confirmar por defecto (CA-M3.4).
    expect(screen.getByText("Cadencia (se confirmará al disparar)")).toBeTruthy();
    const cadenceCheckbox = screen.getByRole("checkbox", {
      name: /Reporte semanal a ACME — cada 7 días/,
    }) as HTMLInputElement;
    expect(cadenceCheckbox.checked).toBe(false);
  });

  it("marcar un checkbox de cadencia dispara un nuevo preview con cadences_confirmed", async () => {
    const { calls } = mockFetch(wizardRoutes());
    ui();
    await openForm();
    fillValidForm();
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));

    // Antes de confirmar: solo las 2 tareas base del plan.
    expect(await screen.findByText("Tareas que se crearán (2)")).toBeTruthy();

    const cadenceCheckbox = await screen.findByRole("checkbox", {
      name: /Reporte semanal a ACME — cada 7 días/,
    });
    fireEvent.click(cadenceCheckbox);

    // El nuevo preview (mismo debounce/guard anti-stale) agrega la primera
    // instancia de la cadencia confirmada al resumen de tareas.
    await waitFor(
      () => {
        expect(screen.getByText("Tareas que se crearán (3)")).toBeTruthy();
      },
      { timeout: 2000 },
    );
    expect(
      (screen.getByRole("checkbox", { name: /Reporte semanal a ACME — cada 7 días/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);

    const previewCalls = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/api/modules/consultoria/preview"),
    );
    const last = previewCalls[previewCalls.length - 1]!;
    expect((last.body as { cadences_confirmed?: string[] }).cadences_confirmed).toEqual([
      "reporte_semanal",
    ]);
  });

  it("sin cadence_proposals no se pinta la sección de cadencia", async () => {
    const routes = wizardRoutes().map((r) =>
      typeof r.path === "string" && r.path.endsWith("/preview")
        ? {
            ...r,
            body: ({ body }: { body: unknown }) => {
              const res = previewFor(body);
              if (res.plan) {
                res.plan = { ...res.plan, cadenceExcluded: [], cadencesConfirmed: [], cadenceProposals: [] };
              }
              return res;
            },
          }
        : r,
    );
    mockFetch(routes as never);
    ui();
    await openForm();
    fillValidForm();
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));

    expect(await screen.findByText("Assessment ACME")).toBeTruthy();
    expect(screen.queryByText("Cadencia (se confirmará al disparar)")).toBeNull();
  });

  it("Disparar hace POST con idempotency_key estable (doble click no duplica) y navega al tablero", async () => {
    const { calls } = mockFetch(wizardRoutes());
    ui();
    await openForm();
    fillValidForm();
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));

    const fireBtn = await screen.findByText("🚀 Disparar");
    // Doble click: el segundo cae con el botón deshabilitado o reutiliza la MISMA key.
    fireEvent.click(fireBtn);
    fireEvent.click(fireBtn);

    // Navegación al tablero del proyecto creado.
    expect(await screen.findByText("BOARD_MARKER")).toBeTruthy();

    const launches: FetchCall[] = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/api/modules/consultoria/launch"),
    );
    expect(launches.length).toBeGreaterThan(0);
    const body = launches[0]!.body as {
      inputs: Record<string, unknown>;
      toggles: Record<string, boolean>;
      cadences_confirmed?: string[];
      idempotency_key: string;
    };
    expect(typeof body.idempotency_key).toBe("string");
    expect(body.idempotency_key.length).toBeGreaterThan(0);
    expect(body.inputs["empresa"]).toBe("ACME");
    expect(body.inputs["areas"]).toEqual(["direccion", "operaciones"]);
    expect(body.inputs["procesos_core"]).toEqual(["ventas", "facturacion"]);
    expect(body.toggles).toEqual({ iso9001: false });
    // Sin cadencias confirmadas: se manda vacío (nada de cadencia se dispara).
    expect(body.cadences_confirmed).toEqual([]);
    // Si el doble click llegó a duplicar el POST, ambas llevan la MISMA key.
    for (const l of launches) {
      expect((l.body as { idempotency_key: string }).idempotency_key).toBe(body.idempotency_key);
    }
    // El proyecto creado quedó activo en el store.
    expect(useStore.getState().activeProjectId).toBe("proj-9");
  });

  it("Disparar incluye las cadencias confirmadas en el POST launch", async () => {
    const { calls } = mockFetch(wizardRoutes());
    ui();
    await openForm();
    fillValidForm();
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));

    const cadenceCheckbox = await screen.findByRole("checkbox", {
      name: /Reporte semanal a ACME — cada 7 días/,
    });
    fireEvent.click(cadenceCheckbox);
    await waitFor(
      () => {
        expect(screen.getByText("Tareas que se crearán (3)")).toBeTruthy();
      },
      { timeout: 2000 },
    );

    fireEvent.click(await screen.findByText("🚀 Disparar"));
    expect(await screen.findByText("BOARD_MARKER")).toBeTruthy();

    const launches: FetchCall[] = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/api/modules/consultoria/launch"),
    );
    expect(launches.length).toBeGreaterThan(0);
    const body = launches[0]!.body as { cadences_confirmed?: string[] };
    expect(body.cadences_confirmed).toEqual(["reporte_semanal"]);
  });

  it("un error de dominio del launch (409 fase ya disparada) se muestra legible", async () => {
    const routes = wizardRoutes().filter((r) => !String(r.path).includes("/launch"));
    routes.push({
      method: "POST",
      path: "/api/modules/consultoria/launch",
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "La fase ENTENDER ya se disparó sobre el proyecto",
          details: { code: "phase_already_launched", projectId: "proj-1", phase: "ENTENDER" },
        },
      },
    } as never);
    mockFetch(routes);
    ui();
    await openForm();
    fillValidForm();
    await waitFor(
      () => {
        expect((screen.getByText("Continuar →") as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByText("Continuar →"));
    fireEvent.click(await screen.findByText("🚀 Disparar"));

    expect(
      await screen.findByText(/Esta fase ya se disparó sobre ese proyecto/),
    ).toBeTruthy();
    // Sin navegación: seguimos en el resumen.
    expect(screen.queryByText("BOARD_MARKER")).toBeNull();
  });
});
