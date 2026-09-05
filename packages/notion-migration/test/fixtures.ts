/**
 * Fixtures SINTÉTICAS de snapshot. Nunca se usa el snapshot real en tests: los
 * datos de Notion de Sixteam no entran en el repositorio ni en la suite.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "../src/notion-client.js";

export const TASKS_DB_ID = "11111111-2222-3333-4444-555555555555";
export const PROJECTS_DB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

export function tasksSchema(): JsonObject {
  return {
    object: "database",
    id: TASKS_DB_ID,
    properties: {
      Name: { id: "title", type: "title", title: {} },
      Estado: {
        id: "st",
        type: "status",
        status: {
          options: [
            { id: "1", name: "Sin empezar" },
            { id: "2", name: "Realizando" },
            { id: "3", name: "StandBy/Sin Información" },
            { id: "4", name: "En validación" },
            { id: "5", name: "Completada" },
          ],
        },
      },
      Priority: {
        id: "pr",
        type: "select",
        select: { options: [{ name: "ALTO" }, { name: "MEDIO" }, { name: "BAJO" }, { name: "URGENTE!!!" }] },
      },
      "Due Date": { id: "dd", type: "date", date: {} },
      Asignado: { id: "as", type: "people", people: {} },
      Project: { id: "pj", type: "relation", relation: { database_id: PROJECTS_DB_ID, type: "dual_property" } },
      "Bloqueado por": {
        id: "bp",
        type: "relation",
        relation: { database_id: TASKS_DB_ID, type: "dual_property" },
      },
      Bloqueando: {
        id: "bd",
        type: "relation",
        relation: { database_id: TASKS_DB_ID, type: "dual_property" },
      },
      Tags: { id: "tg", type: "multi_select", multi_select: { options: [{ name: "MKT" }] } },
      "HH estimadas": { id: "hh", type: "number", number: {} },
    },
  };
}

export function projectsSchema(): JsonObject {
  return {
    object: "database",
    id: PROJECTS_DB_ID,
    properties: {
      Name: { id: "title", type: "title", title: {} },
      Tasks: { id: "tk", type: "relation", relation: { database_id: TASKS_DB_ID, type: "dual_property" } },
      FASE: { id: "fs", type: "select", select: { options: [{ name: "Implementacion" }] } },
      Owner: { id: "ow", type: "people", people: {} },
      "Archive?": { id: "ar", type: "checkbox", checkbox: {} },
    },
  };
}

export function titleValue(text: string): JsonObject {
  return { id: "title", type: "title", title: [{ type: "text", plain_text: text }] };
}

export interface TaskPageInput {
  id: string;
  title: string;
  estado?: string;
  priority?: string | null;
  due?: { start: string; end?: string | null; time_zone?: string | null } | null;
  people?: { id: string; name?: string; email?: string | null }[];
  projectIds?: string[];
  blockedByIds?: string[];
  tags?: string[];
  archived?: boolean;
  lastEditedTime?: string;
}

export function taskPage(input: TaskPageInput): JsonObject {
  return {
    object: "page",
    id: input.id,
    url: `https://notion.example/${input.id}`,
    archived: input.archived === true,
    in_trash: false,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: input.lastEditedTime ?? "2026-02-02T00:00:00.000Z",
    parent: { type: "database_id", database_id: TASKS_DB_ID },
    properties: {
      Name: titleValue(input.title),
      Estado: {
        id: "st",
        type: "status",
        status: input.estado ? { id: "x", name: input.estado, color: "green" } : null,
      },
      Priority: {
        id: "pr",
        type: "select",
        select: input.priority ? { id: "y", name: input.priority } : null,
      },
      "Due Date": { id: "dd", type: "date", date: input.due ?? null },
      Asignado: {
        id: "as",
        type: "people",
        people: (input.people ?? []).map((person) => ({
          object: "user",
          id: person.id,
          name: person.name ?? null,
          type: "person",
          ...(person.email === null ? {} : { person: { email: person.email ?? `${person.id}@example.test` } }),
        })),
      },
      Project: {
        id: "pj",
        type: "relation",
        relation: (input.projectIds ?? []).map((id) => ({ id })),
        has_more: false,
      },
      "Bloqueado por": {
        id: "bp",
        type: "relation",
        relation: (input.blockedByIds ?? []).map((id) => ({ id })),
        has_more: false,
      },
      Bloqueando: { id: "bd", type: "relation", relation: [], has_more: false },
      Tags: {
        id: "tg",
        type: "multi_select",
        multi_select: (input.tags ?? []).map((name) => ({ id: name, name })),
      },
      "HH estimadas": { id: "hh", type: "number", number: 4 },
    },
  };
}

export function projectPage(input: { id: string; name: string; fase?: string }): JsonObject {
  return {
    object: "page",
    id: input.id,
    url: `https://notion.example/${input.id}`,
    archived: false,
    in_trash: false,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-02T00:00:00.000Z",
    parent: { type: "database_id", database_id: PROJECTS_DB_ID },
    properties: {
      Name: titleValue(input.name),
      Tasks: { id: "tk", type: "relation", relation: [], has_more: false },
      FASE: { id: "fs", type: "select", select: input.fase ? { name: input.fase } : null },
      Owner: { id: "ow", type: "people", people: [] },
      "Archive?": { id: "ar", type: "checkbox", checkbox: false },
    },
  };
}

export interface SnapshotFixture {
  root: string;
  runId: string;
}

/** Escribe en disco un snapshot con la MISMA forma que produce el capturador. */
export async function writeSnapshotFixture(options: {
  tasks: JsonObject[];
  projects: JsonObject[];
  runId?: string;
  /** Manifiestos de adjuntos por id de página (`files/<id>.json`). */
  files?: Record<string, unknown>;
}): Promise<SnapshotFixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "agentos-notion-fixture-"));
  const runId = options.runId ?? "notion-fixture-run";
  const root = path.join(base, runId);
  await mkdir(root, { recursive: true });

  const sources: Record<string, { schema: JsonObject; pages: JsonObject[]; databaseId: string }> = {
    tasks: { schema: tasksSchema(), pages: options.tasks, databaseId: TASKS_DB_ID },
    projects: { schema: projectsSchema(), pages: options.projects, databaseId: PROJECTS_DB_ID },
  };

  const summaries = [];
  for (const [key, source] of Object.entries(sources)) {
    const sourceRoot = path.join(root, key);
    await mkdir(path.join(sourceRoot, "pages"), { recursive: true });
    await mkdir(path.join(sourceRoot, "blocks"), { recursive: true });
    await mkdir(path.join(sourceRoot, "comments"), { recursive: true });
    await writeFile(path.join(sourceRoot, "schema.json"), JSON.stringify(source.schema, null, 2));
    for (const page of source.pages) {
      const id = String(page.id);
      await writeFile(path.join(sourceRoot, "pages", `${id}.page.json`), JSON.stringify(page, null, 2));
      await writeFile(
        path.join(sourceRoot, "pages", `${id}.query.json`),
        JSON.stringify({ id, object: "page" }, null, 2),
      );
      await writeFile(
        path.join(sourceRoot, "blocks", `${id}.json`),
        JSON.stringify({ block_id: id, responses: [{ object: "list", results: [] }], children: [] }, null, 2),
      );
      await writeFile(
        path.join(sourceRoot, "comments", `${id}.json`),
        JSON.stringify([{ object: "list", results: [] }], null, 2),
      );
      const attachments = options.files?.[id];
      if (attachments) {
        await mkdir(path.join(sourceRoot, "files"), { recursive: true });
        await writeFile(
          path.join(sourceRoot, "files", `${id}.json`),
          JSON.stringify(attachments, null, 2),
        );
      }
    }
    summaries.push({
      database_id: source.databaseId,
      exceptions: [],
      key,
      pages_captured: source.pages.length,
      page_ids: source.pages.map((page) => String(page.id)),
      archived_captured: 0,
      attachments_downloaded: 0,
      attachments_external: 0,
      attachments_failed: 0,
    });
  }

  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        captured_at: "2026-03-03T00:00:00.000Z",
        manifest_hash: "hash-de-prueba",
        run_id: runId,
        sources: summaries,
        status: "completed",
        version: 1,
      },
      null,
      2,
    ),
  );
  return { root, runId };
}
