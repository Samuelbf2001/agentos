import { describe, expect, it } from "vitest";
import { nowMs } from "@agentos/shared";
import { openDb, runMigrations, type AgentosDb, type PersistedEvent } from "@agentos/db";
import { EventBus } from "../src/bus.js";
import { runTopic, SWARM_TOPIC } from "../src/topics.js";
import type { AgUiEvent } from "../src/ag-ui.js";

function makeDb(): AgentosDb {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function textEvent(runId: string, delta: string): AgUiEvent {
  return {
    type: "TEXT_MESSAGE_CONTENT",
    timestamp: nowMs(),
    runId,
    messageId: "m1",
    delta,
  };
}

describe("EventBus", () => {
  it("asigna seq monotónico por topic y lo persiste en la DB", () => {
    const db = makeDb();
    const bus = new EventBus(db);
    const topic = runTopic("r1");

    const seqs = [1, 2, 3, 4, 5].map((i) => bus.publish(topic, textEvent("r1", `d${i}`)).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(bus.lastSeq(topic)).toBe(5);

    // topics independientes: cada uno arranca en 1
    expect(bus.publish(SWARM_TOPIC, textEvent("r1", "x")).seq).toBe(1);
  });

  it("notifica a suscriptores del topic y a suscriptores globales", () => {
    const db = makeDb();
    const bus = new EventBus(db);
    const topic = runTopic("r2");
    const seen: number[] = [];
    const seenAll: string[] = [];

    const off = bus.subscribe(topic, (e: PersistedEvent) => seen.push(e.seq));
    bus.subscribeAll((e) => seenAll.push(e.topic));

    bus.publish(topic, textEvent("r2", "a"));
    bus.publish(SWARM_TOPIC, textEvent("r2", "b"));
    off();
    bus.publish(topic, textEvent("r2", "c"));

    expect(seen).toEqual([1]); // tras la baja no recibe más
    expect(seenAll).toEqual([topic, SWARM_TOPIC, topic]);
  });

  it("resume: getSince sirve del ring buffer cuando cubre el hueco", () => {
    const db = makeDb();
    const bus = new EventBus(db, { bufferSize: 10 });
    const topic = runTopic("r3");
    for (let i = 1; i <= 5; i += 1) bus.publish(topic, textEvent("r3", `d${i}`));

    const gap = bus.getSince(topic, 2);
    expect(gap.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(gap.map((e) => (e.payload as { delta: string }).delta)).toEqual(["d3", "d4", "d5"]);
  });

  it("resume: cae a la DB cuando el hueco excede el ring buffer", () => {
    const db = makeDb();
    const bus = new EventBus(db, { bufferSize: 3 });
    const topic = runTopic("r4");
    for (let i = 1; i <= 10; i += 1) bus.publish(topic, textEvent("r4", `d${i}`));

    // El buffer solo conserva 8..10; pedir desde 0 obliga al fallback a DB.
    const all = bus.getSince(topic, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Un bus recién creado (buffer vacío) también recupera todo desde la DB.
    const coldBus = new EventBus(db, { bufferSize: 3 });
    expect(coldBus.getSince(topic, 4).map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("la DB es la fuente de verdad: dos instancias de bus comparten el stream", () => {
    const db = makeDb();
    const topic = runTopic("r5");
    const busA = new EventBus(db);
    const busB = new EventBus(db);

    busA.publish(topic, textEvent("r5", "a"));
    const fromB = busB.publish(topic, textEvent("r5", "b"));
    expect(fromB.seq).toBe(2); // continúa la secuencia persistida, no la suya local
    expect(busA.getSince(topic, 0)).toHaveLength(2);
  });

  it("rechaza topics inválidos y payloads que no cumplen el schema", () => {
    const db = makeDb();
    const bus = new EventBus(db);
    expect(() => bus.publish("cualquier-cosa", textEvent("r", "x"))).toThrow(/Topic inválido/);
    expect(() =>
      bus.publish(SWARM_TOPIC, { type: "TEXT_MESSAGE_CONTENT" } as unknown as AgUiEvent),
    ).toThrow();
  });

  it("guarda run_id para indexar el stream por run", () => {
    const db = makeDb();
    const bus = new EventBus(db);
    const persisted = bus.publish(runTopic("r6"), textEvent("r6", "x"));
    expect(persisted.runId).toBe("r6");
  });
});
