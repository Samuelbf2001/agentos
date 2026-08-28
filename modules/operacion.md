---
schema_version: 1
slug: operacion
version: 1
name: Operación continua (Ops)
phase: OPERAR
project_type: ops
project:
  name_tpl: "Operación {{cliente}}"
  workspace_tpl: "workspaces/operacion-{{cliente}}"
methodology:
  slug: ops
  version: null
budget:
  phase_usd: 20
  per_run_usd: 2
  warning_thresholds_pct: [70, 90, 100]
roster:
  - role: orquestador
    agent: alex
    layer: consultoria
    max_usd_per_run: 2
  - role: operadora
    agent: sally
    layer: operacion
    max_usd_per_run: 1
  - role: datos
    agent: clara
    layer: operacion
    max_usd_per_run: 1
  - role: qa
    agent: quinn
    layer: meta
    max_usd_per_run: 1
    always: true
inputs:
  - key: cliente
    label: Cliente
    type: text
    required: true
  - key: proyecto_origen
    label: Proyecto de implementación origen (nombre)
    type: text
  - key: objetivo
    label: Objetivo de la operación (qué se promete mes a mes)
    type: textarea
    required: true
    max_len: 600
  - key: presupuesto_fase
    label: Presupuesto mensual de operación (USD)
    type: number
    min: 1
  - key: fuentes
    label: Hilos y fuentes a asociar
    type: source_refs
templates:
  - key: kickoff_ops
    title: "Kickoff de operación con {{cliente}}"
    description: "Arranque de la fase OPERAR: handoff recibido, cadencias acordadas y objetivo declarado: {{objetivo}}"
    dod: "Acta de kickoff en el Context Hub con cadencias, responsables por pilar y SLAs aceptados por el cliente."
    stage: OPERAR
    activity_type: kickoff
    priority: high
    assign: { role: orquestador }
    due_offset_days: 2
  - key: marketing_ops
    title: "Marketing Ops: campañas y automatizaciones para {{cliente}}"
    description: "Actividad del pilar Marketing: campañas, segmentaciones, plantillas y automatizaciones de marketing."
    dod: "Actividad ejecutada con evidencia adjunta (configuración o pieza publicada en borrador) y resultado registrado en el Context Hub."
    stage: OPERAR
    activity_type: marketing_ops
    priority: normal
    assign: { role: operadora }
    due_offset_days: 5
  - key: sales_ops
    title: "Sales Ops: higiene y seguimiento de pipeline de {{cliente}}"
    description: "Actividad del pilar Sales: higiene de CRM, seguimiento de oportunidades, plantillas de venta."
    dod: "Pipeline al día con evidencia del antes/después y pendientes escalados al humano responsable."
    stage: OPERAR
    activity_type: sales_ops
    priority: normal
    assign: { role: operadora }
    due_offset_days: 2
  - key: service_ops
    title: "Service Ops: atención y postventa de {{cliente}}"
    description: "Actividad del pilar Service: flujos de atención, plantillas de respuesta, seguimiento de tickets."
    dod: "Flujo de atención operativo con evidencia y casos abiertos documentados con su estado."
    stage: OPERAR
    activity_type: service_ops
    priority: normal
    assign: { role: operadora }
    due_offset_days: 3
  - key: reporting_ops
    title: "Reporting Ops: métricas y tablero de {{cliente}}"
    description: "Actividad del pilar Reporting: métricas del mes, tablero al día y lecturas accionables."
    dod: "Tablero de operación adjunto como artefacto con métricas verificables y fuentes citadas."
    stage: OPERAR
    activity_type: reporting_ops
    priority: normal
    assign: { role: datos }
    produces: [ops_dashboard]
    due_offset_days: 5
  - key: reporte_semanal
    title: "Reporte semanal de operación (lunes)"
    description: "Resumen semanal para {{cliente}}: qué se movió por pilar, métricas y riesgos."
    dod: "Reporte adjunto como artefacto y enviado al canal acordado; hallazgos registrados en el Context Hub."
    stage: OPERAR
    activity_type: reporting_ops
    priority: normal
    assign: { role: datos }
    cadence: true
    cadence_period_days: 7
    due_offset_days: 7
  - key: sprint_semanal
    title: "Sprint semanal de operación"
    description: "Planificación semanal: priorizar el catálogo de actividades por pilar según el objetivo del mes."
    dod: "Backlog de la semana priorizado en el tablero con responsables y SLAs asignados."
    stage: OPERAR
    activity_type: sprint
    priority: normal
    assign: { role: orquestador }
    cadence: true
    cadence_period_days: 7
    due_offset_days: 7
  - key: checkin_cliente
    title: "Check-in con {{cliente}}"
    description: "Toque de base con el sponsor: avances, bloqueos y ajustes de prioridad."
    dod: "Acta breve del check-in en el Context Hub con acuerdos y próximos pasos."
    stage: OPERAR
    activity_type: checkin
    priority: normal
    assign: { role: orquestador }
    cadence: true
    cadence_period_days: 14
    due_offset_days: 7
closing_deliverables:
  - kind: ops_dashboard
    source: artifact
    min: 1
    produced_by: reporting_ops
---

# Módulo Operación — catálogo por pilar + cadencia (v1)

La promesa Sixteam hecha rutina (fase **OPERAR**, metodología `ops`): no
montamos y nos vamos — operamos mes a mes. Este módulo trae dos cosas:

## 1. Catálogo de actividades por pilar (US-M4)

Plantillas **disparables sin dependencias** — el operador (o el cliente por
chat, fase 2) pide una actividad y se crea la tarea tipada asignada al agente
del pilar:

| Pilar | Plantilla | activity_type | Agente | SLA (due) |
|---|---|---|---|---|
| Marketing | `marketing_ops` | `marketing_ops` | Sally | 5 días (automatización 3-7) |
| Sales | `sales_ops` | `sales_ops` | Sally | 2 días (tarea chica 1-3) |
| Service | `service_ops` | `service_ops` | Sally | 3 días (tarea chica 1-3) |
| Reporting | `reporting_ops` | `reporting_ops` | Clara | 5 días (automatización 3-7) |

Los SLAs son los publicados en la web de Sixteam (CA-M4.2): tareas chicas 1-3
días, automatizaciones 3-7; quedan como `due_at` por defecto vía
`due_offset_days`.

## 2. Cadencia consent-first (CA-M3.4 — M6a)

`reporte_semanal` (7 días), `sprint_semanal` (7 días) y `checkin_cliente`
(14 días; el primero a la semana vía `due_offset_days`) están marcadas con
`cadence: true` + `cadence_period_days`. **El launch solo crea las que el
humano CONFIRMA** en el resumen del wizard (`cadences_confirmed`): la
confirmada nace como primera instancia READY con su due; al cerrarla en DONE,
el tablero re-crea la siguiente (título re-renderizado, asignado re-resuelto
contra el roster actual, due = due anterior + periodo). Guarda-raíl: nunca hay
dos instancias abiertas de la misma plantilla. La no confirmada no nace ni
renace — consent-first de punta a punta.

## Cierre y presupuesto

Operación es continua: no hay gate de cierre de fase en v1; el entregable
vivo es el tablero de operación (`ops_dashboard`, producido por Reporting).
Presupuesto $20/mes por defecto ($2 por run), editable vía `presupuesto_fase`;
semáforos al 70/90/100%. Quinn audita siempre.
