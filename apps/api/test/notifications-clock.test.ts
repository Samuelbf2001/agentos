/**
 * Reloj de recordatorios (`createNotificationScheduler` + resolución del
 * intervalo + integración con `createApiContext`/`buildApi`). `processDue`
 * existía pero nadie lo llamaba: este archivo cubre que el temporizador
 * dispare, no se solape consigo mismo, tolere errores sin tumbar el proceso,
 * y que `notificationIntervalMs` controle si arranca o queda apagado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNotificationScheduler,
  resolveNotificationIntervalMs,
  DEFAULT_NOTIFICATION_INTERVAL_MS,
  type NotificationDispatchResult,
} from "../src/notifications.js";
import { makeFixture, waitFor, type TestFixture } from "./helpers.js";

function emptyResult(): NotificationDispatchResult {
  return { attempted: 0, delivered: 0, suppressed: 0, failed: 0, deduped: 0, skipped: 0, logs: [] };
}

describe("resolveNotificationIntervalMs", () => {
  it("sin variable de entorno devuelve el default (15 min)", () => {
    expect(resolveNotificationIntervalMs(undefined)).toBe(DEFAULT_NOTIFICATION_INTERVAL_MS);
  });

  it("cadena vacía o sólo espacios también devuelve el default", () => {
    expect(resolveNotificationIntervalMs("")).toBe(DEFAULT_NOTIFICATION_INTERVAL_MS);
    expect(resolveNotificationIntervalMs("   ")).toBe(DEFAULT_NOTIFICATION_INTERVAL_MS);
  });

  it.each(["0", "off", "OFF", "false", "FALSE", "  off  "])(
    '"%s" apaga el reloj (0)',
    (raw) => {
      expect(resolveNotificationIntervalMs(raw)).toBe(0);
    },
  );

  it("un valor no numérico apaga el reloj en vez de inventar una cadencia", () => {
    expect(resolveNotificationIntervalMs("no-es-un-numero")).toBe(0);
  });

  it("un valor negativo o cero explícito también apaga el reloj", () => {
    expect(resolveNotificationIntervalMs("-5")).toBe(0);
    expect(resolveNotificationIntervalMs("0")).toBe(0);
  });

  it("un valor numérico válido se acepta y se trunca a entero", () => {
    expect(resolveNotificationIntervalMs("1500")).toBe(1500);
    expect(resolveNotificationIntervalMs("1500.7")).toBe(1500);
  });
});

describe("createNotificationScheduler", () => {
  it("con intervalMs: 0 no arranca (running queda en false tras start())", () => {
    const processDue = vi.fn(async () => emptyResult());
    const scheduler = createNotificationScheduler({ processor: { processDue }, intervalMs: 0 });
    expect(scheduler.intervalMs).toBe(0);
    scheduler.start();
    expect(scheduler.running).toBe(false);
    scheduler.stop(); // no-op: no debe explotar sin timer activo.
    expect(scheduler.running).toBe(false);
  });

  it("con un intervalo corto llama a processDue al menos una vez", async () => {
    const processDue = vi.fn(async () => emptyResult());
    const scheduler = createNotificationScheduler({ processor: { processDue }, intervalMs: 5 });
    scheduler.start();
    expect(scheduler.running).toBe(true);
    await waitFor(() => processDue.mock.calls.length >= 1, { label: "processDue nunca se llamó" });
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it("runOnce() corre un ciclo ya, sin esperar al temporizador", async () => {
    const processDue = vi.fn(async () => emptyResult());
    const scheduler = createNotificationScheduler({ processor: { processDue }, intervalMs: 0 });
    const result = await scheduler.runOnce();
    expect(processDue).toHaveBeenCalledTimes(1);
    expect(result).toEqual(emptyResult());
  });

  it("un processDue que lanza no rompe el reloj: onError recibe el error y el siguiente tick sigue corriendo", async () => {
    const boom = new Error("proveedor temporalmente caído");
    const processDue = vi
      .fn<() => Promise<NotificationDispatchResult>>()
      .mockRejectedValueOnce(boom)
      .mockResolvedValue(emptyResult());
    const onError = vi.fn();
    const scheduler = createNotificationScheduler({ processor: { processDue }, intervalMs: 5, onError });
    scheduler.start();

    await waitFor(() => onError.mock.calls.length >= 1, { label: "onError nunca se llamó" });
    expect(onError.mock.calls[0]?.[0]).toBe(boom);

    await waitFor(() => processDue.mock.calls.length >= 2, { label: "el reloj no siguió tras el fallo" });
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  it("no se solapa consigo mismo: un ciclo lento no encola un segundo tick concurrente", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const processDue = vi.fn(async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return emptyResult();
    });
    const scheduler = createNotificationScheduler({ processor: { processDue }, intervalMs: 5 });
    scheduler.start();
    await waitFor(() => calls >= 2, { timeoutMs: 2_000, label: "no hubo suficientes ciclos para comprobar solape" });
    scheduler.stop();
    expect(maxConcurrent).toBe(1);
  });
});

describe("createApiContext / buildApi — integración del reloj", () => {
  let fixtures: TestFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  it("buildApi({ notificationIntervalMs: 0 }) deja el reloj parado", async () => {
    const fixture = await makeFixture({ autoStartLoops: true, notificationIntervalMs: 0 });
    fixtures.push(fixture);
    expect(fixture.api.ctx.notificationScheduler.intervalMs).toBe(0);
    expect(fixture.api.ctx.notificationScheduler.running).toBe(false);
  });

  it("buildApi con un intervalo corto arranca el reloj y llega a llamar a processDue", async () => {
    const fixture = await makeFixture({ autoStartLoops: true, notificationIntervalMs: 5 });
    fixtures.push(fixture);
    expect(fixture.api.ctx.notificationScheduler.intervalMs).toBe(5);
    expect(fixture.api.ctx.notificationScheduler.running).toBe(true);

    const spy = vi.spyOn(fixture.api.ctx.notifications, "processDue");
    await waitFor(() => spy.mock.calls.length >= 1, { label: "el reloj de la API nunca llamó a processDue" });
  });

  it("con autoStartLoops en false (default de test) el reloj no arranca aunque el intervalo sea corto", async () => {
    const fixture = await makeFixture({ notificationIntervalMs: 5 });
    fixtures.push(fixture);
    expect(fixture.api.ctx.notificationScheduler.running).toBe(false);
  });

  it("close() detiene el reloj", async () => {
    const fixture = await makeFixture({ autoStartLoops: true, notificationIntervalMs: 5 });
    expect(fixture.api.ctx.notificationScheduler.running).toBe(true);
    await fixture.close();
    expect(fixture.api.ctx.notificationScheduler.running).toBe(false);
  });
});
