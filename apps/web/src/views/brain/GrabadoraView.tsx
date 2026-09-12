/**
 * 2brain › Grabadora: captura de audio (o solo fotos) desde el móvil, portada
 * de WhatsAppHub (`web/src/pages/recorder`). Vive en modo inmersivo — sin
 * menú lateral ni cabecera del shell, igual que el lienzo de Notas
 * (`NotasView.tsx`) — porque en un móvil el micrófono y el temporizador deben
 * ocupar toda la pantalla.
 *
 * Se elimina el panel de configuración de backend/clave del original: la
 * sesión de AgentOS ya autentica y siempre manda a
 * `/api/brain/notas-voz/voice`. Tampoco se registra service worker ni
 * manifest (eso es del PWA suelto, no de esta vista dentro de AgentOS).
 */
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Camera, ChevronLeft, Images, Mic, Pause, Play, Square } from "lucide-react";
import { paths } from "../../lib/paths";
import { useShell } from "../../state/shell";
import { useGrabadora } from "./grabadora/useGrabadora";

export default function GrabadoraView() {
  const setInmersivo = useShell((s) => s.setInmersivo);
  useEffect(() => {
    setInmersivo(true);
    return () => setInmersivo(false);
  }, [setInmersivo]);

  const g = useGrabadora();
  const camInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  function onFilesElegidos(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) void g.onFotos(files);
    e.target.value = "";
  }

  const resultado = g.resultado;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas" data-testid="grabadora-vista">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Link
          to={paths.brainNotasVoz()}
          className="press inline-flex min-h-9 items-center gap-1.5 rounded-tight border border-line bg-surface px-2.5 text-small font-semibold text-ink-2 hover:bg-surface-2"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Notas de voz
        </Link>
        <h1 className="ml-1 text-title text-ink">Grabadora</h1>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-6">
        <p className="text-display tabular-nums text-ink" role="timer" aria-live="off">
          {g.timerText}
        </p>
        <p
          role="status"
          aria-live="polite"
          className={`min-h-[1.2em] max-w-[320px] text-center text-small ${
            g.stateKind === "live" ? "text-link" : g.stateKind === "error" ? "text-broken" : "text-muted"
          }`}
        >
          {g.stateText}
        </p>

        <div
          aria-hidden="true"
          className={`h-1.5 w-36 overflow-hidden rounded-full bg-line transition-opacity ${
            g.meterOn ? "opacity-100" : "opacity-0"
          }`}
        >
          <span
            className={`block h-full transition-[width] ${g.recording ? "bg-broken" : "bg-link"}`}
            style={{ width: `${g.meterLevel}%` }}
          />
        </div>

        <button
          type="button"
          onClick={() => (g.recording ? void g.detener() : void g.iniciar())}
          disabled={g.busy || (!g.soportado && !g.recording)}
          aria-label={g.recording ? "Detener y enviar" : "Empezar a grabar"}
          aria-pressed={g.recording}
          className={`press flex h-32 w-32 items-center justify-center rounded-full text-surface transition disabled:cursor-not-allowed disabled:opacity-40 ${
            g.recording ? "bg-broken" : "bg-ink"
          }`}
        >
          {g.busy ? (
            <span
              aria-hidden="true"
              className="h-9 w-9 animate-spin rounded-full border-4 border-surface/30 border-t-surface"
            />
          ) : g.recording ? (
            <Square size={40} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Mic size={44} strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>

        {g.recording ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={g.busy}
              onClick={() => (g.paused ? g.reanudar() : g.pausar())}
              className="press inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-small font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-50"
            >
              {g.paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              {g.paused ? "Reanudar" : "Pausar"}
            </button>
            <button
              type="button"
              disabled={g.busy}
              onClick={() => void g.detener()}
              className="press inline-flex min-h-10 items-center gap-1.5 rounded-full bg-broken px-4 text-small font-semibold text-surface disabled:opacity-50"
            >
              <Square size={14} aria-hidden="true" />
              Detener y enviar
            </button>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => camInputRef.current?.click()}
            aria-label="Tomar foto"
            className="press relative flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-ink-2 hover:bg-surface-2"
          >
            <Camera size={20} strokeWidth={1.75} aria-hidden="true" />
            {g.photos.length > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-broken px-1 text-label font-bold text-surface"
              >
                {g.photos.length}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            aria-label="Elegir fotos de galería"
            className="press flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-ink-2 hover:bg-surface-2"
          >
            <Images size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {g.photos.length > 0 && !g.recording && !g.busy ? (
            <button
              type="button"
              onClick={() => void g.enviarSoloFotos()}
              className="press rounded-full bg-ink px-4 py-2 text-small font-semibold text-surface hover:bg-ink-2"
            >
              Enviar fotos
            </button>
          ) : null}
        </div>
        <input
          ref={camInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          hidden
          onChange={onFilesElegidos}
        />
        <input ref={galleryInputRef} type="file" accept="image/*" multiple hidden onChange={onFilesElegidos} />

        {g.photos.length > 0 ? (
          <div className="flex max-w-[340px] flex-wrap justify-center gap-2">
            {g.photos.map((p, i) => (
              <div key={i} className="relative h-14 w-14 overflow-hidden rounded-tight border border-line">
                <img src={p.dataUrl} alt={`Foto ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={`Quitar foto ${i + 1}`}
                  onClick={() => g.quitarFoto(i)}
                  className="press absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-canvas bg-broken text-[11px] text-surface"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {g.banner ? (
          <div
            role="alert"
            className="flex w-full max-w-[420px] items-start gap-2 rounded-soft border border-work-line bg-work-bg px-3.5 py-3 text-small text-work"
          >
            <span className="flex-1">{g.banner.text}</span>
            {g.banner.actionLabel ? (
              <button
                type="button"
                onClick={g.banner.onAction}
                className="press shrink-0 rounded-tight bg-ink px-3 py-1.5 text-label font-semibold text-surface"
              >
                {g.banner.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          aria-live="polite"
          aria-label="Transcripción en vivo"
          className="min-h-[54px] w-full max-w-[420px] whitespace-pre-wrap rounded-soft border border-line bg-surface px-3.5 py-3 text-small leading-relaxed text-ink-2"
        >
          {g.finalTxt ? g.finalTxt : <span className="text-faint">Aquí aparece lo que dices…</span>}
          {g.interimTxt ? <span className="text-muted">{g.interimTxt}</span> : null}
        </div>
      </main>

      {g.mostrarResultado && resultado ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-30 overflow-auto bg-canvas">
          <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
            <p className="text-title font-bold text-ink">Nota procesada</p>
            <button
              type="button"
              onClick={g.cerrarResultado}
              className="press ml-auto rounded-tight bg-ink px-3.5 py-2 text-small font-semibold text-surface"
            >
              Listo
            </button>
          </div>
          <div className="mx-auto max-w-[620px] px-4 py-4">
            <p className="text-title font-bold text-ink">{resultado.title || "Nota de voz"}</p>
            {resultado.summary ? <p className="mt-2 text-body text-ink-2">{resultado.summary}</p> : null}
            {(resultado.action_items?.length ?? 0) > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {resultado.action_items!.map((a, i) => (
                  <li key={i} className="text-small text-ink-2">
                    › {a.text}
                    {a.due ? ` (${a.due})` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-small text-muted">
              Nota #{String(resultado.voiceNoteId ?? "—")} guardada
              {(resultado.notionTasks?.length ?? 0) > 0
                ? `, ${resultado.notionTasks!.filter((t) => t.ok).length}/${resultado.notionTasks!.length} tareas a Notion`
                : ""}
              .
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
