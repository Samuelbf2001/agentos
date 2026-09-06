/**
 * Generative UI (handoff Trabajo A): el registro toolName → tarjeta cae al chip
 * genérico con tools desconocidas, tolera JSON parcial (args por deltas) y las
 * tarjetas de ask_human / tasks.move deciden con las acciones del store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useStore } from "../src/state/store";
import { renderToolCall, safeJson, tasksShownByRegistry } from "../src/components/generative/registry";
import type { ToolCallChip } from "../src/state/reducer";
import { agents, makeApproval, makeTask, mockFetch } from "./helpers";

function chip(overrides: Partial<ToolCallChip> = {}): ToolCallChip {
  return {
    id: "tc-1",
    name: "tool",
    args: "",
    result: null,
    isError: false,
    done: false,
    synthetic: false,
    ...overrides,
  };
}

function Harness({ chip: c }: { chip: ToolCallChip }) {
  return <div>{renderToolCall(c, "r1")}</div>;
}

describe("registro generativo", () => {
  beforeEach(() => {
    useStore.setState({
      approvals: [],
      reviewTasks: [],
      toasts: [],
      agents,
      board: { projectId: "proj-1", tasks: {} },
      taskDetail: null,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("safeJson devuelve null con JSON incompleto o vacío", () => {
    expect(safeJson('{"a":1')).toBeNull();
    expect(safeJson("")).toBeNull();
    expect(safeJson(null)).toBeNull();
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("tool desconocida → chip genérico", () => {
    render(<Harness chip={chip({ name: "knowledge.search", done: true, result: "[]" })} />);
    const generic = document.querySelector('[data-tool-chip="knowledge.search"]');
    expect(generic).not.toBeNull();
    expect(document.querySelector("[data-generative]")).toBeNull();
    expect(screen.getByText("ok")).toBeTruthy();
  });

  it("args parciales (streaming) no rompen: ask_human en curso cae al chip genérico", () => {
    render(<Harness chip={chip({ name: "ask_human", args: '{"kind":"question","title":"¿Seg' })} />);
    expect(document.querySelector('[data-tool-chip="ask_human"]')).not.toBeNull();
    expect(screen.getByText("ejecutando…")).toBeTruthy();
    expect(screen.queryByText("✓ Aprobar")).toBeNull();
  });

  it("tasks.move con resultado a medias cae al chip genérico", () => {
    render(
      <Harness chip={chip({ name: "tasks.move", done: true, args: '{"task_id":"t1","to":"REVIEW"}', result: '{"id":"t1","sta' })} />,
    );
    expect(document.querySelector('[data-tool-chip="tasks.move"]')).not.toBeNull();
  });

  it("ask_human pendiente: Aprobar → POST /api/approvals/:id/decide y pasa a Resuelta", async () => {
    useStore.setState({ approvals: [makeApproval({ id: "ap-9", kind: "deliverable" })] });
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/approvals/ap-9/decide",
        body: { approval: makeApproval({ id: "ap-9", status: "approved" }), executed: null, resume_run_id: null },
      },
    ]);
    render(
      <Harness
        chip={chip({
          name: "ask_human",
          done: true,
          args: JSON.stringify({ kind: "question", title: "¿Seguimos con ACME?", body: "Falta el OK del cliente", task_id: "t1" }),
          result: JSON.stringify({ status: "pending_approval", approval_id: "ap-9" }),
        })}
      />,
    );
    expect(screen.getByText("Pregunta para ti: ¿Seguimos con ACME?")).toBeTruthy();
    expect(screen.getByText("Falta el OK del cliente")).toBeTruthy();
    fireEvent.click(screen.getByText("✓ Aprobar"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/approvals/ap-9/decide"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/api/approvals/ap-9/decide"));
    expect(call?.body).toEqual({ decision: "approved" });
    await waitFor(() => {
      expect(screen.getByText("Resuelta")).toBeTruthy();
    });
    expect(screen.queryByText("✓ Aprobar")).toBeNull();
  });

  it("ask_human ya decidida (no está en approvals) → Resuelta sin botones", () => {
    render(
      <Harness
        chip={chip({
          name: "ask_human",
          done: true,
          args: JSON.stringify({ kind: "deliverable", title: "Entrega", body: "x" }),
          result: JSON.stringify({ status: "pending_approval", approval_id: "ap-old" }),
        })}
      />,
    );
    expect(screen.getByText("Resuelta")).toBeTruthy();
    expect(screen.queryByText("✓ Aprobar")).toBeNull();
  });

  it("tasks.move a REVIEW: Aprobar → POST /api/tasks/:id/approve con expected_version del store", async () => {
    const task = makeTask({ id: "t-rev", status: "REVIEW", requiresApproval: true, version: 7 });
    useStore.setState({ board: { projectId: "proj-1", tasks: { [task.id]: task } } });
    const { calls } = mockFetch([
      { method: "POST", path: "/api/tasks/t-rev/approve", body: { task: { ...task, status: "DONE", version: 8 } } },
      { method: "GET", path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
    ]);
    render(
      <Harness
        chip={chip({
          name: "tasks.move",
          done: true,
          args: JSON.stringify({ task_id: "t-rev", to: "REVIEW", expected_version: 6 }),
          result: JSON.stringify(task),
        })}
      />,
    );
    expect(screen.getByText("En revisión: Mapear proceso de ventas")).toBeTruthy();
    fireEvent.click(screen.getByText("✓ Aprobar"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/tasks/t-rev/approve"))).toBe(true);
    });
    const call = calls.find((c) => c.url.includes("/api/tasks/t-rev/approve"));
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ expected_version: 7 });
  });

  it("tasks.move: el estado vivo del tablero manda (ya no está en REVIEW → sin botones)", () => {
    const task = makeTask({ id: "t-rev", status: "DONE", version: 8 });
    useStore.setState({ board: { projectId: "proj-1", tasks: { [task.id]: task } } });
    render(
      <Harness
        chip={chip({
          name: "tasks.move",
          done: true,
          args: JSON.stringify({ task_id: "t-rev", to: "REVIEW", expected_version: 6 }),
          result: JSON.stringify({ ...task, status: "REVIEW", version: 7 }),
        })}
      />,
    );
    expect(screen.getByText("Movida a")).toBeTruthy();
    expect(screen.getByText("Terminada")).toBeTruthy();
    expect(screen.queryByText("✓ Aprobar")).toBeNull();
  });

  it("tasks.move a REVIEW con rechazo exige nota y llama a /reject", async () => {
    const task = makeTask({ id: "t-rev", status: "REVIEW", version: 7 });
    useStore.setState({ board: { projectId: "proj-1", tasks: { [task.id]: task } } });
    const { calls } = mockFetch([
      { method: "POST", path: "/api/tasks/t-rev/reject", body: { task: { ...task, status: "IN_PROGRESS", version: 8 } } },
      { method: "GET", path: "/api/waiting", body: { approvals: [], review_tasks: [] } },
    ]);
    render(<Harness chip={chip({ name: "tasks.move", done: true, args: "{}", result: JSON.stringify(task) })} />);
    fireEvent.click(screen.getByText("✕ Rechazar"));
    const confirm = screen.getByText("Confirmar rechazo") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Nota de rechazo"), { target: { value: "Falta el SIPOC" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/tasks/t-rev/reject"))).toBe(true);
    });
    expect(calls.find((c) => c.url.includes("/reject"))?.body).toEqual({ expected_version: 7, note: "Falta el SIPOC" });
  });

  it("delegate y tasks.create pintan la tarea hija y la excluyen de createdTasks", () => {
    const child = makeTask({ id: "t-child", title: "Entrevistar a compras", assigneeAgentId: "a-sam", status: "READY" });
    const chips = [
      chip({
        id: "tc-d",
        name: "delegate",
        done: true,
        args: JSON.stringify({ tarea: "Entrevistar a compras", limites: "1h", forma_de_buena_respuesta: "acta", assignee: "sam" }),
        result: JSON.stringify(child),
      }),
      chip({ id: "tc-c", name: "tasks.create", done: true, args: "{}", result: JSON.stringify(makeTask({ id: "t-new", title: "Nueva" })) }),
    ];
    render(<div>{chips.map((c) => renderToolCall(c, "r1"))}</div>);
    expect(screen.getByText("Delegada a Sam")).toBeTruthy();
    expect(screen.getByText("Entrevistar a compras")).toBeTruthy();
    expect(screen.getByText("Tarea creada")).toBeTruthy();
    expect(screen.getByText("Nueva")).toBeTruthy();
    expect([...tasksShownByRegistry(chips)].sort()).toEqual(["t-child", "t-new"]);
  });
});
