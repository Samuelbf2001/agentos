---
slug: ops
version: 1
---

# Metodología Sixteam — Operación continua (etapa OPERAR)

> Esqueleto v1. La promesa Sixteam hecha rutina: no montamos y nos vamos —
> operamos mes a mes. Sally ejecuta el catálogo Ops, Clara mide y reporta,
> Vinnie mantiene integraciones, Quinn audita, Alex sintetiza para el humano.

**Precondición:** handoff de CONSTRUIR recibido (o engagement Ops directo con
inventario de sistemas y línea base de métricas registrados en el Context Hub).

## Ciclo semanal (la unidad de operación)

1. **Lunes — reporte** (Clara): las 3 métricas clave del área operada,
   variación vs. semana anterior, qué se movió y por qué, propuesta de
   ajuste. Artefacto a REVIEW; un humano lo aprueba antes de que salga al
   cliente.
2. **Sprint semanal** (Alex + especialistas): solicitudes del cliente y
   ajustes priorizados → tarjetas con DoD; se ejecuta el catálogo Ops
   (CRM, pipelines, automatizaciones, secuencias, formularios, routing,
   dashboards). Reunión de 30 min con el cliente: se ajusta lo que se trabó.
3. **Diario**: monitoreo de lo operado (secuencias activas, integraciones,
   alertas); urgencias del cliente entran como tarjetas priorizadas, no como
   favores invisibles.

## Reglas de operación

- **Solicitud → tarjeta.** Toda petición del cliente se vuelve tarea con DoD
  y dueño; nada se trabaja "de palabra".
- **Frontera de créditos:** operar y optimizar lo que existe → catálogo Ops.
  Construir algo nuevo con alcance complejo, contenido o pauta → se registra
  y se cotiza aparte (posible mini-ciclo `transform`).
- **Nada sale hacia afuera sin aprobación humana** (Gate 2): emails,
  mensajes, campañas, cambios visibles al cliente final.
- **Todo documentado:** cambios de configuración y decisiones → Context Hub
  (`note`/`decision`/`evidence`). Anti-dependencia: cualquier humano puede
  retomar la operación leyendo el Hub.
- **Opt-outs irreversibles** en cualquier canal, sin excepción.

## Entregables recurrentes (tipados)

- Reporte semanal → artefacto + `note` (histórico consultable).
- Reporte mensual: 3 métricas del área + coste del engagement (Clara;
  `null` = sin dato, nunca cero inferido).
- Registro de cambios operados → `evidence` por cambio relevante.
- Hallazgos de mejora detectados operando → `finding` (alimentan el backlog
  del sprint o un próximo transform).

## Gates y auditoría

- Gate 2 permanente sobre todo efecto externo (nivel tool call).
- Revisión humana del reporte semanal antes de enviarlo.
- Auditoría periódica de Quinn: DONE sin artefacto, secuencias huérfanas,
  compromisos del chat sin tarjeta, leases vencidos.
- Kill switch y pausa por agente disponibles siempre; pausar no pierde
  trabajo (las tareas vuelven a READY).
