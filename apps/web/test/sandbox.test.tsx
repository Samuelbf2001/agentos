/**
 * Modo pruebas (sandbox) en la web: aviso + entrada sin contraseña en
 * LoginView cuando la API expone `sandbox:true`, y chip "Pruebas" en la
 * cabecera del shell. Con `sandbox:false` ninguno de los dos aparece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { useStore } from "../src/state/store";
import { agents, makeTask, mockFetch, person, project } from "./helpers";

const SHELL_ROUTES = [
  { path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
  { path: "/api/runs", body: { runs: [] } },
  { path: "/api/projects", body: { projects: [project] } },
  { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { launchId: null, complete: false, items: [], reason: "no_launch" } } },
  { path: /^\/api\/projects\/[^/]+\/launches$/, body: { launches: [] } },
  { path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: "org-1", people: [person] } },
  { path: /^\/api\/board\/[^/]+$/, body: { project, board_seq: 1, total: 1, columns: { READY: [makeTask()] }, cells: {} } },
  { path: "/api/labels", body: { labels: [] } },
  { path: "/api/tasks", body: { tasks: [] } },
  { path: "/api/auth/people", body: { people: [person] } },
  { path: "/api/brain/overview", body: { generated_at: null, core: { counts: {}, people: [] }, agents: { items: [], tree: null, health: [] }, sources: [], modules: [] } },
];

describe("modo pruebas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    // Cada test parte de "sin sesión": el store es un singleton de módulo y
    // un login (real o de sandbox) del test anterior dejaría el siguiente
    // render directo en el shell en vez de en LoginView.
    useStore.setState({
      sandbox: false,
      token: null,
      person: null,
      bootstrapped: false,
      projects: [],
      activeProjectId: null,
      agents: [],
      approvals: [],
      reviewTasks: [],
      failedRunsCount: 0,
      toasts: [],
    });
  });

  describe("con sandbox activo", () => {
    beforeEach(() => {
      mockFetch([
        { path: "/api/health", body: { ok: true, sandbox: true, kill_switch: false, counts: {} } },
        {
          path: "/api/auth/sandbox-login",
          body: { token: "tok-sandbox", person },
        },
        ...SHELL_ROUTES,
      ]);
    });

    it("pinta el aviso y el botón, y al pulsarlo entra al shell con el chip Pruebas", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>,
      );

      expect(
        await screen.findByText(/entorno de pruebas: los datos son una copia/i),
      ).toBeTruthy();
      const button = await screen.findByRole("button", { name: "Entrar sin contraseña" });

      fireEvent.click(button);

      await waitFor(() => {
        expect(useStore.getState().token).toBe("tok-sandbox");
      });
      expect(await screen.findByTitle("Entorno de pruebas: copia de datos, sin efectos reales")).toBeTruthy();
    });
  });

  describe("con sandbox apagado", () => {
    beforeEach(() => {
      mockFetch([
        { path: "/api/health", body: { ok: true, sandbox: false, kill_switch: false, counts: {} } },
        ...SHELL_ROUTES,
      ]);
    });

    it("no muestra el aviso ni el botón de entrada sin contraseña", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>,
      );

      await screen.findByLabelText("¿Quién eres?");
      expect(screen.queryByText(/entorno de pruebas/i)).toBeNull();
      expect(screen.queryByRole("button", { name: "Entrar sin contraseña" })).toBeNull();
    });

    it("no muestra el chip Pruebas en la cabecera ya autenticado", async () => {
      useStore.setState({
        person,
        token: "tok",
        bootstrapped: true,
        sandbox: false,
        projects: [project],
        activeProjectId: project.id,
        agents,
        approvals: [],
        reviewTasks: [],
        failedRunsCount: 0,
        toasts: [],
      });
      render(
        <MemoryRouter initialEntries={["/hoy"]}>
          <App />
        </MemoryRouter>,
      );
      await screen.findByText("AgentOS");
      expect(screen.queryByTitle("Entorno de pruebas: copia de datos, sin efectos reales")).toBeNull();
    });
  });
});
