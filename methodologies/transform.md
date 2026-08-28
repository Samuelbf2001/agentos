---
slug: transform
version: 1
---

# Metodología Sixteam — Transform (etapa CONSTRUIR)

> Esqueleto v1. Convierte el roadmap aprobado en el Gate 1 en sistemas
> funcionando. Alex orquesta, Debbie construye, Vinnie integra, Sam valida
> contra el diagnóstico, Quinn critica cada entregable en REVIEW.

**Precondición dura:** existe un assessment con Gate 1 aprobado (`decision`
registrada). Sin Gate 1, ninguna tarea de CONSTRUIR sale de BACKLOG.

## Fase 1 — Diseño y spec (por palanca del roadmap)

- Cada palanca priorizada se convierte en una spec corta: objetivo, alcance,
  diseño, criterios de aceptación verificables, riesgos y dependencias.
- Los procesos `to_be` se registran en `processes` (variant `to_be`),
  derivados del as-is y enlazando sus fuentes (`source_doc_ids`).
- **Entregables:** spec (artefacto por palanca), procesos `to_be`,
  decisiones de diseño → `decision`.
- **Gate de fase:** spec aprobada por humano antes de construir lo grande;
  piezas chicas y mecánicas pueden ir directo con DoD clara.

## Fase 2 — Construcción e integración

- Debbie produce los entregables técnicos en el workspace; Vinnie conecta
  los sistemas del cliente (credenciales SIEMPRE por referencia).
- Toda acción con efecto externo pasa por Gate 2 (aprobación a nivel tool
  call): se solicita con el payload exacto y se espera.
- Avance visible en el tablero: una tarjeta por pieza, artefacto SIEMPRE
  antes de REVIEW.
- **Entregables:** código/configuración en el workspace, integraciones con
  evidencia de prueba, documentación técnica → `evidence`/`note`.

## Fase 3 — Validación

- Verificación contra los criterios de aceptación de cada spec: ejecutar,
  medir, comparar. Quinn critica los entregables en REVIEW y abre bugs con
  repro; los bugs vuelven al agente constructor.
- Validación con el proceso real del cliente: el dueño del proceso confirma
  que el `to_be` construido refleja lo acordado → proceso `validated`.
- **Entregables:** reportes de verificación (artefactos), bugs cerrados,
  procesos `to_be` validados.
- **Gate de fase:** aprobación humana de los entregables mayores en REVIEW.

## Fase 4 — Despliegue y handoff a operación

- Puesta en marcha acordada con el cliente (ventanas, reversibilidad).
- Handoff a OPERAR: qué queda operando, quién lo opera (Sally/Clara/humanos),
  con qué métricas y qué línea base (medida, no supuesta).
- **Entregables:** sistema en producción, doc de handoff → `note`, línea
  base de métricas → `finding`/`note`, decisión de cierre → `decision`.
- **Gate de salida:** aceptación humana del cierre de CONSTRUIR; habilita la
  operación continua (metodología `ops`).

## Criterios transversales

- Nada se declara "funcionando" sin verificación ejecutada y evidencia.
- Todo cambio sobre sistemas del cliente es reversible o tiene plan de
  reversa documentado.
- El alcance lo fija el roadmap aprobado: lo nuevo que aparezca se registra
  como propuesta (`note`) y se prioriza — no se construye por impulso.
