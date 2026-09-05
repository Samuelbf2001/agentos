import { describe, expect, it } from "vitest";
import {
  bindProjectSchema,
  bindTaskSchema,
  IMPORT_DEFAULTS,
  mapDueDate,
  mapProjectPage,
  mapTaskPage,
  mapTaskPriority,
  mapTaskStatus,
  nextOrderKey,
  NOTION_STATUS_TO_TASK_STATUS,
  resolveIdentity,
} from "../src/field-map.js";
import { PROJECTS_DB_ID, projectPage, projectsSchema, TASKS_DB_ID, taskPage, tasksSchema } from "./fixtures.js";

const ids = { tasksDatabaseId: TASKS_DB_ID, projectsDatabaseId: PROJECTS_DB_ID };

describe("enlace de esquema", () => {
  it("resuelve cada propiedad por su tipo y su base destino, no por el rótulo", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    expect(binding.titleProperty).toBe("Name");
    expect(binding.statusProperty).toBe("Estado");
    expect(binding.priorityProperty).toBe("Priority");
    expect(binding.dueDateProperty).toBe("Due Date");
    expect(binding.peopleProperty).toBe("Asignado");
    expect(binding.projectRelations).toEqual(["Project"]);
  });

  it("solo importa el lado 'depende de' de los pares duales de bloqueo", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    expect(binding.dependencyRelations).toEqual(["Bloqueado por"]);
    // `Bloqueando` es la inversa: se ignora para no duplicar la arista.
    expect(binding.dependencyRelations).not.toContain("Bloqueando");
    expect(binding.unknownSelfRelations).toEqual([]);
  });

  it("reporta una auto-relación con semántica desconocida en vez de adivinarla", () => {
    const schema = tasksSchema();
    (schema.properties as Record<string, unknown>)["Relacionada rara"] = {
      id: "rr",
      type: "relation",
      relation: { database_id: TASKS_DB_ID },
    };
    const binding = bindTaskSchema(schema, ids);
    expect(binding.unknownSelfRelations).toEqual(["Relacionada rara"]);

    const mapped = mapTaskPage(
      {
        ...taskPage({ id: "t1", title: "T" }),
        properties: {
          ...(taskPage({ id: "t1", title: "T" }).properties as Record<string, unknown>),
          "Relacionada rara": { id: "rr", type: "relation", relation: [{ id: "otra" }] },
        },
      },
      binding,
    );
    expect(mapped.exceptions.map((exception) => exception.reason)).toContain(
      "semantica_de_relacion_desconocida",
    );
  });

  it("detecta la relación tarea↔proyecto por la base destino aunque cambie el rótulo", () => {
    const schema = tasksSchema();
    const properties = schema.properties as Record<string, unknown>;
    properties["Proyecto (renombrado)"] = properties.Project;
    delete properties.Project;
    expect(bindTaskSchema(schema, ids).projectRelations).toEqual(["Proyecto (renombrado)"]);
  });

  it("enlaza el esquema de Projects", () => {
    const binding = bindProjectSchema(projectsSchema(), { tasksDatabaseId: TASKS_DB_ID });
    expect(binding.titleProperty).toBe("Name");
    expect(binding.taskRelations).toEqual(["Tasks"]);
  });
});

describe("estado", () => {
  it("traduce los cinco estados acordados", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const cases: [string, string][] = [
      ["Sin empezar", "BACKLOG"],
      ["Realizando", "IN_PROGRESS"],
      ["StandBy/Sin Información", "BLOCKED"],
      ["En validación", "REVIEW"],
      ["Completada", "DONE"],
    ];
    for (const [origen, destino] of cases) {
      expect(mapTaskStatus(taskPage({ id: "t", title: "T", estado: origen }), binding.statusProperty).status).toBe(
        destino,
      );
    }
    expect(Object.keys(NOTION_STATUS_TO_TASK_STATUS)).toHaveLength(5);
  });

  it("marca BLOCKED con motivo manual y conserva el valor original", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskStatus(
      taskPage({ id: "t", title: "T", estado: "StandBy/Sin Información" }),
      binding.statusProperty,
    );
    expect(mapped.blockedReason).toBe("manual");
    expect(mapped.originalValue).toBe("StandBy/Sin Información");
  });

  it("un estado desconocido va a cuarentena y cae a BACKLOG, nunca se inventa", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskStatus(taskPage({ id: "t", title: "T", estado: "Inventado" }), binding.statusProperty);
    expect(mapped.status).toBe("BACKLOG");
    expect(mapped.exception).toMatchObject({ reason: "estado_desconocido", rawReference: "Inventado" });
  });
});

describe("prioridad", () => {
  it("traduce la tabla acordada", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const cases: [string, string][] = [
      ["URGENTE!!!", "urgent"],
      ["ALTO", "high"],
      ["MEDIO", "normal"],
      ["BAJO", "low"],
    ];
    for (const [origen, destino] of cases) {
      expect(
        mapTaskPriority(taskPage({ id: "t", title: "T", priority: origen }), binding.priorityProperty).priority,
      ).toBe(destino);
    }
  });

  it("sin prioridad usa el default y NO registra excepción", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskPriority(taskPage({ id: "t", title: "T" }), binding.priorityProperty);
    expect(mapped.priority).toBe("normal");
    expect(mapped.exception).toBeUndefined();
  });

  it("una prioridad desconocida va a cuarentena", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskPriority(
      taskPage({ id: "t", title: "T", priority: "CRITICO" }),
      binding.priorityProperty,
    );
    expect(mapped.exception?.reason).toBe("prioridad_desconocida");
  });
});

describe("fechas", () => {
  it("usa el inicio del rango como due_at y conserva el fin", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapDueDate(
      taskPage({ id: "t", title: "T", due: { start: "2026-09-01", end: "2026-09-10", time_zone: "America/Bogota" } }),
      binding.dueDateProperty,
    );
    expect(mapped.dueAt).toBe(Date.parse("2026-09-01"));
    expect(mapped.rangeEnd).toBe("2026-09-10");
    expect(mapped.timeZone).toBe("America/Bogota");
  });

  it("sin fecha devuelve null sin excepción", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    expect(mapDueDate(taskPage({ id: "t", title: "T" }), binding.dueDateProperty).dueAt).toBeNull();
  });
});

describe("identidad", () => {
  const directory = { byEmail: new Map([["ernesto@sixteam.pro", "person-ernesto"]]) };

  it("empareja por correo confirmado", () => {
    const resolution = resolveIdentity(
      { notionPersonId: "n1", email: "ernesto@sixteam.pro", displayName: "Ernesto" },
      directory,
    );
    expect(resolution).toEqual({
      agentosPersonId: "person-ernesto",
      matchMethod: "confirmed_email",
      reason: null,
    });
  });

  it("NUNCA empareja por nombre: mismo nombre y sin correo queda sin resolver", () => {
    const resolution = resolveIdentity(
      { notionPersonId: "n2", email: null, displayName: "Ernesto" },
      directory,
    );
    expect(resolution.agentosPersonId).toBeNull();
    expect(resolution.matchMethod).toBe("unresolved");
    expect(resolution.reason).toBe("notion_no_expone_correo");
  });

  it("un correo sin persona en AgentOS queda sin resolver", () => {
    const resolution = resolveIdentity(
      { notionPersonId: "n3", email: "nadie@example.test", displayName: "X" },
      directory,
    );
    expect(resolution.matchMethod).toBe("unresolved");
    expect(resolution.reason).toBe("correo_sin_persona_en_agentos");
  });

  it("la decisión explícita del administrador manda sobre el correo", () => {
    const resolution = resolveIdentity(
      { notionPersonId: "n1", email: "ernesto@sixteam.pro", displayName: "Ernesto" },
      { ...directory, adminDecisions: new Map([["n1", "person-otro"]]) },
    );
    expect(resolution).toEqual({
      agentosPersonId: "person-otro",
      matchMethod: "admin_decision",
      reason: null,
    });
  });
});

describe("página completa", () => {
  it("mapea una tarea con proyecto, dependencia, responsables y valores originales", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskPage(
      taskPage({
        id: "task-1",
        title: "Revisar bot",
        estado: "Realizando",
        priority: "ALTO",
        due: { start: "2026-09-05" },
        people: [{ id: "u1", email: "ernesto@sixteam.pro" }],
        projectIds: ["proj-1"],
        blockedByIds: ["task-0"],
        tags: ["MKT"],
      }),
      binding,
    );
    expect(mapped).toMatchObject({
      title: "Revisar bot",
      status: "IN_PROGRESS",
      priority: "high",
      stage: IMPORT_DEFAULTS.taskStage,
      projectPageIds: ["proj-1"],
      dependsOnPageIds: ["task-0"],
    });
    expect(mapped.assignees[0]?.email).toBe("ernesto@sixteam.pro");
    expect(mapped.original.status).toBe("Realizando");
    expect(mapped.exceptions).toEqual([]);
  });

  it("una tarea con varios proyectos deja excepción explícita", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskPage(
      taskPage({ id: "task-2", title: "T", projectIds: ["p1", "p2"] }),
      binding,
    );
    expect(mapped.exceptions.map((exception) => exception.reason)).toContain("tarea_con_varios_proyectos");
  });

  it("los proyectos entran con type y stage uniformes, jamás derivados de FASE", () => {
    const binding = bindProjectSchema(projectsSchema(), { tasksDatabaseId: TASKS_DB_ID });
    const mapped = mapProjectPage(projectPage({ id: "p1", name: "Cliente X", fase: "Implementacion" }), binding);
    expect(mapped.type).toBe(IMPORT_DEFAULTS.projectType);
    expect(mapped.stage).toBe(IMPORT_DEFAULTS.projectStage);
    expect(mapped.name).toBe("Cliente X");
  });

  it("un título vacío no se rellena: se reporta", () => {
    const binding = bindTaskSchema(tasksSchema(), ids);
    const mapped = mapTaskPage(taskPage({ id: "task-3", title: "" }), binding);
    expect(mapped.exceptions.map((exception) => exception.reason)).toContain("titulo_vacio_en_origen");
  });
});

describe("clave de orden", () => {
  it("crece de forma monótona y lexicográfica", () => {
    const first = nextOrderKey(null);
    const second = nextOrderKey(first);
    expect(first).toBe("m");
    expect(second > first).toBe(true);
    expect(nextOrderKey("z") > "z").toBe(true);
  });
});
