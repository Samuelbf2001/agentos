/**
 * ClientsGrid: sustituye a la tabla de proyectos. Agrupa por cliente, marca
 * atención pendiente (vencidas o gate listo) y cada proyecto enlaza a su ruta.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ClientsGrid } from "../src/views/ClientsGrid";
import { useStore } from "../src/state/store";
import { agents, project, projectB } from "./helpers";
import type { ProjectSummary } from "../src/state/useProjectSummaries";

function makeSummary(
  proj: ProjectSummary["project"],
  overrides: Partial<Omit<ProjectSummary, "project">> = {},
): ProjectSummary {
  return {
    project: proj,
    tasks: null,
    closure: null,
    overdue: 0,
    open: 0,
    workingAgentIds: [],
    nextMilestone: "Cerrar Entender",
    missing: "Sin módulo lanzado",
    gateReady: false,
    ...overrides,
  };
}

function renderGrid(summaries: ProjectSummary[]) {
  useStore.setState({ agents });
  return render(
    <MemoryRouter>
      <ClientsGrid summaries={summaries} />
    </MemoryRouter>,
  );
}

describe("ClientsGrid", () => {
  it("agrupa por cliente y ordena primero al que tiene vencidas", () => {
    const acme = makeSummary(project, { overdue: 2 });
    const beta = makeSummary(projectB, { gateReady: true });
    renderGrid([beta, acme]);

    const cards = screen.getAllByRole("article");
    expect(within(cards[0]!).getAllByText("ACME assessment").length).toBeGreaterThan(0);
    expect(within(cards[0]!).getByText("2 vencidas")).toBeTruthy();
    expect(within(cards[1]!).getAllByText("Beta operación").length).toBeGreaterThan(0);
    expect(within(cards[1]!).getByText("Gate listo")).toBeTruthy();
  });

  it("cada proyecto enlaza a su ruta", () => {
    renderGrid([makeSummary(project)]);
    const link = screen.getByTestId(`client-project-${project.id}`);
    expect(link.getAttribute("href")).toBe(`/proyectos/${project.id}/ruta`);
  });

  it("cierra la rejilla con la tarjeta para crear un cliente nuevo", () => {
    renderGrid([makeSummary(project)]);
    expect(screen.getByText("+ Nuevo cliente").closest("a")?.getAttribute("href")).toBe("/nuevo-proyecto");
  });

  it("sin clientes muestra el estado vacío con la acción de crear el primero", () => {
    renderGrid([]);
    expect(screen.getByText("Todavía no hay clientes")).toBeTruthy();
    expect(screen.getByText("Crear el primero").closest("a")?.getAttribute("href")).toBe("/nuevo-proyecto");
  });
});
