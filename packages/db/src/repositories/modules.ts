/**
 * Repositorio de Módulos de Fase (ARCHITECTURE §13.1):
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
import type { AgentosSqliteDb } from "../client.js";
import { moduleLaunches, phaseModules } from "../schema.js";
import type { ModuleLaunch, NewModuleLaunch, NewPhaseModule, PhaseModule } from "../types.js";
import type { ParsedModuleSeed } from "../seed-sources.js";
import { getAgentBySlug } from "./agents.js";
import { getMethodology } from "./methodologies.js";

// ── Lecturas ────────────────────────────────────────────────────────────────

export function getPhaseModuleById(db: AgentosSqliteDb, id: string): PhaseModule | undefined {
  return db.select().from(phaseModules).where(eq(phaseModules.id, id)).get();
}

export function getActiveModule(db: AgentosSqliteDb, slug: string): PhaseModule | undefined {
  return db
    .select()
    .from(phaseModules)
    .where(and(eq(phaseModules.slug, slug), eq(phaseModules.status, "active")))
    .get();
}

export function getModuleVersion(
  db: AgentosSqliteDb,
  slug: string,
  version: number,
): PhaseModule | undefined {
  return db
    .select()
    .from(phaseModules)
    .where(and(eq(phaseModules.slug, slug), eq(phaseModules.version, version)))
    .get();
}

/** Todas las versiones de todos los módulos (slug asc, versión desc). */
export function listPhaseModules(
  db: AgentosSqliteDb,
  filter: { slug?: string; status?: PhaseModule["status"] } = {},
): PhaseModule[] {
  const conds = [];
  if (filter.slug) conds.push(eq(phaseModules.slug, filter.slug));
  if (filter.status) conds.push(eq(phaseModules.status, filter.status));
  const base = db.select().from(phaseModules);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(asc(phaseModules.slug), desc(phaseModules.version)).all();
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
export function createModuleVersion(db: AgentosSqliteDb, input: CreateModuleVersionInput): PhaseModule {
  const now = nowMs();
  const version = input.version ?? nextModuleVersion(db, input.slug);
  if (getModuleVersion(db, input.slug, version)) {
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
  db.insert(phaseModules).values(row).run();
  return getModuleVersion(db, input.slug, version)!;
}

function nextModuleVersion(db: AgentosSqliteDb, slug: string): number {
  const last = db
    .select({ v: sql<number>`coalesce(max(${phaseModules.version}), 0)` })
    .from(phaseModules)
    .where(eq(phaseModules.slug, slug))
    .get();
  return (last?.v ?? 0) + 1;
}

/**
 * Reglas de validación CON DB del momento B (§13.5): `unknown_methodology`
 * (la metodología pinneada y cada `methodology_add` de los toggles) y
 * `unknown_agent_slug` (cada agente preferido del roster). Aquí y no en el MCP
 * para que TODOS los caminos hacia `active` (seed incluido) las corran.
 * `agent_not_assignable` NO se comprueba aquí: es regla del momento C — la
 * asignabilidad se resuelve al disparar, contra el roster de ese instante.
 */
export function moduleBlueprintDbIssues(db: AgentosSqliteDb, bp: ModuleBlueprint): BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  const main = getMethodology(db, bp.methodology.slug, bp.methodology.version ?? undefined);
  if (!main) {
    issues.push({
      code: "unknown_methodology",
      path: "methodology",
      details: { slug: bp.methodology.slug, version: bp.methodology.version },
    });
  }
  (bp.toggles ?? []).forEach((t, i) => {
    if (t.methodology_add !== undefined && !getMethodology(db, t.methodology_add)) {
      issues.push({
        code: "unknown_methodology",
        path: `toggles[${i}].methodology_add`,
        details: { slug: t.methodology_add, toggle: t.key },
      });
    }
  });
  bp.roster.forEach((r, i) => {
    if (!getAgentBySlug(db, r.agent)) {
      issues.push({
        code: "unknown_agent_slug",
        path: `roster[${i}].agent`,
        details: { agent: r.agent, role: r.role },
      });
    }
  });
  return issues;
}

/**
 * Activa una versión (momento B — §13.5): la validación fail-closed re-corre
 * ENTERA — reglas puras + reglas con DB (`unknown_methodology`,
 * `unknown_agent_slug`) — y un solo issue rechaza con la LISTA COMPLETA.
 * Archiva la versión activa anterior del slug (el índice parcial garantiza
 * una sola activa).
 */
export function activateModuleVersion(db: AgentosSqliteDb, slug: string, version: number): PhaseModule {
  const row = getModuleVersion(db, slug, version);
  if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
  if (row.status === "active") return row;

  const result = validateBlueprint(row.blueprint);
  const issues: BlueprintIssue[] = [...result.issues];
  if (result.blueprint) issues.push(...moduleBlueprintDbIssues(db, result.blueprint));
  if (issues.length > 0) {
    throw errors.validation(
      `El módulo ${slug}@${version} no puede activarse: blueprint inválido (momento B)`,
      issues,
    );
  }

  const now = nowMs();
  const active = getActiveModule(db, slug);
  if (active && active.id !== row.id) {
    db.update(phaseModules)
      .set({ status: "archived", updatedAt: now })
      .where(eq(phaseModules.id, active.id))
      .run();
  }
  db.update(phaseModules)
    .set({ status: "active", activatedAt: now, updatedAt: now })
    .where(eq(phaseModules.id, row.id))
    .run();
  return getModuleVersion(db, slug, version)!;
}

/**
 * Archiva una versión (active|draft → archived). Los launches existentes no se
 * tocan (su recibo es un snapshot — NM-3); el slug queda sin versión activa
 * hasta el próximo publish/rollback.
 */
export function archiveModuleVersion(db: AgentosSqliteDb, slug: string, version: number): PhaseModule {
  const row = getModuleVersion(db, slug, version);
  if (!row) throw errors.notFound("phase_module", `${slug}@${version}`);
  if (row.status === "archived") return row;
  db.update(phaseModules)
    .set({ status: "archived", updatedAt: nowMs() })
    .where(eq(phaseModules.id, row.id))
    .run();
  return getModuleVersion(db, slug, version)!;
}

/**
 * Upsert desde `modules/*.md` (mismo contrato de idempotencia por seed_hash que
 * agentes/metodologías, endurecido por [SÍNTESIS] Codex):
 * - `(slug,version)` no existe → inserta (draft) y ACTIVA (archiva la activa anterior).
 * - existe con el MISMO hash → no-op.
 * - existe con hash DISTINTO → error `module_version_immutable`: hay que subir
 *   `version` en el archivo. Sin auto-bump: archivo y DB no divergen jamás.
 */
export function upsertPhaseModuleFromSeed(
  db: AgentosSqliteDb,
  seed: ParsedModuleSeed,
): { module: PhaseModule; created: boolean } {
  const existing = getModuleVersion(db, seed.slug, seed.version);
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
  createModuleVersion(db, {
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
  const active = activateModuleVersion(db, seed.slug, seed.version);
  return { module: active, created: true };
}

// ── Launches (el motor de launch — src/modules/launch.ts — orquesta; las
// consultas viven aquí por la regla del paquete: nada consulta fuera de
// repositories/) ────────────────────────────────────────────────────────────

export function getLaunch(db: AgentosSqliteDb, id: string): ModuleLaunch | undefined {
  return db.select().from(moduleLaunches).where(eq(moduleLaunches.id, id)).get();
}

/**
 * Insert del recibo INMUTABLE (append-only; no existe update/delete de
 * launches en ninguna capa). Lo llama SOLO el motor de launch, dentro de su
 * transacción única (§13.3).
 */
export function insertModuleLaunch(db: AgentosSqliteDb, row: NewModuleLaunch): ModuleLaunch {
  db.insert(moduleLaunches).values(row).run();
  return getLaunch(db, row.id)!;
}

/**
 * ¿Ya se disparó esta fase sobre este proyecto? Espejo en lectura del índice
 * `uq(project_id, phase)`: el motor rechaza con error de dominio ANTES de que
 * el INSERT reviente el índice ([SÍNTESIS] Codex §13.1).
 */
export function findLaunchByProjectAndPhase(
  db: AgentosSqliteDb,
  projectId: string,
  phase: Stage,
): ModuleLaunch | undefined {
  return db
    .select()
    .from(moduleLaunches)
    .where(and(eq(moduleLaunches.projectId, projectId), eq(moduleLaunches.phase, phase)))
    .get();
}

export function findLaunchByIdempotencyKey(
  db: AgentosSqliteDb,
  idempotencyKey: string,
): ModuleLaunch | undefined {
  return db
    .select()
    .from(moduleLaunches)
    .where(eq(moduleLaunches.idempotencyKey, idempotencyKey))
    .get();
}

/**
 * Último launch del proyecto (M3, CA-M3.1): el recibo cuyos `deliverables`
 * efectivos definen el cierre de fase vigente.
 *
 * Desempate por `id DESC` (dos launches con el mismo `created_at` inyectado en
 * tests): los ids son uuidv7 —monotónicos por tiempo—, así que reproducen el
 * orden de inserción que antes daba `rowid`, y la consulta es la MISMA en
 * Postgres, que no tiene rowid.
 */
export function getLatestLaunchForProject(
  db: AgentosSqliteDb,
  projectId: string,
): ModuleLaunch | undefined {
  return db
    .select()
    .from(moduleLaunches)
    .where(eq(moduleLaunches.projectId, projectId))
    .orderBy(desc(moduleLaunches.createdAt), desc(moduleLaunches.id))
    .get();
}

export function listLaunches(
  db: AgentosSqliteDb,
  filter: { projectId?: string; moduleSlug?: string } = {},
): ModuleLaunch[] {
  const conds = [];
  if (filter.projectId) conds.push(eq(moduleLaunches.projectId, filter.projectId));
  if (filter.moduleSlug) conds.push(eq(moduleLaunches.moduleSlug, filter.moduleSlug));
  const base = db.select().from(moduleLaunches);
  const q = conds.length > 0 ? base.where(and(...conds)) : base;
  return q.orderBy(desc(moduleLaunches.createdAt)).all();
}
