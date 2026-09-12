/**
 * 2brain › Notas de voz: notas transcritas y sincronizadas a Notion, y el
 * ingreso desde la Grabadora (comparten datos: la Grabadora solo escribe,
 * esta ruta además lista/lee/audita).
 *
 * Los datos y el pipeline (transcripción, clasificación, envío a Notion y a
 * LLM Wiki) siguen viviendo en WhatsAppHub ("el hub"); esta ruta proxea con
 * la sesión de AgentOS delante y valida la forma de cada respuesta con Zod
 * (whitelist: solo las claves que usan las vistas, nunca `passthrough`).
 *
 * Las imágenes de una nota llegan del hub como URL absoluta o relativa que
 * contiene `/media/<archivo>` (servida por su propio `express.static`): se
 * reescriben SIEMPRE a `/api/brain/notas-voz/media/<archivo>` para que la UI
 * las pida con `apiUrl()` (misma sesión, sin exponer el host del hub).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentosError, ErrorCodes, errors } from "@agentos/shared";
import { appendAudit } from "@agentos/db";
import type { ApiContext } from "../../context.js";
import { parse } from "../../http-errors.js";
import { asDomainError, requireHub } from "./shared.js";

const MEDIA_ROUTE_PREFIX = "/api/brain/notas-voz/media/";

/** El PNG/imagen del hub no viaja con su host: la UI la pide por AgentOS. */
function rewriteMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = "/media/";
  const idx = url.indexOf(marker);
  if (idx === -1) return url;
  return `${MEDIA_ROUTE_PREFIX}${url.slice(idx + marker.length)}`;
}

/**
 * Valida la respuesta del hub (no la petición): si no cumple la forma
 * esperada es un fallo del proveedor, no una entrada inválida del cliente,
 * así que sale como 502 `provider_error` legible — igual que cualquier otro
 * error del conector (`asDomainError`).
 */
function parseHubResponse<S extends z.ZodType>(schema: S, data: unknown, path: string): z.infer<S> {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new AgentosError(
      ErrorCodes.PROVIDER_ERROR,
      `WhatsAppHub devolvió una forma inesperada en ${path}`,
      { issues: res.error.issues },
    );
  }
  return res.data;
}

// ── Formas compartidas (whitelist de lo que usan las vistas) ────────────────

const NoteImage = z
  .object({
    url: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    mimetype: z.string().nullable().optional(),
  })
  .transform((img) => ({ ...img, url: rewriteMediaUrl(img.url) }));

const NotionTaskResult = z.object({
  text: z.string(),
  ok: z.boolean(),
  url: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

const RoutedInfo = z.object({
  wikiNoteId: z.union([z.string(), z.number()]).nullable().optional(),
  notionTasks: z.array(NotionTaskResult).optional(),
});

const ActionItem = z.object({
  text: z.string(),
  due: z.string().nullable().optional(),
});

const NoteSummary = z.object({
  id: z.coerce.string(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  duration_sec: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  routed: RoutedInfo.optional(),
});

const NoteDetail = NoteSummary.extend({
  transcript: z.string().nullable().optional(),
  action_items: z.array(ActionItem).optional(),
  ideas: z.array(z.string()).optional(),
  images: z.array(NoteImage).optional(),
});

const AuditItem = z.object({
  id: z.coerce.string(),
  title: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  durationSec: z.number().nullable().optional(),
  hasTranscript: z.boolean().optional(),
  summary: z.string().nullable().optional(),
  imagesCount: z.number().optional(),
  wikiNoteId: z.union([z.string(), z.number()]).nullable().optional(),
  notionTasks: z.array(NotionTaskResult).optional(),
  actionItemsCount: z.number().optional(),
  createdBy: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
});

const StatusResponse = z.object({
  transcription: z.boolean().default(false),
  vision: z.boolean().default(false),
  router_llm: z.boolean().default(false),
  notion: z.boolean().default(false),
});

const VoiceIngestResponse = z.object({
  ok: z.boolean().optional(),
  voiceNoteId: z.union([z.string(), z.number()]).optional(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  action_items: z.array(ActionItem).optional(),
  ideas: z.array(z.string()).optional(),
  images: z.array(NoteImage).optional(),
  notionTasks: z.array(NotionTaskResult).optional(),
  notionTasks_pending: z.number().optional(),
  wikiNoteId: z.union([z.string(), z.number()]).nullable().optional(),
});

const RetryNotionResponse = z.object({
  ok: z.boolean(),
  notionTasks: z.array(NotionTaskResult).default([]),
});

// ── Entrada ───────────────────────────────────────────────────────────────

const IdParam = z.object({ id: z.string().min(1) });

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const VoiceImageInput = z
  .object({
    dataUrl: z.string().optional(),
    base64: z.string().optional(),
    caption: z.string().optional(),
  })
  .refine((img) => Boolean(img.dataUrl?.trim() || img.base64?.trim()), {
    message: "Cada imagen necesita dataUrl o base64",
  });

const VoiceBody = z
  .object({
    transcript: z.string().optional(),
    audioBase64: z.string().optional(),
    mimetype: z.string().optional(),
    durationSec: z.number().optional(),
    images: z.array(VoiceImageInput).max(10).optional(),
    source: z.literal("agentos"),
  })
  .refine(
    (body) => Boolean(body.transcript?.trim() || body.audioBase64 || (body.images && body.images.length > 0)),
    { message: "Se necesita transcript, audioBase64 o al menos una imagen" },
  );

/** Body en base64 (audio + hasta 10 fotos): el límite por defecto de Fastify se queda corto. */
const VOICE_BODY_LIMIT = 40 * 1024 * 1024;

export function registerBrainNotasVozRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  const personActor = (req: { session?: { personId: string } | undefined }): string =>
    `person:${req.session!.personId}`;

  app.get("/api/brain/notas-voz", async () => {
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubGetJson("/api/notes");
    } catch (err) {
      throw asDomainError(err);
    }
    return parseHubResponse(z.object({ notes: z.array(NoteSummary).default([]) }), raw, "/api/notes");
  });

  app.get("/api/brain/notas-voz/status", async () => {
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubGetJson("/api/notes/status");
    } catch (err) {
      throw asDomainError(err);
    }
    return parseHubResponse(StatusResponse, raw, "/api/notes/status");
  });

  app.get("/api/brain/notas-voz/audit", async (req) => {
    const q = parse(AuditQuery, req.query);
    const limit = q.limit ?? 50;
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubGetJson("/api/notes/audit", { limit });
    } catch (err) {
      throw asDomainError(err);
    }
    return parseHubResponse(
      z.object({
        page: z.number().optional(),
        limit: z.number().optional(),
        total: z.number().optional(),
        totalPages: z.number().optional(),
        notes: z.array(AuditItem).default([]),
      }),
      raw,
      "/api/notes/audit",
    );
  });

  /** Passthrough de la imagen/foto del hub, para que la vista la pida vía `apiUrl()`. */
  app.get("/api/brain/notas-voz/media/*", async (req, reply) => {
    const rest = (req.params as Record<string, string>)["*"] ?? "";
    if (!rest || rest.includes("..")) throw errors.validation("Ruta de media inválida");
    const hub = requireHub(ctx);
    try {
      const raw = await hub.hubGetRaw(`/media/${rest}`);
      reply.header("content-type", raw.contentType ?? "application/octet-stream");
      reply.status(raw.status);
      return reply.send(Buffer.from(raw.body));
    } catch (err) {
      throw asDomainError(err);
    }
  });

  app.get("/api/brain/notas-voz/:id", async (req) => {
    const { id } = parse(IdParam, req.params);
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubGetJson(`/api/notes/${encodeURIComponent(id)}`);
    } catch (err) {
      throw asDomainError(err);
    }
    return parseHubResponse(z.object({ note: NoteDetail }), raw, `/api/notes/${id}`);
  });

  app.post("/api/brain/notas-voz/:id/retry-notion", async (req) => {
    const { id } = parse(IdParam, req.params);
    const hub = requireHub(ctx);
    let raw: unknown;
    try {
      raw = await hub.hubSendJson("POST", `/api/notes/${encodeURIComponent(id)}/retry-notion`, {});
    } catch (err) {
      throw asDomainError(err);
    }
    const body = parseHubResponse(RetryNotionResponse, raw, `/api/notes/${id}/retry-notion`);
    await appendAudit(db, {
      actor: personActor(req),
      source: "ui",
      action: "voice_note.retry_notion",
      entityType: "voice_note",
      entityId: id,
      after: { ok: body.ok, notionTasks: body.notionTasks.length },
    });
    return body;
  });

  app.post(
    "/api/brain/notas-voz/voice",
    { bodyLimit: VOICE_BODY_LIMIT },
    async (req, reply) => {
      const body = parse(VoiceBody, req.body);
      const hub = requireHub(ctx);
      const images = (body.images ?? []).map((img) => ({
        base64: (img.dataUrl ?? img.base64)!,
        ...(img.caption?.trim() ? { caption: img.caption.trim() } : {}),
      }));
      let raw: unknown;
      try {
        raw = await hub.hubSendJson(
          "POST",
          "/api/notes/voice",
          {
            transcript: body.transcript ?? "",
            audioBase64: body.audioBase64 ?? null,
            mimetype: body.mimetype ?? null,
            durationSec: body.durationSec ?? null,
            images,
            source: "agentos",
          },
          { timeoutMs: 240_000 },
        );
      } catch (err) {
        throw asDomainError(err);
      }
      const result = parseHubResponse(VoiceIngestResponse, raw, "/api/notes/voice");
      await appendAudit(db, {
        actor: personActor(req),
        source: "ui",
        action: "voice_note.ingested",
        entityType: "voice_note",
        entityId: result.voiceNoteId !== undefined ? String(result.voiceNoteId) : "desconocida",
        after: {
          title: result.title,
          category: result.category,
          notionTasks: result.notionTasks?.length ?? 0,
          wikiNoteId: result.wikiNoteId ?? null,
          images: images.length,
        },
      });
      reply.status(201);
      return result;
    },
  );
}
