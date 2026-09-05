# Plan v1.5 — La experiencia: un sistema que avanza

> Responde al veredicto de Ernesto del 2026-09-05: "la visual y la interfaz está desconectada, no se
> siente fluido, no se siente congruente, no se siente todo como un sistema que avanza paso a paso y
> está interconectado". Diagnóstico verificado en el código de `apps/web`, no en impresiones.
> Se apoya en el modelo de tenancy de `MODELO-TENANCY-v1.4.md`.

## El diagnóstico, en una frase

La interfaz no cuenta ninguna historia porque **el proyecto no es el objeto raíz**. Hay nueve destinos
hermanos del mismo rango, seis de ellos ignoran qué cliente tienes seleccionado, y el mecanismo que
hace avanzar el sistema, el gate, no tiene ningún botón en ninguna pantalla.

## Los siete hallazgos que explican la sensación

**El selector de proyecto miente.** Solo dos vistas lo leen. Las otras seis muestran lo mismo aunque
cambies de cliente. Es la causa directa de que nada se sienta conectado.

**El gate más importante del sistema es decorado.** La función que aprueba el gate existe en el cliente
de la API y ninguna vista la llama. El tablero pinta "Gate 1 pendiente" como texto plano, y el botón
para disparar la fase siguiente está deshabilitado con la palabra "próximamente". El ciclo Entender,
Construir y Operar no tiene camino en la pantalla.

**Nada representa dónde está el proyecto.** El único indicador de avance del producto vive en el
asistente de creación y muere al terminarlo. El panel que dice qué falta para cerrar la fase está
enterrado debajo de los filtros del tablero.

**La aplicación entera tiene once enlaces salientes**, y casi todos van al mismo sitio. Una vista de
572 líneas no tiene ni un solo enlace. Desde un run no puedes volver a su tarea: el identificador está
impreso como texto muerto.

**No existe sistema visual.** La hoja de estilos son 25 líneas sin un solo token, conviven nueve
tamaños de tipografía y tres lenguajes visuales distintos, incluido un estilo inyectado dentro de un
componente. La misma columna del tablero se llama de dos formas distintas separadas por veinte píxeles.

**La bandeja de decisiones no prioriza ni agrupa.** Concatena aprobaciones y tareas en el orden que
llegan, sin proyecto, sin riesgo y sin lote. Justo cuando el sistema pasa de dos aprobaciones por
proyecto a más de diez.

**Nadie conecta el atraso con el hito.** El tablero cuenta tareas vencidas, pero ninguna pantalla dice
qué gate están bloqueando.

## El modelo mental correcto

Un proyecto de cliente avanza por un ciclo de tres fases con hitos y gates. En todo momento debe verse
dónde está, qué falta para el siguiente hito, quién está trabajando y qué espera de mí.

Tres principios que ordenan todo lo demás:

**El proyecto es el objeto raíz.** Chat, tablero, contexto, runs y agentes son lentes sobre un
proyecto, no destinos independientes.

**El gate es el motor del avance.** Cada gate tiene tres estados legibles: bloqueado con la lista de
qué falta, listo para aprobar como acción y no como cartel, y aprobado con quién y cuándo. El sistema
avanza porque los candados se abren.

**Hay dos relojes y ambos deben verse.** El del proyecto, en semanas, con fases e hitos. Y el de los
agentes, en segundos, con quién trabaja ahora. Hoy viven en vistas distintas y nunca se cruzan.

## La pantalla de entrada

Nunca más un chat vacío como puerta. Al entrar se ve **Hoy**, con tres bloques en este orden: las
decisiones que te esperan, con proyecto, fase y qué desbloquean; tus proyectos, con su posición en el
ciclo, el siguiente hito y qué falta; y el pulso, con agentes activos, fallos y coste del día.

## Navegación nueva

De nueve entradas planas a cuatro, con un segundo nivel dentro del proyecto.

| Entrada global | Qué contiene |
|---|---|
| **Hoy** | Decisiones pendientes, proyectos, pulso |
| **Proyectos** | Lista y espacio de trabajo de cada proyecto |
| **Sistema** | Ahora mismo, runs, salud de fuentes, equipo, ajustes |
| **Activo Sixteam** | Metodologías, módulos, templates, aprendizajes |

Esa cuarta entrada es exactamente lo que el modelo de tenancy llama funciones de agencia: el método,
que es de Sixteam y no de ningún cliente. Hoy está escondido en una pestaña dentro de otra vista.

Dentro de un proyecto, cinco pestañas: **Ruta, Tablero, Contexto, Conversación y Actividad**. El
selector de proyecto de la cabecera desaparece, porque el proyecto ya es el contexto.

## Qué pasa con cada vista actual

| Vista | Destino |
|---|---|
| Chat | Pestaña Conversación, más un panel invocable desde cualquier pantalla |
| Tablero | Pestaña Tablero, sin su cabecera duplicada |
| Cerebro | **Se desmonta**: contadores y fuentes a Sistema, personas y agentes a Equipo, módulos a Activo Sixteam |
| Reuniones | Panel dentro de Contexto, filtrado por proyecto |
| Asistente de proyecto | Se mantiene y se reutiliza para disparar la fase siguiente desde la Ruta |
| Enjambre | Sistema, más una versión filtrada dentro de la Ruta. Deja de ser entrada de menú |
| Runs | Pestaña Actividad del proyecto, más la vista global en Sistema. Gana columnas de tarea y proyecto |
| Detalle de run | Se mantiene, con miga de pan y enlaces de vuelta |
| Esperando por ti | **Se convierte en Hoy**: agrupada, ordenada por riesgo y con aprobación en lote |
| Contexto | Pestaña Contexto; las metodologías emigran a Activo Sixteam |
| Admin | Sistema, ajustes |
| Ficha de tarea | Se mantiene tal cual, es de lo mejor resuelto del producto |
| Panel de fase | **Se convierte en el cuerpo de la Ruta** |

## Cómo se representa el avance

Un **mapa del ciclo**: tres columnas, Entender, Construir y Operar, con los hitos en vertical dentro de
cada una y los gates intercalados como candados.

Descarté la barra de progreso, porque no puede representar veinte pasos y diez gates sin mentir: un
porcentaje no dice qué falta. Y descarté la lista de hitos, porque pierde la noción de fase y de qué
corre en paralelo.

Se dibuja con rejilla CSS, no con React Flow. No es un grafo libre, es una secuencia conocida. React
Flow se reserva para el organigrama del cliente, donde sí hay topología libre.

Lo importante: **el mapa se puede construir con datos que la API ya devuelve**. La fase del proyecto,
el estado del gate, el recibo de lanzamiento y el estado de cierre de fase, que ya entrega qué se
requiere, qué se encontró y qué falta.

## Los caminos que hay que abrir

La interconexión no es un adjetivo, es una lista de caminos que hoy no existen. Estos son los que más
pesan:

1. Desde una decisión pendiente, a la ruta del proyecto para ver qué gate desbloquea.
2. Desde una decisión, a la tarjeta que produjo el entregable, con el artefacto abierto.
3. Desde un hito de la ruta, al tablero filtrado por las tareas de ese hito.
4. Desde un gate bloqueado, a los entregables que faltan y de cada uno a la tarea que lo produce.
5. Desde una fase completa, al asistente precargado para disparar la siguiente.
6. Desde una tarjeta, al run que la trabajó, y de vuelta.
7. Desde una fila de runs, a su tarea y a su proyecto. La API ya acepta esos filtros y la tabla no los
   pinta.
8. Desde un agente del enjambre, a sus tareas abiertas.
9. Desde un documento del contexto, a las tareas y hallazgos que lo citan.
10. Desde una fuente, a los documentos que produjo y las tareas que creó.
11. Desde el tablero, a las decisiones pendientes de ese proyecto.
12. Desde una fuente degradada, a los proyectos afectados.

## Sistema visual

**El color tiene una sola gramática.** Ámbar es trabajo en curso. Violeta es que se espera una decisión
humana, y no significa nada más. Rojo es roto o vencido. Verde es cerrado o aprobado. Azul es enlace y
selección, nunca estado. Todo lo demás es estructura. Queda prohibido el color por categoría.

**Cinco tamaños de tipografía declarados como tokens**, y nada por debajo de once píxeles. Hoy hay
nueve tamaños y texto de nueve píxeles dentro de elementos que se pueden pulsar.

**Dos densidades y ninguna intermedia.** Modo operar, con filas compactas, para tablero, decisiones y
actividad. Modo explorar, con tarjetas y prosa, para ruta, contexto y método.

**Cada estado tiene un componente y se reutiliza en todas partes.** La fase, siempre en el mismo punto.
El gate, como candado cerrado con su lista, candado abierto que es un botón, o check con quién aprobó.
El agente trabajando, como punto pulsante junto al nombre, sin hacer latir el contenedor entero como
hoy, que deja el texto ilegible. El atraso, con un solo patrón, no los tres que conviven ahora.

**Queda prohibido**: emoji como icono de navegación, cabeceras oscuras por vista, estilos inyectados
dentro de componentes, enumeraciones en mayúscula mostradas al usuario, imprimir la ruta del navegador,
JSON crudo como contenido principal, y textos de estado vacío escritos para el desarrollador.

## Qué ve el tenant cliente

Del modelo de tenancy se sigue qué parte de esto alcanza al cliente: una versión reducida de la ruta,
el contexto solo con lo publicado, el deck del assessment y una bandeja con los gates que le tocan.
Nunca alcanza el enjambre, los runs, el sistema, el activo de Sixteam ni la administración.

## Orden de trabajo

Lo primero no requiere ningún dato nuevo. Eso es lo relevante: la mayor parte de esta sensación de
sistema desconectado se arregla con lo que la API ya devuelve.

1. **Tokens y gramática visual.** Sin esto, cualquier pantalla nueva nace incoherente.
2. **El shell**: proyecto como contexto, cuatro entradas, fase siempre visible.
3. **Hoy**, transformando la bandeja actual: agrupada, priorizada y con aprobación en lote.
4. **La Ruta**, cableando el gate que hoy no tiene botón y convirtiendo el panel de fase en el mapa del
   ciclo.
5. **Los caminos de vuelta**: enlaces inversos entre run, tarea, proyecto y documento.
6. **Desmontar el Cerebro** y repartir su contenido.
7. Solo entonces, las pantallas que dependen de datos que aún no existen: organigrama, procesos en
   diagrama, entrevistas y deck.

## Riesgo principal

Rediseñar mientras se construyen entidades nuevas puede dejar el producto a medias en las dos
dimensiones. La mitigación es el orden de arriba: los seis primeros pasos no tocan el modelo de datos y
se pueden completar antes de que exista la primera tabla del grafo organizacional.
