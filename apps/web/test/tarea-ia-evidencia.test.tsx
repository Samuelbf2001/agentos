/**
 * Los tres añadidos del rediseño de tareas que no viven en la vista:
 *
 * 1. El icono de IA junto a un campo: consulta el contexto del cliente, enseña
 *    lo que propone y sólo cambia el campo si el humano lo aplica. Un 503 se
 *    dice en un toast y no rompe nada.
 * 2. `MarkdownField`: pegar una imagen la sube y la escribe en el Markdown.
 * 3. La evidencia de la ficha: los volcados de Notion se colapsan en una línea
 *    en vez de enterrar lo que sí demuestra el trabajo.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setToken } from "../src/lib/api";
import { useStore } from "../src/state/store";
import { FieldAssist } from "../src/views/task/FieldAssist";
import { MarkdownField } from "../src/views/task/MarkdownField";
import { TaskDrawer } from "../src/views/TaskDrawer";
import { makeArtifact, makeTask, mockFetch, person, project } from "./helpers";

function baseState() {
  setToken("tok");
  useStore.setState({
    person,
    token: "tok",
    projects: [project],
    activeProjectId: project.id,
    people: [person],
    peopleLoading: false,
    peopleError: null,
    projectPeople: null,
    projectPeopleId: null,
    labelCatalog: [],
    taskDetail: null,
    taskDetailId: null,
    taskDetailLoading: false,
    taskDetailError: null,
    taskMutationError: null,
    taskSaving: false,
    blockedMove: null,
    toasts: [],
  });
}

const ASSIST_OK = {
  text: "## Pasos\n\n1. Entrevistar al responsable de cobranza.",
  context: {
    org_name: "ACME S.A.",
    project_name: project.name,
    docs: 3,
    images: 2,
    sibling_tasks: 0,
    model: "test",
  },
};

describe("FieldAssist", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propone con el contexto del cliente y sólo cambia el campo al aplicar", async () => {
    const { calls } = mockFetch([{ method: "POST", path: "/api/ai/task-assist", body: ASSIST_OK }]);
    const onApply = vi.fn();
    render(
      <FieldAssist
        field="description"
        taskId="t1"
        draft={() => ({ title: "Cobranza", description: "corto" })}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByTestId("field-assist-ai-description"));

    // El panel dice QUÉ consultó antes de que nadie acepte nada.
    const panel = await screen.findByTestId("field-assist-panel");
    expect(panel.textContent).toContain("Consultó 3 documentos de ACME S.A.");
    expect(panel.textContent).toContain("2 imágenes");
    expect(onApply).not.toHaveBeenCalled();

    const assist = calls.find((call) => call.url.endsWith("/api/ai/task-assist"));
    expect(assist?.body).toMatchObject({
      mode: "enrich",
      field: "description",
      task_id: "t1",
      draft: { title: "Cobranza", description: "corto" },
    });

    fireEvent.click(screen.getByTestId("field-assist-apply"));
    expect(onApply).toHaveBeenCalledWith(ASSIST_OK.text);
  });

  it("descartar cierra la propuesta sin tocar el campo", async () => {
    mockFetch([{ method: "POST", path: "/api/ai/task-assist", body: ASSIST_OK }]);
    const onApply = vi.fn();
    render(<FieldAssist field="title" draft={() => ({})} onApply={onApply} showPrompt={false} />);

    fireEvent.click(screen.getByTestId("field-assist-ai-title"));
    await screen.findByTestId("field-assist-panel");
    fireEvent.click(screen.getByTestId("field-assist-discard"));

    await waitFor(() => expect(screen.queryByTestId("field-assist-panel")).toBeNull());
    expect(onApply).not.toHaveBeenCalled();
  });

  it("un 503 del proveedor se dice en un toast y deja el campo como estaba", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/ai/task-assist",
        status: 503,
        body: { error: { code: "provider_unavailable", message: "sin proveedor" } },
      },
    ]);
    const onApply = vi.fn();
    render(<FieldAssist field="definition_of_done" draft={() => ({})} onApply={onApply} />);

    fireEvent.click(screen.getByTestId("field-assist-ai-definition_of_done"));

    await waitFor(() =>
      expect(useStore.getState().toasts.some((t) => t.text === "El asistente no está disponible")).toBe(
        true,
      ),
    );
    expect(screen.queryByTestId("field-assist-panel")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("copiar el prompt lo deja en el portapapeles y lo dice", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/ai/task-assist",
        body: { text: "Trabaja la tarea…", context: ASSIST_OK.context },
      },
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<FieldAssist field="description" draft={() => ({})} onApply={vi.fn()} />);
    fireEvent.click(screen.getByTestId("field-assist-prompt"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Trabaja la tarea…"));
    expect(useStore.getState().toasts.some((t) => t.text.includes("Prompt copiado"))).toBe(true);
  });

  it("si el portapapeles falla, el prompt se enseña para copiarlo a mano", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/ai/task-assist",
        body: { text: "Trabaja la tarea…", context: ASSIST_OK.context },
      },
    ]);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denegado")) },
    });

    render(<FieldAssist field="description" draft={() => ({})} onApply={vi.fn()} />);
    fireEvent.click(screen.getByTestId("field-assist-prompt"));

    const texto = (await screen.findByTestId("prompt-fallback-text")) as HTMLTextAreaElement;
    expect(texto.value).toBe("Trabaja la tarea…");
  });
});

/** El campo con su estado, como lo usan la ficha y el alta. */
function CampoConEstado() {
  const [value, setValue] = useState("");
  return <MarkdownField id="campo" testId="campo" label="Campo" value={value} onChange={setValue} />;
}

describe("MarkdownField", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const subida = {
    method: "POST" as const,
    path: "/api/uploads/images",
    status: 201,
    body: { id: "img-9", url: "/api/uploads/img-9", name: "boceto.png", mime: "image/png", bytes: 9 },
  };

  it("pegar una imagen la sube y escribe el Markdown en el cursor", async () => {
    const { calls } = mockFetch([subida]);
    render(<CampoConEstado />);

    const campo = screen.getByTestId("campo");
    fireEvent.change(campo, { target: { value: "Antes" } });
    const file = new File(["png"], "boceto.png", { type: "image/png" });
    fireEvent.paste(campo, { clipboardData: { files: [file], types: ["Files"] } });

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/api/uploads/images"))).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByTestId("campo") as HTMLTextAreaElement).value).toBe(
        "Antes\n\n![boceto](http://localhost:4300/api/uploads/img-9)",
      ),
    );
  });

  it("soltar una imagen encima hace lo mismo que pegarla", async () => {
    const { calls } = mockFetch([subida]);
    render(<CampoConEstado />);

    const file = new File(["png"], "boceto.png", { type: "image/png" });
    fireEvent.drop(screen.getByTestId("campo"), {
      dataTransfer: { files: [file], types: ["Files"] },
    });

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/api/uploads/images"))).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByTestId("campo") as HTMLTextAreaElement).value).toContain(
        "![boceto](http://localhost:4300/api/uploads/img-9)",
      ),
    );
  });

  it("pegar texto no se intercepta: un enlace entra tal cual", async () => {
    const { calls } = mockFetch([subida]);
    render(<CampoConEstado />);

    fireEvent.paste(screen.getByTestId("campo"), {
      clipboardData: { files: [], types: ["text/plain"] },
    });
    expect(calls.some((call) => call.url.endsWith("/api/uploads/images"))).toBe(false);
  });

  it("un fallo de subida se dice en un toast y no escribe nada", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/uploads/images",
        status: 413,
        body: { error: { code: "too_large", message: "La imagen pesa más de 10 MB" } },
      },
    ]);
    render(<CampoConEstado />);

    const file = new File(["png"], "enorme.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("campo"), {
      clipboardData: { files: [file], types: ["Files"] },
    });

    await waitFor(() =>
      expect(useStore.getState().toasts.some((t) => t.text.includes("10 MB"))).toBe(true),
    );
    expect((screen.getByTestId("campo") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("Evidencia y adjuntos en la ficha", () => {
  beforeEach(() => {
    baseState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explica para qué sirve y colapsa el volcado de Notion en una línea", async () => {
    const task = makeTask();
    useStore.setState({
      taskDetail: {
        task,
        events: [],
        runs: [],
        project,
        artifacts: [
          makeArtifact({
            id: "a-notion",
            kind: "notion_archive",
            title: "Volcado de bloques de Notion",
            content: "Original: https://www.notion.so/Tarea-abc123",
          }),
          makeArtifact({ id: "a-real", kind: "file", title: "Informe final.pdf" }),
        ],
      },
      taskDetailId: task.id,
    });
    mockFetch([{ path: "/api/projects/proj-1/people", body: { org_id: "org-1", people: [person] } }]);

    render(
      <MemoryRouter>
        <TaskDrawer />
      </MemoryRouter>,
    );

    // El nombre dice qué es y el subtítulo dice qué pasa si falta.
    expect(await screen.findByText(/Evidencia y adjuntos/)).toBeTruthy();
    expect(screen.getByText(/no pasa a Revisión ni a Hecha/)).toBeTruthy();

    // El volcado no se lista como un artefacto más: una línea con su enlace.
    const importada = screen.getByTestId("artifact-notion-archive");
    expect(importada.textContent).toContain("Importada de Notion");
    expect(
      importada.querySelector("a")?.getAttribute("href"),
    ).toBe("https://www.notion.so/Tarea-abc123");
    expect(screen.queryByText("Volcado de bloques de Notion")).toBeNull();

    // Y la evidencia de verdad sigue ahí.
    expect(screen.getByText("Informe final.pdf")).toBeTruthy();
  });
});
