/**
 * Espejo Postgres de `src/repositories/modules.ts` — misma superficie, asíncrona
 * (§NFR-9). Módulos de Fase (ARCHITECTURE §13.1):
 * `phase_modules` = versiones INMUTABLES (editar = insertar version+1);
 * `module_launches` = recibos append-only (el motor de launch los inserta — M2).
 *
 * Contrato de seed ([SÍNTESIS] Codex, §13.5 A): mismo `(slug,version)` con hash
 * distinto = error `module_version_immutable` — sin auto-bump, la versión del
 * archivo y la de DB no divergen jamás. Mismo hash = no-op. Versión nueva =
 * fila nueva activa + la anterior archivada.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  AgentosError,
  ErrorCodes,
  blueprintHash,
  canonicalizeBlueprint,
  errors,
  newId,
  nowMs,
  validateBlueprint,
  type BlueprintIssue,
  type ModuleBlueprint,
  type ProjectType,
  type Stage,
} from "@agentos/shared";
import { withTransaction } from "../../facade.js";
import type { AgentosPgDb } from "../client-pg.js";
import { moduleLaunches, phaseModules } from "../schema-pg.js";
import type { ModuleLaunch, NewModuleLaunch, NewPhaseModule, PhaseModule } from "../types-pg.js";
import type { ParsedModuleSeed } from "../../seed-sources.js";
import { getAgentBySlug } from "./agents.js";
import { getMethodology } from "./methodologies.js";

// ── Lecturas ────────────────────────────────────────────────────────────────

export async function getPhaseModuleById(
  db: AgentosPgDb,
  id: string,
): Promise<PhaseModule | undefined> {
  const [row] = await db.select().from(phaseModules).where(eq(phaseModules.id, id)).limit(1);
  return row;
}

export async function getActiveModule(
  db: AgentosPgDb,
  slug: string,
): Promise<PhaseModule | undefined> {
  const [row] = await db
    .select()
    .from(phaseModules)
    .where(and(eq(phaseModules.slug, slug), eq(phaseModules.status, "active")))
    .limit(1);
  return row;
}

export async function getModuleVersion(
  db: AgentosPgDb,
  slug: string,
  version: number,
): Promise<PhaseModule | undefined> {
  const [row] = await db
    .select()
    .from(phaseModules)
    .where(and(eq(phaseModules.slug, slug), eq(phaseModules.version, version)))
    .limit(1);
  return row;
}

/** Todas las versiones de todos los módulos (slug asc, versión desc). */
export async function listPhaseModules(
  db: AgentosPgDb,
  filter: { slug?: string; status?: PhaseModule["status"] } = {},
): Promise<PhaseModule[]> {
  const conds = [];
  if (filter.slug) conds.push(eq(phaseModules.slug, filter.slug));
  if (filter.status) conds.push(eq(phaseModules.status, filter.status));
  const base = db.select().from(phaseModules);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return await q.orderBy(asc(phaseModules.slug), desc(phaseModules.version));
}

// ── Escrituras ──────────────────────────────────────────────────────────────

export interface CreateModuleVersionInput {
  slug: string;
  /** Sin versión explícita: max(slug)+1 (patrón `prompt_versions`). */
  version?: number;
  name: string;
  phase: Stage;
  projectType: ProjectType;
  methodologySlug: string;
  methodologyVersion: number | null;
  /** Se acepta un draft con issues (momento A §13.5) — queda inactivable. */
  blueprint: unknown;
  bodyMd: string;
  changelog?: string | null;
  seedFile?: string | null;
  seedHash?: string | null;
  createdBy?: string | null;
}

/**
 * Inserta una versión nueva SIEMPRE en `draft` (activar es un paso aparte y
 * fail-closed). El blueprint se persiste canonicalizado + hasheado.
 */
export async function createModuleVersion(
  db: AgentosPgDb,
  input: CreateModuleVersionInput,
): Promise<PhaseModule> {
  // Una transacción: el "siguiente número de versión" y el chequeo de colisión
  // no pueden decidirse con una foto vieja mientras otro inserta esa misma
  // versión (§NM-4). En SQLite es un no-op práctico (una sola conexión).
  return await withTransaction(db, async (anyTx) => {
    const tx = anyTx as AgentosPgDb;
    return await createModuleVersionTx(tx, input);
  });
}

async function createModuleVersionTx(
  db: AgentosPgDb,
  input: CreateModuleVersionInput,
): Promise<PhaseModule> {
  const now = nowMs();
  const version = input.version ?? (await nextModuleVersion(db, input.slug));
  if (await getModuleVersion(db, input.slug, version)) {
    throw new AgentosError(
      ErrorCodes.CONFLICT,
      `Ya existe la versión ${version} del módulo ${input.slug}`,
      { slug: input.slug, version },
    );
  }
  const canonical = canonicalizeBlueprint(input.blueprint);
  const row: NewPhaseModule = {
    id: newId(),
    slug: input.slug,
    version,
    name: input.name,
    phase: input.phase,
    projectType: input.projectType,
    status: "draft",
    methodologySlug: input.methodologySlug,
    methodologyVersion: input.methodologyVersion,
    blueprint: JSON.parse(canonical) as ModuleBlueprint,
    blueprintHash: blueprintHash(canonical),
    bodyMd: input.bodyMd,
    changelog: input.changelog ?? null,
    seedFile: input.seedFile ?? null,
    seedHash: input.seedHash ?? null,
    createdBy: input.createdBy ?? null,
    activatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(phaseModules).values(row);
  return (await getModuleVersion(db, input.slug, version))!;
}

async function nextModuleVersion(db: AgentosPgDb, slug: string): Promise<number> {
  const [last] = await db
    .select({ v: sql<number>`coalesce(max(${phaseModules.version}), 0)::int` })
    .from(phaseModules)
    .where(eq(phaseModules.slug, slug));
  return Number(last?.v ?? 0) + 1;
}

/**
 * Reglas de validación CON DB del momento B (§13.5): `unknown_methodology`
 * (la metodología pinneada y cada `methodology_add` de los toggles) y
 * `unknown_agent_slug` (cada agente preferido del roster). Aquí y no en el MCP
 * para que TODOS los caminos hacia `active` (seed incluido) las corran.
 * `agent_not_assignable` NO se comprueba aquí: es regla del momento C — la
 * asignabilidad se resuelve al disparar, contra el roster de ese instante.
 */
export async function moduleBlueprintDbIssues(
  db: AgentosPgDb,
  bp: ModuleBlueprint,
): Promise<BlueprintIssue[]> {
  const issues: BlueprintIssue[] = [];
  const main = await getMethodology(db, bp.methodology.slug, bp.methodology.version ?? undefined);
  if (!main) {
    issues.push({
      code: "unknown_methodology",
      path: "methodology",
      details: { slug: bp.methodology.slug, version: bp.methodology.version },
    });
  }
  const toggles = bp.toggles ?? [];
  for (let i = 0; i < toggles.length; i += 1) {
    const t = toggles[i]!;
    if (t.methodology_add !== undefined && !(await getMethodology(db, t.methodology_add))) {
      issues.push({
        code: "unknown_methodology",
        path: `toggles[${i}].methodology_add`,
        details: { slug: t.methodology_add, toggle: t.key },
      });
    }
  }
  for (let i = 0; i < bp.roster.length; i += 1) {
    const r = bp.roster[i]!;
    if (!(await getAgentBySlug(db, r.agent))) {
      issues.push({
        code: "unknown_agent_slug",
        path: `roster[${i}].agent`,
        details: { agent: r.agent, role: r.role },
      });
    }
  }
  return issues;
}

/**
 * Activa una versión (momento B — §13.5): la validación fail-closed re-corre
 * ENTERA — reglas puras + reglas con DB (`unknown_methodology`,
 * `unknown_agent_slug`) — y un solo issue rechaza con la LISTA COMPLETA.
 * Archiva la versión activa anterior del slug (el índice parcial garantiza
 * una sola activa).
 */
export async function activateModuleVersion(
  db: AgentosPgDb,
  slug: string,
  version: number,
): Promise<PhaseModule> {
  const row = await getModuleVersion(db, slug, version);
  if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
  if (row.status === "active") return row;

  const result = validateBlueprint(row.blueprint);
  const issues: BlueprintIssue[] = [...result.issues];
  if (result.blueprint) issues.push(...(await moduleBlueprintDbIssues(db, result.blueprint)));
  if (issues.length > 0) {
    throw errors.validation(
      `El módulo ${slug}@${version} no puede activarse: blueprint inválido (momento B)`,
      issues,
    );
  }

  // Archivar la anterior y activar la nueva van en UNA transacción: si no, hay
  // una ventana con CERO versiones activas del slug y un `launchModule`
  // concurrente falla con `module_not_active`.
  return await withTransaction(db, async (anyTx) => {
    const tx = anyTx as AgentosPgDb;
    const now = nowMs();
    const active = await getActiveModule(tx, slug);
    if (active && active.id !== row.id) {
      await tx
        .update(phaseModules)
        .set({ status: "archived", updatedAt: now })
        .where(eq(phaseModules.id, active.id));
    }
    await tx
      .update(phaseModules)
      .set({ status: "active", activatedAt: now, updatedAt: now })
      .where(eq(phaseModules.id, row.id));
    return (await getModuleVersion(tx, slug, version))!;
  });
}

/**
 * Archiva una versión (active|draft → archived). Los launches existentes no se
 * tocan (su recibo es un snapshot — NM-3); el slug queda sin versión activa
 * hasta el próximo publish/rollback.
 */
export async function archiveModuleVersion(
  db: AgentosPgDb,
  slug: string,
  version: number,
): Promise<PhaseModule> {
  const row = await getModuleVersion(db, slug, version);
  if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
  if (row.status === "archived") return row;
  await db
    .update(phaseModules)
    .set({ status: "archived", updatedAt: nowMs() })
    .where(eq(phaseModules.id, row.id));
  return (await getModuleVersion(db, slug, version))!;
}

/**
 * Upsert desde `modules/*.md` (mismo contrato de idempotencia por seed_hash que
 * agentes/metodologías, endurecido por [SÍNTESIS] Codex):
 * - `(slug,version)` no existe → inserta (draft) y ACTIVA (archiva la activa anterior).
 * - existe con el MISMO hash → no-op.
 * - existe con hash DISTINTO → error `module_version_immutable`: hay que subir
 *   `version` en el archivo. Sin auto-bump: archivo y DB no divergen jamás.
 */
export async function upsertPhaseModuleFromSeed(
  db: AgentosPgDb,
  seed: ParsedModuleSeed,
): Promise<{ module: PhaseModule; created: boolean }> {
  const existing = await getModuleVersion(db, seed.slug, seed.version);
  if (existing) {
    if (existing.seedHash === seed.seedHash) {
      return { module: existing, created: false };
    }
    throw new AgentosError(
      ErrorCodes.MODULE_VERSION_IMMUTABLE,
      `El módulo ${seed.slug}@${seed.version} ya existe con otro contenido; ` +
        `sube \`version\` en ${seed.seedFile} (las versiones son inmutables — CA-M1.2)`,
      { slug: seed.slug, version: seed.version, seedFile: seed.seedFile },
    );
  }
  await createModuleVersion(db, {
    slug: seed.slug,
    version: seed.version,
    name: seed.name,
    phase: seed.phase,
    projectType: seed.projectType,
    methodologySlug: seed.methodology.slug,
    methodologyVersion: seed.methodology.version,
    blueprint: seed.blueprint,
    bodyMd: seed.bodyMd,
    changelog: `Seed desde ${seed.seedFile}`,
    seedFile: seed.seedFile,
    seedHash: seed.seedHash,
    createdBy: "system:seed",
  });
  const active = await activateModuleVersion(db, seed.slug, seed.version);
  return { module: active, created: true };
}

// ── Launches (el motor de launch — src/modules/launch.ts — orquesta; las
// consultas viven aquí por la regla del paquete: nada consulta fuera de
// repositories/) ────────────────────────────────────────────────────────────

export async function getLaunch(db: AgentosPgDb, id: string): Promise<ModuleLaunch | undefined> {
  const [row] = await db.select().from(moduleLaunches).where(eq(moduleLaunches.id, id)).limit(1);
  return row;
}

/**
 * Insert del recibo INMUTABLE (append-only; no existe update/delete de
 * launches en ninguna capa). Lo llama SOLO el motor de launch, dentro de su
 * transacción única (§13.3).
 */
export async function insertModuleLaunch(
  db: AgentosPgDb,
  row: NewModuleLaunch,
): Promise<ModuleLaunch> {
  await db.insert(moduleLaunches).values(row);
  return (await getLaunch(db, row.id))!;
}

/**
 * ¿Ya se disparó esta fase sobre este proyecto? Espejo en lectura del índice
 * `uq(project_id, phase)`: el motor rechaza con error de dominio ANTES de que
 * el INSERT reviente el índice ([SÍNTESIS] Codex §13.1).
 */
export async function findLaunchByProjectAndPhase(
  db: AgentosPgDb,
  projectId: string,
  phase: Stage,
): Promise<ModuleLaunch | undefined> {
  const [row] = await db
    .select()
    .from(moduleLaunches)
    .where(and(eq(moduleLaunches.projectId, projectId), eq(moduleLaunches.phase, phase)))
    .limit(1);
  return row;
}

export async function findLaunchByIdempotencyKey(
  db: AgentosPgDb,
  idempotencyKey: string,
): Promise<ModuleLaunch | undefined> {
  const [row] = await db
    .select()
    .from(moduleLaunches)
    .where(eq(moduleLaunches.idempotencyKey, idempotencyKey))
    .limit(1);
  return row;
}

/**
 * Último launch del proyecto (M3, CA-M3.1): el recibo cuyos `deliverables`
 * efectivos definen el cierre de fase vigente.
 *
 * Desempate: `id DESC`. En SQLite era `rowid DESC` (orden de inserción), que
 * Postgres no tiene; los ids son uuidv7 —monotónicos por tiempo— así que el
 * orden por id reproduce el de inserción incluso con dos launches que comparten
 * `created_at` inyectado en tests.
 */
export async function getLatestLaunchForProject(
  db: AgentosPgDb,
  projectId: string,
): Promise<ModuleLaunch | undefined> {
  const [row] = await db
    .select()
    .from(moduleLaunches)
    .where(eq(moduleLaunches.projectId, projectId))
    .orderBy(desc(moduleLaunches.createdAt), desc(moduleLaunches.id))
    .limit(1);
  return row;
}

export async function listLaunches(
  db: AgentosPgDb,
  filter: { projectId?: string; moduleSlug?: string } = {},
): Promise<ModuleLaunch[]> {
  const conds = [];
  if (filter.projectId) conds.push(eq(moduleLaunches.projectId, filter.projectId));
  if (filter.moduleSlug) conds.push(eq(moduleLaunches.moduleSlug, filter.moduleSlug));
  const base = db.select().from(moduleLaunches);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  // Desempate por id: dos recibos del mismo milisegundo tenían orden arbitrario
  // (y distinto en cada motor).
  return await q.orderBy(desc(moduleLaunches.createdAt), desc(moduleLaunches.id));
}
