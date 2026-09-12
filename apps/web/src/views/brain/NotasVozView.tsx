/**
 * 2brain › Notas de voz: lo que capturó la Grabadora, transcrito y enrutado a
 * Notion y LLM Wiki por WhatsAppHub. Lista + detalle con deep link
 * (`?nota=<id>`) y una pestaña de auditoría; la única escritura de esta
 * vista es "Reintentar Notion" — grabar es responsabilidad de la Grabadora
 * (enlace explícito).
 *
 * Tolerante a `{}` o listas vacías: cada colección se trata como `[] `si el
 * servidor no la manda.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Mic, RefreshCw } from "lucide-react";
import { ApiError, apiUrl } from "../../lib/api";
import { paths } from "../../lib/paths";
import {
  fetchNotaVoz,
  fetchNotasVoz,
  fetchNotasVozAuditoria,
  fetchNotaVozStatus,
  retryNotaVozNotion,
  type NotaVozAuditoriaItem,
  type NotaVozDetalle,
  type NotaVozResumen,
  type NotaVozStatus,
} from "../../lib/brain/notas-voz";
import { ActionButton, Card, Chip, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner } from "../../components/ui";
import { ESTADO_LABEL, ESTADO_TONE, estadoRuteo, fechaLegible } from "./notas-voz/estado";

type Tab = "detalle" | "auditoria";

function EstadoChip({ routed }: { routed: NotaVozResumen["routed"] }) {
  const estado = estadoRuteo(routed);
  return <Chip tone={ESTADO_TONE[estado]}>{ESTADO_LABEL[estado]}</Chip>;
}

export default function NotasVozView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlNota = searchParams.get("nota");

  const [notes, setNotes] = useState<NotaVozResumen[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [status, setStatus] = useState<NotaVozStatus | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(urlNota);
  const [detail, setDetail] = useState<NotaVozDetalle | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("detalle");
  const [audit, setAudit] = useState<NotaVozAuditoriaItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // ── Lista ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setNotesLoading(true);
    setNotesError(null);
    void (async () => {
      try {
        const data = await fetchNotasVoz();
        if (cancelled) return;
        setNotes(Array.isArray(data?.notes) ? data.notes : []);
      } catch (err) {
        if (cancelled) return;
        setNotes([]);
        setNotesError(err instanceof ApiError ? err.message : "No se pudieron cargar las notas de voz.");
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchNotaVozStatus();
        if (!cancelled) setStatus(data ?? null);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // ── Selección + deep link ────────────────────────────────────────────────
  const selectNote = useCallback(
    (id: string) => {
      setSelectedId(id);
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set("nota", id);
        return next;
      });
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (urlNota && urlNota !== selectedId) {
      setSelectedId(urlNota);
      return;
    }
    if (!urlNota && !selectedId && notes.length > 0) selectNote(notes[0]!.id);
  }, [urlNota, selectedId, notes, selectNote]);

  // ── Detalle ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const data = await fetchNotaVoz(selectedId);
        if (cancelled) return;
        setDetail(data?.note ?? null);
      } catch (err) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(err instanceof ApiError ? err.message : "No se pudo cargar la nota.");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // ── Auditoría (solo cuando se abre la pestaña) ───────────────────────────
  useEffect(() => {
    if (tab !== "auditoria") return;
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    void (async () => {
      try {
        const data = await fetchNotasVozAuditoria(50);
        if (cancelled) return;
        setAudit(Array.isArray(data?.notes) ? data.notes : []);
      } catch (err) {
        if (cancelled) return;
        setAudit([]);
        setAuditError(err instanceof ApiError ? err.message : "No se pudo cargar la auditoría.");
      } finally {
        if (!cancelled) setAuditLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey]);

  const notasFiltradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) =>
      [n.title, n.summary, n.category, n.source].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [notes, busqueda]);

  const auditoriaVisible = selectedId ? audit.filter((a) => a.id === selectedId) : audit;

  const tareasNotion = detail?.routed?.notionTasks ?? [];
  const hayPendientesOFallidas = tareasNotion.some((t) => !t.ok);

  async function reintentarNotion() {
    if (!detail) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryNotaVozNotion(detail.id);
      const fresh = await fetchNotaVoz(detail.id);
      setDetail(fresh?.note ?? null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : "No se pudo reintentar Notion.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display text-ink">Notas de voz</h1>
          <p className="mt-1.5 max-w-[60ch] text-body text-muted">
            Transcripciones, resumen y tareas de Notion derivadas de lo que se grabó desde el móvil.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={paths.brainGrabadora()}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-small font-semibold text-surface hover:bg-ink-2"
          >
            <Mic size={14} strokeWidth={2} aria-hidden="true" />
            Grabar una nota
          </Link>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={notesLoading}
            className="press inline-flex min-h-9 items-center gap-1.5 rounded-tight border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-60"
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            Actualizar
          </button>
        </div>
      </div>

      {status && !status.notion ? (
        <p className="mt-3 rounded-soft border border-work-line bg-work-bg px-3 py-2 text-small text-work">
          Notion no está configurado en el servidor: las tareas quedarán pendientes hasta que se configure.
        </p>
      ) : null}

      {notesError ? (
        <div className="mt-4">
          <ErrorBox message={notesError} onRetry={() => setReloadKey((k) => k + 1)} />
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Lista */}
        <Card className="flex max-h-[75vh] min-h-[420px] flex-col overflow-hidden" data-testid="notas-voz-lista">
          <div className="border-b border-line p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-small font-semibold text-ink">Notas</h2>
              <span className="text-label text-muted">{notasFiltradas.length}</span>
            </div>
            <input
              type="text"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por título, resumen o categoría…"
              aria-label="Buscar notas de voz"
              className="mt-2 w-full rounded-tight border border-line bg-canvas px-2.5 py-1.5 text-small text-ink placeholder:text-faint focus:border-link focus:outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {notesLoading && notes.length === 0 ? <Spinner label="Cargando notas…" /> : null}
            {!notesLoading && notasFiltradas.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No hay notas de voz"
                  hint="Grábala desde el móvil con la Grabadora y aparecerá aquí."
                />
              </div>
            ) : null}
            <ul>
              {notasFiltradas.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    data-testid={`nota-fila-${n.id}`}
                    aria-current={n.id === selectedId ? "true" : undefined}
                    onClick={() => selectNote(n.id)}
                    className={`press flex w-full flex-col items-start gap-1 border-b border-line-soft px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-2 ${
                      n.id === selectedId ? "bg-link-bg" : ""
                    }`}
                  >
                    <div className="flex w-full items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">
                        {n.title || "Nota de voz"}
                      </span>
                      <EstadoChip routed={n.routed} />
                    </div>
                    <p className="text-label text-muted">
                      {fechaLegible(n.created_at)} · {n.source ?? "voz"}
                    </p>
                    {n.summary ? <p className="line-clamp-2 text-label text-muted">{n.summary}</p> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        {/* Detalle */}
        <Card className="flex min-h-[420px] flex-col overflow-hidden" data-testid="notas-voz-detalle">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState title="Selecciona una nota" hint="Elige una nota de la lista para ver su detalle." />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-title text-ink">{detail?.title || "Nota de voz"}</h2>
                  <p className="text-label text-muted">
                    {fechaLegible(detail?.created_at)} · origen: {detail?.source ?? "—"}
                  </p>
                </div>
                {detailLoading ? <Spinner label="Cargando…" /> : null}
              </div>

              <div className="flex items-center gap-1 border-b border-line px-4 pt-2" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "detalle"}
                  onClick={() => setTab("detalle")}
                  className={`press border-b-2 px-3 py-2 text-small font-semibold ${
                    tab === "detalle" ? "border-link text-ink" : "border-transparent text-muted hover:text-ink-2"
                  }`}
                >
                  Detalle
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "auditoria"}
                  onClick={() => setTab("auditoria")}
                  className={`press border-b-2 px-3 py-2 text-small font-semibold ${
                    tab === "auditoria" ? "border-link text-ink" : "border-transparent text-muted hover:text-ink-2"
                  }`}
                >
                  Auditoría
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {detailError ? <ErrorBox message={detailError} /> : null}

                {tab === "detalle" && detail ? (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone="quiet">{detail.category || "nota"}</Chip>
                      {detail.duration_sec != null ? (
                        <span className="text-label text-muted">{detail.duration_sec}s de audio</span>
                      ) : null}
                      {detail.routed?.wikiNoteId ? (
                        <Chip tone="done">En LLM Wiki (#{detail.routed.wikiNoteId})</Chip>
                      ) : (
                        <Chip tone="work">Sin registro en LLM Wiki</Chip>
                      )}
                    </div>

                    {detail.summary ? (
                      <section>
                        <SectionHead label="Resumen" />
                        <p className="text-body leading-relaxed text-ink-2">{detail.summary}</p>
                      </section>
                    ) : null}

                    {(detail.action_items?.length ?? 0) > 0 ? (
                      <section>
                        <SectionHead label="Action items" />
                        <ul className="space-y-1.5">
                          {detail.action_items!.map((a, i) => (
                            <li key={i} className="flex gap-2 text-small text-ink-2">
                              <span className="font-bold text-link" aria-hidden="true">
                                ›
                              </span>
                              <span>
                                {a.text}
                                {a.due ? <em className="text-muted"> ({a.due})</em> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}

                    {(detail.ideas?.length ?? 0) > 0 ? (
                      <section>
                        <SectionHead label="Ideas" />
                        <ul className="space-y-1.5">
                          {detail.ideas!.map((idea, i) => (
                            <li key={i} className="flex gap-2 text-small text-ink-2">
                              <span className="font-bold text-link" aria-hidden="true">
                                ›
                              </span>
                              <span>{idea}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}

                    <section>
                      <div className="flex items-center justify-between">
                        <SectionHead label="Tareas Notion" />
                        {hayPendientesOFallidas ? (
                          <ActionButton onClick={() => void reintentarNotion()} disabled={retrying} variant="quiet">
                            {retrying ? "Reintentando…" : "Reintentar Notion"}
                          </ActionButton>
                        ) : null}
                      </div>
                      {retryError ? <ErrorBox message={retryError} /> : null}
                      {tareasNotion.length > 0 ? (
                        <ul className="space-y-1.5">
                          {tareasNotion.map((t, i) => (
                            <li
                              key={i}
                              className="flex items-start justify-between gap-2 rounded-tight border border-line bg-canvas px-3 py-2"
                            >
                              <div className="text-small text-ink-2">
                                {t.url ? (
                                  <a href={t.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                                    {t.text}
                                  </a>
                                ) : (
                                  <span>{t.text}</span>
                                )}
                                {t.error ? <p className="mt-0.5 text-label text-broken">{t.error}</p> : null}
                              </div>
                              <Chip tone={t.ok ? "done" : "broken"}>{t.ok ? "hecha" : "fallida"}</Chip>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState title="Sin tareas Notion" hint="Esta nota no generó tareas derivadas." />
                      )}
                    </section>

                    <section>
                      <SectionHead label="Transcripción completa" />
                      {detail.transcript ? (
                        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-tight border border-line bg-canvas p-3 text-small leading-relaxed text-ink-2">
                          {detail.transcript}
                        </pre>
                      ) : (
                        <EmptyState title="Sin transcripción" hint="La nota solo tiene fotos u otro origen." />
                      )}
                    </section>

                    {(detail.images?.length ?? 0) > 0 ? (
                      <section>
                        <SectionHead label="Fotos" />
                        <div className="flex flex-wrap gap-2">
                          {detail.images!.map((img, i) =>
                            img.url ? (
                              <img
                                key={i}
                                src={apiUrl(img.url)}
                                alt={img.caption || `Foto ${i + 1}`}
                                className="h-20 w-20 rounded-tight border border-line object-cover"
                              />
                            ) : (
                              <div
                                key={i}
                                className="flex h-20 w-20 items-center justify-center rounded-tight border border-line bg-canvas text-label text-faint"
                              >
                                sin imagen
                              </div>
                            ),
                          )}
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {tab === "auditoria" ? (
                  <div className="space-y-3">
                    {auditLoading && audit.length === 0 ? <Spinner label="Cargando auditoría…" /> : null}
                    {auditError ? <ErrorBox message={auditError} /> : null}
                    {!auditLoading && auditoriaVisible.length === 0 ? (
                      <EmptyState title="Sin eventos de auditoría" hint="Todavía no hay registro para esta nota." />
                    ) : null}
                    {auditoriaVisible.map((ev) => (
                      <div key={ev.id} className="rounded-tight border border-line bg-canvas p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-small font-semibold text-ink">{ev.title || "Nota de voz"}</span>
                          <span className="text-label text-muted">{fechaLegible(ev.createdAt)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Chip tone="quiet">{ev.category || "nota"}</Chip>
                          <span className="text-label text-muted">
                            {ev.source ?? "—"} · {ev.createdBy ?? "sin autor"}
                          </span>
                          <span className="text-label text-muted">
                            {ev.actionItemsCount ?? 0} action items · {ev.imagesCount ?? 0} fotos
                          </span>
                        </div>
                        {ev.summary ? <p className="mt-1.5 text-small text-muted">{ev.summary}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
