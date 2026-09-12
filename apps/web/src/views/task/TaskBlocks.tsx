/**
 * Bloques del cuerpo de la ficha (evidencia, adjuntar, aviso de movimiento
 * bloqueado) más los dos editores de texto largo, sin botón "Editar": el campo
 * está siempre en sitio y guarda al perder el foco. `TaskDrawer.tsx` los
 * reexporta para no romper a quien ya los importaba (Hoy, alta de tarea,
 * tests).
 *
 * La descripción ya no tiene formulario de "insertar enlace o imagen por URL":
 * la imagen se pega, se suelta o se elige (`MarkdownField`) y el enlace se pega
 * tal cual.
 */
import { useEffect, useRef, useState } from "react";
import type { BlockedMove } from "../../state/store";
import { CodeBlock, Markdown } from "../../components/Markdown";
import type { Artifact, TaskAssistDraft } from "../../lib/types";
import { FieldAssist } from "./FieldAssist";
import { MarkdownField } from "./MarkdownField";

/** Lo que los editores necesitan para poder llamar al asistente. */
export interface FieldAssistHook {
  draft: () => TaskAssistDraft;
  taskId?: string;
}

/**
 * Descripción siempre editable (patrón Notion): campo Markdown en sitio con
 * imágenes y asistencia de IA, y vista previa. Guarda al salir del bloque si
 * hay cambios; no hay botón de guardar. Usa el PATCH con optimistic locking
 * del store, como el resto de la ficha.
 */
export function TaskDescriptionEditor({
  value,
  saving,
  onSave,
  assist,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
  assist?: FieldAssistHook;
}) {
  const [draft, setDraft] = useState(value);
  const sectionRef = useRef<HTMLElement>(null);
  /** Último texto enviado: si `value` vuelve igual, no pisa lo escrito después. */
  const sentRef = useRef<string | null>(null);
  /** El borrador vivo, para que el asistente lea lo que hay AHORA en pantalla. */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const sent = sentRef.current;
    if (sent !== null && (value === sent || (value === "" && sent.trim() === ""))) {
      sentRef.current = null;
      return;
    }
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;

  async function saveDescription() {
    if (draftRef.current === value) return;
    const next = draftRef.current;
    sentRef.current = next;
    const ok = await onSave(next.trim() ? next : null);
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
      <MarkdownField
        id="task-description-editor"
        testId="task-description-input"
        label="Descripción"
        value={draft}
        onChange={setDraft}
        onCommit={() => void saveDescription()}
        placeholder="Explica el objetivo, pega enlaces o arrastra una imagen…"
        header={
          <h3 id="task-description-title" className="text-small font-bold text-muted">
            Descripción
          </h3>
        }
        status={saving && dirty ? <span className="text-label text-faint">Guardando…</span> : null}
        {...(assist
          ? {
              assist: {
                field: "description" as const,
                draft: () => ({ ...assist.draft(), description: draftRef.current }),
                ...(assist.taskId ? { taskId: assist.taskId } : {}),
              },
            }
          : {})}
      />
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
  assist,
}: {
  value: string;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
  assist?: FieldAssistHook;
}) {
  const [draft, setDraft] = useState(value);
  const sentRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (sentRef.current !== null && value === sentRef.current) {
      sentRef.current = null;
      return;
    }
    setDraft(value);
  }, [value]);

  async function save(): Promise<void> {
    const next = draftRef.current.trim();
    if (next === value.trim()) return;
    sentRef.current = next;
    const ok = await onSave(next ? next : null);
    if (!ok) sentRef.current = null;
  }

  return (
    <section className="mt-5" aria-labelledby="task-dod-title">
      <div className="flex items-center gap-2">
        <h3 id="task-dod-title" className="text-small font-bold text-muted">
          Definición de terminado
        </h3>
        <span className="ml-auto flex items-center gap-0.5">
          {saving && draft.trim() !== value.trim() ? (
            <span className="text-label text-faint">Guardando…</span>
          ) : null}
          {assist ? (
            <FieldAssist
              field="definition_of_done"
              draft={() => ({ ...assist.draft(), definition_of_done: draftRef.current })}
              {...(assist.taskId ? { taskId: assist.taskId } : {})}
              onApply={(text) => setDraft(text)}
            />
          ) : null}
        </span>
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
        <span className="rounded-full bg-line px-1 py-0.5 font-mono text-label">{artifact.kind}</span>
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
 * Adjuntar evidencia: un solo sitio donde cae todo. Se suelta un archivo, se
 * elige con el botón o se pega un enlace en el mismo campo; el título es
 * opcional y hay un único botón. Antes eran dos pestañas y cuatro controles
 * para una acción sola ("muchos botones para guardar o eliminar cosas").
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
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const urlError =
    !file && url.trim() && !/^https?:\/\//i.test(url.trim())
      ? "Usa una URL que empiece por http:// o https://."
      : null;

  function limpiar(): void {
    setFile(null);
    setTitle("");
    setUrl("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit(): Promise<void> {
    setError(null);
    if (file) {
      const ok = await onUpload(file, title.trim() || undefined);
      if (ok) limpiar();
      return;
    }
    if (!url.trim() || urlError) {
      setError(urlError ?? "Suelta un archivo o pega el enlace del entregable.");
      return;
    }
    const ok = await onLink({ title: title.trim() || url.trim(), url: url.trim() });
    if (ok) limpiar();
  }

  return (
    <div
      data-testid="artifact-attacher"
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        setDragging(false);
        const dropped = event.dataTransfer?.files?.[0];
        if (!dropped) return;
        event.preventDefault();
        setFile(dropped);
        setUrl("");
        setError(null);
      }}
      className={`mt-2 rounded-panel border border-dashed p-3 transition-colors ${
        dragging ? "border-link bg-link-bg" : "border-line bg-surface-2"
      }`}
    >
      <label htmlFor="artifact-url" className="text-label font-semibold text-muted">
        Suelta un archivo aquí o pega un enlace
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {file ? (
          <span
            data-testid="artifact-file-chip"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-1 text-small text-ink-2"
          >
            <span aria-hidden="true">▤</span>
            <span className="max-w-[14rem] truncate">{file.name}</span>
            <button
              type="button"
              aria-label={`Quitar ${file.name}`}
              onClick={() => {
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="press min-h-5 min-w-5 rounded-full text-faint hover:text-broken focus:outline-none focus:ring-2 focus:ring-link"
            >
              ×
            </button>
          </span>
        ) : (
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
            className="min-h-10 min-w-0 flex-1 rounded-soft border border-line bg-surface px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
          />
        )}
        <input
          ref={fileRef}
          id="artifact-file"
          data-testid="artifact-file"
          type="file"
          className="sr-only"
          aria-label="Elegir archivo del entregable"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setUrl("");
            setError(null);
          }}
        />
        <button
          type="button"
          data-testid="artifact-file-pick"
          onClick={() => fileRef.current?.click()}
          className="press min-h-10 shrink-0 rounded-soft border border-line bg-surface px-3 text-small font-semibold text-ink-2 hover:border-link hover:text-link focus:outline-none focus:ring-2 focus:ring-link"
        >
          Elegir archivo
        </button>
      </div>
      {urlError ? (
        <p className="mt-1 text-label text-broken" role="alert">
          {urlError}
        </p>
      ) : null}

      <label htmlFor="artifact-title" className="mt-2 block text-label font-semibold text-muted">
        Título (opcional)
      </label>
      <input
        id="artifact-title"
        data-testid="artifact-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Ej. Informe de diagnóstico v2"
        className="mt-1 min-h-10 w-full rounded-soft border border-line bg-surface px-2.5 py-2 text-small focus:border-link focus:outline-none focus:ring-2 focus:ring-link"
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
        className="press mt-2 min-h-10 w-full rounded-soft bg-ink px-3 py-2 text-small font-semibold text-surface hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Adjuntando…" : "Adjuntar"}
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
