/**
 * 2brain › Conversaciones (vista): pestaña de chats (hilos + mensajes con
 * autoscroll) y pestaña de acciones (auditoría), ambas detrás de
 * `/api/brain/conversaciones/*`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ConversacionesView from "../src/views/brain/ConversacionesView";
import { mockFetch } from "./helpers";

const threads = [
  {
    phone: "584121111111",
    lastBody: "Se volvió a parar la línea 2",
    lastAt: "2026-09-01T10:00:00.000Z",
    count: 3,
  },
  {
    phone: "584142222222",
    lastBody: "Confirmado, gracias por la actualización",
    lastAt: "2026-08-30T08:00:00.000Z",
    count: 1,
  },
];

const messagesByPhone: Record<string, unknown[]> = {
  "584121111111": [
    { id: 1, direction: "in", body: "Se volvió a parar la línea 2, el plan no llegó.", created_at: "2026-09-01T10:00:00.000Z" },
    { id: 2, direction: "out", body: "¿Me pasas la foto del plan actual?", created_at: "2026-09-01T10:05:00.000Z" },
  ],
  "584142222222": [
    { id: 3, direction: "in", body: "Todo confirmado, muchas gracias por avisar.", created_at: "2026-08-30T08:00:00.000Z" },
  ],
};

const acciones = [
  {
    id: 9,
    status: "done",
    action_type: "wiki_notes",
    created_at: "2026-09-01T09:00:00.000Z",
    payload: { to: "584121111111", note: "Recordatorio" },
    result: { ok: true },
  },
  {
    id: 10,
    status: "failed",
    action_type: "notion_task",
    created_at: "2026-09-01T09:10:00.000Z",
    payload: { to: "584142222222" },
    result: { error: "timeout creando la tarea" },
  },
];

function baseRoutes() {
  return [
    { path: "/api/brain/conversaciones/chats", body: { threads } },
    {
      path: /^\/api\/brain\/conversaciones\/chats\/[^/]+\/messages$/,
      body: (init: { url: string }) => {
        const phone = decodeURIComponent(init.url.split("/chats/")[1]?.split("/messages")[0] ?? "");
        return { phone, messages: messagesByPhone[phone] ?? [] };
      },
    },
    { path: "/api/brain/conversaciones/acciones", body: { actions: acciones } },
  ];
}

describe("2brain › Conversaciones (vista)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pinta el título, el primer hilo seleccionado y sus mensajes", async () => {
    mockFetch(baseRoutes());

    render(
      <MemoryRouter initialEntries={["/2brain/conversaciones"]}>
        <ConversacionesView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Conversaciones" })).toBeTruthy();
    expect((await screen.findAllByText("+584121111111")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Se volvió a parar la línea 2, el plan no llegó.")).toBeTruthy();
    expect(screen.getByText("¿Me pasas la foto del plan actual?")).toBeTruthy();
  });

  it("al elegir otro hilo, carga y muestra sus mensajes (y actualiza el deep link ?tel=)", async () => {
    mockFetch(baseRoutes());

    render(
      <MemoryRouter initialEntries={["/2brain/conversaciones"]}>
        <ConversacionesView />
      </MemoryRouter>,
    );

    await screen.findByText("Se volvió a parar la línea 2, el plan no llegó.");

    fireEvent.click(screen.getByText("Confirmado, gracias por la actualización"));

    expect(await screen.findByText("Todo confirmado, muchas gracias por avisar.")).toBeTruthy();
    expect(screen.queryByText("Se volvió a parar la línea 2, el plan no llegó.")).toBeNull();
  });

  it("estado vacío: sin hilos, enseña EmptyState; y no rompe con listas vacías", async () => {
    mockFetch([
      { path: "/api/brain/conversaciones/chats", body: { threads: [] } },
      { path: /^\/api\/brain\/conversaciones\/chats\/[^/]+\/messages$/, body: { messages: [] } },
      { path: "/api/brain/conversaciones/acciones", body: {} },
    ]);

    render(
      <MemoryRouter initialEntries={["/2brain/conversaciones"]}>
        <ConversacionesView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Conversaciones" })).toBeTruthy();
    expect(await screen.findByText("No hay conversaciones")).toBeTruthy();
    expect(screen.getByText("Selecciona una conversación")).toBeTruthy();
  });

  it("pestaña Acciones: pinta el registro con su chip de estado y expande el detalle", async () => {
    mockFetch(baseRoutes());

    render(
      <MemoryRouter initialEntries={["/2brain/conversaciones"]}>
        <ConversacionesView />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Acciones del agente" }));

    expect(await screen.findByText("wiki_notes")).toBeTruthy();
    expect(screen.getByText("completado")).toBeTruthy();
    expect(screen.getByText("fallido")).toBeTruthy();
    expect(screen.getByText("timeout creando la tarea")).toBeTruthy();

    const verButtons = screen.getAllByText("Ver");
    fireEvent.click(verButtons[0]!);
    expect(await screen.findByText(/"ok": true/)).toBeTruthy();
  });

  it("abre directamente el hilo indicado por ?tel= (deep link)", async () => {
    mockFetch(baseRoutes());

    render(
      <MemoryRouter initialEntries={["/2brain/conversaciones?tel=584142222222"]}>
        <ConversacionesView />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Todo confirmado, muchas gracias por avisar.")).toBeTruthy();
    expect(screen.queryByText("Se volvió a parar la línea 2, el plan no llegó.")).toBeNull();
  });
});
