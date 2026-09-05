# Parte III — Assessment: recorrido, agentes y gates

> Sección 9 del PRD. La mecánica de extracción, brechas y costeo va en un documento aparte que se
> integra aquí. Este cubre el recorrido, las fichas de los agentes que participan y los gates.
> Estado: borrador para corrección.

## 9.1 Qué es el assessment y qué produce

Sixteam entra a una empresa que no conoce y sale con tres cosas: **su segundo cerebro construido**, una
**lista priorizada de lo que le está costando dinero**, y un **plan de qué hacer con eso**.

El assessment no es un informe. El informe es un subproducto. Lo que queda vivo después es el segundo
cerebro de esa empresa, que sigue sirviendo en las fases siguientes y en los años siguientes.

Criterio de terminado, en una frase: **el sponsor reconoce su empresa en el mapa, y hay al menos una
cifra de ahorro que puede defender ante su directorio.**

## 9.2 El recorrido

Seis momentos. Cada uno produce algo concreto y ninguno empieza sin que el anterior haya dejado su
producto.

**Arranque.** Se acuerda el alcance con el sponsor: qué áreas entran, quién es el contacto de cada una,
qué duele hoy. Se crea la empresa con su rubro, tamaño, áreas y problemas declarados. Con eso el sistema
ya elige qué guías de entrevista usar. Cierra con el gate de alcance.

**Entrevistas.** Una por persona, por agente o por humano. Producen la transcripción y la cobertura de
lo que se preguntó. Corren en paralelo, es el momento más largo del assessment.

**Construcción del mapa.** De las entrevistas salen los procesos, los roles, las funciones y el
inventario de sistemas, todos en borrador. En paralelo se redacta la narrativa central: qué hace la
empresa, por qué y cómo. Los procesos que se nombran ahí y nadie mapeó quedan marcados como pendientes.

**Validación.** Cada dueño de proceso revisa lo suyo en el visualizador y lo corrige. Aquí el mapa deja
de ser lo que dijo un agente y pasa a ser lo que la empresa reconoce. Cierra con el gate del as-is.

**Brechas y costeo.** Sobre el mapa validado se detectan las brechas entre lo que se hace y lo que se
debería hacer, se costean los procesos y se ordenan por lo que cuestan. Aquí aparece la cifra que se
lleva al sponsor.

**Propuesta y entrega.** Se propone el cómo debería operar, se arma el plan y se presenta. Cierra con el
gate de cierre de fase, que habilita construir.

## 9.3 De la conversación al mapa

Aquí está la decisión que sostiene todo el módulo, y no es obvia.

**La unidad no es la entidad, es la afirmación.** Una entrevista no produce procesos directamente.
Produce afirmaciones sueltas, cada una pegada al fragmento exacto de la conversación de donde salió. Los
procesos, los roles y las funciones se construyen después, agrupando afirmaciones.

Eso parece un rodeo y resuelve cuatro problemas de golpe. Cada dato del mapa se puede rastrear hasta la
frase que lo originó. Dos personas pueden decir cosas distintas sin que el sistema tenga que elegir en
el momento. Volver a procesar una entrevista no rompe lo que un humano ya corrigió. Y el mismo trabajo
hecho dos veces no duplica nada.

**Cada afirmación se clasifica en una de tres modalidades**, y esa clasificación hace la mitad del
trabajo del módulo:

**Descriptiva**, lo que la persona hace. **Normativa**, lo que dice que se debería hacer. **Reportada**,
lo que dice que hace otro. Separar estas tres es lo que permite distinguir el estado actual del
deseado sin preguntarlo explícitamente.

**Qué cuenta como proceso.** El criterio: una cadena de actividades que **cruza una frontera**, sea de
rol, de área o de sistema. Ante la duda, se parte hacia abajo. Un proceso inventado cuesta más que un
paso mal clasificado.

**Lo que falta por entrevistar se calcula solo.** Cuando alguien menciona un proceso que nadie ha
mapeado, ese proceso existe como entidad marcada como solo nombrada. La lista de huecos no se mantiene a
mano: es una consulta. Y el caso más valioso es cuando alguien dice "eso lo hace facturación", porque
está señalando exactamente a quién hay que entrevistar después.

### El caso central: dos personas describen el mismo proceso distinto

No es un caso borde, es lo normal. La regla:

**Nunca se fusionan en silencio y nunca se elige ganador automáticamente.** Un proceso guarda tantos
relatos como fuentes, y la versión reconciliada es siempre obra de un humano.

Se distinguen tres situaciones. Si uno cuenta seis pasos y otro tres del mismo tramo, es **detalle**, y
se resuelve solo tomando el relato más fino. Si uno dice que algo lo hace ventas y otro dice que lo hace
administración, es **contradicción**, y va a una decisión pendiente. Si uno describe lo que pasa y otro
lo que debería pasar, **no es conflicto**: es exactamente la materia prima de una brecha.

Y una regla que conviene mirar dos veces: **en una contradicción de hecho, la versión candidata es la de
quien ejecuta el paso, no la del jefe.** La versión del jefe es la oficial. La de quien ejecuta es la
real. Para mapear cómo opera hoy la empresa, la cercanía a la ejecución vence a la jerarquía.

## 9.4 Cómo se detecta una brecha

**Seis tipos, y la lista es cerrada.** Lo que no encaja en los seis es un hallazgo, no una brecha.

| Tipo | Qué es | Ejemplo |
|---|---|---|
| **Ejecución** | Alguien hace algo distinto de lo que se espera de su rol | El vendedor cotiza, factura y persigue el cobro; el gerente cree que factura administración |
| **Cobertura** | Nadie lo hace | Nadie da seguimiento post venta; las cotizaciones no cerradas mueren solas |
| **Continuidad** | Depende de una sola persona | Solo Marta sabe armar la lista de precios en el Excel maestro |
| **Sistema** | Se paga una herramienta que no se usa, o se hace a mano lo que ella cubre | Pagan un CRM y las oportunidades se siguen en una hoja de cálculo |
| **Información** | Se decide sin el dato, o con el dato tarde | Gerencia decide con un reporte armado a mano el día diez del mes siguiente |
| **Control** | No hay criterio ni registro de una decisión | No hay regla escrita de cuándo se aprueba un descuento; decide cada vendedor |

La diferencia entre hallazgo y brecha importa porque **solo las brechas generan trabajo**. Un hallazgo
es cualquier observación con evidencia. Es brecha cuando además tiene un "debería" declarado, venga del
superior o del catálogo, y está anclada a algo concreto del mapa. Sin "debería", no hay brecha.

**El catálogo de referencia** es lo que hace posible detectar lo que falta. Contiene funciones típicas
con su propósito y su dueño esperado, procesos canónicos de cinco a doce pasos, los controles mínimos de
cada proceso y las clases de sistema con lo que deben cubrir.

Se organiza por área funcional, no por rubro. En una empresa mediana la mayoría de la referencia es
independiente del giro, y organizarla por rubro obligaría a replicarlo todo.

De dónde sale: primero, generalizando los assessments que Sixteam ya hizo, quitando nombres. Segundo,
invirtiendo las preguntas de la metodología actual, porque cada pregunta ya codifica una práctica
esperada. Tercero, tapando huecos con marcos públicos. **Recomendación fuerte: empezar con un área
completa, comercial, y no cinco a medias.**

**Los conflictos llegan al sponsor en lote y en una pantalla**, cada uno en una línea con su evidencia y
una pregunta que se pueda responder. No un documento para leer. Y una brecha cuyo "debería" nace de una
contradicción sin resolver no genera trabajo hasta que se resuelva. Diferir es una respuesta válida y se
registra: no decidir también es información.

## 9.5 Costeo

El problema real: en una empresa mediana nadie sabe cuánto cuesta un paso. La solución es no
preguntarlo.

**Tres números y ni uno más.** Cuántas veces al mes pasa, cuánto tiempo toma cada vez preguntado en
bandas del tipo "minutos, media hora, media mañana", y qué rol lo ejecuta. El costo por hora sale de una
tabla que el sponsor fija una sola vez para toda la empresa. Nadie sabe qué cuesta un paso, pero
cualquier gerente sabe a grandes rasgos qué cuesta un vendedor al mes.

Queda fuera de forma explícita el prorrateo de gastos generales, la depreciación y el costo de
oportunidad. **El retrabajo sí entra, como paso propio**: rehacer la cotización mal cargada es un paso
con su volumen. Es el número que el cliente reconoce de inmediato.

**Todo es una banda, nunca un número exacto**, y cada cantidad lleva pegado de dónde salió: medida,
declarada por alguien, o estimada. La etiqueta del dato más débil se propaga hacia arriba: un proceso
con un paso estimado es un proceso estimado. Un paso sin dato queda **sin costear** y se dice: la cifra
final siempre viene acompañada de cuántos pasos de cuántos se pudieron costear. Nunca se rellena con
cero y nunca se omite en silencio.

**El sponsor firma los supuestos antes de ver el resultado.** Esto evita la discusión que mata todo
assessment, que es discutir la cifra cuando ya está sobre la mesa.

### La cifra de ahorro

**Se calcula, nunca se escribe a mano, y es una lista antes de ser un número.** Cada paso del estado
propuesto declara de qué paso actual viene y qué le pasó: sin cambio, eliminado, automatizado,
fusionado, reasignado o nuevo.

Y aquí la regla que hace defendible la cifra: **se presenta el ahorro neto, nunca el bruto.** Al ahorro
se le restan las licencias nuevas y la supervisión que sigue haciendo falta sobre lo automatizado, que
por defecto es un diez por ciento del tiempo original y nunca cero. Ese único ajuste evita el número más
indefendible de la consultoría, que es tratar lo automatizado como si costara cero horas.

El esfuerzo de implementación no se resta del ahorro: va aparte, como en cuánto tiempo se paga solo. Y
en material de cliente el esfuerzo es el precio, jamás el costo interno.

**Si un par de pasos no se puede mostrar, no se puede contar.** La cifra del deck siempre baja hasta los
pasos que la componen.

### El costo de las herramientas

Se captura una vez por sistema y se reparte entre los procesos que lo usan, según cómo se cobre. Nunca a
partes iguales.

Y lo que queda sin repartir **no se reparte: se reporta**. El costo de herramienta que no sirve a ningún
proceso suele ser el número comercialmente más potente de todo el assessment. Diluirlo en prorrateos lo
destruye.

## 9.6 La propuesta de cómo debería operar

Un proceso solo tiene versión propuesta **cuando hay una palanca aprobada que lo justifique**. No se
propone mejorar todo: se propone lo que se decidió atacar.

Y se revisa por pares de pasos, ordenados por diferencia de costo, con un tope de unas quince filas. La
razón es práctica: **el presupuesto de revisión humana define el tamaño de la palanca**. Si un humano no
puede revisarla en una sentada, la palanca es demasiado grande.

## 9.7 Las fichas de los agentes

Cada agente que participa, con los doce campos de la ficha estándar. Lo que no sé, lo digo.

### Sam — diagnóstico

| Campo | Definición |
|---|---|
| Identidad | Sam, capa consultoría, reporta a Alex |
| Tenant | Agencia, trabajando sobre un tenant cliente |
| Tamaño | Empleado |
| Interlocutor | Nadie del cliente directamente. Trabaja sobre lo que producen las entrevistas |
| Módulo | Assessment |
| Trabajo | Construir el mapa de la empresa a partir de las entrevistas, detectar las brechas y proponer el cómo debería operar |
| Produce | Procesos con sus pasos, roles, funciones, inventario de sistemas, la narrativa central, hallazgos y brechas |
| Herramientas | Lectura de entrevistas, escritura sobre el grafo, catálogo de referencia, invocación del micro-agente entrevistador |
| Gates | Su trabajo pasa por el gate del as-is. No aprueba ninguno |
| No hace | No resuelve conflictos entre lo que dicen dos personas: los deja planteados. No decide qué se automatiza. No habla con el cliente. No escribe en la memoria interna |
| Se mide por | Cuánto del mapa sobrevive a la validación humana sin cambios |
| Límites | Presupuesto por ejecución del módulo; sin acceso a otros tenants cliente |

### Entrevistador — micro-agente

| Campo | Definición |
|---|---|
| Identidad | Micro-agente, invocado por Sam |
| Tenant | Cliente, con alcance fijado por la cápsula de esa entrevista |
| Tamaño | Micro, invocable como herramienta |
| Interlocutor | Una persona de la empresa cliente |
| Módulo | Assessment |
| Trabajo | Conducir una entrevista siguiendo una guía, hasta cubrirla o hasta que la persona quiera terminar |
| Produce | La transcripción y el registro de qué quedó cubierto y qué no |
| Herramientas | La guía de entrevista y el hilo de conversación. Nada más |
| Gates | Ninguno. Lo que produce alimenta el trabajo de Sam |
| No hace | No estructura el grafo, eso es de Sam. No juzga lo que le cuentan. No compara con lo que dijo otra persona. No insiste si alguien no quiere responder |
| Se mide por | Cobertura de la guía y que la persona termine la conversación |
| Límites | Una sesión por persona, presupuesto acotado, la organización viene fijada y no puede cambiarla |

### Clara — costeo y datos

| Campo | Definición |
|---|---|
| Identidad | Clara, capa operación |
| Tenant | Agencia sobre tenant cliente |
| Tamaño | Empleado |
| Interlocutor | Nadie |
| Módulo | Assessment, y después en operación |
| Trabajo | Costear los procesos y cuantificar lo que cuesta cada brecha |
| Produce | El costo por paso y por proceso, y la cifra de ahorro comparada |
| Herramientas | Lectura del grafo, datos de costo de herramientas |
| Gates | Su cifra entra al gate del to-be |
| No hace | No inventa un costo sin marcar de dónde salió ni con qué confianza |
| Se mide por | Que la cifra final se pueda rastrear hasta los pasos que la componen |
| Límites | Los del módulo |

### Quinn — QA

Sin cambios respecto a lo ya definido. Revisa que ninguna afirmación sobre el cliente esté sin fuente y
abre defectos. **No aprueba ni cierra nunca.**

### Alex — orquestación

Sin cambios. Coordina el módulo y sintetiza. **No decide por el sponsor.**

## 9.8 Los gates del assessment

| Gate | Cuándo | Quién aprueba | Qué valida al aprobarse |
|---|---|---|---|
| Alcance | Al cerrar el arranque | Sponsor | Que las áreas y los contactos permiten empezar a entrevistar |
| As-is | Con el mapa validado | Dueño de proceso, y Sixteam da por completo | Que el mapa coincide con lo que se entrevistó, y que la empresa lo reconoce |
| To-be | Con las brechas priorizadas | Sponsor | Que el plan solo sale de brechas con decisión tomada |
| Cierre de fase | Con todo entregado | Sixteam y sponsor | Que existen todos los entregables. Habilita construir |

La regla que los sostiene: **un gate bloqueado siempre dice qué falta, y cada cosa que falta enlaza a la
tarea que la produce**. Un gate que solo dice "pendiente" no sirve.

## 9.9 Lo que este módulo necesita y hoy no existe

Para ser honestos sobre la distancia. Del inventario del código: no existe ninguna de las entidades del
grafo, ni entrevistas, ni brechas, ni costeo. Existe el proceso con su variante y sus pasos en un campo
de texto estructurado, y existe el tablero que mueve el trabajo.

Lo que hay que construir antes de que este módulo funcione: las entidades del grafo, la sesión de
entrevista, el visualizador con edición humana, y el costeo. El canal de conversación por chat ya
existe; el de WhatsApp no.

---

## Lo que necesito que decidas

**El costeo se hace sobre el tiempo de las personas o también sobre el dinero perdido.** Lo primero es
medible y defendible: cuántas horas cuesta un proceso al mes. Lo segundo es más vendedor pero más
discutible: cuánto se pierde por un pedido mal despachado. Mi recomendación es empezar por el tiempo, y
añadir el dinero perdido solo donde el cliente tenga el dato.

**Cuántas entrevistas hace el agente y cuántas un humano.** Mi recomendación para el primer engagement
real: las de dirección y las de sponsor siempre humanas, las operativas por agente. La confianza se
gana con las primeras.

**Si el entrevistado puede ver lo que el sistema entendió de su entrevista.** Sería excelente para la
calidad del mapa, porque corrige en el momento. Pero expone lo que el sistema infiere. Mi recomendación
es que sí, limitado a su propia entrevista.
