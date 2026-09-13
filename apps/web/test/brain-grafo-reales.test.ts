/**
 * 2brain › Grafo dinámico: regresión contra las FORMAS REALES de producción.
 *
 * Los dos ficheros de `fixtures/` son recortes literales de
 * `https://whatsfull.sixteam.pro/api/wiki/graph/{skeleton,layer}` (mismo
 * envoltorio columnar, mismos diccionarios `meta.types`, mismos códigos): en el
 * esqueleto `contacto:11353` («Samuel Burgos», grado 229) viaja como NODO
 * completo y en la capa siguiente vuelve como STUB junto a sus reuniones.
 *
 * Lo que se blinda aquí es el defecto que se veía en el lienzo: ese contacto se
 * pintaba del color de Reunión y desaparecía al ocultar Reunión. La causa no
 * era el diccionario —el servidor es coherente y esta prueba lo comprueba— sino
 * que sus 229 reuniones aterrizaban dentro del jitter del propio hub y lo
 * sepultaban. Se fijan las dos cosas: el tipo no se toca y la corona separa.
 */
import { describe, expect, it } from "vitest";
import { decodePayload } from "../src/lib/brain/grafoDynamic";
import { createGraphStore } from "../src/lib/brain/graphStore";
import { reduceNode, emptyContext } from "../src/views/brain/grafo/lod";
import skeletonReal from "./fixtures/grafo-skeleton.json";
import layerReal from "./fixtures/grafo-layer.json";

const HUB = "contacto:11353";

describe("grafo con las formas reales del hub", () => {
  it("el servidor es coherente: cada id declara el tipo que dice su prefijo", () => {
    for (const raw of [skeletonReal, layerReal]) {
      const payload = decodePayload(raw);
      for (const node of payload.nodes) {
        expect(node.type).toBe(node.id.slice(0, node.id.indexOf(":")));
      }
    }
  });

  it("un contacto entregado en el esqueleto sigue siendo contacto tras la capa que lo trae como stub", () => {
    const store = createGraphStore();
    store.applyPayload(decodePayload(skeletonReal));
    expect(store.graph.getNodeAttribute(HUB, "type")).toBe("contacto");

    const capa = decodePayload(layerReal);
    // La capa lo lleva en `stubIds`, no en `nodes`: es la mezcla que se
    // sospechaba de reescribir el tipo con el diccionario equivocado.
    expect(capa.stubIds).toContain(HUB);
    const resultado = store.applyPayload(capa);

    expect(resultado.conflictsIgnored).toBe(0);
    expect(store.graph.getNodeAttribute(HUB, "type")).toBe("contacto");
    expect(store.graph.getNodeAttribute(HUB, "label")).toBe("Samuel Burgos");
    // Y las reuniones de la capa quedaron enganchadas a él.
    expect(store.graph.degree(HUB)).toBe(capa.nodes.length);
  });

  it("ocultar Reunión no puede esconder al contacto: el reducer lee su tipo real", () => {
    const store = createGraphStore();
    store.applyPayload(decodePayload(skeletonReal));
    store.applyPayload(decodePayload(layerReal));

    const sinReunion = new Set(["contacto", "empresa", "equipo", "nota", "nota_voz", "pagina", "tema"]);
    const ctx = { ...emptyContext(), visibleTypes: sinReunion };
    const attrs = store.graph.getNodeAttributes(HUB);

    expect(reduceNode(HUB, attrs, ctx).hidden).toBe(false);
    const reunion = store.graph.findNode((_id, a) => a.type === "reunion");
    expect(reduceNode(reunion!, store.graph.getNodeAttributes(reunion!), ctx).hidden).toBe(true);
  });

  it("las reuniones de la capa rodean al hub en vez de apilarse encima", () => {
    const store = createGraphStore();
    store.applyPayload(decodePayload(skeletonReal));
    const hub = store.graph.getNodeAttributes(HUB);
    const capa = decodePayload(layerReal);
    store.applyPayload(capa);

    const distancias = capa.nodes.map((n) =>
      Math.hypot(store.graph.getNodeAttribute(n.id, "x") - hub.x, store.graph.getNodeAttribute(n.id, "y") - hub.y),
    );
    // Ninguna encima del hub (su radio de dibujo es como mucho 11) y la corona
    // crece: la última está bastante más lejos que la primera.
    expect(Math.min(...distancias)).toBeGreaterThan(hub.size);
    expect(Math.max(...distancias)).toBeGreaterThan(2 * Math.min(...distancias));
  });
});
