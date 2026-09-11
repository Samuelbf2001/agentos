/**
 * `blocksToMarkdown` sobre bloques con la MISMA forma que devuelve la API de
 * Notion y que guarda el capturador. Los textos son sintéticos; las formas
 * (anotaciones, `has_children`, `children` por `block_id`, tablas, adjuntos
 * firmados...) están calcadas de una captura real.
 */
import { describe, expect, it } from "vitest";
import { blocksToMarkdown, richTextToMarkdown } from "../src/blocks-to-markdown.js";
import { blocksTree, paragraphBlock } from "./fixtures.js";

type Json = Record<string, unknown>;

function text(
  content: string,
  annotations: Partial<{ bold: boolean; italic: boolean; strikethrough: boolean; code: boolean; underline: boolean }> = {},
  href: string | null = null,
): Json {
  return {
    type: "text",
    text: { content, link: href ? { url: href } : null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
      ...annotations,
    },
    plain_text: content,
    href,
  };
}

let counter = 0;
function block(type: string, payload: Json, options: { id?: string; has_children?: boolean } = {}): Json {
  counter += 1;
  return {
    object: "block",
    id: options.id ?? `blk-${counter}`,
    has_children: options.has_children === true,
    type,
    [type]: payload,
  };
}

const rich = (type: string, fragments: Json[], extra: Json = {}, options?: { id?: string; has_children?: boolean }) =>
  block(type, { rich_text: fragments, color: "default", ...extra }, options);

describe("richTextToMarkdown", () => {
  it("aplica negrita, cursiva, tachado, código y enlace por fragmento", () => {
    expect(
      richTextToMarkdown([
        text("Entregable: enviar a "),
        text("Juliana", { bold: true }),
        text(" y "),
        text("revisar", { italic: true }),
        text(" "),
        text("viejo", { strikethrough: true }),
        text(" "),
        text("npm test", { code: true }),
        text(" en "),
        text("el doc", {}, "https://docs.example/1"),
      ]),
    ).toBe("Entregable: enviar a **Juliana** y *revisar* ~~viejo~~ `npm test` en [el doc](https://docs.example/1)");
  });

  it("saca los espacios de borde fuera de los marcadores (Markdown válido)", () => {
    expect(richTextToMarkdown([text("hola "), text(" mundo ", { bold: true }), text("!")])).toBe("hola  **mundo** !");
  });

  it("combina anotaciones y enlace en el mismo fragmento", () => {
    expect(richTextToMarkdown([text("Ver", { bold: true, italic: true }, "https://x.test")])).toBe(
      "[***Ver***](https://x.test)",
    );
  });

  it("menciones y ecuaciones usan su texto plano", () => {
    expect(
      richTextToMarkdown([
        { type: "mention", mention: { type: "user", user: { id: "u1" } }, plain_text: "@Ernesto", href: null },
        text(" revisa "),
        { type: "equation", equation: { expression: "E=mc^2" }, plain_text: "E=mc^2", href: null },
      ]),
    ).toBe("@Ernesto revisa `E=mc^2`");
  });

  it("entrada vacía o inválida → cadena vacía", () => {
    expect(richTextToMarkdown([])).toBe("");
    expect(richTextToMarkdown(undefined)).toBe("");
    expect(richTextToMarkdown("no es lista")).toBe("");
  });
});

describe("blocksToMarkdown: bloques de texto", () => {
  it("párrafos separados por línea en blanco; los vacíos se omiten", () => {
    const md = blocksToMarkdown([
      paragraphBlock("p1", "Primero"),
      rich("paragraph", []),
      paragraphBlock("p2", "Segundo"),
    ]);
    expect(md).toBe("Primero\n\nSegundo");
  });

  it("encabezados 1..3 (también los 'toggleable')", () => {
    const md = blocksToMarkdown([
      rich("heading_1", [text("Título")], { is_toggleable: false }),
      rich("heading_2", [text("Descripción")], { is_toggleable: false }),
      rich("heading_3", [text("1. Ítem “Sistema”", { bold: true })], { is_toggleable: true }),
    ]);
    expect(md).toBe("# Título\n\n## Descripción\n\n### **1. Ítem “Sistema”**");
  });

  it("to_do como casillas, marcadas o no", () => {
    const md = blocksToMarkdown([
      rich("to_do", [text("Marcar propietario")], { checked: true }),
      rich("to_do", [text("Enviar formulario")], { checked: false }),
    ]);
    expect(md).toBe("- [x] Marcar propietario\n- [ ] Enviar formulario");
  });

  it("listas con viñetas y numeradas; la numeración se reinicia por grupo", () => {
    const md = blocksToMarkdown([
      rich("bulleted_list_item", [text("MIRO")]),
      rich("bulleted_list_item", [text("Figma")]),
      paragraphBlock("p", "Pasos:"),
      rich("numbered_list_item", [text("Uno")]),
      rich("numbered_list_item", [text("Dos")]),
      paragraphBlock("q", "Otra vez:"),
      rich("numbered_list_item", [text("Uno de nuevo")]),
    ]);
    expect(md).toBe("- MIRO\n- Figma\n\nPasos:\n\n1. Uno\n2. Dos\n\nOtra vez:\n\n1. Uno de nuevo");
  });

  it("quote y callout como cita; el callout conserva su emoji", () => {
    const md = blocksToMarkdown([
      rich("quote", [text("Cita corta")]),
      rich("callout", [text("Ojo con esto")], { icon: { type: "emoji", emoji: "⚠️" } }),
    ]);
    expect(md).toBe("> Cita corta\n\n> ⚠️ Ojo con esto");
  });

  it("code con lenguaje; 'plain text' queda sin lenguaje; el texto NO lleva marcadores", () => {
    const md = blocksToMarkdown([
      rich("code", [text("const a = **1**;\nconsole.log(a);", { bold: true })], { language: "typescript", caption: [] }),
      rich("code", [text("hola")], { language: "plain text", caption: [text("pie")] }),
    ]);
    expect(md).toBe("```typescript\nconst a = **1**;\nconsole.log(a);\n```\n\n```\nhola\n```\n\npie");
  });

  it("divider → ---", () => {
    expect(blocksToMarkdown([paragraphBlock("a", "A"), block("divider", {}), paragraphBlock("b", "B")])).toBe(
      "A\n\n---\n\nB",
    );
  });

  it("equation de bloque → código en línea", () => {
    expect(blocksToMarkdown([block("equation", { expression: "a^2+b^2" })])).toBe("`a^2+b^2`");
  });
});

describe("blocksToMarkdown: anidación (forma del capturador: hijos por block_id)", () => {
  it("lista anidada por sangría y toggle como encabezado en negrita + contenido", () => {
    const tree = blocksTree(
      "page",
      [
        rich("bulleted_list_item", [text("Padre")], {}, { id: "li-1", has_children: true }),
        rich("toggle", [text("TARJETAS ACTUALES", { bold: true })], {}, { id: "tg-1", has_children: true }),
      ],
      [
        blocksTree(
          "li-1",
          [rich("bulleted_list_item", [text("Hijo")], {}, { id: "li-2", has_children: true })],
          [blocksTree("li-2", [rich("numbered_list_item", [text("Nieto")])])],
        ),
        blocksTree("tg-1", [paragraphBlock("p", "Dentro del toggle"), rich("to_do", [text("tarea")], { checked: false })]),
      ],
    );
    expect(blocksToMarkdown(tree)).toBe(
      ["- Padre", "  - Hijo", "    1. Nieto", "", "**TARJETAS ACTUALES**", "", "  Dentro del toggle", "", "  - [ ] tarea"].join("\n"),
    );
  });

  it("un subárbol marcado como ciclo (cycle_or_reuse) no rinde nada ni rompe", () => {
    const tree = blocksTree(
      "page",
      [rich("toggle", [text("Bucle")], {}, { id: "t", has_children: true })],
      [{ block_id: "t", cycle_or_reuse: true }],
    );
    expect(blocksToMarkdown(tree)).toBe("**Bucle**");
  });

  it("column_list / column / synced_block son transparentes: solo su contenido", () => {
    const tree = blocksTree(
      "page",
      [
        block("column_list", {}, { id: "cl", has_children: true }),
        block("synced_block", { synced_from: null }, { id: "sb", has_children: true }),
      ],
      [
        blocksTree(
          "cl",
          [block("column", { width_ratio: 0.5 }, { id: "c1", has_children: true }), block("column", { width_ratio: 0.5 }, { id: "c2", has_children: true })],
          [blocksTree("c1", [paragraphBlock("a", "Izquierda")]), blocksTree("c2", [paragraphBlock("b", "Derecha")])],
        ),
        blocksTree("sb", [paragraphBlock("c", "Sincronizado")]),
      ],
    );
    expect(blocksToMarkdown(tree)).toBe("Izquierda\n\nDerecha\n\nSincronizado");
  });

  it("acepta también bloques con `children` anidados en línea y `{results}` de la API", () => {
    const nested = {
      ...rich("bulleted_list_item", [text("Padre")], {}, { has_children: true }),
      children: [rich("bulleted_list_item", [text("Hijo")])],
    };
    expect(blocksToMarkdown([nested])).toBe("- Padre\n  - Hijo");
    expect(blocksToMarkdown({ object: "list", results: [paragraphBlock("p", "Plano")] })).toBe("Plano");
  });

  it("las respuestas paginadas del capturador se concatenan en orden", () => {
    const tree = {
      block_id: "page",
      responses: [
        { object: "list", results: [paragraphBlock("a", "Página 1")], has_more: true },
        { object: "list", results: [paragraphBlock("b", "Página 2")], has_more: false },
      ],
      children: [],
    };
    expect(blocksToMarkdown(tree)).toBe("Página 1\n\nPágina 2");
  });
});

describe("blocksToMarkdown: tablas", () => {
  function row(cells: string[]): Json {
    return block("table_row", { cells: cells.map((cell) => [text(cell)]) });
  }

  it("con cabecera de columna: primera fila como encabezado; las barras se escapan", () => {
    const tree = blocksTree(
      "page",
      [block("table", { table_width: 2, has_column_header: true, has_row_header: false }, { id: "tb", has_children: true })],
      [blocksTree("tb", [row(["Pendiente", "Responsable"]), row(["Enviar a|b", "Ernesto"])])],
    );
    expect(blocksToMarkdown(tree)).toBe("| Pendiente | Responsable |\n| --- | --- |\n| Enviar a\\|b | Ernesto |");
  });

  it("sin cabecera: fila de encabezado vacía para que siga siendo tabla; rellena celdas que faltan", () => {
    const tree = blocksTree(
      "page",
      [block("table", { table_width: 3, has_column_header: false, has_row_header: false }, { id: "tb", has_children: true })],
      [blocksTree("tb", [row(["a", "b"]), row(["c", "d", "e"])])],
    );
    expect(blocksToMarkdown(tree)).toBe("|  |  |  |\n| --- | --- | --- |\n| a | b |  |\n| c | d | e |");
  });

  it("una table_row suelta fuera de su tabla no rinde nada", () => {
    expect(blocksToMarkdown([row(["x"])])).toBe("");
  });
});

describe("blocksToMarkdown: adjuntos, enlaces y páginas", () => {
  const SIGNED = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/obj/image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600";

  it("imagen firmada de Notion: enlace de imagen con la URL tal cual + aviso de caducidad", () => {
    const md = blocksToMarkdown([block("image", { caption: [], type: "file", file: { url: SIGNED, expiry_time: "2026-09-05T22:14:35.000Z" } })]);
    expect(md).toBe(`![image.png](${SIGNED}) (URL firmada de Notion: puede caducar)`);
  });

  it("imagen externa: sin aviso; el pie es el texto del enlace", () => {
    const md = blocksToMarkdown([block("image", { caption: [text("Captura del flujo")], type: "external", external: { url: "https://cdn.example/a.png" } })]);
    expect(md).toBe("![Captura del flujo](https://cdn.example/a.png)");
  });

  it("file / pdf / video / audio: enlace con nombre (name, pie o último segmento de la ruta)", () => {
    const md = blocksToMarkdown([
      block("file", { caption: [], type: "file", name: "informe.html", file: { url: "https://s3.example/x/informe.html?sig=1" } }),
      block("pdf", { caption: [], type: "external", external: { url: "https://docs.example/guia.pdf" } }),
      block("video", { caption: [], type: "external", external: { url: "https://youtu.be/abc" } }),
      block("audio", { caption: [text("Nota de voz")], type: "external", external: { url: "https://cdn.example/nota.mp3" } }),
    ]);
    expect(md).toBe(
      [
        "[informe.html](https://s3.example/x/informe.html?sig=1) (URL firmada de Notion: puede caducar)",
        "",
        "[guia.pdf](https://docs.example/guia.pdf)",
        "",
        "[abc](https://youtu.be/abc)",
        "",
        "[Nota de voz](https://cdn.example/nota.mp3)",
      ].join("\n"),
    );
  });

  it("bookmark, embed y link_preview: enlace con la URL (o su pie)", () => {
    const md = blocksToMarkdown([
      block("bookmark", { caption: [], url: "https://app.hubspot.com/workflows/1/edit" }),
      block("link_preview", { url: "https://docs.google.com/document/d/abc/edit" }),
      block("embed", { caption: [text("Tablero")], url: "https://miro.example/board" }),
    ]);
    expect(md).toBe(
      [
        "[https://app.hubspot.com/workflows/1/edit](https://app.hubspot.com/workflows/1/edit)",
        "",
        "[https://docs.google.com/document/d/abc/edit](https://docs.google.com/document/d/abc/edit)",
        "",
        "[Tablero](https://miro.example/board)",
      ].join("\n"),
    );
  });

  it("child_page / child_database → [[Título]] (recortado); link_to_page → [[page:id]]", () => {
    const md = blocksToMarkdown([
      block("child_page", { title: "Marketing " }, { has_children: true }),
      block("child_database", { title: "Cronograma Implementación " }),
      block("link_to_page", { type: "page_id", page_id: "ad880cc5-91ee-82e2-bc96-819055f35f1d" }),
    ]);
    expect(md).toBe("[[Marketing]]\n\n[[Cronograma Implementación]]\n\n[[page:ad880cc5-91ee-82e2-bc96-819055f35f1d]]");
  });

  it("un adjunto sin URL no rinde nada", () => {
    expect(blocksToMarkdown([block("image", { caption: [], type: "file", file: {} })])).toBe("");
  });
});

describe("blocksToMarkdown: omisiones y desconocidos", () => {
  it("unsupported se omite; sin bloques o solo vacíos → cadena vacía (el importador pone null)", () => {
    expect(blocksToMarkdown([block("unsupported", { block_type: "drive" })])).toBe("");
    expect(blocksToMarkdown([])).toBe("");
    expect(blocksToMarkdown(null)).toBe("");
    expect(blocksToMarkdown(undefined)).toBe("");
    expect(blocksToMarkdown(blocksTree("page", []))).toBe("");
    expect(blocksToMarkdown([rich("paragraph", []), rich("numbered_list_item", [])])).toBe("");
  });

  it("table_of_contents / breadcrumb / template se omiten", () => {
    expect(
      blocksToMarkdown([block("table_of_contents", { color: "default" }), block("breadcrumb", {}), paragraphBlock("p", "Solo esto")]),
    ).toBe("Solo esto");
  });

  it("tipo desconocido con rich_text → texto plano; sin rich_text → se omite", () => {
    expect(blocksToMarkdown([rich("futuro_bloque", [text("Texto ", {}), text("plano", { bold: true })])])).toBe("Texto **plano**");
    expect(blocksToMarkdown([block("otro_futuro", { algo: 1 })])).toBe("");
  });

  it("un bloque sin `type` o una entrada que no es bloque se ignora sin lanzar", () => {
    expect(blocksToMarkdown([{ id: "x" }, "cadena", 42, null, paragraphBlock("p", "Vale")])).toBe("Vale");
  });

  it("no acumula más de una línea en blanco seguida", () => {
    const md = blocksToMarkdown([
      paragraphBlock("a", "A"),
      rich("paragraph", []),
      block("unsupported", { block_type: "drive" }),
      rich("paragraph", []),
      paragraphBlock("b", "B"),
    ]);
    expect(md).toBe("A\n\nB");
    expect(md.includes("\n\n\n")).toBe(false);
  });
});

describe("blocksToMarkdown: página realista completa", () => {
  it("rinde un cuerpo típico de tarea de Sixteam en el orden de origen", () => {
    const tree = blocksTree(
      "page",
      [
        rich("heading_2", [text("Descripción")], { is_toggleable: false }),
        rich("paragraph", [text("Entregable: enviar a "), text("Juliana", { bold: true }), text(" el "), text("brief", {}, "https://docs.example/brief")]),
        rich("heading_2", [text("Checklist")], { is_toggleable: false }),
        rich("to_do", [text("Crear formulario")], { checked: true }, { id: "td-1", has_children: true }),
        rich("to_do", [text("Configurar workflow")], { checked: false }),
        block("divider", {}),
        block("image", { caption: [], type: "file", file: { url: "https://s3.example/img.png?X-Amz-Expires=3600" } }),
        block("bookmark", { caption: [], url: "https://app.hubspot.com/workflows/1" }),
      ],
      [blocksTree("td-1", [rich("bulleted_list_item", [text("Campo propietario")])])],
    );
    expect(blocksToMarkdown(tree)).toBe(
      [
        "## Descripción",
        "",
        "Entregable: enviar a **Juliana** el [brief](https://docs.example/brief)",
        "",
        "## Checklist",
        "",
        "- [x] Crear formulario",
        "  - Campo propietario",
        "- [ ] Configurar workflow",
        "",
        "---",
        "",
        "![img.png](https://s3.example/img.png?X-Amz-Expires=3600) (URL firmada de Notion: puede caducar)",
        "",
        "[https://app.hubspot.com/workflows/1](https://app.hubspot.com/workflows/1)",
      ].join("\n"),
    );
  });
});
