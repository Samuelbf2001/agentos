/**
 * Frontera con el modelo del asistente de tareas.
 *
 * Mismas reglas que la transcripción de notas (`notes/transcripcion.ts`):
 * - El modelo se crea con el registry de `@agentos/providers` sobre un perfil
 *   de `provider_profiles`. La DB guarda SÓLO el NOMBRE de la variable de
 *   entorno; la clave se lee de `process.env` al construir el modelo y jamás
 *   se persiste, se loguea ni viaja en un error (NFR-11).
 * - Todo fallo del proveedor sale normalizado como `provider_unavailable` por
 *   `asProviderUnavailable`, que nunca reenvía el mensaje del proveedor (un 401
 *   de OpenAI trae la clave dentro del texto).
 * - La interfaz es inyectable: los tests pasan un doble y NINGUNA llamada real
 *   sale de la suite.
 *
 * Aquí se usa `generateText` (no `generateObject`): la salida es un texto libre
 * —el campo mejorado o el prompt de ejecución— y forzar un esquema sólo añadiría
 * una forma más de fallar.
 *
 * Perfil y modelo se configuran por entorno, con la cadena:
 *   `AGENTOS_ASSIST_PROVIDER_SLUG` → `AGENTOS_NOTES_PROVIDER_SLUG` → `anthropic_api`
 *   `AGENTOS_ASSIST_MODEL`         → `AGENTOS_NOTES_MODEL`         → `claude-sonnet-5`
 */
import { generateText } from "ai";
import { errors } from "@agentos/shared";
import { getProviderProfileBySlug, type AgentosDb } from "@agentos/db";
import { ProviderRegistry } from "@agentos/providers";
import { asProviderUnavailable } from "../notes/transcripcion.js";

export const DEFAULT_ASSIST_PROVIDER_SLUG = "anthropic_api";
export const DEFAULT_ASSIST_MODEL = "claude-sonnet-5";

export function assistProviderSlug(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENTOS_ASSIST_PROVIDER_SLUG?.trim() ||
    env.AGENTOS_NOTES_PROVIDER_SLUG?.trim() ||
    DEFAULT_ASSIST_PROVIDER_SLUG
  );
}

export function assistModelId(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENTOS_ASSIST_MODEL?.trim() ||
    env.AGENTOS_NOTES_MODEL?.trim() ||
    DEFAULT_ASSIST_MODEL
  );
}

export interface TaskAssistImagePart {
  data: Buffer;
  mediaType: string;
}

export interface TaskAssistInput {
  system: string;
  prompt: string;
  /** Capturas locales de la descripción; se mandan como partes `file`. */
  images: TaskAssistImagePart[];
}

/** Frontera con el modelo. Los tests inyectan un doble. */
export interface TaskAssistant {
  complete(input: TaskAssistInput): Promise<{ text: string; model: string }>;
}

export interface ModelTaskAssistantOptions {
  db: AgentosDb;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
}

export function createModelTaskAssistant(options: ModelTaskAssistantOptions): TaskAssistant {
  const env = options.env ?? process.env;
  const registry = options.registry ?? new ProviderRegistry(env);

  return {
    async complete(input: TaskAssistInput): Promise<{ text: string; model: string }> {
      const slug = assistProviderSlug(env);
      const modelId = assistModelId(env);
      const profile = await getProviderProfileBySlug(options.db, slug);
      if (!profile) {
        throw errors.providerUnavailable(
          `No existe el perfil de proveedor '${slug}' para el asistente de tareas (AGENTOS_ASSIST_PROVIDER_SLUG).`,
          { slug, model: modelId },
        );
      }

      let model;
      try {
        model = registry.getModel(profile, modelId);
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv }, "redactar");
      }

      let result;
      try {
        result = await generateText({
          model,
          system: input.system,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                // Parte `file` con su mediaType: la parte `image` quedó
                // deprecada en el AI SDK (igual que en la transcripción).
                ...input.images.map((image) => ({
                  type: "file" as const,
                  data: image.data,
                  mediaType: image.mediaType,
                })),
              ],
            },
          ],
        });
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv }, "redactar");
      }

      const text = (result.text ?? "").trim();
      if (text.length === 0) {
        // Sin texto no hay respuesta: antes el error que un campo vacío.
        throw errors.providerUnavailable(
          `El modelo '${modelId}' no devolvió texto para la tarea.`,
          { slug, model: modelId },
        );
      }
      return { text, model: modelId };
    },
  };
}
