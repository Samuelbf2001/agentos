/**
 * Portabilidad SQLite ↔ Postgres — lo que se puede probar SIN una base Postgres.
 * Esta suite corre SIEMPRE (no depende de AGENTOS_PG_URL ni de Docker).
 */
import { describe, expect, it } from "vitest";
import { Table, getTableName, is } from "drizzle-orm";
import * as liteSchema from "../src/schema.js";
import { PG_TABLE_ORDER } from "../src/pg/schema-pg.js";
import * as pgSchema from "../src/pg/schema-pg.js";
import { TABLE_PAIRS, redactUrl } from "../src/pg/migrate-to-pg.js";
import { resolveDriver, isPostgresDriver } from "../src/driver.js";
import {
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  resolveEmbeddingProvider,
  toPgVector,
} from "../src/embeddings.js";
import { looksLikeTransactionPooler } from "../src/pg/client-pg.js";
import type * as liteTypes from "../src/types.js";
import type * as pgTypes from "../src/pg/types-pg.js";

// ── Equivalencia de tipos (se valida al COMPILAR, no al ejecutar) ───────────
// Si algún día una columna deja de ser estructuralmente idéntica entre motores,
// `pnpm -r typecheck` falla aquí y NO en `packages/core` — que es justo lo que
// NFR-9 pide: el cambio de motor no se filtra fuera de la capa de datos.

type AssertAssignable<A, B extends A> = B;
type _TaskLiteToPg = AssertAssignable<pgTypes.Task, liteTypes.Task>;
type _TaskPgToLite = AssertAssignable<liteTypes.Task, pgTypes.Task>;
type _AgentLiteToPg = AssertAssignable<pgTypes.Agent, liteTypes.Agent>;
type _AgentPgToLite = AssertAssignable<liteTypes.Agent, pgTypes.Agent>;
type _DocLiteToPg = AssertAssignable<pgTypes.KnowledgeDoc, liteTypes.KnowledgeDoc>;
type _DocPgToLite = AssertAssignable<liteTypes.KnowledgeDoc, pgTypes.KnowledgeDoc>;
type _RunLiteToPg = AssertAssignable<pgTypes.Run, liteTypes.Run>;
type _LaunchLiteToPg = AssertAssignable<pgTypes.ModuleLaunch, liteTypes.ModuleLaunch>;
type _EventLiteToPg = AssertAssignable<pgTypes.PersistedEvent, liteTypes.PersistedEvent>;
type _TaskAssigneeLiteToPg = AssertAssignable<pgTypes.TaskAssignee, liteTypes.TaskAssignee>;
type _TaskAssigneePgToLite = AssertAssignable<liteTypes.TaskAssignee, pgTypes.TaskAssignee>;
type _NotificationLiteToPg = AssertAssignable<pgTypes.TaskNotificationLog, liteTypes.TaskNotificationLog>;
type _NotificationPgToLite = AssertAssignable<liteTypes.TaskNotificationLog, pgTypes.TaskNotificationLog>;
type _OrgUnitLiteToPg = AssertAssignable<pgTypes.OrgUnit, liteTypes.OrgUnit>;
type _OrgUnitPgToLite = AssertAssignable<liteTypes.OrgUnit, pgTypes.OrgUnit>;
type _OrgRoleLiteToPg = AssertAssignable<pgTypes.OrgRole, liteTypes.OrgRole>;
type _OrgRolePgToLite = AssertAssignable<liteTypes.OrgRole, pgTypes.OrgRole>;
type _RoleFunctionLiteToPg = AssertAssignable<pgTypes.RoleFunction, liteTypes.RoleFunction>;
type _RoleFunctionPgToLite = AssertAssignable<liteTypes.RoleFunction, pgTypes.RoleFunction>;
type _RolePersonLiteToPg = AssertAssignable<pgTypes.RolePerson, liteTypes.RolePerson>;
type _RolePersonPgToLite = AssertAssignable<liteTypes.RolePerson, pgTypes.RolePerson>;
type _RoleProcessLiteToPg = AssertAssignable<pgTypes.RoleProcess, liteTypes.RoleProcess>;
type _RoleProcessPgToLite = AssertAssignable<liteTypes.RoleProcess, pgTypes.RoleProcess>;

function tableNames(mod: Record<string, unknown>): string[] {
  return Object.values(mod)
    .filter((v): v is Table => is(v, Table))
    .map((t) => getTableName(t))
    .sort();
}

describe("esquema Postgres = esquema SQLite", () => {
  it("las 37 tablas existen en los dos motores, con los mismos nombres", () => {
    const lite = tableNames(liteSchema);
    const pg = tableNames(pgSchema);
    expect(lite).toHaveLength(37);
    expect(pg).toEqual(lite);
  });

  it("PG_TABLE_ORDER cubre las 37 tablas sin repetir", () => {
    expect(new Set(PG_TABLE_ORDER).size).toBe(37);
    expect([...PG_TABLE_ORDER].sort()).toEqual(tableNames(liteSchema));
  });

  it("el orden de copia es TOPOLÓGICO: ninguna tabla se copia antes que sus padres", () => {
    // Dependencias declaradas en el esquema (excluidas las auto-FKs, que se
    // resuelven ordenando por fecha dentro de la propia tabla).
    const deps: Record<string, string[]> = {
      people: ["organizations"],
      projects: ["organizations"],
      agents: ["provider_profiles"],
      prompt_versions: ["agents"],
      tasks: ["projects", "agents", "people"],
      task_assignees: ["tasks", "people"],
      task_labels: ["tasks"],
      task_notification_log: ["tasks", "people"],
      runs: ["agents", "tasks", "projects", "provider_profiles"],
      spans: ["runs"],
      task_events: ["tasks", "runs"],
      artifacts: ["tasks", "runs"],
      threads: ["projects", "agents"],
      messages: ["threads", "runs"],
      approvals: ["runs", "tasks", "projects", "people"],
      knowledge_docs: ["organizations", "projects"],
      project_sources: ["projects", "knowledge_docs"],
      processes: ["organizations"],
      org_units: ["organizations"],
      org_roles: ["organizations", "org_units", "agents"],
      role_functions: ["org_roles"],
      role_people: ["org_roles", "people"],
      role_processes: ["org_roles", "processes"],
      module_launches: ["phase_modules", "organizations", "projects", "methodologies"],
      canvas_notes: ["organizations", "projects", "artifacts", "people"],
    };
    const position = new Map(PG_TABLE_ORDER.map((t, i) => [t, i]));
    for (const [table, parents] of Object.entries(deps)) {
      for (const parent of parents) {
        expect(
          position.get(parent as never)!,
          `${parent} debe copiarse antes que ${table}`,
        ).toBeLessThan(position.get(table as never)!);
      }
    }
  });

  it("TABLE_PAIRS empareja las 37 tablas en el mismo orden topológico", () => {
    expect(TABLE_PAIRS).toHaveLength(37);
    expect(TABLE_PAIRS.map((p) => p.name)).toEqual([...PG_TABLE_ORDER]);
    for (const pair of TABLE_PAIRS) {
      expect(getTableName(pair.from)).toBe(pair.name);
      expect(getTableName(pair.to)).toBe(pair.name);
    }
  });

  it("responsables y avisos conservan columnas/c tipos portables", () => {
    const pgColumns = (table: object) => Object.keys(table).filter((key) => key !== "enableRLS");
    expect(Object.keys(liteSchema.taskAssignees)).toEqual(pgColumns(pgSchema.taskAssignees));
    expect(Object.keys(liteSchema.taskNotificationLog)).toEqual(pgColumns(pgSchema.taskNotificationLog));
    expect(Object.keys(liteSchema.taskLabels)).toEqual(pgColumns(pgSchema.taskLabels));
    expect(Object.keys(liteSchema.taskLabels)).toEqual(["taskId", "label", "createdBy", "createdAt"]);
    expect(Object.keys(liteSchema.taskAssignees)).toEqual([
      "taskId",
      "personId",
      "isPrimary",
      "assignedBy",
      "createdAt",
    ]);
    expect(Object.keys(liteSchema.taskNotificationLog)).toEqual([
      "id",
      "taskId",
      "personId",
      "kind",
      "scheduledAt",
      "deliveredAt",
      "status",
      "dedupeKey",
      "lastError",
      "createdAt",
    ]);
  });
});

describe("selección de driver", () => {
  it("el default es sqlite (cero fricción)", () => {
    expect(resolveDriver(undefined)).toBe("sqlite");
    expect(resolveDriver("sqlite")).toBe("sqlite");
  });

  it("postgres y sus alias", () => {
    expect(resolveDriver("postgres")).toBe("postgres");
    expect(resolveDriver("PostgreS")).toBe("postgres");
    expect(resolveDriver("pg")).toBe("postgres");
    expect(resolveDriver("supabase")).toBe("postgres");
    expect(isPostgresDriver("postgres")).toBe(true);
    expect(isPostgresDriver("sqlite")).toBe(false);
  });

  it("un valor desconocido falla explícito (fail-closed), no cae en silencio a sqlite", () => {
    expect(() => resolveDriver("mysql")).toThrow(/no es válido/);
  });

  it("detecta el pooler de transacción de Supabase (prepared statements OFF)", () => {
    expect(looksLikeTransactionPooler("postgres://u:p@aws.pooler.supabase.com:6543/postgres")).toBe(true);
    expect(looksLikeTransactionPooler("postgres://u:p@host:5432/db?pgbouncer=true")).toBe(true);
    expect(looksLikeTransactionPooler("postgres://u:p@localhost:5432/agentos")).toBe(false);
  });

  it("nunca imprime la contraseña de la URL", () => {
    expect(redactUrl("postgres://agentos:s3cr3t@localhost:5432/agentos")).toBe(
      "postgres://agentos:***@localhost:5432/agentos",
    );
  });
});

describe("proveedor de embeddings", () => {
  it("el mock es determinista y unitario", () => {
    const m = new MockEmbeddingProvider(64);
    expect(m.dimensions).toBe(64);
    return m.embed(["mapa de procesos de ventas", "mapa de procesos de ventas"]).then(([a, b]) => {
      expect(a).toEqual(b);
      expect(a).toHaveLength(64);
      const norm = Math.sqrt(a!.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 6);
    });
  });

  it("textos parecidos quedan MÁS CERCA que textos sin relación", async () => {
    const m = new MockEmbeddingProvider(256);
    const [a, b, c] = await m.embed([
      "diagnóstico de procesos de facturación del cliente",
      "diagnóstico de los procesos de facturación",
      "presupuesto de campañas publicitarias en televisión",
    ]);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  });

  it("sin OPENAI_API_KEY devuelve null: degradación limpia a tsvector, no excepción", () => {
    expect(resolveEmbeddingProvider({ env: {} })).toBeNull();
    expect(resolveEmbeddingProvider({ env: { OPENAI_API_KEY: "  " } })).toBeNull();
  });

  it("AGENTOS_EMBEDDING_PROVIDER=none apaga la semántica aunque haya key", () => {
    expect(
      resolveEmbeddingProvider({ env: { OPENAI_API_KEY: "sk-x", AGENTOS_EMBEDDING_PROVIDER: "none" } }),
    ).toBeNull();
  });

  it("con key devuelve el proveedor OpenAI (text-embedding-3-small, 1536)", () => {
    const p = resolveEmbeddingProvider({ env: { OPENAI_API_KEY: "sk-test" } });
    expect(p).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(p!.id).toBe("openai:text-embedding-3-small");
    expect(p!.dimensions).toBe(1536);
  });

  it("pedir openai explícitamente SIN key sí falla (config contradictoria)", () => {
    expect(() =>
      resolveEmbeddingProvider({ env: { AGENTOS_EMBEDDING_PROVIDER: "openai" } }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("el llamante puede inyectar su propio fetch (sin red en tests)", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push(String(url));
      const body = JSON.parse(String((init as RequestInit).body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [0, 1, 0] })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const p = new OpenAIEmbeddingProvider({ apiKey: "sk-test", dimensions: 3, fetchImpl: fake });
    const out = await p.embed(["hola", "adiós"]);
    expect(out).toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ]);
    expect(calls[0]).toBe("https://api.openai.com/v1/embeddings");
  });

  it("serializa al literal de pgvector", () => {
    expect(toPgVector([0.5, -1, 0])).toBe("[0.5,-1,0]");
  });
});
