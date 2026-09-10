/**
 * El lienzo de Excalidraw, aislado en su propio módulo por dos razones:
 *
 * 1. **Peso**: `@excalidraw/excalidraw` (y su CSS) es la dependencia más
 *    grande de la app. `NotasView` lo carga con `React.lazy`, así que no entra
 *    en el bundle inicial de nadie que no abra /notas.
 * 2. **Frontera**: aquí dentro vive TODO lo que sabe de Excalidraw —incluida
 *    la exportación a PNG—. La vista sólo habla con `LienzoHandle`, y los
 *    tests montan un doble de este archivo sin cargar la librería real.
 *
 * La exportación NO es un pantallazo del viewport: `exportToBlob` dibuja los
 * elementos de la escena en un canvas propio, recortado a su contenido.
 */
import { useCallback, useRef } from "react";
import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { CanvasScene, TranscripcionBloque } from "../../lib/types";
import { sinTranscripcionPrevia, skeletonsTranscripcion } from "./transcripcion-elementos";
import { cajaDeEscena, escalaDeExportacion, type CajaEscena } from "./export-scale";

/** Escala del PNG exportado: 3× para que la letra manuscrita se lea al transcribir. */
export const EXPORT_SCALE = 3;
/** Margen alrededor del contenido, en px de escena. */
export const EXPORT_PADDING = 24;

export interface LienzoHandle {
  /** Escena actual, ya reducida a lo que se persiste. */
  getScene(): CanvasScene;
  /** PNG limpio: fondo blanco, sin la interfaz, recortado al contenido. */
  exportarPng(): Promise<Blob>;
  /** ¿Hay algo dibujado? Terminar una nota vacía no tiene sentido. */
  estaVacio(): boolean;
  /**
   * Pone el texto leído DEBAJO de cada región de trazos, en gris y marcado
   * (`customData.agentos.transcripcion`). Repetirlo reemplaza el texto
   * anterior; los trazos no se tocan nunca. Devuelve cuántos textos puso y
   * avisa por `onSceneChange` para que la vista autoguarde.
   */
  insertarTranscripcion(bloques: readonly TranscripcionBloque[], alturaTipica: number): number;
}

export interface LienzoProps {
  initialScene: CanvasScene;
  /** Cada trazo. La vista lo amortigua antes de guardar. */
  onSceneChange(scene: CanvasScene): void;
  onReady(handle: LienzoHandle): void;
  theme?: "light" | "dark";
}

/**
 * De todo `appState` sólo se guarda lo que hace falta para reabrir la nota
 * igual. El resto (colaboradores, punteros, selección) es efímero y además
 * trae estructuras que no son JSON.
 */
function persistableAppState(appState: Record<string, unknown>): Record<string, unknown> {
  return {
    viewBackgroundColor: appState["viewBackgroundColor"] ?? "#ffffff",
    gridSize: appState["gridSize"] ?? null,
    currentItemStrokeColor: appState["currentItemStrokeColor"],
    currentItemStrokeWidth: appState["currentItemStrokeWidth"],
  };
}

export default function Lienzo({ initialScene, onSceneChange, onReady, theme = "light" }: LienzoProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      const getScene = (): CanvasScene => ({
        elements: api.getSceneElements() as readonly unknown[],
        appState: persistableAppState(api.getAppState() as unknown as Record<string, unknown>),
        files: api.getFiles() as unknown as Record<string, unknown>,
      });
      const handle: LienzoHandle = {
        getScene,
        estaVacio: () => api.getSceneElements().length === 0,
        insertarTranscripcion: (bloques, alturaTipica) => {
          const conservados = sinTranscripcionPrevia(api.getSceneElements());
          const nuevos = convertToExcalidrawElements(
            skeletonsTranscripcion(bloques, alturaTipica),
            { regenerateIds: true },
          );
          api.updateScene({
            elements: [...conservados, ...nuevos],
            // Un paso deshacible: Ctrl+Z quita el texto y deja el trazo.
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          // Excalidraw avisa por `onChange`, pero se fuerza aquí para que el
          // autoguardado no dependa de cuándo repinte.
          onSceneChange(getScene());
          return nuevos.length;
        },
        exportarPng: async () =>
          await exportToBlob({
            elements: api.getSceneElements(),
            appState: {
              ...api.getAppState(),
              // PNG limpio: fondo blanco opaco, nunca el tema oscuro de la app
              // ni la interfaz del lienzo.
              exportBackground: true,
              viewBackgroundColor: "#ffffff",
              exportWithDarkMode: false,
              // La escala baja con el tamaño de la escena para que el PNG no
              // supere ~4000 px de lado (una nota grande a 3x daba 413).
              exportScale: escalaDeExportacion(
                cajaDeEscena(api.getSceneElements() as readonly CajaEscena[]),
                EXPORT_PADDING,
              ),
              exportEmbedScene: false,
            },
            files: api.getFiles(),
            mimeType: "image/png",
            quality: 1,
            exportPadding: EXPORT_PADDING,
          }),
      };
      onReady(handle);
    },
    [onReady],
  );

  const handleChange = useCallback(
    (
      elements: readonly unknown[],
      appState: unknown,
      files: unknown,
    ) => {
      onSceneChange({
        elements,
        appState: persistableAppState(appState as Record<string, unknown>),
        files: files as Record<string, unknown>,
      });
    },
    [onSceneChange],
  );

  return (
    <div className="h-full w-full" data-testid="lienzo-excalidraw">
      <Excalidraw
        theme={theme}
        initialData={{
          elements: initialScene.elements as never,
          appState: {
            ...(initialScene.appState ?? {}),
            viewBackgroundColor: "#ffffff",
          } as never,
          files: (initialScene.files ?? {}) as never,
          scrollToContent: true,
        }}
        onChange={handleChange}
        excalidrawAPI={handleApi}
        langCode="es-ES"
      />
    </div>
  );
}
