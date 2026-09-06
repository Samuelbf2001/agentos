/**
 * Ensamblado del prompt en 3 capas (ARCHITECTURE §8/§8b, patrón Hermes):
 *
 *   stable   — identidad del agent card + constitución de plataforma
 *              (PROVENANCE_GUIDANCE + NO_ANSWER_CAME + guía de tools)
 *   context  — proyecto + metodología activa (tabla methodologies) +
 *              resumen del Context Hub + DoD de la tarea
 *   volatile — tarea actual, últimos task_events, timestamp
 *
 * El orden es deliberado: stable primero para maximizar el prefix cache.
 * Función determinista sin estado propio: lee SOLO vía repositorios de @agentos/db.
 */
import { errors, toIso, nowMs, type ProjectType } from "@agentos/shared";
import {
  getActivePrompt,
  getAgent,
  getAgentBySlug,
  getMethodology,
  getProject,
  getTask,
  getThread,
  listDocs,
  listTaskEvents,
  listTasks,
  type Agent,
  type AgentosDb,
  type Project,
  type Task,
  type Thread,
} from "@agentos/db";
import { PLATFORM_CONSTITUTION } from "./constitution.js";

export interface AssembledPrompt {
  stable: string;
  context: string;
  volatile: string;
  /** stable + context + volatile, listo para usarse como system prompt. */
  full: string;
}

export interface AssemblePromptInput {
  /** Agente (fila, id o slug). */
  agent: Agent | string;
  /** Proyecto (fila o id). Opcional para agentes fuera de engagement. */
  project?: Project | string | null;
  /** Tarea actual (fila o id). */
  task?: Task | string | null;
  /** Hilo de conversación que disparó el run (chat) — sus ids REALES van al volatile (H1). */
  thread?: Thread | string | null;
  /** Fuerza una metodología concreta; si no, se deriva del tipo de proyecto. */
  methodologySlug?: string;
  /** Máximo de documentos del Context Hub en el resumen. */
  maxContextDocs?: number;
  /** Máximo de task_events recientes en la capa volatile. */
  maxTaskEvents?: number;
  /** Máximo de tareas del proyecto en el índice de ids reales del volatile. */
  maxBoardTasks?: number;
  /** Instante para el timestamp (tests deterministas). */
  now?: number;
}

/** Metodología activa por tipo de proyecto (seeds en methodologies/*.md). */
export const METHODOLOGY_BY_PROJECT_TYPE: Record<ProjectType, string> = {
  assessment: "assessment-14d",
  transform: "transform",
  ops: "ops",
};

async function resolveAgent(db: AgentosDb, ref: Agent | string): Promise<Agent> {
  if (typeof ref !== "string") return ref;
  const agent = (await getAgent(db, ref)) ?? (await getAgentBySlug(db, ref));
  if (!agent) throw errors.notFound("agent", ref);
  return agent;
}

async function resolveProject(db: AgentosDb, ref: Project | string | null | undefined): Promise<Project | null> {
  if (ref == null) return null;
  if (typeof ref !== "string") return ref;
  const project = await getProject(db, ref);
  if (!project) throw errors.notFound("project", ref);
  return project;
}

async function resolveTask(db: AgentosDb, ref: Task | string | null | undefined): Promise<Task | null> {
  if (ref == null) return null;
  if (typeof ref !== "string") return ref;
  const task = await getTask(db, ref);
  if (!task) throw errors.notFound("task", ref);
  return task;
}

async function resolveThread(db: AgentosDb, ref: Thread | string | null | undefined): Promise<Thread | null> {
  if (ref == null) return null;
  if (typeof ref !== "string") return ref;
  const thread = await getThread(db, ref);
  if (!thread) throw errors.notFound("thread", ref);
  return thread;
}

export async function assemblePrompt(db: AgentosDb, input: AssemblePromptInput): Promise<AssembledPrompt> {
  const agent = await resolveAgent(db, input.agent);
  const project = await resolveProject(db, input.project);
  const task = await resolveTask(db, input.task);
  const thread = await resolveThread(db, input.thread);
  const now = input.now ?? nowMs();

  // ── Capa stable ───────────────────────────────────────────────────────────
  const activePrompt = await getActivePrompt(db, agent.id);
  const identity =
    activePrompt?.stable?.trim() ||
    `Eres ${agent.name} (${agent.slug}), agente de la capa ${agent.layer} de AgentOS Sixteam.`;
  const stable = `${identity}\n\n${PLATFORM_CONSTITUTION}`;

  // ── Capa context ──────────────────────────────────────────────────────────
  const contextParts: string[] = [];
  if (activePrompt?.context?.trim()) contextParts.push(activePrompt.context.trim());

  if (project) {
    contextParts.push(
      `## Proyecto\n- Id (project_id REAL — usa EXACTAMENTE este UUID en tus tools): ${project.id}\n- Nombre: ${project.name}\n- Tipo: ${project.type}\n- Etapa: ${project.stage}\n- Gate 1 (g1_plan): ${project.gateState}`,
    );

    const slug = input.methodologySlug ?? METHODOLOGY_BY_PROJECT_TYPE[project.type];
    const methodology = slug ? await getMethodology(db, slug) : undefined;
    if (methodology) {
      contextParts.push(
        `## Metodología activa: ${methodology.slug} v${methodology.version}\n${methodology.bodyMd.trim()}`,
      );
    } else {
      contextParts.push(
        `## Metodología activa\nSin metodología registrada para "${slug}" — sigue la constitución y pide guía humana si dudas.`,
      );
    }

    const allDocs = await listDocs(db, { projectId: project.id });
    const docs = allDocs.slice(0, input.maxContextDocs ?? 20);
    if (docs.length > 0) {
      const lines = docs.map((d) => `- [doc:${d.id}] (${d.kind}) ${d.title}`);
      contextParts.push(
        `## Context Hub del proyecto (usa knowledge.get/knowledge.search para leer)\n${lines.join("\n")}`,
      );
    } else {
      contextParts.push("## Context Hub del proyecto\n(vacío aún — registra tus hallazgos con knowledge.upsert_doc)");
    }
  }

  if (task?.definitionOfDone?.trim()) {
    contextParts.push(`## Definition of Done de tu tarea\n${task.definitionOfDone.trim()}`);
  }
  const context = contextParts.join("\n\n");

  // ── Capa volatile ─────────────────────────────────────────────────────────
  const volatileParts: string[] = [];
  if (thread) {
    // H1: los ids REALES del contexto de chat, para que el agente jamás los invente.
    volatileParts.push(
      `## Contexto del canal (ids REALES — nunca inventes identificadores)\n` +
        `- thread_id: ${thread.id}\n` +
        `- Proyecto activo del hilo: ${thread.projectId ?? "(sin proyecto activo: pídele el project_id al humano o usa tasks/board SOLO con ids que existan)"}`,
    );
  }
  if (project && !task) {
    // Runs sin tarea reclamada (chat): índice del tablero con los UUIDs reales
    // de las tareas, para que tasks.get/tasks.move/delegate usen ids que existen.
    const allBoardTasks = await listTasks(db, { projectId: project.id });
    const boardIndex = allBoardTasks.slice(0, input.maxBoardTasks ?? 30);
    if (boardIndex.length > 0) {
      // status + version frescos por ensamblado: `version` es el expected_version
      // de tasks.move / tasks.assign_people (el humano puede haber movido la tarjeta).
      const lines = boardIndex.map((t) => `- [task:${t.id}] (${t.status}) ${t.title} · version ${t.version}`);
      volatileParts.push(
        `## Tareas del proyecto (ids REALES — usa EXACTAMENTE estos UUIDs en tus tools)\n` +
          `Formato: [task:id] (status) título · version N. Usa N como expected_version; ` +
          `si recibes version_conflict, relee con board.get y reintenta una vez.\n${lines.join("\n")}`,
      );
    }
  }
  if (task) {
    volatileParts.push(
      `## Tarea actual\n- Id: ${task.id}\n- Título: ${task.title}\n- Estado: ${task.status} (etapa ${task.stage}, prioridad ${task.priority})` +
        (task.description ? `\n- Descripción: ${task.description}` : ""),
    );
    const allEvents = await listTaskEvents(db, task.id);
    const events = allEvents.slice(-(input.maxTaskEvents ?? 10));
    if (events.length > 0) {
      const lines = events.map((e) => {
        const move = e.fromStatus || e.toStatus ? ` ${e.fromStatus ?? "·"}→${e.toStatus ?? "·"}` : "";
        return `- ${toIso(e.createdAt)} ${e.kind}${move} (${e.actor})`;
      });
      volatileParts.push(`## Últimos eventos de la tarea\n${lines.join("\n")}`);
    }
  }
  volatileParts.push(`Timestamp actual: ${toIso(now)}`);
  const volatile = volatileParts.join("\n\n");

  return { stable, context, volatile, full: [stable, context, volatile].filter(Boolean).join("\n\n---\n\n") };
}
