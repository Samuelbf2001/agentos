/** Reductor AG-UI: secuencia de eventos → estado correcto (spec de tests B5). */
import { describe, expect, it } from "vitest";
import { emptyEventState, reduceEvent, type EventState } from "../src/state/reducer";
import { domainEvent, makeTask, topicEvent } from "./helpers";

function run(state: EventState, evs: Parameters<typeof reduceEvent>[1][]) {
  let s = state;
  const effects = [];
  for (const ev of evs) {
    const out = reduceEvent(s, ev);
    s = out.state;
    effects.push(...out.effects);
  }
  return { state: s, effects };
}

describe("reductor AG-UI — streaming de texto en el hilo", () => {
  it("acumula TEXT_MESSAGE_CONTENT y cierra con END", () => {
    const base = emptyEventState();
    base.chat.threadId = "th-1";
    const { state } = run(base, [
      topicEvent("thread:th-1", 1, "TEXT_MESSAGE_START", { messageId: "m9" }, "r1"),
      topicEvent("thread:th-1", 2, "TEXT_MESSAGE_CONTENT", { messageId: "m9", delta: "Hola " }, "r1"),
      topicEvent("thread:th-1", 3, "TEXT_MESSAGE_CONTENT", { messageId: "m9", delta: "Ernesto" }, "r1"),
      topicEvent("thread:th-1", 4, "TEXT_MESSAGE_END", { messageId: "m9" }, "r1"),
    ]);
    expect(state.chat.streams["m9"]).toEqual({ text: "Hola Ernesto", done: true, runId: "r1" });
  });

  it("message.final persiste el mensaje y limpia el stream parcial", () => {
    const base = emptyEventState();
    base.chat.threadId = "th-1";
    const { state } = run(base, [
      topicEvent("thread:th-1", 1, "TEXT_MESSAGE_START", { messageId: "m9" }, "r1"),
      topicEvent("thread:th-1", 2, "TEXT_MESSAGE_CONTENT", { messageId: "m9", delta: "Hola" }, "r1"),
      domainEvent(
        "thread:th-1",
        3,
        "message.final",
        { thread_id: "th-1", message_id: "msg-final", run_id: "r1", role: "assistant", text: "Hola", final: true },
        "r1",
      ),
    ]);
    expect(state.chat.streams).toEqual({});
    expect(state.chat.messages).toHaveLength(1);
    expect(state.chat.messages[0]).toMatchObject({ id: "msg-final", role: "assistant", content: "Hola", runId: "r1" });
  });

  it("ignora eventos de un hilo que no es el abierto", () => {
    const base = emptyEventState();
    base.chat.threadId = "th-1";
    const { state } = run(base, [
      topicEvent("thread:OTRO", 1, "TEXT_MESSAGE_CONTENT", { messageId: "x", delta: "no" }),
    ]);
    expect(state.chat.streams).toEqual({});
  });
});

describe("reductor AG-UI — tool calls abiertas/cerradas", () => {
  it("TOOL_CALL_START/ARGS/END/RESULT construye el chip completo", () => {
    const { state } = run(emptyEventState(), [
      topicEvent("run:r1", 1, "TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "tasks.create" }),
      topicEvent("run:r1", 2, "TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"title":' }),
      topicEvent("run:r1", 3, "TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '"Mapa"}' }),
      topicEvent("run:r1", 4, "TOOL_CALL_END", { toolCallId: "tc1" }),
      topicEvent("run:r1", 5, "TOOL_CALL_RESULT", { toolCallId: "tc1", content: '{"ok":true}' }),
    ]);
    const chips = state.toolCalls["r1"]!;
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      id: "tc1",
      name: "tasks.create",
      args: '{"title":"Mapa"}',
      result: '{"ok":true}',
      done: true,
      isError: false,
    });
  });

  it("la tool activa marca fase usando_tool y el resultado vuelve a pensando", () => {
    const mid = run(emptyEventState(), [
      topicEvent("run:r1", 1, "RUN_STARTED", { runId: "r1", agentId: "a-alex" }),
      topicEvent("run:r1", 2, "TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "board.get" }),
    ]);
    expect(mid.state.runsLive["r1"]).toMatchObject({ phase: "usando_tool", currentTool: "board.get" });
    const done = run(mid.state, [
      topicEvent("run:r1", 3, "TOOL_CALL_RESULT", { toolCallId: "tc1", content: "{}" }),
    ]);
    expect(done.state.runsLive["r1"]).toMatchObject({ phase: "pensando", currentTool: null });
  });
});

describe("reductor AG-UI — fin de run", () => {
  it("RUN_FINISHED fija estado, usage y coste (null = no reportado)", () => {
    const { state } = run(emptyEventState(), [
      topicEvent("run:r1", 1, "RUN_STARTED", { runId: "r1", agentId: "a-alex", taskId: "t1" }),
      topicEvent("run:r1", 2, "RUN_FINISHED", {
        runId: "r1",
        usage: { tokensIn: 100, tokensOut: 40 },
        costUsd: null,
      }),
    ]);
    expect(state.runsLive["r1"]).toMatchObject({
      status: "succeeded",
      phase: null,
      agentId: "a-alex",
      tokensIn: 100,
      tokensOut: 40,
      costUsd: null,
    });
  });

  it("RUN_ERROR deja el run failed con mensaje legible", () => {
    const { state } = run(emptyEventState(), [
      topicEvent("run:r1", 1, "RUN_ERROR", { runId: "r1", message: "budget_exceeded", code: "budget_exceeded" }),
    ]);
    expect(state.runsLive["r1"]).toMatchObject({ status: "failed", error: "budget_exceeded" });
  });
});

describe("reductor — eventos de dominio del tablero", () => {
  it("task.moved parchea el estado local y pide refetch de la tarjeta", () => {
    const base = emptyEventState();
    base.board = { projectId: "proj-1", tasks: { t1: makeTask({ status: "READY" }) } };
    const { state, effects } = run(base, [
      domainEvent("board:proj-1", 1, "task.moved", { taskId: "t1", from: "READY", to: "IN_PROGRESS", actor: "agent:sam" }, "r9"),
    ]);
    expect(state.board.tasks["t1"]!.status).toBe("IN_PROGRESS");
    expect(effects).toContainEqual({ kind: "refetch_task", taskId: "t1" });
  });

  it("task.updated sustituye la tarjeta entera en el tablero montado y pide refetch de la ficha", () => {
    const base = emptyEventState();
    base.board = { projectId: "proj-1", tasks: { t1: makeTask({ title: "Vieja", priority: "low", version: 1 }) } };
    const nueva = makeTask({ title: "Nueva", priority: "high", version: 2 });
    const { state, effects } = run(base, [
      domainEvent("board:proj-1", 1, "task.updated", { task: nueva, actor: "person:ernesto" }),
    ]);
    expect(state.board.tasks["t1"]).toEqual(nueva);
    expect(effects).toContainEqual({ kind: "refetch_task", taskId: "t1" });
  });

  it("task.updated de una tarjeta que no está en el tablero montado no la añade pero sí relee la ficha", () => {
    const base = emptyEventState();
    base.board = { projectId: "proj-1", tasks: {} };
    const { state, effects } = run(base, [
      domainEvent("board:proj-2", 1, "task.updated", { task: makeTask({ id: "t-ajena" }) }),
    ]);
    expect(state.board.tasks["t-ajena"]).toBeUndefined();
    expect(effects).toContainEqual({ kind: "refetch_task", taskId: "t-ajena" });
  });

  it("task.created queda ligada a su run (enlace en el chat) y task.delegated crea arista", () => {
    const { state, effects } = run(emptyEventState(), [
      domainEvent("board:proj-1", 1, "task.created", { taskId: "t-nueva", status: "BACKLOG", actor: "agent:alex" }, "r-chat"),
      domainEvent(
        "board:proj-1",
        2,
        "task.delegated",
        { parentTaskId: "t0", childTaskId: "t-nueva", assignee: "sam", actor: "agent:alex" },
        "r-chat",
      ),
    ]);
    expect(state.createdTasks).toContainEqual(
      expect.objectContaining({ taskId: "t-nueva", runId: "r-chat" }),
    );
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({ from: "alex", to: "sam", taskId: "t-nueva" });
    expect(effects.filter((e) => e.kind === "refetch_task")).toHaveLength(2);
  });

  it("approval.requested dispara refetch de la bandeja y kill_switch.on enciende el banner", () => {
    const { state, effects } = run(emptyEventState(), [
      domainEvent("approvals", 1, "approval.requested", { approvalId: "ap-1", kind: "tool_call" }),
      domainEvent("swarm", 1, "kill_switch.on", { actor: "person:p1" }),
    ]);
    expect(effects).toContainEqual({ kind: "refetch_approvals" });
    expect(state.killSwitch).toBe(true);
  });
});
