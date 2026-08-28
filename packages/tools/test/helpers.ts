/** Fixtures de test del gateway: DB en memoria + agentes con allowlist real. */
import path from "node:path";
import os from "node:os";
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
  type Person,
  type Project,
  type Run,
} from "@agentos/db";
import { createBoardEngine, recordingEventSink, type BoardEngine } from "@agentos/core";
import { createToolRuntime } from "../src/gateway.js";
import type { ToolCallContext, ToolDefinition, ToolRuntime } from "../src/types.js";

export interface ToolsFixture {
  db: AgentosDb;
  engine: BoardEngine;
  runtime: ToolRuntime;
  person: Person;
  project: Project;
  alex: Agent; // allowlist amplia
  quinn: Agent; // allowlist mínima (solo lectura)
  run: Run;
  ctxFor(agent: Agent): ToolCallContext;
  humanCtx(): ToolCallContext;
}

export const ALEX_ALLOWLIST = [
  "tasks.create",
  "tasks.claim",
  "tasks.move",
  "tasks.comment",
  "tasks.attach_artifact",
  "tasks.list",
  "tasks.get",
  "board.get",
  "projects.get",
  "projects.update",
  "artifacts.write",
  "delegate",
  "ask_human",
  "knowledge.search",
  "knowledge.get",
  "knowledge.upsert_doc",
  "knowledge.list",
  "processes.list",
  "processes.get",
  "processes.upsert",
  "processes.link_source",
  "methodology.get",
  "methodology.list",
  "email.send",
  "spy.audit",
  "spy.fail",
];

export function toolsFixture(extraTools: ToolDefinition[] = []): ToolsFixture {
  const db = openDb(":memory:");
  runMigrations(db);
  const org = createOrganization(db, { name: "ACME S.A.", kind: "client" });
  const person = createPerson(db, { orgId: org.id, fullName: "Ernesto", isInternal: true });
  const project = createProject(db, {
    orgId: org.id,
    name: "Assessment ACME",
    type: "assessment",
    workspacePath: path.join(os.tmpdir(), `agentos-test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  });
  const alex = createAgent(db, {
    slug: "alex",
    name: "Alex",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: ALEX_ALLOWLIST,
  });
  const quinn = createAgent(db, {
    slug: "quinn",
    name: "Quinn",
    layer: "meta",
    runtime: "ai_sdk",
    toolsAllowlist: ["tasks.list", "tasks.get", "board.get"],
  });
  const run = createRun(db, { trigger: "manual", runtime: "ai_sdk", agentId: alex.id });
  const sink = recordingEventSink();
  const engine = createBoardEngine({ db, sink });
  const runtime = createToolRuntime({ db, sink, engine, extraTools });
  return {
    db,
    engine,
    runtime,
    person,
    project,
    alex,
    quinn,
    run,
    ctxFor: (agent) => ({
      run_id: run.id,
      agent_id: agent.id,
      task_id: null,
      project_id: project.id,
      actor: `agent:${agent.slug}`,
    }),
    humanCtx: () => ({
      run_id: null,
      agent_id: alex.id,
      task_id: null,
      project_id: project.id,
      actor: `person:${person.id}`,
    }),
  };
}
