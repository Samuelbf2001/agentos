/**
 * Agente 2brain (vista): estado de integraciones, prompt de extracción
 * (editar/guardar/restablecer) y herramientas, todo detrás de
 * `/api/brain/agente/*`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AgenteView from "../src/views/brain/AgenteView";
import { mockFetch } from "./helpers";

const status = { notion: true, kapso: false, whatsapp_reminders: true, wiki_notes: true };

const baseConfig = {
  prompt_default: "Extrae decisiones, tareas y dolores de la reunión.",
  prompt_override: null as string | null,
  prompt_effective: "Extrae decisiones, tareas y dolores de la reunión.",
  tools: [
    {
      name: "notion.create_task",
      description: "Crea una tarea en Notion",
      input_schema: { type: "object", properties: { title: { type: "string" } } },
    },
  ],
  chat_tools: [{ name: "whatsapp.send_reminder", description: "Envía un recordatorio", input_schema: null }],
  chat_enabled: true,
};

describe("Agente 2brain (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("muestra estado, prompt por defecto y herramientas; guarda un override y lo refleja", async () => {
    const draft = "Extrae únicamente decisiones y compromisos con fecha.";
    const { calls } = mockFetch([
      { path: "/api/brain/agente/status", method: "GET", body: status },
      { path: "/api/brain/agente/config", method: "GET", body: baseConfig },
      {
        path: "/api/brain/agente/config",
        method: "PUT",
        body: (init: { method: string; body: unknown; url: string }) => {
          const prompt = (init.body as { prompt: string | null }).prompt;
          return { ...baseConfig, prompt_override: prompt, prompt_effective: prompt ?? baseConfig.prompt_default };
        },
      },
    ]);

    render(
      <MemoryRouter>
        <AgenteView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Agente 2brain" })).toBeTruthy();

    // Estado: Notion/Recordatorios/Wiki conectados, Kapso sin configurar.
    const notionCard = screen.getByText("Notion").closest("div")!;
    expect(notionCard.textContent).toContain("Conectado");
    const kapsoCard = screen.getByText("Kapso (WhatsApp)").closest("div")!;
    expect(kapsoCard.textContent).toContain("Sin configurar");

    // Prompt por defecto precargado; "Guardar" deshabilitado sin cambios.
    const textarea = screen.getByLabelText("Prompt de extracción del agente") as HTMLTextAreaElement;
    expect(textarea.value).toBe(baseConfig.prompt_default);
    const guardar = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);

    // Herramientas listadas (extracción + conversacional).
    expect(screen.getByText("notion.create_task")).toBeTruthy();
    expect(screen.getByText("Crea una tarea en Notion")).toBeTruthy();
    expect(screen.getByText("whatsapp.send_reminder")).toBeTruthy();

    // "Restablecer" deshabilitado: todavía no hay override.
    expect(
      (screen.getByRole("button", { name: "Restablecer al prompt por defecto" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(textarea, { target: { value: draft } });
    expect(guardar.disabled).toBe(false);
    fireEvent.click(guardar);

    expect(await screen.findByText("Prompt guardado correctamente.")).toBeTruthy();
    expect(textarea.value).toBe(draft);
    expect(screen.getByText("Override activo")).toBeTruthy();
    expect(guardar.disabled).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.url.includes("/api/brain/agente/config") &&
          call.method === "PUT" &&
          (call.body as { prompt: string | null }).prompt === draft,
      ),
    ).toBe(true);
  });

  it("restablecer pide confirmación en línea (sin window.confirm) antes de volver al default", async () => {
    const overrideConfig = {
      ...baseConfig,
      prompt_override: "Override guardado antes.",
      prompt_effective: "Override guardado antes.",
    };
    mockFetch([
      { path: "/api/brain/agente/status", method: "GET", body: status },
      { path: "/api/brain/agente/config", method: "GET", body: overrideConfig },
      {
        path: "/api/brain/agente/config",
        method: "PUT",
        body: { ...baseConfig, prompt_override: null, prompt_effective: baseConfig.prompt_default },
      },
    ]);

    render(
      <MemoryRouter>
        <AgenteView />
      </MemoryRouter>,
    );

    const restablecer = (await screen.findByRole("button", {
      name: "Restablecer al prompt por defecto",
    })) as HTMLButtonElement;
    expect(restablecer.disabled).toBe(false);
    fireEvent.click(restablecer);

    expect(screen.getByText("¿Restablecer al prompt por defecto?")).toBeTruthy();
    // Cancelar: no dispara ninguna petición y quita la confirmación.
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(screen.queryByText("¿Restablecer al prompt por defecto?")).toBeNull();

    // El botón se desmonta y remonta al alternar la confirmación: se re-consulta.
    fireEvent.click(screen.getByRole("button", { name: "Restablecer al prompt por defecto" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí" }));

    expect(await screen.findByText("Prompt restablecido al valor por defecto.")).toBeTruthy();
    const textarea = screen.getByLabelText("Prompt de extracción del agente") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(baseConfig.prompt_default));
  });

  it("sin herramientas registradas muestra el vacío sin romper (tolerante a listas vacías)", async () => {
    mockFetch([
      { path: "/api/brain/agente/status", method: "GET", body: status },
      { path: "/api/brain/agente/config", method: "GET", body: { ...baseConfig, tools: [], chat_tools: [] } },
    ]);

    render(
      <MemoryRouter>
        <AgenteView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Agente 2brain" })).toBeTruthy();
    expect(screen.getAllByText("Sin herramientas registradas")).toHaveLength(2);
  });

  it("si el hub no responde el estado, el prompt sigue funcionando y se ve ErrorBox solo si config falla", async () => {
    mockFetch([{ path: "/api/brain/agente/config", method: "GET", body: baseConfig }]);

    render(
      <MemoryRouter>
        <AgenteView />
      </MemoryRouter>,
    );

    // /status no tiene mock (404 del router en memoria): la vista no debe romperse.
    expect(await screen.findByRole("heading", { level: 1, name: "Agente 2brain" })).toBeTruthy();
    expect(screen.getByLabelText("Prompt de extracción del agente")).toBeTruthy();
  });
});
