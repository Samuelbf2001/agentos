/**
 * 2brain › Videos (REST): ingesta por URL, cola de jobs (solo terminados,
 * `/api/history` del microservicio), transcripción/análisis y passthrough de
 * ficheros. Conector SIEMPRE mock — ninguna llamada real sale de los tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { queryAudit } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

type HubGetJson = (path: string, query?: Record<string, unknown>) => Promise<unknown>;
type HubSendJson = (method: string, path: string, body: unknown) => Promise<unknown>;
type HubGetText = (path: string) => Promise<string>;
type HubGetRaw = (path: string) => Promise<{ status: number; contentType: string | null; body: Uint8Array }>;

interface MockState {
  calls: string[];
  hubGetJsonImpl: HubGetJson;
  hubSendJsonImpl: HubSendJson;
  hubGetTextImpl: HubGetText;
  hubGetRawImpl: HubGetRaw;
}

function notImplemented(name: string) {
  return async () => {
    throw new Error(`${name} no implementado en el mock de brain-videos`);
  };
}

function defaultState(): MockState {
  return {
    calls: [],
    hubGetJsonImpl: notImplemented("hubGetJson") as HubGetJson,
    hubSendJsonImpl: notImplemented("hubSendJson") as HubSendJson,
    hubGetTextImpl: notImplemented("hubGetText") as HubGetText,
    hubGetRawImpl: notImplemented("hubGetRaw") as HubGetRaw,
  };
}

function makeConnector(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    listMeetings: notImplemented("listMeetings"),
    getMeeting: notImplemented("getMeeting"),
    getMeetingMarkdown: notImplemented("getMeetingMarkdown"),
    listContacts: notImplemented("listContacts"),
    getDossierMarkdown: notImplemented("getDossierMarkdown"),
    async hubGetJson(path, query) {
      state.calls.push(`GET:${path}`);
      return state.hubGetJsonImpl(path, query);
    },
    async hubSendJson(method, path, body) {
      state.calls.push(`${method}:${path}`);
      return state.hubSendJsonImpl(method, path, body);
    },
    async hubGetText(path) {
      state.calls.push(`GETTEXT:${path}`);
      return state.hubGetTextImpl(path);
    },
    async hubGetRaw(path) {
      state.calls.push(`GETRAW:${path}`);
      return state.hubGetRawImpl(path);
    },
  };
}

const JOB_FULL = {
  jobId: "youtube-abc123",
  url: "https://www.youtube.com/watch?v=abc123",
  title: "Cómo mapear un proceso",
  platform: "youtube",
  duration: "12:34",
  date: "2026-09-01T10:00:00.000Z",
  status: "completed",
  errorCount: 0,
  errors: [],
  // Campos reales del hub que la vista NO usa: no deben llegar al cliente.
  folder: "youtube-abc123",
  secretInternalField: "no-deberia-salir",
  paths: {
    folder: "/files/youtube-abc123",
    thumbnail: "/files/youtube-abc123/thumbnail.jpg",
    transcript: "/files/youtube-abc123/transcript.md",
    analysis: "/files/youtube-abc123/analysis.md",
    meta: "/files/youtube-abc123/meta.json",
    keyframes: [
      "/files/youtube-abc123/keyframes/frame-000.jpg",
      "/files/youtube-abc123/keyframes/frame-001.jpg",
    ],
  },
};

const JOB_PARTIAL = {
  jobId: "tiktok-xyz",
  status: "partial",
  errorCount: 1,
  errors: [{ stage: "transcribe", message: "Whisper no respondió" }],
};

describe("2brain › Videos (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = defaultState();
    fx = await makeFixture({ whatsappHub: makeConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: "/api/brain/videos/jobs" });
    expect(res.statusCode).toBe(401);
  });

  it("ingerir: encola en el hub, audita y devuelve solo id/estado", async () => {
    state.hubSendJsonImpl = async () => ({ id: "job-12345-abcd", status: "queued" });
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/videos/ingest",
      headers: fx.authHeaders,
      payload: { url: "https://www.youtube.com/watch?v=abc123" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: "job-12345-abcd", status: "queued" });
    expect(state.calls).toContain("POST:/api/video-ingest/ingest");

    const entries = await queryAudit(fx.db, { entityType: "video_job", entityId: "job-12345-abcd" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("video.ingest_requested");
  });

  it("ingerir: valida la URL (400 sin url / con esquema no http)", async () => {
    const sinUrl = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/videos/ingest",
      headers: fx.authHeaders,
      payload: {},
    });
    expect(sinUrl.statusCode).toBe(400);

    const ftp = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/videos/ingest",
      headers: fx.authHeaders,
      payload: { url: "ftp://ejemplo.com/video.mp4" },
    });
    expect(ftp.statusCode).toBe(400);
  });

  it("ingerir: 502 legible cuando el hub falla", async () => {
    state.hubSendJsonImpl = async () => {
      throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub");
    };
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/api/brain/videos/ingest",
      headers: fx.authHeaders,
      payload: { url: "https://www.youtube.com/watch?v=abc123" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });

  it("lista jobs: whitelist y rutas de ficheros reescritas a nuestro passthrough", async () => {
    state.hubGetJsonImpl = async () => [JOB_FULL, JOB_PARTIAL];
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toContain("GET:/api/video-ingest/jobs");
    const { jobs } = res.json() as { jobs: Record<string, unknown>[] };
    expect(jobs).toHaveLength(2);

    expect(jobs[0]).toEqual({
      id: "youtube-abc123",
      title: "Cómo mapear un proceso",
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=abc123",
      duration: "12:34",
      date: "2026-09-01T10:00:00.000Z",
      status: "completed",
      error_count: 0,
      errors: [],
      thumbnail_url: "/api/brain/videos/files/youtube-abc123/thumbnail.jpg",
      keyframe_urls: [
        "/api/brain/videos/files/youtube-abc123/keyframes/frame-000.jpg",
        "/api/brain/videos/files/youtube-abc123/keyframes/frame-001.jpg",
      ],
    });
    // Ni el nombre de carpeta ni ningún campo interno del hub llegan al cliente.
    expect(jobs[0]).not.toHaveProperty("folder");
    expect(jobs[0]).not.toHaveProperty("secretInternalField");
    expect(jobs[0]).not.toHaveProperty("paths");

    expect(jobs[1]).toEqual({
      id: "tiktok-xyz",
      title: null,
      platform: null,
      url: null,
      duration: null,
      date: null,
      status: "partial",
      error_count: 1,
      errors: [{ stage: "transcribe", message: "Whisper no respondió" }],
      thumbnail_url: null,
      keyframe_urls: [],
    });
  });

  it("lista jobs: tolera que el hub devuelva {} (smoke global)", async () => {
    state.hubGetJsonImpl = async () => ({});
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobs: [] });
  });

  it("lista jobs: 502 cuando el hub falla", async () => {
    state.hubGetJsonImpl = async () => {
      throw new SourceConnectorError("timeout", "WhatsAppHub no respondió");
    };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });

  it("detalle de job: camino feliz", async () => {
    state.hubGetJsonImpl = async () => JOB_PARTIAL;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs/tiktok-xyz",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toContain("GET:/api/video-ingest/jobs/tiktok-xyz");
    expect((res.json() as { job: { id: string; status: string } }).job).toMatchObject({
      id: "tiktok-xyz",
      status: "partial",
    });
  });

  it("transcripción: markdown de texto plano del hub", async () => {
    state.hubGetTextImpl = async () => "# Transcripción\n\nHola mundo.";
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs/youtube-abc123/transcript",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toContain("GETTEXT:/api/video-ingest/files/youtube-abc123/transcript.md");
    expect(res.json()).toEqual({ markdown: "# Transcripción\n\nHola mundo." });
  });

  it("transcripción: 502 si el hub no la tiene", async () => {
    state.hubGetTextImpl = async () => {
      throw new SourceConnectorError("http_error", "WhatsAppHub respondió 404", 404);
    };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs/youtube-abc123/transcript",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
  });

  it("análisis: markdown de texto plano del hub", async () => {
    state.hubGetTextImpl = async () => "# Análisis\n\nResumen del video.";
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/jobs/youtube-abc123/analysis",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(state.calls).toContain("GETTEXT:/api/video-ingest/files/youtube-abc123/analysis.md");
    expect(res.json()).toEqual({ markdown: "# Análisis\n\nResumen del video." });
  });

  it("ficheros: passthrough binario con el content-type del hub", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    state.hubGetRawImpl = async () => ({ status: 200, contentType: "image/jpeg", body: bytes });
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/files/youtube-abc123/thumbnail.jpg",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(new Uint8Array(res.rawPayload)).toEqual(bytes);
    expect(state.calls).toContain("GETRAW:/api/video-ingest/files/youtube-abc123/thumbnail.jpg");
  });

  it("ficheros: conserva el 404 real del hub (no lo aplana a 502)", async () => {
    state.hubGetRawImpl = async () => {
      throw new SourceConnectorError("http_error", "WhatsAppHub respondió 404", 404);
    };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/files/youtube-abc123/no-existe.jpg",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it("salud: normaliza a { ok, reachable } y no filtra el resto del hub", async () => {
    state.hubGetJsonImpl = async () => ({
      ok: true,
      reachable: true,
      queue: 2,
      active: true,
      hasOpenAIKey: true,
    });
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/health",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reachable: true });
  });

  it("salud: microservicio caído pero hub vivo → 200 con ok/reachable en false", async () => {
    state.hubGetJsonImpl = async () => ({ ok: false, reachable: false });
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/health",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reachable: false });
  });

  it("salud: 502 cuando el hub mismo no responde", async () => {
    state.hubGetJsonImpl = async () => {
      throw new SourceConnectorError("unreachable", "No se pudo conectar con WhatsAppHub");
    };
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/brain/videos/health",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
  });
});
