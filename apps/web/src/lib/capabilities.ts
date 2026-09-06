/**
 * Capacidades del shell (PLAN-v1.5 §Shell por capacidades). Hoy existe un solo
 * rol (persona interna de Sixteam), así que todo el mundo puede todo. Cuando
 * la sesión traiga rol y tenant, este archivo es el único sitio que cambia:
 * el resto de la app solo consulta `useCapabilities()` / `caps.has(...)`.
 */
import { useMemo } from "react";
import { PROJECT_TABS, SYSTEM_TABS, type ProjectTab, type SystemTab } from "./paths";
import type { Person } from "./types";
import { useStore } from "../state/store";

export type GlobalEntry = "hoy" | "tareas" | "proyectos" | "sistema" | "activo" | "2brain";

export type Capability =
  | `nav:${GlobalEntry}`
  | `proyecto:${ProjectTab}`
  | `sistema:${SystemTab}`
  | "buscar"
  | "agentes:pausar";

const GLOBAL_ENTRIES: GlobalEntry[] = ["hoy", "tareas", "proyectos", "sistema", "activo", "2brain"];

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  ...GLOBAL_ENTRIES.map((entry): Capability => `nav:${entry}`),
  ...PROJECT_TABS.map((tab): Capability => `proyecto:${tab}`),
  ...SYSTEM_TABS.map((tab): Capability => `sistema:${tab}`),
  "buscar",
  "agentes:pausar",
]);

/**
 * "Ver como cliente": previsualización local para diseñar y enseñar, no un
 * permiso real — hoy no existe rol de cliente en la sesión.
 */
export type PreviewRole = "sponsor" | null;

const SPONSOR_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "nav:hoy",
  "proyecto:ruta",
  "proyecto:contexto",
]);

/**
 * Hoy existe un solo rol (persona interna de Sixteam): todo el mundo tiene
 * todas las capacidades. Cuando la sesión traiga rol y tenant, esta función
 * es el único sitio que cambia. `previewRole` es aparte: reduce el set sin
 * tocar la sesión real, para previsualizar lo que vería el cliente.
 */
export function capabilitiesFor(
  _person: Person | null,
  previewRole: PreviewRole = null,
): ReadonlySet<Capability> {
  if (previewRole === "sponsor") return SPONSOR_CAPABILITIES;
  return ALL_CAPABILITIES;
}

export function useCapabilities(): ReadonlySet<Capability> {
  const person = useStore((s) => s.person);
  const previewRole = useStore((s) => s.previewRole);
  return useMemo(() => capabilitiesFor(person, previewRole), [person, previewRole]);
}
