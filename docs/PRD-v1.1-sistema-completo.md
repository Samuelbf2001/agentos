# PRD v1.1 — AgentOS "Sistema completo" (Assessment → Implementación → Soporte)

> Extensión de `PRD.md` (constitución y MVP) y de `PRD-modulos-fase.md` (módulos de fase). No reemplaza
> ninguno de los dos: donde este documento cambia algo lo dice explícitamente, el resto sigue vigente.
> Fecha: 2026-09-05. Estado: **borrador para revisión con Ernesto**. Metodología de trabajo: borrador
> completo → presentación → corrección. Por decisión de Ernesto, este documento no lleva fechas ni
> cronograma; la secuencia de construcción (§14) está ordenada por dependencia, no por calendario.
>
> Este PRD se lee junto a `MODELO-TENANCY-v1.4.md` (modelo de tenancy), `PLAN-v1.5-EXPERIENCIA.md`
> (arquitectura de experiencia), `DIRECCION-VISUAL.md` (sistema visual) y `REFERENTES-Puzzle-Wonderful.md`
> (referentes). Donde este PRD y esos documentos difieran, mandan los documentos posteriores.

## 0. Qué cambia respecto a v1

| Cambio | Dónde impacta |
|---|---|
| El principio #4 de la constitución ("sin multi-tenant") pasa a **multi-tenant**: varias organizaciones cliente en el mismo sistema | `PRD.md` §0; gateway de tools, sesión, auditoría (§3.3, §10) |
| **Notion se retira**: AgentOS es la única herramienta de tareas, para humanos y agentes | Módulo Implementación (§4.2); depende de cerrar el "Módulo Proyectos/Tareas" pendiente (§13, riesgo 9) |
| Nace el **grafo organizacional de la empresa cliente** (2brain de empresa): departamentos, roles, personas, funciones, procesos con pasos RACI, herramientas | §3.1, ~13 entidades nuevas |
| Nace el **2brain del proyecto de ejecución**, separado del de la empresa | §3.2 |
| Nace el **SDK de agentes**: spec declarativa extendida, contexto por herramienta en dos capas, micro-agentes invocables como tool, generación de agentes por plan | §6 |
| **Nuevos agentes**: PM agent (Pat), agente de soporte, micro-agente entrevistador, micro-agentes generados por plan; Clara y Debbie se extienden | §2, §6.5 |
| **Nuevos gates**: G0, G-ASIS, G-TOBE, G-ARQ, G-AGENT, G-SPRINT, G-GOLIVE, G-SOPORTE (G1 y G2 ya existían) | §8 |
| **Slides y visualizador**: deck HTML/PPTX generado desde el grafo; organigrama en React Flow, procesos en bpmn-js, edición humana con regla anti-pisado | §9 |
| **Arquitectura de plataformas** como decisión humana trazable (custom vs. SaaS), con catálogo semilla y mapeo de brechas al plan | §7 |
| Metodología de entrevistas se referencia contra **ISO 9001, BPMN 2.0 y SIPOC**, en clave ágil y no de certificación | §4.1 |
| El modelo de tenancy pasa a **agencia y clientes**: Sixteam es un tenant de agencia, cada empresa cliente es un tenant de tipo cliente | §3.3; documento de tenancy `MODELO-TENANCY-v1.4.md` |
| Nace el **costeo de procesos** como salida del assessment: costo por paso y cifra de ahorro frente al estado actual | §4.1 |
| Se añaden **capacidades de inteligencia de interacción** al módulo de soporte: trazabilidad, etiquetado, patrones y alertas | §4.3 |
| Nace el **agente para empleados del cliente**, distinto del agente de soporte y de los expertos | §2.2, §6.5 |

## 1. Visión y porqué

Ernesto lo dice con precisión: **"es un sistema, ni siquiera una plataforma"**. AgentOS v1.1 no es una
pantalla más ni un módulo más: es la organización explícita de cómo trabaja el sistema completo —
roles, personas, funciones y procesos de una empresa cliente, entendidos por entrevista y convertidos
en datos que un agente y un humano pueden leer, corregir y accionar. El sistema entrevista para
discernir lo que una persona **hace** hoy y lo que **debería hacer**, con ambas fuentes de verdad: lo que
dice el propio rol y lo que espera su superior, contrastado contra un catálogo de referencia
metodológico. De esa brecha sale un **plan**, del plan sale una **arquitectura** (qué plataformas usar,
qué agentes construir) y de la arquitectura salen **tareas** ejecutables por un equipo de agentes y
humanos.

El ciclo Entender → Construir → Operar de `PRD.md` no cambia de forma, se completa de contenido. En
Entender, el sistema no solo produce un informe: construye y mantiene el **2brain de la empresa
cliente**, una base tipada de su organización que sigue viva después del assessment. En Construir, ese
plan se traduce en épicas y tareas que un **agente de Project Management** coordina, apoyado por
expertos que acumulan contexto por cada herramienta que tocan (HubSpot, GHL, un ERP), no por dominio
fijo. Ese trabajo de ejecución vive en su propio **2brain del proyecto** — plan, arquitectura, sprints,
aprendizajes — distinto del 2brain de la empresa pero enlazado a él. En Operar, el sistema no se apaga:
entra en **loops** de mejora continua con propuestas que un humano aprueba, y un **agente de soporte por
WhatsApp** atiende dudas y convierte requerimientos en tareas, siempre con un humano validando el
resultado antes de darlo por cerrado.

Esta versión también asume una decisión de arquitectura de negocio: AgentOS pasa a ser
**multi-tenant** (varias organizaciones cliente conviviendo en el mismo sistema, antes prohibido por el
principio #4 de la constitución) y **Notion se retira** como herramienta de tareas: AgentOS es la única,
tanto para las personas de Sixteam como para los propios agentes. Esto no es una limpieza cosmética: es
la condición para que el sistema deje de vivir repartido entre herramientas y se convierta en la fuente
única de verdad que Ernesto pide.

**Criterio de éxito (una frase):** un cliente nuevo pasa por Assessment y termina con su organización,
procesos y herramientas mapeados y validados en su propio 2brain; ese mapeo se convierte en un plan y
una arquitectura que un equipo de agentes ejecuta con un humano en cada punto de riesgo; y, una vez en
producción, un agente de soporte y loops de mejora mantienen el sistema vivo sin que Sixteam tenga que
reconstruirlo desde cero en el siguiente cliente.

## 2. Usuarios y actores

### 2.1 Humanos

| Actor | Quién | Qué necesita del sistema |
|---|---|---|
| Operador Sixteam | Ernesto, Samuel y equipo | Lanzar módulos, aprobar gates, corregir agentes y grafo en caliente |
| Campeón de proyecto | Persona de Sixteam responsable de un proyecto específico | Ser notificado por WhatsApp cuando un humano del cliente se atrasa; aprobar cierre de sprint |
| Sponsor del cliente | Directivo que patrocina el engagement | Aprobar gates de alcance, to-be y arquitectura (coste) |
| Dueño de proceso | Responsable operativo de un proceso en la empresa cliente | Validar el grafo as-is de su proceso; aprobar go-live; validar resultados de soporte |
| Entrevistado | Cualquier persona de la empresa cliente | Responder la entrevista (por agente o por humano) |
| Equipo ejecutor | Personas de Sixteam asignadas a tareas de implementación | Tarjetas con contexto e insumos preparados (sin cambios respecto a `PRD.md` §2) |

### 2.2 Agentes

| Agente | Capa | Nuevo / extensión / sin cambios |
|---|---|---|
| Alex | Consultoría | Sin cambios de identidad; orquesta la arquitectura de agentes junto al PM agent (§6.5) |
| Sam | Consultoría | Extensión: entrevistas, extracción de grafo, hallazgos, gaps y propuesta to-be |
| **PM agent (Pat)** | Implementación | **Nuevo**: coordina el equipo de ejecución, palanca → épica → tareas, escalamiento al campeón |
| **Micro-agente entrevistador** | Consultoría (micro) | **Nuevo pero micro**: paraleliza entrevistas por persona, invocado por Sam |
| **Micro-agentes generados por plan** | Variable (micro, scope org) | **Nuevo**: catálogo fijo + generación por empresa/plan, aprobados en G-AGENT |
| Debbie | Implementación | Extensión: harness de desarrollo (referencias OpenClaw/Hermes) para plataformas a la medida — fase 2 |
| Vinnie | Implementación | Extensión: propone opciones de arquitectura de plataformas; invoca micro-agentes de integración |
| Sally | Operación | Sin cambios de identidad; acumula contexto por herramienta como el resto de expertos |
| Clara | Operación | Extensión: loop de mejora continua (`harness.loop: watchdog`, cadencia semanal) además de reportes |
| **Agente de soporte** | Operación | **Nuevo**: canal WhatsApp, requerimiento → tarea, HITL de tres pasos |
| **Agente para empleados del cliente** | Operación | **Nuevo**: responde dudas del personal del cliente sobre sus propios procesos y ejecuta acciones en sus sistemas |
| Quinn | Meta | Sin cambios: QA adversario, nunca aprueba ni cierra |

## 3. Modelo del 2brain

### 3.1 2brain de la empresa cliente

Entidades nuevas (ver diseño detallado en la adenda de arquitectura; aquí solo el qué y el porqué):

- **Departamento**: área de la organización, con jerarquía propia (árbol).
- **Rol**: puesto dentro de un departamento, con jerarquía de reporte independiente de la de persona.
- **Persona**: ya existe en el sistema; se relaciona con Rol N:N (una persona puede tener más de un rol,
  con dedicación parcial).
- **Función**: lo que un rol hace o debería hacer; un rol tiene varias funciones.
- **Proceso**: con pasos y responsable por paso en estilo RACI; un proceso involucra funciones de
  varios roles, no de uno solo.
- **Herramienta/Sistema**: inventario de lo que la empresa ya usa, con qué capacidades tiene cada
  herramienta y a qué proceso o función sirve. El inventario es **manual** en v1.1 (se captura en
  entrevista o formulario), no hay descubrimiento automático.
- **Hallazgo**: observación con evidencia, cuantificada cuando es posible.
- **Brecha**: la diferencia entre lo que un proceso, rol o herramienta hace y lo que debería hacer, con
  impacto, esfuerzo y dependencias.
- **Decisión**: cualquier elección trazable del proyecto (alcance, arquitectura, plataforma, proceso,
  agente), con opciones consideradas y quién decidió.

Todas estas entidades existen en dos variantes, **as-is** y **to-be**, con un mecanismo de diff: cada
fila to-be declara de qué fila as-is viene y qué tipo de cambio representa (sin cambios, modificado,
añadido, eliminado, fusionado, dividido). El diff no se guarda aparte, se calcula recorriendo esa
cadena y se muestra como tres listas (añadido / modificado / eliminado). Donde la inmutabilidad importa
— al aprobar un gate o al disparar el módulo de Implementación — el grafo se congela en una fotografía
(snapshot) que no cambia aunque el grafo vivo se siga editando después.

**Regla anti-pisado**: una vez que un humano valida una entidad del grafo, un nuevo re-run del agente
sobre esa misma entidad no la sobrescribe. Genera una propuesta de cambio que el humano acepta o
rechaza. Sin esta regla, la corrección humana se pierde en la siguiente entrevista y el visualizador
deja de ser confiable.

### 3.2 2brain del proyecto de ejecución

Distinto del 2brain de la empresa, aunque vive en el mismo sistema y está enlazado a él. Contiene:

- **Plan**: versión inmutable del plan aprobado, con las palancas priorizadas.
- **Palancas**: cada una referencia las brechas que ataca, los procesos objetivo, el impacto esperado
  y el módulo que la va a ejecutar. Es el insumo directo de la épica en Implementación.
- **Decisiones de arquitectura**: no es una entidad separada, son decisiones (de la misma tabla de
  decisiones del §3.1) con alcance "arquitectura" — un ADR necesita opciones, justificación y
  posibilidad de reemplazo, que ya provee esa tabla.
- **Sprints**: agrupan tareas de ejecución con fecha de inicio/fin y objetivo, sin tocar la máquina de
  estados de tareas ya existente.
- **Templates de implementación**: plantillas reutilizables de funcionalidad (p. ej. pipeline de ventas
  en GHL, onboarding de cliente) versionadas igual que las metodologías, que se instancian por proyecto
  y producen tareas.
- **Aprendizajes**: lo que un agente propone mejorar (una metodología, un módulo, un template, un
  agente, una guía de entrevista) a partir de lo vivido en el proyecto, con un humano que acepta o
  rechaza la propuesta. Es el circuito del principio #8 de la constitución: el contexto y la
  metodología son el activo, y se mejoran con cada engagement.

El enlace entre los dos 2brain no es una tabla genérica de relaciones: cada palanca referencia
explícitamente las brechas que ataca, y cada instancia de template referencia explícitamente el
proceso y la herramienta del grafo que toca.

### 3.3 Multi-tenant

Fuente de verdad: `MODELO-TENANCY-v1.4.md`. Este apartado resume lo que sigue vigente del PRD original;
ante cualquier diferencia, manda el documento de tenancy.

Es una sola plataforma con dos tipos de tenant: **agencia** (Sixteam, ve todos sus tenants cliente más
sus propias funciones) y **cliente** (una empresa cliente, ve solo lo suyo). Las funciones se reparten en
tres categorías: **solo agencia** (roster de agentes, catálogos, presupuesto, lanzamiento de módulos),
**solo cliente** (su organigrama, procesos, herramientas, entrevistas, plan) y **comunes con alcance
distinto** (tablero, aprobaciones, 2brain, documentos, informes), donde Sixteam ve el conjunto y el
cliente ve solo lo publicado para él.

El aislamiento no se logra separando la aplicación en dos superficies: cada ruta **declara su alcance**
(qué tipo de tenant y qué rol la pueden alcanzar) y una ruta sin declaración es inalcanzable, con
**denegación por defecto**. El gateway de tools aplica la misma regla a los agentes.

Lo que el cliente lee es una **fotografía**: informe, organigrama validado, roadmap y deck se publican
como copia congelada con fecha y autor, nunca el grafo vivo. Lo que el cliente escribe entra por una
**cápsula**: un enlace firmado para un objeto, un propósito y una fecha de caducidad, sin exigir cuenta
propia.

**RLS de Postgres queda fuera de v1.1** (se declara explícitamente, no es un olvido): se deja el terreno
listo (toda tabla raíz con columna de organización) pero el guard real en esta versión es el gateway, no
la base de datos.

### 3.4 Catálogos globales del activo Sixteam

Se mantienen y se amplían los catálogos que ya existen como "datos versionados, no código" (metodologías,
módulos de fase): se agregan **guías de entrevista** (por rol/área/industria), un **catálogo de
plataformas SaaS** semilla (HubSpot, GoHighLevel, Google Workspace, WhatsAppHub, Apollo, Stripe, Odoo,
Notion solo como lectura para migración), **templates de implementación**, y **contexto por
herramienta** en dos capas (global y por organización, ver §6.2). Todo esto es el activo compartido de
Sixteam entre clientes: se mejora una vez y sirve al siguiente engagement.

### 3.5 Un solo 2brain: la LLM Wiki es la capa de conocimiento

Hoy conviven dos almacenes de conocimiento: el Context Hub de AgentOS (documentos en Postgres con
pgvector) y la LLM Wiki (páginas markdown con curador RAG en el servidor). Por decisión de Ernesto, no
hay dos cosas. La regla de v1.1 es:

- **La wiki es la capa de conocimiento narrativo** y la única referencia: entrevistas, hallazgos,
  decisiones, guías de entrevista, contextos por herramienta, metodologías y aprendizajes son páginas
  de la wiki, con el índice RAG de la wiki como único índice de búsqueda para agentes y humanos.
- **AgentOS guarda solo lo estructurado**: el grafo (departamentos, roles, funciones, procesos, pasos,
  sistemas), brechas, planes, palancas, tareas, sprints, gates y auditoría. Es lo que necesita
  relaciones, versionado, puntajes y máquina de estados, y lo que alimenta el visualizador.
- **Cada entidad estructurada enlaza a su página wiki** y cada página wiki declara a qué organización
  pertenece. El registro de documentos de AgentOS deja de ser un almacén propio: pasa a ser el índice
  de páginas de la wiki (ruta, organización, huella de versión), de modo que la provenance `[doc:id]`
  siga funcionando sin duplicar contenido.

Consecuencia para los dos 2brains de §3.1 y §3.2: son dos espacios de la misma wiki (empresa cliente y
proyecto de ejecución), no dos sistemas. La separación entre wiki local y curador del servidor se
mantiene como sincronización, no como segunda fuente de verdad. **(supuesto)** el detalle de cómo se
aísla la wiki por organización (carpeta por cliente vs. metadato por página) se decide en la adenda de
arquitectura.

## 4. Flujo de trabajo del sistema

| # | Paso | Quién | Produce | Gate |
|---|---|---|---|---|
| 1 | Launch del módulo Consultoría | Humano | Proyecto, organización, backlog inicial | — |
| 2 | Kickoff con sponsor | Alex + humano | Perfil de organización, primeros departamentos | **G0** alcance |
| 3 | Guías y agenda de entrevistas | Sam | Entrevistas programadas | — |
| 4 | Entrevistas (agente por chat o WhatsApp; voz en fase siguiente; o humana con guía y transcripción) | Micro-agente entrevistador / humano + Fathom | Sesiones de entrevista y transcripciones | — |
| 5 | Extracción del grafo as-is | Sam | Roles, funciones, procesos, pasos, herramientas (borrador) | — |
| 6 | Corrección humana en el visualizador | Dueño de proceso | Entidades validadas | **G-ASIS** |
| 7 | Hallazgos y brechas | Sam + Clara | Hallazgos con evidencia, brechas priorizables | — |
| 8 | Propuesta to-be | Sam | Grafo to-be enlazado al as-is | — |
| 9 | Priorización de procesos | Agente calcula, humano decide | Plan y palancas priorizadas | **G-TOBE** |
| 10 | Arquitectura de plataformas | Vinnie propone, humano elige | Decisión custom/SaaS por proceso | **G-ARQ** |
| 11 | Arquitectura de agentes | Alex + PM agent | Specs de micro-agente propuestos | **G-AGENT** |
| 12 | Slides y cierre de Entender | Clara/Alex + humano | Deck del assessment, informe, roadmap | **G1** (existente) |
| 13 | Launch del módulo Implementación | Humano | Proyecto de construcción con inputs desde el plan | — |
| 14 | Palanca → épica → tareas | PM agent | Épicas, tareas, sprints, instancias de template | — |
| 15 | Ejecución | Debbie/Vinnie/Sally + micro-agentes + humanos | Artefactos técnicos | **G2** (existente) |
| 16 | Seguimiento: atrasos escalados al campeón, QA de Quinn | PM agent / Quinn | Notificación por WhatsApp, bugs abiertos | — |
| 17 | Cierre de sprint y go-live | Campeón + dueño de proceso | Artefacto de cierre de sprint | **G-SPRINT**, **G-GOLIVE** |
| 18 | Launch de Operación y loops de mejora | Humano / Clara (cadencia semanal) | Cadencia activa, propuestas de mejora | Aprobación consent-first |
| 19 | Soporte por WhatsApp | Agente de soporte | Respuesta o tarea de requerimiento | **G-SOPORTE** |
| 20 | Realimentación del activo | Humano acepta aprendizajes | Nueva versión de metodología/módulo/template/guía | — |

### 4.1 Assessment (fase Entender)

El agente construye el organigrama y el mapa de procesos a partir de entrevistas, guiado por
metodologías y organigramas de referencia; el humano corrige en el visualizador. Las entrevistas —por
agente o por humano, ambos modos coexisten— usan guías documentadas por rol/área/industria, referenciadas
contra **ISO 9001, BPMN 2.0 y SIPOC**, pero en una versión **intermedia y ágil, con visión sistémica
orientada a tecnología**: no se busca preparar una certificación exacta, se busca capturar procesos de
forma suficientemente estructurada para diseñar una arquitectura sobre ellos (esto no cambia el
principio #6 de la constitución: ISO sigue siendo preparación asistida, nunca certificación).

El objetivo de cada entrevista es capturar lo que la persona **hace** hoy y lo que **debería hacer**; si
tiene roles a cargo, también qué debería hacer cada uno de ellos. El "debería" sale de **dos fuentes**:
la entrevista al superior de esa persona, y el catálogo de referencia metodológico. Cuando ambas fuentes
no coinciden, el conflicto no lo resuelve el agente: queda como una decisión pendiente que el sponsor
resuelve en el gate correspondiente.

En paralelo se levanta el **mapeo de sistemas actuales**: qué herramientas tiene la empresa, qué hace
cada una, qué funciona bien y cómo, y a qué proceso o función sirve. Es un inventario manual (no hay
descubrimiento automático en v1.1) capturado en entrevista o formulario.

**Regla de automatizaciones externas**: cada flujo de n8n, HubSpot, Zapier o Make entra al mapa como
**un solo paso con enlace profundo a la herramienta**, nunca desglosado en sus nodos internos. Reflejar
el interior de cada automatización sería un pozo sin fondo imposible de mantener sincronizado.

De la comparación as-is/to-be sale un **scoring visible** de brechas por impacto, esfuerzo y
dependencias, sobre el que el humano decide qué procesos implementar primero. La arquitectura resultante
tiene dos partes: (a) **plataformas**, decisión humana entre a la medida o SaaS; y (b) **agentes**, la
estructura para construir el equipo que va a ejecutar el plan (ver §6 y §7). Todo esto se resume en
**slides** exportables (HTML primario, PPTX best effort) y queda persistido en el **2brain de la
empresa cliente**, dentro de AgentOS — no en Notion ni en una wiki externa.

**Costeo de procesos**: cada paso admite un costo. El sistema costea el proceso como corre hoy y la
versión propuesta, y la diferencia entre ambos costeos es la **cifra de ahorro** que se presenta al
sponsor, siempre enlazada a los pasos exactos de donde sale. Se costea también el **gasto anual por
herramienta**, atribuido a los procesos que la usan, como insumo de la decisión de comprar o construir
(§7). El costeo pasa a ser, junto al roadmap, la **salida principal del assessment**.

### 4.2 Implementación (fase Construir)

La metodología de ejecución es palanca del roadmap → épica → tareas, con sprints y gates entre ellos.
El **PM agent** (nuevo, no es Quinn) coordina al equipo de agentes que ejecuta el plan. Cuando un
humano se atrasa en una tarea, el PM agent lo detecta y notifica por WhatsApp al **campeón del
proyecto**, la persona de Sixteam responsable de ese proyecto específico. Quinn sigue siendo QA
adversario y nunca aprueba ni cierra nada.

Los agentes expertos existentes (Vinnie en integraciones, Sally en operación de revenue, Debbie en
construcción) se suman al trabajo de implementación, pero no se vuelven expertos fijos por herramienta:
**acumulan contexto por cada herramienta que van tocando** (HubSpot, GHL, un ERP), reutilizable en el
siguiente cliente. Las **templates de implementación** (pipeline de ventas, onboarding, reporte
semanal) reducen ese trabajo a editar poco, complementar y ejecutar. Quinn valida cada entregable antes
de darlo por cerrado.

### 4.3 Soporte (fase Operar)

Reutiliza al PM agent y sus funciones de seguimiento. Los agentes entran en **loop**: mejora continua y
recomendación de estrategias, con cadencia semanal **(supuesto)**, leyendo CRM, métricas y
conversaciones, y produciendo propuestas al tablero que un humano aprueba (consent-first, ya existente
en el módulo de Operación). El **agente de soporte** responde dudas y recibe requerimientos por
**WhatsApp**, conectado por MCP/APIs a las plataformas del cliente. Todo requerimiento se convierte en
tarea con **human-in-the-loop de tres pasos**: un humano aprueba, el sistema ejecuta, un humano valida
el resultado — no basta con aprobar y ejecutar.

## 5. User stories con criterios de aceptación

### Grafo y visualizador

**US-S1 — Generar el grafo as-is desde entrevistas y corregirlo en el visualizador.**
- CA-S1.1 Tras completar las entrevistas de un área, el sistema genera roles, funciones, procesos, pasos
  y herramientas en variante as-is y estado borrador.
- CA-S1.2 El organigrama se renderiza en React Flow y el mapa de procesos en bpmn-js; ninguna edición
  humana se hace por SQL directo, siempre por el servicio de dominio correspondiente.
- CA-S1.3 Al guardar una edición humana, la entidad pasa a estado validado con quién la validó; guardar
  sobre una versión desactualizada de la entidad falla en vez de sobrescribir en silencio.

**US-S2 — Regla anti-pisado entre agente y humano.**
- CA-S2.1 Un re-run del agente sobre una entidad ya validada no la sobrescribe: crea una propuesta de
  cambio separada.
- CA-S2.2 Aceptar la propuesta actualiza la entidad y conserva el historial de dónde viene; rechazarla
  no altera en nada lo ya validado.

**US-S3 — Diff as-is/to-be y snapshot de gate.**
- CA-S3.1 El diff entre as-is y to-be se calcula bajo demanda (no se guarda como tabla aparte) y se
  presenta como tres listas: añadido, modificado, eliminado.
- CA-S3.2 Al aprobar el gate de to-be, el grafo queda congelado en una fotografía con huella (hash); esa
  fotografía no cambia aunque el grafo vivo se siga editando después.

### Entrevistas

**US-S4 — Entrevista por agente en paralelo, por persona.**
- CA-S4.1 El micro-agente entrevistador corre una sesión por persona (chat web en v1.1; WhatsApp cuando
  exista el canal, §14 B9; voz en fase siguiente) y produce la sesión, la conversación y la
  transcripción tipada como documento de entrevista.
- CA-S4.2 La cobertura de la guía queda registrada por sesión; una entrevista con cobertura incompleta
  queda visible como pendiente en vez de descartarse en silencio.

**US-S5 — Entrevista humana con guía y transcripción.**
- CA-S5.1 Un humano puede tomar la entrevista con la misma guía generada para el agente, adjunta a la
  sesión.
- CA-S5.2 La transcripción de una reunión (vía Fathom) se enlaza a la misma entrevista y recibe el
  mismo tratamiento posterior (extracción de grafo) que una entrevista hecha por agente.

### Brechas, plan y arquitectura

**US-S6 — Hallazgos y brechas con las dos fuentes del "debería".**
- CA-S6.1 Cada brecha documenta su "hace" desde la entrevista a la persona y su "debería" desde la
  entrevista al superior más el catálogo de referencia; ambas fuentes quedan citadas en la brecha.
- CA-S6.2 Un conflicto entre ambas fuentes queda como decisión pendiente hasta que el sponsor lo
  resuelve en el gate de to-be; no lo resuelve el agente por su cuenta.

**US-S7 — Priorización visible y decisión humana del plan.**
- CA-S7.1 El puntaje de cada brecha (impacto, esfuerzo, dependencias) es visible en la interfaz antes de
  cualquier aprobación.
- CA-S7.2 Las palancas del plan solo pueden crearse a partir de brechas con decisión tomada; el gate de
  to-be bloquea el avance mientras existan brechas priorizadas sin decisión.

**US-S8 — Arquitectura de plataformas trazable.**
- CA-S8.1 Toda decisión de plataforma registra al menos dos opciones evaluadas (a la medida y SaaS) con
  su puntaje de ajuste, costo anual y riesgo de dependencia del proveedor, y queda ligada a la
  aprobación del gate correspondiente.
- CA-S8.2 Toda funcionalidad del to-be sin cobertura de plataforma ("brecha de herramienta") genera
  automáticamente una brecha del plan; no puede quedar sin registro.

### SDK de agentes

**US-S9 — Invocar un micro-agente como tool con límites duros.**
- CA-S9.1 Invocar un agente como tool solo funciona si el destino es un micro-agente marcado como
  invocable; invocar un agente "empleado" de esa forma devuelve error.
- CA-S9.2 La profundidad máxima de invocación es 2 (empleado → micro → nada) y el máximo de invocaciones
  por turno es 5; superar cualquiera de los dos límites aborta la sub-ejecución, verificado por prueba
  automatizada.
- CA-S9.3 Las herramientas permitidas al micro-agente son la intersección con las del agente que lo
  invoca, nunca una lista más amplia; el micro hereda la organización activa y no puede cambiarla.

**US-S10 — Generar y aprobar un micro-agente nuevo por plan.**
- CA-S10.1 Un micro-agente propuesto por el plan requiere aprobación humana explícita antes de existir;
  al aprobarse queda con autonomía supervisada, herramientas contenidas en las de quien lo propuso, y
  una fecha de expiración obligatoria (no puede quedar vacía).
- CA-S10.2 Al expirar o archivarse, el micro-agente deja de ser asignable a tareas nuevas; sus
  ejecuciones pasadas permanecen intactas y consultables.

### Implementación / PM

**US-S11 — El PM agent coordina palanca → épica → tareas.**
- CA-S11.1 Al lanzar el módulo de Implementación, cada palanca aprobada del plan genera un grupo de
  tareas (una épica y sus tareas hijas) asignado a un sprint.
- CA-S11.2 Si una tarea asignada a un humano vence su fecha límite, el PM agent genera una notificación
  por WhatsApp al campeón del proyecto sin intervención manual.

**US-S12 — Templates de implementación instanciables.**
- CA-S12.1 Instanciar un template sobre un proceso y una herramienta objetivo crea las tareas
  correspondientes con parámetros verificados por tipo, trazables hasta el template de origen.
- CA-S12.2 Quinn puede abrir un defecto sobre cualquier tarea derivada de un template, pero no puede
  aprobarla ni cerrarla.

### Soporte / HITL

**US-S13 — Agente de soporte por WhatsApp.**
- CA-S13.1 Un mensaje entrante al canal de soporte del cliente continúa la conversación existente o
  abre una nueva, y si es un requerimiento genera una tarea en el backlog citando el mensaje original.
- CA-S13.2 Ninguna tarea generada por el agente de soporte sale del backlog sin pasar por el gate de
  soporte.

**US-S14 — HITL de tres pasos en soporte.**
- CA-S14.1 El gate de soporte exige tres estados distintos y auditados —aprobar, ejecutar, validar
  resultado—; una tarea que se ejecuta sin haber sido aprobada, o que no se valida después de
  ejecutarse, no puede marcarse como cerrada.
- CA-S14.2 El nivel de riesgo de la tarea determina quién debe validar el resultado; por defecto valida
  el dueño del proceso afectado.

### Slides

**US-S15 — Deck de assessment regenerable sin perder overrides.**
- CA-S15.1 Cada slide del deck declara de qué entidades sale su contenido; regenerar el deck después de
  corregir el grafo actualiza el contenido derivado y conserva los ajustes manuales guardados por
  slide.
- CA-S15.2 El export a HTML siempre está disponible; si el export a PPTX falla, no bloquea la
  disponibilidad del HTML (best effort, declarado como tal en el producto).

### Multi-tenant

**US-S16 — Aislamiento de organización fail-closed en el gateway.**
- CA-S16.1 Toda acción de un agente resuelve la organización activa en el gateway antes de aplicar
  política y ejecutar; un intento de actuar fuera de esa organización se rechaza sin ejecutar nada,
  verificado por prueba automatizada.
- CA-S16.2 Todo documento de conocimiento nuevo requiere organización asignada; no puede crearse sin
  ella.

## 6. Estructura de agentes (SDK)

La necesidad real, en palabras de Ernesto, no es "más agentes" sino **la estructura para armar
agentes** y poder escalar con confianza. v1.1 extiende la especificación declarativa de agente que ya
existe (identidad, capa, runtime, proveedor, modelo, autonomía, a quién reporta, herramientas
permitidas) con estos campos:

```yaml
size: employee            # employee | micro
invocable_as_tool: false  # solo un micro puede ponerlo en true
scope: catalog            # catalog | org  (org => el agente pertenece a una organización cliente)
mcp: [whatsapphub, hubspot]
contexts: [hubspot, ghl]  # slugs de contexto por herramienta a inyectar
harness:
  loop: react | plan_execute | interview | watchdog
  max_turns: 12
  max_tool_calls: 40
  max_usd_per_run: 2
  memory: { context_docs: 8, char_cap: 24000, continuation_summary: true }
  triggers: [dispatcher, "cron:0 9 * * 1"]
lifecycle: { generated_from_plan_id: null, review_at: null, expires_at: null }
```

### 6.1 Dos tamaños, una jerarquía

Los agentes "empleados" (Alex, Sam, Vinnie, Sally, Clara, Debbie, Quinn, el nuevo PM agent) son el
roster amplio, con identidad estable y presencia en el chat. Los **micro-agentes** tienen una tarea muy
específica (analizar un negocio, una cuenta, un proceso pequeño) y pueden ser usados por un empleado
como si fueran una herramienta más. Un empleado nuevo sigue siendo decisión de roster de Sixteam, nunca
salida automática de un plan; lo que sí puede salir de un plan es un micro-agente nuevo (§6.3).

### 6.2 Contexto por herramienta en dos capas

Cada herramienta (HubSpot, GoHighLevel, un ERP) tiene un contexto documentado en dos capas: una capa
**global**, el conocimiento transferible de esa herramienta que se mejora una vez y sirve a todos los
clientes, y una capa **de organización**, la configuración real de ese cliente específico (sus pipelines,
sus campos personalizados, sus límites de API). Al ensamblar el contexto de un agente para una tarea se
inyectan ambas capas. Esta es la forma concreta en la que "los expertos no son fijos por herramienta,
acumulan contexto por herramienta" (principio #8 de la constitución).

### 6.3 Micro-agente como tool: límites

Un empleado puede usar un micro-agente de dos formas, siempre explícitas:

- **Delegar** (ya existente): crea una tarea hija visible en el tablero. Sigue siendo el modo por
  defecto de cualquier trabajo que produzca un artefacto.
- **Invocar como tool** (nuevo): una sub-ejecución síncrona dentro del mismo turno, solo permitida si el
  destino es un micro-agente marcado como invocable. Pasa por el mismo gateway de política y auditoría
  que cualquier otra acción.

Límites duros, verificados por prueba y no por instrucción de prompt: **profundidad máxima 2**
(empleado → micro → nada), **máximo 5 invocaciones por turno**, presupuesto heredado del que le queda a
la tarea (nunca más), tiempo límite propio, y herramientas permitidas como **intersección** con las del
invocador — nunca una lista más amplia, para que invocar un micro-agente no sea una forma de escalar
privilegios. El micro-agente hereda la organización activa del invocador y no puede cambiarla.

### 6.4 Catálogo fijo más generación por plan

Existe un catálogo fijo de micro-agentes y, además, la capacidad de **generar micro-agentes nuevos por
plan y por empresa cliente** — nunca empleados nuevos. La especificación propuesta pasa por el gate
G-AGENT (aprobación de Sixteam); al aprobarse, el micro-agente queda con autonomía supervisada,
herramientas contenidas en las de quien lo propuso, y una fecha de expiración obligatoria. Un
micro-agente nunca se borra al retirarse, queda archivado: sus ejecuciones históricas permanecen
consultables.

### 6.5 Agentes de v1.1

| Agente | Nuevo / extensión | Justificación |
|---|---|---|
| PM agent | Nuevo | Alex es la cara del chat y orquesta el encargo; perseguir atrasos y escalar al campeón necesita autoridad y ritmo distinto |
| Entrevistador (micro) | Nuevo, pero micro | La metodología de entrevista ya vive en Sam; falta paralelismo por persona, no otra identidad senior |
| Agente de soporte | Nuevo | Sally es revenue saliente; soporte es entrante, con SLA y conversión de requerimiento a tarea |
| Loops de mejora | Extensión de Clara | Ya es la analista de datos y reportes; solo necesita el ciclo de vigilancia con cadencia y salida de propuesta |
| Experto de desarrollo | Extensión de Debbie | Ya construye sobre Claude; se le agrega el harness de desarrollo (fase 2) |
| Expertos CRM / ERP / Marketing | No son agentes nuevos | El conocimiento vive en el contexto por herramienta y en micro-agentes por capacidad, invocados por Vinnie y Sally |
| Quinn | Sin cambios | Sigue siendo QA adversario y nunca aprueba ni cierra |

## 7. Arquitectura de plataformas

La elección entre construir a la medida o usar una plataforma SaaS es siempre una **decisión humana**,
trazable: el sistema calcula y muestra el puntaje de cada opción (ajuste al proceso, costo anual, tiempo
a valor, riesgo de dependencia del proveedor, brechas que quedarían sin cubrir), pero la elección la
firma un humano. Esa decisión queda ligada a la aprobación del gate correspondiente (G-ARQ, §8).

Existe un **catálogo de plataformas SaaS** semilla, con el mismo patrón de dato versionado que las
metodologías: HubSpot, GoHighLevel, Google Workspace y Drive, WhatsAppHub, Apollo, Stripe, Notion (solo
lectura, para la migración final), y Odoo como ERP piloto. Cada entrada del catálogo declara cómo se
conecta (MCP, API REST, automatización de interfaz, o ninguna todavía) y su estado (soportado,
experimental, no soportado).

El **mapeo entre el to-be y la capacidad real de una plataforma** es explícito: cada paso de proceso o
funcionalidad del to-be se marca contra una plataforma candidata con un nivel de ajuste (nativo,
configuración, desarrollo a medida, o brecha). Toda funcionalidad marcada como brecha entra
automáticamente al plan como una brecha de tipo "herramienta" — es la costura que evita el error clásico
de comprar un SaaS y descubrir después que el proceso no cabe.

**Computer-use queda en fase 2**, pero v1.1 deja los enganches listos: el catálogo acepta el tipo de
conexión "automatización de interfaz", pero la validación del lanzamiento de un módulo la **rechaza**
en v1.1 (fail-closed, no un pendiente silencioso); el gateway único de tools hace que, cuando llegue, un
ejecutor de interfaz sea simplemente otro tipo de destino y no una reescritura. **(supuesto)** un
contenedor por bot queda descartado por ahora, por escala y por el estado actual del VPS.

El **agente de desarrollo autónomo** (Debbie extendida, sobre Claude, con un harness de desarrollo
construido a partir de referencias externas como OpenClaw y Hermes) también queda para fase 2: en v1.1,
las plataformas a la medida siguen construyéndose con el flujo de implementación normal, sin ese harness
específico todavía.

## 8. Gates y humano en el circuito

| Gate | Momento | Riesgo | Aprueba | Qué valida |
|---|---|---|---|---|
| G0 alcance | Tras el kickoff | Medio | Sponsor | Agenda de entrevistas ejecutable |
| G-ASIS | Grafo as-is completo | Medio | Dueño de proceso + Sixteam | El grafo validado coincide con lo entrevistado |
| G-TOBE | To-be y brechas priorizadas | Alto | Sponsor | Las palancas del plan solo derivan de brechas aprobadas |
| **G1** (existente) | Cierre de Entender | Alto | Sixteam + sponsor | Informe y roadmap sin faltantes |
| G-ARQ | Custom vs. SaaS | Alto (costo, dependencia de proveedor) | Sponsor (costo) + Sixteam (técnico) | Ninguna brecha de herramienta queda sin plan |
| G-AGENT | Spec de micro-agente generado | Medio | Sixteam | Herramientas contenidas en las del proponente y expiración fijada |
| **G2** (existente) | Tool con efecto externo | Alto | Operador humano o dueño de proceso | Los argumentos de la acción quedan intactos y auditados |
| G-SPRINT | Cierre de sprint | Bajo-medio | Campeón | Artefactos presentes y defectos de Quinn cerrados |
| G-GOLIVE | Proceso automatizado a producción | Alto | Dueño de proceso | Métrica del proceso posterior al go-live |
| G-SOPORTE | Requerimiento del cliente a ejecución | Según riesgo | Dueño de proceso | Aprobar → ejecutar → validar (tres pasos, no dos) |

**Regla anti-fatiga**: los gates de riesgo bajo se aprueban en lote desde una bandeja única —una
decisión, muchas filas, la misma auditoría. Sin esto, pasar de 2 aprobaciones por proyecto (el estado
actual) a más de 10 lleva a aprobar sin mirar, que es peor que no tener el gate.

## 9. Slides y visualizador

### 9.1 Deck del assessment

| Slide | Fuente de datos |
|---|---|
| Portada y contexto del cliente | Perfil de organización |
| Organigrama | Departamentos, roles, personas por rol |
| Mapa de procesos as-is | Procesos y pasos en variante as-is |
| Inventario y uso de herramientas | Sistemas y sus capacidades |
| Hallazgos y fugas | Hallazgos con evidencia citada |
| Brechas priorizadas (impacto/esfuerzo) | Brechas ordenadas por puntaje |
| Procesos to-be y diff | Diff calculado as-is / to-be |
| Arquitectura de plataformas | Decisión de plataforma y mapeo de capacidad |
| Arquitectura de agentes | Agentes participantes y palancas |
| Roadmap y sprints | Palancas y sprints |
| Inversión y presupuesto | Presupuesto del módulo y costo de la opción elegida |

El **HTML autocontenido es el formato primario**: exportable, versionable, apto para mostrarse en un
portal de cliente. El **PPTX es un export secundario, explícitamente "best effort"**: no se promete
paridad pixel a pixel con una entrega hecha a mano. La estructura de referencia es la entrega real
`Entrega-Final-Conecty-SixTeam-vFinal.pptx`: veinte slides organizadas en bloques (portada; diagnóstico
de negocio con cifras destacadas; metodología y resultado; procesos operativos con diagramas de flujo;
decisión técnica con tabla comparativa de plataformas y modelo de datos; documentación de procesos y
arquitectura; plan y paquete de entrega; cierre). El patrón que deja esa entrega es claro: buena parte
del contenido (los procesos del cliente, la comparación de plataformas, el roadmap, los indicadores) ya
es un dato estructurado que hoy se retipea a mano en cada slide; en AgentOS ese contenido se genera por
plantilla desde el 2brain de la empresa cliente, no se redacta de nuevo cada vez.

### 9.2 Visualizador

- **Organigrama**: React Flow sobre departamentos, roles y personas por rol.
- **Procesos**: bpmn-js sobre los pasos de proceso; cada paso mantiene una referencia estable para que
  el ciclo de render → edición humana → guardado no reordene ni duplique elementos.
- **Mapa de herramientas**: React Flow bipartito entre sistemas y procesos, coloreado por nivel de uso y
  si la herramienta funciona bien o no.
- **Escritura de vuelta**: toda edición humana pasa por los mismos servicios de dominio que usa el
  agente (nunca SQL directo), queda auditada con el estado anterior y posterior, y marca la entidad como
  validada. El enjambre de agentes sigue siendo de solo lectura sobre el runtime (`PRD.md` §6.6); el
  visualizador del grafo es la única superficie editable, y edita entidades del cliente, no el sistema.

## 10. NFRs

| # | Requisito | Verificación |
|---|---|---|
| NFR-1 | Aislamiento de organización fail-closed en el gateway de tools | Prueba obligatoria: una acción fuera de la organización activa se rechaza y no ejecuta nada |
| NFR-2 | Límites duros de micro-agentes (profundidad ≤2, fan-out ≤5, presupuesto heredado, permisos por intersección) | Verificado por prueba automatizada, no por instrucción de prompt |
| NFR-3 | Inmutabilidad de los snapshots de gate | El snapshot congelado en la aprobación no cambia aunque el grafo vivo se siga editando después |
| NFR-4 | Regeneración de decks sin perder ajustes humanos | Regenerar un slide desde datos actualizados conserva los overrides guardados por slide |
| NFR-5 | Presupuesto por fase editable | El tope de gasto por fase (15/30/20 USD por defecto) sigue siendo un valor de configuración del módulo, no una constante en código |
| NFR-6 | Auditoría completa de acciones sensibles | Todo lanzamiento de módulo, edición de grafo, invocación de micro-agente y gate queda en el registro de auditoría, exportable por organización |
| NFR-7 | Round-trip del visualizador sin duplicar elementos | Prueba de render → edición → guardado sin reordenar ni duplicar pasos de proceso |
| NFR-8 | Sin escalada de privilegios en agentes generados | Un micro-agente generado por plan no puede aprobarse sin fecha de expiración ni con herramientas fuera de las de quien lo propuso |

## 11. Fuera de alcance de v1.1

- Voz en entrevistas (se acepta transcripción de reunión humana vía Fathom, no entrevista por voz del
  agente).
- RLS de Postgres (el guard de v1.1 es el gateway de tools, no la base de datos).
- Computer-use / agentes con acceso a computadoras virtuales.
- Agente de desarrollo autónomo completo para plataformas a la medida.
- Portal de cliente.
- Marketplace de módulos entre organizaciones.
- Facturación o cotización ligada al módulo.

## 12. Supuestos pendientes de confirmar

| Pregunta | Default asumido |
|---|---|
| Q22 — ¿Qué metodología de sprints se usa en Implementación? | Palanca del roadmap → épica → tareas, con sprints y gates entre ellos |
| Q23 — ¿Cómo se versionan los templates de implementación? | Mismo patrón YAML versionado que metodologías y módulos |
| Q24 — ¿Con qué cadencia corren los loops de mejora de Operación? | Semanal, leyendo CRM, métricas y conversaciones |
| Q25 — ¿Cómo se configura el WhatsApp de soporte? | Un número por cliente, reutilizando WhatsAppHub, atendiendo a la empresa cliente (no a los clientes del cliente) |
| Q26 — ¿Quién valida cada nivel de HITL en soporte? | Por nivel de riesgo de la tarea; por defecto valida el dueño del proceso |
| Q28 — ¿Se mantiene el presupuesto por fase actual? | Sí, 15/30/20 USD por fase, como valor editable, no como constante |

## 13. Riesgos

| # | Riesgo | Recomendación |
|---|---|---|
| 1 | Multi-tenant exige que toda la capa de datos esté completamente portada a Postgres de forma asíncrona; hoy no lo está | Bloque previo obligatorio antes de cualquier otra pieza de v1.1 |
| 2 | Cerca de veinte entidades nuevas de golpe | Entregar por bloques (§14); ninguna tabla sin una herramienta de agente y una vista que la use |
| 3 | Las aprobaciones humanas pasan de un puñado por proyecto a más de diez: riesgo de fatiga y aprobación a ciegas | Aprobación en lote para gates de riesgo bajo, con bandeja priorizada por severidad |
| 4 | Sin RLS, el gateway es el único guardián multi-tenant | Aceptable en v1.1 con prueba obligatoria de violación de alcance; RLS se activa cuando exista portal de cliente |
| 5 | Micro-agentes: riesgo de recursión y gasto descontrolado | Profundidad 2, fan-out 5, presupuesto heredado, permisos por intersección, todo verificado por prueba |
| 6 | Agentes generados por plan como vector de escalada de privilegios | Gate humano obligatorio, expiración obligatoria, herramientas contenidas en las de quien propone |
| 7 | El canal de WhatsApp no está construido todavía, solo el contrato | v1.1 arranca entrevistas por chat web; WhatsApp es un bloque propio que bloquea al PM agent y al agente de soporte |
| 8 | Voz para entrevistas | Fuera de v1.1; se acepta transcripción de reunión humana |
| 9 | Retirar Notion mientras el módulo de Proyectos/Tareas sigue sin integrar al tronco principal | Cerrar e integrar ese módulo antes de declarar Notion retirado |
| 10 | Preguntas del brief sin confirmar (Q22, Q23, Q24, Q25, Q26, Q28) | Avanzar con los defaults de §12, marcados como supuesto, y confirmarlos con Ernesto en la revisión |

## 14. Secuencia de construcción

Sin fechas, por dependencia:

- **B0** — Base de datos completamente portada a Postgres de forma asíncrona. Bloquea todo lo demás.
- **B1** — Multi-tenant mínimo (relación persona-organización, organización activa en el gateway y en la
  sesión). Depende de B0.
- **B2** — Grafo as-is: departamentos, roles, funciones, personas por rol, pasos de proceso, sistemas y
  sus capacidades, con sus herramientas de agente. Depende de B1.
- **B3** — Visualizador (React Flow + bpmn-js), edición humana con validación y regla anti-pisado.
  Depende de B2.
- **B4** — Entrevistas: guías de referencia, sesiones, micro-agente entrevistador, extracción de
  entrevista a grafo. Depende de B2.
- **B5** — Brechas y to-be: hallazgos, brechas, variante to-be con su cadena de origen, diff, puntaje,
  snapshots, gates G-ASIS y G-TOBE. Depende de B2 y B4.
- **B6** — Plan y arquitectura: plan, palancas, decisiones, catálogo SaaS, mapeo de capacidad, G-ARQ.
  Depende de B5.
- **B7** — Decks: HTML primero, PPTX después. Depende de B5 y B6.
- **B8** — SDK de agentes: campos de especificación, contexto por herramienta, invocación de
  micro-agente, catálogo de micro-agentes, G-AGENT. Depende de B1.
- **B9** — Canal de WhatsApp. Depende de B1.
- **B10** — Implementación: PM agent, sprints, templates de implementación, escalamiento al campeón.
  Depende de B6, B8 y B9.
- **B11** — Operación: agente de soporte, loops de Clara, HITL de aprobar → ejecutar → validar. Depende
  de B8, B9 y B10.
- **B12** — Aprendizajes que producen nueva versión de metodologías, módulos y templates. Depende de
  B10 y B11.

**Rutas paralelizables**: B2/B3 (grafo) puede avanzar en paralelo con B8 (SDK de agentes) y con B9
(WhatsApp), una vez cerrado B1. Los índices de migración de base de datos deben repartirse por
adelantado entre quienes trabajen en paralelo; el siguiente índice libre en el proyecto es 0006.
