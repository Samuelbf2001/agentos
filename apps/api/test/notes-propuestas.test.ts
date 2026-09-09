/**
 * Notas manuscritas, fase 3 (REST): proponer tareas desde la transcripción →
 * revisar (PATCH con `expected_version`) → crear SÓLO al pulsar "Crear".
 *
 * El proponedor es SIEMPRE un doble (regla dura: nada de LLM real en tests).
 * Lo que se cubre: proponer exige nota transcrita y no crea nada; los ids del
 * modelo se contrastan con el catálogo; las propuestas ya creadas se
 * conservan; el PATCH respeta la versión; `commit-tasks` crea por el motor con
 * el proyecto y la etapa correctos, rechaza sin proyecto sin crear nada, es
 * idempotente, audita y deja el origen en la descripción.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  getTask,
  listTaskAssignees,
  listTasks,
  queryAudit,
  updateCanvasNote,
} from "@agentos/db";
import type { NoteTaskProposal } from "@agentos/shared";
import { makeFixture, type TestFixture } from "./helpers.js";
import type {
  NoteProposer,
  ProposeNoteInput,
  PropuestaModelo,
} from "../src/notes/propuestas.js";

interface NoteWire {
  id: string;
  status: string;
  version: number;
  projectId: string | null;
  transcription: string | null;
  proposals: NoteTaskProposal[];
}

const TRANSCRIPCION = [
  "# Reunión con dirección",
  "- Cerrar el presupuesto con Jorge para el viernes",
  "- Sonria: mandar propuesta de automatización",
  "- Revisar el flujo de cobranza",
].join("\n");

function propuesta(overrides: Partial<PropuestaModelo> = {}): PropuestaModelo {
  return {
    title: "Cerrar el presupuesto",
    description: null,
    project_id: null,
    project_guess: null,
    assignee_person_id: null,
    assignee_guess: null,
    due_at: null,
    priority: "normal",
    source_excerpt: "Cerrar el presupuesto con Jorge para el viernes",
    confidence: "alta",
    ...overrides,
  };
}

/** Doble del proponedor: devuelve lo programado y registra lo que recibe. */
function makeProposer(tareas: PropuestaModelo[] | (() => PropuestaModelo[])) {
  const llamadas: ProposeNoteInput[] = [];
  const proposer: NoteProposer = {
    async propose(input) {
      llamadas.push(input);
      return {
        propuestas: typeof tareas === "function" ? tareas() : tareas,
        proveedor: "openai",
        modelo: "modelo-de-prueba",
        usage: { tokensIn: 900, tokensOut: 120, tokensCacheRead: null, tokensCacheWrite: null },
        costUsd: null,
      };
    },
  };
  return { proposer, llamadas };
}

describe("Notas manuscritas — propuestas de tareas (fase 3)", () => {
  const fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function fx(overrides: Parameters<typeof makeFixture>[0] = {}): Promise<TestFixture> {
    const fixture = await makeFixture(overrides);
    fixtures.push(fixture);
    return fixture;
  }

  async function createNote(fixture: TestFixture, payload: Record<string, unknown> = {}) {
    const res = await fixture.api.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: fixture.authHeaders,
      payload,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { note: NoteWire }).note;
  }

  /** Nota con transcripción revisada: el punto de partida de la fase 3. */
  async function notaTranscrita(fixture: TestFixture, projectId: string | null = fixture.project.id) {
    const note = await createNote(fixture, projectId ? { project_id: projectId } : {});
    const transcrita = await updateCanvasNote(fixture.db, note.id, {
      transcription: TRANSCRIPCION,
      status: "transcribed",
    });
    return transcrita as unknown as NoteWire;
  }

  async function proponer(fixture: TestFixture, noteId: string) {
    return fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/propose`,
      headers: fixture.authHeaders,
    });
  }

  async function leer(fixture: TestFixture, noteId: string): Promise<NoteWire> {
    const res = await fixture.api.app.inject({
      method: "GET",
      url: `/api/notes/${noteId}`,
      headers: fixture.authHeaders,
    });
    return (res.json() as { note: NoteWire }).note;
  }

  it("proponer exige nota transcrita: en borrador da 409 y no llama al modelo", async () => {
    const { proposer, llamadas } = makeProposer([propuesta()]);
    const fixture = await fx({ noteProposer: proposer });
    const note = await createNote(fixture, { project_id: fixture.project.id });

    const res = await proponer(fixture, note.id);
    expect(res.statusCode).toBe(409);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/Transcribir/);
    expect(llamadas).toHaveLength(0);
    expect((await leer(fixture, note.id)).proposals).toEqual([]);
  });

  it("proponer manda la transcripción con los catálogos, guarda las propuestas contrastadas y NO crea tareas", async () => {
    const { proposer, llamadas } = makeProposer(() => [
      propuesta({
        project_id: "id-inventado",
        project_guess: "Sonria",
        assignee_person_id: "persona-inventada",
        assignee_guess: "Jorge",
        due_at: "2026-09-11",
        title: "Mandar propuesta de automatización",
        source_excerpt: "Sonria: mandar propuesta de automatización",
      }),
      propuesta({ title: "Revisar el flujo de cobranza", source_excerpt: "Revisar el flujo de cobranza" }),
    ]);
    const fixture = await fx({ noteProposer: proposer });
    const note = await notaTranscrita(fixture);
    const tareasAntes = (await listTasks(fixture.db)).length;

    const res = await proponer(fixture, note.id);
    expect(res.statusCode).toBe(200);
    const propuesta1 = (res.json() as { note: NoteWire }).note;

    // Recibe TEXTO (no imagen) y los catálogos con nombre de cliente y personas internas.
    expect(llamadas).toHaveLength(1);
    const input = llamadas[0]!;
    expect(input.transcripcion).toBe(TRANSCRIPCION);
    expect(input.proyectoNota?.id).toBe(fixture.project.id);
    expect(input.proyectos.find((p) => p.id === fixture.project.id)?.orgName).toBe("ACME S.A.");
    expect(input.personas.some((p) => p.id === fixture.person.id && p.full_name === "Ernesto")).toBe(true);
    expect(input.hoy).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(propuesta1.version).toBe(note.version + 1);
    expect(propuesta1.status).toBe("transcribed");
    expect(propuesta1.proposals).toHaveLength(2);
    const [sonria, cobranza] = propuesta1.proposals;
    // Un id inventado por el modelo se descarta: queda el nombre para que el humano elija.
    expect(sonria!.project_id).toBeNull();
    expect(sonria!.project_guess).toBe("Sonria");
    expect(sonria!.assignee_person_id).toBeNull();
    expect(sonria!.assignee_guess).toBe("Jorge");
    expect(sonria!.due_at).toBe("2026-09-11");
    expect(sonria!.include).toBe(true);
    expect(sonria!.created_task_id).toBeNull();
    expect(sonria!.id).toBeTruthy();
    // Sin otro proyecto nombrado, hereda el de la nota.
    expect(cobranza!.project_id).toBe(fixture.project.id);
    expect(cobranza!.project_guess).toBeNull();

    // Proponer no crea nada: ni una tarea más en el tablero.
    expect((await listTasks(fixture.db)).length).toBe(tareasAntes);

    const audit = await queryAudit(fixture.db, { entityType: "canvas_note", entityId: note.id });
    const registro = audit.find((a) => a.action === "note.propose");
    expect(registro?.after).toMatchObject({ proposed: 2, kept: 0, model: "modelo-de-prueba", tokensIn: 900 });
  });

  it("el PATCH de propuestas guarda la revisión humana y una versión vieja da 409", async () => {
    const { proposer } = makeProposer([propuesta(), propuesta({ title: "Otra" })]);
    const fixture = await fx({ noteProposer: proposer });
    const note = await notaTranscrita(fixture);
    const propuesta1 = ((await proponer(fixture, note.id)).json() as { note: NoteWire }).note;
    const [primera, segunda] = propuesta1.proposals as [NoteTaskProposal, NoteTaskProposal];

    const editada = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}/proposals`,
      headers: fixture.authHeaders,
      payload: {
        expected_version: propuesta1.version,
        proposals: [
          {
            ...primera,
            title: "Cerrar el presupuesto 2026",
            priority: "high",
            assignee_person_id: fixture.person.id,
            // El cliente no puede fijar esto: sólo lo escribe commit-tasks.
            created_task_id: "colado",
          },
          { ...segunda, include: false },
        ],
      },
    });
    expect(editada.statusCode).toBe(200);
    const nota = (editada.json() as { note: NoteWire }).note;
    expect(nota.version).toBe(propuesta1.version + 1);
    expect(nota.proposals[0]).toMatchObject({
      title: "Cerrar el presupuesto 2026",
      priority: "high",
      assignee_person_id: fixture.person.id,
      created_task_id: null,
    });
    expect(nota.proposals[1]?.include).toBe(false);

    const tarde = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}/proposals`,
      headers: fixture.authHeaders,
      payload: { expected_version: propuesta1.version, proposals: [primera] },
    });
    expect(tarde.statusCode).toBe(409);
    expect((tarde.json() as { error: { code: string } }).error.code).toBe("version_conflict");

    // Un proyecto inexistente no se puede elegir.
    const fantasma = await fixture.api.app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}/proposals`,
      headers: fixture.authHeaders,
      payload: { expected_version: nota.version, proposals: [{ ...primera, project_id: "no-existe" }] },
    });
    expect(fantasma.statusCode).toBe(404);
  });

  it("crear rechaza si alguna incluida no tiene proyecto: 400 que la nombra y ninguna tarea creada", async () => {
    const { proposer } = makeProposer([
      propuesta({ project_guess: "Sonria", title: "Mandar propuesta a Sonria" }),
      propuesta({ title: "Revisar el flujo de cobranza" }),
    ]);
    const fixture = await fx({ noteProposer: proposer });
    const note = await notaTranscrita(fixture);
    const propuesta1 = ((await proponer(fixture, note.id)).json() as { note: NoteWire }).note;
    const tareasAntes = (await listTasks(fixture.db)).length;

    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/commit-tasks`,
      headers: fixture.authHeaders,
      payload: { expected_version: propuesta1.version },
    });
    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("Mandar propuesta a Sonria");

    // Ni la que sí tenía proyecto: o todas o ninguna.
    expect((await listTasks(fixture.db)).length).toBe(tareasAntes);
    const despues = await leer(fixture, note.id);
    expect(despues.status).toBe("transcribed");
    expect(despues.version).toBe(propuesta1.version);
    expect(despues.proposals.every((p) => p.created_task_id === null)).toBe(true);
  });

  it("crear pasa por el motor con proyecto y etapa del destino, deja el origen, audita y es idempotente", async () => {
    const { proposer } = makeProposer([
      propuesta({
        title: "Cerrar el presupuesto",
        description: "Con las cifras de la reunión",
        assignee_person_id: "sin-validar", // se descarta al proponer; se fija abajo por PATCH
        due_at: "2026-09-11",
        priority: "high",
      }),
      propuesta({ title: "Revisar el flujo de cobranza", project_guess: "Otro" }),
      propuesta({ title: "Idea descartada" }),
    ]);
    const fixture = await fx({ noteProposer: proposer });
    const otro = await createProject(fixture.db, {
      orgId: fixture.org.id,
      name: "Operación ACME",
      type: "ops",
      stage: "OPERAR",
      gateState: "approved",
    });
    const note = await notaTranscrita(fixture);
    const propuesta1 = ((await proponer(fixture, note.id)).json() as { note: NoteWire }).note;
    const [primera, segunda, tercera] = propuesta1.proposals as [
      NoteTaskProposal,
      NoteTaskProposal,
      NoteTaskProposal,
    ];

    // El humano completa: responsable en la primera, proyecto en la segunda, excluye la tercera.
    const revisada = (
      (
        await fixture.api.app.inject({
          method: "PATCH",
          url: `/api/notes/${note.id}/proposals`,
          headers: fixture.authHeaders,
          payload: {
            expected_version: propuesta1.version,
            proposals: [
              { ...primera, assignee_person_id: fixture.person.id },
              { ...segunda, project_id: otro.id },
              { ...tercera, include: false },
            ],
          },
        })
      ).json() as { note: NoteWire }
    ).note;

    const tareasAntes = (await listTasks(fixture.db)).length;
    const res = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/commit-tasks`,
      headers: fixture.authHeaders,
      payload: { expected_version: revisada.version },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { note: NoteWire; tasks: { proposalId: string; taskId: string }[] };
    expect(body.tasks).toHaveLength(2);
    expect(body.note.status).toBe("converted");
    expect(body.note.version).toBe(revisada.version + 1);
    expect((await listTasks(fixture.db)).length).toBe(tareasAntes + 2);

    const [creada1, creada2] = body.tasks as [{ proposalId: string; taskId: string }, { proposalId: string; taskId: string }];
    const task1 = (await getTask(fixture.db, creada1.taskId))!;
    expect(task1.projectId).toBe(fixture.project.id);
    expect(task1.stage).toBe(fixture.project.stage); // ENTENDER: la del proyecto destino
    expect(task1.status).toBe("BACKLOG");
    expect(task1.title).toBe("Cerrar el presupuesto");
    expect(task1.priority).toBe("high");
    expect(task1.dueAt).toBe(Date.parse("2026-09-11"));
    expect(task1.description).toContain("Con las cifras de la reunión");
    expect(task1.description?.trim().endsWith(`Origen: nota manuscrita ${note.id}`)).toBe(true);
    expect((await listTaskAssignees(fixture.db, task1.id)).map((a) => a.personId)).toEqual([fixture.person.id]);

    const task2 = (await getTask(fixture.db, creada2.taskId))!;
    expect(task2.projectId).toBe(otro.id);
    expect(task2.stage).toBe("OPERAR");

    // Cada propuesta creada apunta a su tarea; la excluida sigue sin crear.
    const porId = new Map(body.note.proposals.map((p) => [p.id, p]));
    expect(porId.get(primera.id)?.created_task_id).toBe(task1.id);
    expect(porId.get(segunda.id)?.created_task_id).toBe(task2.id);
    expect(porId.get(tercera.id)?.created_task_id).toBeNull();

    // Los eventos de tablero de siempre (`task.created`) están en el bus: la UI las ve en vivo.
    const eventos = await fixture.api.ctx.bus.getSince(`board:${fixture.project.id}`, 0);
    expect(eventos.filter((e) => e.type === "task.created").length).toBeGreaterThanOrEqual(1);

    const audit = await queryAudit(fixture.db, { entityType: "canvas_note", entityId: note.id });
    const registro = audit.find((a) => a.action === "note.tasks_created");
    expect(registro?.after).toMatchObject({ status: "converted", taskIds: [task1.id, task2.id] });
    expect(registro?.actor).toBe(`person:${fixture.person.id}`);

    // Reintentar con la versión nueva no duplica: las creadas se saltan.
    const otraVez = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/commit-tasks`,
      headers: fixture.authHeaders,
      payload: { expected_version: body.note.version },
    });
    expect(otraVez.statusCode).toBe(200);
    expect((otraVez.json() as { tasks: unknown[] }).tasks).toEqual([]);
    expect((await listTasks(fixture.db)).length).toBe(tareasAntes + 2);

    // Reintentar con la versión vieja: 409 y tampoco crea nada.
    const vieja = await fixture.api.app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/commit-tasks`,
      headers: fixture.authHeaders,
      payload: { expected_version: revisada.version },
    });
    expect(vieja.statusCode).toBe(409);
    expect((await listTasks(fixture.db)).length).toBe(tareasAntes + 2);
  });

  it("volver a proponer sobre una nota convertida conserva las propuestas ya creadas", async () => {
    let ronda = 0;
    const { proposer } = makeProposer(() =>
      ronda++ === 0
        ? [propuesta({ title: "Cerrar el presupuesto" })]
        : [propuesta({ title: "Nueva acción de la segunda lectura" })],
    );
    const fixture = await fx({ noteProposer: proposer });
    const note = await notaTranscrita(fixture);
    const propuesta1 = ((await proponer(fixture, note.id)).json() as { note: NoteWire }).note;
    const creada = (
      (
        await fixture.api.app.inject({
          method: "POST",
          url: `/api/notes/${note.id}/commit-tasks`,
          headers: fixture.authHeaders,
          payload: { expected_version: propuesta1.version },
        })
      ).json() as { note: NoteWire }
    ).note;
    expect(creada.status).toBe("converted");
    const taskId = creada.proposals[0]!.created_task_id;
    expect(taskId).toBeTruthy();

    const res = await proponer(fixture, note.id);
    expect(res.statusCode).toBe(200);
    const nota = (res.json() as { note: NoteWire }).note;
    expect(nota.status).toBe("converted");
    expect(nota.proposals).toHaveLength(2);
    expect(nota.proposals[0]).toMatchObject({ title: "Cerrar el presupuesto", created_task_id: taskId });
    expect(nota.proposals[1]).toMatchObject({
      title: "Nueva acción de la segunda lectura",
      created_task_id: null,
      include: true,
    });
  });
});
