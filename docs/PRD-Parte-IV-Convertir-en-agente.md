# Parte IV, sección 13.5 — Convertir un rol, una función o un proceso en un agente

> Función definida por Ernesto el 2026-09-05. Es la pieza que une el segundo cerebro con la ejecución:
> lo que ni Puzzle ni Wonderful hacen. Estado: borrador para corrección. Depende de que exista el grafo
> (bloque B2) y la estructura de agentes (bloque B8); se construye después de la ola actual.

## 13.5.1 La idea en una frase

**Cualquier rol, función o proceso del mapa se puede convertir en un agente de IA con un clic.** El
sistema rellena la ficha del agente con lo que ya sabe del mapa, el humano decide tres cosas, y el
agente queda listo para trabajar.

Las tres decisiones humanas son: **qué tan grande y potente** es la inteligencia, **cómo se activa**
(sola en bucle, por un disparador, o bajo demanda) y **a qué herramientas accede**. Nada más. Todo lo
demás viene del mapa.

## 13.5.2 Por qué esto es el diferencial

Hoy crear un agente es empezar de cero: escribir qué hace, qué produce, qué herramientas usa, a quién
reporta. Toda esa información **ya existe en el segundo cerebro** cuando el assessment terminó. Un rol
tiene funciones, participa en procesos, responde de pasos concretos, usa sistemas identificados y
reporta a alguien. Eso es, literalmente, la ficha de un agente.

Puzzle documenta el rol pero no lo ejecuta. Wonderful ejecuta agentes pero no sabe qué rol están
cubriendo. Aquí el mapa y el agente son el mismo objeto visto desde dos lados.

## 13.5.3 Qué hereda el agente, según de dónde nace

La misma función funciona sobre tres puntos de partida, y cada uno hereda cosas distintas.

**De un rol.** Es el caso más completo. Sus funciones se convierten en el trabajo del agente y en lo
que produce. Los procesos donde participa y los pasos de los que responde son sus tareas típicas. Los
sistemas que usa en esos pasos son las herramientas que va a necesitar. A quién reporta el rol es quién
supervisa al agente. Y las personas que hoy ocupan ese rol son quienes validan lo que el agente hace.

**De una función.** Una sola responsabilidad. Nace como micro-agente, por defecto invocable como
herramienta por otros agentes. Es el caso más pequeño y el más frecuente: "analizar una cuenta",
"preparar el reporte semanal", "revisar una cotización".

**De un proceso.** La secuencia de pasos con sus responsables. El agente toma los pasos que el estado
propuesto marcó como automatizables y deja los pasos humanos como tareas o aprobaciones. Los pasos que
una plataforma cubre de forma nativa o por configuración se convierten en llamadas a herramienta. Los
que quedaron marcados como brecha no se pueden automatizar y siguen siendo humanos.

En los tres casos, el agente **queda enlazado a su origen**. Se sabe siempre de qué rol, función o
proceso nació, y si el mapa cambia, el sistema avisa de que la ficha puede estar desactualizada.

## 13.5.4 Las tres decisiones del humano

El asistente de conversión tiene tres pasos. Cada uno propone un valor por defecto que se puede cambiar.

**Uno: tamaño y potencia.** Micro-agente o empleado. Qué modelo y proveedor lo mueven. Cuánto puede
gastar por ejecución. El sistema sugiere micro-agente para una función y empleado para un rol completo,
y sugiere el modelo según la complejidad de lo que hereda.

**Dos: cómo se activa.** Tres modos, y solo tres.

| Modo | Qué significa | Ejemplo |
|---|---|---|
| **Autónomo en bucle** | Corre solo con una cadencia, vigila y actúa | Cada lunes revisa las oportunidades sin seguimiento y propone acciones |
| **Por disparador** | Despierta cuando pasa algo concreto | Cuando entra un mensaje de WhatsApp, cuando se crea una tarea, cuando un sistema envía un evento |
| **Bajo demanda** | Solo cuando alguien o algo lo invoca | Otro agente lo usa como herramienta, o una persona le pide algo |

**Tres: accesos.** El sistema lista las herramientas que el rol o proceso necesita, derivadas de los
sistemas que usa en el mapa. Las que tienen conector disponible aparecen listas para activar. Las que
no lo tienen quedan señaladas: ese paso seguirá siendo humano hasta que exista el conector. El humano
quita o añade.

Dos reglas que no se negocian en este paso: el agente nunca recibe más permisos que quien lo crea, y
toda acción con efecto hacia fuera pasa por el gate de efecto externo, como cualquier otro agente.

## 13.5.5 Qué sale

Una ficha de doce campos rellenada, con lo que no se pudo inferir marcado como pendiente para que el
humano lo complete. La especificación declarativa del agente, lista para el sistema. Y una propuesta
que pasa por el gate de aprobación de agentes antes de existir.

Al aprobarse, el agente nace con **autonomía supervisada**, una **fecha de revisión** obligatoria, y
dentro del tenant que corresponde: si nació de un rol de una empresa cliente, pertenece a ese tenant y
no ve nada de otros clientes.

Nunca se borra. Se archiva, y su historial queda.

## 13.5.6 Tres reglas que evitan los problemas previsibles

**Un agente no reemplaza a una persona por defecto.** Si el rol de origen lo ocupa alguien hoy, el
agente nace como **asistente de ese rol**: la persona es su dueña humana y valida lo que hace. Solo
cuando el estado propuesto del proceso dice explícitamente que un paso pasa a la inteligencia
artificial, el agente lo toma. Esto evita que "convertir en agente" se lea como "despedir", que es lo
primero que va a pensar cualquier empleado del cliente que lo vea.

**La autonomía se gana, no se configura.** Todo agente empieza supervisado. Pasa a asistido y luego a
autónomo cuando sus resultados llevan un tiempo aprobándose sin cambios, y esa subida la decide una
persona. Nunca se crea un agente autónomo de golpe.

**El agente no sabe más que el mapa.** Si un rol tiene sus funciones a medio mapear, el agente heredará
funciones a medias, y la ficha lo dirá. Esto convierte la función en un incentivo para mapear bien:
cuanto mejor está el segundo cerebro, mejores agentes salen de él.

## 13.5.7 Dónde vive en la interfaz

Un botón, **Convertir en agente**, en tres sitios: el panel de un rol en el organigrama, el panel de
una función, y el panel de un proceso en el flujograma. Y un cuarto punto de entrada, desde el plan:
cada palanca puede proponer "estos pasos pasan a un agente", y ese enlace abre el mismo asistente ya
apuntando al proceso correcto.

## 13.5.8 Historia de usuario

**US-S20 — Convertir un rol, función o proceso en agente.**

- CA-S20.1 Desde el panel de un rol, función o proceso existe la acción de convertir en agente, que
  abre un asistente de tres pasos: tamaño y potencia, modo de activación, accesos.
- CA-S20.2 La ficha resultante trae rellenados, desde el mapa, al menos: el trabajo, lo que produce, a
  quién reporta, quién valida, y la lista de herramientas derivada de los sistemas que usa el origen.
  Lo no inferible queda marcado como pendiente y visible.
- CA-S20.3 Las herramientas sin conector disponible se muestran como no activables y el paso
  correspondiente queda marcado como humano; no se puede aprobar un agente con una herramienta sin
  conector como activa.
- CA-S20.4 El agente creado no puede tener permisos que su creador no tenga, y su especificación
  registra el rol, función o proceso de origen.
- CA-S20.5 Un agente nacido de un rol ocupado por una persona nace con esa persona como dueña humana y
  en autonomía supervisada; no existe la opción de crearlo autónomo en el primer paso.
- CA-S20.6 Si el rol, función o proceso de origen cambia después, el agente muestra un aviso de ficha
  posiblemente desactualizada con el diff de lo que cambió.
- CA-S20.7 Todo agente convertido pasa por el gate de aprobación de agentes; sin aprobación no existe
  en el catálogo ni puede recibir tareas.

## 13.5.9 Qué necesita del sistema

Depende de dos bloques que aún no existen: el grafo organizacional, para tener de dónde heredar, y la
estructura de agentes ampliada, para tener dónde guardar tamaño, activación, contextos y expiración.
También del catálogo de plataformas con sus conectores, para saber qué herramienta se puede activar.

Sobre lo que ya existe hoy: la creación y clonación de agentes por MCP, el versionado de prompts, la
jerarquía de agentes, el gate de efecto externo y el kill switch. Todo eso se reutiliza tal cual.

---

## Supuestos que tomé

**Un agente por proceso, no un agente por paso.** Convertir un proceso produce un agente que ejecuta
los pasos automatizables de ese proceso. La alternativa, un micro-agente por paso, fragmenta y complica
la supervisión. Si un paso concreto merece agente propio, se convierte desde la función que lo cubre.

**"Plantilla de trabajo de agente" es la ficha de doce campos más la especificación declarativa** que
ya definimos, prellenada. Si te referías a otra plantilla, dímelo y la incorporo.

**El botón no aparece sobre el estado actual, solo sobre el propuesto**, salvo para funciones. Convertir
un rol tal como opera hoy, sin haber decidido qué debería hacer, produce un agente que replica los
problemas. La excepción son las funciones, que son lo bastante pequeñas para convertirse tal cual.
