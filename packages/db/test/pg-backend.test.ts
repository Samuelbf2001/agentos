/**
 * Suite del backend Postgres/pgvector.
 *
 * **Se auto-omite si no hay `AGENTOS_PG_URL`** — así nadie necesita Docker ni
 * una base Postgres para que `pnpm -r test` siga verde. Para correrla de verdad:
 *
 *   docker run -d --name agentos-pg -e POSTGRES_PASSWORD=agentos \
 *     -e POSTGRES_USER=agentos -e POSTGRES_DB=agentos -p 55432:5432 pgvector/pgvector:pg16
 *   $env:AGENTOS_PG_URL="postgres://agentos:agentos@localhost:55432/agentos"
 *   pnpm --filter @agentos/db test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { isAgentosError } from "@agentos/shared";

import { openDb, type AgentosDb } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { MockEmbeddingProvider } from "../src/embeddings.js";
/** Repositorios SQLite bajo namespace: mismos nombres que los de PG, sin colisión. */
import * as lite from "../src/index.js";

import { closePgDb, openPgDb, type AgentosPgDb } from "../src/pg/client-pg.js";
import { runPgMigrations } from "../src/pg/migrate-pg.js";
import { PG_TABLE_ORDER } from "../src/pg/schema-pg.js";
import {
  backfillKnowledgeEmbeddings,
  currentEmbeddingDimension,
  ensurePgSearch,
  searchMessagesPg,
} from "../src/pg/search-pg.js";
import { copyAllTables } from "../src/pg/migrate-to-pg.js";

import { createOrganization, createPerson, listInternalPeople } from "../src/pg/repositories/organizations-people.js";
import { createProject, getProject, setGateState, updateProject } from "../src/pg/repositories/projects.js";
import { upsertProviderProfile } from "../src/pg/repositories/providers.js";
import { activatePromptVersion, createAgent, createPromptVersion, getActivePrompt } from "../src/pg/repositories/agents.js";
import {
  attachArtifact,
  claimTask,
  countArtifacts,
  countOpenTasksByAgent,
  createTask,
  getTask,
  listDispatchableTasks,
  listTaskEvents,
  reapExpiredLeases,
  renewLease,
  updateTask,
} from "../src/pg/repositories/tasks.js";
import { createRun, sumRunCostForProject } from "../src/pg/repositories/runs.js";
import { appendEvent, lastSeq, listEventsSince } from "../src/pg/repositories/events.js";
import { appendMessage, buildSessionKey, getOrCreateThread, listMessages } from "../src/pg/repositories/threads.js";
import { createDoc, listDocs, searchDocs, semanticSearchDocs } from "../src/pg/repositories/knowledge.js";
import { getConfig, setConfig } from "../src/pg/repositories/config.js";
import { appendAudit, queryAudit } from "../src/pg/repositories/audit.js";

const PG_URL = process.env.AGENTOS_PG_URL;
/** Dimensión pequeña: la suite prueba el PIPELINE vectorial, no el modelo. */
const EMB_DIM = 64;
const embedder = new MockEmbeddingProvider(EMB_DIM);

const describePg = describe.skipIf(!PG_URL);

describePg("backend Postgres + pgvector", () => {
  let db: AgentosPgDb;

  beforeAll(async () => {
    db = openPgDb(PG_URL);
    try {
      await runPgMigrations(db, { embeddingDimensions: EMB_DIM });
    } catch (err) {
      // La base pudo quedar con una dimensión distinta de una corrida previa:
      // recrear la columna es barato y deja la suite reproducible.
      if (!/dimensión/.test((err as Error).message)) throw err;
      await db.execute(sql`ALTER TABLE knowledge_docs DROP COLUMN IF EXISTS embedding`);
      await runPgMigrations(db, { embeddingDimensions: EMB_DIM });
    }
  }, 180_000);

  afterAll(async () => {
    if (db) await closePgDb(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(`TRUNCATE TABLE ${PG_TABLE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`),
    );
  });

  // ── 1. Esquema ────────────────────────────────────────────────────────────

  describe("migración de esquema", () => {
    it("crea las 31 tablas del dominio", async () => {
      const rows = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const names = rows.map((r) => r.table_name);
      for (const t of PG_TABLE_ORDER) expect(names).toContain(t);
      expect(PG_TABLE_ORDER).toHaveLength(31);
    });

    it("respeta las convenciones de portabilidad: id TEXT, *_at bigint, JSON→jsonb, boolean nativo", async () => {
      const rows = await db.execute<{ column_name: string; data_type: string }>(sql`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tasks'
      `);
      const type = (c: string) => rows.find((r) => r.column_name === c)?.data_type;
      expect(type("id")).toBe("text");
      expect(type("created_at")).toBe("bigint");
      expect(type("lease_until")).toBe("bigint");
      expect(type("depends_on")).toBe("jsonb");
      expect(type("requires_approval")).toBe("boolean");
    });

    it("mantiene el índice único PARCIAL de módulos activos", async () => {
      const rows = await db.execute<{ indexdef: string }>(sql`
        SELECT indexdef FROM pg_indexes
         WHERE tablename = 'phase_modules' AND indexname = 'uq_phase_modules_slug_active'
      `);
      expect(rows[0]?.indexdef).toMatch(/UNIQUE.*\(slug\).*WHERE.*'active'/s);
    });

    it("instala tsvector (GIN) y pgvector (HNSW) — fuera de las migraciones, como FTS5", async () => {
      const idx = await db.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
      );
      const names = idx.map((r) => r.indexname);
      expect(names).toContain("idx_messages_tsv");
      expect(names).toContain("idx_knowledge_tsv");
      expect(names).toContain("idx_knowledge_embedding_hnsw");
      expect(await currentEmbeddingDimension(db)).toBe(EMB_DIM);
    });

    it("ensurePgSearch es idempotente (se puede llamar en cada arranque)", async () => {
      const a = await ensurePgSearch(db, { embeddingDimensions: EMB_DIM });
      const b = await ensurePgSearch(db, { embeddingDimensions: EMB_DIM });
      expect(a.vector).toBe(true);
      expect(b).toEqual(a);
    });
  });

  // ── 2. Round-trip de repositorios clave ───────────────────────────────────

  async function fixture() {
    const org = await createOrganization(db, { name: "Org PG", kind: "client" });
    const project = await createProject(db, {
      orgId: org.id,
      name: "Proyecto PG",
      type: "assessment",
      stage: "ENTENDER",
    });
    const provider = await upsertProviderProfile(db, {
      slug: "test_provider",
      name: "Test",
      kind: "openai_compatible",
      apiKeyEnv: "TEST_KEY",
    });
    const agent = await createAgent(db, {
      slug: "tester",
      name: "Tester",
      layer: "meta",
      runtime: "ai_sdk",
      providerProfileId: provider.id,
      model: "test-1",
      toolsAllowlist: ["tasks.claim"],
      mcpAllowlist: [],
    });
    return { org, project, agent };
  }

  describe("repositorios (misma superficie que SQLite, asíncrona)", () => {
    it("organizations/people", async () => {
      const { org } = await fixture();
      await createPerson(db, { orgId: org.id, fullName: "Ana PG", isInternal: true });
      await createPerson(db, { orgId: org.id, fullName: "Luis PG", isInternal: false });
      expect(await listInternalPeople(db, org.id)).toHaveLength(1);
    });

    it("projects: optimistic locking y gate", async () => {
      const { project } = await fixture();
      const updated = await updateProject(db, project.id, { stage: "CONSTRUIR" }, project.version);
      expect(updated.version).toBe(project.version + 1);
      const gated = await setGateState(db, project.id, "approved", updated.version);
      expect(gated.gateState).toBe("approved");
      expect((await getProject(db, project.id))?.version).toBe(project.version + 2);
    });

    it("projects: expected_version incorrecta lanza version_conflict (no last-write-wins)", async () => {
      const { project } = await fixture();
      try {
        await updateProject(db, project.id, { name: "X" }, 999);
        expect.unreachable("debió lanzar version_conflict");
      } catch (err) {
        expect(isAgentosError(err, "version_conflict")).toBe(true);
      }
    });

    it("agents + prompt_versions: activar versión", async () => {
      const { agent } = await fixture();
      const v1 = await createPromptVersion(db, { agentId: agent.id, stable: "eres v1" });
      await activatePromptVersion(db, agent.id, v1.id);
      expect((await getActivePrompt(db, agent.id))?.stable).toBe("eres v1");
    });

    it("tasks: CRUD, timeline y regla anti-teatro (artefacto obligatorio)", async () => {
      const { project, agent } = await fixture();
      const task = await createTask(db, {
        projectId: project.id,
        title: "Mapear ventas",
        stage: "ENTENDER",
        status: "READY",
        assigneeAgentId: agent.id,
        orderKey: "a0",
        definitionOfDone: "mapa validado",
      });
      expect((await getTask(db, task.id))?.title).toBe("Mapear ventas");
      expect(await countArtifacts(db, task.id)).toBe(0);
      await attachArtifact(db, { taskId: task.id, kind: "doc", title: "Mapa v1" });
      expect(await countArtifacts(db, task.id)).toBe(1);
      const moved = await updateTask(db, task.id, { status: "REVIEW" }, task.version);
      expect(moved.version).toBe(task.version + 1);
    });

    it("tasks: jsonb depends_on y bigint due_at viajan intactos", async () => {
      const { project } = await fixture();
      const dueAt = Date.now() + 86_400_000;
      const a = await createTask(db, {
        projectId: project.id, title: "A", stage: "ENTENDER", orderKey: "a0",
      });
      const b = await createTask(db, {
        projectId: project.id, title: "B", stage: "ENTENDER", orderKey: "a1",
        dependsOn: [a.id], dueAt,
      });
      const read = await getTask(db, b.id);
      expect(read?.dependsOn).toEqual([a.id]);
      expect(read?.dueAt).toBe(dueAt);
      expect(typeof read?.createdAt).toBe("number");
    });

    it("threads/messages: idempotencia por (thread, idempotency_key)", async () => {
      const key = buildSessionKey("web", "chat-1");
      const thread = await getOrCreateThread(db, { channel: "web", sessionKey: key });
      await appendMessage(db, { threadId: thread.id, role: "user", content: "hola", idempotencyKey: "k1" });
      await appendMessage(db, { threadId: thread.id, role: "user", content: "hola", idempotencyKey: "k1" });
      expect(await listMessages(db, thread.id)).toHaveLength(1);
    });

    it("los agregados devuelven number, no el bigint-como-string de Postgres", async () => {
      // Trampa real de portabilidad: `count(*)` es bigint y el driver lo entrega
      // como STRING. Sin el casteo, `countArtifacts` devolvía "0" y cualquier
      // comparación aritmética de core habría mentido en silencio.
      const { project, agent } = await fixture();
      const task = await createTask(db, {
        projectId: project.id, title: "T", stage: "ENTENDER",
        assigneeAgentId: agent.id, orderKey: "a0",
      });
      await attachArtifact(db, { taskId: task.id, kind: "doc", title: "A" });
      expect(await countArtifacts(db, task.id)).toStrictEqual(1);

      const carga = await countOpenTasksByAgent(db);
      expect(carga.get(agent.id)).toStrictEqual(1);

      await createRun(db, {
        rootRunId: "r1", id: "r1", agentId: agent.id, projectId: project.id,
        trigger: "manual", runtime: "ai_sdk", costUsd: 0.25,
      });
      expect(await sumRunCostForProject(db, project.id)).toBeCloseTo(0.25, 6);
      expect(typeof (await sumRunCostForProject(db, project.id))).toBe("number");
    });

    it("app_config (jsonb) y audit_log round-trip", async () => {
      await setConfig(db, "kill_switch", { paused: true, reason: "prueba" });
      expect(await getConfig(db, "kill_switch")).toEqual({ paused: true, reason: "prueba" });
      await appendAudit(db, {
        actor: "system:test", source: "system", action: "test.run",
        entityType: "task", entityId: "t1", after: { ok: true },
      });
      expect(await queryAudit(db, { entityType: "task", entityId: "t1" })).toHaveLength(1);
    });
  });

  // ── 3. Concurrencia real (lo que SQLite mono-escritor regalaba) ───────────

  describe("claim atómico bajo concurrencia REAL", () => {
    it("8 agentes compiten por la misma tarea y exactamente UNO gana", async () => {
      const { project, agent } = await fixture();
      const task = await createTask(db, {
        projectId: project.id, title: "Contendida", stage: "ENTENDER",
        status: "READY", assigneeAgentId: agent.id, orderKey: "a0",
      });

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => claimTask(db, { taskId: task.id, agentId: `a${i}` })),
      );

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const after = await getTask(db, task.id);
      expect(after?.status).toBe("IN_PROGRESS");
      // Un solo intento contabilizado: el UPDATE condicional no se ejecutó 8 veces.
      expect(after?.attempts).toBe(1);
      expect((await listTaskEvents(db, task.id)).filter((e) => e.kind === "claimed")).toHaveLength(1);
    });

    it("lease: renovar, vencer y reencolar; attempts>=3 → BLOCKED stuck", async () => {
      const { project, agent } = await fixture();
      const task = await createTask(db, {
        projectId: project.id, title: "Con lease", stage: "ENTENDER",
        status: "READY", assigneeAgentId: agent.id, orderKey: "a0",
      });
      await claimTask(db, { taskId: task.id, agentId: agent.id, leaseMs: -1 });
      expect(await renewLease(db, task.id, -1)).toBe(true);

      const first = await reapExpiredLeases(db);
      expect(first.requeued).toContain(task.id);

      await updateTask(db, task.id, { attempts: 3 }, (await getTask(db, task.id))!.version);
      await claimTask(db, { taskId: task.id, agentId: agent.id, leaseMs: -1 });
      const second = await reapExpiredLeases(db);
      expect(second.blocked).toContain(task.id);
      expect((await getTask(db, task.id))?.blockedReason).toBe("stuck");
    });

    it("la cola del despachador solo ve READY con agente asignado", async () => {
      const { project, agent } = await fixture();
      await createTask(db, {
        projectId: project.id, title: "lista", stage: "ENTENDER",
        status: "READY", assigneeAgentId: agent.id, orderKey: "a0",
      });
      await createTask(db, {
        projectId: project.id, title: "sin agente", stage: "ENTENDER",
        status: "READY", orderKey: "a1",
      });
      await createTask(db, {
        projectId: project.id, title: "backlog", stage: "ENTENDER",
        status: "BACKLOG", assigneeAgentId: agent.id, orderKey: "a2",
      });
      const queue = await listDispatchableTasks(db);
      expect(queue.map((t) => t.title)).toEqual(["lista"]);
    });

    it("seq de eventos sin huecos ni duplicados con 15 escritores concurrentes", async () => {
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          appendEvent(db, { topic: "run:x", type: "TEXT_MESSAGE_CONTENT", payload: { i } }),
        ),
      );
      const all = await listEventsSince(db, "run:x", 0, 100);
      expect(all).toHaveLength(15);
      expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      expect(await lastSeq(db, "run:x")).toBe(15);
    });
  });

  // ── 4. Búsqueda por palabras (tsvector) ──────────────────────────────────

  describe("tsvector — equivalente de FTS5", () => {
    async function seedDocs(orgId: string) {
      await createDoc(db, {
        orgId, kind: "process_map", title: "Mapa del proceso de facturación",
        bodyMd: "El proceso de facturación arranca cuando ventas cierra el pedido y termina en cobranza.",
      });
      await createDoc(db, {
        orgId, kind: "note", title: "Inventario de sistemas",
        bodyMd: "ERP propio, hojas de cálculo compartidas y un CRM sin integrar.",
      });
      await createDoc(db, {
        orgId, kind: "finding", title: "Hallazgo de cobranza",
        bodyMd: "La cobranza depende de recordatorios manuales por WhatsApp.",
      });
    }

    it("encuentra por palabra y devuelve extracto con los mismos marcadores « »", async () => {
      const { org } = await fixture();
      await seedDocs(org.id);
      const hits = await searchDocs(db, "facturación");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.title).toBe("Mapa del proceso de facturación");
      expect(hits[0]?.snippet).toContain("«");
    });

    it("el contrato del rank se mantiene: menor = mejor (como FTS5)", async () => {
      const { org } = await fixture();
      await seedDocs(org.id);
      const hits = await searchDocs(db, "cobranza");
      const ranks = hits.map((h) => h.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    });

    it("busca también en messages", async () => {
      const thread = await getOrCreateThread(db, {
        channel: "web", sessionKey: buildSessionKey("web", "c1"),
      });
      await appendMessage(db, {
        threadId: thread.id, role: "user",
        content: "necesitamos revisar el inventario de sistemas del cliente",
      });
      const hits = await searchMessagesPg(db, "inventario sistemas");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.threadId).toBe(thread.id);
      expect(typeof hits[0]?.createdAt).toBe("number");
    });
  });

  // ── 5. Búsqueda semántica (pgvector) ─────────────────────────────────────

  describe("pgvector — el Context Hub como wiki semántica", () => {
    it("createDoc con embedder vectoriza; la búsqueda usa el índice y ordena por distancia", async () => {
      const { org } = await fixture();
      await createDoc(db, {
        orgId: org.id, kind: "process_map", title: "Mapa del proceso de facturación",
        bodyMd: "Ventas cierra el pedido, administración emite la factura y cobranza persigue el pago.",
      }, { embedder });
      await createDoc(db, {
        orgId: org.id, kind: "note", title: "Plan de medios",
        bodyMd: "Pauta publicitaria en radio y televisión para el trimestre.",
      }, { embedder });

      const res = await semanticSearchDocs(db, "cómo se emite la factura del pedido", 5, { embedder });
      expect(res.mode).toBe("vector");
      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.hits[0]?.title).toBe("Mapa del proceso de facturación");
      expect(res.hits[0]?.distance).toBeLessThan(res.hits[1]?.distance ?? Infinity);
      expect(res.hits[0]?.score).toBeGreaterThan(0);
    });

    it("filtra por organización/proyecto sin perder el orden por distancia", async () => {
      const { org, project } = await fixture();
      const otra = await createOrganization(db, { name: "Otra Org", kind: "client" });
      await createDoc(db, {
        orgId: org.id, projectId: project.id, kind: "finding", title: "Fuga en cobranza",
        bodyMd: "Recordatorios manuales de cobranza por WhatsApp.",
      }, { embedder });
      await createDoc(db, {
        orgId: otra.id, kind: "finding", title: "Fuga en cobranza ajena",
        bodyMd: "Recordatorios manuales de cobranza por WhatsApp.",
      }, { embedder });

      const res = await semanticSearchDocs(db, "cobranza manual", 5, { embedder, orgId: org.id });
      expect(res.mode).toBe("vector");
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]?.orgId).toBe(org.id);
    });

    it("documentos sin vectorizar quedan fuera; el backfill los incorpora", async () => {
      const { org } = await fixture();
      await createDoc(db, {
        orgId: org.id, kind: "note", title: "Acta sin vectorizar",
        bodyMd: "Reunión de arranque con el sponsor del proyecto.",
      }); // ← sin embedder

      const antes = await semanticSearchDocs(db, "reunión de arranque", 5, { embedder });
      expect(antes.hits).toHaveLength(0);

      const res = await backfillKnowledgeEmbeddings(db, embedder);
      expect(res.embedded).toBe(1);

      const despues = await semanticSearchDocs(db, "reunión de arranque", 5, { embedder });
      expect(despues.mode).toBe("vector");
      expect(despues.hits[0]?.title).toBe("Acta sin vectorizar");
    });

    it("SIN proveedor de embeddings degrada a tsvector y lo dice — no revienta", async () => {
      const { org } = await fixture();
      await createDoc(db, {
        orgId: org.id, kind: "note", title: "Inventario de sistemas",
        bodyMd: "ERP propio y hojas de cálculo.",
      }, { embedder });

      const res = await semanticSearchDocs(db, "inventario", 5, { embedder: null });
      expect(res.mode).toBe("keyword");
      expect(res.degradedReason).toMatch(/embeddings/);
      expect(res.hits[0]?.title).toBe("Inventario de sistemas");
    });

    it("una dimensión que no cuadra degrada en vez de corromper el índice", async () => {
      const { org } = await fixture();
      await createDoc(db, {
        orgId: org.id, kind: "note", title: "Inventario de sistemas", bodyMd: "ERP propio.",
      }, { embedder });
      const otro = new MockEmbeddingProvider(EMB_DIM * 2);
      const res = await semanticSearchDocs(db, "inventario", 5, { embedder: otro });
      expect(res.mode).toBe("keyword");
      expect(res.degradedReason).toMatch(/vector\(64\)/);
    });
  });

  // ── 6. Migración de datos SQLite → Postgres ──────────────────────────────

  describe("migrate-to-pg", () => {
    function freshSqlite(): AgentosDb {
      const source = openDb(":memory:");
      runMigrations(source);
      return source;
    }

    it("copia una SQLite completa respetando FKs y es idempotente al repetir", async () => {
      const source = freshSqlite();
      // Semilla mínima que ejercita el orden topológico y las auto-FKs.
      const org = lite.createOrganization(source, { name: "ACME Copia", kind: "client" });
      const project = lite.createProject(source, {
        orgId: org.id, name: "Assessment", type: "assessment", stage: "ENTENDER",
      });
      const provider = lite.upsertProviderProfile(source, {
        slug: "p1", name: "P", kind: "claude_subscription",
      });
      const parentAgent = lite.createAgent(source, {
        slug: "alex", name: "Alex", layer: "consultoria", runtime: "claude_code",
        providerProfileId: provider.id, toolsAllowlist: [], mcpAllowlist: [],
      });
      lite.createAgent(source, {
        slug: "sam", name: "Sam", layer: "implementacion", runtime: "ai_sdk",
        providerProfileId: provider.id, reportsTo: parentAgent.id,
        toolsAllowlist: [], mcpAllowlist: [],
      });
      const padre = lite.createTask(source, {
        projectId: project.id, title: "Padre", stage: "ENTENDER", orderKey: "a0",
      });
      lite.createTask(source, {
        projectId: project.id, title: "Hija", stage: "ENTENDER", orderKey: "a1",
        parentTaskId: padre.id, dependsOn: [padre.id],
      });
      lite.createDoc(source, {
        orgId: org.id, projectId: project.id, kind: "org_profile",
        title: "Perfil ACME", bodyMd: "Manufactura mediana con 40 personas.",
        tags: ["acme"], sourceRefs: [{ kind: "interview", id: "e1" }],
      });
      lite.appendEvent(source, { topic: "board:x", type: "STATE_SNAPSHOT", payload: { n: 1 } });
      lite.setConfig(source, "budget_max_cost_per_run_usd", 3);

      const first = await copyAllTables(source, db);
      const byTable = new Map(first.map((r) => [r.table, r]));
      expect(byTable.get("organizations")?.inserted).toBe(1);
      expect(byTable.get("agents")?.inserted).toBe(2);
      expect(byTable.get("tasks")?.inserted).toBe(2);
      expect(byTable.get("knowledge_docs")?.inserted).toBe(1);
      expect(first.every((r) => r.target >= r.source)).toBe(true);

      // Los tipos se conservan: jsonb, boolean y epoch ms.
      const docs = await listDocs(db, { orgId: org.id });
      expect(docs[0]?.tags).toEqual(["acme"]);
      expect(docs[0]?.sourceRefs).toEqual([{ kind: "interview", id: "e1" }]);
      expect(await getConfig<number>(db, "budget_max_cost_per_run_usd")).toBe(3);
      const hija = (await db.execute<{ id: string; parent_task_id: string }>(
        sql`SELECT id, parent_task_id FROM tasks WHERE title = 'Hija'`,
      ))[0];
      expect(hija?.parent_task_id).toBe(padre.id);

      // Segunda pasada: idempotente, cero inserciones, mismos totales.
      const second = await copyAllTables(source, db);
      expect(second.every((r) => r.inserted === 0)).toBe(true);
      expect(second.map((r) => r.target)).toEqual(first.map((r) => r.target));

      source.$client.close();
    }, 60_000);

    it("--dry-run no escribe nada", async () => {
      const source = freshSqlite();
      lite.createOrganization(source, { name: "Solo cuenta", kind: "client" });
      const report = await copyAllTables(source, db, { dryRun: true });
      expect(report.find((r) => r.table === "organizations")?.source).toBe(1);
      expect(report.every((r) => r.inserted === 0)).toBe(true);
      const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM organizations`);
      expect(Number(rows[0]?.n)).toBe(0);
      source.$client.close();
    });
  });
});
