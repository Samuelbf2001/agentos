/**
 * Embeddings para la búsqueda semántica del Context Hub (pgvector).
 *
 * Principio rector: **degradación limpia**. Si no hay proveedor configurado,
 * `resolveEmbeddingProvider()` devuelve `null` y TODO sigue funcionando con
 * FTS5 (SQLite) o tsvector (Postgres). La búsqueda semántica es una MEJORA,
 * nunca un requisito de arranque.
 *
 * El proveedor es inyectable: los tests usan `MockEmbeddingProvider`
 * (determinista, sin red) y producción usa `OpenAIEmbeddingProvider`.
 *
 * Variables de entorno:
 *   AGENTOS_EMBEDDING_PROVIDER = openai | mock | none        (default: openai si hay key, none si no)
 *   AGENTOS_EMBEDDING_MODEL    = text-embedding-3-small      (default)
 *   AGENTOS_EMBEDDING_DIM      = 1536                        (default)
 *   AGENTOS_EMBEDDING_BASE_URL = https://api.openai.com/v1   (default; para compatibles OpenAI)
 *   OPENAI_API_KEY             = …                           (SOLO el nombre viaja a la DB, jamás el valor)
 */

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIM = 1536;

export interface EmbeddingProvider {
  /** Identificador estable para trazabilidad (p.ej. `openai:text-embedding-3-small`). */
  readonly id: string;
  /** Dimensión del vector. DEBE coincidir con `vector(N)` de la columna. */
  readonly dimensions: number;
  /** Devuelve un vector por cada texto, en el mismo orden. */
  embed(texts: string[]): Promise<number[][]>;
}

// ── Mock determinista (tests, sin red, sin coste) ───────────────────────────

/**
 * Bag-of-words con hashing: cada término cae siempre en el mismo bucket, así
 * que dos textos que comparten vocabulario quedan CERCA en coseno y dos que no
 * lo comparten quedan LEJOS. Suficiente para probar el pipeline vectorial de
 * punta a punta de forma reproducible.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(dimensions: number = DEFAULT_EMBEDDING_DIM) {
    this.dimensions = dimensions;
    this.id = `mock:bow-${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const terms = tokenize(text);
    for (const term of terms) {
      const h = fnv1a(term);
      const bucket = h % this.dimensions;
      // Signo derivado del hash: evita que todo el vector sea positivo.
      const sign = (h >>> 31) % 2 === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    return l2normalize(vec);
  }
}

// ── OpenAI (y compatibles) ──────────────────────────────────────────────────

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? DEFAULT_EMBEDDING_DIM;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `openai:${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // text-embedding-3-* admite acortar la dimensión sin reentrenar.
        dimensions: this.dimensions,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Embeddings ${this.model}: HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`Embeddings ${this.model}: se pidieron ${texts.length} y llegaron ${data.length}`);
    }
    const out = new Array<number[]>(texts.length);
    for (const item of data) out[item.index] = item.embedding;
    return out as number[][];
  }
}

// ── Resolución por entorno (degradación limpia) ─────────────────────────────

export interface ResolveEmbeddingOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Devuelve el proveedor configurado o `null` si no hay ninguno.
 * `null` NO es un error: significa "solo búsqueda por palabras" (FTS/tsvector).
 */
export function resolveEmbeddingProvider(
  opts: ResolveEmbeddingOptions = {},
): EmbeddingProvider | null {
  const env = opts.env ?? process.env;
  const dimensions = Number(env.AGENTOS_EMBEDDING_DIM ?? DEFAULT_EMBEDDING_DIM);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`AGENTOS_EMBEDDING_DIM="${env.AGENTOS_EMBEDDING_DIM}" no es un entero positivo.`);
  }

  const explicit = (env.AGENTOS_EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "none") return null;
  if (explicit === "mock") return new MockEmbeddingProvider(dimensions);

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    if (explicit === "openai") {
      throw new Error(
        "AGENTOS_EMBEDDING_PROVIDER=openai pero OPENAI_API_KEY está vacía. " +
          "Deja el proveedor sin configurar para caer limpiamente en tsvector.",
      );
    }
    return null; // ← degradación limpia: sin key, sin semántica, todo sigue vivo.
  }

  return new OpenAIEmbeddingProvider({
    apiKey,
    model: env.AGENTOS_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    dimensions,
    baseUrl: env.AGENTOS_EMBEDDING_BASE_URL,
    fetchImpl: opts.fetchImpl,
  });
}

// ── Utilidades ──────────────────────────────────────────────────────────────

/** Serializa un vector al literal que entiende pgvector: `[0.1,0.2,…]`. */
export function toPgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length > 1);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    // Vector nulo: pgvector rechaza el coseno contra el cero. Un 1 en el bucket 0.
    const fallback = new Array<number>(vec.length).fill(0);
    fallback[0] = 1;
    return fallback;
  }
  return vec.map((v) => v / norm);
}
