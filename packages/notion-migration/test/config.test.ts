import { describe, expect, it } from "vitest";
import { parseEnvText, resolveSnapshotSettings, SnapshotConfigError } from "../src/config.js";

describe("snapshot config", () => {
  it("loads only the snapshot token by default", () => {
    const values = parseEnvText("NOTION_SNAPSHOT_TOKEN='safe-token'\nNOTION_TASKS_DB_ID=tasks\nNOTION_PROJECTS_DB_ID=projects\n");
    expect(resolveSnapshotSettings(values, { outputDirectory: "data/test-snapshots" })).toMatchObject({
      tasksDatabaseId: "tasks",
      projectsDatabaseId: "projects",
      token: "safe-token",
    });
  });

  it("does not silently reuse an operational token", () => {
    expect(() => resolveSnapshotSettings({ NOTION_TOKEN: "write-capable", NOTION_TASKS_DB_ID: "tasks", NOTION_PROJECTS_DB_ID: "projects" }))
      .toThrow(SnapshotConfigError);
  });
});
