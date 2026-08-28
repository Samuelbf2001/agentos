/**
 * Tests de la tool `iso.gap_matrix_template` (preparación ISO 9001, F2-3):
 * - Devuelve una fila por cláusula (4.1–10.3) con el disclaimer literal.
 * - Pre-enlaza los procesos por `iso_refs` (cláusula exacta o su capítulo).
 * - Respeta el filtro `clausulas` y la allowlist del agente (fail-closed).
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { createAgent, createProcess } from "@agentos/db";
import { toolsFixture } from "./helpers.js";
import { ISO9001_CLAUSES, ISO_DISCLAIMER } from "../src/tools/iso.js";

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    if (isAgentosError(err)) return err.code;
    throw err;
  }
}

function okResult<T>(res: unknown): T {
  expect(res).toMatchObject({ status: "ok" });
  return (res as { status: "ok"; result: T }).result;
}

interface MatrixRow {
  clausula: string;
  titulo: string;
  proceso_id: string | null;
  proceso_nombre: string | null;
  procesos_relacionados: { id: string; name: string }[];
  estado: string | null;
  evidencia: string[];
}
interface Matrix {
  doc_type: string;
  disclaimer: string;
  procesos_considerados: number;
  filas: MatrixRow[];
  alcance_sgc: string | null;
}

function samWith(f: ReturnType<typeof toolsFixture>, allowlist: string[]) {
  return createAgent(f.db, {
    slug: "sam",
    name: "Sam",
    layer: "consultoria",
    runtime: "ai_sdk",
    toolsAllowlist: allowlist,
  });
}

describe("iso.gap_matrix_template (F2-3)", () => {
  it("una fila por cláusula 4.1–10.3, con disclaimer literal y estado sin asignar", async () => {
    const f = toolsFixture();
    const sam = samWith(f, ["iso.gap_matrix_template"]);
    const m = okResult<Matrix>(
      await f.runtime.execute(f.ctxFor(sam), "iso.gap_matrix_template", {
        org_id: f.project.orgId,
        alcance_sgc: "Producción y comercialización",
      }),
    );
    expect(m.doc_type).toBe("iso_gap_matrix");
    expect(m.disclaimer).toBe(ISO_DISCLAIMER);
    expect(m.disclaimer).toContain("organismo de certificación acreditado");
    expect(m.alcance_sgc).toBe("Producción y comercialización");
    expect(m.filas).toHaveLength(ISO9001_CLAUSES.length);
    expect(m.filas.map((r) => r.clausula)).toContain("4.1");
    expect(m.filas.map((r) => r.clausula)).toContain("10.3");
    // El esqueleto NO asigna conformidad: estado queda null y evidencia vacía.
    for (const row of m.filas) {
      expect(row.estado).toBeNull();
      expect(row.evidencia).toEqual([]);
    }
  });

  it("pre-enlaza procesos por iso_refs (cláusula exacta y por capítulo)", async () => {
    const f = toolsFixture();
    const sam = samWith(f, ["iso.gap_matrix_template"]);
    const compras = createProcess(f.db, {
      orgId: f.project.orgId,
      name: "Compras y abastecimiento",
      variant: "as_is",
      isoRefs: ["8.4"],
    });
    const produccion = createProcess(f.db, {
      orgId: f.project.orgId,
      name: "Producción",
      variant: "as_is",
      isoRefs: ["8"], // capítulo entero → cubre 8.1..8.7
    });

    const m = okResult<Matrix>(
      await f.runtime.execute(f.ctxFor(sam), "iso.gap_matrix_template", { org_id: f.project.orgId }),
    );
    expect(m.procesos_considerados).toBe(2);
    const row84 = m.filas.find((r) => r.clausula === "8.4")!;
    // 8.4 lo cubren AMBOS: Compras (match exacto) y Producción (match por capítulo "8").
    const ids84 = row84.procesos_relacionados.map((p) => p.id).sort();
    expect(ids84).toEqual([compras.id, produccion.id].sort());
    // 8.6 solo lo cubre Producción (por capítulo).
    const row86 = m.filas.find((r) => r.clausula === "8.6")!;
    expect(row86.procesos_relacionados.map((p) => p.id)).toEqual([produccion.id]);
    // Una cláusula sin proceso relacionado queda con proceso_id null.
    const row41 = m.filas.find((r) => r.clausula === "4.1")!;
    expect(row41.proceso_id).toBeNull();
    expect(row41.procesos_relacionados).toEqual([]);
  });

  it("respeta el filtro `clausulas`", async () => {
    const f = toolsFixture();
    const sam = samWith(f, ["iso.gap_matrix_template"]);
    const m = okResult<Matrix>(
      await f.runtime.execute(f.ctxFor(sam), "iso.gap_matrix_template", {
        org_id: f.project.orgId,
        clausulas: ["8.4", "9.2"],
      }),
    );
    expect(m.filas.map((r) => r.clausula)).toEqual(["8.4", "9.2"]);
  });

  it("fuera de la allowlist → policy_denied (fail-closed)", async () => {
    const f = toolsFixture();
    const sam = samWith(f, ["knowledge.get"]); // sin la tool ISO
    expect(
      await codeOf(() =>
        f.runtime.execute(f.ctxFor(sam), "iso.gap_matrix_template", { org_id: f.project.orgId }),
      ),
    ).toBe(ErrorCodes.POLICY_DENIED);
  });
});
