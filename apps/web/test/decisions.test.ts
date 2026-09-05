/**
 * Modelo de la bandeja "Hoy": riesgo, orden, agrupación por proyecto y gate,
 * lote y resumen legible del payload (PLAN-v1.5 §La pantalla de entrada).
 */
import { describe, expect, it } from "vitest";
import {
  batchable,
  buildDecisions,
  daysWaiting,
  groupDecisions,
  nextStage,
  sortByRisk,
  summarizePayload,
} from "../src/lib/decisions";
import { makeApproval, makeTask, project } from "./helpers";
import type { Project } from "../src/lib/types";

const otherProject: Project = { ...project, id: "proj-2", name: "Conecty", stage: "CONSTRUIR" };

const gateApproval = makeApproval({ id: "ap-gate", kind: "gate", createdAt: 5_000 });
const toolApproval = makeApproval({ id: "ap-tool", kind: "tool_call", createdAt: 1_000 });
const deliverableApproval = makeApproval({
  id: "ap-deliv",
  kind: "deliverable",
  projectId: otherProject.id,
  createdAt: 2_000,
});

const routineReview = {
  task: makeTask({ id: "t-rutina", status: "REVIEW", title: "Notas de la entrevista 4", updatedAt: 3_000 }),
  artifacts: [],
};
const sensitiveReview = {
  task: makeTask({
    id: "t-sensible",
    status: "REVIEW",
    title: "Correo al sponsor",
    requiresApproval: true,
    updatedAt: 4_000,
  }),
  artifacts: [],
};
const secondRoutine = {
  task: makeTask({ id: "t-rutina-2", status: "REVIEW", title: "Notas de la entrevista 5", updatedAt: 6_000 }),
  artifacts: [],
};

function build() {
  return buildDecisions(
    [gateApproval, toolApproval, deliverableApproval],
    [routineReview, sensitiveReview, secondRoutine],
    [project, otherProject],
  );
}

describe("decisiones de Hoy", () => {
  it("asigna riesgo alto al gate y al efecto externo, y bajo a la revisión rutinaria", () => {
    const byId = new Map(build().map((d) => [d.id, d]));
    expect(byId.get("approval:ap-gate")?.risk).toBe("alto");
    expect(byId.get("approval:ap-tool")?.risk).toBe("alto");
    expect(byId.get("approval:ap-deliv")?.risk).toBe("medio");
    expect(byId.get("review:t-sensible")?.risk).toBe("medio");
    expect(byId.get("review:t-rutina")?.risk).toBe("bajo");
  });

  it("ordena por riesgo y, a igual riesgo, por lo que lleva más tiempo esperando", () => {
    const ids = sortByRisk(build()).map((d) => d.id);
    expect(ids.slice(0, 2)).toEqual(["approval:ap-tool", "approval:ap-gate"]);
    // Los de riesgo bajo cierran la lista.
    expect(ids.slice(-2)).toEqual(["review:t-rutina", "review:t-rutina-2"]);
  });

  it("dice qué desbloquea un gate nombrando la fase que abre", () => {
    const gate = build().find((d) => d.id === "approval:ap-gate");
    expect(gate?.unlocks).toContain("Cierra Entender");
    expect(gate?.unlocks).toContain("abre Construir");
    expect(nextStage("OPERAR")).toBeNull();
  });

  it("agrupa por proyecto y por gate, con el nombre del cliente resuelto", () => {
    const groups = groupDecisions(build(), [project, otherProject]);
    const keys = groups.map((g) => g.key);
    expect(keys).toContain(`${project.id}|gate`);
    expect(keys).toContain(`${project.id}|tool_call`);
    expect(keys).toContain(`${otherProject.id}|deliverable`);
    const conecty = groups.find((g) => g.projectId === otherProject.id);
    expect(conecty?.projectName).toBe("Conecty");
    // Las dos revisiones rutinarias del mismo proyecto caen en un solo grupo.
    const review = groups.find((g) => g.key === `${project.id}|review`);
    expect(review?.decisions).toHaveLength(3);
  });

  it("el lote sólo admite riesgo bajo: ni gates, ni efectos externos, ni sensibles", () => {
    const ids = batchable(build()).map((d) => d.id);
    expect(ids).toEqual(["review:t-rutina", "review:t-rutina-2"]);
  });

  it("cuenta los días de espera", () => {
    const [decision] = buildDecisions([makeApproval({ createdAt: 0 })], [], [project]);
    expect(daysWaiting(decision!, 3 * 86_400_000)).toBe(3);
  });

  it("resume el payload en líneas legibles en vez de JSON crudo", () => {
    const lines = summarizePayload({
      tool: "email.send",
      args: { to: "cliente@acme.com", cc: ["a@b.c", "d@e.f"], borrador: true },
      motivo: "cierre de fase",
    });
    expect(lines).toContainEqual({ label: "to", value: "cliente@acme.com" });
    expect(lines).toContainEqual({ label: "cc", value: "a@b.c, d@e.f" });
    expect(lines).toContainEqual({ label: "borrador", value: "sí" });
    expect(lines).toContainEqual({ label: "motivo", value: "cierre de fase" });
    // El nombre del tool tiene su propio sitio en la tarjeta.
    expect(lines.some((l) => l.label === "tool")).toBe(false);
  });
});
