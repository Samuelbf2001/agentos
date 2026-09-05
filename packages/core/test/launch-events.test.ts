/**
 * launchModuleWithEvents (M2 — §13.3): el motor de @agentos/db no publica nada;
 * la capa de core publica sus pendingEvents AG-UI POST-commit por el EventSink.
 */
import { describe, expect, it } from "vitest";
import { openDb, runMigrations, seed, type AgentosDb } from "@agentos/db";
import { launchModuleWithEvents, recordingEventSink } from "../src/index.js";

async function seededDb(): Promise<AgentosDb> {
  const db = openDb(":memory:");
  runMigrations(db);
  await seed(db, { env: {} });
  return db;
}

const INPUTS = {
  empresa: "Nova Manufactura S.A.",
  alias: "Nova",
  industria: "manufactura",
  empleados: 40,
  sponsor: "Gerente General",
  objetivo: "Diagnóstico Entender.",
  areas: ["direccion", "operaciones"],
  procesos_core: ["Producción"],
  fecha_objetivo: "2026-09-15",
};

describe("launchModuleWithEvents", () => {
  it("publica los pendingEvents tras el commit: task.created×N + module.launched", async () => {
    const db = await seededDb();
    const sink = recordingEventSink();
    const r = await launchModuleWithEvents(db, sink, {
      moduleSlug: "consultoria",
      org: { name: "Nova Manufactura S.A." },
      inputs: INPUTS,
      actor: "person:ernesto",
      idempotencyKey: "launch:test:core:nova",
    });

    // 2 áreas + 1 proceso, sin ISO → 9 tareas; 9 task.created + 1 module.launched.
    expect(r.tasks).toHaveLength(9);
    expect(sink.published).toHaveLength(r.pendingEvents.length);
    expect(sink.published).toHaveLength(10);
    expect(new Set(sink.published.map((p) => p.topic))).toEqual(new Set([`board:${r.project.id}`]));
    expect(sink.published.slice(0, 9).every((p) => p.event.type === "task.created")).toBe(true);
    const last = sink.published[9]!;
    expect(last.event.type).toBe("module.launched");
    expect(last.event.payload?.["launchId"]).toBe(r.launch.id);

    // Retorno idempotente: nada nuevo → nada re-publicado.
    const again = await launchModuleWithEvents(db, sink, {
      moduleSlug: "consultoria",
      org: { name: "Nova Manufactura S.A." },
      inputs: INPUTS,
      actor: "person:ernesto",
      idempotencyKey: "launch:test:core:nova",
    });
    expect(again.idempotent).toBe(true);
    expect(sink.published).toHaveLength(10);
  });
});
