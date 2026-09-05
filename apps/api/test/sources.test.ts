/**
 * Fuentes del proyecto (F2) por REST: asociar → ingerir → re-ingerir, browse
 * proxy y errores del conector. Conector SIEMPRE mock con fixtures de markdown
 * realistas — ninguna llamada real sale de los tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceConnectorError, type WhatsAppHubConnector } from "@agentos/shared";
import { getDoc, getProjectSource, listDocs } from "@agentos/db";
import { makeFixture, type TestFixture } from "./helpers.js";

const MEETING_MD = `# Reunión: Diagnóstico de producción — ACME

**Fecha:** 2026-08-21 · **Cliente:** ACME S.A.

## Resumen
El jefe de producción describió el flujo de planta: planificación semanal en
Excel, órdenes impresas y registro de mermas al final del turno.

## Dolores detectados
- Re-trabajos por órdenes desactualizadas (aprox. 6h/semana).
- Sin trazabilidad de lotes entre planta y facturación.
`;

const DOSSIER_MD = `# Dossier WhatsApp: Jefe de Producción ACME

## Transcript
[2026-08-18 09:12] Jefe Producción: Se volvió a parar la línea 2, el plan no llegó.
[2026-08-18 09:15] Ernesto: ¿Me pasas la foto del plan actual? Lo reviso con el equipo.
`;

interface MockState {
  failMeetingMarkdown: boolean;
  failContacts: boolean;
  isInternal: boolean;
  calls: string[];
}

function makeMockConnector(state: MockState): WhatsAppHubConnector {
  return {
    isConfigured: () => true,
    async listMeetings(params = {}) {
      state.calls.push(`listMeetings:${JSON.stringify(params)}`);
      return {
        meetings: [
          { id: "m-1", title: "Diagnóstico de producción", client: "ACME", date: "2026-08-21" },
          { id: "m-2", title: "Reunión interna Sixteam", client: null, is_internal: true },
        ],
        total: 2,
        hasMore: false,
      };
    },
    async getMeeting(meetingId) {
      state.calls.push(`getMeeting:${meetingId}`);
      return {
        id: meetingId,
        title: "Diagnóstico de producción",
        client: "ACME",
        is_internal: state.isInternal,
        driveFileId: "drive-123",
      };
    },
    async getMeetingMarkdown(meetingId) {
      state.calls.push(`getMeetingMarkdown:${meetingId}`);
      if (state.failMeetingMarkdown) {
        throw new SourceConnectorError(
          "unreachable",
          "No se pudo conectar con WhatsAppHub (/api/meetings). ¿VPS caído? Reintenta más tarde.",
        );
      }
      return MEETING_MD;
    },
    async listContacts() {
      state.calls.push("listContacts");
      if (state.failContacts) {
        throw new SourceConnectorError("timeout", "WhatsAppHub no respondió en 8000 ms (/api/wiki/contacts).");
      }
      return [
        { id: "c-1", name: "Jefe de Producción ACME", phone: "+58 412 111 1111" },
        { id: "c-2", name: "Gerente General ACME", phone: "+58 414 222 2222" },
        { id: "c-3", name: "Proveedor externo", phone: "+58 424 333 3333" },
      ];
    },
    async getDossierMarkdown(contactId) {
      state.calls.push(`getDossier:${contactId}`);
      return DOSSIER_MD;
    },
  };
}

describe("Fuentes del proyecto (REST)", () => {
  let fx: TestFixture;
  let state: MockState;

  beforeEach(async () => {
    state = { failMeetingMarkdown: false, failContacts: false, isInternal: false, calls: [] };
    fx = await makeFixture({ whatsappHub: makeMockConnector(state) });
  });

  afterEach(async () => {
    await fx.close();
  });

  async function linkMeeting(): Promise<{ id: string }> {
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${fx.project.id}/sources`,
      headers: fx.authHeaders,
      payload: {
        kind: "meeting",
        external_ref: { system: "whatsapphub", meetingId: "m-1", title: "Diagnóstico de producción" },
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { source: { id: string } }).source;
  }

  it("exige sesión (401 sin token)", async () => {
    const res = await fx.api.app.inject({ method: "GET", url: `/api/projects/${fx.project.id}/sources` });
    expect(res.statusCode).toBe(401);
  });

  it("asociar → listar; re-asociar la misma referencia no duplica (dedupe)", async () => {
    const source = await linkMeeting();

    const again = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${fx.project.id}/sources`,
      headers: fx.authHeaders,
      payload: {
        kind: "meeting",
        external_ref: { system: "whatsapphub", meetingId: "m-1", title: "Diagnóstico (retitulada)" },
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { deduped: boolean }).deduped).toBe(true);

    const list = await fx.api.app.inject({
      method: "GET",
      url: `/api/projects/${fx.project.id}/sources`,
      headers: fx.authHeaders,
    });
    const sources = (list.json() as { sources: { id: string; status: string }[] }).sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe(source.id);
    expect(sources[0]!.status).toBe("linked");
  });

  it("valida coherencia kind↔external_ref (meeting sin meetingId → 400)", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${fx.project.id}/sources`,
      headers: fx.authHeaders,
      payload: { kind: "meeting", external_ref: { system: "whatsapphub", title: "Sin id" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ingerir crea el knowledge_doc tipado y aparece en /api/knowledge del proyecto", async () => {
    const source = await linkMeeting();
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: { status: string; knowledgeDocId: string };
      doc: { id: string; kind: string; sourceRefs: Record<string, unknown>[] };
    };
    expect(body.source.status).toBe("ingested");
    expect(body.doc.kind).toBe("interview"); // is_internal=false → entrevista
    const ref = body.doc.sourceRefs[0]!;
    expect(ref.system).toBe("whatsapphub");
    expect(ref.meeting_id).toBe("m-1");
    expect(ref.project_source_id).toBe(source.id);
    expect((ref.ids as Record<string, unknown>).driveFileId).toBe("drive-123");

    // El doc ingerido aparece en la lista existente de knowledge_docs del proyecto.
    const docs = await fx.api.app.inject({
      method: "GET",
      url: `/api/knowledge?project_id=${fx.project.id}`,
      headers: fx.authHeaders,
    });
    const docList = (docs.json() as { docs: { id: string }[] }).docs;
    expect(docList.map((d) => d.id)).toContain(body.doc.id);
  });

  it("reunión interna → kind 'evidence'", async () => {
    state.isInternal = true;
    const source = await linkMeeting();
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect((res.json() as { doc: { kind: string } }).doc.kind).toBe("evidence");
  });

  it("re-ingerir actualiza el MISMO doc (no duplica)", async () => {
    const source = await linkMeeting();
    const first = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    const docId = (first.json() as { doc: { id: string } }).doc.id;

    const second = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { doc: { id: string } }).doc.id).toBe(docId);
    expect(listDocs(fx.db, { projectId: fx.project.id })).toHaveLength(1);
    expect(getDoc(fx.db, docId)!.updatedAt).toBeGreaterThanOrEqual(getDoc(fx.db, docId)!.createdAt);
  });

  it("error del conector → 502 legible, fuente en 'error' y SIN doc huérfano", async () => {
    state.failMeetingMarkdown = true;
    const source = await linkMeeting();
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    const err = (res.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("provider_error");
    expect(err.message).toContain("VPS");

    const after = getProjectSource(fx.db, source.id)!;
    expect(after.status).toBe("error");
    expect(after.lastError).toContain("VPS");
    expect(after.knowledgeDocId).toBeNull();
    expect(listDocs(fx.db, { projectId: fx.project.id })).toHaveLength(0);

    // Reintentable: al volver el VPS, la re-ingesta sana el estado.
    state.failMeetingMarkdown = false;
    const retry = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect(retry.statusCode).toBe(200);
    expect(getProjectSource(fx.db, source.id)!.status).toBe("ingested");
  });

  it("ingerir un hilo de WhatsApp produce 'evidence' con el transcript", async () => {
    const link = await fx.api.app.inject({
      method: "POST",
      url: `/api/projects/${fx.project.id}/sources`,
      headers: fx.authHeaders,
      payload: {
        kind: "whatsapp_thread",
        external_ref: { system: "whatsapphub", contactId: "c-1", title: "Hilo Jefe de Producción" },
      },
    });
    const source = (link.json() as { source: { id: string } }).source;
    const res = await fx.api.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const doc = (res.json() as { doc: { kind: string; bodyMd: string } }).doc;
    expect(doc.kind).toBe("evidence");
    expect(doc.bodyMd).toContain("Transcript");
  });

  it("browse proxy: reuniones normalizadas para el picker", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/sources/browse?kind=meeting",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { id: string; title: string; subtitle: string | null }[];
      has_more: boolean;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "m-1", title: "Diagnóstico de producción" });
    expect(body.items[0]!.subtitle).toContain("ACME");
    expect(body.has_more).toBe(false);
  });

  it("expone el ledger de procesamiento sin transcript ni extracción", async () => {
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/meetings/processing?status=pending&page=1&page_size=10",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mode: string;
      status: string;
      queue: { pending: number | null; errors: number | null; complete: number | null };
      meetings: Array<Record<string, unknown>>;
    };
    expect(body.mode).toBe("remote_read_only");
    expect(body.status).toBe("pending");
    expect(body.queue).toEqual({ pending: 2, errors: 2, complete: 2 });
    expect(body.meetings[0]).toMatchObject({
      id: "m-1",
      title: "Diagnóstico de producción",
      association_status: "awaiting_confirmation",
      task_status: "candidates_pending_confirmation",
    });
    expect(body.meetings[0]).not.toHaveProperty("transcript");
    expect(body.meetings[0]).not.toHaveProperty("extraction");
    expect(state.calls.some((call) => call.includes('"status":"pending"'))).toBe(true);
  });

  it("browse proxy: contactos con búsqueda y paginación local", async () => {
    const filtered = await fx.api.app.inject({
      method: "GET",
      url: "/api/sources/browse?kind=whatsapp_thread&q=gerente",
      headers: fx.authHeaders,
    });
    const fBody = filtered.json() as { items: { id: string }[]; total: number };
    expect(fBody.items).toHaveLength(1);
    expect(fBody.items[0]!.id).toBe("c-2");
    expect(fBody.total).toBe(1);

    const page1 = await fx.api.app.inject({
      method: "GET",
      url: "/api/sources/browse?kind=whatsapp_thread&page=1&page_size=2",
      headers: fx.authHeaders,
    });
    const p1 = page1.json() as { items: { id: string }[]; has_more: boolean; total: number };
    expect(p1.items.map((i) => i.id)).toEqual(["c-1", "c-2"]);
    expect(p1.has_more).toBe(true);
    expect(p1.total).toBe(3);

    const page2 = await fx.api.app.inject({
      method: "GET",
      url: "/api/sources/browse?kind=whatsapp_thread&page=2&page_size=2",
      headers: fx.authHeaders,
    });
    const p2 = page2.json() as { items: { id: string }[]; has_more: boolean };
    expect(p2.items.map((i) => i.id)).toEqual(["c-3"]);
    expect(p2.has_more).toBe(false);
  });

  it("browse con el conector caído responde 502 legible (no cuelga)", async () => {
    state.failContacts = true;
    const res = await fx.api.app.inject({
      method: "GET",
      url: "/api/sources/browse?kind=whatsapp_thread",
      headers: fx.authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("provider_error");
  });
});
