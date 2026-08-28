---
schema_version: 1
slug: consultoria
version: 1
name: Consultoría (Assessment 14 días)
phase: ENTENDER
project_type: assessment
project:
  name_tpl: "Assessment {{cliente}}"
  workspace_tpl: "workspaces/assessment-{{cliente}}"
methodology:
  slug: assessment-14d
  version: null
budget:
  phase_usd: 15
  per_run_usd: 2
  warning_thresholds_pct: [70, 90, 100]
roster:
  - role: orquestador
    agent: alex
    layer: consultoria
    max_usd_per_run: 2
  - role: diagnostico
    agent: sam
    layer: consultoria
    max_usd_per_run: 2
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
  - key: empresa
    label: Nombre de la empresa
    type: text
    required: true
  - key: alias
    label: Nombre corto del cliente (para títulos)
    type: text
    default_from: empresa
  - key: industria
    label: Industria
    type: text
    required: true
  - key: empleados
    label: Tamaño (número de empleados)
    type: number
    required: true
    min: 1
  - key: sponsor
    label: Sponsor (nombre y rol)
    type: text
    required: true
  - key: objetivo
    label: Objetivo del engagement
    type: textarea
    required: true
    max_len: 600
  - key: areas
    label: Áreas a entrevistar
    type: multi_select
    required: true
    min_items: 2
    options: [direccion, operaciones, ventas, atencion, administracion]
  - key: procesos_core
    label: Procesos core a mapear as-is
    type: list_text
    min_items: 1
    default_from: areas
  - key: fecha_objetivo
    label: Fecha objetivo de entrega
    type: date
    required: true
  - key: presupuesto_fase
    label: Presupuesto de fase (USD)
    type: number
    min: 1
  - key: sistemas_conocidos
    label: Sistemas conocidos
    type: textarea
  - key: fuentes
    label: Hilos y fuentes a asociar
    type: source_refs
  - key: notas_comercial
    label: Notas del comercial (CRM / llamada)
    type: textarea
    sensitive: true
toggles:
  - key: iso9001
    label: Incluir preparación ISO 9001
    default: false
    enables_templates: [matriz_iso]
    enables_deliverables: [iso_clause]
    methodology_add: iso9001-prep
templates:
  - key: kickoff
    title: "Kickoff con sponsor de {{cliente}}"
    description: "Reunión inicial con {{sponsor}}: alcance del assessment, expectativas, accesos y calendario. Objetivo declarado: {{objetivo}}"
    dod: "Agenda enviada, asistentes confirmados y acta de kickoff registrada en el Context Hub como nota tipada con fecha y participantes."
    stage: ENTENDER
    activity_type: kickoff
    priority: high
    assign: { role: orquestador }
    due_offset_days: 2
  - key: perfil_org
    title: "Perfil de organización {{cliente}}"
    description: "Levantar el org_profile: estructura, roles, productos y contexto de {{industria}} ({{empleados}} empleados)."
    dod: "Documento `org_profile` en el Context Hub con industria, tamaño, estructura y sistemas declarados, citando su fuente."
    stage: ENTENDER
    activity_type: org_profile
    priority: high
    assign: { role: diagnostico }
    produces: [org_profile]
    due_offset_days: 4
  - key: inventario_sistemas
    title: "Inventario de sistemas y herramientas"
    description: "Qué usa {{cliente}} hoy: ERP, hojas de cálculo, mensajería, control de producción. Partir de los sistemas declarados en el formulario de arranque (si los hay)."
    dod: "Lista de sistemas en uso registrada como documento tipado en el Context Hub, con fuente por sistema y responsable que lo declaró."
    stage: ENTENDER
    activity_type: systems_inventory
    priority: normal
    assign: { role: datos }
    due_offset_days: 4
  - key: entrevista
    title: "Entrevista: {{area}}"
    description: "Entrevista al área {{area}} de {{cliente}}: visión, dolores, prioridades y flujo de trabajo actual."
    dod: "Nota `interview` en el Context Hub con hallazgos clave y citas atribuidas a la persona entrevistada."
    stage: ENTENDER
    activity_type: interview
    priority: normal
    assign: { role: diagnostico }
    depends_on: [kickoff]
    produces: [interview]
    fan_out: { over: areas, as: area }
    due_offset_days: 7
  - key: mapa_proceso
    title: "Mapa de proceso as-is: {{proceso}}"
    description: "Mapear el proceso {{proceso}} tal como opera hoy, con base en las entrevistas."
    dod: "Proceso en `processes` (variant as_is) con pasos SIPOC, sistemas implicados y dolores, enlazado a sus entrevistas fuente."
    stage: ENTENDER
    activity_type: process_map
    priority: high
    assign: { role: diagnostico }
    depends_on: [entrevista]
    produces: [process_map]
    fan_out: { over: procesos_core, as: proceso }
    due_offset_days: 10
  - key: fugas
    title: "Análisis de fugas y cuellos de botella"
    description: "Consolidar retrabajos, esperas y fugas de margen detectadas en entrevistas y mapas de {{cliente}}."
    dod: "Un `finding` por fuga con impacto estimado y fuente; toda afirmación sin fuente marcada como no verificada."
    stage: ENTENDER
    activity_type: leak_analysis
    priority: high
    assign: { role: diagnostico }
    depends_on: [entrevista, mapa_proceso]
    produces: [finding]
    due_offset_days: 11
  - key: matriz_iso
    title: "Matriz de brechas ISO 9001 (cláusulas 4-10)"
    description: "Contrastar los procesos mapeados de {{cliente}} contra requisitos ISO 9001 e identificar huecos."
    dod: "Matriz cláusula↔proceso↔evidencia registrada como documento `iso_clause` con huecos identificados y priorizados."
    stage: ENTENDER
    activity_type: iso_gap
    priority: normal
    assign: { role: diagnostico }
    depends_on: [mapa_proceso]
    produces: [iso_clause]
    when_toggle: iso9001
    due_offset_days: 11
  - key: informe
    title: "Informe de assessment (borrador)"
    description: "Redactar el informe de diagnóstico de {{cliente}} consolidando perfil, mapas, fugas y brechas."
    dod: "Informe adjunto como artefacto citando doc ids del Context Hub (provenance); pasa a REVIEW para aprobación humana."
    stage: ENTENDER
    activity_type: report
    priority: urgent
    assign: { role: diagnostico }
    depends_on: [fugas, matriz_iso]
    produces: [report]
    gate: g1_plan
    due_from_input: fecha_objetivo
    due_offset_days: -1
  - key: roadmap
    title: "Roadmap de transformación priorizado"
    description: "Proponer el roadmap Entender → Construir → Operar para {{cliente}} con prioridades y esfuerzo, hacia {{fecha_objetivo}}."
    dod: "Roadmap adjunto como artefacto, coherente con el informe; su aprobación humana habilita el Gate 1 y cierra ENTENDER."
    stage: ENTENDER
    activity_type: roadmap
    priority: urgent
    assign: { role: orquestador }
    depends_on: [informe]
    produces: [roadmap]
    gate: g1_plan
    due_from_input: fecha_objetivo
gates:
  - name: g1_plan
    when: phase_close
    fed_by: [informe, roadmap]
    blocks_next_stage: CONSTRUIR
closing_deliverables:
  - kind: org_profile
    source: knowledge_doc
    min: 1
    produced_by: perfil_org
  - kind: interview
    source: knowledge_doc
    min_from_input: areas
    produced_by: entrevista
  - kind: process_map
    source: process
    min_from_input: procesos_core
    produced_by: mapa_proceso
  - kind: finding
    source: knowledge_doc
    min: 1
    produced_by: fugas
  - kind: iso_clause
    source: knowledge_doc
    min: 1
    produced_by: matriz_iso
    when_toggle: iso9001
  - kind: report
    source: artifact
    min: 1
    produced_by: informe
  - kind: roadmap
    source: artifact
    min: 1
    produced_by: roadmap
---

# Módulo Consultoría — Assessment en 14 días (v1)

Empaqueta la fase **ENTENDER** completa: disparo con formulario (13 inputs),
backlog desde plantillas, roster con topes de gasto, Gate 1 y entregables de
cierre. Es el mismo assessment que hoy vive hardcodeado en el seed demo de
ACME, convertido en producto disparable para cualquier cliente (PRD §1).

## Cómo funciona el disparo

1. El operador llena el formulario: empresa, industria, tamaño, sponsor,
   objetivo, **áreas a entrevistar** (mínimo 2) y fecha objetivo. Opcionales:
   alias corto, procesos core a mapear (default: una por área elegida),
   presupuesto de fase, sistemas conocidos, fuentes y notas del comercial
   (sensibles: se redactan en el recibo del launch).
2. `{{cliente}}` = alias ?? empresa. Cada área elegida genera **una entrevista**
   (`entrevista:direccion`, `entrevista:ventas`, ...); cada proceso core genera
   **un mapa as-is**.
3. Dependencias: las entrevistas esperan al kickoff; los mapas a las
   entrevistas; fugas a ambos; informe a fugas (y a la matriz ISO si aplica);
   roadmap al informe. Kickoff, perfil y el inventario de sistemas nacen READY.
4. **Toggle ISO 9001**: añade la matriz de brechas (`iso_gap`), el entregable
   de cierre `iso_clause` y la metodología `iso9001-prep`.

## Cierre de fase (Gate 1)

`g1_plan` se alimenta del informe y el roadmap (ambos con aprobación humana
obligatoria) y bloquea CONSTRUIR. La fase no cierra sin: org_profile, una
entrevista por área, un mapa por proceso core, findings de fugas, informe y
roadmap (+ matriz ISO con el toggle activo).

## Presupuesto

$15 por fase / $2 por run (editables al disparar vía `presupuesto_fase`);
semáforos al 70/90/100%. Quinn (QA) participa siempre, audite lo que audite.
