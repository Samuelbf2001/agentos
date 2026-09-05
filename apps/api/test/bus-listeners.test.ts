/**
 * B1 — ningún rechazo suelto puede tumbar el proceso de la API.
 *
 * Los listeners del bus son asíncronos (el forwarder de chat, la auto-crítica
 * de Quinn). Un throw dentro de uno de ellos salía como `unhandledRejection` y
 * mataba apps/api entera. Ahora el bus los envuelve: el error queda registrado
 * y el proceso sigue.
 */
import { describe, expect, it, vi } from "vitest";
import { publishRaw } from "../src/bus-bridge.js";
import { makeFixture } from "./helpers.js";

describe("EventBus: un listener que lanza no termina el proceso", () => {
  it("captura el rechazo (asíncrono y síncrono) y lo registra", async () => {
    const fx = await makeFixture();
    const rechazos: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rechazos.push(err);
    };
    process.on("unhandledRejection", onRejection);
    const registrado = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const topic = "thread:listener-boom";
      const offAsync = fx.api.ctx.bus.subscribe(topic, async () => {
        throw new Error("listener asíncrono explota");
      });
      const offSync = fx.api.ctx.bus.subscribe(topic, () => {
        throw new Error("listener síncrono explota");
      });
      const offAll = fx.api.ctx.bus.subscribeAll(async () => {
        throw new Error("listener global explota");
      });

      // Publicar NO propaga el fallo de los listeners.
      await expect(
        publishRaw(fx.api.ctx.bus, topic, { type: "message.inbound", payload: {} }),
      ).resolves.toBeDefined();
      await new Promise((r) => setTimeout(r, 50)); // ventana del unhandledRejection

      offAsync();
      offSync();
      offAll();

      expect(rechazos).toEqual([]);
      const mensajes = registrado.mock.calls.map((c) => String(c[0]));
      expect(mensajes.filter((m) => m.includes("listener de"))).toHaveLength(3);
    } finally {
      registrado.mockRestore();
      process.off("unhandledRejection", onRejection);
      await fx.close();
    }
  });
});
