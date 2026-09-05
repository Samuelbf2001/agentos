/**
 * Ficha "Historial de Notion" por REST. Datos SINTÉTICOS: el snapshot real de
 * Sixteam nunca entra en la suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNotionMigrationRun,
  createNotionPageArchive,
  createTask,
  recordNotionQuarantine,
  upsertNotionImportLink,
} from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeEach(async () => {
  fx = await makeFixture();
});

afterEach(async () => {
  await fx.close();
});

async function seedOrigin(objectKind: "task" | "project", objectId: string, notionPageId: string) {
  const run = (await createNotionMigrationRun(fx.db, {
    sourceSchemaVersion: "esquema-de-prueba",
    capturedAt: 1_700_000_000_000,
    manifestHash: "hash-de-prueba",
    snapshotRunId: "notion-fixture-run",
    mode: "full",
    status: "completed",
    immutable: true,
  }));
  const archive = (await createNotionPageArchive(fx.db, {
    migrationRunId: run.id,
    sourceKind: objectKind,
    notionPageId,
    originalUrl: `https://notion.example/${notionPageId}`,
    rawPageUri: `tasks/pages/${notionPageId}.page.json`,
    rawBlocksUri: `tasks/blocks/${notionPageId}.json`,
    rawCommentsUri: `tasks/comments/${notionPageId}.json`,
    rawFilesUri: null,
    payload: {
      page: { properties: { Tags: { multi_select: [{ name: "MKT" }] }, "HH estimadas": { number: 4 } } },
      blocks: { block_id: notionPageId, responses: [] },
      comments: [],
      files: null,
    },
    payloadHash: "a".repeat(64),
    capturedAt: 1_700_000_000_000,
  }));
  (await upsertNotionImportLink(fx.db, {
    migrationRunId: run.id,
    sourceKind: objectKind,
    notionPageId,
    agentosObjectKind: objectKind,
    agentosObjectId: objectId,
    archiveId: archive.id,
    importStatus: "imported",
    sourceLastEditedAt: 1_699_000_000_000,
  }));
  (await recordNotionQuarantine(fx.db, {
    migrationRunId: run.id,
    sourceKind: objectKind === "task" ? "task" : "project",
    notionPageId,
    fieldName: "Tags",
    reason: "campo_sin_columna_nativa",
    rawReference: "MKT",
    resolutionState: "open",
  }));
  return { run, archive };
}

describe("GET /api/{tasks,projects}/:id/notion-origin", () => {
  it("devuelve el origen íntegro de una tarea importada", async () => {
    const task = (await createTask(fx.db, {
      projectId: fx.project.id,
      title: "Tarea importada",
      stage: "ENTENDER",
      status: "BACKLOG",
      orderKey: "m",
    }));
    await seedOrigin("task", task.id, "task-notion-1");

    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/notion-origin`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      has_origin: boolean;
      origin: {
        notion_page_id: string;
        original_url: string;
        payload: { page: { properties: Record<string, unknown> } };
        raw_uris: Record<string, string | null>;
        run: { snapshot_run_id: string };
        quarantine: { reason: string }[];
      };
    };
    expect(body.has_origin).toBe(true);
    expect(body.origin.notion_page_id).toBe("task-notion-1");
    expect(body.origin.original_url).toBe("https://notion.example/task-notion-1");
    // Los campos sin columna nativa se leen enteros desde el archivo.
    expect(body.origin.payload.page.properties["Tags"]).toBeDefined();
    expect(body.origin.payload.page.properties["HH estimadas"]).toBeDefined();
    expect(body.origin.raw_uris.page).toBe("tasks/pages/task-notion-1.page.json");
    expect(body.origin.run.snapshot_run_id).toBe("notion-fixture-run");
    expect(body.origin.quarantine.map((entry) => entry.reason)).toEqual(["campo_sin_columna_nativa"]);
  });

  it("una tarea nativa responde 200 con has_origin=false, no es un error", async () => {
    const task = (await createTask(fx.db, {
      projectId: fx.project.id,
      title: "Tarea nativa",
      stage: "ENTENDER",
      status: "BACKLOG",
      orderKey: "m",
    }));
    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/notion-origin`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ has_origin: false, origin: null });
  });

  it("devuelve el origen de un proyecto", async () => {
    await seedOrigin("project", fx.project.id, "proj-notion-1");
    const res = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${fx.project.id}/notion-origin`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { origin: { notion_page_id: string } }).origin.notion_page_id).toBe(
      "proj-notion-1",
    );
  });

  it("404 si el objeto no existe y 401 sin sesión", async () => {
    const missing = await fx.api.app.inject({
      method: "GET",
      url: "/api/tasks/no-existe/notion-origin",
      headers: fx.authHeaders,
    });
    expect(missing.statusCode).toBe(404);

    const unauthorized = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${fx.project.id}/notion-origin`,
    });
    expect(unauthorized.statusCode).toBe(401);
  });
});
