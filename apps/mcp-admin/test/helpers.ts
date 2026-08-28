/** Fixture: DB temporal migrada + seedeada (helpers de packages/db) + dos perfiles. */
import {
  getPersonByFullName,
  getProjectByName,
  openDb,
  runMigrations,
  seed,
  type AgentosDb,
  type Person,
  type Project,
} from "@agentos/db";
import { createAdminContext, type AdminContext } from "../src/context.js";
import { dispatchAdminTool, type AdminToolDefinition } from "../src/registry.js";
import { buildAdminToolCatalog } from "../src/server.js";

export interface AdminFixture {
  db: AgentosDb;
  catalog: Map<string, AdminToolDefinition>;
  rw: AdminContext;
  ro: AdminContext;
  person: Person;
  project: Project;
  /** Despacha con el perfil rw. */
  call(name: string, args?: unknown): Promise<unknown>;
  /** Despacha con el perfil ro. */
  callRo(name: string, args?: unknown): Promise<unknown>;
}

export function adminFixture(): AdminFixture {
  const db = openDb(":memory:");
  runMigrations(db);
  // env vacío: determinista (todo agente ai_sdk cae al fallback claude_code).
  seed(db, { env: {} });
  const person = getPersonByFullName(db, "Ernesto")!;
  const project = getProjectByName(db, "Assessment ACME")!;
  const catalog = buildAdminToolCatalog();
  const rw = createAdminContext({ db, profile: "rw", personId: person.id, migrate: false });
  const ro = createAdminContext({ db, profile: "ro", personId: person.id, migrate: false });
  return {
    db,
    catalog,
    rw,
    ro,
    person,
    project,
    call: (name, args) => dispatchAdminTool(catalog, rw, name, args ?? {}),
    callRo: (name, args) => dispatchAdminTool(catalog, ro, name, args ?? {}),
  };
}
