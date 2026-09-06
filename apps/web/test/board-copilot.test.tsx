/**
 * Copiloto del tablero: un hilo determinista por proyecto (thread_hint
 * `board:<projectId>`) con el proyecto en el scope del run aunque la vista no
 * tenga proyecto activo; sin opts, sendChatMessage se comporta como antes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useStore } from "../src/state/store";
import BoardView from "../src/views/BoardView";
import { boardThreadHint, findBoardThread } from "../src/components/chat/BoardCopilotPanel";
import type { Thread } from "../src/lib/types";
import { makeMessage, makeTask, mockFetch, person, project, projectB, thread, type MockRoute } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = "/v1/channels/web/events";

const boardThread: Thread = {
  ...thread,
  id: "th-board",
  sessionKey: "web:p-ernesto:board:proj-1",
  projectId: "proj-1",
  title: "Tablero ACME",
};

const emptyChat = { threadId: null, messages: [], streams: {} };

function chatRoutes(threads: Thread[]): MockRoute[] {
  return [
    { path: "/api/threads", body: { threads } },
    {
      path: /^\/api\/threads\/[^/]+\/messages$/,
      body: ({ url }: { url: string }) => ({
        messages: url.includes("/th-board/")
          ? [makeMessage({ id: "m-b", threadId: "th-board", content: "Planifica el sprint" })]
          : [makeMessage()],
      }),
    },
    { path: /^\/api\/threads\/th-board$/, body: { thread: boardThread, last_seq: 2 } },
    {
      path: /^\/api\/threads\/[^/]+$/,
      body: ({ url }: { url: string }) => ({ thread: { ...thread, id: url.split("/").pop() }, last_seq: 0 }),
    },
    {
      method: "POST",
      path: EVENTS,
      // El servidor enruta por session_key: el hilo depende del hint.
      body: ({ body }: { body: unknown }) => {
        const hint = String((body as { thread_hint?: string }).thread_hint ?? "");
        return {
          deduped: false,
          thread_id: hint === "board:proj-1" ? "th-board" : `th-${hint.replace(/[^a-z0-9]/gi, "")}`,
          message_id: "m-new",
          run_id: null,
        };
      },
    },
    { path: /^\/api\/projects\/[^/]+\/launches$/, body: { launches: [] } },
    { path: /^\/api\/projects\/[^/]+\/phase-status$/, body: { status: { reason: "no_launch" } } },
  ];
}

function postCalls(calls: { url: string; method: string; body: unknown }[]) {
  return calls.filter((c) => c.method === "POST" && c.url.includes(EVENTS)).map((c) => c.body as Record<string, unknown>);
}

describe("sendChatMessage con opts (panel del tablero)", () => {
  beforeEach(() => {
    useStore.setState({ person, token: "tok", activeProjectId: null, threads: [], chat: emptyChat, chatSending: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda thread_hint determinista y project_id del panel aunque activeProjectId sea null", async () => {
    const { calls } = mockFetch(chatRoutes([]));
    await useStore.getState().sendChatMessage("Descompón esta iniciativa en tareas", {
      threadHint: boardThreadHint("proj-1"),
      projectId: "proj-1",
    });
    const [body] = postCalls(calls);
    expect(body).toMatchObject({
      external_user_id: "p-ernesto",
      external_chat_id: "p-ernesto",
      thread_hint: "board:proj-1",
      project_id: "proj-1",
      text: "Descompón esta iniciativa en tareas",
    });
    // El hilo que respondió el servidor queda abierto.
    expect(useStore.getState().chat.threadId).toBe("th-board");
  });

  it("opts.projectId manda sobre activeProjectId cuando la vista tiene otro proyecto", async () => {
    useStore.setState({ activeProjectId: projectB.id });
    const { calls } = mockFetch(chatRoutes([]));
    await useStore.getState().sendChatMessage("Asigna las tareas", {
      threadHint: boardThreadHint("proj-1"),
      projectId: "proj-1",
    });
    expect(postCalls(calls)[0]).toMatchObject({ thread_hint: "board:proj-1", project_id: "proj-1" });
  });

  it("sin opts conserva el comportamiento: hint aleatorio y sin project_id si no hay proyecto activo", async () => {
    const { calls } = mockFetch(chatRoutes([]));
    await useStore.getState().sendChatMessage("Hola Alex");
    const [body] = postCalls(calls);
    expect(body).toBeDefined();
    expect(String(body!.thread_hint)).toMatch(UUID);
    expect(body).not.toHaveProperty("project_id");
  });

  it("sin opts sigue mandando el proyecto activo de la vista", async () => {
    useStore.setState({ activeProjectId: projectB.id });
    const { calls } = mockFetch(chatRoutes([]));
    await useStore.getState().sendChatMessage("Hola Alex");
    expect(postCalls(calls)[0]).toMatchObject({ project_id: projectB.id });
  });
});

describe("findBoardThread", () => {
  it("encuentra el hilo cuya session_key termina en board:<projectId>", () => {
    expect(findBoardThread([thread, boardThread], "proj-1")?.id).toBe("th-board");
    expect(findBoardThread([thread, boardThread], "proj-2")).toBeUndefined();
  });
});

describe("Panel Copiloto en BoardView", () => {
  beforeEach(() => {
    useStore.setState({
      person,
      token: "tok",
      projects: [project, projectB],
      activeProjectId: project.id,
      people: [person],
      threads: [],
      chat: emptyChat,
      chatSending: false,
      board: { projectId: project.id, tasks: { t1: makeTask() } },
      boardLoading: false,
      boardError: null,
      toasts: [],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reabre el hilo existente cuyo sessionKey coincide con board:<projectId>", async () => {
    const { calls } = mockFetch(chatRoutes([thread, boardThread]));
    render(<BoardView projectId={project.id} />);
    expect(screen.queryByTestId("board-copilot")).toBeNull();

    fireEvent.click(screen.getByTestId("board-copilot-toggle"));
    expect(screen.getByTestId("board-copilot")).toBeTruthy();
    expect(screen.getByPlaceholderText("Pídele a Alex que planifique, descomponga o asigne…")).toBeTruthy();

    await waitFor(() => {
      expect(useStore.getState().chat.threadId).toBe("th-board");
    });
    expect(calls.some((c) => c.url.includes("/api/threads/th-board/messages"))).toBe(true);
    expect(await screen.findByText("Planifica el sprint")).toBeTruthy();
    // El tablero sigue ahí, al lado del panel.
    expect(screen.getByText("Mapear proceso de ventas")).toBeTruthy();
  });

  it("sin hilo previo deja el panel vacío y el primer envío lo crea con el hint del tablero", async () => {
    const { calls } = mockFetch(chatRoutes([thread]));
    render(<BoardView projectId={project.id} />);
    fireEvent.click(screen.getByTestId("board-copilot-toggle"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/threads?"))).toBe(true);
    });
    expect(useStore.getState().chat.threadId).toBeNull();
    expect(screen.getByText("Planifica con Alex")).toBeTruthy();

    const input = screen.getByTestId("board-copilot-input");
    fireEvent.change(input, { target: { value: "Descompón esta iniciativa en tareas y asígnalas" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(postCalls(calls)).toHaveLength(1);
    });
    expect(postCalls(calls)[0]).toMatchObject({ thread_hint: "board:proj-1", project_id: "proj-1" });
    await waitFor(() => {
      expect(useStore.getState().chat.threadId).toBe("th-board");
    });
  });

  it("al cambiar de proyecto con el panel abierto salta al hilo del nuevo proyecto", async () => {
    const { calls } = mockFetch(chatRoutes([thread, boardThread]));
    const { rerender } = render(<BoardView projectId={project.id} />);
    fireEvent.click(screen.getByTestId("board-copilot-toggle"));
    await waitFor(() => {
      expect(useStore.getState().chat.threadId).toBe("th-board");
    });

    useStore.setState({ activeProjectId: projectB.id, board: { projectId: projectB.id, tasks: {} } });
    rerender(<BoardView projectId={projectB.id} />);
    // proj-2 no tiene hilo de tablero: se vacía en vez de seguir en el de proj-1.
    await waitFor(() => {
      expect(useStore.getState().chat.threadId).toBeNull();
    });

    const input = screen.getByTestId("board-copilot-input");
    fireEvent.change(input, { target: { value: "Planifica este proyecto" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => {
      expect(postCalls(calls)).toHaveLength(1);
    });
    expect(postCalls(calls)[0]).toMatchObject({ thread_hint: "board:proj-2", project_id: "proj-2" });
  });

  it("el botón de cerrar retira el panel", async () => {
    mockFetch(chatRoutes([thread]));
    render(<BoardView projectId={project.id} />);
    fireEvent.click(screen.getByTestId("board-copilot-toggle"));
    expect(screen.getByTestId("board-copilot")).toBeTruthy();
    fireEvent.click(screen.getByTestId("board-copilot-close"));
    expect(screen.queryByTestId("board-copilot")).toBeNull();
    expect(screen.getByTestId("board-copilot-toggle").getAttribute("aria-pressed")).toBe("false");
  });
});
