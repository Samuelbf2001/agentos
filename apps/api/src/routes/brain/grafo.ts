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

/** Defense during rolling upgrades: an older hub may ignore global budgets. */
function projectGraph(graph: z.infer<typeof GraphResponseSchema>, maxNodes: number, maxEdges: number, focus?: string) {
  const ids = new Set(graph.nodes.map(node => node.id));
  if (focus && !ids.has(focus)) return { nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, byType: {}, truncated: graph.stats.truncated } };
  const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) for (const [id, other] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    adjacency.get(id)!.add(other);
  }
  const distance = new Map<string, number>();
  if (focus && ids.has(focus)) {
    distance.set(focus, 0);
    const queue = [focus];
    for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i]!) ?? []) {
      if (!distance.has(next)) { distance.set(next, distance.get(queue[i]!)! + 1); queue.push(next); }
    }
  }
  const ranked = [...graph.nodes].sort((a, b) =>
    (focus ? (distance.get(a.id) ?? Infinity) - (distance.get(b.id) ?? Infinity) : 0) ||
    (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  let nodes = ranked.slice(0, maxNodes);
  const chosen = new Set(nodes.map(node => node.id));
  const eligible = edges.filter(edge => chosen.has(edge.source) && chosen.has(edge.target));
  // Keep a breadth-first spanning backbone before filling remaining links.
  // Tight edge budgets then retain useful neighbors instead of detached islands.
  const picked: typeof edges = [];
  const used = new Set<typeof edges[number]>();
  const incident = new Map<string, typeof edges>();
  for (const edge of eligible) for (const id of [edge.source, edge.target]) {
    if (!incident.has(id)) incident.set(id, []);
    incident.get(id)!.push(edge);
  }
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id) || (focus && seen.size > 0)) continue;
    const queue = [node.id]; seen.add(node.id);
    for (let i = 0; i < queue.length && picked.length < maxEdges; i++) for (const edge of incident.get(queue[i]!) ?? []) {
      const next = edge.source === queue[i] ? edge.target : edge.source;
      if (seen.has(next) || picked.length >= maxEdges) continue;
      seen.add(next); queue.push(next); used.add(edge); picked.push(edge);
    }
  }
  for (const edge of eligible) {
    if (picked.length >= maxEdges) break;
    if (!used.has(edge) && (!focus || (seen.has(edge.source) && seen.has(edge.target)))) picked.push(edge);
  }
  if (focus) nodes = nodes.filter(node => seen.has(node.id));
  const byType: Record<string, number> = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  return { nodes, edges: picked, stats: {
    nodeCount: nodes.length, edgeCount: picked.length, byType,
    truncated: graph.stats.truncated || nodes.length < graph.nodes.length || picked.length < graph.edges.length,
  } };
}

function isIsoDateLike(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Cancelación de extremo a extremo: el cliente puede cerrar la conexión
 * ("Ver vecinos" repetido, cambio de pestaña) antes de que el hub responda —
 * sin esto la llamada seguiría viva sin nadie escuchando. Se aborta en cuanto
 * `raw` emite `close` y `dispose()` quita el listener siempre al terminar,
 * salga bien o mal la llamada al hub. Recibe solo la superficie de
 * `req.raw` que usa (no todo `FastifyRequest`) para poder probarla con un
 * `EventEmitter` sencillo, sin depender de que el runtime de pruebas emita
 * `close` en peticiones GET sin cuerpo.
 */
export function abortSignalOnClientClose(raw: {
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  raw.on("close", onClose);
  return { signal: controller.signal, dispose: () => raw.off("close", onClose) };
}

const GrafoQuerySchema = z.object({
  maxNodes: z.coerce.number().int().min(1).max(300).default(120),
  maxEdges: z.coerce.number().int().min(1).max(600).default(240),
  limitPerType: z.coerce.number().int().min(1).max(300).optional(),
  since: z.string().refine(isIsoDateLike, "since debe ser una fecha válida").optional(),
  includeIsolated: z.enum(["true", "false"]).optional(),
  focus: z
    .string()
    .max(200, "focus no puede superar 200 caracteres")
    .regex(/^[a-z_]+:.+$/, "focus debe tener forma tipo:id")
    .optional(),
  depth: z.coerce.number().int().min(1).max(2).optional(),
});

export function registerBrainGrafoRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // GET /api/brain/grafo?limitPerType=&since=&includeIsolated=&focus=&depth=
  app.get("/api/brain/grafo", async (req) => {
    const query = parse(GrafoQuerySchema, req.query);
    const hub = requireHub(ctx);

    const disconnect = abortSignalOnClientClose(req.raw);

    let raw: unknown;
    try {
      raw = await hub.hubGetJson(
        "/api/wiki/graph",
        {
          limitPerType: query.limitPerType,
          maxNodes: query.maxNodes,
          maxEdges: query.maxEdges,
          since: query.since,
          includeIsolated: query.includeIsolated === "true",
          focus: query.focus,
          // El hub ignora depth sin focus; no tiene sentido mandarlo suelto.
          depth: query.focus ? query.depth ?? 1 : undefined,
        },
        { timeoutMs: 20_000, maxResponseBytes: 2 * 1024 * 1024, signal: disconnect.signal },
      );
    } catch (err) {
      throw asDomainError(err);
    } finally {
      disconnect.dispose();
    }

    // Reject oversized collections before Zod constructs per-item error trees.
    const shape = raw as { nodes?: unknown[]; edges?: unknown[] } | null;
    if ((Array.isArray(shape?.nodes) && shape.nodes.length > 4200) ||
        (Array.isArray(shape?.edges) && shape.edges.length > 12000)) {
      throw new AgentosError(ErrorCodes.PROVIDER_ERROR, "WhatsAppHub devolvió un grafo demasiado grande");
    }
    const parsed = GraphResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentosError(ErrorCodes.PROVIDER_ERROR, "WhatsAppHub devolvió un grafo con forma inesperada", {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    return projectGraph(parsed.data, query.maxNodes, query.maxEdges, query.focus);
  });

  // Carga progresiva (skeleton + capas + ego-red + búsqueda): mismas reglas de
  // auth y de aborto, envoltorio columnar reenviado tal cual. Ver más abajo.
  registerBrainGrafoDynamicRoutes(app, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grafo dinámico: skeleton + capas por fecha + ego-red + búsqueda.
//
// Cuatro rutas nuevas sobre los endpoints columnares del hub
// (`/api/wiki/graph/{skeleton,layer,neighbors/:id,search}`). Aquí NO se
// reproyecta nada a objetos: se valida la COHERENCIA del envoltorio columnar
// (largos de columnas, índices de aristas dentro de `refs`) y se reenvía tal
// cual, que es justo lo que ahorra memoria y tiempo en el navegador.
// La ruta vieja `/api/brain/grafo` queda intacta arriba.
// ─────────────────────────────────────────────────────────────────────────────

/** Solo estos tipos se piden por capas; los primarios ya vienen en el skeleton. */
const SECONDARY_NODE_TYPES = ["reunion", "nota", "nota_voz", "pagina"] as const;
type SecondaryNodeType = (typeof SECONDARY_NODE_TYPES)[number];

const NODE_ID_RE = /^[a-z_]+:.+$/;

/** `types=reunion,pagina` → lista validada contra el enum de secundarios. */
const SecondaryTypesCsv = z
  .string()
  .max(120, "types no puede superar 120 caracteres")
  .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
  .refine((list) => list.length > 0 && list.length <= SECONDARY_NODE_TYPES.length, "types vacío o demasiado largo")
  .refine(
    (list) => list.every((type) => (SECONDARY_NODE_TYPES as readonly string[]).includes(type)),
    "types solo admite tipos secundarios (reunion, nota, nota_voz, pagina)",
  )
  .transform((list) => [...new Set(list)] as SecondaryNodeType[]);

const LocationIdSchema = z.string().max(64, "locationId no puede superar 64 caracteres").optional();

const SkeletonQuerySchema = z.object({ locationId: LocationIdSchema });

const LayerQuerySchema = z.object({
  locationId: LocationIdSchema,
  types: SecondaryTypesCsv.optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  beforeId: z
    .string()
    .max(200, "beforeId no puede superar 200 caracteres")
    .regex(NODE_ID_RE, "beforeId debe tener forma tipo:id")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(300),
});

const NeighborsParamsSchema = z.object({
  id: z.string().max(200, "id no puede superar 200 caracteres").regex(NODE_ID_RE, "id debe tener forma tipo:id"),
});

const NeighborsQuerySchema = z.object({
  locationId: LocationIdSchema,
  depth: z.coerce.number().int().min(1).max(2).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(300),
});

/** La búsqueda sí puede filtrar por CUALQUIER tipo: busca en el índice entero. */
const AnyTypesCsv = z
  .string()
  .max(120, "types no puede superar 120 caracteres")
  .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
  .refine((list) => list.length > 0 && list.length <= GRAPH_NODE_TYPES.length, "types vacío o demasiado largo")
  .refine(
    (list) => list.every((type) => (GRAPH_NODE_TYPES as readonly string[]).includes(type)),
    "types tiene un tipo de nodo desconocido",
  )
  .transform((list) => [...new Set(list)]);

const SearchQuerySchema = z.object({
  locationId: LocationIdSchema,
  q: z.string().min(2, "q necesita al menos 2 caracteres").max(80, "q no puede superar 80 caracteres"),
  types: AnyTypesCsv.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

function providerError(detail: string): AgentosError {
  return new AgentosError(ErrorCodes.PROVIDER_ERROR, "WhatsAppHub devolvió un grafo con forma inesperada", { detail });
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isStringArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "string");
}

/** `ts` viaja siempre en epoch ms o null — nunca ISO (contrato §A.2). */
function isTsArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length &&
    value.every((item) => item === null || (typeof item === "number" && Number.isFinite(item)));
}

/**
 * Valida la coherencia del envoltorio columnar sin copiarlo: `refs.length ===
 * nodes.count + stubs.count`, todas las columnas del mismo largo y `edges.s/t`
 * dentro del rango de `refs`. Devuelve el MISMO objeto recibido para reenviarlo
 * sin reproyectar (la respuesta puede pesar cientos de KB).
 */
export function assertColumnarGraph(raw: unknown): Record<string, unknown> {
  const payload = raw as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") throw providerError("respuesta vacía");
  if (typeof payload.index !== "string") throw providerError("falta index");
  const refs = payload.refs;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) throw providerError("refs inválido");

  const nodes = payload.nodes as Record<string, unknown> | undefined;
  const stubs = payload.stubs as Record<string, unknown> | undefined;
  const edges = payload.edges as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes.count !== "number") throw providerError("nodes.count inválido");
  if (!stubs || typeof stubs.count !== "number") throw providerError("stubs.count inválido");
  if (!edges || typeof edges.count !== "number") throw providerError("edges.count inválido");

  const nodeCount = nodes.count;
  const stubCount = stubs.count;
  const edgeCount = edges.count;
  if (refs.length !== nodeCount + stubCount) throw providerError("refs.length no cuadra con nodes.count + stubs.count");

  if (!isNumberArray(nodes.type, nodeCount) || !isStringArray(nodes.label, nodeCount) ||
      !isTsArray(nodes.ts, nodeCount) || !isNumberArray(nodes.deg, nodeCount)) {
    throw providerError("columnas de nodes descuadradas");
  }
  if (!isNumberArray(stubs.type, stubCount) || !isStringArray(stubs.label, stubCount) || !isTsArray(stubs.ts, stubCount)) {
    throw providerError("columnas de stubs descuadradas");
  }
  if (!isNumberArray(edges.s, edgeCount) || !isNumberArray(edges.t, edgeCount) ||
      !isNumberArray(edges.type, edgeCount) || !isNumberArray(edges.w, edgeCount)) {
    throw providerError("columnas de edges descuadradas");
  }
  const sourceIdx = edges.s as number[];
  const targetIdx = edges.t as number[];
  for (let i = 0; i < edgeCount; i++) {
    const s = sourceIdx[i]!;
    const t = targetIdx[i]!;
    if (!Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0 || s >= refs.length || t >= refs.length) {
      throw providerError("edges.s/t fuera del rango de refs");
    }
  }

  const meta = payload.meta as Record<string, unknown> | undefined;
  if (meta && (!Array.isArray(meta.types) || !Array.isArray(meta.edgeTypes))) {
    throw providerError("meta.types/meta.edgeTypes inválidos");
  }
  return payload;
}

/** `/search` no es columnar: lista corta de resultados con su ts en epoch ms. */
const SearchResponseSchema = z.object({
  v: z.number().int().optional(),
  index: z.string(),
  results: z
    .array(
      z.object({
        id: z.string().max(200),
        type: z.string().max(40),
        label: z.string().max(400),
        ts: z.number().nullable().optional(),
      }),
    )
    .max(50),
});

/** Topes de bytes por endpoint (spec §B): el grafo completo son ~315 KB crudos. */
const BYTE_BUDGETS = {
  skeleton: 1024 * 1024,
  layer: 768 * 1024,
  neighbors: 512 * 1024,
  search: 64 * 1024,
} as const;

function registerBrainGrafoDynamicRoutes(app: FastifyInstance, ctx: ApiContext): void {
  /** Un solo camino al hub: aborto de extremo a extremo + traducción de errores. */
  async function callHub(
    raw: Parameters<typeof abortSignalOnClientClose>[0],
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    opts: { timeoutMs: number; maxResponseBytes: number },
  ): Promise<unknown> {
    const hub = requireHub(ctx);
    const disconnect = abortSignalOnClientClose(raw);
    try {
      return await hub.hubGetJson(path, query, { ...opts, signal: disconnect.signal });
    } catch (err) {
      throw asDomainError(err);
    } finally {
      disconnect.dispose();
    }
  }

  // GET /api/brain/grafo/skeleton?locationId=
  app.get("/api/brain/grafo/skeleton", async (req) => {
    const query = parse(SkeletonQuerySchema, req.query);
    const raw = await callHub(req.raw, "/api/wiki/graph/skeleton", { locationId: query.locationId }, {
      timeoutMs: 20_000,
      maxResponseBytes: BYTE_BUDGETS.skeleton,
    });
    return assertColumnarGraph(raw);
  });

  // GET /api/brain/grafo/layer?types=&before=&beforeId=&limit=&locationId=
  app.get("/api/brain/grafo/layer", async (req) => {
    const query = parse(LayerQuerySchema, req.query);
    const raw = await callHub(
      req.raw,
      "/api/wiki/graph/layer",
      {
        locationId: query.locationId,
        types: query.types?.join(","),
        before: query.before,
        beforeId: query.beforeId,
        limit: query.limit,
      },
      { timeoutMs: 12_000, maxResponseBytes: BYTE_BUDGETS.layer },
    );
    return assertColumnarGraph(raw);
  });

  // GET /api/brain/grafo/neighbors/:id?depth=&limit=&locationId=
  app.get("/api/brain/grafo/neighbors/:id", async (req) => {
    const params = parse(NeighborsParamsSchema, req.params);
    const query = parse(NeighborsQuerySchema, req.query);
    const raw = await callHub(
      req.raw,
      `/api/wiki/graph/neighbors/${encodeURIComponent(params.id)}`,
      { locationId: query.locationId, depth: query.depth, limit: query.limit },
      { timeoutMs: 12_000, maxResponseBytes: BYTE_BUDGETS.neighbors },
    );
    return assertColumnarGraph(raw);
  });

  // GET /api/brain/grafo/search?q=&limit=&types=&locationId=
  app.get("/api/brain/grafo/search", async (req) => {
    const query = parse(SearchQuerySchema, req.query);
    const raw = await callHub(
      req.raw,
      "/api/wiki/graph/search",
      { locationId: query.locationId, q: query.q, types: query.types?.join(","), limit: query.limit },
      { timeoutMs: 12_000, maxResponseBytes: BYTE_BUDGETS.search },
    );
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentosError(ErrorCodes.PROVIDER_ERROR, "WhatsAppHub devolvió una búsqueda con forma inesperada", {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    return parsed.data;
  });
}
