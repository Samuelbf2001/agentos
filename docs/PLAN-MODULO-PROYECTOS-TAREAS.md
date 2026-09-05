# Plan de acción — Módulo operativo de Proyectos y Tareas

Este plan implementa [`PRD-MODULO-PROYECTOS-TAREAS.md`](./PRD-MODULO-PROYECTOS-TAREAS.md). Cada oleada termina con una revisión antes de abrir la siguiente; así evitamos que interfaz, API y persistencia inventen contratos distintos.

## Oleada 0 — Baseline y contrato

- Confirmar árbol limpio, contratos actuales, esquema SQLite/PostgreSQL y pruebas relevantes.
- Fijar el PRD, las exclusiones y los criterios de aceptación anteriores.
- Resultado: este plan y el PRD; no se cambia la semántica del BoardEngine.

## Oleada 1 — Dominio y persistencia

- Añadir `task_assignees` y `task_notification_log`, migraciones SQLite/PG, tipos y repositorios.
- Backfill de la asignación singular existente; servicios atómicos para sustituir responsables y mantener la proyección singular.
- Exponer consultas con responsables y filtros por persona; cubrir pertenencia a la organización, versión, deduplicación y portabilidad.
- Gate: migración nueva sobre base seed y pruebas de `@agentos/db`, `@agentos/core` y compatibilidad PG.

## Oleada 2 — API, MCP y notificaciones

- Adaptar REST y MCP al contrato de responsables y `due_at`; conservar todas las validaciones, eventos y auditorías.
- Implementar el procesador de solo dos avisos con adaptador fake/off por defecto, deduplicación y endpoint/job protegido para el recordatorio.
- Gate: pruebas REST/MCP, pruebas de no-red sin proveedor y regresiones de aprobación/gates.

## Oleada 3 — Interfaz de operación

- Aplicar la dirección "mesa de control operativa" al tablero y a la ficha de tarea.
- Añadir filtros de responsable, "Mis tareas", sin responsable, vencidas/próximas; selector accesible de responsables y fecha de vencimiento; contexto de archivos/fuentes ya existentes.
- Mantener drag-and-drop y reconciliación de eventos existentes. Validar estados vacío/carga/error/conflicto y 390×844.
- Gate: tests de reducer/UI, typecheck, build y revisión visual real de los flujos críticos.

## Oleada 4 — Integración, revisión y QA independiente

- Ejecutar migraciones con datos de seed, suite completa, typecheck y build de todos los paquetes.
- Revisión adversarial: aislamiento organizacional, optimistic locking, duplicación de avisos, no-envío por defecto, compatibilidad SQLite/PG, gates/artefactos y vista móvil.
- Corregir solo defectos demostrados y documentar resultados, riesgos residuales y configuración pendiente de un proveedor real de correo.
- Entregar un descriptor acotado a Claude QA: no edita; reproduce flujos, intenta romper invariantes y devuelve evidencia clasificada (bloqueante/no bloqueante/no reproducible).

## Cierre esperado

La entrega se considera lista para uso local cuando pasan las pruebas y el build, se observa el tablero en móvil/escritorio y el proveedor fake verifica ambos avisos. El envío a correos reales queda listo para habilitar, pero requiere configurar y probar un proveedor/remitente autorizado antes de declararlo productivo.
