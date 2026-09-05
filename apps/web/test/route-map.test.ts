/**
 * Mapa del ciclo: hitos por etapa, estado de cada candado y enlace de cada
 * entregable que falta con la tarea que lo produce (PLAN-v1.5 §4).
 */
import { describe, expect, it } from "vitest";
import {
  buildCycle,
  findProducingTask,
  gateStateFor,
  humanizeKind,
  milestonesFor,
  missingDeliverables,
} from "../src/lib/route-map";
import { makeTask, project } from "./helpers";
import type { PhaseClosureStatus } from "../src/lib/types";

const tasks = [
  makeTask({ id: "t1", stage: "ENTENDER", activityType: "entrevista", status: "DONE" }),
  makeTask({ id: "t2", stage: "ENTENDER", activityType: "entrevista", status: "IN_PROGRESS" }),
  makeTask({ id: "t3", stage: "ENTENDER", activityType: "proceso_asis", status: "BACKLOG" }),
  makeTask({ id: "t4", stage: "CONSTRUIR", activityType: null, status: "BACKLOG" }),
  makeTask({ id: "t5", stage: "ENTENDER", activityType: "entrevista", status: "CANCELLED" }),
];

const incomplete: PhaseClosureStatus = {
  launchId: "l-1",
  complete: false,
  items: [
    {
      kind: "proceso_asis",
      source: "process",
      required: 2,
      found: 0,
      missing: 'Falta(n) 2 de 2 "proceso_asis"',
    },
    { kind: "entrevista", source: "knowledge_doc", required: 1, found: 1, missing: null },
  ],
};

const complete: PhaseClosureStatus = { launchId: "l-1", complete: true, items: incomplete.items.map((i) => ({ ...i, missing: null })) };

describe("mapa del ciclo", () => {
  it("agrupa los hitos por tipo de actividad e ignora las canceladas", () => {
    const milestones = milestonesFor("ENTENDER", tasks);
    const entrevista = milestones.find((m) => m.label === "Entrevista");
    expect(entrevista?.total).toBe(2);
    expect(entrevista?.done).toBe(1);
    expect(entrevista?.state).toBe("now");
    const asis = milestones.find((m) => m.label === "Procesos as-is");
    expect(asis?.state).toBe("open");
  });

  it("nombra los hitos sin etapa como trabajo de la fase", () => {
    const milestones = milestonesFor("CONSTRUIR", tasks);
    expect(milestones[0]?.label).toBe("Trabajo de la fase");
  });

  it("un candado se abre sólo cuando el cierre de fase está completo", () => {
    const pending = { stage: "ENTENDER", gateState: "pending" } as const;
    expect(gateStateFor("ENTENDER", pending, false)).toBe("locked");
    expect(gateStateFor("ENTENDER", pending, true)).toBe("ready");
    expect(gateStateFor("CONSTRUIR", pending, true)).toBe("locked");
    expect(gateStateFor("ENTENDER", { stage: "CONSTRUIR", gateState: "pending" }, false)).toBe("passed");
    expect(gateStateFor("ENTENDER", { stage: "ENTENDER", gateState: "approved" }, false)).toBe("passed");
  });

  it("construye tres columnas con su gate y su posición en el ciclo", () => {
    const columns = buildCycle(project, tasks, incomplete);
    expect(columns.map((c) => c.stage)).toEqual(["ENTENDER", "CONSTRUIR", "OPERAR"]);
    expect(columns[0]?.status).toBe("active");
    expect(columns[1]?.status).toBe("blocked");
    expect(columns[0]?.gate?.code).toBe("G1");
    expect(columns[0]?.gate?.state).toBe("locked");
    expect(buildCycle(project, tasks, complete)[0]?.gate?.state).toBe("ready");
  });

  it("el candado listo dice qué fase abre", () => {
    expect(buildCycle(project, tasks, complete)[0]?.gate?.caption).toContain("abre Construir");
  });

  it("enlaza cada entregable que falta con la tarea que lo produce", () => {
    const missing = missingDeliverables(incomplete, tasks);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.label).toBe("Procesos as-is");
    expect(missing[0]?.task?.id).toBe("t3");
  });

  it("busca la tarea productora por actividad, etiqueta y título, y no inventa una", () => {
    const item = { kind: "roadmap", source: "artifact" as const, required: 1, found: 0, missing: "falta" };
    expect(findProducingTask(item, tasks)).toBeNull();
    const byLabel = makeTask({ id: "t-label", labels: ["roadmap"], status: "READY" });
    expect(findProducingTask(item, [byLabel])?.id).toBe("t-label");
    const byTitle = makeTask({ id: "t-title", title: "Preparar el roadmap priorizado", status: "READY" });
    expect(findProducingTask(item, [byTitle])?.id).toBe("t-title");
  });

  it("humaniza los kind del cierre en vez de mostrar la enumeración cruda", () => {
    expect(humanizeKind("resumen_ejecutivo")).toBe("Resumen ejecutivo");
    expect(humanizeKind("sin_diccionario")).toBe("Sin diccionario");
  });
});
