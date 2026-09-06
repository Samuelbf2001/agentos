/**
 * Contexto (US-12, spec B5 §8): Context Hub por proyecto — knowledge_docs por
 * tipo con búsqueda (knowledge.search), vista de doc (markdown + fuentes),
 * procesos como tabla con detalle de pasos, y metodologías (lectura + versión).
 *
 * Fase 2 — Fuentes del proyecto: sección para asociar reuniones y conversaciones
 * de WhatsApp de 2brain (WhatsAppHub) e ingerirlas como docs tipados del Hub.
 */
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type {
  KnowledgeDoc,
  ProcessEntity,
  ProjectSource,
  ProjectSourceKind,
  SourceBrowseItem,
} from "../lib/types";
import { Markdown } from "../components/Markdown";
import { EmptyState, ErrorBox, fmtDate, Spinner } from "../components/ui";
import { paths, type ContextSubtab } from "../lib/paths";

const KIND_LABELS: Record<string, string> = {
  org_profile: "Perfil de organización",
  process_map: "Mapa de proceso",
  interview: "Entrevista",
  finding: "Hallazgo",
  decision: "Decisión",
  iso_clause: "Cláusula ISO",
  evidence: "Evidencia",
  template: "Plantilla",
  note: "Nota",
};

// ── Fuentes del proyecto (Fase 2) ───────────────────────────────────────────

const SOURCE_KIND_LABELS: Record<ProjectSourceKind, string> = {
  meeting: "Reunión",
  whatsapp_thread: "WhatsApp",
};

const SOURCE_STATUS_STYLES: Record<string, string> = {
  linked: "bg-line text-ink-2",
  ingested: "bg-done-bg text-done",
  error: "bg-broken-bg text-broken",
};

const SOURCE_STATUS_LABELS: Record<string, string> = {
  linked: "asociada",
  ingested: "ingerida",
  error: "error",
};

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Modal picker: tabs Reuniones / WhatsApp + buscador sobre GET /api/sources/browse.
 * Elegir un item = asociar + ingerir en un paso (si la ingesta falla, la fuente
 * queda asociada con estado error legible y botón Re-ingerir en la lista).
 */
function SourcePickerModal({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<ProjectSourceKind>("meeting");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SourceBrowseItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(kind: ProjectSourceKind, query: string) {
    setItems(null);
    setError(null);
    try {
      const res = await api.browseSources(kind, query);
      setItems(res.items);
    } catch (err) {
      setError(errMessage(err, "No se pudo listar el catálogo de 2brain"));
    }
  }

  useEffect(() => {
    void load(tab, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function pick(item: SourceBrowseItem) {
    setBusyId(item.id);
    setError(null);
    try {
      const { source } = await api.linkProjectSource(projectId, tab, {
        system: "whatsapphub",
        ...(tab === "meeting" ? { meetingId: item.id } : { contactId: item.id }),
        title: item.title,
        ...(item.url ? { url: item.url } : {}),
      });
      try {
        await api.ingestSource(source.id);
      } catch {
        // Queda asociada con status 'error' legible; se reintenta desde la lista.
      }
      onDone();
      onClose();
    } catch (err) {
      setError(errMessage(err, "No se pudo asociar la fuente"));
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-soft bg-surface p-4 shadow-float">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-bold">Asociar fuente de 2brain</h3>
          <button onClick={onClose} className="rounded px-2 py-1 text-small text-muted hover:bg-line-soft">
            ✕ Cerrar
          </button>
        </div>
        <div className="mt-2 flex gap-1">
          {(["meeting", "whatsapp_thread"] as ProjectSourceKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-tight px-3 py-1.5 text-small font-medium ${
                tab === k ? "bg-ink text-surface" : "bg-line-soft text-muted hover:bg-line"
              }`}
            >
              {k === "meeting" ? "Reuniones" : "WhatsApp"}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void load(tab, q);
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === "meeting" ? "Buscar reunión (título, cliente)…" : "Buscar contacto…"}
            className="flex-1 rounded-tight border border-line px-2 py-1.5 text-small"
          />
          <button className="rounded-tight bg-ink px-2.5 py-1.5 text-small text-surface">🔍</button>
        </form>
        {error ? (
          <div className="mt-2">
            <ErrorBox message={error} onRetry={() => void load(tab, q)} />
          </div>
        ) : null}
        {items === null && !error ? <Spinner label="Consultando 2brain…" /> : null}
        {items !== null && items.length === 0 ? (
          <div className="mt-2">
            <EmptyState title="Sin resultados" hint="Prueba otro término de búsqueda." />
          </div>
        ) : null}
        <ul className="mt-2 divide-y divide-line-soft">
          {(items ?? []).map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-medium">{item.title}</p>
                {item.subtitle ? <p className="truncate text-label text-faint">{item.subtitle}</p> : null}
              </div>
              <button
                onClick={() => void pick(item)}
                disabled={busyId !== null}
                className="shrink-0 rounded-tight bg-link px-2.5 py-1 text-label font-medium text-surface hover:bg-link disabled:opacity-50"
              >
                {busyId === item.id ? "Asociando…" : "Asociar e ingerir"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Sección "Fuentes del proyecto": lista con estado + Re-ingerir + Asociar fuente. */
function SourcesSection({ projectId, onIngested }: { projectId: string; onIngested: () => void }) {
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await api.projectSources(projectId);
      setSources(res.sources);
    } catch (err) {
      setError(errMessage(err, "Error cargando fuentes del proyecto"));
    }
  }

  useEffect(() => {
    setSources(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function reingest(source: ProjectSource) {
    setBusyId(source.id);
    setError(null);
    try {
      await api.ingestSource(source.id);
      onIngested();
    } catch (err) {
      // El estado 'error' + last_error queda persistido; el mensaje sale en la fila.
      setError(errMessage(err, "La ingesta falló — reintenta cuando el VPS responda"));
    } finally {
      setBusyId(null);
      void load();
    }
  }

  return (
    <div className="mb-3 rounded-soft bg-surface shadow-rest p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-label font-bold text-muted">
          Fuentes del proyecto (2brain)
        </h3>
        <button
          onClick={() => setPickerOpen(true)}
          className="rounded-tight bg-ink px-2.5 py-1 text-label font-medium text-surface hover:bg-ink-2"
        >
          + Asociar fuente
        </button>
      </div>
      {error ? <div className="mt-2"><ErrorBox message={error} onRetry={() => void load()} /></div> : null}
      {sources === null && !error ? <Spinner label="Cargando fuentes…" /> : null}
      {sources !== null && sources.length === 0 ? (
        <p className="mt-2 text-small text-faint">
          Sin fuentes asociadas. Asocia reuniones o conversaciones de WhatsApp y quedarán como
          documentos tipados del Context Hub.
        </p>
      ) : null}
      <ul className="mt-2 divide-y divide-line-soft">
        {(sources ?? []).map((s) => (
          <li key={s.id} className="flex items-center gap-2 py-1.5">
            <span className="shrink-0 rounded-full bg-line px-1 py-0.5 text-label font-semibold">
              {SOURCE_KIND_LABELS[s.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-small font-medium">{s.externalRef.title}</p>
              {s.status === "error" && s.lastError ? (
                <p className="truncate text-label text-broken" title={s.lastError}>
                  {s.lastError}
                </p>
              ) : s.lastIngestedAt ? (
                <p className="text-label text-faint">ingerida {fmtDate(s.lastIngestedAt)}</p>
              ) : null}
            </div>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-label font-semibold ${
                SOURCE_STATUS_STYLES[s.status] ?? "bg-line text-ink-2"
              }`}
            >
              {SOURCE_STATUS_LABELS[s.status] ?? s.status}
            </span>
            <button
              onClick={() => void reingest(s)}
              disabled={busyId !== null}
              className="shrink-0 rounded-tight border border-line px-2 py-0.5 text-label font-medium text-muted hover:bg-line-soft disabled:opacity-50"
            >
              {busyId === s.id ? "Ingiriendo…" : s.status === "linked" ? "Ingerir" : "Re-ingerir"}
            </button>
          </li>
        ))}
      </ul>
      {pickerOpen ? (
        <SourcePickerModal
          projectId={projectId}
          onClose={() => setPickerOpen(false)}
          onDone={() => {
            void load();
            onIngested();
          }}
        />
      ) : null}
    </div>
  );
}

function DocsTab({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<KnowledgeDoc | null>(null);
  const [searching, setSearching] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await api.knowledge({ project_id: projectId });
      setDocs(res.docs);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando documentos");
    }
  }

  useEffect(() => {
    setSelected(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      void load();
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await api.knowledgeSearch(query.trim());
      setDocs(res.hits);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error buscando");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <SourcesSection projectId={projectId} onIngested={() => void load()} />
      <div className="flex gap-4">
      <div className="w-80 shrink-0">
        <form onSubmit={search} className="flex gap-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar (knowledge.search)…"
            className="flex-1 rounded-tight border border-line px-2 py-1.5 text-small"
          />
          <button className="rounded-tight bg-ink px-2.5 py-1.5 text-small text-surface" disabled={searching}>
            🔍
          </button>
        </form>
        {error ? <div className="mt-2"><ErrorBox message={error} onRetry={() => void load()} /></div> : null}
        {docs === null && !error ? <Spinner label="Cargando…" /> : null}
        {docs !== null && docs.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              title="Sin documentos"
              hint="Todo artefacto relevante de un agente se registra aquí tipado — la conversación es efímera, el contexto no."
            />
          </div>
        ) : null}
        <ul className="mt-2 space-y-1">
          {(docs ?? []).map((d) => (
            <li key={d.id}>
              <button
                onClick={() => setSelected(d)}
                className={`w-full rounded-tight px-2 py-1.5 text-left text-small ${
                  selected?.id === d.id ? "bg-line font-medium" : "hover:bg-line-soft"
                }`}
              >
                <span className="mr-1 rounded-full bg-line px-1 py-0.5 text-label font-semibold">
                  {KIND_LABELS[d.kind] ?? d.kind}
                </span>
                {d.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <div className="rounded-soft bg-surface shadow-rest p-4">
            <p className="text-label text-faint">
              {KIND_LABELS[selected.kind] ?? selected.kind} · actualizado {fmtDate(selected.updatedAt)}
            </p>
            <h2 className="text-body font-bold">{selected.title}</h2>
            {selected.tags && selected.tags.length > 0 ? (
              <p className="mt-1 flex flex-wrap gap-1">
                {selected.tags.map((t) => (
                  <span key={t} className="rounded-full bg-link-bg px-1.5 py-0.5 text-label text-link">
                    #{t}
                  </span>
                ))}
              </p>
            ) : null}
            <div className="mt-3 text-body">
              <Markdown>{selected.bodyMd}</Markdown>
            </div>
            <div className="mt-4 border-t border-line-soft pt-2">
              <p className="text-label font-bold text-faint">
                Fuentes (provenance)
              </p>
              {selected.sourceRefs && selected.sourceRefs.length > 0 ? (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-2 p-2 text-label">
                  {JSON.stringify(selected.sourceRefs, null, 2)}
                </pre>
              ) : (
                <p className="mt-1 text-small text-work">Sin fuente registrada — no verificado.</p>
              )}
            </div>
          </div>
        ) : (
          <EmptyState title="Elige un documento" hint="El Context Hub es el activo del engagement." />
        )}
      </div>
      </div>
    </div>
  );
}

function ProcessesTab() {
  const [processes, setProcesses] = useState<ProcessEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProcessEntity | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await api.processes();
      setProcesses(res.processes);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error cargando procesos");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  if (error) return <ErrorBox message={error} onRetry={() => void load()} />;
  if (processes === null) return <Spinner label="Cargando procesos…" />;
  if (processes.length === 0) {
    return (
      <EmptyState
        title="Sin procesos mapeados"
        hint="Un proceso mapeado es una entidad de primera clase: nombre, dueño, as-is/to-be, pasos y fuentes."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-soft bg-surface shadow-rest">
        <table className="w-full text-left text-small">
          <thead className="bg-surface-2 text-label text-faint">
            <tr>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Dueño</th>
              <th className="px-3 py-2">Variante</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Nº fuentes</th>
              <th className="px-3 py-2">Pasos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {processes.map((p) => (
              <tr
                key={p.id}
                onClick={() => setSelected(p)}
                className={`cursor-pointer hover:bg-surface-2 ${selected?.id === p.id ? "bg-link-bg" : ""}`}
              >
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2">{p.ownerPerson ?? "—"}</td>
                <td className="px-3 py-2">{p.variant === "as_is" ? "as-is" : "to-be"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-label font-semibold ${
                      p.status === "validated"
                        ? "bg-done-bg text-done"
                        : "bg-work-bg text-work"
                    }`}
                  >
                    {p.status === "validated" ? "validado" : "borrador"}
                  </span>
                </td>
                <td className="px-3 py-2">{p.sourceDocIds?.length ?? 0}</td>
                <td className="px-3 py-2">{p.steps?.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <div className="rounded-soft bg-surface shadow-rest p-4">
          <h3 className="text-body font-bold">
            {selected.name} <span className="text-small font-normal text-faint">({selected.variant})</span>
          </h3>
          {selected.steps && selected.steps.length > 0 ? (
            <ol className="mt-2 space-y-1">
              {selected.steps.map((s, i) => (
                <li key={i} className="rounded bg-surface-2 p-2 text-small">
                  <span className="font-semibold">{i + 1}. {s.step}</span>
                  <span className="ml-2 text-muted">
                    {s.responsible ? `resp: ${s.responsible}` : ""}
                    {s.system ? ` · sistema: ${s.system}` : ""}
                    {s.input ? ` · entrada: ${s.input}` : ""}
                    {s.output ? ` · salida: ${s.output}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-small text-faint">(sin pasos registrados)</p>
          )}
          {selected.painPoints && selected.painPoints.length > 0 ? (
            <div className="mt-2">
              <p className="text-label font-bold text-faint">Puntos de dolor</p>
              <ul className="ml-4 list-disc text-small text-broken">
                {selected.painPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Contexto del proyecto. Las metodologías emigraron a Activo Sixteam, porque
 * son de Sixteam y no del cliente; el panel de reuniones vive en Sistema ›
 * Fuentes, porque es transversal a todos los proyectos.
 */
export default function ContextView({ projectId, sub }: { projectId: string; sub: ContextSubtab }) {
  const tabs = [
    { id: "documentos" as const, label: "Documentos" },
    { id: "procesos" as const, label: "Procesos" },
  ];
  return (
    <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-5 sm:px-5">
      <div className="mb-4 flex gap-0.5">
        {tabs.map((t) => (
          <NavLink
            key={t.id}
            to={paths.contexto(projectId, t.id)}
            aria-pressed={sub === t.id}
            className={`press inline-flex min-h-9 items-center rounded-tight px-3 py-1.5 text-small font-semibold ${
              sub === t.id ? "bg-canvas-deep text-ink" : "text-muted hover:text-ink-2"
            }`}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      {sub === "documentos" ? <DocsTab projectId={projectId} /> : <ProcessesTab />}
    </div>
  );
}
