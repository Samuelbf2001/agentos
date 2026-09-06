# Estructura del PRD — mapa de trabajo

> El PRD completo son 22 secciones en 6 partes. Hoy viven repartidas en siete documentos. Este es el
> índice maestro: qué cubre cada parte, dónde vive, en qué estado está y en qué orden la trabajamos.
> Estado a 2026-09-05.

## Cómo leemos el estado

**Cerrado.** Decidido y escrito. Se puede construir contra eso.
**Abierto.** Escrito, pero con decisiones pendientes marcadas.
**Esbozado.** Sabemos para qué existe y qué problema resuelve. Falta el detalle.
**Vacío.** Solo el título. No lo hemos trabajado.

---

## Parte I — Fundamentos

Qué es esto, para quién y bajo qué reglas. Es lo que no se renegocia cada semana.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 1 | Visión y criterio de éxito | Cerrado | PRD §1 | — |
| 2 | Constitución y qué cambia de v1 | Cerrado | PRD §0 | — |
| 3 | Modelo de tenancy: agencia y clientes | Cerrado | Tenancy v1.4 | — |
| 4 | Usuarios, roles y permisos | Abierto | PRD §2 y Tenancy | Los permisos concretos por rol dentro de cada tenant |

## Parte II — El modelo

Las entidades. Es el cimiento del que dependen todos los módulos, y por eso va antes que ellos.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 5 | El 2brain de la empresa: el grafo | Abierto | PRD §3.1 | Los atributos de cada entidad, uno por uno |
| 6 | El 2brain del proyecto | Esbozado | PRD §3.2 | Cómo se relaciona con el de la empresa en la práctica |
| 7 | Publicación y visibilidad al cliente | Cerrado | Tenancy v1.4 | — |
| 8 | Catálogos del activo Sixteam | Esbozado | PRD §3.4 | Qué contiene cada catálogo y quién lo mantiene |

## Parte III — Los módulos

El recorrido del cliente. Cada uno se desarrolla completo antes de pasar al siguiente.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 9 | Assessment | Abierto | PRD §4.1 y Parte III | Confirmar tres decisiones de la Parte III. Versión 2 decidida: descubrimiento automático observando el trabajo (sección 9.10) |
| 10 | Arquitectura y plan | Esbozado | PRD §4.1 y §7 | El criterio de decisión entre construir y comprar, y cómo nace el plan |
| 11 | Implementación | Esbozado | PRD §4.2 | La metodología de ejecución y qué hacen los expertos |
| 12 | Soporte | Esbozado | PRD §4.3 | El alcance real del agente de soporte y el ciclo de vigilancia |

## Parte IV — Los agentes

Cómo se construyen y qué hace cada uno. Aquí es donde más falta, y es deliberado: se llena módulo por
módulo, no de golpe.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 13 | Estructura de agentes | Cerrado | PRD §6 | — |
| 13.5 | Convertir un rol, función o proceso en agente | Abierto | Parte IV, Convertir en agente | Confirmar los tres supuestos del documento. Es la costura mapa → ejecución que ningún referente hace |
| 14 | Fichas de cada agente | Vacío en su mayoría | Mapa de agentes | Once fichas por llenar. Es el trabajo de las próximas sesiones |
| 15 | Gates y humano en el circuito | Abierto | PRD §8 | Qué valida exactamente cada gate al aprobarse |

## Parte V — La experiencia

Cómo se ve y cómo se siente. Se puede avanzar en paralelo a todo lo demás porque casi no depende del
modelo de datos.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 16 | Arquitectura de información | Cerrado | Plan v1.5 | — |
| 17 | Sistema visual y movimiento | Cerrado | Dirección visual | Solo la decisión de tipografía de marca |
| 18 | Pantallas principales | Abierto | Plan v1.5 y prototipo | Faltan las pantallas de procesos, entrevistas y contexto |

## Parte VI — Ejecución

Qué existe, qué se exige y en qué orden se construye.

| # | Sección | Estado | Dónde vive | Qué falta |
|---|---|---|---|---|
| 19 | Estado real frente al PRD | Cerrado | Estado vs PRD | Se revisa cuando cambie el código |
| 20 | Requisitos no funcionales | Abierto | PRD §10 | Los de experiencia y los de costeo |
| 21 | Secuencia de construcción | Abierto | PRD §14 | Reordenar con lo aprendido de tenancy y experiencia |
| 22 | Riesgos y supuestos abiertos | Abierto | PRD §12 y §13 | Cerrar los seis supuestos que siguen sin confirmar |

---

## Los siete documentos de hoy

| Documento | Qué contiene | Partes que cubre |
|---|---|---|
| `PRD-v1.1-sistema-completo.md` | El PRD principal, 19 historias de usuario | I, II, III, IV, VI |
| `MODELO-TENANCY-v1.4.md` | Agencia y clientes, publicación, WhatsApp | I, II |
| `PLAN-v1.5-EXPERIENCIA.md` | Diagnóstico y arquitectura de información | V |
| `DIRECCION-VISUAL.md` | Sistema visual y reglas de movimiento | V |
| `REFERENTES-Puzzle-Wonderful.md` | Qué tomamos de cada referente | III, IV |
| `MAPA-DE-AGENTES.md` | Ficha estándar y estado de cada agente | IV |
| `ESTADO-vs-PRD-v1.1.md` | Qué existe hoy en el código | VI |
| `REFERENTES-Within.md` | Within (ex-Klarity): el referente más parecido; variante de proceso, MCP hacia fuera, velocidad | III, IV, discurso comercial |
| `PLAN-DESCUBRIMIENTO-AUTOMATICO-v2.md` | Bitácora: descubrimiento de procesos por observación (assessment v2), señales, anonimización, pipeline, fases B14a/b/c | III (§9.10), VI |

Cuando una parte se cierre, su contenido se consolida en el PRD principal y el documento auxiliar queda
como anexo con el razonamiento. No al revés: el PRD no debe convertirse en un índice de enlaces.

---

## El orden en que las vamos a trabajar

No es el orden de lectura del documento. Es el orden en que se toman las decisiones, y sigue una regla
simple: **nada se decide antes que aquello de lo que depende.**

**Primero, cerrar el modelo.** Las secciones 5 y 6, el grafo de la empresa y el del proyecto. Todos los
módulos escriben sobre esas entidades, así que definirlas mal cuesta el doble después. Aquí se decide
qué atributos tiene un rol, qué es exactamente una función, cómo se relaciona un paso de proceso con
quien responde de él, y cómo se representa una brecha.

**Segundo, el módulo de Assessment completo.** Sección 9, con sus agentes. Es lo que Sixteam vende
primero, lo que produce el 2brain y lo que alimenta todo lo demás. Incluye llenar las fichas de Sam, del
entrevistador y del costeo.

**Tercero, arquitectura y plan.** Sección 10. Convierte el mapa en decisiones y en trabajo.

**Cuarto, Implementación.** Sección 11, con la ficha del agente de proyecto y la metodología de
ejecución.

**Quinto, Soporte.** Sección 12, con el agente de soporte, el de empleados y el ciclo de vigilancia.

**En paralelo desde ya, la experiencia.** Sección 18. Las pantallas que faltan no dependen de que el
modelo esté cerrado, y el prototipo ya demostró que se puede avanzar.

**Al final, ejecución.** Secciones 20, 21 y 22, que solo se pueden cerrar cuando lo anterior esté
decidido.

## Cómo trabajamos cada parte

El mismo formato en todas, para que las sesiones sean predecibles:

1. Te muestro qué hay hoy de esa parte y qué decisiones están abiertas.
2. Te hago las preguntas que solo tú puedes responder, con un valor por defecto para cada una.
3. Escribo la parte completa y la publico.
4. La corriges y la cerramos.

Empezamos por la parte II, el modelo, salvo que prefieras otro punto de entrada.
