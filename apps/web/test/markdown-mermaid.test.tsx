/**
 * La transcripción de un diagrama trae un bloque ```mermaid. El componente
 * Markdown NO renderiza mermaid (sin dependencias nuevas): el bloque tiene
 * que quedar como código monoespaciado tal cual, sin reventar.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "../src/components/Markdown";

describe("Markdown con un bloque mermaid", () => {
  it("lo deja como código tal cual, sin renderizarlo ni romper", () => {
    const md = "```mermaid\nflowchart TD\n  CEO --> CMO\n  CEO --> CTO\n```\n\n- CEO\n  - CMO\n  - CTO";
    const { container } = render(<Markdown>{md}</Markdown>);
    const codigo = container.querySelector("pre code");
    expect(codigo).not.toBeNull();
    expect(codigo!.textContent).toContain("flowchart TD");
    expect(codigo!.textContent).toContain("CEO --> CMO");
    // La lista anidada de debajo sí se renderiza como lista.
    expect(container.querySelectorAll("li").length).toBe(3);
  });
});
