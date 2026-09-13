/**
 * 2brain › Grafo dinámico: decodificación columnar, grafo vivo y LOD.
 *
 * Ningún test importa sigma ni el worker de ForceAtlas2 (jsdom no tiene WebGL
 * ni `Worker`, y el layout se instancia desde un `blob:`): aquí solo hay
 * módulos puros — `grafoDynamic`, `graphStore` y `lod`.
 */
import { describe, expect, it } from "vitest";
import { GraphPayloadError, decodePayload } from "../src/lib/brain/grafoDynamic";
import { createGraphStore, sizeForDegree } from "../src/lib/brain/graphStore";
import { emptyContext, reduceEdge, reduceNode, shouldHideEdges } from "../src/views/brain/grafo/lod";

const TYPES = ["contacto", "empresa", "equipo", "reunion", "nota", "nota_voz", "pagina", "tema"];
const EDGE_TYPES = [
  "pertenece-a", "asignado-a", "reunion-contacto", "reunion-empresa", "nota-contacto",
  "nota-empresa", "participo-en", "tagged", "relacionada-con", "creada-por",
];

interface RawNode {
  id: string;
  type: string;
  label: string;
  ts?: number | null;
  deg?: number;
}

/**
 * Construye un envoltorio columnar conforme a §A.2 a partir de nodos, stubs y
 * aristas "en objetos": los tests se leen, el transporte sigue siendo columnar.
 */
function payload(
  nodes: RawNode[],
  stubs: RawNode[],
  edges: Array<{ s: string; t: string; type?: string; w?: number }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const refs = [...nodes.map((n) => n.id), ...stubs.map((n) => n.id)];
  const index = (id: string) => refs.indexOf(id);
  return {
    v: 1,
    index: "default:1757700000000:1278:4210",
    refs,
    nodes: {
      count: nodes.length,
      type: nodes.map((n) => TYPES.indexOf(n.type)),
      label: nodes.map((n) => n.label),
      ts: nodes.map((n) => n.ts ?? null),
      deg: nodes.map((n) => n.deg ?? 1),
    },
    stubs: {
      count: stubs.length,
      type: stubs.map((n) => TYPES.indexOf(n.type)),
      label: stubs.map((n) => n.label),
      ts: stubs.map((n) => n.ts ?? null),
    },
    edges: {
      count: edges.length,
      s: edges.map((e) => index(e.s)),
      t: edges.map((e) => index(e.t)),
      type: edges.map((e) => EDGE_TYPES.indexOf(e.type ?? "pertenece-a")),
      w: edges.map((e) => e.w ?? 1),
    },
    meta: { types: TYPES, edgeTypes: EDGE_TYPES },
    ...extra,
  };
}

describe("decodePayload (envoltorio columnar)", () => {
  it("decodifica nodos, stubs y aristas con los diccionarios de meta", () => {
    const decoded = decodePayload(
      payload(
        [
          { id: "contacto:12", type: "contacto", label: "Ana", ts: 1757000000000, deg: 7 },
          { id: "empresa:1", type: "empresa", label: "ACME", ts: null, deg: 31 },
        ],
        [{ id: "reunion:88", type: "reunion", label: "Kickoff ACME", ts: 1756900000000 }],
        [{ s: "contacto:12", t: "empresa:1", type: "pertenece-a" }, { s: "contacto:12", t: "reunion:88", type: "participo-en" }],
      ),
    );

    expect(decoded.index).toBe("default:1757700000000:1278:4210");
    expect(decoded.nodes).toEqual([
      { id: "contacto:12", type: "contacto", label: "Ana", ts: 1757000000000, deg: 7 },
      { id: "empresa:1", type: "empresa", label: "ACME", ts: null, deg: 31 },
    ]);
    // Los stubs viajan aparte y NUNCA se confunden con nodos.
    expect(decoded.stubIds).toEqual(["reunion:88"]);
    expect(decoded.edges).toEqual([
      { source: "contacto:12", target: "empresa:1", type: "pertenece-a", weight: 1 },
      { source: "contacto:12", target: "reunion:88", type: "participo-en", weight: 1 },
    ]);
  });

  it.each([
    ["refs no cuadra con nodes.count + stubs.count", { refs: ["contacto:12"] }],
    ["una columna de nodes más corta", { nodes: { count: 2, type: [0], label: ["a", "b"], ts: [1, 2], deg: [1, 2] } }],
    ["una columna de stubs más corta", { stubs: { count: 1, type: [], label: ["x"], ts: [1] } }],
    ["edges.s fuera del rango de refs", { edges: { count: 1, s: [99], t: [0], type: [0], w: [1] } }],
    ["ts en ISO en vez de epoch ms", { nodes: { count: 2, type: [0, 1], label: ["a", "b"], ts: ["2026-01-01", null], deg: [1, 2] } }],
    ["sin diccionarios en meta", { meta: { types: TYPES } }],
    ["un código de tipo fuera del diccionario", { nodes: { count: 2, type: [0, 99], label: ["a", "b"], ts: [1, 2], deg: [1, 2] } }],
  ])("rechaza %s", (_name, patch) => {
    const raw = payload(
      [
        { id: "contacto:12", type: "contacto", label: "Ana" },
        { id: "empresa:1", type: "empresa", label: "ACME" },
      ],
      [{ id: "reunion:88", type: "reunion", label: "Kickoff" }],
      [{ s: "contacto:12", t: "empresa:1" }],
      patch as Record<string, unknown>,
    );
    expect(() => decodePayload(raw)).toThrow(GraphPayloadError);
  });

  it("rechaza una respuesta vacía", () => {
    expect(() => decodePayload(null)).toThrow(GraphPayloadError);
  });
});

describe("graphStore", () => {
  const skeleton = () =>
    decodePayload(
      payload(
        [
          { id: "contacto:12", type: "contacto", label: "Ana", deg: 3 },
          { id: "empresa:1", type: "empresa", label: "ACME", deg: 9 },
        ],
        [],
        [{ s: "contacto:12", t: "empresa:1", type: "pertenece-a" }],
      ),
    );

  it("inserta el esqueleto y cuenta lo añadido", () => {
    const store = createGraphStore();
    const result = store.applyPayload(skeleton());

    expect(result).toEqual({ nodesAdded: 2, edgesAdded: 1, unparked: 0, conflictsIgnored: 0 });
    expect(store.graph.order).toBe(2);
    expect(store.graph.size).toBe(1);
    expect(store.indexVersion).toBe("default:1757700000000:1278:4210");
    expect(store.typeCounts()).toEqual({ contacto: 1, empresa: 1 });
    expect(store.loadedByType).toEqual({ contacto: 1, empresa: 1 });
  });

  it("los stubs NUNCA entran como nodos: su arista se aparca", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());

    // Capa 1: la reunión llega como stub (la toca una arista pero no se entrega).
    const conStub = decodePayload(
      payload(
        [{ id: "nota:5", type: "nota", label: "Acta", ts: 1757000000000 }],
        [{ id: "reunion:88", type: "reunion", label: "Kickoff" }],
        [{ s: "nota:5", t: "reunion:88", type: "relacionada-con" }],
      ),
    );
    const first = store.applyPayload(conStub);

    expect(first.nodesAdded).toBe(1);
    expect(first.edgesAdded).toBe(0);
    expect(store.has("reunion:88")).toBe(false);
    expect(store.graph.order).toBe(3);
    expect(store.pendingEdges.get("reunion:88")).toHaveLength(1);

    // Capa 2: ahora sí llega la reunión → la arista aparcada entra sola.
    const second = store.applyPayload(
      decodePayload(payload([{ id: "reunion:88", type: "reunion", label: "Kickoff", ts: 1756900000000 }], [], [])),
    );

    expect(second).toMatchObject({ nodesAdded: 1, edgesAdded: 1, unparked: 1 });
    expect(store.pendingEdges.has("reunion:88")).toBe(false);
    expect(store.graph.hasEdge("nota:5|reunion:88|relacionada-con")).toBe(true);
  });

  it("un nodo nuevo aterriza EN TORNO al centroide de sus vecinos ya colocados", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());
    const ana = { x: store.graph.getNodeAttribute("contacto:12", "x"), y: store.graph.getNodeAttribute("contacto:12", "y") };

    store.applyPayload(
      decodePayload(
        payload(
          [{ id: "reunion:88", type: "reunion", label: "Kickoff", ts: 1756900000000 }],
          // Ana ya está en el grafo: en esta tanda viaja como stub, no como nodo.
          [{ id: "contacto:12", type: "contacto", label: "Ana" }],
          [{ s: "reunion:88", t: "contacto:12", type: "reunion-contacto" }],
        ),
      ),
    );

    const pos = { x: store.graph.getNodeAttribute("reunion:88", "x"), y: store.graph.getNodeAttribute("reunion:88", "y") };
    // Cerca de Ana, pero NO encima: el primer hermano sale a ~10 unidades.
    const distancia = Math.hypot(pos.x - ana.x, pos.y - ana.y);
    expect(distancia).toBeGreaterThan(3);
    expect(distancia).toBeLessThanOrEqual(30);
  });

  it("los hermanos de un mismo hub se reparten en corona, no se apilan encima", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());
    const ana = { x: store.graph.getNodeAttribute("contacto:12", "x"), y: store.graph.getNodeAttribute("contacto:12", "y") };

    // 200 reuniones colgando SOLO de Ana: el caso real del hub de grado 229.
    const hojas = Array.from({ length: 200 }, (_, i) => ({
      id: `reunion:${100 + i}`,
      type: "reunion",
      label: `Reunión ${i}`,
      ts: 1757000000000 - i,
    }));
    store.applyPayload(
      decodePayload(
        payload(
          hojas,
          [{ id: "contacto:12", type: "contacto", label: "Ana" }],
          hojas.map((h) => ({ s: h.id, t: "contacto:12", type: "reunion-contacto" })),
        ),
      ),
    );

    let dentro = 0;
    let maxima = 0;
    for (const hoja of hojas) {
      const d = Math.hypot(
        store.graph.getNodeAttribute(hoja.id, "x") - ana.x,
        store.graph.getNodeAttribute(hoja.id, "y") - ana.y,
      );
      if (d < 25) dentro++;
      maxima = Math.max(maxima, d);
    }
    // Antes: las 200 caían dentro de ±12 y sepultaban al hub. Ahora la corona
    // llega a ~200 unidades y solo un puñado queda en el radio del propio hub.
    expect(dentro).toBeLessThan(10);
    expect(maxima).toBeGreaterThan(150);
  });

  it("un nodo ya cargado no cambia de tipo ni de etiqueta por una tanda ajena", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());

    // Una respuesta posterior insiste en que el contacto es una reunión.
    const intruso = store.applyPayload(
      decodePayload(payload([{ id: "contacto:12", type: "reunion", label: "Kickoff", deg: 50 }], [], [])),
    );

    expect(intruso.conflictsIgnored).toBe(1);
    expect(store.graph.getNodeAttribute("contacto:12", "type")).toBe("contacto");
    expect(store.graph.getNodeAttribute("contacto:12", "label")).toBe("Ana");
    // El grado sí se acepta: nunca pinta de menos.
    expect(store.graph.getNodeAttribute("contacto:12", "deg")).toBe(50);

    // Solo su PROPIA ego-red puede corregirlo.
    const propio = store.applyPayload(
      decodePayload(payload([{ id: "contacto:12", type: "contacto", label: "Ana Gómez", deg: 50 }], [], [])),
      { egoOf: "contacto:12" },
    );
    expect(propio.conflictsIgnored).toBe(0);
    expect(store.graph.getNodeAttribute("contacto:12", "label")).toBe("Ana Gómez");
  });

  it("sin vecinos conocidos, aterriza en el anillo de su tipo (no en el origen)", () => {
    const store = createGraphStore();
    store.applyPayload(decodePayload(payload([{ id: "pagina:3", type: "pagina", label: "Wiki" }], [], [])));
    const { x, y } = store.graph.getNodeAttributes("pagina:3");
    expect(Math.hypot(x, y)).toBeGreaterThan(100);
  });

  it("la ego-red se MEZCLA: no borra lo ya cargado y suma lo nuevo", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());

    const ego = store.applyPayload(
      decodePayload(
        payload(
          [
            { id: "empresa:1", type: "empresa", label: "ACME", deg: 9 }, // ya estaba
            { id: "reunion:90", type: "reunion", label: "Revisión", ts: 1757100000000 },
          ],
          [],
          [{ s: "reunion:90", t: "empresa:1", type: "reunion-empresa" }],
        ),
      ),
    );

    expect(ego.nodesAdded).toBe(1);
    expect(store.graph.order).toBe(3);
    expect(store.has("contacto:12")).toBe(true); // la vista anterior sigue viva
    expect(store.graph.size).toBe(2);
  });

  it("una tanda repetida no duplica nodos ni aristas", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());
    const again = store.applyPayload(skeleton());
    expect(again).toEqual({ nodesAdded: 0, edgesAdded: 0, unparked: 0, conflictsIgnored: 0 });
    expect(store.graph.order).toBe(2);
    expect(store.graph.size).toBe(1);
  });

  it("clear() deja el grafo, los aparcados y los contadores a cero", () => {
    const store = createGraphStore();
    store.applyPayload(skeleton());
    store.clear();
    expect(store.graph.order).toBe(0);
    expect(store.pendingEdges.size).toBe(0);
    expect(store.loadedByType).toEqual({});
    expect(store.indexVersion).toBeNull();
  });

  it("el tamaño por grado crece con la raíz y queda acotado en [2, 11]", () => {
    expect(sizeForDegree(0)).toBe(2);
    expect(sizeForDegree(9)).toBeCloseTo(3.8, 5);
    // El hub real del grafo (grado 229) toca el techo; nada lo supera.
    expect(sizeForDegree(229)).toBe(11);
    expect(sizeForDegree(100_000)).toBe(11);
  });
});

describe("LOD (reducers puros)", () => {
  const node = { type: "contacto", size: 6, label: "Ana" };

  it("oculta los nodos de un tipo filtrado y deja pasar el resto", () => {
    const ctx = { ...emptyContext(), visibleTypes: new Set(["empresa"]) };
    expect(reduceNode("contacto:1", node, ctx).hidden).toBe(true);
    expect(reduceNode("empresa:1", { ...node, type: "empresa" }, ctx).hidden).toBe(false);
  });

  it("con hover, el nodo y sus vecinos conservan color; el resto se atenúa y pierde etiqueta", () => {
    const ctx = { ...emptyContext(), hoveredId: "contacto:1", hoveredNeighbors: new Set(["empresa:1"]) };
    expect(reduceNode("contacto:1", node, ctx).label).toBe("Ana");
    expect(reduceNode("empresa:1", { ...node, type: "empresa" }, ctx).label).toBe("Ana");
    const lejano = reduceNode("pagina:9", { ...node, type: "pagina" }, ctx);
    expect(lejano.label).toBeNull();
    expect(lejano.color).toBe("#d3d6df");
  });

  it("la selección y el resultado de búsqueda fuerzan etiqueta y suben de plano", () => {
    const seleccionado = reduceNode("contacto:1", node, { ...emptyContext(), selectedId: "contacto:1" });
    expect(seleccionado.forceLabel).toBe(true);
    expect(seleccionado.zIndex).toBe(4);
    expect(seleccionado.size).toBeGreaterThan(node.size);
    expect(reduceNode("contacto:1", node, { ...emptyContext(), searchHitId: "contacto:1" }).forceLabel).toBe(true);
  });

  it("un hub se dibuja por encima de sus hojas", () => {
    const hoja = reduceNode("reunion:1", { ...node, type: "reunion", deg: 2 }, emptyContext());
    const hub = reduceNode("contacto:1", { ...node, deg: 229 }, emptyContext());
    expect(hub.zIndex).toBeGreaterThan(hoja.zIndex);
  });

  it("los aislados (grado 0) se ocultan salvo que se pidan o se seleccionen", () => {
    const aislado = { ...node, deg: 0 };
    expect(reduceNode("contacto:9", aislado, emptyContext()).hidden).toBe(true);
    expect(reduceNode("contacto:9", aislado, { ...emptyContext(), showIsolated: true }).hidden).toBe(false);
    expect(reduceNode("contacto:9", aislado, { ...emptyContext(), searchHitId: "contacto:9" }).hidden).toBe(false);
    expect(reduceNode("contacto:9", aislado, { ...emptyContext(), selectedId: "contacto:9" }).hidden).toBe(false);
    // Con grado ≥ 1 nunca se esconde por este motivo.
    expect(reduceNode("contacto:1", { ...node, deg: 1 }, emptyContext()).hidden).toBe(false);
  });

  it("las aristas desaparecen solo con grafo grande Y cámara lejos", () => {
    expect(shouldHideEdges(2501, 1.3)).toBe(true);
    expect(shouldHideEdges(2501, 1.1)).toBe(false);
    expect(shouldHideEdges(2000, 4)).toBe(false);
  });

  it("la arista bajo el hover se resalta y las demás se atenúan", () => {
    const ctx = { ...emptyContext(), hoveredId: "contacto:1" };
    const data = { source: "contacto:1", target: "empresa:1", sourceType: "contacto", targetType: "empresa" };
    expect(reduceEdge("e1", data, ctx)).toMatchObject({ hidden: false, color: "#5b6bff" });
    expect(reduceEdge("e2", { ...data, source: "nota:1", sourceType: "nota" }, ctx)).toMatchObject({ color: "#e6e8ee" });
  });

  it("una arista con un extremo filtrado se oculta", () => {
    const ctx = { ...emptyContext(), visibleTypes: new Set(["contacto"]) };
    const data = { source: "contacto:1", target: "empresa:1", sourceType: "contacto", targetType: "empresa" };
    expect(reduceEdge("e1", data, ctx).hidden).toBe(true);
  });
});
