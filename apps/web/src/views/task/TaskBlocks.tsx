/**
 * Bloques del cuerpo de la ficha que NO cambian con el rediseño Notion
 * (artefactos, adjuntar evidencia, aviso de movimiento bloqueado) más los dos
 * editores de texto largo, que pierden el botón "Editar": textarea siempre
 * visible que guarda al perder el foco. `TaskDrawer.tsx` los reexporta para
 * no romper a quien ya los importaba (Hoy, alta de tarea, tests).
 */
import { useEffect, useRef, useState } from "react";
import type { BlockedMove } from "../../state/store";
import { CodeBlock, Markdown } from "../../components/Markdown";
import type { Artifact } from "../../lib/types";

type DescriptionInsertKind = "link" | "image";

function cleanMarkdownLabel(value: string, fallback: string): string {
  const clean = value.trim().replace(/[\[\]]/g, "");
  return clean || fallback;
}

/** Solo dejamos insertar recursos web explícitos; evita enlaces javascript: y data: en tareas. */
export function buildDescriptionInsert(kind: DescriptionInsertKind, label: string, url: string): string | null {
  const candidate = url.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const safeLabel = cleanMarkdownLabel(label, kind === "image" ? "Imagen" : "Enlace");
    return kind === "image"
      ? `![${safeLabel}](<${parsed.toString()}>)`
      : `[${safeLabel}](<${parsed.toString()}>)`;
  } catch {
    return null;
  }
}

function insertMarkdownAtCursor(
  value: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
  const next = `${before}${prefix}${insertion}${suffix}${after}`;
  return { value: next, cursor: before.length + prefix.length + insertion.length };
}

/**
 * Descripción siempre editable (patrón Notion): textarea en sitio, inserciones
 * guiadas de enlace/imagen y vista previa. Guarda al salir del bloque si hay
 * cambios; no hay botón de guardar. Usa el PATCH con optimistic locking del
 * store, como el resto de la ficha.
 */
export function TaskDescriptionEditor({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [insertKind, setInsertKind] = useState<DescriptionInsertKind | null>(null);
  const [insertLabel, setInsertLabel] = useState("");
  const [insertUrl, setInsertUrl] = useState("");
  const [insertError, setInsertError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Último texto enviado: si `value` vuelve igual, no pisa lo escrito después. */
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    const sent = sentRef.current;
    if (sent !== null && (value === sent || (value === "" && sent.trim() === ""))) {
      sentRef.current = null;
      return;
    }
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;

  function openInsert(kind: DescriptionInsertKind) {
    const textarea = textareaRef.current;
    const selected = textarea
      ? draft.slice(textarea.selectionStart, textarea.selectionEnd).trim()
      : "";
    setInsertKind(kind);
    setInsertLabel(selected);
    setInsertUrl("");
    setInsertError(null);
  }

  function addInsert() {
    if (!insertKind) return;
    const markdown = buildDescriptionInsert(insertKind, insertLabel, insertUrl);
    if (!markdown) {
      setInsertError("Usa una URL que empiece por http:// o https://.");
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const result = insertMarkdownAtCursor(draft, markdown, start, end);
    setDraft(result.value);
    setInsertKind(null);
    setInsertLabel("");
    setInsertUrl("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  async function saveDescription() {
    if (!dirty) return;
    sentRef.current = draft;
    const ok = await onSave(draft.trim() ? draft : null);
    if (!ok) sentRef.current = null;
  }

  return (
    <section
      ref={sectionRef}
      className="mt-5"
      aria-labelledby="task-description-title"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && sectionRef.current?.contains(next)) return;
        void saveDescription();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="task-description-title" className="text-small font-bold uppercase text-muted">Descripción</h3>
        <div className="flex flex-wrap items-center gap-2" aria-label="Insertar contenido en descripción">
          <button type="button" onClick={() => openInsert("link")} className="min-h-9 rounded-soft border border-line bg-surface px-3 py-1.5 text-small font-semibold text-ink-2 hover:border-link hover:text-link focus:outline-none focus:ring-2 focus:ring-link">↗ Enlace</button>
          <button type="button" onClick={() => openInsert("image")} className="min-h-9 rounded-soft border border-line bg-surface px-3 py-1.5 text-small font-semibold text-ink-2 hover:border-link hover:text-link focus:outline-none focus:ring-2 focus:ring-link">▧ Imagen</button>
          {saving && dirty ? <span className="text-label text-faint">Guardando…</span> : null}
        </div>
      </div>

      {insertKind ? (
        <fieldset className="mt-2 rounded-panel border border-link bg-surface p-3">
          <legend className="px-1 text-small font-semibold text-link">{insertKind === "image" ? "Añadir imagen por URL" : "Añadir enlace"}</legend>
          <label className="block text-label font-medium text-muted" htmlFor="description-insert-label">{insertKind === "image" ? "Texto alternativo" : "Texto visible"}</label>
          <input id="description-insert-label" value={insertLabel} onChange={(event) => setInsertLabel(event.target.value)} placeholder={insertKind === "image" ? "Ej. Boceto de flujo" : "Ej. Documento de referencia"} className="mt-1 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link" />
          <label className="mt-2 block text-label font-medium text-muted" htmlFor="description-insert-url">URL</label>
          <input id="description-insert-url" value={insertUrl} onChange={(event) => { setInsertUrl(event.target.value); setInsertError(null); }} placeholder="https://…" inputMode="url" className="mt-1 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link" />
          {insertError ? <p className="mt-1 text-label text-broken" role="alert">{insertError}</p> : null}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={addInsert} className="min-h-10 rounded-soft bg-ink px-3 py-1.5 text-small font-semibold text-surface hover:bg-ink-2 focus:outline-none focus:ring-2 focus:ring-link">Insertar</button>
            <button type="button" onClick={() => { setInsertKind(null); setInsertError(null); }} className="min-h-10 rounded-soft px-3 py-1.5 text-small font-semibold text-muted hover:bg-line-soft focus:outline-none focus:ring-2 focus:ring-link">Cancelar</button>
          </div>
        </fieldset>
      ) : null}

      <label htmlFor="task-description-editor" className="sr-only">Descripción</label>
      <textarea
        ref={textareaRef}
        id="task-description-editor"
        data-testid="task-description-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void saveDescription();
          }
        }}
        placeholder="Explica el objetivo, pega enlaces o añade una imagen…"
        className="mt-2 min-h-24 w-full resize-y rounded-panel border border-transparent bg-transparent px-2 py-1.5 text-body leading-relaxed hover:border-line focus:border-link focus:bg-surface focus:outline-none focus:ring-2 focus:ring-link"
      />
      {draft.trim() ? (
        <div className="mt-2 rounded-panel border border-line-soft bg-surface-2 p-3" aria-live="polite">
          <p className="text-label font-bold uppercase text-faint">Vista previa</p>
          <div className="mt-1 text-body"><Markdown>{draft}</Markdown></div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Definición de terminado: requisito duro de `BACKLOG→READY`. Textarea
 * siempre visible; guarda al perder el foco si cambió.
 */
export function DefinitionOfDoneEditor({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const sentRef = useRef<string | null>(null);

  useEffect(() => {
    if (sentRef.current !== null && value === sentRef.current) {
      sentRef.current = null;
      return;
    }
    setDraft(value);
  }, [value]);

  async function save(): Promise<void> {
    const next = draft.trim();
    if (next === value.trim()) return;
    sentRef.current = next;
    const ok = await onSave(next ? next : null);
    if (!ok) sentRef.current = null;
  }

  return (
    <section className="mt-5" aria-labelledby="task-dod-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="task-dod-title" className="text-small font-bold uppercase text-muted">
          Definición de terminado
        </h3>
        {saving && draft.trim() !== value.trim() ? <span className="text-label text-faint">Guardando…</span> : null}
      </div>
      <label htmlFor="task-dod-input" className="sr-only">
        Definición de terminado
      </label>
      <textarea
        id="task-dod-input"
        data-testid="task-dod-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        rows={3}
        placeholder="Qué tiene que existir para dar la tarea por cerrada"
        className="mt-2 w-full resize-y rounded-panel border border-transparent bg-transparent px-2 py-1.5 text-body hover:border-line focus:border-done focus:bg-surface focus:outline-none focus:ring-2 focus:ring-done"
      />
      {!value.trim() ? (
        <p className="mt-1 text-small text-work" data-testid="dod-missing">
          ⚠ Sin definición de terminado: la tarea no podrá pasar a READY.
        </p>
      ) : null}
    </section>
  );
}

export function ArtifactBlock({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(true);
  const isDiff = artifact.kind === "diff" || /\.(diff|patch)$/.test(artifact.title);
  return (
    <div className="rounded-tight border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 w-full items-center gap-2 bg-surface-2 px-3 py-2 text-left text-small focus:outline-none focus:ring-2 focus:ring-link focus:ring-inset"
      >
        <span className="rounded bg-line px-1 py-0.5 font-mono text-label">{artifact.kind}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
        <span className="text-faint" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="p-3 text-body">
          {artifact.content ? (
            isDiff ? (
              <CodeBlock code={artifact.content} lang="diff" />
            ) : (
              <Markdown>{artifact.content}</Markdown>
            )
          ) : artifact.path ? (
            <p className="break-words text-small text-muted">
              Archivo en workspace: <code className="rounded bg-line-soft px-1">{artifact.path}</code>
            </p>
          ) : (
            <p className="text-small text-faint">(sin contenido)</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function toDateTimeLocal(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): number | null {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Adjuntar evidencia: archivo real (multipart) o enlace. Es lo que convierte
 * la regla anti-teatro del motor en algo que un humano puede satisfacer desde
 * la interfaz sin pedirle nada a un agente.
 */
export function ArtifactAttacher({
  saving,
  onUpload,
  onLink,
}: {
  saving: boolean;
  onUpload: (file: File, title?: string) => Promise<boolean>;
  onLink: (input: { title: string; url: string }) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const urlError =
    mode === "link" && url.trim() && !/^https?:\/\//i.test(url.trim())
      ? "Usa una URL que empiece por http:// o https://."
      : null;

  async function submit(): Promise<void> {
    setError(null);
    if (mode === "file") {
      if (!file) {
        setError("Elige un archivo.");
        return;
      }
      const ok = await onUpload(file, title.trim() || undefined);
      if (ok) {
        setFile(null);
        setTitle("");
        if (fileRef.current) fileRef.current.value = "";
      }
      return;
    }
    if (!url.trim() || urlError) {
      setError(urlError ?? "Escribe la URL del entregable.");
      return;
    }
    const ok = await onLink({ title: title.trim() || url.trim(), url: url.trim() });
    if (ok) {
      setUrl("");
      setTitle("");
    }
  }

  return (
    <div className="mt-2 rounded-panel border border-dashed border-line bg-surface-2 p-3" data-testid="artifact-attacher">
      <div className="flex gap-1.5" role="tablist" aria-label="Tipo de artefacto">
        {(["file", "link"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            data-testid={`artifact-mode-${value}`}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={`min-h-9 rounded-soft px-3 py-1.5 text-small font-semibold ${
              mode === value ? "bg-ink text-surface" : "border border-line bg-surface text-muted"
            }`}
          >
            {value === "file" ? "Archivo" : "Enlace"}
          </button>
        ))}
      </div>

      {mode === "file" ? (
        <div className="mt-2">
          <label htmlFor="artifact-file" className="text-label font-semibold text-muted">
            Archivo del entregable
          </label>
          <input
            ref={fileRef}
            id="artifact-file"
            data-testid="artifact-file"
            type="file"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
            className="mt-1 block w-full text-small text-muted file:mr-2 file:min-h-9 file:rounded-soft file:border-0 file:bg-ink file:px-3 file:py-2 file:text-small file:font-semibold file:text-surface"
          />
        </div>
      ) : (
        <div className="mt-2">
          <label htmlFor="artifact-url" className="text-label font-semibold text-muted">
            URL del entregable
          </label>
          <input
            id="artifact-url"
            data-testid="artifact-url"
            value={url}
            inputMode="url"
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://…"
            className="mt-1 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
          />
          {urlError ? (
            <p className="mt-1 text-label text-broken" role="alert">
              {urlError}
            </p>
          ) : null}
        </div>
      )}

      <label htmlFor="artifact-title" className="mt-2 block text-label font-semibold text-muted">
        Título (opcional)
      </label>
      <input
        id="artifact-title"
        data-testid="artifact-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Ej. Informe de diagnóstico v2"
        className="mt-1 min-h-10 w-full rounded-soft border border-line px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
      />

      {error ? (
        <p className="mt-2 text-label text-broken" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        data-testid="artifact-submit"
        disabled={saving || Boolean(urlError)}
        onClick={() => void submit()}
        className="mt-2 min-h-10 w-full rounded-soft bg-link px-3 py-2 text-small font-semibold text-surface hover:bg-link disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Adjuntando…" : "Adjuntar artefacto"}
      </button>
    </div>
  );
}

/** Aviso del movimiento que el motor rechazó, con la salida a mano. */
export function BlockedMoveNotice({
  blocked,
  retrying,
  onRetry,
  onDismiss,
}: {
  blocked: BlockedMove;
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="mb-3 rounded-soft border border-broken bg-broken-bg p-3 text-small text-broken"
      role="alert"
      data-testid="blocked-move"
    >
      <p className="font-semibold">No se pudo mover la tarea a {blocked.to}.</p>
      <p className="mt-1 break-words">{blocked.message}</p>
      <p className="mt-1 text-label text-broken">
        Adjunta el entregable (archivo o enlace) abajo y vuelve a intentarlo.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="blocked-move-retry"
          disabled={retrying}
          onClick={onRetry}
          className="min-h-9 rounded-tight bg-broken px-3 py-1.5 font-semibold text-surface hover:bg-broken disabled:cursor-not-allowed disabled:opacity-40"
        >
          {retrying ? "Reintentando…" : `Reintentar mover a ${blocked.to}`}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-9 rounded-tight border border-broken bg-surface px-3 py-1.5 font-semibold text-broken hover:bg-broken-bg"
        >
          Descartar aviso
        </button>
      </div>
    </div>
  );
}
