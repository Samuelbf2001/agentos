import { describe, expect, it } from "vitest";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { getRun, listSpans } from "@agentos/db";
import type { AgUiEvent } from "@agentos/events";
import { AiSdkRunner } from "../src/ai-sdk-runner.js";
import { NO_ANSWER_CAME, type RunInput } from "../src/types.js";
import { makeCtx, makeDb, makeProfile } from "./helpers.js";

const usageV3 = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

function toolCallStep(usageIn: number, usageOut: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "response-metadata" as const, id: "res-1", modelId: "mock-model" },
        {
          type: "tool-call" as const,
          toolCallId: "call-1",
          toolName: "sumar",
          input: JSON.stringify({ a: 2, b: 3 }),
        },
        {
          type: "finish" as const,
          usage: usageV3(usageIn, usageOut),
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
        },
      ],
    }),
  };
}

function textStep(text: string, usageIn: number, usageOut: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "response-metadata" as const, id: "res-2", modelId: "mock-model" },
        { type: "text-start" as const, id: "txt-1" },
        { type: "text-delta" as const, id: "txt-1", delta: text },
        { type: "text-end" as const, id: "txt-1" },
        {
          type: "finish" as const,
          usage: usageV3(usageIn, usageOut),
          finishReason: { unified: "stop" as const, raw: "end_turn" },
        },
      ],
    }),
  };
}

const sumarTool = tool({
  description: "Suma dos números",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ total: a + b }),
});

async function collect(iterable: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
  const events: AgUiEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const indexOf = (events: AgUiEvent[], predicate: (e: AgUiEvent) => boolean) => events.findIndex(predicate);

describe("AiSdkRunner", () => {
  it("loop completo con tool call: eventos AG-UI en orden, runs y spans escritos, coste calculado", async () => {
    const db = makeDb();
    const profile = await makeProfile(db);
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: [toolCallStep(100, 20), textStep("La suma es 5", 50, 10)],
    });
    const runner = new AiSdkRunner({ db, resolveModel: () => model });
    const ctx = makeCtx();
    const input: RunInput = {
      agent: { slug: "sam" },
      systemPrompt: "Eres Sam",
      messages: [{ role: "user", content: "suma 2+3" }],
      tools: { sumar: sumarTool },
      provider: profile,
      model: "mock-model",
      budget: { maxSteps: 4 },
    };

    const events = await collect(runner.run(input, ctx));
    const types = events.map((e) => e.type);

    // Orden AG-UI: arranque → tool call completo → texto → cierre.
    expect(types[0]).toBe("RUN_STARTED");
    expect(types[types.length - 1]).toBe("RUN_FINISHED");
    const iStart = indexOf(events, (e) => e.type === "TOOL_CALL_START" && e.toolCallName === "sumar");
    const iEnd = indexOf(events, (e) => e.type === "TOOL_CALL_END");
    const iResult = indexOf(events, (e) => e.type === "TOOL_CALL_RESULT");
    const iText = indexOf(events, (e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(iStart).toBeGreaterThan(0);
    expect(iEnd).toBeGreaterThan(iStart);
    expect(iResult).toBeGreaterThan(iEnd);
    expect(iText).toBeGreaterThan(iResult);
    const result = events[iResult]!;
    expect(result.type === "TOOL_CALL_RESULT" && result.content).toContain('"total":5');
    const textDeltas = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(textDeltas).toBe("La suma es 5");
    // Sin TOOL_CALL_START duplicados para el mismo id.
    expect(events.filter((e) => e.type === "TOOL_CALL_START")).toHaveLength(1);

    // Fila runs: succeeded, tokens sumados de ambos pasos, coste por tarifas.
    const run = (await getRun(db, ctx.runId))!;
    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBe(150);
    expect(run.tokensOut).toBe(30);
    expect(run.costUsd).toBeCloseTo((150 / 1e6) * 3 + (30 / 1e6) * 15, 10);

    // Spans estilo OTel GenAI: 2 llamadas LLM + 1 tool.
    const spans = (await listSpans(db, ctx.runId));
    const llmSpans = spans.filter((s) => s.kind === "llm");
    const toolSpans = spans.filter((s) => s.kind === "tool");
    expect(llmSpans).toHaveLength(2);
    expect(toolSpans).toHaveLength(1);
    expect(llmSpans[0]!.attrs).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "mock-model",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
    });
    expect(toolSpans[0]!.attrs).toMatchObject({
      "gen_ai.tool.name": "sumar",
      "gen_ai.tool.call.id": "call-1",
    });
    expect(llmSpans.every((s) => s.endedAt !== null)).toBe(true);

    // RUN_FINISHED lleva usage y coste (null-explicito, aquí reportado).
    const finished = events[events.length - 1]!;
    expect(finished.type === "RUN_FINISHED" && finished.usage?.tokensIn).toBe(150);
  });

  it("presupuesto excedido corta DURO: no hay paso 2, run failed budget_exceeded", async () => {
    const db = makeDb();
    const profile = await makeProfile(db);
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: [toolCallStep(100, 20), textStep("nunca debería llegar", 50, 10)],
    });
    const runner = new AiSdkRunner({ db, resolveModel: () => model });
    const ctx = makeCtx();
    const input: RunInput = {
      agent: { slug: "sam" },
      systemPrompt: "Eres Sam",
      messages: [{ role: "user", content: "suma 2+3" }],
      tools: { sumar: sumarTool },
      provider: profile,
      model: "mock-model",
      budget: { maxSteps: 4, maxTokens: 50 }, // el paso 1 ya gasta 120
    };

    const events = await collect(runner.run(input, ctx));
    const types = events.map((e) => e.type);

    expect(types).not.toContain("TEXT_MESSAGE_CONTENT");
    const last = events[events.length - 1]!;
    expect(last.type).toBe("RUN_ERROR");
    expect(last.type === "RUN_ERROR" && last.code).toBe("budget_exceeded");

    const run = (await getRun(db, ctx.runId))!;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("budget_exceeded");
    // Solo el primer paso llegó a ejecutarse.
    expect((await listSpans(db, ctx.runId)).filter((s) => s.kind === "llm")).toHaveLength(1);
  });

  it("presupuesto en USD también corta (tarifas del perfil)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db); // 3 / 15 USD por Mtok
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: [toolCallStep(1_000_000, 100_000), textStep("no", 1, 1)],
    });
    const runner = new AiSdkRunner({ db, resolveModel: () => model });
    const ctx = makeCtx();
    const events = await collect(
      runner.run(
        {
          agent: { slug: "sam" },
          systemPrompt: "",
          messages: [{ role: "user", content: "hola" }],
          tools: { sumar: sumarTool },
          provider: profile,
          model: "mock-model",
          budget: { maxUsd: 0.001 }, // paso 1 cuesta 3 + 1.5 = 4.5 USD
        },
        ctx,
      ),
    );
    const last = events[events.length - 1]!;
    expect(last.type === "RUN_ERROR" && last.code).toBe("budget_exceeded");
    expect((await getRun(db, ctx.runId))!.status).toBe("failed");
  });

  it("cierra tool-calls huérfanos con NO_ANSWER_CAME (tool sin execute = queda sin respuesta)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db);
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: [toolCallStep(10, 5)],
    });
    const runner = new AiSdkRunner({ db, resolveModel: () => model });
    const ctx = makeCtx();
    const clientTool = tool({
      description: "Suma que resuelve el cliente (sin execute)",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
    });

    const events = await collect(
      runner.run(
        {
          agent: { slug: "sam" },
          systemPrompt: "",
          messages: [{ role: "user", content: "suma 2+3" }],
          tools: { sumar: clientTool },
          provider: profile,
          model: "mock-model",
        },
        ctx,
      ),
    );

    const synthetic = events.find((e) => e.type === "TOOL_CALL_RESULT");
    expect(synthetic).toBeDefined();
    expect(synthetic!.type === "TOOL_CALL_RESULT" && synthetic!.content).toBe(NO_ANSWER_CAME);
    expect(synthetic!.type === "TOOL_CALL_RESULT" && synthetic!.synthetic).toBe(true);
    // El cierre sintético llega ANTES del evento final del run.
    const iSynthetic = events.indexOf(synthetic!);
    expect(iSynthetic).toBeLessThan(events.length - 1);
    expect((await getRun(db, ctx.runId))!.status).toBe("succeeded");
  });

  it("tokens null cuando el proveedor no los reporta (nunca cero inferido)", async () => {
    const db = makeDb();
    const profile = await makeProfile(db);
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "hola" },
              { type: "text-end" as const, id: "t" },
              {
                type: "finish" as const,
                usage: {
                  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
                },
                finishReason: { unified: "stop" as const, raw: undefined },
              },
            ],
          }),
        },
      ],
    });
    const runner = new AiSdkRunner({ db, resolveModel: () => model });
    const ctx = makeCtx();
    await collect(
      runner.run(
        {
          agent: { slug: "sam" },
          systemPrompt: "",
          messages: [{ role: "user", content: "hola" }],
          provider: profile,
          model: "mock-model",
        },
        ctx,
      ),
    );
    const run = (await getRun(db, ctx.runId))!;
    expect(run.status).toBe("succeeded");
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    expect(run.costUsd).toBeNull(); // sin tokens no hay coste inferido
  });
});
