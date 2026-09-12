/**
 * Coste aproximado del asistente de IA de tareas, en USD.
 *
 * A diferencia de `computeCostUsd` (`@agentos/providers`), que usa las tarifas
 * del `provider_profile` guardado en la DB, aquí basta una tabla por PREFIJO de
 * id de modelo: el asistente de tareas se configura por variable de entorno
 * (`AGENTOS_ASSIST_MODEL`) y puede cambiar de modelo sin tocar `provider_profiles`.
 * Un modelo desconocido devuelve `null`: mejor sin coste que uno inventado.
 */
import type { TokenUsage } from "@agentos/providers";

/** USD por millón de tokens, [entrada, salida]. Orden: prefijo más específico primero. */
const TARIFAS_POR_PREFIJO: [prefijo: string, entrada: number, salida: number][] = [
  ["claude-sonnet-4-6", 3, 15],
  ["claude-sonnet-5", 2, 10],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4", 5, 25],
  ["claude-haiku-4-5", 1, 5],
  ["claude-fable", 10, 50],
  ["gpt-5", 1.25, 10],
];

function tarifaPara(modelId: string): { entrada: number; salida: number } | null {
  for (const [prefijo, entrada, salida] of TARIFAS_POR_PREFIJO) {
    if (modelId.startsWith(prefijo)) return { entrada, salida };
  }
  return null;
}

/**
 * Coste estimado en USD de una llamada, o `null` si el modelo no está en la
 * tabla o el proveedor no informó tokens. Redondeado a 6 decimales.
 */
export function estimarCosteUsd(modelId: string, usage: TokenUsage | null): number | null {
  if (!usage) return null;
  const { tokensIn, tokensOut } = usage;
  if (tokensIn === null || tokensOut === null) return null;
  const tarifa = tarifaPara(modelId);
  if (!tarifa) return null;
  const costo = (tokensIn / 1_000_000) * tarifa.entrada + (tokensOut / 1_000_000) * tarifa.salida;
  return Math.round(costo * 1_000_000) / 1_000_000;
}
