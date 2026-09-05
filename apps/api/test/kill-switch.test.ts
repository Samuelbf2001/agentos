/**
 * Kill switch (US-11): pause_all → el despachador NO lanza runs nuevos;
 * resume_all → vuelve a despachar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTask, listRuns } from "@agentos/db";
import { makeFixture, makeReadyTask, waitFor, type TestFixture } from "./helpers.js";

let fx: TestFixture;

beforeAll(async () => {
  fx = await makeFixture();
});
afterAll(async () => {
  await fx.close();
});

describe("kill switch", () => {
  it("pause_all detiene el despachador; resume_all lo reactiva", async () => {
    const task = await makeReadyTask(fx, fx.sam, { title: "Tarea bajo kill switch" });
    fx.aiRunner.setBehavior(() => ({ text: "no debería ni arrancar en pausa" }));

    // Pausa por REST.
    const pause = await fx.api.app.inject({
      method: "POST",
      url: "/api/config/pause-all",
      headers: fx.authHeaders,
      payload: { reason: "prueba" },
    });
    expect(pause.statusCode).toBe(200);
    expect((pause.json() as { active: boolean }).active).toBe(true);

    const paused = await fx.api.ctx.dispatcher.tick();
    expect(paused.skipped).toBe("kill_switch");
    expect(paused.dispatched).toHaveLength(0);
    expect(await listRuns(fx.db, { taskId: task.id })).toHaveLength(0);
    expect((await getTask(fx.db, task.id))!.status).toBe("READY");

    // El canal web tampoco encola un run (mensaje persistido + warning).
    const chat = await fx.api.app.inject({
      method: "POST",
      url: "/v1/channels/web/events",
      headers: fx.authHeaders,
      payload: {
        external_user_id: "u",
        external_chat_id: "chat-ks",
        message_id: "msg-ks-1",
        text: "hola con el freno puesto",
      },
    });
    expect(chat.statusCode).toBe(200);
    const chatBody = chat.json() as { run_id: string | null; warning?: string };
    expect(chatBody.run_id).toBeNull();
    expect(chatBody.warning).toBe("kill_switch_active");

    // Reanudar.
    const resume = await fx.api.app.inject({
      method: "POST",
      url: "/api/config/resume-all",
      headers: fx.authHeaders,
      payload: {},
    });
    expect(resume.statusCode).toBe(200);
    expect((resume.json() as { active: boolean }).active).toBe(false);

    fx.aiRunner.setBehavior(async () => ({ text: "trabajando de nuevo" }));
    const report = await fx.api.ctx.dispatcher.tick();
    expect(report.dispatched).toHaveLength(1);
    await waitFor(async () => (await listRuns(fx.db, { taskId: task.id })).length === 1);
  });
});
