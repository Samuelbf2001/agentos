/** Bandeja: decidir approve dispara el POST correcto y saca el item de la lista. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../src/state/store";
import { makeApproval, mockFetch } from "./helpers";

describe("decideApproval", () => {
  beforeEach(() => {
    useStore.setState({ approvals: [makeApproval(), makeApproval({ id: "ap-2" })], toasts: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("approve → POST /api/approvals/:id/decide y el item sale de la bandeja", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/approvals/ap-1/decide",
        body: {
          approval: makeApproval({ status: "approved" }),
          executed: { status: "ok" },
          resume_run_id: "r-resume",
        },
      },
    ]);
    await useStore.getState().decideApproval("ap-1", "approved");
    const call = calls.find((c) => c.url.includes("/api/approvals/ap-1/decide"));
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ decision: "approved" });
    expect(useStore.getState().approvals.map((a) => a.id)).toEqual(["ap-2"]);
  });

  it("reject con nota manda la nota y también saca el item", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        path: "/api/approvals/ap-2/decide",
        body: { approval: makeApproval({ id: "ap-2", status: "rejected" }), executed: null, resume_run_id: null },
      },
    ]);
    await useStore.getState().decideApproval("ap-2", "rejected", "no mandes ese email");
    const call = calls.find((c) => c.url.includes("/api/approvals/ap-2/decide"));
    expect(call?.body).toEqual({ decision: "rejected", note: "no mandes ese email" });
    expect(useStore.getState().approvals.map((a) => a.id)).toEqual(["ap-1"]);
  });

  it("si la API falla, la bandeja se recarga (no se pierde el item)", async () => {
    mockFetch([
      {
        method: "POST",
        path: "/api/approvals/ap-1/decide",
        status: 409,
        body: { error: { code: "approval_invalidated", message: "El digest cambió" } },
      },
      {
        method: "GET",
        path: "/api/approvals/pending",
        body: { approvals: [makeApproval(), makeApproval({ id: "ap-2" })] },
      },
    ]);
    await useStore.getState().decideApproval("ap-1", "approved");
    await vi.waitFor(() => {
      expect(useStore.getState().approvals).toHaveLength(2);
    });
    expect(
      useStore.getState().toasts.some((t) => t.kind === "error" && t.text.includes("approval_invalidated")),
    ).toBe(true);
  });
});
