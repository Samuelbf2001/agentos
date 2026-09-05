export type JsonObject = Record<string, unknown>;

export interface PaginatedJson {
  items: JsonObject[];
  pages: JsonObject[];
}

export interface NotionReader {
  getComments(blockId: string): Promise<PaginatedJson>;
  getDatabase(databaseId: string): Promise<JsonObject>;
  getPage(pageId: string): Promise<JsonObject>;
  getPageProperty(pageId: string, propertyId: string): Promise<PaginatedJson>;
  getBlockChildren(blockId: string): Promise<PaginatedJson>;
  queryDatabase(databaseId: string): AsyncIterable<JsonObject>;
}

export class NotionReadError extends Error {
  override name = "NotionReadError";

  constructor(
    readonly status: number,
    message = `Notion respondió ${status}`,
  ) {
    super(message);
  }
}

export interface NotionReaderOptions {
  apiVersion: string;
  fetchFn?: typeof fetch;
  /** Intentos ante 429 o 5xx antes de abandonar una llamada. */
  maxAttempts?: number;
  /** Espaciado mínimo entre llamadas: Notion admite del orden de 3 por segundo. */
  minIntervalMs?: number;
  token: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Respeta `Retry-After` cuando Notion lo envía; si no, retrocede exponencialmente. */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers?.get?.("retry-after");
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("La API de Notion devolvió un JSON no esperado");
  }
  return value as JsonObject;
}

function asResults(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function nextCursor(value: JsonObject): string | undefined {
  return typeof value.next_cursor === "string" && value.next_cursor ? value.next_cursor : undefined;
}

/** Read-only client. It exposes no POST/PATCH/DELETE endpoint except Notion's query API. */
export class NotionApiReader implements NotionReader {
  private readonly fetchFn: typeof fetch;
  private readonly maxAttempts: number;
  private readonly minIntervalMs: number;
  /** Momento más temprano permitido para la siguiente llamada. */
  private nextSlot = 0;

  constructor(private readonly options: NotionReaderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.minIntervalMs = options.minIntervalMs ?? 340;
  }

  /** Serializa las llamadas para no superar el límite de tasa de Notion. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await delay(wait);
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<JsonObject> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      await this.throttle();
      const response = await this.fetchFn(`https://api.notion.com/v1${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Notion-Version": this.options.apiVersion,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (response.ok) return asRecord(await response.json());
      lastStatus = response.status;
      // 429 y 5xx son transitorios; cualquier otro estado es definitivo.
      if (response.status !== 429 && response.status < 500) throw new NotionReadError(response.status);
      if (attempt === this.maxAttempts - 1) break;
      await delay(retryAfterMs(response, attempt));
    }
    throw new NotionReadError(lastStatus);
  }

  async getDatabase(databaseId: string): Promise<JsonObject> {
    return this.request(`/databases/${encodeURIComponent(databaseId)}`);
  }

  async getPage(pageId: string): Promise<JsonObject> {
    return this.request(`/pages/${encodeURIComponent(pageId)}`);
  }

  async *queryDatabase(databaseId: string): AsyncIterable<JsonObject> {
    let cursor: string | undefined;
    do {
      const body: JsonObject = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const page = await this.request(`/databases/${encodeURIComponent(databaseId)}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      for (const item of asResults(page.results)) yield item;
      cursor = nextCursor(page);
    } while (cursor);
  }

  private async getPaginated(pathname: string): Promise<PaginatedJson> {
    const pages: JsonObject[] = [];
    const items: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);
      const delimiter = pathname.includes("?") ? "&" : "?";
      const page = await this.request(`${pathname}${delimiter}${params.toString()}`);
      pages.push(page);
      items.push(...asResults(page.results));
      cursor = nextCursor(page);
    } while (cursor);
    return { pages, items };
  }

  getBlockChildren(blockId: string): Promise<PaginatedJson> {
    return this.getPaginated(`/blocks/${encodeURIComponent(blockId)}/children`);
  }

  getComments(blockId: string): Promise<PaginatedJson> {
    return this.getPaginated(`/comments?block_id=${encodeURIComponent(blockId)}`);
  }

  getPageProperty(pageId: string, propertyId: string): Promise<PaginatedJson> {
    return this.getPaginated(`/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(propertyId)}`);
  }
}
