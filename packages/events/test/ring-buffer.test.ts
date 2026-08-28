import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

const ev = (seq: number) => ({ seq });

describe("RingBuffer", () => {
  it("rechaza capacidades inválidas", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  it("overflow: conserva solo los últimos N eventos", () => {
    const buffer = new RingBuffer<{ seq: number }>(3);
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(ev(seq));
    expect(buffer.size).toBe(3);
    expect(buffer.oldestSeq).toBe(3);
    expect(buffer.newestSeq).toBe(5);
    expect(buffer.toArray().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("since(): sirve el hueco cuando puede garantizar continuidad", () => {
    const buffer = new RingBuffer<{ seq: number }>(10);
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(ev(seq));
    expect(buffer.since(0)?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(buffer.since(3)?.map((e) => e.seq)).toEqual([4, 5]);
    expect(buffer.since(5)).toEqual([]);
    expect(buffer.since(99)).toEqual([]);
  });

  it("since(): devuelve null (fail-closed) cuando hay hueco o está vacío", () => {
    const empty = new RingBuffer<{ seq: number }>(3);
    expect(empty.since(0)).toBeNull();

    const buffer = new RingBuffer<{ seq: number }>(3);
    for (let seq = 1; seq <= 5; seq += 1) buffer.push(ev(seq)); // conserva 3..5
    // sinceSeq=1 pediría el 2, que ya salió del buffer → null (ir a la DB)
    expect(buffer.since(1)).toBeNull();
    // sinceSeq=2 pide desde el 3, que ES el más viejo del buffer → sirve
    expect(buffer.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});
