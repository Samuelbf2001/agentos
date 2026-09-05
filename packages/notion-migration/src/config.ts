import path from "node:path";

export interface SnapshotSettings {
  apiVersion: string;
  outputDirectory: string;
  projectsDatabaseId: string;
  tasksDatabaseId: string;
  token: string;
}

export class SnapshotConfigError extends Error {
  override name = "SnapshotConfigError";
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Parser intentionally small: it is used only to load a local secret file at runtime.
 * Values are never printed, persisted outside the process, or copied to AgentOS config.
 */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    const rawValue = match[2] ?? "";
    const quoted = rawValue.match(/^(["'])(.*)\1$/u);
    values[key] = quoted ? (quoted[2] ?? "") : rawValue.trim();
  }
  return values;
}

export function resolveSnapshotSettings(
  values: Record<string, string | undefined>,
  options: {
    allowOperationalToken?: boolean;
    outputDirectory?: string;
  } = {},
): SnapshotSettings {
  const token = nonEmpty(values.NOTION_SNAPSHOT_TOKEN)
    ?? (options.allowOperationalToken ? nonEmpty(values.NOTION_TOKEN) : undefined);
  const tasksDatabaseId = nonEmpty(values.NOTION_SNAPSHOT_TASKS_DATABASE_ID)
    ?? nonEmpty(values.NOTION_TASKS_DB_ID);
  const projectsDatabaseId = nonEmpty(values.NOTION_SNAPSHOT_PROJECTS_DATABASE_ID)
    ?? nonEmpty(values.NOTION_PROJECTS_DB_ID);
  const missing = [
    !token ? "NOTION_SNAPSHOT_TOKEN" : null,
    !tasksDatabaseId ? "NOTION_SNAPSHOT_TASKS_DATABASE_ID" : null,
    !projectsDatabaseId ? "NOTION_SNAPSHOT_PROJECTS_DATABASE_ID" : null,
  ].filter((value): value is string => value !== null);

  if (missing.length > 0 || !token || !tasksDatabaseId || !projectsDatabaseId) {
    throw new SnapshotConfigError(`Faltan secretos o identificadores: ${missing.join(", ")}`);
  }

  return {
    token,
    tasksDatabaseId,
    projectsDatabaseId,
    apiVersion: nonEmpty(values.NOTION_SNAPSHOT_API_VERSION) ?? "2022-06-28",
    outputDirectory: path.resolve(options.outputDirectory ?? "data/notion-snapshots"),
  };
}
