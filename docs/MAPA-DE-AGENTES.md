# Mapa de agentes — qué sabemos y qué falta por definir

> Estado a 2026-09-05. Estamos en la fase de estructura, no de detalle. Este documento existe para que
> ningún agente entre al sistema sin ficha, y para que se vea de un vistazo qué está definido y qué no.
> El detalle se completa módulo por módulo, no de golpe.

## Por qué este documento

Hay agentes que aparecen en el PRD con nombre y capa, pero sin que nadie haya dicho todavía qué hacen
exactamente, qué producen y qué no deben tocar. Eso está bien en esta fase, y es peor inventarlo que
dejarlo marcado como pendiente.

La regla que adoptamos: **un agente sin ficha completa no se construye**. La ficha es lo que se llena
al desarrollar cada módulo.

## La ficha estándar

Todo agente, sea empleado o micro-agente, se define con estos doce campos. Los primeros cinco fijan
qué es. Los siguientes cuatro, qué hace. Los tres últimos, qué lo contiene.

| Campo | Qué responde |
|---|---|
| Identidad | Nombre, capa y a quién reporta |
| Tenant | Vive en el tenant de agencia, en uno de cliente, o en ambos con alcance distinto |
| Tamaño | Empleado con identidad estable, o micro-agente invocable como herramienta |
| Interlocutor | Con quién habla: nadie, el equipo de Sixteam, el personal del cliente, o el cliente final |
| Módulo | En qué fase del ciclo participa |
| Trabajo | Qué hace, en una frase que empiece con un verbo |
| Produce | Qué entidad o artefacto deja cuando termina. Si no deja nada, no es una tarea |
| Herramientas | Qué puede usar, incluidos micro-agentes y conectores |
| Gates | Qué aprobaciones toca, y cuáles nunca puede saltarse |
| No hace | La frontera explícita. El campo más importante y el que más se olvida |
| Se mide por | Cómo sabemos si funciona |
| Límites | Presupuesto por ejecución, turnos, y expiración si es generado |

El campo **No hace** merece énfasis. Quinn no aprueba ni cierra. El agente de soporte responde pero no
actúa. El entrevistador no resuelve conflictos entre versiones. Esas fronteras son lo que hace
confiable al sistema, y se escriben antes que las capacidades.

## Estado de cada agente

Tres estados. **Definido** significa que su comportamiento está escrito y probado en el sistema actual.
**Esbozado** significa que sabemos para qué existe pero falta la ficha. **Por definir** significa que
solo tenemos el nombre y la intención.

### Roster actual, en funcionamiento

| Agente | Capa | Estado | Qué falta |
|---|---|---|---|
| Alex | Consultoría | Definido | Revisar su frontera con el agente de proyecto, que es nuevo |
| Sam | Consultoría | Definido, se amplía | Su trabajo con el grafo, las brechas y el to-be no está especificado |
| Debbie | Implementación | Definido, se amplía | El harness de desarrollo queda para fase posterior |
| Vinnie | Implementación | Definido, se amplía | Qué micro-agentes de integración invoca y con qué límites |
| Sally | Operación | Definido | Cómo acumula contexto por herramienta |
| Clara | Operación | Definido, se amplía | El ciclo de vigilancia: qué lee, con qué cadencia, qué propone |
| Quinn | Meta | Definido | Nada. Es el más claro del roster |

### Agentes nuevos acordados

| Agente | Estado | Lo que sí sabemos | Lo que falta |
|---|---|---|---|
| Agente de proyecto | Esbozado | Coordina la ejecución, convierte palancas en épicas y tareas, detecta atrasos y avisa al campeón por WhatsApp | Cómo prioriza, cuándo escala, qué hace ante un agente atascado y no un humano |
| Agente de soporte | Esbozado | Atiende a la empresa cliente por WhatsApp, convierte requerimientos en tareas, responde pero no actúa | Alcance de lo que puede responder solo, política de horario, qué pasa fuera de la ventana de conversación |
| Entrevistador | Esbozado | Micro-agente, una sesión por persona, guiado por documento base | Cómo cierra una entrevista incompleta, cómo pide aclaración, qué hace si la persona se niega |
| Agente para empleados del cliente | Por definir | Responde dudas del personal sobre sus propios procesos y ejecuta acciones en sus sistemas | Todo lo demás. Es el más nuevo, viene del análisis de referentes |
| Expertos por herramienta | Decidido que no son agentes | Su conocimiento vive como contexto por herramienta en dos capas, más micro-agentes por capacidad | Qué micro-agentes concretos hacen falta por herramienta |
| Micro-agentes generados por plan | Estructura definida | Se generan por cliente, pasan por aprobación humana, expiran, y sus permisos son un subconjunto de quien los propone | Qué dispara la generación y quién revisa la propuesta |

## Lo que ya está decidido para todos

Aunque falte el detalle de cada uno, estas reglas aplican al conjunto y no se renegocian por agente.

**Dos tamaños y una jerarquía.** Los empleados tienen identidad estable y presencia en el chat. Los
micro-agentes hacen una tarea específica y pueden usarse como herramienta. Un empleado nuevo es
decisión de roster de Sixteam, nunca salida automática de un plan.

**Límites duros y verificados.** Profundidad máxima de dos niveles, cinco invocaciones por turno,
presupuesto heredado de la tarea, y permisos como intersección con los de quien invoca. Nunca un
conjunto mayor. Se comprueba con pruebas, no con instrucciones en el prompt.

**El contexto por herramienta es del sistema, no del agente.** Se acumula en dos capas, una global que
sirve a todos los clientes y otra con la configuración real de cada uno. Por eso no hay un agente de
HubSpot: hay agentes que saben de HubSpot cuando les toca.

**Solo dos agentes miran al cliente.** El entrevistador y el de soporte, a los que ahora se suma el de
empleados. El resto trabaja de puertas adentro y lo que producen se publica de forma explícita.

**Ninguno aprueba su propio trabajo.** Quinn revisa y abre defectos, pero tampoco aprueba. Las
aprobaciones son humanas.

## Cómo lo vamos a desarrollar

Módulo por módulo, y dentro de cada módulo, agente por agente. El orden que propongo sigue el ciclo,
porque cada fase alimenta a la siguiente:

**Assessment.** Sam con el grafo y las brechas, el entrevistador, y el costeo de procesos. Es donde
más fichas faltan y donde más valor hay, porque es lo que Sixteam vende primero.

**Implementación.** El agente de proyecto, los micro-agentes de integración de Vinnie, y las plantillas.

**Soporte.** El agente de soporte, el de empleados, y el ciclo de vigilancia de Clara con las cuatro
capacidades de inteligencia de interacción.

En cada módulo hacemos lo mismo: llenar las fichas, decidir qué gates toca cada agente, escribir el
campo de lo que no hace, y recién entonces construir.
