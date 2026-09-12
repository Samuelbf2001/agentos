/**
 * 2brain › Videos (vista): cola con miniatura/estado, ingesta por URL,
 * salud del microservicio y detalle por deep link (`?job=`) con
 * transcripción/análisis. `mockFetch` por rutas, sin store global (esta
 * vista usa hooks locales).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import VideosView from "../src/views/brain/VideosView";
import { mockFetch, type MockRoute } from "./helpers";

const jobDone = {
  id: "youtube-abc123",
  title: "Cómo mapear un proceso",
  platform: "youtube",
  url: "https://www.youtube.com/watch?v=abc123",
  duration: "12:34",
  date: "2026-09-01T10:00:00.000Z",
  status: "completed",
  error_count: 0,
  errors: [],
  thumbnail_url: "/api/brain/videos/files/youtube-abc123/thumbnail.jpg",
  keyframe_urls: ["/api/brain/videos/files/youtube-abc123/keyframes/frame-000.jpg"],
};

const healthOk = { ok: true, reachable: true };

function ui(path = "/2brain/videos") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <VideosView />
    </MemoryRouter>,
  );
}

describe("2brain › Videos (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pinta la cola con miniatura, plataforma y estado, y el chip de salud", async () => {
    mockFetch([
      { path: "/api/brain/videos/jobs", body: { jobs: [jobDone] } },
      { path: "/api/brain/videos/health", body: healthOk },
    ]);
    ui();

    expect(await screen.findByRole("heading", { level: 1, name: "Videos" })).toBeTruthy();
    expect(await screen.findByText("Cómo mapear un proceso")).toBeTruthy();
    expect(screen.getByText("youtube")).toBeTruthy();
    expect(screen.getByText("Completada")).toBeTruthy();
    expect(await screen.findByText("Servicio activo")).toBeTruthy();
  });

  it("estado vacío cuando no hay videos todavía", async () => {
    mockFetch([
      { path: "/api/brain/videos/jobs", body: { jobs: [] } },
      { path: "/api/brain/videos/health", body: { ok: false, reachable: false } },
    ]);
    ui();

    expect(await screen.findByText("Aún no hay videos")).toBeTruthy();
    expect(await screen.findByText("Sin respuesta")).toBeTruthy();
  });

  it("tolera que el hub responda vacío ({}), sin romper el render (smoke global)", async () => {
    mockFetch([
      { path: "/api/brain/videos/jobs", body: {} },
      { path: "/api/brain/videos/health", body: {} },
    ]);
    ui();

    expect(await screen.findByRole("heading", { level: 1, name: "Videos" })).toBeTruthy();
    expect(await screen.findByText("Aún no hay videos")).toBeTruthy();
  });

  it("ingerir una URL: llama a la API y refresca la lista", async () => {
    let jobsCall = 0;
    const routes: MockRoute[] = [
      {
        path: "/api/brain/videos/jobs",
        body: () => {
          jobsCall += 1;
          return { jobs: jobsCall === 1 ? [] : [jobDone] };
        },
      },
      { path: "/api/brain/videos/health", body: healthOk },
      {
        path: "/api/brain/videos/ingest",
        method: "POST",
        status: 202,
        body: { id: "job-12345-abcd", status: "queued" },
      },
    ];
    const { calls } = mockFetch(routes);
    ui();

    expect(await screen.findByText("Aún no hay videos")).toBeTruthy();

    const input = screen.getByLabelText("URL del video a ingerir");
    fireEvent.change(input, { target: { value: "https://www.youtube.com/watch?v=abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingerir" }));

    expect(await screen.findByText("Cómo mapear un proceso")).toBeTruthy();
    const ingestCall = calls.find((c) => c.url.includes("/api/brain/videos/ingest"));
    expect(ingestCall?.method).toBe("POST");
    expect(ingestCall?.body).toEqual({ url: "https://www.youtube.com/watch?v=abc123" });
  });

  it("detalle por deep link ?job=: transcripción y análisis", async () => {
    mockFetch([
      { path: "/api/brain/videos/jobs", body: { jobs: [jobDone] } },
      { path: "/api/brain/videos/health", body: healthOk },
      { path: /^\/api\/brain\/videos\/jobs\/youtube-abc123$/, body: { job: jobDone } },
      {
        path: /^\/api\/brain\/videos\/jobs\/youtube-abc123\/transcript$/,
        body: { markdown: "# Transcripción\n\nHola mundo." },
      },
      {
        path: /^\/api\/brain\/videos\/jobs\/youtube-abc123\/analysis$/,
        body: { markdown: "# Análisis\n\nResumen del video." },
      },
    ]);
    ui("/2brain/videos?job=youtube-abc123");

    expect(
      await screen.findByRole("heading", { level: 2, name: "Cómo mapear un proceso" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Hola mundo\./)).toBeTruthy();
    });
    expect(screen.getByText(/Resumen del video\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver el video original" }).getAttribute("href")).toBe(
      jobDone.url,
    );
  });

  it("detalle: video que no aparece en la cola muestra el error, no rompe la vista", async () => {
    mockFetch([
      { path: "/api/brain/videos/jobs", body: { jobs: [] } },
      { path: "/api/brain/videos/health", body: healthOk },
      { path: /^\/api\/brain\/videos\/jobs\/no-existe$/, status: 404, body: { error: { code: "not_found", message: "Job no encontrado" } } },
    ]);
    ui("/2brain/videos?job=no-existe");

    expect(await screen.findByText("Job no encontrado")).toBeTruthy();
  });
});
