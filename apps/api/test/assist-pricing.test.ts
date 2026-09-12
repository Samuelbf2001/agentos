import { describe, expect, it } from "vitest";
import { estimarCosteUsd } from "../src/tasks/assist-pricing.js";

describe("estimarCosteUsd", () => {
  it("calcula el coste según la tarifa del modelo", () => {
    const usage = { tokensIn: 1_000_000, tokensOut: 500_000, tokensCacheRead: null, tokensCacheWrite: null };
    expect(estimarCosteUsd("claude-sonnet-5", usage)).toBe(2 + 5);
    expect(estimarCosteUsd("claude-opus-5", usage)).toBe(5 + 12.5);
  });

  it("redondea a 6 decimales", () => {
    const usage = { tokensIn: 123, tokensOut: 456, tokensCacheRead: null, tokensCacheWrite: null };
    expect(estimarCosteUsd("claude-sonnet-5", usage)).toBe(0.004806);
  });

  it("modelo desconocido devuelve null", () => {
    const usage = { tokensIn: 100, tokensOut: 100, tokensCacheRead: null, tokensCacheWrite: null };
    expect(estimarCosteUsd("modelo-que-no-existe", usage)).toBeNull();
  });

  it("sin usage o sin tokens informados devuelve null", () => {
    expect(estimarCosteUsd("claude-sonnet-5", null)).toBeNull();
    expect(
      estimarCosteUsd("claude-sonnet-5", {
        tokensIn: null,
        tokensOut: 100,
        tokensCacheRead: null,
        tokensCacheWrite: null,
      }),
    ).toBeNull();
  });
});
