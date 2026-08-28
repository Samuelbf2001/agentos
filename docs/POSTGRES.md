# POSTGRES — backend alternativo (Postgres / Supabase + pgvector)

> Fase 2. **SQLite sigue siendo el default.** Postgres se activa por configuración,
> no por decreto: `AGENTOS_DB_DRIVER=postgres`. Si no tocas nada, nada cambia.
>
> La ganancia que justifica todo esto: **pgvector en el Context Hub**. Hoy
> `knowledge.search` es coincidencia de palabras (FTS5); con pgvector busca por
> **significado**, que es lo que convierte el Context Hub en un "LLM wiki" por
> cliente.

---

## 1. Cuándo migrar (los 5 disparadores)

De `ARCHITECTURE.md §5`, sin cambios. **Cualquiera dispara; antes, no.**

| # | Disparador | Por qué SQLite deja de bastar |
|---|---|---|
| 1 | **>1 proceso escritor** | `apps/api` deja de ser el dueño único de la DB (p.ej. el MCP admin escribiendo en su propio proceso, o dos instancias de la API). |
| 2 | **Acceso remoto multi-usuario concurrente** | El equipo entra desde fuera de la máquina de Ernesto. |
| 3 | **DB > 5 GB** | Transcripciones y `events` acumulados. |
| 4 | **Autorización por fila por cliente** | Cada cliente ve solo lo suyo → RLS de Postgres/Supabase. |
| 5 | **Búsqueda vectorial** | ← **este es el que ya está sobre la mesa.** |

Los cuatro primeros son de escala; el quinto es de producto. Se puede activar
Postgres solo por el quinto y seguir siendo un despliegue de un solo usuario.

---

## 2. Cómo se activa

```bash
AGENTOS_DB_DRIVER=postgres
AGENTOS_PG_URL=postgres://usuario:clave@host:5432/agentos
```

Sin `AGENTOS_DB_DRIVER`, o con `sqlite`, todo sigue exactamente como hoy y
`postgres-js` ni siquiera se carga (el backend PG vive en un *entrypoint*
separado, `@agentos/db/pg`).

`AGENTOS_DB_DRIVER` admite `sqlite | postgres` (+ alias `pg`, `supabase`).
Un valor desconocido **falla explícito** — nunca cae en silencio a SQLite.

### Postgres local con pgvector (Docker)

```bash
docker run -d --name agentos-pg \
  -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=agentos -e POSTGRES_DB=agentos \
  -p 55432:5432 pgvector/pgvector:pg16

# Windows PowerShell
$env:AGENTOS_PG_URL = "postgres://agentos:agentos@localhost:55432/agentos"
pnpm --filter @agentos/db migrate:pg
```

`migrate:pg` aplica las 23 tablas **y** deja listas las estructuras de búsqueda
(tsvector + pgvector). Imprime qué quedó disponible:

```
Migraciones Postgres aplicadas.
  búsqueda por texto : tsvector (spanish)
  búsqueda semántica : pgvector vector(1536) + HNSW
```

### Supabase

1. Proyecto nuevo → **Database → Extensions → activar `vector`**.
2. Copiar la cadena de conexión.
   - **Direct connection** (puerto `5432`): úsala para migraciones y para la
     herramienta de copia de datos.
   - **Transaction pooler** (puerto `6543`, o `?pgbouncer=true`): úsala para la
     app. El cliente lo **detecta solo** y apaga los *prepared statements* con
     nombre (`prepare: false`, `max: 1`), que es lo que PgBouncer en modo
     transacción exige. No hay que configurar nada a mano.
3. `AGENTOS_PG_URL=...` y `pnpm --filter @agentos/db migrate:pg`.

> ⚠️ La contraseña vive **solo** en la variable de entorno. Los logs de la
> herramienta de migración la redactan (`postgres://user:***@host/db`), y en la
> DB seguimos guardando **solo el NOMBRE** de las variables de credenciales
> (`provider_profiles.api_key_env`), nunca el valor — NFR-11 intacto.

---

## 3. Búsqueda semántica (pgvector) y embeddings

| Variable | Default | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | — | Sin ella **no hay semántica**, y eso está bien: se degrada a tsvector. |
| `AGENTOS_EMBEDDING_PROVIDER` | `openai` si hay key, si no `none` | `openai` \| `mock` \| `none`. |
| `AGENTOS_EMBEDDING_MODEL` | `text-embedding-3-small` | Modelo de embeddings. |
| `AGENTOS_EMBEDDING_DIM` | `1536` | Debe coincidir con `vector(N)` de la columna. |
| `AGENTOS_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Para proveedores compatibles con OpenAI. |

**Degradación limpia, en tres niveles.** Nada de esto lanza excepciones:

1. Sin `OPENAI_API_KEY` → `resolveEmbeddingProvider()` devuelve `null`;
   `semanticSearchDocs` responde `{ mode: "keyword", degradedReason: "…" }` con
   los resultados de tsvector.
2. Sin extensión `vector` (Postgres gestionado que no la ofrece) →
   `ensurePgSearch` lo reporta en `PgSearchCapabilities.vectorUnavailableReason`
   y el resto del arranque sigue.
3. Dimensión del proveedor ≠ dimensión de la columna → degrada a `keyword` en
   vez de escribir vectores corruptos.

### Indexar el Context Hub

- Al escribir: `createDoc(db, doc, { embedder })` / `upsertDoc(...)` vectorizan
  el documento en el momento.
- En bloque: `backfillKnowledgeEmbeddings(db, embedder)` recorre lo que falta
  (o lo que se vectorizó con **otro** modelo — se compara `embedding_model`).
- Tras copiar datos: `pnpm --filter @agentos/db migrate-to-pg --embed`.

### Cambiar de modelo de embeddings

La dimensión está en el DDL. Cambiar de modelo obliga a recrear la columna:

```sql
ALTER TABLE knowledge_docs DROP COLUMN embedding;
```
…y volver a llamar a `migrate:pg` con el nuevo `AGENTOS_EMBEDDING_DIM`, seguido
de un backfill. `ensurePgSearch` **se niega** a continuar si detecta la
discrepancia, con el mensaje exacto de qué hacer: no corrompe el índice en
silencio.

### Índice vectorial

Por defecto **HNSW** con `vector_cosine_ops` (mejor recall/latencia).
`ensurePgSearch(db, { vectorIndex: "ivfflat" })` si la RAM aprieta;
`"none"` para no indexar (escaneo secuencial, correcto pero lento).

Los filtros por `org_id` / `project_id` se aplican **después** del recorrido del
índice. A la escala de un Context Hub por cliente (miles de docs) es irrelevante;
si algún día no lo fuera, la salida es un índice parcial por organización.

---

## 4. Migrar los datos de una `agentos.db` existente

```bash
pnpm --filter @agentos/db migrate-to-pg                    # usa AGENTOS_DB_PATH y AGENTOS_PG_URL
pnpm --filter @agentos/db migrate-to-pg --from ./data/agentos.db --to postgres://…
pnpm --filter @agentos/db migrate-to-pg --dry-run          # solo cuenta, no escribe
pnpm --filter @agentos/db migrate-to-pg --no-schema        # no aplica migraciones antes
pnpm --filter @agentos/db migrate-to-pg --embed            # vectoriza al terminar
```

Lo que garantiza:

- **Orden topológico**: las 23 tablas se copian en un orden en el que ninguna FK
  apunta a algo que aún no existe. Las auto-FKs (`tasks.parent_task_id`,
  `runs.parent_run_id`, `agents.reports_to`, `module_launches.previous_launch_id`)
  se resuelven ordenando por fecha de creación dentro de cada tabla.
- **Idempotencia**: lee las PKs ya presentes en destino y las salta. Re-ejecutar
  no duplica ni falla; el informe separa `insertadas` de `ya estaban`.
- **Sin conversiones a mano**: lee con el esquema Drizzle de SQLite y escribe con
  el de Postgres. `0/1 → boolean`, `TEXT → jsonb` y epoch ms los hace el ORM. La
  correspondencia la valida el **compilador** (los tipos de fila son
  estructuralmente idénticos; hay un test que lo fija).
- **No toca el origen**: la SQLite se abre y se cierra sin escribir.

Informe real de la `agentos.db` de desarrollo (558 filas, 23 tablas):

```
Origen  : …\data\agentos.db
Destino : postgres://agentos:***@localhost:55432/agentos_real
Esquema : 23 tablas aplicadas · tsvector(spanish) · pgvector(1536)
Copiando (orden topológico):
  organizations        origen=     3  insertadas=     3  ya estaban=     0  destino=     3
  …
  events               origen=   345  insertadas=   345  ya estaban=     0  destino=   345
  module_launches      origen=     1  insertadas=     1  ya estaban=     0  destino=     1

Total: 558 filas insertadas de 558 en origen (795 ms). Integridad: OK ✓
```

> Migra siempre una **COPIA** primero. Si la API está corriendo, copia también
> `agentos.db-wal` y `agentos.db-shm`, o los últimos commits no estarán en el
> fichero principal.

---

## 5. Qué cambia y qué NO cambia

### No cambia

| | |
|---|---|
| **Las 23 tablas** | Mismos nombres de tabla, columna, índice y índice único. Incluido el **único parcial** `uq_phase_modules_slug_active` (Postgres lo soporta nativo). |
| **Las convenciones de §5** | `id` TEXT uuidv7 (generado en JS, nunca en SQL), `*_at` epoch ms, JSON estructurado, `version` para optimistic locking. |
| **El claim atómico** | `UPDATE … WHERE status='READY' AND (lease vencido o nulo)` es atómico por fila en Postgres igual que en SQLite. `changes=0` se traduce a `RETURNING id` vacío. Verificado con 8 clientes concurrentes: gana exactamente uno y `attempts` sube **una** vez. |
| **`expected_version`** | Idéntico: conflicto → `version_conflict`, nunca last-write-wins. |
| **La superficie de repositorios** | Mismos nombres de función, mismos argumentos, mismos tipos de fila (NFR-9: fuera de `packages/db` no se toca nada). |
| **El contrato de `rank`** | En FTS5 menor = mejor; `ts_rank` es al revés. Devolvemos `-ts_rank` para que el llamante no tenga que saber qué motor hay debajo. |
| **`snippet()` → `ts_headline`** | Mismos marcadores `«` `»`, mismo tamaño de extracto. |

### Sí cambia

| | |
|---|---|
| **Índices de búsqueda** | FTS5 (tablas virtuales + 6 triggers espejo) → columnas `tsvector` **generadas** + GIN. En Postgres los triggers espejo **sobran**: la columna se mantiene sola. |
| **`seq` de `events`** | En SQLite el mono-escritor bastaba. En Postgres (READ COMMITTED) dos sesiones pueden leer el mismo `max(seq)`, así que la asignación va dentro de una transacción con `pg_advisory_xact_lock(hashtext(topic))`. El `unique(topic, seq)` sigue siendo la red. Verificado con 15 escritores concurrentes: seqs 1..15, sin huecos ni duplicados. |
| **Agregados** | `count(*)` es `bigint` y el driver lo entrega como **string**. Los repositorios PG castean (`::int`, `::float8`) para devolver `number`, como promete el contrato. *(Esto fue un bug real que solo apareció al correr la suite contra Postgres de verdad.)* |
| **`json_extract`** | Función de SQLite. En Postgres, operador `->>`. |
| **Pragmas** | `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` no existen; su equivalente es la configuración del servidor. |

### Lo que **NO** es portable tal cual — dilo en voz alta

**Los repositorios SQLite son SÍNCRONOS y los de Postgres son ASÍNCRONOS.**
`better-sqlite3` es síncrono por diseño y **no existe** un driver Postgres
síncrono para Node. La *forma* de la API es idéntica —mismos nombres, mismos
argumentos, mismos tipos de fila— pero el llamante debe `await`.

Consecuencia práctica y honesta:

- `packages/db` está **completo** para los dos motores.
- `packages/core`, `apps/api`, `apps/mcp-admin` y las tools llaman a los
  repositorios de forma síncrona. Para que Postgres sea el motor **en ejecución**
  falta una fase mecánica —pero real— de `async/await` en esos llamantes.
- Por eso el switch es por configuración y el default sigue siendo SQLite: esto
  **habilita** Postgres, no lo impone. NFR-9 se cumple en lo que promete —el
  cambio de motor no se filtra fuera de la capa de datos como *cambio de forma*—
  y donde no puede cumplirse (sync→async) está documentado aquí en vez de
  escondido.
- El **motor de launch de Módulos de Fase** (`src/modules/launch.ts`) es el otro
  pendiente: depende de la transacción **síncrona** de better-sqlite3
  (`db.$client.transaction(...)`, que solo revierte callbacks síncronos). Su
  equivalente en Postgres es `db.transaction(async tx => …)`, que es *mejor*
  (revierte también en async), pero es una reescritura, no una traducción
  mecánica. No está portado.

### Mejora opcional documentada: `FOR UPDATE SKIP LOCKED`

El claim actual (UPDATE condicional) es **correcto** en Postgres: los
competidores se serializan sobre la fila y solo uno ve `status='READY'`.
`SELECT … FOR UPDATE SKIP LOCKED` sería una mejora **de rendimiento** cuando el
despachador saque N tareas de la cola en lote y no quiera que los perdedores
esperen el lock. No es un requisito de corrección y no está implementado.

---

## 6. Tests

```bash
# Sin AGENTOS_PG_URL: la suite PG se auto-omite y todo sigue verde.
pnpm -r test

# Con Postgres de verdad:
docker run -d --name agentos-pg -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=agentos \
  -e POSTGRES_DB=agentos -p 55432:5432 pgvector/pgvector:pg16
$env:AGENTOS_PG_URL = "postgres://agentos:agentos@localhost:55432/agentos"
pnpm --filter @agentos/db test
```

- `test/pg-portability.test.ts` — corre **siempre**, sin Postgres: equivalencia
  de esquema (23 tablas en ambos motores), orden topológico de la copia,
  equivalencia de **tipos** en tiempo de compilación, resolución de driver,
  detección del pooler de Supabase, redacción de contraseñas y el proveedor de
  embeddings (mock determinista, degradación sin key).
- `test/pg-backend.test.ts` — `describe.skipIf(!AGENTOS_PG_URL)`: migración de
  esquema, round-trip de repositorios, **claim atómico con 8 clientes
  concurrentes**, `seq` con 15 escritores, tsvector, pgvector con el embedder
  mock, degradaciones, y la copia de datos (incluida su idempotencia).

---

## 7. Referencias

- `ARCHITECTURE.md §5` — reglas de portabilidad y los 5 disparadores.
- `PRD.md` NFR-9 — "migrar a Postgres no toca código fuera de la capa de datos".
- `packages/db/src/search.ts` — el equivalente tsvector ya estaba documentado ahí
  desde el día 1; `packages/db/src/pg/search-pg.ts` es su implementación.
