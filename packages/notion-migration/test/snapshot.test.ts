import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject, NotionReader, PaginatedJson } from "../src/notion-client.js";
import { createNotionSnapshot } from "../src/snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeNotionReader implements NotionReader {
  getDatabase(databaseId: string): Promise<JsonObject> {
    return Promise.resolve({ id: databaseId, properties: { Project: { id: "proj", type: "relation" } } });
  }
  async *queryDatabase(): AsyncIterable<JsonObject> {
    yield { id: "11111111-1111-1111-1111-111111111111" };
  }
  getPage(pageId: string): Promise<JsonObject> {
    return Promise.resolve({ id: pageId, properties: { Project: { type: "relation", relation: [{ id: "a" }], has_more: false } } });
  }
  getPageProperty(): Promise<PaginatedJson> {
    return Promise.resolve({ items: [], pages: [] });
  }
  getBlockChildren(blockId: string): Promise<PaginatedJson> {
    return Promise.resolve({ items: [], pages: [{ object: "list", results: [], block_id: blockId }] });
  }
  getComments(): Promise<PaginatedJson> {
    return Promise.resolve({ items: [], pages: [{ object: "list", results: [] }] });
  }
}

describe("createNotionSnapshot", () => {
  it("keeps raw page, blocks, comments, schema and a manifest without importing data", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "agentos-notion-snapshot-"));
    temporaryDirectories.push(outputDirectory);
    const result = await createNotionSnapshot({
      outputDirectory,
      reader: new FakeNotionReader(),
      runId: "notion-test-run",
      sources: [{ key: "tasks", databaseId: "tasks-db" }],
    });
    expect(result.manifest.status).toBe("completed");
    expect(result.manifest.sources[0]?.pages_captured).toBe(1);
    const page = await readFile(path.join(result.runDirectory, "tasks", "pages", "11111111-1111-1111-1111-111111111111.page.json"), "utf8");
    expect(JSON.parse(page)).toMatchObject({ id: "11111111-1111-1111-1111-111111111111" });
  });
});
