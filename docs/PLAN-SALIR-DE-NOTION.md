# Salir de Notion sin perder nada — plan de acción

> Verificado contra el código el 2026-09-05, en tres frentes: el módulo de tareas, la migración de
> datos y el despliegue. Este documento existe porque hay una fecha real de por medio.

## La conclusión, sin rodeos

**Si Notion se apaga hoy, se pierde todo.** No hay ni una copia descargada ni una línea de código que
escriba los datos de Notion dentro de AgentOS. Se perderían las tareas, los proyectos, sus estados,
asignados, fechas, relaciones, dependencias, etiquetas, horas, comentarios y adjuntos.

Y además se romperían en caliente seis rutas que hoy funcionan en el servidor: crear tareas por voz,
por chat de WhatsApp, desde una reunión, las tareas de cliente, el seguimiento de vencimientos y los
clips. Todas escriben en Notion y no tienen otro destino.

La buena noticia: **el trabajo que falta es de días, no de semanas**, y hay tres movimientos que quitan
casi todo el riesgo hoy mismo.

## Lo que hay que hacer hoy

Tres cosas, en este orden. Ninguna depende de decisiones de producto.

### 1. Descargar la copia de Notion

El capturador está construido y probado. Solo hay que ejecutarlo. Lee, no escribe: Notion no se toca.

Eso congela las tareas y los proyectos en un archivo con sus hashes, y **quita la urgencia de golpe**.
A partir de ese momento, aunque Notion se apague, los datos están. Es cuestión de minutos.

Dos cosas que el capturador todavía no hace y conviene añadirle antes o justo después: descargar los
adjuntos, porque las direcciones de Notion caducan, y capturar lo archivado.

### 2. Poner a salvo el código

Hay unas 9.300 líneas sin commitear, incluido el módulo de tareas entero, y ningún repositorio remoto.
No existe copia fuera de tu disco.

Crear un repositorio privado, commitear todo en una rama y subirlo. Media hora. Es lo único que hoy
puede costarte el trabajo de tres días de otra persona.

### 3. Reconciliar la base con el repositorio

La base viva tiene 25 tablas y el esquema commiteado tiene 23. Restaurar desde el repositorio hoy
dejaría la aplicación rota contra su propia base. Se resuelve al commitear la migración que ya está
aplicada.

## Lo que falta para que el equipo lo use

Aquí está el hallazgo incómodo: **el módulo no puede reemplazar Notion todavía**, y no por lo que
parecía.

Toda la lógica difícil está construida y probada. Lo que falta es interfaz.

**No se puede crear una tarea desde la pantalla.** La función existe en el cliente y ningún componente
la llama. No hay botón. Es lo primero.

**No se puede cerrar una tarea desde la pantalla.** El sistema exige adjuntar evidencia para dar algo
por terminado, y no hay forma de adjuntar. Arrastrar a terminado falla y la tarjeta vuelve sola.

**El acceso es una contraseña compartida y elegir tu nombre de una lista.** Cualquiera entra como
cualquiera y ve todo. Para que Sebastián, Jorge o Jefferson lo usen, hace falta contraseña por persona.

**Las notificaciones no llegan.** El envío está apagado por defecto y el recordatorio de vencimiento
existe pero nadie lo dispara: falta el reloj que lo llame.

**Falta búsqueda, etiquetas y una vista de "mis tareas" que cruce proyectos.** Con más de cien tareas el
tablero deja de ser navegable.

Los cuatro primeros son de esfuerzo bajo o medio. El quinto se puede posponer unas semanas.

## Lo que falta para ponerlo en el servidor

**Postgres no hace falta.** Ese era el bloqueo que hacía parecer esto un proyecto de semanas. La
aplicación nunca intenta usar Postgres: los repositorios existen pero nadie los invoca. Y para un solo
proceso de API, SQLite en un volumen persistente aguanta de sobra. Portar todo costaría semanas y no
compra nada que el equipo necesite el lunes.

Con esa decisión, el despliegue es corto. Pero hay tres cosas que no se pueden saltar:

**Declarar el volumen de datos.** Hoy la carpeta de datos está excluida de la imagen y ningún archivo
declara dónde vive. Si el servicio arranca sin volumen montado, la aplicación crea una base nueva, la
puebla sola, y todo lo que el equipo escriba desaparece en el siguiente despliegue. Sin error, porque
técnicamente funciona.

**Cerrar la puerta de la contraseña de desarrollo.** Si la variable de contraseña no se carga, la
aplicación arranca igual con la de desarrollo y solo lo dice en un log. Sumado a que el listado del
equipo es público, un dominio publicado sería adivinable el primer día.

**Copia de seguridad probada antes de meter datos reales.** No existe ninguna hoy.

Y un detalle que haría fallar el primer intento: la versión del gestor de paquetes en el archivo de
construcción no coincide con la que generó el archivo de dependencias. Hay que alinearla antes de subir.

## Lo que hay que decidir

**El alcance de la migración es más estrecho que el uso real.** El plan cubre solo las bases de tareas y
proyectos. Pero el servidor escribe hoy en varias más: reuniones, tareas de cliente y clips. Redirigir
esas tres es trabajo adicional que no está contemplado. Hay dos caminos: ampliar el alcance, o dejar
esas tres en Notion por ahora y salir solo de tareas y proyectos.

**Hay campos de Notion sin destino en AgentOS.** Etiquetas, horas estimadas y reales, y varios campos de
proyecto como responsable, fase y fechas. O se les crea sitio, o se aceptan como pérdida y se archivan
solo como historial de lectura.

**Y hay campos obligatorios en AgentOS que Notion no tiene**, como la etapa de la tarea y el tipo de
proyecto. Hay que decidir un valor por defecto o la importación falla.

## El orden completo

Primero, lo que protege: copia de Notion, código a salvo, base reconciliada.

Segundo, lo que hace usable el módulo: crear tarea, cerrar tarea con evidencia, contraseña por persona,
notificaciones que llegan de verdad.

Tercero, la migración: las tablas de trazabilidad, el mapa de campos decidido, el importador que hoy no
existe, y una prueba con diez tareas y tres proyectos antes de traerlo todo.

Cuarto, el servidor: volumen, seguridad, copia de seguridad, y arrancar con los agentes pausados
durante las primeras 48 horas.

Quinto y último, el corte: redirigir lo que hoy escribe en Notion, y recién entonces apagarlo.

La pieza más grande de todo esto es el importador, porque no existe nada. Todo lo demás es completar
cosas que ya están construidas a medias.
