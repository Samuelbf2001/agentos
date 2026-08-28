/**
 * Recibo del launch (CA-M2.4) y panel "Cierre de fase" (CA-M3.1/M3.2) en la
 * vista del proyecto: badge "Disparado desde <Módulo> v<N> por <persona>" con
 * panel del recibo, entregables required/found/missing legibles, y con todo
 * completo el check verde + hueco del botón "Disparar <siguiente>" deshabilitado
 * (tooltip "próximamente" — el endpoint next-phase aún no existe).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectPhaseHeader } from "../src/views/PhasePanel";
import { mockFetch, project } from "./helpers";
import type { LaunchReceipt, PhaseClosureStatus } from "../src/lib/types";

const receipt: LaunchReceipt = {
  id: "l-1",
  module_slug: "consultoria",
  module_version: 1,
  module_name: "Consultoría (Assessment 14 días)",
  phase: "ENTENDER",
  org_id: "org-1",
  project_id: project.id,
  inputs: { empresa: "ACME", objetivo: "[redacted]", areas: ["direccion", "operaciones"] },
  toggles: { iso9001: true },
  task_count: 9,
  budget_phase_usd: 15,
  budget_per_run_usd: 2,
  previous_launch_id: null,
  actor: "person:p-ernesto",
  actor_name: "Ernesto",
  label: "Disparado desde Consultoría (Assessment 14 días) v1 por Ernesto",
  created_at: Date.parse("2026-08-20T15:00:00Z"),
};

const incompleteStatus: PhaseClosureStatus = {
  launchId: "l-1",
  complete: false,
  items: [
    {
      kind: "resumen_ejecutivo",
      source: "knowledge_doc",
      required: 1,
      found: 0,
      missing: 'Falta(n) 1 de 1 "resumen_ejecutivo" — documento(s) en el Context Hub',
    },
    { kind: "proceso_asis", source: "process", required: 2, found: 2, missing: null },
  ],
};

const completeStatus: PhaseClosureStatus = {
  launchId: "l-1",
  complete: true,
  items: [
    { kind: "resumen_ejecutivo", source: "knowledge_doc", required: 1, found: 1, missing: null },
    { kind: "proceso_asis", source: "process", required: 2, found: 3, missing: null },
  ],
};

function routes(status: PhaseClosureStatus, launches: LaunchReceipt[] = [receipt]) {
  return [
    { path: `/api/projects/${project.id}/launches`, body: { launches } },
    { path: `/api/projects/${project.id}/phase-status`, body: { status } },
  ];
}

describe("recibo del launch y cierre de fase (CA-M2.4 / CA-M3.1 / CA-M3.2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pinta el badge del launch y el recibo con inputs redactados, task_count y fecha", async () => {
    mockFetch(routes(incompleteStatus));
    render(<ProjectPhaseHeader projectId={project.id} />);

    // CA-M2.4: "Disparado desde Consultoría v1 por Ernesto" visible.
    expect(
      await screen.findByText("Disparado desde Consultoría (Assessment 14 días) v1 por Ernesto"),
    ).toBeTruthy();

    // El panel del recibo se abre desde el badge.
    fireEvent.click(
      screen.getByText("Disparado desde Consultoría (Assessment 14 días) v1 por Ernesto"),
    );
    const panel = await screen.findByTestId("launch-receipt");
    expect(panel.textContent).toContain("9");
    expect(panel.textContent).toContain("tareas");
    expect(panel.textContent).toContain("Ernesto");
    expect(panel.textContent).toContain("ACME");
    // Inputs sensibles ya llegan redactados del servidor y se pintan tal cual.
    expect(panel.textContent).toContain("[redacted]");
    expect(panel.textContent).toContain("direccion, operaciones");
    expect(panel.textContent).toContain("iso9001: sí");
  });

  it("cierre de fase incompleto: lista missing legible y avisa que el gate no puede aprobarse", async () => {
    mockFetch(routes(incompleteStatus));
    render(<ProjectPhaseHeader projectId={project.id} />);

    const closure = await screen.findByTestId("phase-closure");
    expect(screen.getByText("faltan entregables")).toBeTruthy();
    expect(closure.textContent).toContain("resumen_ejecutivo");
    expect(
      screen.getByText(/Falta\(n\) 1 de 1 "resumen_ejecutivo" — documento\(s\) en el Context Hub/),
    ).toBeTruthy();
    // El que sí está: found/required visible.
    expect(closure.textContent).toContain("2/2");
    expect(screen.getByText(/El gate de fase no puede aprobarse mientras falten entregables/)).toBeTruthy();
    // Sin fase completa no hay hueco de "Disparar Implementación".
    expect(screen.queryByText(/Disparar Implementación/)).toBeNull();
  });

  it("cierre de fase completo: check verde + botón 'Disparar Implementación' deshabilitado con tooltip próximamente (CA-M3.2)", async () => {
    mockFetch(routes(completeStatus));
    render(<ProjectPhaseHeader projectId={project.id} />);

    expect(await screen.findByText("✓ Fase completa")).toBeTruthy();
    expect(screen.getByText("✓ entregables completos")).toBeTruthy();
    const btn = screen.getByText(/Disparar Implementación/) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("próximamente");
  });

  it("proyecto sin launch (reason no_launch) no pinta nada", async () => {
    const { calls } = mockFetch(
      routes({ launchId: null, complete: false, items: [], reason: "no_launch" }, []),
    );
    const { container } = render(<ProjectPhaseHeader projectId={project.id} />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/phase-status"))).toBe(true);
    });
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("phase-closure")).toBeNull();
  });
});
