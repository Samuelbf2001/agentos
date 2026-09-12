/**
 * 2brain › Grafo: contactos, empresas, equipo, reuniones, notas, notas de voz,
 * páginas y temas conectados. Proxea el "Grafo de conocimiento" que YA calcula
 * WhatsAppHub (`graphStore.buildGraph`, 8 tipos de nodo, relaciones directas y
 * derivadas): esta ruta solo valida la entrada, valida y recorta la forma de
 * salida a lo que la vista pinta, y traduce errores del hub.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentosError, ErrorCodes } from "@agentos/shared";
import type { ApiContext } from "../../context.js";
import { parse } from "../../http-errors.js";
import { asDomainError, requireHub } from "./shared.js";

/** Mismos 8 tipos que `graphStore.GRAPH_NODE_TYPES` en WhatsAppHub. */
const GRAPH_NODE_TYPES = [
  "contacto",
  "empresa",
  "equipo",
  "reunion",
  "nota",
  "nota_voz",
  "pagina",
  "tema",
] as const;

/**
 * Metadatos por tipo de nodo: exactamente los campos que `metaLines()` de la
 * vista original enseña en el panel lateral. Cualquier otra clave que venga
 * del hub (p. ej. ids internos, tags de auditoría) se descarta al parsear
 * (whitelist por construcción: `z.object` sin `.passthrough()`).
 */
const GraphNodeMetaSchema = z
  .object({
    // contacto
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    leadStatus: z.string().nullable().optional(),
    msgInCount: z.number().nullable().optional(),
    lastMessageAt: z.string().nullable().optional(),
    // empresa
    domain: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    // equipo (comparte email con contacto)
    role: z.string().nullable().optional(),
    // reunion
    source: z.string().nullable().optional(),
    meetingDate: z.string().nullable().optional(),
    isInternal: z.boolean().nullable().optional(),
    participantsCount: z.number().nullable().optional(),
    // nota (comparte tags/createdAt con pagina/nota_voz)
    kind: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    createdAt: z.string().nullable().optional(),
    // nota_voz
    category: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    // pagina
    pageType: z.string().nullable().optional(),
  })
  .default({});

const GraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(GRAPH_NODE_TYPES),
  label: z.string(),
  /** Id "crudo" (número o slug/tag) para construir enlaces a la sección real. */
  refId: z.union([z.string(), z.number()]).optional(),
  meta: GraphNodeMetaSchema,
});

/**
 * Aristas: solo lo que el lienzo dibuja (extremos, tipo para la key/leyenda y
 * peso para la opacidad de la línea). El hub también manda `derived`, pero la
 * vista lo usa únicamente para un detalle visual (línea punteada) que esta
 * whitelist deja fuera a propósito: ver informe final.
 */
const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string().optional(),
  weight: z.number().optional(),
});

const GraphStatsSchema = z
  .object({
    nodeCount: z.number().int().nonnegative().default(0),
    edgeCount: z.number().int().nonnegative().default(0),
    byType: z.record(z.string(), z.number()).default({}),
    truncated: z.boolean().default(false),
  })
  .default({ nodeCount: 0, edgeCount: 0, byType: {}, truncated: false });

const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema).default([]),
  edges: z.array(GraphEdgeSchema).default([]),
  stats: GraphStatsSchema,
});

function isIsoDateLike(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const GrafoQuerySchema = z.object({
  limitPerType: z.coerce.number().int().min(1).max(300).optional(),
  since: z.string().refine(isIsoDateLike, "since debe ser una fecha válida").optional(),
  includeIsolated: z.enum(["true", "false"]).optional(),
  focus: z.string().regex(/^[a-z_]+:.+$/, "focus debe tener forma tipo:id").optional(),
  depth: z.coerce.number().int().min(1).max(2).optional(),
});

export function registerBrainGrafoRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // GET /api/brain/grafo?limitPerType=&since=&includeIsolated=&focus=&depth=
  app.get("/api/brain/grafo", async (req) => {
    const query = parse(GrafoQuerySchema, req.query);
    const hub = requireHub(ctx);

    let raw: unknown;
    try {
      raw = await hub.hubGetJson(
        "/api/wiki/graph",
        {
          limitPerType: query.limitPerType,
          since: query.since,
          includeIsolated: query.includeIsolated === "true",
          focus: query.focus,
          // El hub ignora depth sin focus; no tiene sentido mandarlo suelto.
          depth: query.focus ? query.depth ?? 1 : undefined,
        },
        { timeoutMs: 20_000 },
      );
    } catch (err) {
      throw asDomainError(err);
    }

    const parsed = GraphResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentosError(ErrorCodes.PROVIDER_ERROR, "WhatsAppHub devolvió un grafo con forma inesperada", {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  });
}
