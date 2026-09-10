/**
 * Transcripción de notas manuscritas: lo que va en el prompt y lo que se
 * limpia de la salida antes de enseñarla.
 *
 * - El SYSTEM_PROMPT pide marcar cada duda con `[?]` (es lo que evita que el
 *   modelo invente), pero el humano no quiere verlos: `limpiarMarcadores`
 *   deja la lectura elegida y la lista `dudas` viaja aparte.
 * - Con un organigrama real el modelo aplanó la jerarquía e inventó un nodo
 *   raíz; la guía de flujogramas y organigramas fija cómo leer formas y
 *   líneas y prohíbe inventar nodos o conexiones.
 */
import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT,
  construirPrompt,
  limpiarMarcadores,
} from "../src/notes/transcripcion.js";
import { segmentarEscena } from "../src/notes/segmentacion.js";

describe("limpiarMarcadores", () => {
  it("quita el marcador con alternativas y deja la palabra de antes (la lectura elegida)", () => {
    expect(limpiarMarcadores("Definir Procesos [?: Procesos/Processos] clave")).toBe(
      "Definir Procesos clave",
    );
    expect(limpiarMarcadores("- Cerrar el presupuesto [?: presupuesto/presupuestó]")).toBe(
      "- Cerrar el presupuesto",
    );
    // Sin espacio antes del marcador y con puntuación pegada a la palabra.
    expect(limpiarMarcadores("presupuesto[?: presupuesto], luego.[?: luego]")).toBe(
      "presupuesto, luego.",
    );
  });

  it("un marcador SIN palabra antes se sustituye por la primera alternativa", () => {
    expect(limpiarMarcadores("[?: Procesos/Processos] clave")).toBe("Procesos clave");
    expect(limpiarMarcadores("- [?: Ventas/Ventos]\n  - [?: Marketing]")).toBe(
      "- Ventas\n  - Marketing",
    );
    expect(limpiarMarcadores("CEO → [?: COO/CCO]")).toBe("CEO → COO");
  });

  it("los `[?]` sueltos desaparecen y no quedan dobles espacios ni se pierde la sangría", () => {
    expect(limpiarMarcadores("Hablar con Jorge [?] mañana")).toBe("Hablar con Jorge mañana");
    expect(limpiarMarcadores("[?] Hablar con Jorge [?]")).toBe("Hablar con Jorge");
    expect(limpiarMarcadores("- Padre\n  - Hijo [?]\n    - Nieto [?: Nieto/Nieta]")).toBe(
      "- Padre\n  - Hijo\n    - Nieto",
    );
  });

  it("un texto sin marcadores sale intacto, incluido un bloque mermaid", () => {
    const mermaid = "```mermaid\nflowchart TD\n  CEO --> CMO\n  CEO --> CTO\n```\n\n- CEO\n  - CMO\n  - CTO";
    expect(limpiarMarcadores(mermaid)).toBe(mermaid);
    expect(limpiarMarcadores("")).toBe("");
  });
});

describe("guía de flujogramas y organigramas en el prompt", () => {
  it("el SYSTEM_PROMPT sigue pidiendo marcar dudas y trae la guía de diagramas", () => {
    // La limpieza es de presentación: el prompt no se ablanda.
    expect(SYSTEM_PROMPT).toContain("[?]");
    expect(SYSTEM_PROMPT).toContain("flowchart TD");
    expect(SYSTEM_PROMPT).toMatch(/JERARQU[IÍ]A/i);
    expect(SYSTEM_PROMPT).toMatch(/NUNCA inventes nodos ni conexiones/);
    expect(SYSTEM_PROMPT).toMatch(/suelto/);
    expect(SYSTEM_PROMPT).toMatch(/rombo = decisión/);
    // Las etiquetas van tal cual; la corrección es una duda, no un cambio.
    expect(SYSTEM_PROMPT).toContain("«CcO»");
    // El lienzo recibe la lista anidada, jamás el mermaid.
    expect(SYSTEM_PROMPT).toMatch(/Nunca el mermaid/);
  });

  it("el prompt de usuario remite a la guía y sigue sin coordenadas", () => {
    const segmentacion = segmentarEscena({
      elements: [{ id: "a", type: "freedraw", x: 0, y: 0, points: [[0, 0], [100, 20]] }],
    });
    const prompt = construirPrompt({ segmentacion, titulo: "Organigrama" });
    expect(prompt).toContain("flowchart TD");
    expect(prompt).toContain("ni un nodo ni una conexión que no esté dibujada");
    expect(prompt).toMatch(/lista anidada/);
    // Sin cajas ni renglones: la imagen manda (ver la nota de medición del módulo).
    expect(prompt).not.toMatch(/x0 y0/);
  });
});
