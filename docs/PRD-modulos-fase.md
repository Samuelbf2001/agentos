# PRD — Módulos de Fase (Consultoría → Implementación → Operación)

> Extensión del `PRD.md` canónico. Spec (qué/porqué); las decisiones de implementación irán en una adenda de `ARCHITECTURE.md` al construir. Fecha: 2026-08-28. Estado: aprobado para construcción tras aterrizar las ramas de fase 2 en vuelo.

## 1. Visión y porqué

Hoy arrancar un engagement en AgentOS requiere que el backlog nazca del seed (hardcodeado) o de que Alex lo improvise bien. Eso no escala a "llegar a una empresa nueva y disparar la operación".

**Un Módulo de Fase empaqueta todo lo necesario para ejecutar una fase del ciclo Entender → Construir → Operar sobre un proyecto nuevo**: metodología, plantilla de backlog, agentes participantes, gates, entregables de cierre, inputs requeridos y presupuesto. Se **configura una vez** (y se versiona), y se **dispara** por proyecto: elegir cliente + módulo → llenar el formulario de arranque → validación → el sistema crea el proyecto completo y los agentes empiezan a trabajar.

Esto convierte la plataforma en el producto que vende Sixteam: el mismo módulo de Consultoría que se dispara para ACME se dispara mañana para el siguiente cliente, con la metodología ya codificada y mejorada por cada engagement (principio #8: el activo es el contexto y la metodología).

**Criterio de éxito (una frase):** Ernesto abre "Nuevo proyecto", elige el módulo Consultoría, llena 8-10 campos sobre el cliente, pulsa **Disparar**, y en ≤60 s existe el proyecto con su backlog completo, metodología activa, gates armados, presupuesto fijado y el kickoff de Alex encolado — sin tocar el tablero a mano.

## 2. Concepto: qué contiene un módulo

| Pieza | Qué define | Ejemplo (Consultoría) |
|---|---|---|
| Identidad | slug, nombre, fase (`ENTENDER`\|`CONSTRUIR`\|`OPERAR`), versión, changelog | `consultoria` v1 |
| Metodología | slug+versión de `methodologies` que rige la fase | `assessment-14d` (+ `iso9001-prep` si toggle) |
| Blueprint de backlog | Lista de plantillas de tarea: título (con variables `{{cliente}}`), DoD, activity_type, prioridad, asignación **por rol/capa** (no por id), dependencias entre plantillas, flags de gate | Kickoff → entrevistas (una por área elegida) → mapas as-is → fugas → (matriz ISO) → informe → roadmap |
| Agentes | Qué agentes del roster participan y con qué límites de presupuesto en esta fase | Alex, Sam (+Clara); Quinn siempre |
| Gates | Qué aprueba el humano y cuándo (gate de fase + entregables sensibles) | G1 al cerrar ENTENDER; informe y roadmap con aprobación |
| Entregables de cierre | Tipos de `knowledge_docs`/`artifacts` que deben existir para cerrar la fase | org_profile, ≥N process_map, leak_analysis, report, roadmap (+iso_gap) |
| Inputs de arranque | Formulario tipado: campos requeridos/opcionales con validación | Ver §4 módulo Consultoría |
| Opciones (toggles) | Variantes del módulo que alteran el blueprint | "Incluir preparación ISO 9001", nº de áreas a entrevistar |
| Presupuesto | Tope USD de la fase, tope por run, semáforos | $15 fase / $2 run (defaults editables) |
| Fuentes | Qué fuentes de contexto se asocian al disparar (enlaza con "Fuentes del proyecto": reuniones, WhatsApp) | hilo del sponsor, reuniones del cliente |

Los módulos viven como **datos versionados** (mismo patrón que `agents/*.md` y `methodologies/*.md`: archivo en git → carga a DB → edición en caliente por MCP → seed_hash). Un disparo (`launch`) queda registrado: quién, cuándo, con qué inputs y qué produjo — es un recibo inmutable.

## 3. User stories

**US-M1 — Configurar un módulo.**
*Como administrador quiero editar qué contiene cada módulo sin tocar código.*
- CA-M1.1 Los 3 módulos (consultoría, implementación, operación) existen como semilla y son visibles en la UI y por MCP.
- CA-M1.2 Editar el blueprint (añadir/quitar plantillas de tarea, cambiar DoD, gates, presupuesto) crea **versión nueva** con changelog; rollback disponible; nada se sobrescribe.
- CA-M1.3 Un módulo con blueprint inválido (dependencia circular, asignación a capa inexistente, entregable de cierre sin plantilla que lo produzca) **no puede activarse**: la validación lo rechaza con error específico.
- CA-M1.4 Todo editable por MCP (`agentos.modules.*`) con `expected_version` y auditoría.

**US-M2 — Disparar Consultoría para un cliente nuevo.**
*Como operador quiero lanzar un assessment completo llenando un formulario.*
- CA-M2.1 El wizard "Nuevo proyecto" pide: módulo → inputs → resumen → Disparar. Con inputs incompletos, el botón Disparar está deshabilitado y se listan los campos faltantes.
- CA-M2.2 Al disparar: se crea la organización (si no existe), el proyecto (type/stage del módulo), el backlog completo desde el blueprint con variables sustituidas (`{{cliente}}`, `{{sponsor}}`, áreas elegidas → una entrevista por área), asignaciones resueltas por capa/rol al roster activo, dependencias, gates armados, presupuesto de fase fijado y metodología activa — todo en ≤60 s y en **una transacción** (o se revierte completo: cero proyectos a medias).
- CA-M2.3 La tarea de kickoff queda READY asignada a Alex y el resto respetando dependencias (las entrevistas no salen de BACKLOG hasta que el kickoff esté DONE, etc., según blueprint).
- CA-M2.4 El launch queda registrado (módulo+versión, inputs, actor, timestamp) y visible en el proyecto ("Disparado desde Consultoría v1 por Ernesto").
- CA-M2.5 Con el toggle ISO 9001 activo, el backlog incluye las tareas de matriz de brechas y el entregable de cierre `iso_gap`; sin el toggle, no.
- CA-M2.6 Disparar dos veces con los mismos inputs e idempotency_key no duplica el proyecto.

**US-M3 — Cerrar una fase y disparar la siguiente.**
*Como operador quiero encadenar Consultoría → Implementación → Operación sin perder contexto.*
- CA-M3.1 La UI muestra el **estado de cierre de fase**: qué entregables de cierre existen y cuáles faltan; el gate de fase no puede aprobarse si faltan.
- CA-M3.2 Con la fase cerrada (gate aprobado + entregables completos), aparece "Disparar Implementación": pre-llena sus inputs desde el Context Hub (el roadmap aprobado alimenta el blueprint — cada palanca priorizada genera un grupo de tareas de CONSTRUIR).
- CA-M3.3 El proyecto conserva TODO el contexto entre fases (mismo Context Hub, procesos, decisiones); solo cambia stage y backlog activo.
- CA-M3.4 Disparar Operación configura la **cadencia**: tareas recurrentes según el módulo (reporte de lunes 9am, sprint semanal, check-in) creadas de forma **consent-first** — el módulo las propone en el resumen del wizard y el humano confirma cuáles activar.

**US-M4 — Módulo de Operación con catálogo.**
- CA-M4.1 El módulo Operación incluye el catálogo de actividades por pilar (Marketing/Sales/Service/Reporting Ops) como `activity_types` disparables: el operador (o el cliente por chat, fase 2) pide una actividad y se crea la tarea tipada asignada al agente del pilar.
- CA-M4.2 SLAs del módulo (tareas chicas 1-3 días, automatizaciones 3-7 — los de la web) quedan como `due_at` por defecto según activity_type.

## 4. Inputs de arranque del módulo Consultoría (v1)

Requeridos: nombre de la empresa, industria, tamaño (empleados), sponsor (nombre y rol), objetivo del engagement (texto corto), áreas a entrevistar (multi-select: dirección, operaciones/producción, ventas, atención, administración — mín 2), fecha objetivo de entrega.
Opcionales: toggle "preparación ISO 9001", presupuesto de fase (default $15), sistemas conocidos (texto), hilo/fuentes a asociar (cuando exista "Fuentes del proyecto"), notas del comercial (pega del CRM/llamada de Sofia).

## 5. NFRs

| # | Requisito | Verificación |
|---|---|---|
| NM-1 | Disparo atómico: proyecto completo o nada | Test: fallo inyectado a mitad de launch → cero filas huérfanas |
| NM-2 | Disparo ≤60 s con blueprint de ≤40 tareas | Test local con timestamps |
| NM-3 | Módulos versionados: un launch referencia módulo+versión inmutables | Editar el módulo después NO altera proyectos ya disparados |
| NM-4 | Validación fail-closed del blueprint | Módulo inválido no activable; launch con módulo inactivo rechazado |
| NM-5 | Sin nuevos privilegios: launch usa los mismos servicios de dominio y auditoría | El launch aparece en audit_log con inputs (redactados si sensibles) |

## 6. Fuera de alcance

- Marketplace/compartición de módulos entre organizaciones (el empaquetado TEAM.md de Paperclip queda para fase 3).
- Editor visual de blueprints (se editan como markdown/JSON estructurado + MCP; la UI muestra y valida).
- Disparo autónomo de fases por agentes: **disparar es siempre humano** (Alex puede sugerirlo, nunca ejecutarlo).
- Overrides de módulo por cliente (v2): en v1 los inputs parametrizan; no hay fork del módulo por cliente.
- Facturación/cotización ligada al módulo.

## 7. Secuencia de construcción propuesta

1. Persistencia + validación (`phase_modules`, `module_launches`, semillas de los 3 módulos; migración tras aterrizar las ramas de fase 2 en vuelo para no chocar esquema).
2. Motor de launch (transaccional, sustitución de variables, resolución por capa, dependencias, idempotencia) + tests NM-1..NM-4.
3. MCP `agentos.modules.*` + wizard UI "Nuevo proyecto" + estado de cierre de fase.
4. Migrar el seed demo ACME a "launch del módulo Consultoría v1" (deja de estar hardcodeado — el seed solo dispara el módulo).
5. Encadenado de fases (US-M3) y cadencia consent-first de Operación (US-M4).
