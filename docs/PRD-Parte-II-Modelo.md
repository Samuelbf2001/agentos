# Parte II — El modelo: el segundo cerebro de la empresa

> Secciones 5 a 8 del PRD. Recoge las definiciones de Ernesto del 2026-09-05.
> Estado: borrador para corrección. Los supuestos que tomé están marcados al final.

## 5.1 El 2brain tiene dos capas, no una

Esta es la decisión que ordena todo lo demás. El segundo cerebro no es un grafo de entidades con un
buscador encima. Son **dos capas que se necesitan**:

**Una narrativa central que explica la empresa.** Un documento vivo que responde tres preguntas en este
orden: qué hace la empresa, por qué lo hace, y cómo lo hace. Se lee de corrido, como se lo explicarías
a alguien que acaba de entrar.

**Una capa de entidades estructuradas.** Roles, personas, procesos, funciones, áreas y sistemas, cada
uno con sus atributos y sus relaciones.

Las dos se unen en un punto concreto: **dentro del "cómo lo hace", los procesos se nombran, y cada
nombre es una puerta.** Se puede leer el texto de corrido sin salir de él, o entrar en cualquier
proceso mencionado y ver su detalle completo, sus pasos, quién responde de cada uno y qué herramientas
usa. Al volver, sigues donde estabas.

Eso resuelve el problema que tienen por separado las wikis y los diagramas. La wiki explica pero no
estructura. El diagrama estructura pero no explica. Aquí el texto es la puerta de entrada y las
entidades son el detalle, y ninguna de las dos es un resumen de la otra.

## 5.2 El eje central

Un documento por empresa cliente, con tres partes.

**Qué hace.** A qué se dedica, qué vende, a quién. Es lo primero que cualquiera necesita, humano o
agente.

**Por qué lo hace.** Su propósito, su posición, qué la distingue. Es lo que evita que un agente proponga
mejoras que van contra el negocio.

**Cómo lo hace.** La parte más larga y la que se enlaza con todo. Describe la operación por áreas y, al
recorrerla, va nombrando procesos. Un nombre mencionado puede estar solo nombrado, y entonces existe
como proceso pendiente de mapear, o estar mapeado, y entonces se entra a su detalle.

Esa distinción es útil por sí sola: **lo que se nombra pero no se ha mapeado es exactamente la lista de
lo que falta por entrevistar.**

Las áreas tienen su propia narrativa anidada, con la misma estructura, cuando la empresa es lo bastante
grande para justificarlo.

## 5.3 El rol es el centro del grafo

Todo lo demás cuelga del rol. No de la persona, porque las personas rotan y los procesos no.

Un rol se conecta en cuatro direcciones:

**Hacia los procesos, que es la principal.** Un rol participa en procesos concretos y, dentro de cada
uno, responde de pasos concretos. Esta es la relación que más importa y la que el flujograma hace
visible.

**Hacia el organigrama.** El rol pertenece a un área y reporta a otro rol. Es la vista jerárquica, útil
para entender la estructura, pero secundaria frente a la anterior.

**Hacia las personas.** Un rol lo ocupan una, varias o ninguna persona. Un rol sin persona es una
vacante y es un hallazgo por sí mismo. Una persona con varios roles también.

**Hacia las funciones.** Lo que ese rol hace o debería hacer, que es donde vive la brecha entre ambas
cosas.

## 5.4 Las entidades

**La empresa.** Además del eje narrativo, lleva atributos que cambian cómo se la trata: rubro, tamaño,
áreas, principales problemas. El rubro y el tamaño no son adorno: determinan qué guías de entrevista se
usan y qué procesos de referencia se comparan. Los principales problemas son lo que el sponsor dice que
le duele, y sirven para contrastar contra lo que el mapeo encuentra de verdad.

**Área.** Entidad propia, con jerarquía y con su propia narrativa.

**Rol, persona, función.** Como en el apartado anterior.

**Proceso.** Con sus pasos, y en cada paso quién responde, qué entra, qué sale y qué sistema se usa. Es
lo que se dibuja como flujograma.

**Sistema o plataforma.** Lo que la empresa ya usa, con qué hace cada uno y a qué proceso sirve.

**Relaciones hacia fuera.** El grafo no termina en los límites de la empresa. Un proceso puede depender
de un proveedor, un área puede atender a un tipo de cliente, un sistema puede conectarse con la
plataforma de un tercero. Esas relaciones externas son entidades de pleno derecho, porque muchas de las
fugas viven justo ahí, en el borde.

## 5.5 La memoria interna del engagement

Aquí hay una decisión fuerte de Ernesto que conviene dejar clarísima.

Existe una **memoria del trabajo interno de Sixteam con ese cliente**: lo que se ha visto, lo que se ha
intentado, lo que el sponsor dijo en privado, dónde están las resistencias reales, qué funcionó y qué
no. Esa memoria se relaciona con todas las entidades del grafo, pero:

**Vive aparte y el cliente no la ve. Nunca.**

Y a la vez **manda sobre la información de la empresa**. Cuando lo que el cliente documentó y lo que
Sixteam observó no coinciden, la memoria interna es la que dice qué está pasando de verdad.

Esto tiene tres consecuencias de diseño que no son negociables:

La memoria interna se ancla a entidades del grafo, pero se guarda en un espacio separado con su propio
control de acceso. No es un campo dentro del proceso, es un objeto que apunta al proceso.

Ningún contenido publicado al cliente puede derivarse de la memoria interna sin que un humano lo
reescriba. Un agente que redacta un hallazgo para el cliente no puede citar la memoria interna como
fuente.

Cuando un agente responda una pregunta, debe saber cuál de las dos capas está usando. Si el cliente
pregunta, la memoria interna no entra. Si pregunta Sixteam, entra y pesa más.

## 5.6 Lo que ve cada tipo de usuario

Tres tipos, como definiste.

| Tipo | Quién es | Qué ve |
|---|---|---|
| **Sixteam** | El equipo de la agencia | Todo: el grafo, la narrativa, la memoria interna, el trabajo de todos los clientes |
| **Empresa** | El cliente | Su propia narrativa y su propio grafo, en lo que esté publicado. Nunca la memoria interna, nunca otros clientes |
| **Visualizador** | Alguien con acceso puntual a datos | Solo lo que se le comparte de forma explícita |

El tercero tiene una particularidad importante: **si su usuario está vinculado a un proceso de
entrevista, además de ver, responde**. Es decir, el mismo tipo de acceso sirve para enseñarle a alguien
una parte del mapa y para que esa persona conteste su entrevista, sin necesidad de darle una cuenta
completa de la empresa.

Eso encaja con el mecanismo de cápsula que ya habíamos definido: un enlace firmado, para un objeto y un
propósito, con caducidad. El visualizador es ese mecanismo con nombre de usuario.

## 6. El 2brain del proyecto

El de la empresa describe cómo funciona el cliente. El del proyecto guarda cómo lo estamos cambiando:
el plan, las palancas, las decisiones de arquitectura, los sprints y los aprendizajes.

La diferencia práctica: **el de la empresa sobrevive al proyecto**. Cuando el engagement termina, el
segundo cerebro de la empresa sigue vivo y sigue siendo útil. El del proyecto se cierra.

Se enlazan por referencias explícitas: cada palanca del plan dice qué brechas ataca, y cada implantación
dice qué proceso y qué sistema toca.

## 7. Publicación

Sin cambios respecto a lo ya decidido. El cliente lee fotografías, no el grafo vivo. Publicar es un acto
explícito. La memoria interna nunca se publica.

## 8. Catálogos del activo Sixteam

Lo que preguntaste. Son las piezas que **no pertenecen a ningún cliente y sirven para todos**:

Las guías de qué preguntar en una entrevista, por rol, área y rubro. Las metodologías. Los procesos de
referencia contra los que se compara lo que hace un cliente para detectar lo que le falta. Las
plantillas de implementación. Y el conocimiento acumulado de cada herramienta, que crece cada vez que se
trabaja con ella.

Viven en el tenant de agencia, se versionan, y nunca se publican a un cliente porque son el método. Su
valor es acumulativo: cada engagement los mejora y el siguiente cliente empieza más arriba.

---

## Supuestos que tomé y conviene que confirmes

**El eje narrativo es uno por empresa**, con narrativas anidadas por área cuando hace falta. La
alternativa sería un documento por área desde el principio, que me parece prematuro.

**El cliente valida y comenta, pero no edita libremente** su grafo. Puede marcar que algo está mal y
proponer la corrección; quien edita es Sixteam. Si prefieres que el cliente edite directamente, cambia
el diseño de la regla anti-pisado.

**Un proceso solo nombrado en la narrativa existe como entidad pendiente**, no como texto suelto. Así la
lista de lo que falta mapear se genera sola.

**La memoria interna se organiza por cliente**, con secciones por proyecto, no al revés. Porque lo
aprendido de un cliente sirve para el siguiente proyecto con ese mismo cliente.

**El visualizador no ve la narrativa completa**, solo el objeto que se le comparte. Si debe ver el eje
central completo, dímelo, porque cambia bastante el diseño de permisos.
