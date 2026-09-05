# Qué existe hoy y qué no — AgentOS frente al PRD v1.1

> Inventario verificado contra el código el 2026-09-05, no contra la documentación. Cuatro exploraciones
> independientes: capa de datos, runtime de agentes, interfaz y canales, estado de trabajo. Cada línea
> tiene evidencia en `archivo:línea`. Complementa `PRD-v1.1-sistema-completo.md`, no lo reemplaza.

## Veredicto

La plataforma **existe y funciona**: tablero con máquina de estados, agentes que trabajan, módulos de
fase que se disparan, 516 tests verdes, 73 herramientas de administración por MCP. Lo que el PRD v1.1
pide encima de eso está **casi todo sin construir**: de las 27 entidades nuevas del 2brain, cero
existen; de las 13 capacidades de interfaz, una existe completa.

La buena noticia es que el cimiento es mejor de lo que el PRD asumía en tres puntos concretos
(procesos, límites de delegación, catálogos versionados). La mala es que tres supuestos del PRD son
falsos hoy: no hay multi-tenant de ningún tipo, WhatsApp no envía mensajes, y Postgres es código que
nadie ejecuta.

Antes de construir nada nuevo hay una deuda de higiene que domina todo lo demás: **71 entradas sin
commitear y ningún remoto de git**.

---

## 1. El cimiento que sí existe

| Pieza | Estado | Evidencia |
|---|---|---|
| Tablero con máquina de estados, claim por lease, `expected_version` | Sólido | `packages/core/src/board/engine.ts` |
| 25 tablas de datos (organizaciones, proyectos, tareas, agentes, runs, spans, aprobaciones, auditoría) | Sólido | `packages/db/src/schema.ts` (676 líneas) |
| Módulos de fase: launch transaccional, snapshot inmutable, cierre de fase, cadencia | Sólido | `packages/db/src/modules/launch.ts:347,440`; `packages/core/src/modules.ts:90,334,489` |
| Gateway único de herramientas: resolver, kill switch, allowlist, Gate 2, auditoría previa | Sólido | `packages/tools/src/gateway.ts:53,101-168` |
| Catálogos como datos versionados (agentes, metodologías, módulos) con `seed_hash` | Sólido | `packages/db/src/seed-sources.ts:115,139,208` |
| MCP de administración: 73 herramientas, perfiles lectura/escritura | Sólido | `apps/mcp-admin/src/registry.ts:59-63` |
| Prompts versionados e inmutables, edición en caliente sin pisar el seed | Sólido | `packages/db/src/repositories/agents.ts:55-127` |
| Presupuesto por ejecución y por fase, kill switch global | Sólido | `packages/shared/src/project-budget.ts`; `apps/api/src/dispatcher.ts:126-151,414-424` |
| Diez vistas web: chat, tablero, cerebro, reuniones, wizard, enjambre, runs, esperando, contexto, admin | Sólido | `apps/web/src/App.tsx:183-197` |
| Módulo de proyectos y tareas (responsables, vencimientos, avisos) | Construido, **sin commitear** | rutas en `apps/api/src/routes/board.ts:155-660` |
| 58 archivos de test, ~516 casos | Sólido | conteo por área en el informe de runtime |

---

## 2. Tres cosas que el PRD subestimaba (aprovechables tal cual)

**Procesos ya es una entidad rica.** Tiene `variant` as-is/to-be con enumeración propia, pasos en JSON
estilo SIPOC, sistemas, puntos de dolor, referencias ISO y trazabilidad a documentos
(`packages/db/src/schema.ts:534-556`). El PRD planteaba crear el versionado as-is/to-be desde cero: ya
está. El trabajo real es normalizar los pasos de JSON a tabla y abrir escritura por API, porque hoy
solo se editan por MCP (`apps/api/src/routes/ops.ts:318-328`).

**Los límites de delegación ya existen.** Profundidad máxima 3 y abanico máximo 4 por ejecución, con
recuento real sobre eventos de tarea (`packages/core/src/board/engine.ts:898-926`). El PRD proponía
profundidad 2 y abanico 5 para micro-agentes: es el mismo patrón, ya probado, aplicado a tareas en
lugar de a sub-ejecuciones.

**La API del organigrama de agentes está construida y muerta.** `GET /api/agents/org` devuelve el árbol
con salud de cadena de mando y detección de ciclos, con tests (`apps/api/src/routes/ops.ts:86-95`), y
la interfaz web nunca la llama. Es la capacidad con menor distancia entre lo que hay y lo que se pide.

---

## 3. Cinco supuestos del PRD que hoy son falsos

**1. No hay multi-tenant de ninguna clase.** La sesión guarda solo persona y vencimiento
(`apps/api/src/auth.ts:15-20`). El gateway de herramientas nunca consulta la organización. La tabla de
agentes ni siquiera tiene columna de organización. Los documentos de conocimiento admiten organización
nula (`packages/db/src/schema.ts:492`), así que un documento huérfano es visible en cualquier consulta
que no lo excluya. El aislamiento hoy depende de quien llama, no del sistema.

**2. WhatsApp existe, pero solo lee.** El conector consulta cinco endpoints del servidor para traer
reuniones, contactos y expedientes al Context Hub
(`apps/api/src/connectors/whatsapphub.ts:262-304`). No envía ni recibe mensajes. El único canal de
conversación es la web. El PRD lo necesita bidireccional para entrevistas, aviso al campeón y soporte.
El envío de correo también es un simulacro declarado (`packages/tools/src/tools/email.ts:13-28`).

**3. Postgres está escrito y nadie lo ejecuta.** Hay dos implementaciones completas de repositorios,
las de SQLite síncronas y las de Postgres asíncronas, y la aplicación importa solo las primeras
(`apps/api/src/context.ts:6-15`). Falta el repositorio de módulos en Postgres, así que el lanzamiento
de fases ni siquiera es portable. pgvector se crea pero ningún consumidor lo usa: la búsqueda real es
texto completo de SQLite.

**4. Los gates nombrados no tienen dónde guardarse.** Solo existe un gate, `g1_plan`, y aprobar
cualquier otro nombre devuelve error (`packages/core/src/board/engine.ts:78,682-685`). Las aprobaciones
no tienen campo de gate, ni rol de aprobador, ni organización. Los diez gates del PRD necesitan primero
esas tres columnas.

**5. No hay RAG en el prompt.** El contexto se arma con la metodología completa en texto plano y un
índice de títulos de hasta 20 documentos (`packages/core/src/prompt/assemble.ts:127,135-143`). La
recuperación queda a criterio del agente y va siempre a búsqueda por texto. La LLM Wiki aparece solo
como un contador agregado en el cerebro: no hay integración de agente, ni curador, ni sincronización
dentro de este repositorio. La decisión de que la wiki sea la capa de conocimiento está por construir
entera.

---

## 4. Semáforo por capacidad del PRD v1.1

### Datos y 2brain

| Capacidad | Estado | Qué falta |
|---|---|---|
| Grafo organizacional (departamentos, roles, personas por rol, funciones) | **No existe** | Las cuatro tablas. Hoy `people.role` es texto libre sin relación |
| Pasos de proceso como entidad con RACI | **Parcial** | Existen como JSON dentro del proceso; falta tabla, responsable por paso y referencia estable |
| Variante as-is/to-be y diff | **Parcial** | La variante existe en procesos; falta cadena de origen, tipo de cambio y cálculo del diff |
| Inventario de sistemas del cliente y sus capacidades | **Parcial** | Existe como lista de texto dentro del proceso; falta entidad propia, capacidades y qué proceso soporta |
| Entrevistas y guías | **No existe** | Ambas tablas. Hoy una entrevista es un documento markdown sin estructura |
| Hallazgos, brechas, decisiones | **No existe** | Las tres tablas. Hoy son documentos sin puntaje ni orden |
| Planes, palancas, sprints | **No existe** | Las tres. Sprint solo existe como tipo de actividad de una tarea |
| Templates de implementación e instancias | **No existe** | Ambas |
| Aprendizajes | **No existe** | La tabla |
| Contexto por herramienta y catálogo de plataformas | **No existe** | Ambas |
| Snapshots del grafo | **No existe** | La tabla, aunque el patrón ya está probado en el snapshot de blueprint |
| Multi-tenant (membresías, organización activa) | **No existe** | Todo: tabla de membresías, organización en sesión, verificación en el gateway |

Confirmado una por una: **ninguna de las 27 entidades nuevas del PRD existe**, en ninguna forma.

### Runtime de agentes

| Capacidad | Estado | Qué falta |
|---|---|---|
| Especificación declarativa de agente | **Parcial** | El frontmatter admite 8 campos. Faltan tamaño, alcance, harness, contextos, expiración, organización |
| Micro-agente invocable como herramienta | **No existe** | Ninguna herramienta resuelve a un agente. El tipo de traza existe pero nadie lo emite |
| Límites de profundidad y abanico | **Existe** | Aplicado a tareas (3 y 4), no a sub-ejecuciones |
| Contexto por herramienta en dos capas | **No existe** | Las herramientas tienen una sola capa de definición |
| Generación de agentes por plan | **Parcial** | Se pueden crear y clonar a mano por MCP; sin origen de plan ni expiración |
| Agente de PM, de soporte, entrevistador | **No existen** | Los tres. El roster son siete agentes |
| Loop de vigilancia con cadencia | **Parcial** | Hay tick, recolector de leases y renacimiento de cadencia; sin vigilancia por agente ni cron |
| Harness de desarrollo | **No existe** | Ninguna referencia. Claude Code sobre workspace es lo más cercano |
| Gates nombrados y aprobación en lote | **No existen** | Solo `g1_plan`; una aprobación por llamada |
| Lista de MCP permitidos por agente | **Decorativa** | La columna existe y se puede escribir, pero ningún componente la lee en ejecución |

### Interfaz y canales

| Capacidad | Estado | Qué falta |
|---|---|---|
| Bandeja de aprobaciones | **Existe** | Aprobación en lote |
| Visualizador de organigrama | **Parcial** | React Flow instalado y usado solo para el enjambre; sin datos de organización que pintar |
| Visualizador de procesos BPMN | **No existe** | La librería no está instalada; hoy los procesos son una fila de tabla |
| Mapa de herramientas | **Parcial** | El cerebro lista capacidades internas, no el inventario del cliente |
| Edición humana del grafo | **No existe** | El enjambre es de solo lectura por diseño |
| Interfaz de entrevistas | **No existe** | Todo |
| Decks HTML y export a PPTX | **No existe** | Ninguna librería ni generador. Los informes se escriben a mano |
| Canal WhatsApp bidireccional | **Parcial** | El conector solo lee. Falta el envío entero |
| Selector de organización, vista de sprints, portal de cliente | **No existen** | Los tres |

---

## 5. La deuda que bloquea, en orden

1. **Commitear las 71 entradas y crear un remoto de git.** Unas 9.300 líneas entre modificadas y nuevas,
   sin copia fuera de este disco, sin ramas ni stashes. Cualquier rama nueva parte de un árbol sucio.
2. **Reconciliar la base de datos viva con el repositorio.** La base tiene 25 tablas con la migración
   0005 aplicada; el esquema commiteado tiene 23. Restaurar desde git dejaría la aplicación rota contra
   su propia base.
3. **Cerrar la QA del módulo de proyectos y tareas.** El descriptor está escrito, sin veredicto.
4. **Portar la aplicación a Postgres asíncrono**, incluido el repositorio de módulos que falta. Es
   requisito de multi-tenant, de pgvector y del despliegue.
5. **Multi-tenant mínimo**: membresías, organización en la sesión, verificación en el gateway.
6. **Higiene**: fin de línea uniforme, verificación única, y reservar índices de migración. El siguiente
   libre es 0006 en SQLite y 0002 en Postgres, pero 0005 aún no está commiteado.

Nota sobre Notion: el paquete de migración está escrito y **nunca se ha ejecutado**, no existe la
carpeta de instantáneas, y el ecosistema sigue escribiendo a Notion hoy. El PRD asume que Notion se
retira; entre esa premisa y la realidad hay dos fases sin ejecutar.

---

## 6. Qué cambia en la secuencia del PRD

La secuencia B0 a B12 del PRD sigue siendo correcta en dependencias, con tres ajustes:

- **Antes de B0 va un bloque de higiene** (commit, remoto, reconciliación de base, QA pendiente). No es
  trabajo de producto, pero sin él no hay punto de retorno.
- **B2 (grafo) es más barato de lo previsto y B3 (visualizador) más caro.** Procesos ya existe con
  variante y pasos; en cambio no hay ninguna librería de diagramas de proceso instalada ni ningún grafo
  editable en la interfaz.
- **B9 (WhatsApp) es un bloque de construcción, no de integración.** Lo que existe es un lector. El
  envío, la conversación y la conversión de requerimiento en tarea están enteros por hacer, y bloquean
  al agente de PM, a las entrevistas por ese canal y al agente de soporte.

Una cuarta consideración: la decisión de que **la LLM Wiki sea la única capa de conocimiento** (sección
3.5 del PRD) hoy no tiene ninguna base en el código. No hay integración de wiki para agentes dentro de
AgentOS. Ese bloque debe entrar explícitamente en la secuencia, probablemente junto a B1, porque
condiciona dónde se guarda todo lo narrativo del assessment.
