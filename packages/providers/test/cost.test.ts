import { describe, expect, it } from "vitest";
import { addUsage, computeCostUsd, EMPTY_USAGE, normalizeUsage } from "../src/cost.js";

const rates = { costInputPerMtok: 3, costOutputPerMtok: 15 };

describe("normalizeUsage", () => {
  it("mapea el usage del AI SDK a null-explicito", () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 5, cacheWriteTokens: undefined },
      }),
    ).toEqual({ tokensIn: 100, tokensOut: 20, tokensCacheRead: 5, tokensCacheWrite: null });
  });

  it("proveedor que no reporta → todo null (nunca cero inferido)", () => {
    expect(normalizeUsage(undefined)).toEqual(EMPTY_USAGE);
    expect(normalizeUsage({})).toEqual(EMPTY_USAGE);
    expect(normalizeUsage({ inputTokens: undefined, outputTokens: undefined })).toEqual(EMPTY_USAGE);
  });
});

describe("addUsage", () => {
  it("suma preservando null (null+null=null, null+n=n)", () => {
    const a = { tokensIn: 100, tokensOut: null, tokensCacheRead: null, tokensCacheWrite: 2 };
    const b = { tokensIn: 50, tokensOut: 10, tokensCacheRead: null, tokensCacheWrite: null };
    expect(addUsage(a, b)).toEqual({
      tokensIn: 150,
      tokensOut: 10,
      tokensCacheRead: null,
      tokensCacheWrite: 2,
    });
  });
});

describe("computeCostUsd", () => {
  it("calcula con cost_in/out_per_mtok del perfil", () => {
    const cost = computeCostUsd({ tokensIn: 1_000_000, tokensOut: 500_000 }, rates);
    expect(cost).toBeCloseTo(3 + 7.5, 10);
  });

  it("null si el proveedor no reportó tokens (in u out)", () => {
    expect(computeCostUsd({ tokensIn: null, tokensOut: 100 }, rates)).toBeNull();
    expect(computeCostUsd({ tokensIn: 100, tokensOut: null }, rates)).toBeNull();
  });

  it("null si el perfil no tiene tarifas", () => {
    expect(
      computeCostUsd({ tokensIn: 10, tokensOut: 10 }, { costInputPerMtok: null, costOutputPerMtok: 15 }),
    ).toBeNull();
    expect(
      computeCostUsd({ tokensIn: 10, tokensOut: 10 }, { costInputPerMtok: 3, costOutputPerMtok: null }),
    ).toBeNull();
  });

  it("cero tokens reportados es un coste 0 legítimo (distinto de null)", () => {
    expect(computeCostUsd({ tokensIn: 0, tokensOut: 0 }, rates)).toBe(0);
  });
});
