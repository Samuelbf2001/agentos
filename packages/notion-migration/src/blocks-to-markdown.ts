/**
 * Bloques de Notion → Markdown legible. Módulo PURO: sin disco, sin red, sin
 * base de datos y sin dependencias. Es lo que el importador vuelca en
 * `tasks.description` a partir del cuerpo de la página.
 *
 * Acepta las dos formas en que viajan los bloques:
 *
 * 1. El **árbol del capturador** (`snapshot.ts#captureBlocks`, y el mismo
 *    objeto dentro de `notion_page_archives.payload.blocks`):
 *    `{ block_id, responses: [{ results: Block[] }], children: Tree[] }`.
 *    Los hijos NO van anidados dentro de cada bloque: cada subárbol de
 *    `children` se identifica por `block_id === bloque.id`.
 * 2. Una **lista plana** de bloques de la API (`Block[]`, o `{ results: Block[] }`),
 *    opcionalmente con `children: Block[]` anidados dentro de cada bloque.
 *
 * Reglas de traducción (ver README del paquete / tests):
 * - rich_text: **negrita**, *cursiva*, ~~tachado~~, `código`, [enlace](url);
 *   una mención de página/usuario/fecha usa su `plain_text`.
 * - heading_1..3 → `#`, `##`, `###`; un encabezado "toggleable" se trata igual.
 * - listas con anidación por sangría (2 espacios por nivel); numeradas
 *   consecutivas dentro de su grupo.
 * - to_do → `- [ ]` / `- [x]`.
 * - toggle → línea en negrita + contenido sangrado.
 * - code → cerca con lenguaje. quote / callout → `>`. divider → `---`.
 * - table → tabla Markdown (primera fila como cabecera si `has_column_header`;
 *   si no, cabecera vacía para que siga siendo tabla válida).
 * - image / file / pdf / video / audio / bookmark / embed / link_preview →
 *   enlace con su URL tal cual. Las URLs `file` de Notion van firmadas y
 *   CADUCAN (1 h): se dejan igual y se anota entre paréntesis.
 * - child_page / child_database → `[[Título]]`. link_to_page → `[[page:id]]`.
 * - column_list / column / synced_block → solo su contenido.
 * - unsupported → se omite. Tipo desconocido → texto plano si tiene
 *   `rich_text`; si no, se omite.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── rich_text ───────────────────────────────────────────────────────────────

/**
 * Un `rich_text` de Notion a Markdown en línea. Las anotaciones se aplican por
 * fragmento, respetando los espacios de borde (Notion parte "hola **mundo** "
 * en fragmentos cuyos espacios quedan fuera de los marcadores para que el
 * Markdown siga siendo válido).
 */
export function richTextToMarkdown(richText: unknown): string {
  return asArray(richText)
    .map((item) => {
      const fragment = asRecord(item);
      const type = str(fragment.type);
      const raw = str(fragment.plain_text) ?? (type === "text" ? str(asRecord(fragment.text).content) : undefined) ?? "";
      if (raw.length === 0) return "";
      const annotations = asRecord(fragment.annotations);
      const href = str(fragment.href) ?? str(asRecord(asRecord(fragment.text).link).url);
      // Una ecuación va como código en línea: no hay Markdown estándar para LaTeX.
      if (type === "equation") return `\`${raw}\``;

      const leading = raw.match(/^\s*/u)?.[0] ?? "";
      const trailing = raw.match(/\s*$/u)?.[0] ?? "";
      let core = raw.slice(leading.length, raw.length - trailing.length);
      if (core.length === 0) return raw;
      if (annotations.code === true) core = `\`${core}\``;
      if (annotations.bold === true) core = `**${core}**`;
      if (annotations.italic === true) core = `*${core}*`;
      if (annotations.strikethrough === true) core = `~~${core}~~`;
      if (href) core = `[${core}](${href})`;
      return `${leading}${core}${trailing}`;
    })
    .join("");
}

function plainOf(richText: unknown): string {
  return asArray(richText)
    .map((item) => str(asRecord(item).plain_text) ?? "")
    .join("");
}

// ── Normalización de la entrada ─────────────────────────────────────────────

interface Node {
  block: JsonRecord;
  type: string;
  children: Node[];
}

type ChildLookup = (blockId: string) => Node[];

function fromBlockList(blocks: unknown[], lookup: ChildLookup): Node[] {
  const nodes: Node[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    const type = str(block.type);
    if (!type) continue;
    const id = str(block.id);
    // Hijos anidados en el propio bloque (forma 2) o resueltos por id (forma 1).
    const inline = asArray(block.children);
    const children =
      inline.length > 0 ? fromBlockList(inline, lookup) : id && block.has_children === true ? lookup(id) : [];
    nodes.push({ block, type, children });
  }
  return nodes;
}

/** Árbol del capturador → nodos con hijos resueltos por `block_id`. */
function fromCaptureTree(tree: JsonRecord): Node[] {
  const subtrees = new Map<string, JsonRecord>();
  for (const child of asArray(tree.children)) {
    const record = asRecord(child);
    const id = str(record.block_id);
    if (id) subtrees.set(id, record);
  }
  const lookup: ChildLookup = (blockId) => {
    const subtree = subtrees.get(blockId);
    // `cycle_or_reuse`: el capturador cortó un ciclo — no hay contenido que rendir.
    if (!subtree || subtree.cycle_or_reuse === true) return [];
    return fromCaptureTree(subtree);
  };
  const blocks: unknown[] = [];
  for (const response of asArray(tree.responses)) blocks.push(...asArray(asRecord(response).results));
  return fromBlockList(blocks, lookup);
}

function normalize(input: unknown): Node[] {
  if (Array.isArray(input)) return fromBlockList(input, () => []);
  const record = asRecord(input);
  if (Array.isArray(record.responses)) return fromCaptureTree(record);
  if (Array.isArray(record.results)) return fromBlockList(record.results, () => []);
  return [];
}

// ── Render ──────────────────────────────────────────────────────────────────

const HEADING_LEVEL: Readonly<Record<string, number>> = { heading_1: 1, heading_2: 2, heading_3: 3 };
const LIST_TYPES = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);
const FILE_TYPES = new Set(["image", "file", "pdf", "video", "audio"]);
const LINK_TYPES = new Set(["bookmark", "embed", "link_preview"]);
const TRANSPARENT_TYPES = new Set(["column_list", "column", "synced_block"]);
const EXPIRING_NOTE = "(URL firmada de Notion: puede caducar)";

function indent(lines: string[], prefix: string): string[] {
  return lines.map((line) => (line.length > 0 ? `${prefix}${line}` : line));
}

function blankJoin(chunks: string[][]): string[] {
  const output: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    if (output.length > 0) output.push("");
    output.push(...chunk);
  }
  return output;
}

/** URL y nombre de un bloque de archivo/medio (`file` firmado o `external`). */
function fileTarget(payload: JsonRecord): { url: string; expiring: boolean; name: string | null } | null {
  const kind = str(payload.type);
  const url = kind === "file" ? str(asRecord(payload.file).url) : kind === "external" ? str(asRecord(payload.external).url) : undefined;
  if (!url) return null;
  return { url, expiring: kind === "file", name: str(payload.name) ?? null };
}

function fileLabel(type: string, payload: JsonRecord, target: { url: string; name: string | null }): string {
  const caption = richTextToMarkdown(payload.caption).trim();
  if (caption) return caption;
  if (target.name) return target.name;
  const fallback: Record<string, string> = {
    image: "imagen",
    file: "archivo",
    pdf: "PDF",
    video: "vídeo",
    audio: "audio",
  };
  const base = fallback[type] ?? type;
  // Sin nombre ni pie: el último segmento de la ruta suele ser el nombre real.
  try {
    const last = decodeURIComponent(new URL(target.url).pathname.split("/").filter(Boolean).pop() ?? "");
    return last && last !== base ? last : base;
  } catch {
    return base;
  }
}

function renderTable(node: Node): string[] {
  const table = asRecord(node.block.table);
  const rows = node.children
    .filter((child) => child.type === "table_row")
    .map((child) => asArray(asRecord(child.block.table_row).cells).map((cell) => richTextToMarkdown(cell).replace(/\|/gu, "\\|").trim()));
  if (rows.length === 0) return [];
  const width = Math.max(
    Number(table.table_width) || 0,
    ...rows.map((row) => row.length),
  );
  const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => "")];
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const separator = line(Array.from({ length: width }, () => "---"));
  const hasHeader = table.has_column_header === true;
  const header = hasHeader ? pad(rows[0]!) : Array.from({ length: width }, () => "");
  const body = hasHeader ? rows.slice(1) : rows;
  return [line(header), separator, ...body.map((row) => line(pad(row)))];
}

interface RenderContext {
  /** Índice dentro del grupo de lista numerada; se reinicia al cambiar de tipo. */
  numbered: number;
}

function renderNode(node: Node, context: RenderContext): string[] {
  const { type, block } = node;
  const payload = asRecord(block[type]);
  const childLines = (): string[] => renderNodes(node.children);

  if (type === "unsupported") return [];

  if (type in HEADING_LEVEL) {
    const text = richTextToMarkdown(payload.rich_text).trim();
    const head = text ? [`${"#".repeat(HEADING_LEVEL[type]!)} ${text}`] : [];
    return blankJoin([head, childLines()]);
  }

  if (type === "paragraph") {
    const text = richTextToMarkdown(payload.rich_text);
    return blankJoin([text.trim() ? [text] : [], indent(childLines(), "  ")]);
  }

  if (LIST_TYPES.has(type)) {
    const text = richTextToMarkdown(payload.rich_text).trim();
    const nested = indent(renderNodes(node.children), "  ");
    // Un elemento vacío y sin hijos (Notion los deja al borrar texto) no
    // rinde nada — y no consume número de la lista.
    if (!text && nested.length === 0) return [];
    let marker = "-";
    if (type === "numbered_list_item") {
      context.numbered += 1;
      marker = `${context.numbered}.`;
    } else if (type === "to_do") {
      marker = payload.checked === true ? "- [x]" : "- [ ]";
    }
    return [`${marker} ${text}`.trimEnd(), ...nested];
  }

  if (type === "toggle") {
    const text = richTextToMarkdown(payload.rich_text).trim();
    // Cabecera en negrita; si el texto ya viene íntegramente en negrita
    // (caso habitual en Notion) no se duplica el marcador.
    const alreadyBold = text.startsWith("**") && text.endsWith("**") && text.length > 4;
    const head = text ? [alreadyBold ? text : `**${text}**`] : [];
    return blankJoin([head, indent(childLines(), "  ")]);
  }

  if (type === "code") {
    const language = str(payload.language) ?? "";
    const body = plainOf(payload.rich_text);
    const caption = richTextToMarkdown(payload.caption).trim();
    return blankJoin([[`\`\`\`${language === "plain text" ? "" : language}`, ...body.split("\n"), "```"], caption ? [caption] : []]);
  }

  if (type === "quote" || type === "callout") {
    const text = richTextToMarkdown(payload.rich_text);
    const icon = asRecord(payload.icon);
    const emoji = type === "callout" ? str(icon.emoji) : undefined;
    const first = emoji ? `${emoji} ${text}` : text;
    const inner = blankJoin([first.trim() ? first.split("\n") : [], childLines()]);
    return inner.map((line) => (line.length > 0 ? `> ${line}` : ">"));
  }

  if (type === "divider") return ["---"];

  if (FILE_TYPES.has(type)) {
    const target = fileTarget(payload);
    if (!target) return [];
    const label = fileLabel(type, payload, target);
    const link = type === "image" ? `![${label}](${target.url})` : `[${label}](${target.url})`;
    return [target.expiring ? `${link} ${EXPIRING_NOTE}` : link];
  }

  if (LINK_TYPES.has(type)) {
    const url = str(payload.url);
    if (!url) return [];
    const caption = richTextToMarkdown(payload.caption).trim();
    return [`[${caption || url}](${url})`];
  }

  if (type === "child_page" || type === "child_database") {
    const title = str(payload.title)?.trim();
    return title ? [`[[${title}]]`] : [];
  }

  if (type === "link_to_page") {
    const target = str(payload.page_id) ?? str(payload.database_id);
    return target ? [`[[page:${target}]]`] : [];
  }

  if (type === "table") return renderTable(node);
  if (type === "table_row") return []; // Solo tiene sentido dentro de `table`.

  if (type === "equation") {
    const expression = str(payload.expression);
    return expression ? [`\`${expression}\``] : [];
  }

  if (type === "table_of_contents" || type === "breadcrumb" || type === "template") {
    return [];
  }

  if (TRANSPARENT_TYPES.has(type)) return childLines();

  // Tipo desconocido: texto plano si lo tiene; si no, se omite.
  const text = richTextToMarkdown(payload.rich_text).trim();
  return blankJoin([text ? [text] : [], childLines()]);
}

function renderNodes(nodes: Node[]): string[] {
  const output: string[] = [];
  const context: RenderContext = { numbered: 0 };
  let previousType: string | null = null;
  for (const node of nodes) {
    if (node.type === "unsupported" || node.type === "table_row") continue;
    if (node.type !== "numbered_list_item") context.numbered = 0;
    const lines = renderNode(node, context);
    if (lines.length === 0) continue;
    const isList = LIST_TYPES.has(node.type);
    const previousIsList = previousType !== null && LIST_TYPES.has(previousType);
    // Elementos de lista consecutivos van pegados; cualquier otro cambio de
    // bloque se separa con una línea en blanco.
    if (output.length > 0 && !(isList && previousIsList)) output.push("");
    output.push(...lines);
    previousType = node.type;
  }
  return output;
}

/**
 * Rinde bloques de Notion a Markdown. Devuelve `""` si no hay nada que mostrar
 * (sin bloques, solo párrafos vacíos, solo `unsupported`...), para que el
 * importador pueda dejar `description = null`.
 */
export function blocksToMarkdown(blocks: unknown): string {
  const lines = renderNodes(normalize(blocks));
  // Colapsa líneas en blanco repetidas y recorta bordes.
  return lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
