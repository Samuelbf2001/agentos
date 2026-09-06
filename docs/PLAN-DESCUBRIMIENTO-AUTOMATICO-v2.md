# Plan — Descubrimiento automático de procesos por observación (Assessment v2)

> Baja a ejecución la decisión de Ernesto del 2026-09-06 (PRD Parte III §9.10). Es el equivalente
> Sixteam del módulo *Companion* de Within, adaptado a PYME LATAM sin SOC 2 y con WhatsApp como canal.
> Nombre propuesto del componente: **Bitácora** (alternativa descartada: "Compañero", calca de Within).
> Todo dato de terceros va marcado **[confirmado]** o **[inferido]**. Fuentes al final.

**La tesis en una frase:** no capturamos pantallas, capturamos **la forma de la pantalla**. Todo texto que
sale del computador pasa antes por un plantillador local que lo convierte en `Cotización #<num> — Odoo`.
Lo que viaja es la plantilla; el valor del hueco se descarta o se convierte en un hash con sal del tenant.
Eso hace que "observar el trabajo, no al trabajador" sea **una propiedad comprobable con tests**, no un lema.

---

## A. Qué se captura y qué no

### A.1 Las señales, una por una

| Señal | Valor para el mapa | Riesgo | Coste | Decisión |
|---|---|---|---|---|
| App en primer plano + **plantilla** del título | Alto: identifica sistema y objeto | Medio (el título literal filtra nombres y montos) | Bajo | **v2.1** |
| **Origen + plantilla de ruta** de URL (`crm.x.com/deals/<id>`) | Muy alto: en PYME casi todo es web | Medio (la URL cruda lleva IDs y query) | Medio | **v2.0** |
| Cambio de pestaña, foco, inactividad, bloqueo de sesión | Alto: sin esto el tiempo medido miente | Nulo | Bajo | **v2.0** |
| Contadores de clics y teclas por ventana de 60 s | Medio: mide esfuerzo | Bajo si son solo conteos | Bajo (web) / Medio (escritorio) | **v2.0** web / **v2.1** escritorio |
| Evento **copiar/pegar** (que ocurrió, entre qué pantallas) | Muy alto: es la huella del trasvase manual | Bajo (sin contenido) | Bajo | **v2.0** |
| Nombres de controles invocados por API de accesibilidad (solo botón, menú, pestaña, enlace) | Alto: da el verbo ("Guardar", "Enviar") | Medio (una celda de grilla es dato) | Alto | **v2.1**, Windows primero |
| Nombre de documento abierto, plantillado | Medio: identifica artefactos y hojas de cálculo sombra | Medio | Bajo | **v2.1** |
| **Captura de pantalla o vídeo en modo pasivo** con OCR/VLM | El más rico de todos | **Inaceptable** | Muy alto | **NUNCA** |
| Captura **a petición de la persona** (vídeo narrado de 5-10 min) | Muy alto y con la intención explicada | Bajo (la persona elige qué mostrar) | Medio | **v2.1** |
| Contenido del portapapeles | Alto | Inaceptable | Bajo | **NUNCA** |
| Texto tecleado, micrófono, cámara, ubicación, contenido de documentos | — | Inaceptable | — | **NUNCA** |

Dos decisiones fuertes están en esa tabla. La primera: **v2.0 es solo extensión de navegador**: cubre la
mayor parte del trabajo de una PYME sin instalador, sin permisos de administrador, sin ganchos de teclado y
sin alarma del antivirus. La segunda: **la captura pasiva de pantalla no llega nunca**. Within la sostiene
con SOC 2 Type II y clientes Fortune 500 [confirmado]; nosotros no, y encima cuesta dos o tres órdenes de
magnitud más (§E, coste de inferencia). Sí adoptamos su otra mitad: el vídeo narrado por el propio empleado [confirmado].

### A.2 El plantillador local: dos barreras y ninguna limpieza silenciosa

Todo texto (título, ruta de URL, nombre de control, nombre de archivo) atraviesa en el dispositivo:

1. **Lista blanca.** Si la app o el dominio no está autorizado, no se genera ni el evento. Es el modelo
   opt-in de Soroco: nada se captura hasta que se permite explícitamente [confirmado].
2. **Ranurado.** Números, IDs, correos, teléfonos, montos, fechas y nombres propios pasan a `<num>`,
   `<id>`, `<pii>`. De cada ranura se guarda `HMAC(clave_del_tenant, valor)` truncado a 64 bits: el
   **ancla**, que dice que dos pantallas hablan del mismo caso sin decir de qué caso.
3. **Presupuesto de entropía.** Si tras el ranurado quedan demasiados tokens desconocidos, la cadena **se
   descarta entera** y viaja solo su hash: el patrón se puede contar, el texto no se puede leer.
4. **Barrera de ingesta.** El endpoint **rechaza** el lote cuyo texto no case con la gramática de
   plantillas; no lo limpia. Un lote rechazado es un reporte de error; uno limpiado en silencio es una fuga
   que nadie encuentra. Es el "denegar por defecto" de Tenancy v1.4 aplicado a los datos.

Se prueba con un corpus de títulos y URLs reales de Sixteam y un test que falla si algo sin ranurar pasa.
### A.3 Qué ve cada quien

| | Evento crudo | Agregado por proceso | Agregado por persona | Mapa validado |
|---|---|---|---|---|
| La persona observada | Sí, el suyo, en vivo | Sí | Sí, el suyo | Sí |
| Dueño de proceso (cliente) | No | Sí | No (salvo regla k=3) | Sí |
| Sponsor (cliente) | No | Sí | No | Sí |
| **Sixteam** | **No, nunca** | Sí, con k≥3 | **No, nunca** | Sí |

La identidad se pseudonimiza, no se anonimiza: `subject_id = HMAC(secreto_del_tenant, persona)`. Decirlo
así es más honesto que llamarlo anónimo. El administrador del tenant cliente puede reidentificar —hace
falta para "borra lo mío"—; Sixteam no puede, porque el secreto no sale del tenant.

**Regla k=3.** Ningún agregado se muestra a nadie si proviene de menos de tres personas distintas. Con una
excepción que importa en PYME: cuando un proceso lo ejecuta **una sola persona**, esa persona autoriza
expresamente la publicación de su agregado. Y esa autorización, o su negativa, es en sí misma el hallazgo:
un proceso con un solo ejecutor es una **brecha de continuidad** (PRD §9.4).

### A.4 Consentimiento

Flujo por persona, en español, sin letra pequeña:

- **Pantalla de inicio** que enumera las señales con **un ejemplo real** de lo que se enviaría desde su
  equipo, no una descripción abstracta.
- **Autorización previa, expresa e informada**, versionada, con fecha, por nivel (nivel 1 metadatos /
  nivel 2 vídeo narrado). Se firma **por cápsula** —el mecanismo de Tenancy v1.4—, sin crear cuenta.
- **Indicador siempre visible** (icono en la barra) y **pausa de un clic**; en pausa no se escribe nada.
- **Apagados automáticos por defecto**: fuera de horario laboral, en sesión bloqueada, y en todo lo que no
  esté en la lista blanca. Cada persona puede **quitar** apps de esa lista; nunca añadir.
- **Borrado a petición**: "borra mis últimos 7 / 30 días", efecto inmediato y comprobante. Al borrar, las
  afirmaciones derivadas pierden esa evidencia y bajan su soporte; si caen bajo el mínimo, vuelven a
  pendientes. El borrado no puede dejar un mapa que ya no se puede defender.
- **Cláusula de no consecuencia**, firmada por el sponsor: pausar o salir no tiene efecto laboral alguno.

**Qué revisar con abogado (esto no es asesoría legal).** En Colombia la referencia es la Ley 1581 de 2012
(habeas data): autorización previa, expresa e informada y principio de finalidad [confirmado]. Cinco
preguntas concretas: (1) redacción de la autorización, y si el nivel 2 exige una aparte; (2) si procede
registrar la base ante la SIC (RNBD); (3) qué debe decir el reglamento interno de trabajo para que esto no
sea monitoreo laboral encubierto; (4) si la autorización dada dentro de una relación laboral se considera
libre, y qué salvaguarda la sostiene; (5) el contrato Sixteam-cliente, donde Sixteam debe figurar como
**encargado** y quedar impedido de recibir datos por persona. Fuera de Colombia hay que repetirlo: México
LFPDPPP, Perú 29733, Chile 21.719, Argentina 25.326, Ecuador LOPDP.

---

## B. Arquitectura

### B.1 Bitácora Navegador (v2.0) y Bitácora Escritorio (v2.1)

**Navegador: extensión MV3 para Chrome y Edge** (Firefox después). Es la pieza de v2.0 porque el cliente
de escritorio no ve dentro del navegador: el título de una pestaña no es una URL y una aplicación de una
sola página ni siquiera cambia el título. Celonis hace exactamente ese reparto, app de escritorio más
extensiones opcionales [confirmado]. Distribución sin tienda: CRX autoalojado con `update_url` propio,
instalado por política del Google Workspace del cliente, o a mano en cinco minutos.

**Escritorio: Tauri v2 (Rust), no Electron.** La capa de captura es nativa de todos modos (Win32 + UI
Automation en Windows, CoreGraphics + AX en macOS), así que Rust con FFI encaja mejor que módulos nativos
de Node, y el instalador pesa decenas de megas en vez de cientos. Screenpipe, que es Rust y hace algo más
pesado que esto, apunta a <1% de CPU y <400 MB de RAM [confirmado]; nuestro objetivo, sin OCR ni imágenes,
es **<1% CPU y <120 MB**. Windows 10/11 primero, macOS después: UI Automation lee el árbol completo de una
vez y en macOS hay que ir atributo por atributo [confirmado], y esa asimetría es toda la razón del orden.
Firma: certificado EV en Windows —sin él SmartScreen mata la instalación en una PYME— y Developer ID con
notarización en macOS. Actualización por el updater firmado de Tauri contra un endpoint de AgentOS.
### B.2 Canal de subida

Lotes cada 60 s o 200 eventos, gzip sobre TLS. Credencial: **cápsula por persona**, token firmado con
`tenant`, `subject_id`, `scope=bitacora.ingest`, caducidad 30 días renovable, revocable desde la pantalla
de la persona. Sin conexión: buffer local circular (SQLite en escritorio, IndexedDB en la extensión) con
tope duro de 50 MB / 72 h y descarte del más antiguo. Contrapresión: 429 con `Retry-After` y espera
exponencial. Idempotencia por `subject_id + secuencia_de_lote`, para que reintentar no duplique.
Endpoint `POST /api/tenants/:tenantId/bitacora/eventos`, **cerrado hasta que el gate G-OBS esté aprobado**
(fail-closed, como el modo sandbox).

### B.3 Almacén crudo, separado del grafo

Esquema `obs_*` en Postgres, particionado por día, **retención 30 días por defecto** (configurable 7-90 por
el cliente). Los derivados (`obs_sesiones`, `obs_unidades`, `obs_secuencias`) viven 12 meses; las
afirmaciones, siempre. Volumen estimado por persona y día:

| Modo | Eventos/día | Tamaño/día | 20 personas x 30 días |
|---|---|---|---|
| v2.0 (extensión) | 600-1.500 | 0,3-1 MB | 0,2-0,6 GB |
| v2.1 (+ escritorio y accesibilidad) | 5.000-20.000 | 3-10 MB | 2-6 GB |
| Con captura de pantalla (rechazado) | — | **~900 MB** [confirmado, screenpipe] | ~540 GB |

Esa última fila es, por sí sola, un argumento suficiente. Todo **[inferido]** salvo lo marcado.

### B.4 Qué se reutiliza y qué hay que construir antes

Se reutiliza: la modalidad de afirmación (se añade `observada` junto a descriptiva, normativa y reportada),
el mecanismo de cápsula, el patrón de publicación por fotografía, el gateway con perfil `ro` para el agente
que lee observaciones, y el `variant` que ya existe en `processes`. **Advertencia honesta:** las tablas
`interviews` y `claims` **no existen hoy** —verificado en `packages/db/src/schema.ts`— y tampoco hay
multi-tenant. Este plan no se puede empezar por el pipeline: se empieza por B0 y B1 (§E, orden y dependencias).

---

## C. De eventos a procesos

Ocho etapas. Las seis primeras son deterministas; el modelo de lenguaje entra en la séptima y solo nombra.

**0 · Normalización.** Salida: `(subject_id, ts, app, pantalla_id, acción, ms, anclas[])`, con `pantalla_id`
= hash de app + plantilla de ruta + plantilla de título. Produce el **diccionario de pantallas**, primer
entregable y revisado a mano: alguien nombra una vez cada pantalla frecuente, y eso hace legible lo de abajo.

**1 · Sesionización.** Corte por inactividad >180 s, bloqueo de sesión o suspensión. Salida: `obs_sesion`
con inicio, fin, segundos activos y conjunto de apps.

**2 · Unidad de trabajo.** La etapa difícil: aislar *una* instancia de tarea del negocio ("cotizar a un
cliente"). Cuatro reglas, en orden. **Ancla compartida**: dos pantallas separadas en el tiempo con el mismo
hash de ancla son el mismo caso —esto da la noción de *case id* del process mining **sin haber leído nunca
el identificador**, y es la idea técnica central del pipeline—. **Cambio de asunto**: si las anclas de la
ventana actual no intersecan con las de la anterior, se corta. **Retorno a pantalla de inicio**: bandejas y
listados, detectados solos por alto grado de entrada y permanencia corta. **Cortes duros**: fin de sesión y
45 minutos.

**3 · Secuencia de pasos.** Se colapsan eventos consecutivos en la misma pantalla en un paso con su
permanencia y sus contadores. Una traza típica: de 4 a 25 pasos.

**4 · Proceso y variantes.** Dos niveles. **Proceso**: agrupación por similitud del *conjunto* de pantallas
(Jaccard ≥ 0,6, agrupación por densidad sobre el grafo de vecinos). **Variante**: dentro de un proceso,
firma de la secuencia ordenada tras colapsar bucles (`A B B B C` → `A B{3} C`); dos trazas son la misma
variante si y solo si la firma colapsada coincide. Eso produce la explosión de Within (4.000 variantes
sobre 70 procesos [confirmado]), así que se jerarquiza: una variante es **troncal** si cubre ≥10% de los
casos o ≥5 casos, y solo se muestra si además está **explicada** por una dimensión —persona, sucursal, tipo
de cliente—, medido con lift y chi-cuadrado, no con un modelo. Lo demás se resume: *"cola: 312 casos, 118
variantes, ninguna sobre 0,4%"*. Una cola larga no es ruido: es la ausencia de estándar, y es un hallazgo.
**5 · Volumen y tiempo.** Por paso: casos/mes (extrapolados con factor explícito, con aviso si la ventana
observada es menor de 10 días hábiles), mediana y p90 de permanencia. Dos números distintos y no
intercambiables: **tiempo activo medido** (el que entra al costo por hora) y **tiempo de ciclo en
calendario** (el que incluye la espera de un tercero). Confundirlos es lo que hace indefendible una cifra.
Alimenta el costeo de §9.5 con el origen nuevo **"medido por observación"**, que pesa más que "declarado".

**6 · Nombrado (aquí, y solo aquí, entra el LLM).** Recibe el diccionario de pantallas, la lista de pasos
con conteos y tiempos, y la narrativa de la empresa. Devuelve nombre del proceso, nombre de cada paso y un
párrafo de resumen. **No puede añadir, quitar ni reordenar pasos**: la única herramienta que se le expone
es `nombrar_pasos(secuencia_id, nombres[])` con verificación de aridad, y cada nombre se guarda contra un
paso que ya tiene eventos detrás. El control de alucinación no es una instrucción del prompt: es que no
existe camino de escritura que permita inventar un paso. El VLM solo aparece en el vídeo narrado, leyendo
una pantalla que la persona está enseñando a propósito.

**7 · Afirmaciones observadas.** Cada salida es un `claim` con `modalidad='observada'`, soporte
`{casos, personas, sesiones, ventana}`, `evidence_refs` a `obs_secuencia` (nunca a eventos crudos) y
confianza derivada del soporte y de la cohesión del grupo. Aquí se aplica k=3.

**8 · Propuesta al grafo.** Nunca escritura directa: propuesta sujeta a validación humana, con la regla
anti-pisado intacta. El cruce con entrevistas y documentos:

| Situación | Qué se produce |
|---|---|
| **Observado y no mencionado** | Pregunta pendiente, colgada del rol que lo ejecuta, e inyectada en la guía del entrevistador. Es la salida más valiosa: lo que nadie cuenta porque es obvio |
| **Mencionado y no observado** | Hilo abierto con **tres causas posibles**: pasa fuera del computador, pasa en una app fuera de la lista blanca, o no pasa. El sistema no elige, pero **descarta las que los datos excluyen** (si la app estaba en la lista y tuvo cero eventos, la segunda cae). Una contradicción vaga se vuelve una pregunta decidible |
| **Contradicción de hecho** | Decisión del sponsor, en la pantalla en lote de §9.4 |

Y la extensión de la regla "gana quien ejecuta" de §9.3: **la observación es el relato del ejecutante
llevado al extremo**, así que vence al del jefe. Pero pierde frente al ejecutante cuando este dice "eso lo
hago fuera del computador", porque ahí la observación es ciega y él lo sabe.

---

## D. Lo que ve el humano

**Dueño de proceso — "Lo que observamos".** Procesos propuestos ordenados por costo mensual medido. Cada
uno se abre en su variante troncal dibujada como flujo (React Flow, bloque B3), con nombre editable por
paso, pantallas detrás, casos, tiempo mediano y el **rol** que lo ejecuta —nunca un nombre—. Acciones:
aceptar, corregir, rechazar, **partir** ("esto son dos procesos") y **fusionar** ("esto ya es X"). La
evidencia siempre es agregada: *"37 casos, 4 personas, 12 días, pantallas: Odoo>Cotización, Gmail>Redactar"*.
Se puede abrir **un** caso concreto, sin sujeto, solo en variantes con tres o más ejecutantes.

**La persona — "Mi bitácora".** Un clic desde el icono, o por cápsula sin cuenta. Contiene: el **espejo en
vivo** —las filas literales que salieron de mi equipo en la última hora, legibles—, mis totales por app y
día, en qué procesos aparezco, pausar / parar hoy / parar del todo, borrar 7 o 30 días con comprobante, y
la lista blanca con un interruptor por app para quitar. El espejo es la única funcionalidad que gana la
reunión de presentación: nadie discute con lo que puede leer.

**Ruta y gates.** La observación es un **momento nuevo**, entre Arranque y Entrevistas, en **paralelo** con
ellas durante 10-15 días hábiles. Aparece un gate previo, **G-OBS**, que aprueba el sponsor: alcance de
apps, personas y duración, con el consentimiento de cada una registrado; sin G-OBS el endpoint de ingesta
está cerrado. Y **G-ASIS gana una condición**: ninguna afirmación observada llega al mapa sin que un humano
la haya aceptado, corregido o rechazado, y el gate bloqueado dice cuáles faltan y enlaza a su tarea (§9.8).

---

## E. Plan de construcción

**v2.0 — "Lo que pasa en el navegador".** Extensión MV3 en Chrome y Edge, Windows y macOS con el mismo
código. Señales: origen y plantilla de ruta, plantilla de título, cambio de pestaña, inactividad,
contadores, copiar/pegar, anclas. Plantillador con presupuesto de entropía, ingesta que rechaza, almacén
crudo, etapas 0-5 deterministas, etapa 6 de nombrado, las dos pantallas, G-OBS. **Precisión aceptable y
cómo se mide:** F1 ≥ 0,70 en detección de unidad de trabajo contra 100 unidades etiquetadas a mano, y
≥ 60% de afirmaciones aceptadas sin cambio —la misma métrica con la que se mide a Sam en §9.7—. Ambas se
miden en el piloto interno, nunca por primera vez en un cliente.

**v2.1 — "El escritorio".** Tauri en Windows: app en primer plano, plantilla de título, nombres de
documento, inactividad y bloqueo, y nombres de controles invocados por UI Automation limitados a botón,
menú, pestaña y enlace. Más la **observación asistida**: vídeo narrado que sube la propia persona, leído
con VLM. macOS después de Windows.

**v2.2 — "Medición continua".** La observación sobrevive al assessment y se vuelve la capa de medida de la
fase Operar: mide si el to-be ocurrió de verdad, con antes y después sobre el mismo proceso. Es el
argumento que ninguna consultora puede dar y que Within tampoco vende, porque se retira tras el mapa.
Añade inferencia de dimensiones (sucursal, tipo de cliente) desde las anclas.

**Piloto con el equipo de Sixteam, antes de cualquier cliente.** Cinco a ocho personas, 15 días hábiles,
solo extensión. Truco metodológico que lo hace válido: antes de mirar un dato, el equipo escribe y **sella**
la lista de procesos que cree tener; sin eso todo hallazgo parece obvio a posteriori. Se mide: procesos
sellados que el sistema encuentra; procesos que encuentra y **no** estaban en la lista y el equipo
reconoce; F1 contra 100 etiquetas; % aceptado sin cambio; horas hasta el primer mapa usable; consumo de
recursos; y el dato incómodo, **cuántas personas pausaron y por qué**. **Éxito:** ≥ 8 de 15 procesos
sellados descubiertos, ≥ 3 descubrimientos nuevos reconocidos, **cero** eventos con texto sin ranurar en
ingesta (uno solo invalida el piloto), ≥ 60% de aceptación, nadie desinstala.

**Coste de inferencia, en órdenes de magnitud.** *Sin VLM*: las etapas 0-5 son SQL y Rust, cero. El LLM se
invoca una vez por variante troncal, no por persona y día: un cliente de 20 personas con ~70 procesos y ~5
variantes troncales son ~350 llamadas de 3-6k tokens en todo el engagement, del orden de **$3-10 por
engagement**, o **menos de $0,02 por persona y día**. Céntimos. *Con VLM en el camino pasivo*, la opción
que rechazamos: ~900 capturas útiles por persona y día a ~1.000-1.500 tokens por imagen son 1-1,4 M de
tokens diarios por persona, **$1-5 por persona y día**, unos **$400-2.000 por engagement**, más ~900 MB
diarios de almacenamiento por persona. Entre 100 y 1.000 veces más caro [inferido, salvo el almacenamiento].
*Vídeo narrado*: uno o dos por persona, una sola vez, $0,20-1,00 cada uno. Irrelevante.

**Orden y dependencias sobre los bloques del PRD.** Prerrequisitos duros: **B0** (Postgres asíncrono, por
volumen y particionado) y **B1** (tenancy, porque "nada sale del tenant del cliente" es hoy literalmente
inconstruible: el gateway nunca consulta la organización). **B2** para tener dónde escribir, con la entidad
`variante de proceso` añadida antes. **B4** para cruzar con entrevistas. **B3** para las pantallas. Este
trabajo es **B14**, en tres piezas: `B14a` captura + ingesta + almacén crudo, que depende solo de B0 y B1 y
**puede ir en paralelo con B2 y B4**; `B14b` pipeline y afirmaciones, que depende de B14a, B2 y B4; `B14c`
pantallas, G-OBS y la condición nueva de G-ASIS, que depende de B14b y B3. El costeo con origen "medido por
observación" entra en B5.

---

## F. Riesgos y decisiones

### F.1 Ocho riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | Muere en la reunión de presentación: "esto es un espía" | El espejo demostrado en vivo en el arranque, lista blanca aprobada por el propio equipo, v2.0 sin instalador, y Sixteam observado primero con resultados publicados |
| 2 | Fuga de contenido por un título o una URL | Dos barreras, ingesta que rechaza en vez de limpiar, tests con corpus real, y auditoría mensual de "lo que salió" leída por un humano |
| 3 | La unidad de trabajo se detecta mal y el mapa sale ruidoso | F1 medido contra etiquetas antes de tocar un cliente; bajo cierta confianza la afirmación no llega al grafo, se vuelve pregunta para la entrevista. Mejor una pregunta que un proceso falso |
| 4 | Sesgo de lo observable: el teléfono, el pasillo y la visita al cliente son invisibles | Nunca presentar el mapa observado como completo; cada proceso muestra su **cobertura observada**; el hilo "mencionado y no observado" es salida de primera clase, no error |
| 5 | El antivirus o el EDR bloquean el cliente de escritorio, o TI del cliente no deja instalar | v2.0 no tiene app de escritorio; cuando llegue, firma EV, sin gancho de teclado por defecto y nota de excepción para el TI del cliente |
| 6 | Deriva de pantallas: el cliente actualiza su CRM y el proceso se parte solo, en silencio | Vigilancia de cobertura del diccionario: alerta cuando cae el porcentaje de eventos que casan con plantillas conocidas; lo nuevo va a la cola de "¿qué es esta pantalla?" |
| 7 | Reidentificación: con seis personas, una variante de un solo ejecutante lo identifica | Regla k=3 y autorización expresa del ejecutante único; el `subject_id` no sale del tenant cliente |
| 8 | El consentimiento dado dentro de una relación laboral puede no considerarse libre | Cláusula de no consecuencia firmada por el sponsor, revisión de abogado sobre autorización y reglamento interno, y diseño donde el agregado por persona **no es entregable de nada** |

### F.2 Cinco decisiones que solo puede tomar Ernesto

| Decisión | Recomendación | Por defecto |
|---|---|---|
| ¿v2.0 es solo extensión, o extensión y escritorio a la vez? | Solo extensión: se pierde cobertura de Excel y sistemas de escritorio, se gana la reunión, el tiempo y la ausencia de instalador | **Solo extensión** |
| ¿Capturamos pantalla en algún modo pasivo? | Nunca en pasivo. Sí a petición de la persona, con vídeo narrado, que es lo que Within ya demostró que funciona | **Nunca en pasivo** |
| ¿Lista blanca o lista negra de aplicaciones? | Blanca. Cuesta cobertura real y obliga a mantenerla; es la única versión defendible ante un empleado y ante un abogado | **Blanca** |
| ¿Puede Sixteam ver datos crudos del cliente, aunque sea para depurar? | No, ni para depurar: soporte con métricas agregadas y con el espejo que el cliente comparte en sesión. Es caro de sostener en ingeniería y hay que asumirlo | **No** |
| ¿La observación sigue viva tras el assessment? | Sí, opcional, con consentimiento nuevo y contrato aparte: convierte el antes-y-después en medible, que es justo lo que ningún competidor vende | **Sí, opt-in** |

## Fuentes

- **Celonis Task Mining** — app de escritorio más extensiones de navegador opcionales; clics, teclas y desplazamiento con OCR. `docs.celonis.com/en/task-mining-desktop-application.html`
- **Soroco Scout** — opt-in estricto por app y URL, hash del identificador de usuario, depuración de PII, agregados de equipo y nunca de individuos. `soroco.com/scout-data-privacy-faq/`
- **UiPath Task Mining** — captura por acción con OCR, solo desde apps y dominios aprobados; su propia documentación advierte que el módulo de PII puede fallar. `docs.uipath.com/task-mining/.../protection-of-personal-data-and-privacy-of-the-users`
- **Screenpipe** — captura por eventos con árbol de accesibilidad y OCR de reserva; ~300 MB por 8 horas, objetivo <1% CPU y <400 MB RAM. `docs.screenpi.pe/architecture`
- **Microsoft UI Automation** y accesibilidad de macOS — Windows lee el árbol completo de una vez, macOS atributo por atributo. `learn.microsoft.com/windows/win32/winauto/uiauto-uiautomationoverview`
- **Within** — *Companion*: "built to map work, not track workers", "user-controlled, anonymized and reviewed"; sin detalle técnico público. `within.ai/platform/company-brain` y `REFERENTES-Within.md`
- **Ley 1581 de 2012 (Colombia)** — autorización previa, expresa e informada; principio de finalidad. `funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981`
