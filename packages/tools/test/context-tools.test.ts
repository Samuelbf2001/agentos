/**
 * Tests de los fixes del ciclo B8 sobre tools de contexto y tablero:
 * - H2: board.get con project_id inexistente → not_found (jamás tablero vacío OK).
 * - H3: knowledge.search devuelve snippet útil del body y knowledge.get lee el doc completo.
 * - H8: processes.upsert acepta source_doc_ids y avisa cuando un as_is queda sin fuentes.
 */
import { describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { createDoc, getProcess } from "@agentos/db";
import { toolsFixture } from "./helpers.js";

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

describe("board.get (fix H2)", () => {
  it("project_id inexistente → not_found, no un tablero vacío OK", async () => {
    const f = toolsFixture();
    expect(
      await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "board.get", { project_id: "assessment-acme" })),
    ).toBe(ErrorCodes.NOT_FOUND);
    // El proyecto real sigue funcionando.
    const board = okResult<{ project_id: string; total: number }>(
      await f.runtime.execute(f.ctxFor(f.alex), "board.get", { project_id: f.project.id }),
    );
    expect(board.project_id).toBe(f.project.id);
  });
});

describe("knowledge.search + knowledge.get (fix H3)", () => {
  it("search devuelve snippet con contexto del body; get devuelve el doc completo", async () => {
    const f = toolsFixture();
    const doc = createDoc(f.db, {
      projectId: f.project.id,
      kind: "interview",
      title: "Entrevista: Jefe de Producción",
      bodyMd:
        "La planta pierde unas 12 horas semanales en retrabajos por falta de registros de calidad. " +
        "El jefe de producción estima $12.000/mes de fuga.",
    });

    const hits = okResult<{ id: string; title: string; snippet: string }[]>(
      await f.runtime.execute(f.ctxFor(f.alex), "knowledge.search", { query: "retrabajos" }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(doc.id);
    // El snippet trae CONTEXTO del body (no solo metadata) con el match marcado.
    expect(hits[0]!.snippet).toContain("«retrabajos»");
    expect(hits[0]!.snippet).toContain("registros de calidad");

    const full = okResult<{ id: string; bodyMd: string }>(
      await f.runtime.execute(f.ctxFor(f.alex), "knowledge.get", { doc_id: doc.id }),
    );
    expect(full.id).toBe(doc.id);
    expect(full.bodyMd).toContain("$12.000/mes");
  });

  it("knowledge.get con doc inexistente → not_found", async () => {
    const f = toolsFixture();
    expect(
      await codeOf(() => f.runtime.execute(f.ctxFor(f.alex), "knowledge.get", { doc_id: "no-existe" })),
    ).toBe(ErrorCodes.NOT_FOUND);
  });
});

describe("processes.upsert con provenance (fix H8)", () => {
  it("acepta source_doc_ids y los persiste", async () => {
    const f = toolsFixture();
    const doc = createDoc(f.db, {
      projectId: f.project.id,
      kind: "interview",
      title: "Entrevista producción",
      bodyMd: "Flujo de planta descrito.",
    });
    const res = okResult<{ id: string; sourceDocIds: string[] | null; warning?: string }>(
      await f.runtime.execute(f.ctxFor(f.alex), "processes.upsert", {
        org_id: f.project.orgId,
        name: "Producción as-is",
        variant: "as_is",
        source_doc_ids: [doc.id],
      }),
    );
    expect(res.sourceDocIds).toEqual([doc.id]);
    expect(res.warning).toBeUndefined();
    expect(getProcess(f.db, res.id)?.sourceDocIds).toEqual([doc.id]);
  });

  it("un as_is sin fuentes se acepta pero devuelve warning de provenance", async () => {
    const f = toolsFixture();
    const res = okResult<{ id: string; warning?: string }>(
      await f.runtime.execute(f.ctxFor(f.alex), "processes.upsert", {
        org_id: f.project.orgId,
        name: "Ventas as-is",
        variant: "as_is",
      }),
    );
    expect(res.warning).toContain("source_doc_ids");
    // link_source cierra el hueco.
    const doc = createDoc(f.db, { kind: "interview", title: "Entrevista ventas", bodyMd: "Ciclo de venta." });
    const linked = okResult<{ sourceDocIds: string[] | null }>(
      await f.runtime.execute(f.ctxFor(f.alex), "processes.link_source", {
        process_id: res.id,
        doc_id: doc.id,
      }),
    );
    expect(linked.sourceDocIds).toEqual([doc.id]);
  });
});
