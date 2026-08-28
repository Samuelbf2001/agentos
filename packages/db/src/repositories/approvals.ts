import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { errors, newId, nowMs, type ApprovalStatus } from "@agentos/shared";
import type { AgentosDb } from "../client.js";
import { approvals } from "../schema.js";
import type { Approval, NewApproval } from "../types.js";

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
export function createApproval(
  db: AgentosDb,
  input: Omit<NewApproval, "id" | "createdAt" | "actionDigest" | "status"> & { id?: string },
): Approval {
  const row: NewApproval = {
    ...input,
    id: input.id ?? newId(),
    actionDigest: digestPayload(input.payload),
    status: "pending",
    createdAt: nowMs(),
  };
  db.insert(approvals).values(row).run();
  return getApproval(db, row.id!)!;
}

export function getApproval(db: AgentosDb, id: string): Approval | undefined {
  return db.select().from(approvals).where(eq(approvals.id, id)).get();
}

export function listPendingApprovals(db: AgentosDb): Approval[] {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"))
    .orderBy(asc(approvals.createdAt))
    .all();
}

/**
 * Decide una aprobación (solo pendientes; decidir dos veces falla explícitamente).
 * La ejecución del efecto y el run de reanudación son de B3 — aquí solo el estado.
 */
export function decideApproval(
  db: AgentosDb,
  id: string,
  decision: {
    status: Exclude<ApprovalStatus, "pending">;
    decidedByPersonId: string;
    note?: string;
  },
): Approval {
  const res = db
    .update(approvals)
    .set({
      status: decision.status,
      decidedByPersonId: decision.decidedByPersonId,
      note: decision.note ?? null,
      decidedAt: nowMs(),
    })
    .where(eq(approvals.id, id))
    .run();
  if (res.changes === 0) throw errors.notFound("approval", id);
  const updated = getApproval(db, id)!;
  return updated;
}

/** Valida que el payload a ejecutar sigue siendo EXACTAMENTE el aprobado. */
export function verifyApprovalDigest(approval: Approval, payload: unknown): boolean {
  return approval.actionDigest === digestPayload(payload);
}
