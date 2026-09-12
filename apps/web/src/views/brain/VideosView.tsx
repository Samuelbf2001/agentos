/**
 * 2brain › Videos: ingesta de videos por URL (YouTube, TikTok, Instagram, X y
 * Facebook), cola de jobs del microservicio `video-ingest` y su
 * transcripción/análisis en Markdown, con keyframes.
 *
 * Master-detail con deep link (`?job=<id>`, ver `lib/paths.ts`). La lista
 * `GET /api/brain/videos/jobs` solo trae jobs YA terminados (el hub la
 * resuelve desde su historial persistido): tras «Ingerir» no hay redirección
 * automática a un detalle — se refresca la lista y el video aparece cuando el
 * pipeline termine. Mientras haya al menos un job en curso, la lista se
 * refresca sola cada 10 s (limpiado al desmontar).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, Video } from "lucide-react";
import { ActionButton, Card, Chip, SectionHead } from "../../components/system";
import { EmptyState, ErrorBox, Spinner, fmtDate } from "../../components/ui";
import { ApiError, apiUrl } from "../../lib/api";
import {
  getVideoAnalysis,
  getVideoHealth,
  getVideoJob,
  getVideoTranscript,
  ingestVideo,
  isVideoJobInProgress,
  listVideoJobs,
  videoStatusLabel,
  videoStatusTone,
  type VideoHealth,
  type VideoJob,
} from "../../lib/brain/videos";

const AUTO_REFRESH_MS = 10_000;

function toTimestamp(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Transcripción y análisis solo existen (o tiene sentido pedirlos) cuando el pipeline llegó a producir algo. */
function tieneLectura(status: string): boolean {
  return status === "completed" || status === "done" || status === "partial";
}

function JobRow({
  job,
  active,
  onSelect,
}: {
  job: VideoJob;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`press flex w-full items-center gap-3 rounded-tight px-2.5 py-2 text-left hover:bg-surface-2 ${
        active ? "bg-link-bg" : ""
      }`}
    >
      <span className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-tight bg-canvas-deep">
        {job.thumbnail_url ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={apiUrl(job.thumbnail_url)} alt="" className="h-full w-full object-cover" />
        ) : (
          <Video size={18} className="text-faint" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small font-semibold text-ink">{job.title || "Sin título"}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-label text-muted">
          <span>{job.platform || "plataforma desconocida"}</span>
          <span aria-hidden="true">·</span>
          <span>{fmtDate(toTimestamp(job.date))}</span>
        </span>
      </span>
      <Chip tone={videoStatusTone(job.status)}>{videoStatusLabel(job.status)}</Chip>
    </button>
  );
}

export default function VideosView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("job");

  const [url, setUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const [health, setHealth] = useState<VideoHealth | null>(null);

  const [detail, setDetail] = useState<VideoJob | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** El botón «Reintentar» del detalle solo necesita forzar que el efecto de abajo vuelva a correr. */
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  const [transcript, setTranscript] = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const list = await listVideoJobs();
      setJobs(list);
      setJobsError(null);
    } catch (err) {
      setJobsError(errorMessage(err, "No se pudo leer la cola de videos."));
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    getVideoHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, reachable: false }));
  }, [loadJobs]);

  // Auto-refresco cada 10 s mientras haya al menos un job en curso.
  useEffect(() => {
    if (!jobs.some((job) => isVideoJobInProgress(job.status))) return;
    const timer = setInterval(() => {
      void loadJobs();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [jobs, loadJobs]);

  // Deep link `?job=<id>`: carga el detalle cuando cambia; cancelable.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    (async () => {
      try {
        const job = await getVideoJob(selectedId);
        if (cancelled) return;
        setDetail(job);
        if (!job) setDetailError("Ese video no aparece en la cola.");
      } catch (err) {
        if (!cancelled) setDetailError(errorMessage(err, "No se pudo cargar el video."));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailReloadKey]);

  // Transcripción y análisis del job seleccionado, en paralelo.
  useEffect(() => {
    if (!selectedId || !detail || !tieneLectura(detail.status)) {
      setTranscript("");
      setTranscriptError(null);
      setAnalysis("");
      setAnalysisError(null);
      return;
    }
    let cancelled = false;

    setTranscriptLoading(true);
    setTranscriptError(null);
    getVideoTranscript(selectedId)
      .then((markdown) => {
        if (!cancelled) setTranscript(markdown);
      })
      .catch((err) => {
        if (!cancelled) setTranscriptError(errorMessage(err, "No se pudo cargar la transcripción."));
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });

    setAnalysisLoading(true);
    setAnalysisError(null);
    getVideoAnalysis(selectedId)
      .then((markdown) => {
        if (!cancelled) setAnalysis(markdown);
      })
      .catch((err) => {
        if (!cancelled) setAnalysisError(errorMessage(err, "No se pudo cargar el análisis."));
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, detail]);

  const selectJob = useCallback(
    (id: string) => {
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.set("job", id);
        return next;
      });
    },
    [setSearchParams],
  );

  async function handleIngest(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || ingesting) return;
    setIngesting(true);
    setIngestError(null);
    try {
      await ingestVideo(trimmed);
      setUrl("");
      await loadJobs();
    } catch (err) {
      setIngestError(errorMessage(err, "No se pudo encolar el video."));
    } finally {
      setIngesting(false);
    }
  }

  const healthChip =
    health === null
      ? null
      : health.ok && health.reachable
        ? { tone: "done" as const, label: "Servicio activo" }
        : { tone: "broken" as const, label: "Sin respuesta" };

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display text-ink">Videos</h1>
          <p className="mt-1.5 max-w-[60ch] text-body text-muted">
            Transcripción, keyframes y análisis de videos de YouTube, TikTok, Instagram, X y Facebook por URL.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {healthChip ? <Chip tone={healthChip.tone}>{healthChip.label}</Chip> : null}
          <ActionButton onClick={() => void loadJobs()} disabled={jobsLoading}>
            <RefreshCw size={14} aria-hidden="true" className={jobsLoading ? "animate-spin" : ""} />
            Actualizar
          </ActionButton>
        </div>
      </div>

      <form onSubmit={handleIngest} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Pega una URL de YouTube, TikTok, Instagram, X o Facebook…"
          aria-label="URL del video a ingerir"
          className="min-w-0 flex-1 rounded-tight border border-line bg-surface px-3 py-2 text-small text-ink outline-none focus:border-link"
        />
        <ActionButton type="submit" variant="primary" disabled={ingesting || !url.trim()}>
          {ingesting ? "Ingiriendo…" : "Ingerir"}
        </ActionButton>
      </form>
      {ingestError ? (
        <div className="mt-2">
          <ErrorBox message={ingestError} />
        </div>
      ) : null}

      <SectionHead label="Cola de videos" count={jobs.length} />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="max-h-[560px] overflow-y-auto p-2">
          {jobsLoading && jobs.length === 0 ? (
            <Spinner label="Cargando videos…" />
          ) : jobsError ? (
            <ErrorBox message={jobsError} onRetry={() => void loadJobs()} />
          ) : jobs.length === 0 ? (
            <EmptyState title="Aún no hay videos" hint="Pega una URL arriba y pulsa «Ingerir»." />
          ) : (
            <div className="flex flex-col gap-1">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} active={job.id === selectedId} onSelect={() => selectJob(job.id)} />
              ))}
            </div>
          )}
        </Card>

        <Card className="min-h-[360px] p-4">
          {!selectedId ? (
            <EmptyState title="Selecciona un video" hint="Elige uno de la lista para ver su detalle." />
          ) : detailLoading && !detail ? (
            <Spinner label="Cargando el video…" />
          ) : detailError ? (
            <ErrorBox message={detailError} onRetry={() => setDetailReloadKey((k) => k + 1)} />
          ) : detail ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-title text-ink">{detail.title || "Video"}</h2>
                  <p className="mt-0.5 text-small text-muted">
                    {detail.platform || "plataforma desconocida"}
                    {detail.duration ? ` · ${detail.duration}` : ""}
                    {detail.date ? ` · ${fmtDate(toTimestamp(detail.date))}` : ""}
                  </p>
                </div>
                <Chip tone={videoStatusTone(detail.status)}>{videoStatusLabel(detail.status)}</Chip>
              </div>

              {detail.url ? (
                <a
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-small font-semibold text-link hover:underline"
                >
                  Ver el video original
                </a>
              ) : null}

              {detail.keyframe_urls.length > 0 ? (
                <div>
                  <h3 className="text-label uppercase tracking-wide text-muted">Keyframes</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {detail.keyframe_urls.map((src) => (
                      <img key={src} src={apiUrl(src)} alt="" className="h-16 w-28 rounded-tight object-cover" />
                    ))}
                  </div>
                </div>
              ) : null}

              {detail.errors.length > 0 ? (
                <div>
                  <h3 className="text-label uppercase tracking-wide text-muted">Errores</h3>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {detail.errors.map((err, i) => (
                      <li
                        key={`${err.stage}-${i}`}
                        className="rounded-tight border border-broken-line bg-broken-bg px-2.5 py-1.5 text-small text-broken"
                      >
                        <strong>{err.stage || "error"}:</strong> {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <h3 className="text-label uppercase tracking-wide text-muted">Transcripción</h3>
                {transcriptLoading ? (
                  <Spinner label="Cargando transcripción…" />
                ) : transcriptError ? (
                  <p className="mt-1.5 text-small text-muted">{transcriptError}</p>
                ) : transcript ? (
                  <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-tight border border-line bg-canvas p-3 text-small text-ink-2">
                    {transcript}
                  </pre>
                ) : (
                  <p className="mt-1.5 text-small text-muted">Sin transcripción disponible.</p>
                )}
              </div>

              <div>
                <h3 className="text-label uppercase tracking-wide text-muted">Análisis</h3>
                {analysisLoading ? (
                  <Spinner label="Cargando análisis…" />
                ) : analysisError ? (
                  <p className="mt-1.5 text-small text-muted">{analysisError}</p>
                ) : analysis ? (
                  <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-tight border border-line bg-canvas p-3 text-small text-ink-2">
                    {analysis}
                  </pre>
                ) : (
                  <p className="mt-1.5 text-small text-muted">Sin análisis disponible.</p>
                )}
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
