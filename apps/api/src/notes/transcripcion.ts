/**
 * Transcripción de una nota manuscrita con un modelo de visión (fase 2 del
 * módulo de Notas).
 *
 * Reglas heredadas del repo:
 * - El modelo se crea con el registry de `@agentos/providers` sobre el perfil
 *   de `provider_profiles`: la DB guarda SÓLO el NOMBRE de la variable de
 *   entorno; la clave se lee de `process.env` al construir el modelo y jamás
 *   se persiste, se loguea ni viaja en un mensaje de error (NFR-11).
 * - Si el proveedor no está configurado, falla o devuelve vacío, se lanza
 *   `provider_unavailable`. NUNCA se inventa una transcripción: un texto falso
 *   es peor que un error visible.
 * - El transcriptor es una interfaz inyectable, igual que los runners: los
 *   tests pasan un doble y ninguna llamada real sale de la suite.
 * - Salida ESTRUCTURADA (`generateObject` + `SalidaTranscripcion`): el
 *   Markdown completo, el texto plano por región (para pintarlo en el lienzo
 *   junto a cada trazo) y las dudas. Nada de parsear texto libre.
 *
 * Modelo y perfil son configurables por entorno para poder cambiarlos sin
 * tocar código (`AGENTOS_NOTES_PROVIDER_SLUG`, `AGENTOS_NOTES_MODEL`).
 */
import { generateObject } from "ai";
import { z } from "zod";
import { errors, isAgentosError, ErrorCodes } from "@agentos/shared";
import { getProviderProfileBySlug, type AgentosDb } from "@agentos/db";
import {
  ProviderRegistry,
  classifyProviderError,
  computeCostUsd,
  normalizeUsage,
  type TokenUsage,
} from "@agentos/providers";
import type { SegmentacionNota } from "./segmentacion.js";

export const DEFAULT_NOTES_PROVIDER_SLUG = "openai";
export const DEFAULT_NOTES_MODEL = "gpt-5.6-luna";

export function notesProviderSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTOS_NOTES_PROVIDER_SLUG?.trim() || DEFAULT_NOTES_PROVIDER_SLUG;
}

export function notesModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTOS_NOTES_MODEL?.trim() || DEFAULT_NOTES_MODEL;
}

export interface TranscribeNoteInput {
  /** PNG ya exportado por el lienzo (bytes leídos del disco). */
  imagen: Buffer;
  /** Orden de lectura + lo que ya es dato (texto tecleado, figuras). */
  segmentacion: SegmentacionNota;
  titulo: string;
}

/** Texto plano de una región (bloque de la segmentación) tal como lo leyó el modelo. */
export interface BloqueTranscrito {
  /** Índice del bloque en `segmentacion.bloques` (0..N-1, de arriba abajo). */
  bloque: number;
  texto: string;
}

export interface TranscribeNoteResult {
  /** La transcripción completa en Markdown: es lo que se guarda en `transcription`. */
  markdown: string;
  /** Texto plano por región, para pintarlo en el lienzo junto a cada trazo. */
  bloques: BloqueTranscrito[];
  /**
   * Lecturas inciertas (las que el modelo marcó con `[?]`). Es la única huella
   * de la duda que llega al cliente: los marcadores se quitan del texto en la
   * ruta (`limpiarMarcadores`).
   */
  dudas: string[];
  proveedor: string;
  modelo: string;
  usage: TokenUsage;
  costUsd: number | null;
}

/**
 * Salida ESTRUCTURADA del modelo. `generateObject` la valida contra este
 * esquema; si el modelo no la cumple, sale `provider_unavailable` (nada de
 * parsear texto libre buscando "Dudas:").
 */
export const SalidaTranscripcion = z.object({
  markdown: z.string(),
  bloques: z.array(z.object({ bloque: z.number().int(), texto: z.string() })),
  dudas: z.array(z.string()),
});

/** Frontera con el modelo de visión. Los tests inyectan un doble. */
export interface NoteTranscriber {
  transcribe(input: TranscribeNoteInput): Promise<TranscribeNoteResult>;
}

export const SYSTEM_PROMPT = [
  "Eres un transcriptor de notas manuscritas. Tu única tarea es leer la imagen",
  "y devolver lo que está escrito, en español, tal cual.",
  "",
  "Reglas, en orden de importancia:",
  "1. NUNCA inventes lo que no puedas leer. Marca cada duda con `[?]` y pon tu",
  "   mejor lectura entre corchetes: `presupuesto [?: presupuesto/presupuestó]`.",
  "   Una transcripción fluida y falsa es mucho peor que una con huecos señalados.",
  "2. No corrijas ni edites al autor: respeta sus palabras, abreviaturas y orden.",
  "   Si quieres sugerir una versión pulida, va aparte y después.",
  "3. Respeta la estructura en Markdown: viñetas, numeración, sangrías, recuadros",
  "   (un recuadro suele ser un título o algo destacado) y flechas, que se escriben `→`.",
  "4. Escribe bien las tildes y la ortografía del español: la letra a mano se come",
  "   los acentos, pero transcribes la palabra, no el trazo.",
  "5. Devuelve SOLO la transcripción, sin preámbulo, sin encabezados que no estén",
  "   escritos en la nota y sin comentarios sobre la imagen.",
  "6. Respondes con un objeto: `markdown` (la transcripción completa), `bloques`",
  "   (el texto plano de cada región, en orden) y `dudas` (las palabras marcadas `[?]`).",
  "",
  "Flujogramas y organigramas:",
  "- Distingue una LISTA de un DIAGRAMA. Es diagrama cuando hay nodos (formas con",
  "  texto dentro) unidos por líneas. Si no hay líneas, es una lista: transcríbela como tal.",
  "- Identifica cada nodo por su forma: óvalo = inicio/fin de un flujo o rol raíz;",
  "  rectángulo = paso o rol; rombo = decisión, con sus salidas sí/no.",
  "- Lee las conexiones por las LÍNEAS dibujadas. Una línea que sale de un nodo hacia",
  "  abajo y se abre en horizontal hacia varios nodos es JERARQUÍA: los de abajo",
  "  dependen del de arriba (organigrama). Una flecha es FLUJO con dirección (flujograma).",
  "- NUNCA inventes nodos ni conexiones que no estén dibujados. No añadas un nodo raíz",
  "  vacío, no unas dos ramas que no se tocan ni completes un nivel que no existe.",
  "  Un nodo sin ninguna línea se lista aparte como «suelto», sin conectarlo a nada.",
  "- Las etiquetas de los nodos se transcriben tal cual: si pone «CcO» escribes «CcO»;",
  "  si crees que quiso decir «CEO», ponlo en `dudas`, no lo cambies.",
  "- En `markdown`, el diagrama va como un bloque ```mermaid con `flowchart TD`, con",
  "  exactamente los nodos y aristas que se ven (`A --> B`; jerarquía = arista del",
  "  padre a cada hijo), y DEBAJO una lista anidada legible: el padre como viñeta y",
  "  sus hijos sangrados bajo él, con `→` para el flujo.",
  "- En `bloques[].texto` (texto plano para el lienzo) va SOLO esa lista anidada",
  "  con `→` e indentación. Nunca el mermaid.",
].join("\n");

/**
 * Quita de un texto los marcadores de duda que pide el SYSTEM_PROMPT, sin
 * tocar la lectura elegida. El prompt SIGUE pidiéndolos (es lo que evita que
 * el modelo invente): esto es presentación, y la lista de `dudas` viaja aparte.
 *
 * - `palabra [?: palabra/palabrá]` → `palabra` (la palabra de antes es la
 *   lectura elegida; el marcador sobra).
 * - `[?: A/B]` sin palabra antes (inicio de línea, tras una viñeta o una
 *   flecha) → `A`, la primera alternativa.
 * - `[?]` suelto → nada.
 * - Los dobles espacios que deja el recorte se normalizan; la sangría de
 *   línea (listas anidadas, código) se respeta.
 */
export function limpiarMarcadores(texto: string): string {
  const conAlternativas = texto.replace(
    /[ \t]*\[\?:\s*([^\]]*)\][ \t]*/g,
    (coincidencia: string, alternativas: string, offset: number, todo: string) => {
      const antes = ultimoCaracterDeLinea(todo, offset);
      const inicioDeLinea = antes === null;
      const sigueTexto = siguePalabra(todo, offset + coincidencia.length);
      const hayPalabraAntes = antes !== null && /[\p{L}\p{N}.,;!?)»"'”’]/u.test(antes);
      if (hayPalabraAntes) return sigueTexto ? " " : "";
      const primera = alternativas.split("/")[0]?.trim() ?? "";
      return `${inicioDeLinea ? "" : " "}${primera}${sigueTexto ? " " : ""}`;
    },
  );
  const sinSueltos = conAlternativas.replace(
    /[ \t]*\[\?\][ \t]*/g,
    (coincidencia: string, offset: number, todo: string) => {
      const inicioDeLinea = ultimoCaracterDeLinea(todo, offset) === null;
      return inicioDeLinea || !siguePalabra(todo, offset + coincidencia.length) ? "" : " ";
    },
  );
  return sinSueltos.replace(/(\S)[ \t]{2,}(\S)/g, "$1 $2");
}

/**
 * ¿Tras `offset` viene algo que pide un espacio de separación? Fin de texto,
 * salto de línea o puntuación de cierre (`, . ; : ! ? )`) no lo piden.
 */
function siguePalabra(texto: string, offset: number): boolean {
  const c = texto.charAt(offset);
  return c !== "" && !/[\n\r,.;:!?)»”’]/.test(c);
}

/** Último carácter no blanco de la línea antes de `offset`, o null si no hay ninguno. */
function ultimoCaracterDeLinea(texto: string, offset: number): string | null {
  for (let i = offset - 1; i >= 0; i--) {
    const c = texto.charAt(i);
    if (c === "\n") return null;
    if (c !== " " && c !== "\t") return c;
  }
  return null;
}

/** Describe el orden de lectura en texto plano: bloques → renglones. */
export function describirSegmentacion(seg: SegmentacionNota): string {
  const lineas: string[] = [];
  const r = seg.resumen;
  // Solo un aviso de regiones: sin cajas ni renglones. El detalle geométrico
  // empujaba al modelo a transcribir por filas de trazos y rompía los diagramas.
  if (r.bloques > 1) {
    lineas.push(
      `Pista: los trazos forman ${r.bloques} regiones separadas verticalmente; alguna puede ser una columna o nota al margen.`,
    );
  }
  if (seg.textoExistente.length > 0) {
    lineas.push("");
    lineas.push("Texto YA TECLEADO en el lienzo (es dato, NO lo transcribas ni lo repitas):");
    for (const t of seg.textoExistente) {
      lineas.push(`- "${t.texto.replace(/\n/g, " ")}" (x${t.caja.x} y${t.caja.y})`);
    }
  }
  if (seg.figuras.length > 0) {
    lineas.push("");
    lineas.push("Figuras ya dibujadas (dato, úsalas para entender la estructura):");
    for (const f of seg.figuras) {
      const enlace = f.desde || f.hacia ? ` [${f.desde ?? "?"} → ${f.hacia ?? "?"}]` : "";
      lineas.push(`- ${f.tipo} (x${f.caja.x} y${f.caja.y}, ${f.caja.w}×${f.caja.h})${enlace}`);
    }
  }
  return lineas.join("\n");
}

/** Prompt de usuario: el título de la nota y la estructura como orden de lectura. */
export function construirPrompt(input: Pick<TranscribeNoteInput, "segmentacion" | "titulo">): string {
  // Medido con letra real (nota 01a088fb, 2026-09-10): imponer el orden
  // geométrico ("bloque por bloque, renglón por renglón") con las cajas de cada
  // renglón bajó la lectura de ~11/14 a ~4/14 con el mismo modelo y la misma
  // imagen. La segmentación por cajas de trazos parte un diagrama en renglones
  // falsos y el modelo obedece. La IMAGEN manda; la geometría solo avisa de
  // regiones separadas y aporta lo que ya es dato (texto tecleado, figuras).
  return [
    `Nota: "${input.titulo}".`,
    "",
    "La imagen adjunta es la exportación limpia del lienzo y es la fuente: léela",
    "como una página. Si hay un diagrama (óvalos, cajas, rombos unidos por líneas o",
    "flechas), aplica la guía de flujogramas y organigramas: bloque ```mermaid",
    "(`flowchart TD`) más la lista anidada en `markdown`, solo la lista anidada en",
    "`bloques`, y ni un nodo ni una conexión que no esté dibujada. Si hay una lista con",
    "números en círculos, reprodúcela numerada. Si una región está claramente",
    "aparte (una columna, una nota al margen), trátala como sección propia.",
    "",
    describirSegmentacion(input.segmentacion),
    "",
    describirBloques(input.segmentacion.resumen.bloques),
    "",
    "Devuelve `markdown` con la transcripción completa en Markdown, `bloques` con",
    "el texto plano de cada región en orden y `dudas` con las palabras marcadas `[?]`.",
    "Nada más.",
  ].join("\n");
}

/**
 * Pide el texto por región para poder ponerlo en el lienzo junto a cada
 * trazo. Sólo el NÚMERO de regiones y su orden: sin cajas ni renglones (ver
 * la nota de medición de arriba).
 */
export function describirBloques(n: number): string {
  const total = Math.max(1, n);
  return [
    `La nota tiene ${total} ${total === 1 ? "región" : "regiones separadas verticalmente"}`,
    `(bloque 0${total > 1 ? `..${total - 1}` : ""}, de arriba abajo). Devuelve en \`bloques\` el texto`,
    "plano de cada región, en ese orden. Si dos regiones son en realidad una sola,",
    "une su texto en la primera y deja la otra con texto vacío.",
  ].join("\n");
}

export interface ModelTranscriberOptions {
  db: AgentosDb;
  registry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
}

/**
 * Transcriptor real: perfil de `provider_profiles` + registry del AI SDK.
 * Todo fallo del proveedor sale como `provider_unavailable` con un mensaje que
 * menciona, como mucho, el NOMBRE de la variable de entorno que falta.
 */
export function createModelTranscriber(options: ModelTranscriberOptions): NoteTranscriber {
  const registry = options.registry ?? new ProviderRegistry(options.env ?? process.env);
  const env = options.env ?? process.env;

  return {
    async transcribe(input: TranscribeNoteInput): Promise<TranscribeNoteResult> {
      const slug = notesProviderSlug(env);
      const modelId = notesModelId(env);
      const profile = await getProviderProfileBySlug(options.db, slug);
      if (!profile) {
        throw errors.providerUnavailable(
          `No existe el perfil de proveedor '${slug}' para transcribir notas (AGENTOS_NOTES_PROVIDER_SLUG).`,
          { slug, model: modelId },
        );
      }

      let model;
      try {
        model = registry.getModel(profile, modelId);
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv });
      }

      let result;
      try {
        result = await generateObject({
          model,
          schema: SalidaTranscripcion,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: construirPrompt(input) },
                // Parte `file` con mediaType image/png: la parte `image` quedó
                // deprecada en el AI SDK y avisa por consola en cada llamada.
                { type: "file", data: input.imagen, mediaType: "image/png" },
              ],
            },
          ],
        });
      } catch (err) {
        throw asProviderUnavailable(err, { slug, modelId, apiKeyEnv: profile.apiKeyEnv });
      }

      const markdown = (result.object.markdown ?? "").trim();
      if (markdown.length === 0) {
        // Sin texto no hay transcripción: antes el error que un hueco inventado.
        throw errors.providerUnavailable(
          `El modelo '${modelId}' no devolvió texto para la nota; no se inventa una transcripción.`,
          { slug, model: modelId },
        );
      }

      const usage = normalizeUsage(result.usage);
      return {
        markdown,
        bloques: result.object.bloques.map((b) => ({ bloque: b.bloque, texto: b.texto.trim() })),
        dudas: result.object.dudas.map((d) => d.trim()).filter((d) => d.length > 0),
        proveedor: profile.slug,
        modelo: modelId,
        usage,
        costUsd: computeCostUsd(usage, profile),
      };
    },
  };
}

/**
 * Convierte cualquier fallo del proveedor en `provider_unavailable`.
 *
 * El mensaje del proveedor NO se reenvía: un 401 de OpenAI llega con la clave
 * (aunque sea parcialmente enmascarada) dentro del texto, y ese texto acabaría
 * en la respuesta HTTP y en los logs. Se clasifica el error y se responde con
 * una causa estable; como mucho se nombra la VARIABLE de entorno. La comparte
 * el proponedor de tareas (fase 3): misma frontera, misma clasificación.
 */
export function asProviderUnavailable(
  err: unknown,
  ctx: { slug: string; modelId: string; apiKeyEnv: string | null },
  accion = "transcribir",
): Error {
  if (isAgentosError(err, ErrorCodes.PROVIDER_UNAVAILABLE)) return err;
  // Errores nuestros de configuración: el mensaje ya es seguro (nombre de la variable).
  if (isAgentosError(err, ErrorCodes.PROVIDER_NOT_CONFIGURED)) {
    return errors.providerUnavailable(err.message, {
      slug: ctx.slug,
      model: ctx.modelId,
      causa: "not_configured",
    });
  }
  const kind = classifyProviderError(err);
  const causas: Record<string, string> = {
    auth: `el proveedor rechazó las credenciales${ctx.apiKeyEnv ? ` (revisa ${ctx.apiKeyEnv})` : ""}`,
    rate_limit: "el proveedor devolvió límite de tasa",
    transient: "el proveedor no respondió (red o error temporal)",
    permanent: "el proveedor rechazó la petición",
  };
  return errors.providerUnavailable(
    `No se pudo ${accion} con '${ctx.slug}' (${ctx.modelId}): ${causas[kind]}.`,
    { slug: ctx.slug, model: ctx.modelId, causa: kind },
  );
}
