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

export type GlobalEntry = "hoy" | "tareas" | "proyectos" | "sistema" | "activo";

export type Capability =
  | `nav:${GlobalEntry}`
  | `proyecto:${ProjectTab}`
  | `sistema:${SystemTab}`
  | "buscar"
  | "agentes:pausar";

const GLOBAL_ENTRIES: GlobalEntry[] = ["hoy", "tareas", "proyectos", "sistema", "activo"];

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  ...GLOBAL_ENTRIES.map((entry): Capability => `nav:${entry}`),
  ...PROJECT_TABS.map((tab): Capability => `proyecto:${tab}`),
  ...SYSTEM_TABS.map((tab): Capability => `sistema:${tab}`),
  "buscar",
  "agentes:pausar",
]);

/**
 * Hoy existe un solo rol (persona interna de Sixteam): todo el mundo tiene
 * todas las capacidades. Cuando la sesión traiga rol y tenant, esta función
 * es el único sitio que cambia.
 */
export function capabilitiesFor(_person: Person | null): ReadonlySet<Capability> {
  return ALL_CAPABILITIES;
}

export function useCapabilities(): ReadonlySet<Capability> {
  const person = useStore((s) => s.person);
  return useMemo(() => capabilitiesFor(person), [person]);
}
