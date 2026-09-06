/**
 * Canal web (ARCHITECTURE §9): mensaje → thread creado → run de Alex encolado;
 * duplicado por (channel, message_id) → deduped silencioso, sin segundo run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorCodes, isAgentosError } from "@agentos/shared";
import { createProject, getRun, getThread, listMessages, listRuns, listThreads } from "@agentos/db";
import { callTool, makeFixture, makeReadyTask, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("canal web", () => {
  it("mensaje entrante crea thread, persiste mensaje y encola run de Alex", async () => {
    fx.aiRunner.setBehavior(() => ({ text: "Hola, soy Alex. Creo el proyecto y su backlog." }));

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u-ernesto",
        external_chat_id: "chat-1",
        message_id: "msg-001",
        text: "Arranca un assessment para ACME S.A., 40 empleados, manufactura",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deduped: boolean; thread_id: string; run_id: string };
    expect(body.deduped).toBe(false);
    expect(body.run_id).toBeTruthy();

    const thread = (await getThread(fx.db, body.thread_id))!;
    expect(thread.channel).toBe("web");
    expect(thread.sessionKey).toBe("web:chat-1:main");

    // Run de Alex encolado con trigger 'chat'.
    const run = (await getRun(fx.db, body.run_id))!;
    expect(run.trigger).toBe("chat");
    expect(run.agentId).toBe(fx.alex.id);

    // El runner fake termina y el mensaje del asistente aterriza en el thread.
    await waitFor(async () => (await getRun(fx.db, body.run_id))!.status === "succeeded", {
      label: "run de chat terminado",
    });
    const messages = await waitFor(async () => {
      const all = await listMessages(fx.db, body.thread_id);
      return all.some((m) => m.role === "assistant") ? all : undefined;
    });
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("soy Alex");
    expect(assistant.runId).toBe(body.run_id);

    // La salida final se publicó al topic del canal y al del thread.
    const channelEvents = await fx.api.ctx.bus.getSince("channel:web", 0);
    expect(channelEvents.some((e) => e.type === "message.final")).toBe(true);
    const threadEvents = await fx.api.ctx.bus.getSince(`thread:${body.thread_id}`, 0);
    expect(threadEvents.some((e) => e.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(threadEvents.some((e) => e.type === "message.final")).toBe(true);
  });

  it("duplicado por message_id → 200 {deduped:true} y ningún segundo run", async () => {
    const runsBefore = (await listRuns(fx.db, {})).length;
    const threadsBefore = (await listThreads(fx.db, "web")).length;

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u-ernesto",
        external_chat_id: "chat-1",
        message_id: "msg-001", // MISMO message_id
        text: "Arranca un assessment para ACME S.A., 40 empleados, manufactura",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deduped: boolean; run_id: string | null };
    expect(body.deduped).toBe(true);
    expect(body.run_id).toBeNull();

    expect((await listRuns(fx.db, {})).length).toBe(runsBefore);
    expect((await listThreads(fx.db, "web")).length).toBe(threadsBefore);
  });

  // Fix H1: el system prompt de un run de chat lleva los UUIDs REALES del
  // contexto (thread, project_id del hilo, tareas del tablero) — sin esto Alex
  // inventaba slugs ("assessment-acme") y todo tasks.create fallaba not_found.
  it("run de chat con project_id: el prompt incluye thread_id, project_id real y las tareas del tablero", async () => {
    const task = await makeReadyTask(fx, fx.sam, { title: "Perfil de organización ACME" });
    fx.aiRunner.setBehavior(() => ({ text: "OK" }));

    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u-ernesto",
        external_chat_id: "chat-h1",
        message_id: "msg-h1",
        text: "¿Cómo va el tablero del assessment?",
        project_id: fx.project.id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { thread_id: string; run_id: string };
    expect(body.run_id).toBeTruthy();

    const call = await waitFor(
      () => fx.aiRunner.calls.find((c) => c.ctx.runId === body.run_id),
      { label: "run de chat capturado por el runner fake" },
    );
    const prompt = call.input.systemPrompt ?? "";
    expect(prompt).toContain(fx.project.id); // project_id REAL, no inventado
    expect(prompt).toContain(`thread_id: ${body.thread_id}`);
    expect(prompt).toContain(`[task:${task.id}]`); // índice del tablero con UUIDs reales
    expect(prompt).toContain("nunca inventes identificadores");
  });

  // DISENO-SCOPE-GATEWAY §1: getOrCreateThread solo fija el proyecto al crear.
  // Un hilo sin proyecto adopta el que llega; un hilo de OTRO proyecto → 409.
  it("el hilo del board reconcilia projectId null y rechaza el cambio de proyecto", async () => {
    fx.aiRunner.setBehavior(() => ({ text: "OK" }));
    const post = (message_id: string, project_id?: string) =>
      fx.api.app.inject({
        method: "POST",
        url: "/v1/channels/web/events",
        headers: fx.authHeaders,
        payload: { external_user_id: "u-ernesto", external_chat_id: "chat-recon", message_id, text: "hola", ...(project_id ? { project_id } : {}) },
      });

    const first = await post("msg-recon-1");
    expect(first.statusCode).toBe(200);
    const threadId = (first.json() as { thread_id: string }).thread_id;
    expect((await getThread(fx.db, threadId))!.projectId).toBeNull();

    // Llega project_id sobre el mismo hilo (misma session_key) → se adopta.
    const second = await post("msg-recon-2", fx.project.id);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { thread_id: string }).thread_id).toBe(threadId);
    expect((await getThread(fx.db, threadId))!.projectId).toBe(fx.project.id);

    // Otro proyecto sobre un hilo vivo → 409 conflict, sin reasignar ni persistir el mensaje.
    const other = await createProject(fx.db, { orgId: fx.org.id, name: "Assessment Beta", type: "assessment" });
    const messagesBefore = (await listMessages(fx.db, threadId)).length;
    const third = await post("msg-recon-3", other.id);
    expect(third.statusCode).toBe(409);
    expect((third.json() as { error: { code: string } }).error.code).toBe("conflict");
    expect((await getThread(fx.db, threadId))!.projectId).toBe(fx.project.id);
    expect((await listMessages(fx.db, threadId)).length).toBe(messagesBefore);
  });

  // DISENO-SCOPE-GATEWAY §1/§2: enqueueChatRun propaga thread.projectId al
  // ToolCallContext; la guarda de scope del gateway lo ve (fail-closed sin proyecto).
  it("enqueueChatRun propaga thread.projectId al ToolCallContext de las tools", async () => {
    let outcome: unknown;
    fx.aiRunner.setBehavior(async (input) => {
      try {
        outcome = await callTool(input, "tasks.create", {
          project_id: fx.project.id,
          title: "Creada desde el chat del tablero",
          stage: "ENTENDER",
          definition_of_done: "Existe en el tablero",
          assignee_agent_slug: "sam",
        });
      } catch (err) {
        outcome = err;
      }
      return { text: "OK" };
    });
    const post = (external_chat_id: string, message_id: string, project_id?: string) =>
      fx.api.app.inject({
        method: "POST",
        url: "/v1/channels/web/events",
        headers: fx.authHeaders,
        payload: { external_user_id: "u-ernesto", external_chat_id, message_id, text: "crea la tarea", ...(project_id ? { project_id } : {}) },
      });

    // Hilo CON proyecto → el ctx lleva project_id y tasks.create pasa la guarda.
    const withProject = await post("chat-scope-a", "msg-scope-1", fx.project.id);
    expect(withProject.statusCode).toBe(200);
    const runA = (withProject.json() as { run_id: string }).run_id;
    await waitFor(async () => (await getRun(fx.db, runA))!.status === "succeeded", { label: "run con proyecto" });
    expect(outcome).toMatchObject({
      status: "ok",
      result: { projectId: fx.project.id, title: "Creada desde el chat del tablero" },
    });

    // Hilo SIN proyecto → ctx.project_id null → fail-closed (policy_denied), aunque el project_id del arg sea real.
    outcome = undefined;
    const noProject = await post("chat-scope-b", "msg-scope-2");
    expect(noProject.statusCode).toBe(200);
    const runB = (noProject.json() as { run_id: string }).run_id;
    await waitFor(async () => (await getRun(fx.db, runB))!.status === "succeeded", { label: "run sin proyecto" });
    expect(isAgentosError(outcome, ErrorCodes.POLICY_DENIED)).toBe(true);
    expect((outcome as { details: { ctx_project_id: string | null } }).details.ctx_project_id).toBeNull();
  });

  it("sin sesión ni secreto de canal → 401", async () => {
    const res = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      payload: {
        external_user_id: "u",
        external_chat_id: "c",
        message_id: "msg-401",
        text: "hola",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
