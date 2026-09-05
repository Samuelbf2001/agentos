# Modelo de tenancy — una plataforma, tenant de agencia y tenants cliente

> Decisión de producto tomada por Ernesto el 2026-09-05. Corrige el PRD v1.1, que mezclaba la gestión
> interna de Sixteam con la plataforma del cliente como si fueran dos cosas. No lo son.
> Estado: decisión tomada, pendiente de bajar a las secciones afectadas del PRD.

## La decisión

**Es una sola plataforma.** Sixteam no tiene un sistema aparte: Sixteam es **un tenant de tipo agencia**
dentro de la misma plataforma, con funciones propias y alcance sobre los tenants de sus clientes. Cada
empresa cliente es **un tenant de tipo cliente** que ve solo lo suyo.

Es el modelo de cuenta de agencia y subcuenta que Sixteam ya conoce de GoHighLevel. No hay dos
aplicaciones, ni dos códigos, ni dos bases de datos. Lo que cambia entre un tenant y otro es **el tipo
de tenant, el alcance de lo que se ve y los permisos del rol de quien mira**.

## Por qué esto es mejor que separar en dos productos

**Una sola implementación de cada pieza.** El tablero, las tareas, los agentes, las aprobaciones y el
2brain son el mismo software. Un tenant de agencia ve el tablero de todos sus clientes; un tenant
cliente ve el suyo. Dos productos habrían significado mantener dos veces cada pieza.

**Es lo que Sixteam vende.** El discurso comercial es "esto que ves moverse es lo que te vamos a
montar". Si Sixteam opera en la misma plataforma que entrega, la demo es el producto. Con dos
productos, la demo sería de otra cosa.

**El camino de crecimiento ya existe.** Si mañana un cliente quiere administrar a sus propias
sucursales, o si Sixteam habilita a un socio para que atienda clientes, el modelo ya lo soporta: es
otro tenant de agencia.

## Los tipos de tenant

| Tipo | Quién es | Qué ve | Ejemplo |
|---|---|---|---|
| **Agencia** | Sixteam | Todos sus tenants cliente, más sus propias funciones de agencia | Sixteam |
| **Cliente** | Una empresa cliente | Solo su organización | ACME, Conecty |

Un tercer tipo queda descartado por ahora. Si un cliente necesita administrar varias unidades de
negocio, se resuelve con jerarquía dentro de su tenant, no con un tipo nuevo.

## Cómo se reparten las funciones

Tres categorías, no dos. La tercera es la más importante y la que el PRD se estaba perdiendo.

**Solo agencia.** Existen únicamente en el tenant de Sixteam: roster de agentes y sus prompts,
catálogos de metodologías, módulos y templates, contextos por herramienta, presupuesto y costes,
lanzamiento de módulos de fase, WhatsApp del equipo interno, el agente de PM y el campeón de proyecto,
administración y kill switch.

**Solo cliente.** Existen únicamente en un tenant cliente: su organigrama, sus procesos, su inventario
de herramientas, sus entrevistas, su plan, y el canal de soporte de esa empresa.

**Comunes con alcance distinto.** La misma pieza, distinta lente según quién mire. El tablero de
tareas, las aprobaciones, el 2brain, los documentos y los informes. Sixteam ve el conjunto y el detalle
de ejecución; el cliente ve lo suyo y solo lo que está publicado para él.

Esa última categoría trae una regla que el PRD no tenía: **el contenido tiene estado de publicación**.
Un informe en borrador es visible para Sixteam y no para el cliente. Publicarlo es un acto explícito,
no un efecto secundario de guardarlo.

## Qué implica esto para lo que ya está construido

El estado real verificado dice que hoy no hay nada de esto. La sesión guarda solo la persona, el
gateway de herramientas nunca consulta la organización, y todo el sistema exige que quien entra sea
persona interna de Sixteam. En la práctica, hoy **solo existe el tenant de agencia**, implícito y sin
nombrar.

Eso cambia la lectura del trabajo pendiente. El bloque de multi-tenant deja de ser una funcionalidad
más y pasa a ser el cimiento del producto entero. Y aparece una pieza que el PRD no contemplaba: el
**cambio de contexto entre tenants**, el selector que permite a alguien de Sixteam pasar de la vista de
agencia a operar dentro de un cliente concreto, con todo lo que eso implica en auditoría, porque cada
acción debe registrar quién la hizo, desde qué tenant y sobre qué tenant.

## Roles, no solo tenants

El tipo de tenant dice qué se ve. El rol dice qué se puede hacer. Sin roles, un tenant cliente sería
todo o nada.

En el tenant de agencia: operador, que lanza y aprueba; campeón de proyecto, responsable de un
engagement; estratega, que consulta sin operar.

En el tenant cliente: sponsor, que aprueba alcance y arquitectura; dueño de proceso, que valida su
proceso y el resultado de lo que se automatiza; entrevistado, que solo responde lo suyo.

Esto reemplaza al `is_internal` binario de hoy.

## WhatsApp, con el encuadre correcto

Ernesto aclaró que WhatsApp no es un canal genérico: se trata de conectar las cuentas de personas del
equipo interno de Sixteam y mantener esa parte. Eso es una **función de agencia**, no del cliente.

Son usos distintos que el PRD había colapsado en uno:

1. **Cuentas del equipo interno de Sixteam** conectadas al sistema. Función de agencia. Es lo que
   WhatsAppHub ya hace en el servidor.
2. **Aviso al campeón** cuando alguien se atrasa. Función de agencia, requiere envío, que hoy no existe.
3. **Entrevistas al personal del cliente**. Función de cliente ejecutada por Sixteam, con consentimiento
   explícito.
4. **Soporte al cliente final**. Función de cliente, número propio de esa empresa.

El detalle de cada uno, con lo que existe hoy y lo que falta, va en el análisis que acompaña a este
documento.

## Cómo se aísla sin partir el producto en dos

Hay una tentación técnica que conviene nombrar y descartar: separar la aplicación en dos superficies,
una para Sixteam y otra para el cliente. Da aislamiento por construcción, pero rompe la decisión de
producto y duplica el trabajo de interfaz para siempre.

La forma correcta de conseguir el mismo aislamiento en una sola plataforma es **declarar el alcance en
un solo sitio y denegar por defecto**. Cada ruta declara qué tipo de tenant y qué rol la pueden
alcanzar. Una ruta que no lo declare es inalcanzable, no abierta. Así el olvido de un desarrollador
produce un error visible, no una fuga silenciosa. El gateway de herramientas aplica la misma regla para
los agentes.

Eso reemplaza al guard binario de hoy, que solo pregunta si quien entra es persona interna, sin mirar
sobre qué organización actúa.

## Cómo ve el cliente lo que Sixteam produce sobre él

Dos mecanismos, según si el cliente lee o escribe.

**Lo que el cliente lee es una fotografía.** El informe, el organigrama validado, el roadmap y el deck
se publican como una copia congelada con fecha y autor. El cliente nunca lee el grafo vivo. Así se
sabe exactamente qué se entregó y cuándo, y una edición interna posterior no cambia en silencio lo que
el cliente ya vio. El patrón ya está probado en el sistema con el snapshot de los módulos de fase.

**Lo que el cliente escribe entra por una cápsula.** Validar su proceso, aprobar un gate, responder una
entrevista o abrir un ticket no exige crear una cuenta. Es un enlace firmado para un objeto, un
propósito y una fecha de caducidad. La decisión queda auditada como esa cápsula, no como un usuario
inventado. Esto permite que el sponsor apruebe y el dueño de proceso valide desde el primer día, sin
esperar a que exista un portal completo.

Las cuentas de cliente con sesión propia llegan después, cuando el portal exista. La cápsula no es un
parche: es lo correcto para alguien que interviene una vez.

## Qué se publica y qué nunca sale del tenant de agencia

Hay contenido que describe al cliente y contenido que es el método de Sixteam. La línea importa porque
el método es el activo.

Se publica al cliente: su organigrama, sus procesos, su inventario de herramientas, los hallazgos
redactados para él, las brechas con su impacto, el plan como roadmap, las decisiones de arquitectura y
el deck.

No sale nunca del tenant de agencia: las guías de entrevista, los templates de implementación, los
aprendizajes, el catálogo de plataformas con su criterio de comparación, la capa global de contexto por
herramienta, las especificaciones de los agentes y sus permisos, los sprints y el coste interno.

Dos matices que conviene fijar ahora. De una brecha se publica el qué y el impacto, no el esfuerzo ni
el coste que le supone a Sixteam. Y de una entrevista, cada persona ve la suya y nadie más.

## Los cuatro usos de WhatsApp

WhatsAppHub es el transporte de los cuatro. AgentOS nunca habla directamente con el proveedor de
mensajería. Lo que distingue un uso de otro es quién está del otro lado.

**Cuentas del equipo interno de Sixteam.** Función de agencia. La relación real con el cliente vive en
el WhatsApp de las personas del equipo: compromisos, fechas, quejas. Hoy eso se pierde, solo llegan las
reuniones. El valor es capturar esa fuente y extraer los compromisos como propuestas de tarea, no como
tareas directas.

Con una recomendación fuerte: **capturar sí, escribir automáticamente no**. Un mensaje desde el número
personal de alguien es esa persona hablando, no se puede deshacer, y en ese teléfono hay conversaciones
de familia y de otros clientes. La alternativa es el borrador sugerido: el agente redacta, la persona
envía. Requiere además consentimiento por empleado, lista blanca de conversaciones ligadas a un
cliente, exclusión de grupos y opción de salir en cualquier momento.

**Aviso al campeón por atrasos.** Función de agencia, y resulta ser la victoria más barata de todo el
plan. WhatsAppHub ya tiene construido y desplegado el envío de recordatorios al equipo. AgentOS solo
necesita un adaptador de entrega, porque hoy el único que existe es un simulacro. Esto corrige el PRD,
que daba por hecho que el agente de PM dependía de construir el canal completo. No depende: es un envío
saliente, sin conversación.

**Entrevistas al personal del cliente.** Es el canal bidireccional de verdad. WhatsAppHub ya tiene
webhook de entrada, envío, ventana de servicio y control de duplicados. Falta el adaptador del lado de
AgentOS, y el contrato del canal ya existe con la web como implementación de referencia. El número debe
ser de Sixteam, dedicado al engagement, nunca el personal de alguien. El entrevistado debe saber desde
el primer mensaje que habla con un sistema y poder pedir entrevista humana.

**Soporte al cliente final.** Un número por organización cliente, que WhatsAppHub ya soporta. La regla
que lo hace seguro: el agente responde, pero no actúa. Toda acción con efecto pasa por aprobación.

## El tenant de agencia es el Notion de Sixteam

Aclaración de Ernesto del 2026-09-05, que cambia cómo se navega el tenant de agencia.

**Las tareas de Sixteam son transversales.** Ernesto no tiene que entrar a cada módulo ni a cada cliente
para ver el trabajo. En el tenant de agencia existe **una sola vista de tareas** que cruza todos los
clientes y todos los proyectos, como la base de tareas que hoy tienen en Notion: se filtra y agrupa por
cliente, proyecto, responsable, estado, etiqueta o vencimiento, pero nunca se navega proyecto por
proyecto para descubrir qué hay. Las tareas siguen relacionadas con su proyecto y su cliente, y esa
relación es un atributo por el que se filtra, no una puerta que hay que cruzar.

Esto tiene una consecuencia de diseño: **el proyecto es el objeto raíz cuando se trabaja dentro de un
cliente, pero no es la puerta de entrada al trabajo diario de Sixteam.** La puerta de entrada de la
agencia es la vista transversal, y desde una tarea se salta a su proyecto cuando hace falta contexto.

**Los módulos antiguos del 2brain viven aquí.** Lo que hoy hace WhatsAppHub para Sixteam, las
reuniones procesadas, las notas de voz que se vuelven tareas, los clips para redes, la wiki y los
expedientes de contactos, pertenece al tenant de agencia y debe convivir con las tareas en la misma
plataforma. No son funciones de ningún cliente: son el sistema interno de Sixteam. La redirección de
las trece escrituras que hoy van a Notion es el primer paso de esa convivencia, y está documentada en
el plan de migración.

**La plataforma para Sixteam es distinta de la que ve el cliente**, aunque sea el mismo software. El
cliente ve su proyecto y su segundo cerebro. Sixteam ve el conjunto: todas las tareas, todos los
clientes, sus propios módulos internos, y el método.

## Qué hay que reescribir del PRD v1.1

La sección de multi-tenant, que hablaba de aislamiento pero no de tipos de tenant ni de agencia. La de
usuarios y actores, que mezcla humanos de Sixteam y del cliente sin decir en qué tenant vive cada uno.
La de gates, que asigna aprobadores sin apoyarse en roles y que hoy es directamente inconstruible,
porque asigna al sponsor y al dueño de proceso acciones que el sistema solo permite a personas
internas. La de soporte por WhatsApp. La secuencia de construcción, porque el aviso al campeón sale
del bloque de canal y se adelanta. Y la sección de catálogos, que ahora tiene un dueño claro: el tenant
de agencia.
