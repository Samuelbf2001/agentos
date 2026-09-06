# Referente: Within (ex-Klarity) — el competidor más parecido que hemos encontrado

> Análisis para Ernesto. Fecha: 2026-09-05. Mismo formato que `REFERENTES-Puzzle-Wonderful.md`:
> no es un resumen de su producto, es una lista de decisiones.
> Todo dato lleva fuente. Lo no confirmado va marcado como **[inferido]** o **[sin confirmar]**.

## 1. Qué es Within en tres líneas

Within no es "parecido a lo que hacemos": es **la mitad de arriba de AgentOS, con $90M y clientes
logo**. Su portada es, literalmente, nuestro PRD: *"Within maps how your company works, then builds
dream teams of people and agents."*

Within construye el **"Company Brain"**: un grafo vivo de cómo trabaja realmente una empresa —procesos,
decisiones, excepciones y reglas no escritas— capturado observando el trabajo, no documentándolo.
Sobre ese grafo identifica qué tareas deben pasar a agentes de IA, con ROI cuantificado, y sirve el
contexto por MCP a ChatGPT, Claude o Gemini. **Vende software a la Fortune 500; la implementación la
hacen el cliente o un partner, no ellos.**

### Ficha

| Dato | Valor | Fuente |
|---|---|---|
| Nombre legal | Within Intelligence, Inc. | Política de privacidad del producto |
| Nombre anterior | **Klarity** (revisión de contratos → automatización financiera) | YC; blog "Klarity is now Within" |
| Rebranding | **6 de agosto de 2026** | blog `klarity-is-now-within` |
| Fundación | 2017; YC **Summer 2018** | perfil YC |
| Fundadores | Andrew Antos (CEO, Harvard Law) · Nischal Nadhamuni (CTO, MIT, Forbes 30U30) | About; blog Klarity |
| Sede | San Francisco. Cultura **presencial** declarada ("we believe in being in a room together") | Careers |
| Tamaño | **128 personas** | perfil YC |
| Financiación | **$90M totales**; Serie B de **$70M** liderada por **NFDG** (Nat Friedman + Daniel Gross), con YC, Tola Capital, Scale VP, Picus Capital, Invus | blog `series-b-funding` |
| Clientes públicos | OpenAI, DoorDash, ServiceNow, Stripe, Salesforce, JLL, Uber, Baker Tilly, Tyler Technologies, McKesson, MPE Partners, Accelirate | Home, Customers, YC |
| Certificaciones | SOC 2 Type II, SOC 1 Type II, GDPR, CCPA. Datos alojados en EE.UU. | `/trust`; privacy policy |
| Precios | **No públicos.** Todo pasa por "Book a demo" | web completa |
| Vacantes abiertas | 10, **todas en San Francisco**: 4 ingeniería IA, 2 producto, 1 diseño, 1 marketing, 1 alianzas, 1 recruiting. Rangos $140K–$340K | job board Ashby (API pública) |

**Dato que importa más que la financiación**: en agosto de 2026 Antos contó en el podcast *A Product
Market Fit Show* que **vendieron el negocio de Klarity (8 cifras de facturación) para apostar todo a
Within**, que creció **20x en un año**. El episodio se titula así literalmente. La cifra de ~$20M ARR
circula en la descripción del episodio pero está **[sin confirmar]** por fuente primaria.

**Señal de foco**: ni una vacante de *forward deployed engineer*, *solutions architect* ni de
implementación. El perfil de YC sí listaba "Solution Architect (India)" y "Solution Consultant"
**[discrepancia sin resolver: puestos cerrados o listado de YC desactualizado]**. Con 10 de 10 vacantes
en producto, ingeniería y GTM, la lectura es que **apuestan a producto puro y delegan el servicio**.

---

## 2. Qué hace y cómo lo hace: el recorrido de un cliente

Tres fases declaradas: **Discover → Structure → Improve**. Reconstruido del caso ServiceNow, el único
documentado paso a paso.

**Paso 0 — Entrada.** Un directivo de función (CFO, CIO, CHRO, COO) o un *operating partner* de private
equity: quien tiene mandato de transformación y presupuesto. Cifra de encuadre: *"$600B+ al año en
transformación y el 70% de las iniciativas fracasa"*.

**Paso 1 — Ingesta documental.** El cliente sube políticas, playbooks, organigramas y artefactos
operativos. En ServiceNow, esto solo ya capturó **~2.000 procesos**.

**Paso 2 — Observación (módulo *Companion*).** Aquí está su diferencia real. Companion **observa cómo
se mueve el trabajo entre aplicaciones**, sin integraciones y sin entrevistas largas. En ServiceNow
**duplicó el conteo de procesos** respecto a la documentación. Los empleados además graban vídeos
narrando su tarea ("walking through a process, explaining their screen, narrating decisions").
Su web insiste en *"user-controlled, anonymized, and reviewed"* y *"Built to observe work, not
workers"*. Su propio FAQ de seguridad incluye la pregunta *"Is this employee monitoring?"* — es la
objeción que más les hacen. **No publican la respuesta**: los acordeones no se abren sin sesión
**[sin confirmar]**.

**Paso 3 — Entrevistas de IA.** *"AI-led interviewing… on-demand AI conversations that probe for detail
to help people articulate knowledge"*, para sacar traspasos informales, excepciones y reglas no
escritas. Es exactamente nuestro micro-agente entrevistador, y en su recorrido es el **tercer** método,
no el primero.

**Paso 4 — Estructuración: el Context Graph.** Modela **personas, procesos y sistemas** más *"el
trabajo, las decisiones detrás y las reglas no escritas que lo conectan"*. En ServiceNow salieron
**tres grafos** —operativo, cara al cliente y estratégico— con **4.000+ variantes de proceso sobre 70
flujos núcleo**, con variación por individuo, equipo, región y partner. **En 9 días**, un 87% más
rápido que el método tradicional. En DoorDash, el CAO capturó **3.800+ procesos en semanas**, con
propietario, tiempos y variación geográfica.

**Paso 5 — *Advisor*: qué automatizar.** Se le pregunta en lenguaje natural (*"¿dónde están las 5
mayores oportunidades de automatización?"*, *"¿de dónde sacamos un 15% de coste?"*) y responde con
oportunidades priorizadas por ROI. Genera **archivos de habilidad descargables: `playbook.md` y
`checklist.md`**.

**Paso 6 — Activación.** Su MCP **expone el grafo hacia fuera**: *"Access the Context Graph from your
AI platform of choice. Within's MCP connects with ChatGPT, Claude, Gemini, and more."* El grafo se
actualiza de forma continua.

**Paso 7 — Quién construye los agentes. Ellos no.** El caso ServiceNow dice que **ServiceNow** montó su
planificador de partners y su agente de pipeline. Y su acuerdo con **Cognida.ai** (15 jun 2026) lo deja
explícito: *"los ingenieros y científicos de datos de Cognida.ai realizan la implementación"*, mientras
Within aporta el descubrimiento. **Within mapea; otro ejecuta.** Ese es el modelo.

---

## 3. Cómo lo vende

**La narrativa.** El enemigo no es un competidor, es un diagnóstico: *"no es un problema de modelo, es
un problema de contexto"*. Su dato ancla: *"65% de los empleados dice que es más productivo, pero solo
el 10% dice que cambió cómo funciona su organización."* Y su paradoja de marca: *"It takes AI to get AI
right."*

**El anti-posicionamiento**, muy bien construido, contra las tres alternativas:
- *Task mining*: *"Te dirá que alguien copió datos de un sistema a otro 47 veces hoy. No te dirá cuál
  es el siguiente paso, quién lo hace, ni dónde están los cuellos de botella."*
- *Process mining*: *"Te enseña dónde se atasca tu ERP. Pero es ciego a todo lo que pasa entre sistemas
  —las hojas de cálculo, los arreglos manuales, el 'aquí lo hacemos así'."*
- *Consultoras*: *"Te dan recomendaciones basadas en fotografías que ya están desactualizadas cuando
  las implementas."* Contra ellas, el ángulo de velocidad: **"dos semanas en vez de nueve meses"**.

**Las pruebas.** Todos los casos son una cifra de velocidad o de ahorro: 4.000+ variantes en 9 días
(ServiceNow) · 840+ personas documentadas en 9 días (software global) · 2.000 horas ahorradas en dos
meses (pagos global) · −67% en tiempo de documentación (Accelirate) · 4X en creación de valor (MPE
Partners) · integración de 12 empresas adquiridas en 6 semanas en vez de 6 meses. Ninguna cifra es de
calidad; **todas son de tiempo o de coste**.

**Los canales.** Eventos propios como motor principal: "Inflection NYC" (24 sep, SPYSCAPE, *"100+
Fortune 500 CFOs, CIOs, CHROs"*), una serie recurrente **"AI Fridays"** por función (finanzas, GTM,
customer success, producto, growth), presencia en Gartner IT Symposium y co-marketing con ServiceNow.
Lead magnet: un **diagnóstico de AI Readiness** de 5–11 preguntas / 3 minutos, gratis a cambio del
correo corporativo, con una matriz 2×2 —visibilidad operativa × madurez de IA— que clasifica en
"AI-native", "zona de riesgo", "preparado pero esperando" y "tradicional". También tienen **programa de
referidos** con página propia.

---

## 4. Parecidos con Sixteam y diferencias que importan

| Dimensión | Within | Sixteam / AgentOS |
|---|---|---|
| Promesa | Mapear cómo trabaja la empresa y construir equipos de personas + agentes | Entender → Construir → Operar la operación comercial |
| Artefacto central | Context Graph / Company Brain | 2brain de la empresa cliente (grafo tipado) |
| Entidades | Personas, procesos, sistemas, decisiones, reglas no escritas | Roles, funciones, procesos, pasos, herramientas, datos |
| Captura | Documentos → **observación de pantalla** → entrevistas de IA | Entrevistas (agente o humano) + formulario; sin descubrimiento automático |
| Metodología declarada | Ninguna citada | ISO 9001 / BPMN 2.0 / SIPOC en versión ágil |
| Salida del diagnóstico | Oportunidades con ROI + `playbook.md` / `checklist.md` | Costeo paso a paso as-is vs to-be + roadmap + slides |
| Corrección humana | *"user-controlled, anonymized, and reviewed"* | Gate G-ASIS: el dueño de proceso valida en el visualizador |
| Quién implementa | **El cliente o un partner** (Cognida.ai) | **Sixteam**, con agentes + equipo humano, tablero y gates |
| Quién opera después | Nadie declarado | Sixteam: loops de mejora, soporte por WhatsApp, HITL de 3 pasos |
| Multi-organización | Sí, para *operating partners* de PE: *"context deployed across every company"* | Sí: tenant de agencia sobre tenants cliente (v1.4) |
| MCP | **Hacia fuera**: expone el grafo a ChatGPT/Claude/Gemini | **Hacia dentro**: `mcp-admin` para nuestros agentes |
| Cliente | Fortune 500, EE.UU., inglés, comprador de función | PYME LATAM, español, dueño o gerente comercial |
| Modelo de negocio | Software, precio no público, venta enterprise | Servicio operado + plataforma, retainer mensual |
| Canal WhatsApp | Inexistente | Central |

**Las cuatro diferencias que deciden todo:**

1. **Ellos venden entendimiento; nosotros vendemos operación.** Within entrega el mapa y se retira. La
   promesa raíz de Sixteam —*"operamos los sistemas comerciales de tu empresa, no te dejamos solo"*— es
   justamente lo que ellos delegan en un partner. **No competimos por el mismo dólar.**
2. **Ellos observan, nosotros preguntamos.** Su ventaja de velocidad (9 días) viene de ahí. Nuestra
   ventaja de profundidad —el "debería hacer" contrastado entre la persona, su superior y el catálogo
   metodológico— no la tienen: la observación dice lo que pasa, no lo que debería pasar.
3. **Ellos no bajan a la ejecución.** No hay tablero, ni tareas, ni gates, ni artefactos, ni QA
   adversario. La *Parte IV* (rol/función/proceso → agente en un clic) **no tiene equivalente**.
4. **Ellos no existen en LATAM ni en PYME.** Cero presencia en español, cero PYME, precio enterprise,
   todo el equipo en San Francisco con cultura presencial.

---

## 5. Qué tomamos, qué adaptamos, qué descartamos

**ADOPTAR — la variante de proceso como entidad de primera clase.** Es el hallazgo más valioso: 4.000+
variantes sobre **70** procesos núcleo. Nuestro grafo tiene procesos y pasos, pero no modela que el
mismo proceso se ejecute distinto por sucursal, por vendedor o por tipo de cliente. En una PYME LATAM
eso no es un detalle, **es el problema entero**. Sin variantes, el mapa miente.

**ADOPTAR — el MCP hacia fuera.** Publicar el 2brain del cliente para que su gente lo consulte desde su
propio ChatGPT o Claude. Ya existe `apps/mcp-admin` con perfil `ro`: es trabajo de alcance y permisos,
no de invención. Hace que el cliente use el 2brain a diario aunque nunca entre a AgentOS.

**ADOPTAR — entregables como archivos de habilidad.** `playbook.md` y `checklist.md` por rol y por
proceso, generados del grafo. Barato, tangible, y encaja con la *Parte IV*: el mismo objeto es manual
para el humano y ficha del agente.

**ADOPTAR — la velocidad como argumento, con cifra propia medida.** "En 9 días" vende más que
"metodología robusta".

**ADOPTAR — el lead magnet 2×2** de 3 minutos en español, con ejes nuestros (por ejemplo: proceso
comercial documentado × datos en un CRM vivo).

**ADAPTAR — la observación, con consentimiento explícito y sin software espía.** No instalar nada en
las máquinas. La versión viable para PYME LATAM: **pedir al empleado un vídeo corto narrando su
pantalla mientras trabaja**, más sus documentos y grabaciones existentes. Misma materia prima que
Within, sin su coste ni su objeción de vigilancia. Hoy el PRD §4.1 solo contempla entrevista y
formulario.

**ADAPTAR — tres lentes, no tres grafos.** Ellos entregaron tres grafos a ServiceNow. Con las vistas
por audiencia que ya decidimos con Puzzle logramos lo mismo sin sincronizar tres copias.

**DESCARTAR — "sin integraciones" como virtud.** Para ellos tiene sentido porque solo diagnostican;
para nosotros la integración **es** el producto. Copiarlo sería vender nuestra debilidad como decisión.

**DESCARTAR — la observación pasiva por defecto** (en una PYME familiar mata el proyecto en la primera
reunión, y no tenemos SOC 2 para sostener la conversación) y **el modelo "mapeamos y que otro
implemente"**, que es justo lo que el discurso V2 define como lo que NO somos.

### Qué hacemos nosotros que ellos no

Con la misma honestidad que en el análisis de Puzzle y Wonderful: **ellos ya hacen bien su mitad y
nosotros todavía no hacemos ninguna completa.** Dicho eso, tres cosas son estructuralmente nuestras:
(a) **ejecutar y operar** después del mapa, con tablero, gates y humanos responsables; (b) el **"debería
hacer"** contrastado entre persona, superior y catálogo, que ninguna observación produce; y
(c) **WhatsApp de punta a punta** para entrevistar, escalar atrasos y dar soporte.

---

## 6. Riesgos competitivos y oportunidades

**Riesgo 1 — la categoría ya tiene dueño.** "Company Brain" y "Context Graph" son nombres que YC puso
en su Request for Startups de 2026 y que Forbes ya cubre. **No vamos a ganar la guerra de categoría**;
hay que ganar un segmento que ellos no atienden.

**Riesgo 2 — el partner regional, no Within.** Cognida.ai es la plantilla. El competidor real de
Sixteam en 2027 es **una consultora latinoamericana con Within debajo y los logos de OpenAI y DoorDash
en su propuesta**.

**Riesgo 3 — la velocidad.** Si el prospecto oye "4.000 procesos en 9 días" y nosotros ofrecemos seis
semanas de entrevistas, perdemos la reunión aunque nuestro entregable sea mejor.

**Riesgo 4 — que bajen a ejecución.** Con $90M es el movimiento obvio y cerraría nuestro hueco por
arriba. **[inferido]**: sus 10 vacantes son de producto, ninguna de implementación.

**Oportunidad 1 — el mapa se comoditiza y eso nos favorece.** Si mapear cuesta días, el valor se
desplaza a quien implementa y opera. El discurso correcto no es "mapeamos mejor", es **"el mapa ya no
es el problema; el problema es que nadie lo ejecuta ni lo opera después"**.

**Oportunidad 2 — LATAM y PYME están vacíos.** Ni español, ni PYME, ni precio accesible, ni WhatsApp.
Su método necesita organizaciones grandes con documentación previa; en una empresa de 30 personas sin
procesos escritos, la entrevista sigue ganando.

**Oportunidad 3 — el tenant de agencia.** Su página de PE valida el modelo v1.4: *"context deployed
across every company"* frente a *"5 operadores, 15 portcos"*. Sirve para vender AgentOS a otras
agencias de LATAM.

---

## 7. Cambios concretos al PRD y al discurso comercial

1. **PRD §4.1**: añadir **"observación asistida"** como tercera fuente de captura (vídeo narrado de pantalla + documentos + grabaciones existentes), con consentimiento explícito y anonimización.
2. **PRD §3**: añadir la entidad **`variante de proceso`**, colgando de un proceso núcleo, con su dimensión de variación (persona, equipo, sucursal, región, tipo de cliente).
3. **PRD §7 / `mcp-admin`**: **publicar el 2brain del cliente por MCP hacia fuera**, perfil `ro` y alcance por tenant, para el ChatGPT/Claude/Gemini del propio cliente.
4. **PRD §4.1**: añadir **exportación de habilidades** (`playbook.md`, `checklist.md`) por rol y proceso, reutilizadas como ficha de agente en la Parte IV.
5. **Fijar y medir un compromiso de velocidad del assessment** ("mapa validado en N días"); no publicarlo hasta tener un caso real que lo respalde.
6. **Discurso**: cambiar el gancho de "mapeamos tus procesos" a **"el mapa ya no es el problema; el problema es que nadie lo ejecuta ni lo opera después"**.
7. **Construir el lead magnet 2×2** en español, 3 minutos, a cambio del correo.
8. **Publicar precios** (nadie en la categoría lo hace) y **no prometer "sin integraciones"** en ningún material.
9. **Vigilar cada trimestre** si Within lanza ejecución o abre partners en LATAM: son las dos señales que invalidarían esta lectura.

## 8. Fuentes consultadas

- **Sitio de Within** — https://www.within.ai/ y sus rutas `/platform`, `/platform/company-brain`, `/about`, `/careers`, `/customers`, `/customers/servicenow`, `/solutions/pe-operating-partners`, `/trust`, `/legal/privacy-policy-product`, `/resources/ai-readiness`
- **Blog de Within** — https://www.within.ai/resources/blog : `klarity-is-now-within` (rebranding, 6-ago-2026), `series-b-funding` ($70M/NFDG), `new-brain-for-ai`, `within-manifesto`, `task-mining-vs-process-mining-vs-klarity`, `human-side-of-context-graphs`, `cognida-partnership` (15-jun-2026)
- **Y Combinator** — https://www.ycombinator.com/companies/within (2017, YC S18, 128 personas, ex-Klarity)
- **Bolsa de empleo** — https://jobs.ashbyhq.com/within-ai (vía API pública de Ashby: 10 vacantes, todas en SF)
- **A Product Market Fit Show** — https://www.pmf.show/ , episodio del 31-ago-2026 con Andrew Antos (venta del negocio de 8 cifras, 20x en un año)
- **MIT Sloan** — https://mitsloan.mit.edu/ideas-made-to-matter/klarity-ceo-find-a-world-changing-idea-then-stick-it (historia de los fundadores)
- **Klarity blog** — https://www.klarity.ai/post/nischal-nadhamuni-klarity-co-founder-and-cto-named-to-forbes-30-under-30-list
- **Forbes** — https://www.forbes.com/sites/josipamajic/2026/04/03/vcs-say-context-graphs-might-be-the-next-big-thing-in-ai/ (contexto de categoría)
