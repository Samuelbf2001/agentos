/**
 * Excepción documentada al sistema de diseño: el TIPO de nodo del grafo es la
 * única categorización que lleva color propio (fuera de los tokens `work|
 * decide|broken|done|link`), porque distinguir 8 tipos con la gramática de
 * estado del producto no alcanza — no hay 8 estados, hay 8 clases de cosa.
 * Los colores son los mismos que ya usa WhatsAppHub (validados en claro y
 * oscuro) y se enseñan siempre junto a la leyenda, nunca solos.
 */
import type { GraphNodeType } from "../../../lib/brain/grafo";

export interface NodeTypeStyle {
  label: string;
  color: string;
}

export const NODE_TYPE_STYLES: Record<GraphNodeType, NodeTypeStyle> = {
  contacto: { label: "Contacto", color: "#6c8ef5" },
  empresa: { label: "Empresa", color: "#f5a623" },
  equipo: { label: "Equipo", color: "#25d366" },
  reunion: { label: "Reunión", color: "#a78bfa" },
  nota: { label: "Nota", color: "#f472b6" },
  nota_voz: { label: "Nota de voz", color: "#14c8b4" },
  pagina: { label: "Página", color: "#8b90a8" },
  tema: { label: "Tema", color: "#64748b" },
};

export const NODE_TYPE_ORDER = Object.keys(NODE_TYPE_STYLES) as GraphNodeType[];

export function styleForType(type: GraphNodeType): NodeTypeStyle {
  return NODE_TYPE_STYLES[type] ?? NODE_TYPE_STYLES.tema;
}
