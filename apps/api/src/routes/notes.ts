/**
 * Notas manuscritas: un lienzo Excalidraw donde se escribe con tableta
 * gráfica, autoguardado desde la interfaz, un PNG limpio al pulsar "Terminar
 * notas" y, sobre ese PNG, la transcripción con un modelo de visión que el
 * humano puede corregir a mano (PATCH con `transcription`).
 *
 * Reglas heredadas del repo:
 * - `expected_version` en el guardado → 409 `version_conflict`, igual que
 *   `/api/tasks/:id`. El autoguardado no hace last-write-wins en silencio.
 * - El binario NUNCA entra en la base: se escribe bajo la raíz de artefactos
 *   (`AGENTOS_ARTIFACTS_DIR` …) y la fila guarda la ruta relativa, misma
 *   frontera que `artifacts.path` (ARCHITECTURE §5, adenda 2026-09-05).
 * - Toda mutación audita.
 *
 * `image_artifact_id` sólo se puede rellenar cuando la captura viene con
 * `task_id`: `artifacts.task_id` es NOT NULL y una nota no es una tarea. Sin
 * tarea, la nota se basta con su propia ruta (`GET /api/notes/:id/image`).
 *
 * Fase 3 (propuestas → tareas): `propose` sólo PROPONE y guarda la lista en la
 * nota; `proposals` (PATCH) guarda la revisión humana; `commit-tasks` es la
 * única orden que crea tarjetas, y lo hace por el mismo camino que
 * `POST /api/tasks`. Ninguna tarea nace sin esa orden explícita.
 */
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CanvasNoteStatus,
  NoteTaskProposal,
  emptyCanvasScene,
  errors,
  newId,
} from "@agentos/shared";
import {
  appendAudit,
  attachArtifact,
  captureCanvasNote,
  createCanvasNote,
  getCanvasNote,
  getProject,
  getTask,
  listCanvasNotes,
  listOrganizations,
  listPeople,
  listProjects,
  updateCanvasNote,
  type Project,
} from "@agentos/db";
import {
  artifactsRoot,
  maxArtifactBytes,
  resolveArtifactPath,
  storeCanvasNoteImage,
} from "../artifact-files.js";
import type { ApiContext } from "../context.js";
import { parse } from "../http-errors.js";
import {
  normalizarPropuestas,
  type PersonaCatalogo,
  type ProyectoCatalogo,
} from "../notes/propuestas.js";
import { segmentarEscena } from "../notes/segmentacion.js";
import { limpiarMarcadores } from "../notes/transcripcion.js";
import { validatePeopleForProject } from "../task-contract.js";
import { createTaskFromBody } from "../task-create.js";

/** La escena es JSON opaco de Excalidraw: se valida la forma mínima, no el contenido. */
const Scene = z.object({ elements: z.array(z.unknown()) }).catchall(z.unknown());

const ListQuery = z.object({
  project_id: z.string().optional(),
  status: CanvasNoteStatus.optional(),
});

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  project_id: z.string().optional(),
});

const UpdateBody = z.object({
  title: z.string().min(1).max(200).optional(),
  scene: Scene.optional(),
  /** Corrección humana de la transcripción (cadena vacía = borrarla). */
  transcription: z.string().max(200_000).optional(),
  expected_version: z.number().int().positive().optional(),
});

const CaptureBody = z.object({
  /** PNG en base64 (con o sin prefijo data:). */
  image_base64: z.string().min(1),
  /** Opcional: ancla el PNG a una tarea y crea además su fila en `artifacts`. */
  task_id: z.string().optional(),
  /**
   * Captura intermedia: guarda el PNG sin cambiar el estado (un borrador sigue
   * en borrador). Es lo que usa «Transcribir» mientras se sigue escribiendo.
   */
  keep_status: z.boolean().optional(),
});

/**
 * `interim`: transcribe lo que hay y la nota sigue como está (un borrador
 * sigue editable). `final`: «Terminar nota», pasa a `transcribed`. Por defecto
 * `final`, que es lo que hacía la ruta antes de existir el modo.
 */
const TranscribeBody = z.object({ mode: z.enum(["interim", "final"]).default("final") });

/** Lista revisada por el humano; `created_task_id` se ignora (sólo lo fija `commit-tasks`). */
const ProposalsBody = z.object({
  expected_version: z.number().int().positive(),
  proposals: z.array(NoteTaskProposal).max(100),
});

const CommitTasksBody = z.object({
  expected_version: z.number().int().positive(),
});

const DATA_URL_PREFIX = /^data:image\/png;base64,/i;

export function registerNoteRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.get("/api/notes", async (req) => {
    const query = parse(ListQuery, req.query);
    const notes = await listCanvasNotes(db, {
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    return { notes };
  });

  /** Nace en borrador y con la escena vacía: escribir es el primer gesto, no rellenar un formulario. */
  app.post("/api/notes", async (req, reply) => {
    const body = parse(CreateBody, req.body);
    let orgId: string | null = null;
    if (body.project_id) {
      const project = await getProject(db, body.project_id);
      if (!project) throw errors.notFound("project", body.project_id);
      orgId = project.orgId;
    }
    const note = await createCanvasNote(db, {
      orgId,
      projectId: body.project_id ?? null,
      title: body.title?.trim() || "Notas sin título",
      scene: emptyCanvasScene(),
      status: "draft",
      createdByPersonId: req.session!.personId,
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.create",
      entityType: "canvas_note",
      entityId: note.id,
      after: { title: note.title, projectId: note.projectId },
    });
    reply.status(201);
    return { note };
  });

  app.get("/api/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    return { note };
  });

  /** Autoguardado del lienzo. Con `expected_version`, el conflicto es 409 y no se pierde nada. */
  app.patch("/api/notes/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(UpdateBody, req.body);
    const before = await getCanvasNote(db, id);
    if (!before) throw errors.notFound("canvas_note", id);
    if (body.title === undefined && body.scene === undefined && body.transcription === undefined) {
      throw errors.validation("Nada que guardar: manda `title`, `scene`, `transcription` o varios");
    }

    // La corrección humana del texto es tan válida como la del modelo: se
    // guarda tal cual (vacía = se borra) y no cambia el estado de la nota.
    const transcription =
      body.transcription === undefined ? undefined : body.transcription.trim() || null;

    const note = await updateCanvasNote(
      db,
      id,
      {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.scene !== undefined
          ? { scene: body.scene as { elements: readonly unknown[] } }
          : {}),
        ...(transcription !== undefined ? { transcription } : {}),
      },
      body.expected_version,
    );
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.update",
      entityType: "canvas_note",
      entityId: id,
      before: { version: before.version, title: before.title },
      after: {
        version: note.version,
        title: note.title,
        elements: note.scene.elements.length,
        ...(transcription !== undefined
          ? { transcriptionChars: transcription?.length ?? 0, transcriptionEditedBy: "human" }
          : {}),
      },
    });
    return { note };
  });

  /**
   * Captura: recibe el PNG ya exportado por el lienzo (escala 3, fondo blanco,
   * recortado al contenido) y lo guarda. Sin `keep_status` la nota pasa a
   * `captured` (camino de «Terminar nota»); con `keep_status: true` sólo se
   * renueva la imagen y el estado no se toca (camino de «Transcribir» sobre
   * un borrador que se sigue escribiendo). Se eligió esta bandera frente a
   * mandar la imagen inline a `/transcribe` para que la imagen tenga un único
   * dueño (esta ruta: límite de tamaño, disco, artefacto) y `/transcribe`
   * siga leyendo siempre del disco.
   */
  // El PNG viaja en base64 (4/3 del binario): el límite por defecto de
  // Fastify (1 MiB) devolvía 413 con una nota grande antes de llegar siquiera
  // a la comprobación de tamaño de abajo. Se alinea con el tope de artefactos.
  const captureBodyLimit = Math.ceil((maxArtifactBytes() * 4) / 3) + 64 * 1024;
  app.post("/api/notes/:id/capture", { bodyLimit: captureBodyLimit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CaptureBody, req.body);
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);

    const base64 = body.image_base64.replace(DATA_URL_PREFIX, "").trim();
    let data: Buffer;
    try {
      data = Buffer.from(base64, "base64");
    } catch {
      throw errors.validation("El PNG no es base64 válido");
    }
    if (data.byteLength === 0) throw errors.validation("La imagen está vacía");
    if (data.byteLength > maxArtifactBytes()) {
      return reply.status(413).send({
        error: {
          code: "file_too_large",
          message: `La imagen supera el límite de ${Math.round(maxArtifactBytes() / (1024 * 1024))} MB`,
        },
      });
    }

    const project = (note.projectId ? await getProject(db, note.projectId) : null) ?? null;
    const root = artifactsRoot(project);
    const stored = storeCanvasNoteImage({
      root,
      noteId: note.id,
      sequence: note.version,
      data,
    });

    // Sólo con tarea puede existir fila en `artifacts` (su task_id es NOT NULL).
    let artifactId: string | null = null;
    if (body.task_id) {
      const task = await getTask(db, body.task_id);
      if (!task) throw errors.notFound("task", body.task_id);
      const artifact = await attachArtifact(db, {
        id: newId(),
        taskId: task.id,
        kind: "file",
        title: note.title,
        content: null,
        path: stored.relativePath,
        meta: {
          originalName: `${note.title}.png`,
          mimeType: "image/png",
          bytes: stored.bytes,
          storage: "artifacts_root",
          canvasNoteId: note.id,
        },
        createdBy: personActor(req),
      });
      artifactId = artifact.id;
    }

    const captured = await captureCanvasNote(db, id, {
      imagePath: stored.relativePath,
      imageBytes: stored.bytes,
      imageArtifactId: artifactId,
      ...(body.keep_status ? { keepStatus: true } : {}),
    });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.capture",
      entityType: "canvas_note",
      entityId: id,
      before: { status: note.status },
      after: {
        status: captured.status,
        bytes: stored.bytes,
        artifactId,
        keepStatus: body.keep_status === true,
      },
    });
    reply.status(201);
    return { note: captured };
  });

  /**
   * Transcribe la nota con el modelo de visión. Exige que la imagen ya exista
   * en disco (`POST /capture`), pero NO que la nota haya salido de borrador:
   *
   * - `mode: "interim"` («Transcribir» mientras se escribe): guarda el
   *   Markdown en `transcription`, sube la versión y deja el estado como está.
   *   Una nota `converted` ya tiene tareas: no admite intermedias (409).
   * - `mode: "final"` («Terminar nota», y el valor por defecto): además pasa
   *   la nota a `transcribed`, lista para proponer tareas.
   *
   * Devuelve, junto a la nota, el texto por región casado con las cajas de
   * la segmentación (índice = bloque; los índices que el modelo invente se
   * descartan) y la altura típica del trazo, para que el lienzo lo pinte
   * junto a cada trazo. Nada de eso se persiste: el lienzo es el almacén.
   *
   * Si el proveedor no está configurado o falla, sale `provider_unavailable`
   * (502) y la nota NO se toca: jamás se guarda una transcripción inventada.
   */
  app.post("/api/notes/:id/transcribe", async (req) => {
    const { id } = req.params as { id: string };
    const { mode } = parse(TranscribeBody, req.body);
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    if (!note.imagePath) {
      throw errors.conflict(
        "La nota no tiene imagen: captura el lienzo (POST /capture) antes de transcribir",
        { noteId: id, status: note.status },
      );
    }
    if (mode === "interim" && note.status === "converted") {
      throw errors.conflict(
        "La nota ya tiene tareas creadas: no admite transcripciones intermedias, usa «Terminar nota»",
        { noteId: id, status: note.status, mode },
      );
    }

    const project = (note.projectId ? await getProject(db, note.projectId) : null) ?? null;
    const absolute = resolveArtifactPath(artifactsRoot(project), note.imagePath);
    if (!fs.existsSync(absolute)) throw errors.notFound("canvas_note_image", id);
    const imagen = fs.readFileSync(absolute);

    const segmentacion = segmentarEscena(note.scene);
    const leido = await ctx.noteTranscriber.transcribe({
      imagen,
      segmentacion,
      titulo: note.title,
    });
    // El prompt pide marcar cada duda con `[?]` (es lo que evita inventos),
    // pero el humano no quiere verlos: la lectura elegida basta, y lo incierto
    // viaja aparte en `dudas`. Se limpia aquí, sobre lo que devuelva cualquier
    // transcriptor (el real o un doble), antes de guardar y de responder.
    const resultado = {
      ...leido,
      markdown: limpiarMarcadores(leido.markdown).trim(),
      bloques: leido.bloques.map((b) => ({ ...b, texto: limpiarMarcadores(b.texto).trim() })),
    };

    const transcrita = await updateCanvasNote(db, id, {
      transcription: resultado.markdown,
      ...(mode === "final" ? { status: "transcribed" as const } : {}),
    });

    // Texto del modelo + caja de la segmentación, por índice. Un índice que no
    // exista en la escena no tiene dónde ir; uno repetido se queda con el primero.
    const vistos = new Set<number>();
    const bloques = resultado.bloques.flatMap((b) => {
      const seg = segmentacion.bloques[b.bloque];
      if (!seg || vistos.has(b.bloque)) return [];
      vistos.add(b.bloque);
      return [{ bloque: b.bloque, caja: seg.caja, texto: b.texto }];
    });

    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.transcribe",
      entityType: "canvas_note",
      entityId: id,
      before: { status: note.status, version: note.version },
      after: {
        mode,
        status: transcrita.status,
        version: transcrita.version,
        provider: resultado.proveedor,
        model: resultado.modelo,
        chars: resultado.markdown.length,
        tokensIn: resultado.usage.tokensIn,
        tokensOut: resultado.usage.tokensOut,
        costUsd: resultado.costUsd,
        blocks: segmentacion.resumen.bloques,
        blocksRead: bloques.length,
        blocksDropped: resultado.bloques.length - bloques.length,
        lines: segmentacion.resumen.renglones,
        doubts: resultado.dudas.length,
      },
    });
    return {
      note: transcrita,
      bloques,
      dudas: resultado.dudas,
      alturaTipica: segmentacion.resumen.alturaTipica,
    };
  });

  // ── Fase 3: proponer tareas → revisar → crear (sólo con orden explícita) ──

  /** Catálogo de proyectos con el nombre del cliente: lo que el modelo ve y lo que valida la ruta. */
  async function catalogoProyectos(): Promise<ProyectoCatalogo[]> {
    const [projects, orgs] = await Promise.all([listProjects(db), listOrganizations(db)]);
    const orgNameById = new Map(orgs.map((org) => [org.id, org.name]));
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      orgName: orgNameById.get(project.orgId) ?? null,
    }));
  }

  async function personasInternas(): Promise<PersonaCatalogo[]> {
    return (await listPeople(db))
      .filter((person) => person.isInternal)
      .map((person) => ({ id: person.id, full_name: person.fullName }));
  }

  /**
   * Propone tareas a partir de la transcripción. Exige que la nota esté
   * `transcribed` (o `converted`, para volver a proponer tras crear algunas).
   * Se manda el TEXTO revisado, no la imagen. Las propuestas se guardan en la
   * nota reemplazando las anteriores que no llegaron a crearse; las que ya
   * tienen `created_task_id` se conservan. NO crea ninguna tarea.
   */
  app.post("/api/notes/:id/propose", async (req) => {
    const { id } = req.params as { id: string };
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    const transcripcion = note.transcription?.trim() ?? "";
    if ((note.status !== "transcribed" && note.status !== "converted") || !transcripcion) {
      throw errors.conflict(
        "La nota no está transcrita: pulsa «Transcribir» y revisa el texto antes de proponer tareas",
        { noteId: id, status: note.status },
      );
    }

    const proyectos = await catalogoProyectos();
    const proyectoNota = note.projectId
      ? (proyectos.find((p) => p.id === note.projectId) ?? null)
      : null;
    const personas = await personasInternas();
    const resultado = await ctx.noteProposer.propose({
      transcripcion,
      titulo: note.title,
      proyectoNota,
      proyectos,
      personas,
      hoy: new Date().toISOString().slice(0, 10),
    });

    // Los ids del modelo se contrastan con el catálogo real: nada inventado.
    const nuevas: NoteTaskProposal[] = normalizarPropuestas(resultado.propuestas, {
      proyectos,
      personas,
      proyectoNota,
    }).map((p) => ({ id: newId(), include: true, ...p, created_task_id: null }));
    const creadas = note.proposals.filter((p) => p.created_task_id);
    const proposals = [...creadas, ...nuevas];

    const updated = await updateCanvasNote(db, id, { proposals });
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.propose",
      entityType: "canvas_note",
      entityId: id,
      before: { version: note.version, proposals: note.proposals.length },
      after: {
        version: updated.version,
        proposed: nuevas.length,
        kept: creadas.length,
        provider: resultado.proveedor,
        model: resultado.modelo,
        tokensIn: resultado.usage.tokensIn,
        tokensOut: resultado.usage.tokensOut,
        costUsd: resultado.costUsd,
      },
    });
    return { note: updated };
  });

  /**
   * Guarda la lista revisada por el humano (incluir/excluir, título, proyecto,
   * responsable, fecha, prioridad). Con `expected_version`: 409 si otra
   * pestaña la cambió. Las propuestas ya creadas no se tocan: se devuelven tal
   * cual estaban aunque el cliente mande otra cosa, y se conservan si faltan.
   */
  app.patch("/api/notes/:id/proposals", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(ProposalsBody, req.body);
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);

    const creadasPorId = new Map(
      note.proposals.filter((p) => p.created_task_id).map((p) => [p.id, p] as const),
    );
    const proyectos = new Set((await listProjects(db)).map((p) => p.id));
    const personas = new Set((await listPeople(db)).map((p) => p.id));
    const vistas = new Set<string>();
    const proposals: NoteTaskProposal[] = [];
    for (const p of body.proposals) {
      if (vistas.has(p.id)) throw errors.validation(`Propuesta repetida: ${p.id}`, { proposalId: p.id });
      vistas.add(p.id);
      const creada = creadasPorId.get(p.id);
      if (creada) {
        proposals.push(creada);
        continue;
      }
      const title = p.title.trim();
      if (!title) throw errors.validation("Una propuesta no puede quedarse sin título", { proposalId: p.id });
      if (p.project_id && !proyectos.has(p.project_id)) throw errors.notFound("project", p.project_id);
      if (p.assignee_person_id && !personas.has(p.assignee_person_id)) {
        throw errors.notFound("person", p.assignee_person_id);
      }
      const description = p.description?.trim();
      proposals.push({
        ...p,
        title,
        ...(description ? { description } : {}),
        ...(description === "" ? { description: undefined } : {}),
        // Sólo `commit-tasks` fija este campo: el cliente jamás lo escribe.
        created_task_id: null,
      });
    }
    for (const [proposalId, creada] of creadasPorId) {
      if (!vistas.has(proposalId)) proposals.push(creada);
    }

    const updated = await updateCanvasNote(db, id, { proposals }, body.expected_version);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "note.proposals_edit",
      entityType: "canvas_note",
      entityId: id,
      before: { version: note.version, proposals: note.proposals.length },
      after: {
        version: updated.version,
        proposals: proposals.length,
        included: proposals.filter((p) => p.include && !p.created_task_id).length,
      },
    });
    return { note: updated };
  });

  /**
   * "Crear N tareas": la ÚNICA orden que crea algo. Toma las propuestas
   * incluidas y aún sin `created_task_id`, exige proyecto en todas (si falta en
   * alguna, 400 y no se crea ninguna) y las crea por el MISMO camino que
   * `POST /api/tasks` (`createTaskFromBody`: motor del tablero + repositorios;
   * publica `task.created` en `board:<projectId>`). Etapa = la del proyecto
   * destino. Idempotente: las ya creadas se saltan; si falla a medias, los ids
   * ya creados se persisten antes de propagar el error para que el reintento
   * no duplique.
   */
  app.post("/api/notes/:id/commit-tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(CommitTasksBody, req.body);
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    // La versión se comprueba ANTES de crear nada: un 409 después de crear
    // tareas dejaría el tablero cambiado y la nota sin enterarse.
    if (note.version !== body.expected_version) {
      throw errors.versionConflict("canvas_note", id, body.expected_version);
    }

    const incluidas = note.proposals.filter((p) => p.include);
    if (incluidas.length === 0) {
      throw errors.validation("No hay propuestas incluidas: marca al menos una antes de crear", {
        noteId: id,
      });
    }
    const pendientes = incluidas.filter((p) => !p.created_task_id);
    const sinProyecto = pendientes.filter((p) => !p.project_id);
    if (sinProyecto.length > 0) {
      throw errors.validation(
        `Cada tarea necesita proyecto; falta en ${sinProyecto.map((p) => `«${p.title}»`).join(", ")}`,
        { noteId: id, proposalIds: sinProyecto.map((p) => p.id) },
      );
    }

    // Todo lo que pueda fallar por datos se valida antes de crear la primera.
    const proyectos = new Map<string, Project>();
    for (const p of pendientes) {
      const projectId = p.project_id!;
      if (!proyectos.has(projectId)) {
        const project = await getProject(db, projectId);
        if (!project) throw errors.notFound("project", projectId);
        proyectos.set(projectId, project);
      }
      if (p.assignee_person_id) {
        await validatePeopleForProject(db, proyectos.get(projectId)!, [p.assignee_person_id], p.assignee_person_id);
      }
    }

    const actor = personActor(req);
    const creadas: { proposalId: string; taskId: string }[] = [];

    /** Fija `created_task_id` sobre la versión MÁS RECIENTE de la nota y la pasa a `converted`. */
    const persistir = async () => {
      const latest = (await getCanvasNote(db, id)) ?? note;
      const taskPorPropuesta = new Map(creadas.map((c) => [c.proposalId, c.taskId] as const));
      const proposals = latest.proposals.map((p) =>
        taskPorPropuesta.has(p.id) ? { ...p, created_task_id: taskPorPropuesta.get(p.id)! } : p,
      );
      // Si otra pestaña quitó una propuesta mientras se creaba, su tarea ya
      // existe: se vuelve a anotar para que nadie la cree dos veces.
      const presentes = new Set(proposals.map((p) => p.id));
      for (const p of pendientes) {
        if (taskPorPropuesta.has(p.id) && !presentes.has(p.id)) {
          proposals.push({ ...p, created_task_id: taskPorPropuesta.get(p.id)! });
        }
      }
      return updateCanvasNote(db, id, {
        proposals,
        ...(creadas.length > 0 ? { status: "converted" as const } : {}),
      });
    };

    try {
      for (const p of pendientes) {
        const project = proyectos.get(p.project_id!)!;
        const description = [p.description?.trim(), `Origen: nota manuscrita ${note.id}`]
          .filter((part): part is string => !!part)
          .join("\n\n");
        const dueAt = p.due_at ? Date.parse(p.due_at) : Number.NaN;
        const task = await createTaskFromBody(ctx, {
          actor,
          log: req.log,
          body: {
            project_id: project.id,
            title: p.title,
            stage: project.stage,
            description,
            priority: p.priority,
            ...(p.assignee_person_id ? { assignee_person_id: p.assignee_person_id } : {}),
            ...(Number.isFinite(dueAt) ? { due_at: dueAt } : {}),
          },
        });
        creadas.push({ proposalId: p.id, taskId: task.id });
      }
    } catch (err) {
      if (creadas.length > 0) await persistir();
      throw err;
    }

    const updated = creadas.length > 0 ? await persistir() : note;
    if (creadas.length > 0) {
      await appendAudit(db, {
        actor,
        source: "ui",
        action: "note.tasks_created",
        entityType: "canvas_note",
        entityId: id,
        before: { version: note.version, status: note.status },
        after: {
          version: updated.version,
          status: updated.status,
          taskIds: creadas.map((c) => c.taskId),
          proposalIds: creadas.map((c) => c.proposalId),
        },
      });
    }
    reply.status(creadas.length > 0 ? 201 : 200);
    return { note: updated, tasks: creadas };
  });

  /** El PNG de la nota. Misma defensa contra path traversal que la descarga de artefactos. */
  app.get("/api/notes/:id/image", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = await getCanvasNote(db, id);
    if (!note) throw errors.notFound("canvas_note", id);
    if (!note.imagePath) throw errors.notFound("canvas_note_image", id);
    const project = (note.projectId ? await getProject(db, note.projectId) : null) ?? null;
    const absolute = resolveArtifactPath(artifactsRoot(project), note.imagePath);
    if (!fs.existsSync(absolute)) throw errors.notFound("canvas_note_image", id);
    reply.header("content-type", "image/png");
    return reply.send(fs.createReadStream(absolute));
  });
}
