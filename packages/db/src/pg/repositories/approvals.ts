/** Espejo Postgres de src/repositories/approvals.ts — misma superficie, asíncrona (§NFR-9). */
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { AgentosError, ErrorCodes, errors, newId, nowMs, type ApprovalStatus } from "@agentos/shared";
import type { AgentosPgDb } from "../client-pg.js";
import { approvals } from "../schema-pg.js";
import type { Approval, NewApproval } from "../types-pg.js";

/**
 * Digest estable del payload literal de la acción (ARCHITECTURE §5):
 * JSON canónico (claves ordenadas recursivamente) → sha256 hex.
 * Cambiar cualquier argumento cambia el digest e invalida la aprobación.
 */
export function digestPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Crea una aprobación pendiente. El digest se calcula SIEMPRE aquí a partir del
 * payload literal — el llamador no puede fabricar un digest que no corresponda.
 * unique(action_digest, run_id) impide duplicar la misma acción en el mismo run.
 */
export async function createApproval(
  db: AgentosPgDb,
  input: Omit<NewApproval, "id" | "createdAt" | "actionDigest" | "status"> & { id?: string },
): Promise<Approval> {
  const row: NewApproval = {
    ...input,
    id: input.id ?? newId(),
    actionDigest: digestPayload(input.payload),
    status: "pending",
    createdAt: nowMs(),
  };
  await db.insert(approvals).values(row);
  return (await getApproval(db, row.id!))!;
}

export async function getApproval(db: AgentosPgDb, id: string): Promise<Approval | undefined> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  return row;
}

export async function listPendingApprovals(db: AgentosPgDb): Promise<Approval[]> {
  return await db
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"))
    .orderBy(asc(approvals.createdAt));
}

/**
 * Decide una aprobación (solo pendientes; decidir dos veces falla explícitamente).
 * La ejecución del efecto y el run de reanudación son de B3 — aquí solo el estado.
 *
 * El UPDATE es CONDICIONAL (`status = 'pending'`): la decisión es atómica a nivel
 * SQL, así que dos decisiones concurrentes (p. ej. la API y el MCP admin, que abren
 * conexiones distintas al mismo Postgres) no pueden pisarse — la segunda no afecta
 * ninguna fila (`.returning()` vacío) y falla con `conflict` en vez de un
 * last-write-wins que dejaría el estado mintiendo (NFR-12: aprobaciones
 * transaccionales e idempotentes).
 */
export async function decideApproval(
  db: AgentosPgDb,
  id: string,
  decision: {
    status: Exclude<ApprovalStatus, "pending">;
    decidedByPersonId: string;
    note?: string;
  },
): Promise<Approval> {
  const updated = await db
    .update(approvals)
    .set({
      status: decision.status,
      decidedByPersonId: decision.decidedByPersonId,
      note: decision.note ?? null,
      decidedAt: nowMs(),
    })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (updated.length === 0) {
    const current = await getApproval(db, id);
    if (!current) throw errors.notFound("approval", id);
    throw new AgentosError(
      ErrorCodes.CONFLICT,
      `La aprobación ${id} ya fue decidida (${current.status}); no se decide dos veces`,
      { approvalId: id, status: current.status },
    );
  }
  const updatedApproval = (await getApproval(db, id))!;
  return updatedApproval;
}

/** Valida que el payload a ejecutar sigue siendo EXACTAMENTE el aprobado. */
export function verifyApprovalDigest(approval: Approval, payload: unknown): boolean {
  return approval.actionDigest === digestPayload(payload);
}

/**
 * Aprobaciones YA decididas (approved|rejected) pero SIN reconciliar todavía
 * (fix Q2): son las que el despachador de apps/api debe drenar para ejecutar el
 * efecto del tool_call y/o desbloquear la tarea. Incluye las decididas por el
 * MCP admin (que solo fija el estado y no puede ejecutar el efecto).
 */
export async function listReconcilableApprovals(db: AgentosPgDb): Promise<Approval[]> {
  return await db
    .select()
    .from(approvals)
    .where(and(ne(approvals.status, "pending"), isNull(approvals.reconciledAt)))
    .orderBy(asc(approvals.createdAt));
}

/**
 * Reclama ATÓMICAMENTE la reconciliación de una aprobación decidida (fix Q2):
 * fija `reconciled_at` solo si la aprobación está decidida y aún sin reconciliar.
 * Una fila devuelta por `.returning()` = el llamador ganó la reconciliación y es
 * el ÚNICO que debe ejecutar el efecto externo; ninguna fila = ya la reconcilió
 * otro (REST o un tick del despachador) — garantiza ejecución exactamente-una-vez
 * del efecto.
 */
export async function claimApprovalReconciliation(db: AgentosPgDb, id: string): Promise<boolean> {
  const updated = await db
    .update(approvals)
    .set({ reconciledAt: nowMs() })
    .where(and(eq(approvals.id, id), ne(approvals.status, "pending"), isNull(approvals.reconciledAt)))
    .returning({ id: approvals.id });
  return updated.length === 1;
}
