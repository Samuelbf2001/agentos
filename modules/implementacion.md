---
schema_version: 1
slug: implementacion
version: 1
name: Implementación (Transform)
phase: CONSTRUIR
project_type: transform
project:
  name_tpl: "Implementación {{cliente}}"
  workspace_tpl: "workspaces/implementacion-{{cliente}}"
methodology:
  slug: transform
  version: null
budget:
  phase_usd: 30
  per_run_usd: 2
  warning_thresholds_pct: [70, 90, 100]
roster:
  - role: orquestador
    agent: alex
    layer: consultoria
    max_usd_per_run: 2
  - role: constructora
    agent: debbie
    layer: implementacion
    max_usd_per_run: 2
  - role: integraciones
    agent: vinnie
    layer: implementacion
    max_usd_per_run: 2
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
    label: Proyecto de assessment origen (nombre)
    type: text
    required: true
  - key: palancas
    label: Palancas priorizadas del roadmap aprobado
    type: list_text
    required: true
    min_items: 1
    max_items: 8
  - key: fecha_objetivo
    label: Fecha objetivo de entrega
    type: date
    required: true
  - key: presupuesto_fase
    label: Presupuesto de fase (USD)
    type: number
    min: 1
  - key: fuentes
    label: Hilos y fuentes a asociar
    type: source_refs
templates:
  - key: kickoff_fase
    title: "Kickoff de fase CONSTRUIR con {{cliente}}"
    description: "Arranque de implementación sobre el roadmap aprobado en el Gate 1 del proyecto {{proyecto_origen}}. Palancas priorizadas: {{palancas}}"
    dod: "Acta de kickoff en el Context Hub con alcance por palanca, responsables y calendario; el roadmap origen citado por doc id."
    stage: CONSTRUIR
    activity_type: kickoff
    priority: high
    assign: { role: orquestador }
    due_offset_days: 2
  - key: diseno_palanca
    title: "Diseño de solución: {{palanca}}"
    description: "Diseño to-be de la palanca {{palanca}} para {{cliente}}: alcance, sistemas implicados, criterios de aceptación."
    dod: "Documento de diseño en el Context Hub con proceso to-be, sistemas y criterios de aceptación medibles, citando el diagnóstico origen."
    stage: CONSTRUIR
    activity_type: design
    priority: high
    assign: { role: constructora }
    depends_on: [kickoff_fase]
    fan_out: { over: palancas, as: palanca }
    due_offset_days: 5
  - key: construccion_palanca
    title: "Construcción: {{palanca}}"
    description: "Construir y configurar la solución de la palanca {{palanca}} según su diseño aprobado."
    dod: "Sistema configurado y funcionando en el entorno del cliente; evidencia adjunta como artefacto y criterios de aceptación del diseño verificados."
    stage: CONSTRUIR
    activity_type: build
    priority: high
    assign: { role: constructora }
    depends_on: [diseno_palanca]
    fan_out: { over: palancas, as: palanca }
    due_offset_days: 10
  - key: integracion
    title: "Integraciones y conexiones entre sistemas"
    description: "Conectar los sistemas construidos entre sí y con los existentes de {{cliente}} (datos, webhooks, automatizaciones)."
    dod: "Integraciones probadas extremo a extremo con evidencia de payloads reales; errores y reintentos documentados."
    stage: CONSTRUIR
    activity_type: integration
    priority: normal
    assign: { role: integraciones }
    depends_on: [construccion_palanca]
    due_offset_days: 12
  - key: pruebas_uat
    title: "Pruebas y UAT con {{cliente}}"
    description: "Plan de pruebas + UAT con usuarios reales del cliente sobre todas las palancas construidas."
    dod: "Informe de implementación adjunto como artefacto: resultados de pruebas, hallazgos de UAT y estado por palanca; pasa a REVIEW humano."
    stage: CONSTRUIR
    activity_type: uat
    priority: urgent
    assign: { role: constructora }
    depends_on: [construccion_palanca, integracion]
    produces: [report]
    gate: uat_ok
    due_from_input: fecha_objetivo
    due_offset_days: -3
  - key: despliegue_handoff
    title: "Despliegue y handoff a operación"
    description: "Despliegue final y handoff: roadmap de operación para {{cliente}} (cadencias, responsables, SLAs) que arma la fase OPERAR."
    dod: "Roadmap de operación adjunto como artefacto y aceptado; su aprobación habilita el Gate 2 y cierra CONSTRUIR."
    stage: CONSTRUIR
    activity_type: deploy
    priority: urgent
    assign: { role: constructora }
    depends_on: [pruebas_uat]
    produces: [roadmap]
    gate: g2_cierre
    due_from_input: fecha_objetivo
gates:
  - name: uat_ok
    when: deliverable
    fed_by: [pruebas_uat]
  - name: g2_cierre
    when: phase_close
    fed_by: [despliegue_handoff]
    blocks_next_stage: OPERAR
closing_deliverables:
  - kind: report
    source: artifact
    min: 1
    produced_by: pruebas_uat
  - kind: roadmap
    source: artifact
    min: 1
    produced_by: despliegue_handoff
---

# Módulo Implementación — Transform (v1)

Convierte el roadmap aprobado en el Gate 1 en sistemas funcionando (fase
**CONSTRUIR**, metodología `transform`). Se dispara normalmente encadenado
desde Consultoría (US-M3): `palancas` se pre-llena con las palancas priorizadas
del roadmap del Context Hub.

## Estructura del backlog

- **Kickoff de fase** (Alex) → nace READY.
- **Diseño de solución** — una tarea por palanca (`diseno_palanca:<palanca>`).
- **Construcción** — una tarea por palanca, tras el diseño.
- **Integraciones** (Vinnie) — tras la construcción.
- **Pruebas + UAT** (gate `uat_ok`) → produce el **informe de implementación**.
- **Despliegue + handoff** (gate `g2_cierre`, cierra CONSTRUIR) → produce el
  **roadmap de operación** que alimenta el módulo Operación.

## Nota sobre dependencias entre fan-outs

El modelo de dependencias v1 resuelve una dependencia hacia una plantilla
fan-out como dependencia hacia **TODAS sus instancias**: cada
`construccion_palanca:<palanca>` espera a que terminen **todos** los diseños,
no solo el de su propia palanca. Es deliberadamente conservador (el diseño de
una palanca suele condicionar a las demás); el emparejamiento instancia a
instancia queda para una versión futura del formato si la práctica lo pide.

## Presupuesto

$30 por fase / $2 por run (editable vía `presupuesto_fase`); semáforos al
70/90/100%. Quinn participa siempre: `build`, `integration`, `deploy` y los
entregables de fase pasan por REVIEW humano por política determinista.
