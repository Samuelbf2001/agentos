/** Fixtures de test: DB en memoria migrada + org/proyecto/personas/agentes. */
import {
  createAgent,
  createOrganization,
  createPerson,
  createProject,
  createRun,
  openDb,
  runMigrations,
  type Agent,
  type AgentosDb,
  type Organization,
  type Person,
  type Project,
  type Run,
} from "@agentos/db";
import { createBoardEngine, recordingEventSink, type BoardEngine, type EventSink } from "../src/index.js";

export interface Fixture {
  db: AgentosDb;
  sink: EventSink & { published: { topic: string; event: { type: string } }[] };
  engine: BoardEngine;
  org: Organization;
  person: Person;
  project: Project;
  alex: Agent; // orquestador
  sam: Agent;
  run: Run;
}

export function fixture(): Fixture {
  const db = openDb(":memory:");
  runMigrations(db);
  const org = createOrganization(db, { name: "ACME S.A.", kind: "client" });
  const person = createPerson(db, { orgId: org.id, fullName: "Ernesto", isInternal: true });
  const project = createProject(db, { orgId: org.id, name: "Assessment ACME", type: "assessment" });
  const alex = createAgent(db, {
    slug: "alex",
    name: "Alex",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: [],
  });
  const sam = createAgent(db, {
    slug: "sam",
    name: "Sam",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: [],
  });
  const run = createRun(db, { trigger: "manual", runtime: "ai_sdk", agentId: alex.id });
  const sink = recordingEventSink();
  const engine = createBoardEngine({ db, sink });
  return { db, sink, engine, org, person, project, alex, sam, run };
}

/** Crea una tarea lista para trabajar (DoD + asignada) en el estado pedido. */
export function seedTask(
  f: Fixture,
  overrides: {
    status?: "BACKLOG" | "READY" | "IN_PROGRESS" | "BLOCKED" | "REVIEW";
    stage?: "ENTENDER" | "CONSTRUIR" | "OPERAR";
    assignee?: Agent | null;
    requiresApproval?: boolean;
    definitionOfDone?: string | null;
  } = {},
) {
  const task = f.engine.createTask(
    {
      projectId: f.project.id,
      title: "Mapear proceso de ventas",
      stage: overrides.stage ?? "ENTENDER",
      definitionOfDone:
        overrides.definitionOfDone === undefined ? "Proceso documentado con SIPOC" : overrides.definitionOfDone,
      assigneeAgentId: overrides.assignee === undefined ? f.sam.id : (overrides.assignee?.id ?? null),
      requiresApproval: overrides.requiresApproval,
    },
    { actor: "person:" + f.person.id },
  );
  const target = overrides.status ?? "BACKLOG";
  if (target === "BACKLOG") return task;
  // Setup directo (fuera de la máquina) para no acoplar tests entre sí.
  f.db.$client
    .prepare(`UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?`)
    .run(target, task.id);
  return { ...task, status: target, version: task.version + 1 };
}
