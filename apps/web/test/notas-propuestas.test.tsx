/**
 * Notas manuscritas, fase 3 (vista): «Proponer tareas» → POST propose; la
 * edición del humano → PATCH proposals (amortiguado, con expected_version);
 * «Crear N tareas» deshabilitado mientras alguna incluida no tenga proyecto,
 * y con proyecto → POST commit-tasks; tras crear aparece «Creada» con enlace
 * que abre la ficha. Ninguna tarea se crea sin pulsar el botón.
 *
 * El lienzo se dobla igual que en notas.test.tsx: jsdom no pinta Excalidraw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotasView from "../src/views/NotasView";
import { PROPOSALS_SAVE_MS } from "../src/views/notas/PropuestasPanel";
import { useStore } from "../src/state/store";
import { mockFetch, person, personB, project, projectB, type MockRoute } from "./helpers";
import type { CanvasNote, NoteTaskProposal } from "../src/lib/types";

vi.mock("../src/views/notas/Lienzo", () => ({
  default: ({ onReady }: { onReady: (handle: unknown) => void }) => {
    onReady({ getScene: () => ({ elements: [] }), estaVacio: () => false, exportarPng: async () => new Blob() });
    return <div data-testid="lienzo">lienzo</div>;
  },
}));

function propuesta(overrides: Partial<NoteTaskProposal> = {}): NoteTaskProposal {
  return {
    id: "prop-1",
    include: true,
    title: "Cerrar el presupuesto",
    project_id: project.id,
    project_guess: null,
    assignee_person_id: null,
    assignee_guess: null,
    due_at: null,
    priority: "normal",
    source_excerpt: "Cerrar el presupuesto con Jorge para el viernes",
    confidence: "alta",
    created_task_id: null,
    ...overrides,
  };
}

/** Nota ya transcrita: el punto de partida de la fase 3. */
function notaTranscrita(overrides: Partial<CanvasNote> = {}): CanvasNote {
  return {
    id: "n1",
    orgId: project.orgId,
    projectId: project.id,
    title: "Reunión con dirección",
    scene: { elements: [] },
    status: "transcribed",
    imageArtifactId: null,
    imagePath: "notas/n1/n1-4.png",
    imageBytes: 4,
    capturedAt: 3000,
    transcription: "- Cerrar el presupuesto con Jorge para el viernes\n- Sonria: mandar propuesta",
    proposals: [],
    createdByPersonId: person.id,
    version: 6,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

/** Rutas comunes: proyectos de dos clientes y el roster del proyecto de la nota. */
function rutasBase(note: CanvasNote): MockRoute[] {
  return [
    { method: "GET", path: "/api/notes", body: { notes: [note] } },
    { method: "GET", path: "/api/notes/n1", body: () => ({ note: useStore.getState().notes[0] }) },
    {
      method: "GET",
      path: "/api/projects",
      body: { projects: [{ ...project, orgName: "ACME S.A." }, { ...projectB, orgName: "Beta Corp" }] },
    },
    { method: "GET", path: /^\/api\/projects\/[^/]+\/people$/, body: { org_id: project.orgId, people: [person, personB] } },
    { method: "GET", path: "/api/auth/people", body: { people: [person, personB] } },
  ];
}

function renderNotas() {
  useStore.setState({
    person,
    token: "tok",
    bootstrapped: true,
    notes: [],
    projects: [],
    people: [],
    projectPeople: null,
    projectPeopleId: null,
    notesLoading: false,
    notesError: null,
    activeNoteId: null,
    noteSaving: false,
    noteSavedAt: null,
    noteCapturing: false,
    noteTranscribing: false,
    noteTranscribeError: null,
    noteProposing: false,
    noteProposeError: null,
    noteCommitting: false,
    toasts: [],
  });
  return render(
    <MemoryRouter initialEntries={["/notas"]}>
      <NotasView />
    </MemoryRouter>,
  );
}

describe("Notas manuscritas — tareas propuestas (vista)", () => {
  beforeEach(() => {
    useStore.setState({ notes: [], activeNoteId: null, toasts: [], taskDetailId: null, taskDetail: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("«Proponer tareas» llama a POST propose y pinta la lista sin crear nada", async () => {
    const note = notaTranscrita();
    const { calls } = mockFetch([
      ...rutasBase(note),
      {
        method: "POST",
        path: "/api/notes/n1/propose",
        body: () => ({
          note: notaTranscrita({
            version: 7,
            proposals: [
              propuesta(),
              propuesta({
                id: "prop-2",
                title: "Mandar propuesta a Sonria",
                project_id: null,
                project_guess: "Sonria",
                assignee_guess: "Jorge",
                source_excerpt: "Sonria: mandar propuesta",
                confidence: "media",
              }),
            ],
          }),
        }),
      },
    ]);
    renderNotas();
    await screen.findByTestId("lienzo");
    const panel = within(await screen.findByTestId("propuestas-panel"));
    // Sólo con nota transcrita existe el botón, y de entrada no hay propuestas.
    expect(panel.getByText(/Pulsa «Proponer tareas»/)).toBeTruthy();

    fireEvent.click(panel.getByRole("button", { name: /^Proponer tareas$/ }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === "POST" && c.url.includes("/propose"))).toBeTruthy();
    });
    expect(await screen.findByTestId("propuesta-prop-1")).toBeTruthy();
    expect(screen.getByTestId("propuesta-prop-2")).toBeTruthy();
    // El fragmento de origen y la marca del proyecto no encontrado.
    expect(screen.getByText(/«Sonria: mandar propuesta»/)).toBeTruthy();
    expect(screen.getByText(/Proyecto no encontrado: «Sonria»/)).toBeTruthy();
    // Ningún POST a tareas ni a commit: proponer no crea.
    expect(calls.some((c) => c.url.includes("/commit-tasks") || c.url.endsWith("/api/tasks"))).toBe(false);
    expect(await screen.findByText("Transcrita")).toBeTruthy();
  });

  it("editar una propuesta manda PATCH proposals con expected_version tras el retardo", async () => {
    const note = notaTranscrita({ proposals: [propuesta()] });
    const { calls } = mockFetch([
      ...rutasBase(note),
      {
        method: "PATCH",
        path: "/api/notes/n1/proposals",
        body: (init: { body: unknown }) => ({
          note: notaTranscrita({
            version: 7,
            proposals: (init.body as { proposals: NoteTaskProposal[] }).proposals,
          }),
        }),
      },
    ]);
    renderNotas();
    const titulo = (await screen.findByTestId("propuesta-titulo-prop-1")) as HTMLInputElement;
    expect(titulo.value).toBe("Cerrar el presupuesto");

    vi.useFakeTimers();
    fireEvent.change(titulo, { target: { value: "Cerrar el presupuesto 2026" } });
    fireEvent.change(screen.getByTestId("propuesta-prioridad-prop-1"), { target: { value: "high" } });
    // Antes del retardo no se llama: se edita, no se martillea la API.
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROPOSALS_SAVE_MS + 100);
    });
    vi.useRealTimers();

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain("/api/notes/n1/proposals");
      expect(patch!.body).toMatchObject({
        expected_version: 6,
        proposals: [{ id: "prop-1", title: "Cerrar el presupuesto 2026", priority: "high" }],
      });
    });
    // Un solo PATCH para las dos ediciones seguidas.
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("«Crear» queda deshabilitado mientras una incluida no tenga proyecto, y con proyecto manda commit sólo con las incluidas", async () => {
    const note = notaTranscrita({
      proposals: [
        propuesta(),
        propuesta({ id: "prop-2", title: "Mandar propuesta a Sonria", project_id: null, project_guess: "Sonria" }),
        propuesta({ id: "prop-3", title: "Idea descartada", include: false, project_id: null }),
      ],
    });
    const { calls } = mockFetch([
      ...rutasBase(note),
      {
        method: "PATCH",
        path: "/api/notes/n1/proposals",
        body: (init: { body: unknown }) => ({
          note: notaTranscrita({
            version: 7,
            proposals: (init.body as { proposals: NoteTaskProposal[] }).proposals,
          }),
        }),
      },
      {
        method: "POST",
        path: "/api/notes/n1/commit-tasks",
        status: 201,
        body: () => {
          const actual = useStore.getState().notes[0]!;
          return {
            note: {
              ...actual,
              status: "converted",
              version: actual.version + 1,
              proposals: actual.proposals.map((p) =>
                p.include ? { ...p, created_task_id: `t-${p.id}` } : p,
              ),
            },
            tasks: [
              { proposalId: "prop-1", taskId: "t-prop-1" },
              { proposalId: "prop-2", taskId: "t-prop-2" },
            ],
          };
        },
      },
      {
        method: "GET",
        path: "/api/tasks/t-prop-1",
        body: {
          task: {
            id: "t-prop-1",
            projectId: project.id,
            title: "Cerrar el presupuesto",
            status: "BACKLOG",
            stage: "ENTENDER",
            priority: "normal",
            version: 1,
            assignees: [],
          },
          events: [],
          artifacts: [],
          runs: [],
        },
      },
    ]);
    renderNotas();
    await screen.findByTestId("propuesta-prop-1");

    const crear = screen.getByTestId("crear-tareas") as HTMLButtonElement;
    expect(crear.textContent).toContain("Crear 2 tareas");
    expect(crear.disabled).toBe(true);
    expect(screen.getByTestId("motivo-crear").textContent).toContain("«Mandar propuesta a Sonria»");

    // El humano elige el proyecto que faltaba (agrupado por cliente).
    const selector = (await screen.findByTestId("propuesta-proyecto-prop-2")) as HTMLSelectElement;
    await waitFor(() => {
      expect(selector.querySelectorAll("optgroup").length).toBe(2);
    });
    fireEvent.change(selector, { target: { value: projectB.id } });

    await waitFor(() => {
      expect((screen.getByTestId("crear-tareas") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId("motivo-crear")).toBeNull();
    // Hasta aquí, nada creado.
    expect(calls.some((c) => c.url.includes("/commit-tasks"))).toBe(false);

    fireEvent.click(screen.getByTestId("crear-tareas"));

    await waitFor(() => {
      const commit = calls.find((c) => c.method === "POST" && c.url.includes("/commit-tasks"));
      expect(commit).toBeTruthy();
      // El pendiente se guardó ANTES de crear, con la elección del proyecto y el excluido tal cual.
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeTruthy();
      const enviadas = (patch!.body as { proposals: NoteTaskProposal[] }).proposals;
      expect(enviadas.find((p) => p.id === "prop-2")?.project_id).toBe(projectB.id);
      expect(enviadas.find((p) => p.id === "prop-3")?.include).toBe(false);
      expect(commit!.body).toMatchObject({ expected_version: 7 });
    });

    // Tras crear: «Creada» con enlace a la ficha; la excluida sigue editable.
    expect(await screen.findAllByText("Creada")).toHaveLength(2);
    expect(await screen.findByText("Con tareas")).toBeTruthy();
    expect(screen.getByTestId("propuesta-incluir-prop-3")).toBeTruthy();

    fireEvent.click(screen.getByTestId("propuesta-abrir-prop-1"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/tasks/t-prop-1"))).toBe(true);
      expect(useStore.getState().taskDetailId).toBe("t-prop-1");
    });
  });

  it("si el proveedor falla al proponer, se enseña el error y no hay propuestas", async () => {
    const note = notaTranscrita();
    mockFetch([
      ...rutasBase(note),
      {
        method: "POST",
        path: "/api/notes/n1/propose",
        status: 502,
        body: {
          error: {
            code: "provider_unavailable",
            message: "No se pudo proponer tareas con 'openai': falta OPENAI_API_KEY",
          },
        },
      },
    ]);
    renderNotas();
    await screen.findByTestId("propuestas-panel");

    fireEvent.click(screen.getByRole("button", { name: /^Proponer tareas$/ }));

    const error = await screen.findByTestId("error-propuestas");
    expect(error.textContent).toContain("OPENAI_API_KEY");
    expect(screen.queryByTestId("crear-tareas")).toBeNull();
  });

  it("en una nota sin transcribir no se ofrece proponer", async () => {
    const note = notaTranscrita({ status: "captured", transcription: null });
    mockFetch(rutasBase(note));
    renderNotas();
    const panel = within(await screen.findByTestId("propuestas-panel"));
    expect(panel.queryByRole("button", { name: /Proponer tareas/ })).toBeNull();
    expect(panel.getByText(/Primero transcribe la nota/)).toBeTruthy();
  });
});
