/** Fixture: DB temporal migrada + seedeada (helpers de packages/db) + dos perfiles. */
import {
  getPersonByFullName,
  getProjectByName,
  openDb,
  runMigrations,
  seed,
  type AgentosSqliteDb,
  type Person,
  type Project,
} from "@agentos/db";
import { createAdminContext, type AdminContext } from "../src/context.js";
import { dispatchAdminTool, type AdminToolDefinition } from "../src/registry.js";
import { buildAdminToolCatalog } from "../src/server.js";

export interface AdminFixture {
  db: AgentosSqliteDb;
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

export async function adminFixture(): Promise<AdminFixture> {
  const db = openDb(":memory:");
  runMigrations(db);
  // env vacío: determinista (todo agente ai_sdk cae al fallback claude_code).
  await seed(db, { env: {} });
  const person = (await getPersonByFullName(db, "Ernesto"))!;
  const project = (await getProjectByName(db, "Assessment ACME"))!;
  const catalog = buildAdminToolCatalog();
  const rw = await createAdminContext({ db, profile: "rw", personId: person.id, migrate: false });
  const ro = await createAdminContext({ db, profile: "ro", personId: person.id, migrate: false });
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
