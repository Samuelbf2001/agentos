/**
 * Lógica de la Grabadora, portada de WhatsAppHub (`web/src/pages/recorder`):
 * `MediaRecorder` con negociación de mimetype, vúmetro con `AudioContext`,
 * `SpeechRecognition` opcional (es-ES) como vista previa en vivo, `wakeLock`
 * mientras se graba, fotos reducidas a 1600px/JPEG 0.82 (máx 10) y borrador en
 * `localStorage`. Se elimina el panel de configuración de backend/clave: la
 * sesión de AgentOS ya autentica, y esta vista manda siempre a
 * `/api/brain/notas-voz/voice` con `source: "agentos"`.
 *
 * Separado de la vista para poder testearlo sin micrófono: jsdom no tiene
 * `MediaRecorder` ni `getUserMedia`, así que `soportado` sale en `false` y el
 * resto del hook (borrador, envío, fotos) sigue siendo ejercitable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../lib/api";
import { enviarNotaVoz, type NotaVozEnvio, type NotaVozResultado } from "../../../lib/brain/notas-voz";

const DRAFT_KEY = "agentos_rec_draft";
const MAX_PHOTOS = 10;
const MAX_DIM = 1600;
const JPEG_Q = 0.82;

export type EstadoTono = "" | "live" | "error";

export interface Foto {
  dataUrl: string;
  mimetype: string;
}

interface Borrador {
  transcript: string;
  durationSec: number;
  audioBase64: string | null;
  mimetype: string | null;
  ts: number;
}

export interface Banner {
  text: string;
  actionLabel?: string;
  type: "warn" | "info";
  onAction?: () => void;
}

/** API experimental sin tipos en lib.dom: se declara lo mínimo que se usa. */
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { [i: number]: { [j: number]: { transcript: string }; isFinal: boolean }; length: number };
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function leerBorrador(): Borrador | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Borrador;
  } catch {
    return null;
  }
}

function guardarBorrador(b: Omit<Borrador, "ts">): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...b, ts: Date.now() }));
  } catch {
    /* almacenamiento no disponible: la nota queda solo en memoria */
  }
}

function borrarBorrador(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function fmtTiempo(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el audio grabado"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function elegirMediaRecorder(stream: MediaStream): MediaRecorder {
  const tipos = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg"];
  for (const tipo of tipos) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(tipo)) return new MediaRecorder(stream, { mimeType: tipo });
    } catch {
      /* el navegador no reconoce el tipo: se prueba el siguiente */
    }
  }
  return new MediaRecorder(stream);
}

function downscaleImagen(file: File): Promise<Foto | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width;
      let h = img.height;
      if (Math.max(w, h) > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", JPEG_Q), mimetype: "image/jpeg" });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** jsdom (tests) nunca tiene `MediaRecorder`/`getUserMedia`: se degrada a solo fotos/texto. */
function micDisponible(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function useGrabadora() {
  const soportado = useRef(micDisponible()).current;

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timerText, setTimerText] = useState("00:00");
  const [stateText, setStateText] = useState(
    soportado ? "Toca para grabar" : "Micrófono no disponible en este dispositivo: puedes enviar fotos.",
  );
  const [stateKind, setStateKind] = useState<EstadoTono>(soportado ? "" : "error");
  const [meterLevel, setMeterLevel] = useState(0);
  const [meterOn, setMeterOn] = useState(false);
  const [finalTxt, setFinalTxt] = useState("");
  const [interimTxt, setInterimTxt] = useState("");
  const [photos, setPhotos] = useState<Foto[]>([]);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [resultado, setResultado] = useState<NotaVozResultado | null>(null);
  const [mostrarResultado, setMostrarResultado] = useState(false);

  const recordingRef = useRef(false);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);
  const t0Ref = useRef(0);
  const elapsedBefore = useRef(0);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const restartGuard = useRef(0);

  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRAF = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerInt = useRef<ReturnType<typeof setInterval> | null>(null);
  const photosRef = useRef<Foto[]>([]);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  function actualizarEstado(text: string, kind: EstadoTono = "") {
    setStateText(text);
    setStateKind(kind);
  }

  const elapsedSec = useCallback(
    () => Math.floor((elapsedBefore.current + (t0Ref.current ? Date.now() - t0Ref.current : 0)) / 1000),
    [],
  );

  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        wakeLockRef.current.addEventListener("release", () => {
          wakeLockRef.current = null;
        });
      }
    } catch {
      /* sin wake lock: la pantalla puede apagarse, pero la grabación sigue */
    }
  }
  function releaseWakeLock() {
    try {
      void wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  }

  function startMeter(stream: MediaStream) {
    try {
      const AC = window.AudioContext;
      if (!AC) return;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      setMeterOn(true);
      const loop = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i]!;
        setMeterLevel(Math.min(100, Math.round((sum / data.length / 140) * 100) + 2));
        meterRAF.current = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* sin vúmetro: la grabación no depende de él */
    }
  }
  function stopMeter() {
    if (meterRAF.current !== null) cancelAnimationFrame(meterRAF.current);
    meterRAF.current = null;
    analyserRef.current = null;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
    setMeterOn(false);
    setMeterLevel(0);
  }

  function startRecognition() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const recog = new Ctor();
    recogRef.current = recog;
    recog.lang = "es-ES";
    recog.continuous = true;
    recog.interimResults = true;
    recog.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i]!;
        const transcript = item[0]?.transcript ?? "";
        if (item.isFinal) finalRef.current += `${transcript} `;
        else interim += transcript;
      }
      interimRef.current = interim;
      setFinalTxt(finalRef.current);
      setInterimTxt(interim);
    };
    recog.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        actualizarEstado("Permiso de micrófono denegado", "error");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        actualizarEstado("Vista previa de texto falló — el audio se transcribirá en el servidor", "live");
      }
    };
    recog.onend = () => {
      if (!recordingRef.current || pausedRef.current) return;
      const now = Date.now();
      if (now - restartGuard.current < 400) return;
      restartGuard.current = now;
      try {
        recog.start();
      } catch {
        /* ignore */
      }
    };
    try {
      recog.start();
    } catch {
      /* ignore */
    }
  }
  function stopRecognition() {
    if (!recogRef.current) return;
    try {
      recogRef.current.onend = null;
      recogRef.current.stop();
    } catch {
      /* ignore */
    }
  }

  const enviar = useCallback(async (payload: NotaVozEnvio) => {
    setBusy(true);
    actualizarEstado("Subiendo y procesando…");
    try {
      const data = await enviarNotaVoz(payload);
      borrarBorrador();
      setBanner(null);
      setPhotos([]);
      setResultado(data);
      setMostrarResultado(true);
      actualizarEstado("Toca para grabar");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sin conexión con el servidor";
      actualizarEstado(`${message} — borrador guardado`, "error");
      setBanner({
        text: "No se pudo enviar la nota (quedó guardada como borrador).",
        actionLabel: "Reintentar envío",
        type: "warn",
        onAction: () => {
          setBanner(null);
          void enviar(payload);
        },
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const iniciar = useCallback(async () => {
    if (busyRef.current || recordingRef.current) return;
    if (!soportado) {
      actualizarEstado("Este dispositivo no tiene micrófono disponible.", "error");
      return;
    }
    setBanner(null);
    finalRef.current = "";
    interimRef.current = "";
    chunksRef.current = [];
    setFinalTxt("");
    setInterimTxt("");
    elapsedBefore.current = 0;

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const denied = err instanceof Error && (err.name === "NotAllowedError" || err.name === "SecurityError");
      actualizarEstado(denied ? "Permiso de micrófono denegado" : "No se pudo acceder al micrófono", "error");
      return;
    }

    pausedRef.current = false;
    setPaused(false);
    recordingRef.current = true;
    setRecording(true);
    t0Ref.current = Date.now();
    const tick = () => setTimerText(fmtTiempo(elapsedSec()));
    tick();
    timerInt.current = setInterval(tick, 500);
    void acquireWakeLock();

    try {
      const mr = elegirMediaRecorder(streamRef.current);
      mediaRecRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.start(1000);
      startMeter(streamRef.current);
    } catch {
      /* sin MediaRecorder utilizable: el resto sigue (vista previa, timer) */
    }

    if (speechRecognitionCtor()) {
      actualizarEstado("Escuchando…", "live");
      startRecognition();
    } else {
      actualizarEstado("Grabando audio… (se transcribe en el servidor)", "live");
      setFinalTxt("(Transcripción en el dispositivo no disponible — se transcribirá en el servidor)");
    }
  }, [elapsedSec, soportado]);

  const pausar = useCallback(() => {
    if (!recordingRef.current || pausedRef.current || busyRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    if (timerInt.current) clearInterval(timerInt.current);
    timerInt.current = null;
    elapsedBefore.current = elapsedSec();
    t0Ref.current = 0;
    try {
      if (mediaRecRef.current?.state === "recording") mediaRecRef.current.pause();
    } catch {
      /* ignore */
    }
    stopMeter();
    stopRecognition();
    actualizarEstado("En pausa — toca Reanudar para seguir");
  }, [elapsedSec]);

  const reanudar = useCallback(() => {
    if (!recordingRef.current || !pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    t0Ref.current = Date.now();
    const tick = () => setTimerText(fmtTiempo(elapsedSec()));
    tick();
    timerInt.current = setInterval(tick, 500);
    try {
      if (mediaRecRef.current?.state === "paused") mediaRecRef.current.resume();
    } catch {
      /* ignore */
    }
    if (streamRef.current) startMeter(streamRef.current);
    if (speechRecognitionCtor()) {
      actualizarEstado("Escuchando…", "live");
      startRecognition();
    } else {
      actualizarEstado("Grabando audio… (se transcribe en el servidor)", "live");
    }
  }, [elapsedSec]);

  const detener = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    pausedRef.current = false;
    setPaused(false);
    if (timerInt.current) clearInterval(timerInt.current);
    timerInt.current = null;
    actualizarEstado("Procesando…");
    releaseWakeLock();
    stopRecognition();
    stopMeter();

    let audioBase64: string | null = null;
    let mimetype: string | null = null;
    const recorder = mediaRecRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          recorder.stop();
        });
      } catch {
        /* ignore */
      }
      if (chunksRef.current.length > 0) {
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          mimetype = blob.type;
          audioBase64 = await blobToDataUrl(blob);
        } catch {
          /* sin audio: puede seguir con transcripción en vivo o fotos */
        }
      }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    const transcript = (finalRef.current + interimRef.current).trim();
    const durationSec = elapsedSec();
    t0Ref.current = 0;

    if (!transcript && !audioBase64 && photosRef.current.length === 0) {
      actualizarEstado("No se captó nada. Intenta de nuevo.", "error");
      return;
    }
    guardarBorrador({ transcript, durationSec, audioBase64, mimetype });
    await enviar({
      transcript,
      durationSec,
      audioBase64,
      mimetype,
      images: photosRef.current.map((p) => ({ dataUrl: p.dataUrl })),
    });
  }, [elapsedSec, enviar]);

  const onFotos = useCallback(async (files: FileList | File[]) => {
    const lista = Array.from(files);
    const siguiente = [...photosRef.current];
    for (const file of lista) {
      if (siguiente.length >= MAX_PHOTOS) break;
      if (!/^image\//.test(file.type)) continue;
      const foto = await downscaleImagen(file);
      if (foto) siguiente.push(foto);
    }
    setPhotos(siguiente);
  }, []);

  const quitarFoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const enviarSoloFotos = useCallback(async () => {
    if (busyRef.current || recordingRef.current || photosRef.current.length === 0) return;
    await enviar({
      transcript: "",
      durationSec: 0,
      audioBase64: null,
      mimetype: null,
      images: photosRef.current.map((p) => ({ dataUrl: p.dataUrl })),
    });
  }, [enviar]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Borrador de una sesión anterior: se ofrece reenviarlo, nunca se pierde en silencio.
  useEffect(() => {
    const draft = leerBorrador();
    if (draft && (draft.transcript || draft.audioBase64)) {
      const cuando = draft.ts ? new Date(draft.ts).toLocaleTimeString() : "";
      setBanner({
        text: `Tienes una nota sin enviar de una sesión anterior${cuando ? ` (${cuando})` : ""}.`,
        actionLabel: "Enviar ahora",
        type: "warn",
        onAction: () => {
          setBanner(null);
          void enviar({
            transcript: draft.transcript,
            durationSec: draft.durationSec,
            audioBase64: draft.audioBase64,
            mimetype: draft.mimetype,
            images: [],
          });
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Salir de la vista con la grabación viva no puede dejar el micrófono abierto.
  useEffect(
    () => () => {
      if (timerInt.current) clearInterval(timerInt.current);
      stopMeter();
      stopRecognition();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      releaseWakeLock();
    },
    [],
  );

  return {
    soportado,
    recording,
    paused,
    busy,
    timerText,
    stateText,
    stateKind,
    meterLevel,
    meterOn,
    finalTxt,
    interimTxt,
    photos,
    banner,
    resultado,
    mostrarResultado,
    iniciar,
    pausar,
    reanudar,
    detener,
    onFotos,
    quitarFoto,
    enviarSoloFotos,
    cerrarResultado: () => setMostrarResultado(false),
    descartarBanner: () => setBanner(null),
  };
}

export type UseGrabadora = ReturnType<typeof useGrabadora>;
