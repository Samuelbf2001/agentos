import { describe, expect, it } from "vitest";
import { selectPilot, type PilotCandidate, type PilotFeature } from "../src/pilot-selection.js";

function candidate(
  notionPageId: string,
  features: PilotFeature[],
  projectPageIds: string[] = [],
): PilotCandidate {
  return { notionPageId, features: new Set(features), projectPageIds };
}

describe("selección del piloto por cobertura", () => {
  it("prefiere las tareas que aportan rasgos nuevos, no el prefijo alfabético", () => {
    const candidates = [
      candidate("a-aburrida-1", ["con_proyecto"], ["p1"]),
      candidate("a-aburrida-2", ["con_proyecto"], ["p1"]),
      candidate("z-interesante", ["con_proyecto", "multi_responsable", "con_adjunto"], ["p1"]),
    ];
    const selection = selectPilot(candidates, ["p1"], { tasks: 2, projects: 1 });
    // El prefijo alfabético habría elegido las dos aburridas.
    expect(selection.taskIds).toContain("z-interesante");
    expect(selection.covered).toContain("multi_responsable");
    expect(selection.covered).toContain("con_adjunto");
  });

  it("cubre los rasgos del plan cuando el lote da de sí", () => {
    const candidates = [
      candidate("t1", ["con_responsable", "multi_responsable"], ["p1"]),
      candidate("t2", ["con_fecha", "con_rango_de_fechas"], ["p1"]),
      candidate("t3", ["con_dependencia", "con_proyecto"], ["p2"]),
      candidate("t4", ["sin_proyecto"]),
      candidate("t5", ["con_adjunto", "con_comentario"], ["p1"]),
      candidate("t6", ["estado_terminado"], ["p1"]),
      candidate("t7", ["estado_bloqueado", "con_excepcion"], ["p1"]),
    ];
    const selection = selectPilot(candidates, ["p1", "p2"], { tasks: 7, projects: 2 });
    expect(selection.covered).toHaveLength(12);
    expect(selection.missing).toEqual([]);
    expect(selection.absent).toEqual([]);
  });

  it("es determinista: la misma entrada da el mismo lote", () => {
    const build = (): PilotCandidate[] => [
      candidate("t2", ["con_proyecto", "con_fecha"], ["p1"]),
      candidate("t1", ["con_proyecto", "con_fecha"], ["p1"]),
      candidate("t3", ["sin_proyecto"]),
    ];
    const first = selectPilot(build(), ["p1"], { tasks: 2, projects: 1 });
    const second = selectPilot(build(), ["p1"], { tasks: 2, projects: 1 });
    expect(first.taskIds).toEqual(second.taskIds);
    // Empate de ganancia → gana el id menor.
    expect(first.taskIds[0]).toBe("t1");
  });

  it("distingue lo que el lote no alcanzó de lo que el snapshot no tiene", () => {
    const candidates = [
      candidate("t1", ["con_proyecto"], ["p1"]),
      candidate("t2", ["multi_responsable"], ["p1"]),
    ];
    const selection = selectPilot(candidates, ["p1"], { tasks: 1, projects: 1 });
    expect(selection.missing).toContain("multi_responsable"); // existe, no entró
    expect(selection.absent).toContain("con_adjunto"); // no existe en el snapshot
    expect(selection.missing).not.toContain("con_adjunto");
  });

  it("los proyectos del lote salen de las tareas elegidas", () => {
    const candidates = [
      candidate("t1", ["con_proyecto", "con_adjunto"], ["p-de-la-tarea"]),
      candidate("t2", ["con_proyecto"], ["p-otro"]),
    ];
    const selection = selectPilot(candidates, ["p-otro", "p-de-la-tarea"], { tasks: 1, projects: 1 });
    expect(selection.taskIds).toEqual(["t1"]);
    expect(selection.projectIds).toEqual(["p-de-la-tarea"]);
  });

  it("un proyecto referenciado que no está en el snapshot no se inventa", () => {
    const candidates = [candidate("t1", ["con_proyecto"], ["p-fantasma"])];
    const selection = selectPilot(candidates, ["p-real"], { tasks: 1, projects: 1 });
    expect(selection.projectIds).toEqual(["p-real"]);
  });

  it("--pilot 0,0 no selecciona nada", () => {
    const selection = selectPilot([candidate("t1", ["con_proyecto"], ["p1"])], ["p1"], {
      tasks: 0,
      projects: 0,
    });
    expect(selection.taskIds).toEqual([]);
    expect(selection.projectIds).toEqual([]);
  });
});
