/**
 * Propuesta de tareas a partir de la TRANSCRIPCIÓN de una nota manuscrita
 * (fase 3 del módulo de Notas).
 *
 * Regla permanente: proponer NO crea nada. Este módulo sólo devuelve una lista
 * de candidatas que el humano revisa, edita y —sólo si pulsa "Crear"— pasan
 * por `commit-tasks`, que a su vez usa el mismo camino que `POST /api/tasks`.
 *
 * Reglas heredadas de la transcripción (fase 2):
 * - Se manda TEXTO (la transcripción ya revisada), no la imagen: más barato y
 *   sin releer una letra que el humano ya corrigió.
 * - Salida ESTRUCTURADA con `generateObject` y el esquema zod: nada de parsear
 *   texto libre. Si el modelo no devuelve un objeto válido, sale
 *   `provider_unavailable` y la nota no se toca.
 * - Los ids que devuelva el modelo se contrastan con el catálogo real: un id
 *   que no exista se descarta (queda el nombre en `*_guess` para que el humano
 *   elija). Sin responsables ni fechas inventados: null si el texto no los dice.
 * - Interfaz inyectable (`NoteProposer`), como `NoteTranscriber`: los tests
 *   pasan un doble y ninguna llamada real sale de la suite.
 */
import { generateObject } from "ai";
import { z } from "zod";
import {
  errors,
  NoteProposalConfidence,
  TaskPriority,
  type NoteTaskProposal,
} from "@agentos/shared";
import { getProviderProfileBySlug, type AgentosDb } from "@agentos/db";
import {
  ProviderRegistry,
  computeCostUsd,
  normalizeUsage,
  type TokenUsage,
} from "@agentos/providers";
import { asProviderUnavailable, notesModelId, notesProviderSlug } from "./transcripcion.js";

/** Entrada del catálogo de proyectos que ve el modelo (id, nombre, cliente). */
export interface ProyectoCatalogo {
  id: string;
  name: string;
  orgName: string | null;
}

/** Persona interna que puede ser responsable (id + nombre completo). */
export interface PersonaCatalogo {
  id: string;
  full_name: string;
}

export interface ProposeNoteInput {
  transcripcion: string;
  titulo: string;
  /** Proyecto de la nota, si lo tiene: las propuestas lo heredan por defecto. */
  proyectoNota: ProyectoCatalogo | null;
  proyectos: ProyectoCatalogo[];
  personas: PersonaCatalogo[];
  /** Fecha de hoy (ISO, sólo día) para resolver "el viernes" o "en dos semanas". */
  hoy: string;
}

/** Propuesta ya normalizada: la de la nota SIN los campos que pone la plataforma. */
export type ProposedTask = Omit<NoteTaskProposal, "id" | "include" | "created_task_id">;

export interface ProposeNoteResult {
  /**
   * Salida CRUDA del modelo (o del doble en tests). La ruta la pasa por
   * `normalizarPropuestas` contra los catálogos reales antes de guardarla.
   */
  propuestas: PropuestaModelo[];
  proveedor: string;
  modelo: string;
  usage: TokenUsage;
  costUsd: number | null;
}

/** Frontera con el modelo de lenguaje. Los tests inyectan un doble. */
export interface NoteProposer {
  propose(input: ProposeNoteInput): Promise<ProposeNoteResult>;
}

/** Esquema de SALIDA del modelo (zod → JSON Schema vía el AI SDK). */
export const SalidaPropuestas = z.object({
  tareas: z
    .array(
      z.object({
        title: z.string().min(1).max(300).describe("Título corto y accionable, en infinitivo"),
        description: z
          .string()
          .max(5_000)
          .nullable()
          .describe("Contexto útil sacado del texto; null si el título basta"),
        project_id: z
          .string()
          .nullable()
          .describe("Id EXACTO del catálogo sólo si la coincidencia es inequívoca; si no, null"),
        project_guess: z
          .string()
          .max(200)
          .nullable()
          .describe("Nombre del proyecto o cliente TAL CUAL lo escribió el autor; null si no lo menciona"),
        assignee_person_id: z
          .string()
          .nullable()
          .describe("Id EXACTO de la persona sólo si la coincidencia es inequívoca; si no, null"),
        assignee_guess: z
          .string()
          .max(200)
          .nullable()
          .describe("Nombre del responsable TAL CUAL aparece en el texto; null si no aparece"),
        due_at: z
          .string()
          .max(40)
          .nullable()
          .describe("Fecha límite ISO 8601 (YYYY-MM-DD) sólo si el texto la dice; si no, null"),
        priority: TaskPriority.describe("normal salvo que el texto marque urgencia o baja prioridad"),
        source_excerpt: z
          .string()
          .max(2_000)
          .describe("Fragmento LITERAL de la transcripción del que sale la tarea"),
        confidence: NoteProposalConfidence,
      }),
    )
    .max(50),
});
export type SalidaPropuestas = z.infer<typeof SalidaPropuestas>;
export type PropuestaModelo = SalidaPropuestas["tareas"][number];

const SYSTEM_PROMPT = [
  "Eres un asistente que convierte notas de reunión manuscritas (ya transcritas)",
  "en TAREAS PROPUESTAS para un tablero de trabajo. Un humano revisará cada una;",
  "tú no creas nada. Respondes en español y SOLO con el objeto pedido.",
  "",
  "Reglas, en orden de importancia:",
  "1. Una tarea por ACCIÓN CONCRETA del texto (verbo + objeto). Ideas, contexto",
  "   o decisiones sin acción no son tareas. No dividas una acción en varias ni",
  "   fusiones dos acciones distintas.",
  "2. NUNCA inventes responsables ni fechas. Si el texto no nombra a nadie,",
  "   `assignee_guess` y `assignee_person_id` van a null; si no da fecha, `due_at`",
  "   va a null. Una fecha relativa (\"el viernes\", \"en dos semanas\") se resuelve",
  "   con la fecha de hoy que se te da.",
  "3. `project_guess` y `assignee_guess` llevan el nombre TAL CUAL lo escribió el",
  "   autor (respeta abreviaturas y errores). `project_id` y `assignee_person_id`",
  "   sólo se rellenan con un id EXACTO del catálogo cuando la coincidencia es",
  "   inequívoca; ante la duda, null y deja el nombre en el guess.",
  "4. Si la nota pertenece a un proyecto, las tareas son de ese proyecto salvo",
  "   que el texto nombre claramente otro.",
  "5. `source_excerpt` es el fragmento LITERAL (copia exacta) del que sale la",
  "   tarea: sirve para que el humano localice el origen.",
  "6. `confidence`: alta si la acción, y a quién y cuándo, están explícitos;",
  "   media si hay que interpretar algo; baja si dudas de que sea una tarea.",
].join("\n");

/** Prompt de usuario: catálogos + la transcripción tal cual está guardada. */
export function construirPromptPropuestas(input: ProposeNoteInput): string {
  const lineas: string[] = [];
  lineas.push(`Hoy es ${input.hoy}. Nota: "${input.titulo}".`);
  lineas.push(
    input.proyectoNota
      ? `La nota pertenece al proyecto "${input.proyectoNota.name}" (id ${input.proyectoNota.id}${
          input.proyectoNota.orgName ? `, cliente ${input.proyectoNota.orgName}` : ""
        }).`
      : "La nota no está asociada a ningún proyecto.",
  );
  lineas.push("");
  lineas.push("Catálogo de proyectos (id — nombre — cliente):");
  if (input.proyectos.length === 0) lineas.push("- (vacío)");
  for (const p of input.proyectos) {
    lineas.push(`- ${p.id} — ${p.name}${p.orgName ? ` — ${p.orgName}` : ""}`);
  }
  lineas.push("");
  lineas.push("Personas internas que pueden ser responsables (id — nombre):");
  if (input.personas.length === 0) lineas.push("- (vacío)");
  for (const persona of input.personas) lineas.push(`- ${persona.id} — ${persona.full_name}`);
  lineas.push("");
  lineas.push("Transcripción de la nota (entre las líneas de guiones):");
  lineas.push("-----");
  lineas.push(input.transcripcion);
  lineas.push("-----");
  lineas.push("");
  lineas.push("Devuelve las tareas propuestas. Si no hay ninguna acción concreta, devuelve la lista vacía.");
  return lineas.join("\n");
}

/**
 * Deja la salida del modelo en la forma que guarda la nota: descarta ids que
 * no existan en los catálogos (queda el guess), recorta cadenas y aplica el
 * proyecto de la nota por defecto SÓLO cuando el texto no nombra otro.
 */
export function normalizarPropuestas(
  tareas: readonly PropuestaModelo[],
  input: Pick<ProposeNoteInput, "proyectos" | "personas" | "proyectoNota">,
): ProposedTask[] {
  const proyectos = new Set(input.proyectos.map((p) => p.id));
  const personas = new Set(input.personas.map((p) => p.id));
  const limpiar = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };
  return tareas
    .map((t): ProposedTask | null => {
      const title = limpiar(t.title);
      if (!title) return null;
      const projectGuess = limpiar(t.project_guess);
      const projectId =
        t.project_id && proyectos.has(t.project_id)
          ? t.project_id
          : // Sin mención a otro proyecto, hereda el de la nota; con un nombre
            // que no casó, se deja vacío para que el humano lo elija a mano.
            !projectGuess && input.proyectoNota
            ? input.proyectoNota.id
            : null;
      const assigneeId = t.assignee_person_id && personas.has(t.assignee_person_id) ? t.assignee_person_id : null;
      const dueAt = limpiar(t.due_at);
      const description = limpiar(t.description);
      return {
        title,
        ...(description ? { description } : {}),
        project_id: projectId,
        project_guess: projectGuess,
        assignee_person_id: assigneeId,
        assignee_guess: limpiar(t.assignee_guess),
        due_at: dueAt && Number.isFinite(Date.parse(dueAt)) ? dueAt : null,
        priority: t.priority,
        source_excerpt: t.source_excerpt.trim(),
        confidence: t.confidence,
      };
    })
    .filter((t): t is ProposedTask => t !== null);
}

export interface ModelProposerOptions {
  db: AgentosDb;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
}

/**
 * Proponedor real: mismo perfil y modelo que la transcripción
 * (`AGENTOS_NOTES_PROVIDER_SLUG` / `AGENTOS_NOTES_MODEL`) y salida estructurada.
 * Todo fallo del proveedor sale como `provider_unavailable`; el mensaje nombra,
 * como mucho, la VARIABLE de entorno que falta.
 */
export function createModelProposer(options: ModelProposerOptions): NoteProposer {
  const registry = options.registry ?? new ProviderRegistry(options.env ?? process.env);
  const env = options.env ?? process.env;

  return {
    async propose(input: ProposeNoteInput): Promise<ProposeNoteResult> {
      const slug = notesProviderSlug(env);
      const modelId = notesModelId(env);
      const profile = await getProviderProfileBySlug(options.db, slug);
      if (!profile) {
        throw errors.providerUnavailable(
          `No existe el perfil de proveedor '${slug}' para proponer tareas (AGENTOS_NOTES_PROVIDER_SLUG).`,
          { slug, model: modelId },
        );
      }

      let model;
      try {
        model = registry.getModel(profile, modelId);
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv }, "proponer tareas");
      }

      let result;
      try {
        result = await generateObject({
          model,
          schema: SalidaPropuestas,
          system: SYSTEM_PROMPT,
          prompt: construirPromptPropuestas(input),
        });
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv }, "proponer tareas");
      }

      const usage = normalizeUsage(result.usage);
      return {
        propuestas: result.object.tareas,
        proveedor: profile.slug,
        modelo: modelId,
        usage,
        costUsd: computeCostUsd(usage, profile),
      };
    },
  };
}
