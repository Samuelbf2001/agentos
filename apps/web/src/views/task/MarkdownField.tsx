/**
 * Campo de texto largo en Markdown con imágenes de verdad.
 *
 * "No veo en la tarea cómo añadir imágenes en descripción." Antes había que
 * abrir un formulario de tres campos y pegar una URL que alguien tenía que
 * alojar por su cuenta. Aquí la imagen entra por donde la gente ya la trae:
 * pegándola del portapapeles, soltándola sobre el texto o eligiéndola con el
 * icono. Se sube a `/api/uploads/images` y se escribe `![nombre](url)` en el
 * punto exacto del cursor.
 *
 * Los enlaces siguen pegándose tal cual: pegar texto no se intercepta.
 *
 * La barra vive en la esquina superior derecha y sólo tiene lo que hace algo:
 * imagen, ✦ mejorar con IA y ⧉ copiar prompt de ejecución.
 */
import { useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Markdown } from "../../components/Markdown";
import { insertarEnCursor } from "../../lib/tareas";
import { useStore } from "../../state/store";
import type { TaskAssistDraft, TaskAssistField } from "../../lib/types";
import { FieldAssist } from "./FieldAssist";

/** Nombre legible para el texto alternativo: el archivo sin su extensión. */
export function altDeArchivo(name: string): string {
  const clean = name.replace(/\.[a-z0-9]+$/i, "").replace(/[\[\]]/g, "").trim();
  return clean || "Imagen";
}

function esImagen(file: File): boolean {
  return file.type.startsWith("image/");
}

export interface MarkdownFieldProps {
  id: string;
  value: string;
  onChange(value: string): void;
  /** Guardar al salir del campo (la ficha); el modal no lo usa. */
  onBlur?(): void;
  /** Ctrl/Cmd+S dentro del campo. */
  onCommit?(): void;
  label: string;
  placeholder?: string;
  rows?: number;
  testId?: string;
  /** Contenido a la izquierda de la barra: el título de la sección o la etiqueta. */
  header?: ReactNode;
  /** Aviso a la derecha del header (p. ej. "Guardando…"). */
  status?: ReactNode;
  textareaClassName?: string;
  /** Sin esto no se pintan los iconos de IA. */
  assist?: {
    field: TaskAssistField;
    draft: () => TaskAssistDraft;
    taskId?: string;
    showPrompt?: boolean;
  };
  /** Vista previa bajo el campo cuando hay contenido. */
  preview?: boolean;
}

export function MarkdownField({
  id,
  value,
  onChange,
  onBlur,
  onCommit,
  label,
  placeholder,
  rows = 5,
  testId,
  header,
  status,
  textareaClassName =
    "mt-2 min-h-24 w-full resize-y rounded-panel border border-transparent bg-transparent px-2 py-1.5 text-body leading-relaxed hover:border-line focus:border-link focus:bg-surface focus:outline-none focus:ring-2 focus:ring-link",
  assist,
  preview = true,
}: MarkdownFieldProps) {
  const pushToast = useStore((state) => state.pushToast);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** El valor más reciente, para encadenar varias imágenes sin perder ninguna. */
  const valueRef = useRef(value);
  valueRef.current = value;

  function escribir(fragmento: string): void {
    const textarea = textareaRef.current;
    const pos = textarea ? textarea.selectionStart : valueRef.current.length;
    const result = insertarEnCursor(valueRef.current, pos, fragmento);
    valueRef.current = result.value;
    onChange(result.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  async function subir(files: File[]): Promise<void> {
    const images = files.filter(esImagen);
    if (images.length === 0) return;
    setUploading(true);
    try {
      for (const file of images) {
        const uploaded = await api.uploadImage(file);
        escribir(`![${altDeArchivo(uploaded.name || file.name)}](${uploaded.url})`);
      }
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "No se pudo subir la imagen");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {header}
        <div className="ml-auto flex items-center gap-0.5">
          {uploading ? (
            <span className="mr-1 text-label text-muted" role="status" data-testid={`${testId ?? id}-subiendo`}>
              Subiendo…
            </span>
          ) : null}
          {status}
          <button
            type="button"
            data-testid={`${testId ?? id}-imagen`}
            aria-label="Añadir imagen"
            title="Añadir imagen (también puedes pegarla o soltarla aquí)"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="press inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-tight text-small text-faint hover:bg-surface-2 hover:text-link focus:outline-none focus:ring-2 focus:ring-link disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span aria-hidden="true">▧</span>
          </button>
          {assist ? (
            <FieldAssist
              field={assist.field}
              draft={assist.draft}
              {...(assist.taskId ? { taskId: assist.taskId } : {})}
              {...(assist.showPrompt === undefined ? {} : { showPrompt: assist.showPrompt })}
              onApply={(text) => {
                valueRef.current = text;
                onChange(text);
              }}
            />
          ) : null}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="sr-only"
        data-testid={`${testId ?? id}-file`}
        aria-label="Elegir imagen"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void subir(files);
        }}
      />

      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={id}
        data-testid={testId}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-busy={uploading}
        onChange={(event) => onChange(event.target.value)}
        {...(onBlur ? { onBlur } : {})}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onCommit?.();
          }
        }}
        onPaste={(event) => {
          // Sólo se intercepta si vienen imágenes: el texto y los enlaces se
          // pegan tal cual, que es lo que la gente espera.
          const files = [...(event.clipboardData?.files ?? [])].filter(esImagen);
          if (files.length === 0) return;
          event.preventDefault();
          void subir(files);
        }}
        onDragOver={(event) => {
          if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          const files = [...(event.dataTransfer?.files ?? [])].filter(esImagen);
          setDragging(false);
          if (files.length === 0) return;
          event.preventDefault();
          void subir(files);
        }}
        className={`${textareaClassName} ${dragging ? "border-link bg-link-bg" : ""}`}
      />

      {preview && value.trim() ? (
        <div className="mt-2 rounded-panel border border-line-soft bg-surface-2 p-3" aria-live="polite">
          <p className="text-label font-bold text-faint">Vista previa</p>
          <div className="mt-1 text-body">
            <Markdown>{value}</Markdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default MarkdownField;
