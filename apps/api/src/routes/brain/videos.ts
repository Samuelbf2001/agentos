/**
 * 2brain › Videos: ingesta de videos por URL, cola de jobs, transcripción y
 * análisis. Los datos y el pipeline (yt-dlp + ffmpeg + Whisper/análisis) viven
 * en el microservicio hermano `video-ingest`, detrás del backend de
 * WhatsAppHub ("el hub"): esta ruta solo transporta la petición autenticada
 * (`hub.hubGetJson`/`hubSendJson`/`hubGetText`/`hubGetRaw`) y valida/whitelist
 * la respuesta con Zod — el mismo patrón que el resto de módulos de 2brain.
 *
 * `POST /ingest` en el microservicio responde AL INSTANTE (202, encola) con un
 * id de cola efímero (`job-<ts>-<rand>`) DISTINTO del `jobId` final
 * (`<plataforma>-<slug-del-id>`, que además es el nombre de la carpeta de
 * salida): el resultado real solo aparece más tarde en `GET /jobs` — que el
 * hub resuelve leyendo `output/index.json`, es decir, solo jobs YA
 * terminados (completados, parciales o fallidos) — cuando el pipeline
 * escribe ahí. Por eso no hay redirección automática a un detalle tras
 * ingerir: la UI refresca la lista y dependen del cliente de este módulo.
 *
 * Las rutas de fichero que devuelve el hub (`/files/<jobId>/...`, miniatura y
 * keyframes) se reescriben a nuestro propio passthrough
 * (`/api/brain/videos/files/...`) para que la sesión de AgentOS quede
 * siempre delante y el origen real del hub nunca llegue al navegador.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appendAudit } from "@agentos/db";
import { errors, SourceConnectorError } from "@agentos/shared";
import type { ApiContext } from "../../context.js";
import { parse } from "../../http-errors.js";
import { asDomainError, requireHub } from "./shared.js";

const HUB_PREFIX = "/api/video-ingest";
const HUB_FILES_PREFIX = "/files/";
const OUR_FILES_PREFIX = "/api/brain/videos/files/";

const IngestBody = z.object({
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "La URL debe empezar por http:// o https://",
    }),
});

const HubIngestResponse = z.object({
  id: z.string(),
  status: z.string().optional(),
});

const HubVideoErrorSchema = z.object({
  stage: z.string().optional(),
  message: z.string().optional(),
});

/** Forma real de `buildHistoryItem` en `video-ingest/server.mjs` (lista y detalle comparten forma). */
const HubVideoJobSchema = z.object({
  jobId: z.string(),
  url: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  platform: z.string().optional().nullable(),
  duration: z.string().optional().nullable(),
  date: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  errorCount: z.number().optional(),
  errors: z.array(HubVideoErrorSchema).optional(),
  paths: z
    .object({
      thumbnail: z.string().optional(),
      keyframes: z.array(z.string()).optional(),
    })
    .optional(),
});

/** El hub devuelve el arreglo tal cual; tolera `{ jobs: [...] }` por si una instalación futura envuelve la lista. */
const HubVideoJobsResponse = z.preprocess((raw) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).jobs)) {
    return (raw as Record<string, unknown>).jobs;
  }
  return [];
}, z.array(HubVideoJobSchema));

const HubHealthResponse = z.object({
  ok: z.boolean().optional(),
  reachable: z.boolean().optional(),
});

const HubTextResponse = z.string();

interface VideoJob {
  id: string;
  title: string | null;
  platform: string | null;
  url: string | null;
  duration: string | null;
  date: string | null;
  status: string;
  error_count: number;
  errors: { stage: string; message: string }[];
  thumbnail_url: string | null;
  keyframe_urls: string[];
}

/** `/files/<jobId>/...` (el hub) → `/api/brain/videos/files/<jobId>/...` (nuestro passthrough). */
function rewriteHubFilePath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith(HUB_FILES_PREFIX)) return null;
  return `${OUR_FILES_PREFIX}${path.slice(HUB_FILES_PREFIX.length)}`;
}

/** Whitelist: solo lo que la vista pinta. `errorCount` puede faltar; se calcula del arreglo si no viene. */
function toVideoJob(raw: z.infer<typeof HubVideoJobSchema>): VideoJob {
  const jobErrors = (raw.errors ?? []).map((e) => ({
    stage: e.stage?.trim() || "",
    message: e.message?.trim() || "",
  }));
  return {
    id: raw.jobId,
    title: raw.title?.trim() || null,
    platform: raw.platform?.trim() || null,
    url: raw.url ?? null,
    duration: raw.duration ?? null,
    date: raw.date ?? null,
    status: raw.status?.trim() || "desconocido",
    error_count: raw.errorCount ?? jobErrors.length,
    errors: jobErrors,
    thumbnail_url: rewriteHubFilePath(raw.paths?.thumbnail),
    keyframe_urls: (raw.paths?.keyframes ?? [])
      .map((k) => rewriteHubFilePath(k))
      .filter((v): v is string => v !== null),
  };
}

/**
 * Valida `/api/brain/videos/files/<resto>`: rechaza segmentos `.`/`..` (path
 * traversal) y re-codifica cada segmento antes de pedirlo al hub (el
 * parámetro wildcard de Fastify llega ya decodificado).
 */
function safeHubFilesPath(rest: string): string | null {
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function registerBrainVideosRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  /** Encola la ingesta. NO crea el job final: solo pide al hub que arranque el pipeline. */
  app.post("/api/brain/videos/ingest", async (req, reply) => {
    const body = parse(IngestBody, req.body);
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubSendJson("POST", `${HUB_PREFIX}/ingest`, { url: body.url });
      const queued = HubIngestResponse.parse(raw);
      await appendAudit(db, {
        actor: personActor(req),
        source: "ui",
        action: "video.ingest_requested",
        entityType: "video_job",
        entityId: queued.id,
        after: { url: body.url, status: queued.status ?? "queued" },
      });
      reply.status(202);
      return { id: queued.id, status: queued.status ?? "queued" };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  /** Solo jobs YA terminados: `/api/history` del microservicio lee `output/index.json`. */
  app.get("/api/brain/videos/jobs", async () => {
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson(`${HUB_PREFIX}/jobs`);
      const jobs = HubVideoJobsResponse.parse(raw).map(toVideoJob);
      return { jobs };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  app.get("/api/brain/videos/jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson(`${HUB_PREFIX}/jobs/${encodeURIComponent(id)}`);
      const job = toVideoJob(HubVideoJobSchema.parse(raw));
      return { job };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  app.get("/api/brain/videos/jobs/:id/transcript", async (req) => {
    const { id } = req.params as { id: string };
    const hub = requireHub(ctx);
    try {
      const text = await hub.hubGetText(`${HUB_PREFIX}/files/${encodeURIComponent(id)}/transcript.md`);
      return { markdown: HubTextResponse.parse(text) };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  app.get("/api/brain/videos/jobs/:id/analysis", async (req) => {
    const { id } = req.params as { id: string };
    const hub = requireHub(ctx);
    try {
      const text = await hub.hubGetText(`${HUB_PREFIX}/files/${encodeURIComponent(id)}/analysis.md`);
      return { markdown: HubTextResponse.parse(text) };
    } catch (err) {
      throw asDomainError(err);
    }
  });

  /** Passthrough binario (miniaturas/keyframes) con el content-type del hub. */
  app.get("/api/brain/videos/files/*", async (req, reply) => {
    const wildcard = (req.params as { "*"?: string })["*"] ?? "";
    const rest = safeHubFilesPath(wildcard);
    if (rest === null) throw errors.validation("Ruta de archivo inválida", { path: wildcard });
    const hub = requireHub(ctx);
    try {
      const file = await hub.hubGetRaw(`${HUB_PREFIX}/files/${rest}`);
      reply.header("content-type", file.contentType ?? "application/octet-stream");
      return reply.status(file.status).send(Buffer.from(file.body));
    } catch (err) {
      // El conector convierte cualquier respuesta no-2xx del hub (404 típico
      // de una miniatura que aún no existe) en SourceConnectorError: se
      // conserva el status real en vez de aplanarlo todo a 502.
      if (err instanceof SourceConnectorError && typeof err.status === "number") {
        return reply.status(err.status).send();
      }
      throw asDomainError(err);
    }
  });

  /** Siempre 200 desde el hub (ver videoIngestClient.checkHealth): `ok`/`reachable` narran si el microservicio responde. */
  app.get("/api/brain/videos/health", async () => {
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetJson(`${HUB_PREFIX}/health`);
      const health = HubHealthResponse.parse(raw);
      return { ok: health.ok === true, reachable: health.reachable === true };
    } catch (err) {
      throw asDomainError(err);
    }
  });
}
