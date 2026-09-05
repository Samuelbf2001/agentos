# Descriptor de QA — módulo nativo de Proyectos y Tareas

## Mandato

Actúa como revisor independiente de calidad para el módulo nativo de AgentOS.
El producto **no** pretende replicar Notion ni sincronizarlo. La fuente de
verdad es AgentOS: proyectos, personas, tareas, entregables, documentos de
conocimiento y fuentes ya existentes. El módulo sólo añade responsables
múltiples, vencimientos, tablero operativo y dos avisos de correo controlados.

Tu revisión es estrictamente de sólo lectura: no edites archivos, no ejecutes
migraciones contra bases compartidas, no hagas commits, no cambies
configuración, no llames proveedores de correo ni servicios externos. No
busques ni reproduzcas secretos.

## Alcance que debe existir

- Una tarea puede tener cero, una o varias personas responsables; una de ellas
  puede ser la principal. `tasks.assignee_person_id` sigue como proyección de
  compatibilidad, mientras `task_assignees` es la relación canónica.
- Responsables y tareas pertenecen a la misma organización. La asignación se
  reemplaza atómicamente y requiere `expected_version`; conserva eventos y
  auditoría de tareas.
- `due_at` se puede crear, editar o limpiar sin alterar las transiciones de
  estado, gates, dependencias o artefactos existentes.
- El tablero muestra por fase y estado canónico, filtros para mis tareas/sin
  responsable/vencidas-próximas, responsable principal, contador adicional,
  agente y vencimiento. La ficha de tarea permite administrar responsables y
  vencimiento y muestra el contexto existente del proyecto.
- Los únicos correos son `task_assigned` y `task_due_24h`; van sólo a una
  persona responsable interna con correo válido. Sin proveedor configurado no
  hay red ni correo: queda una bitácora `suppressed`. La deduplicación usa una
  clave estable; fallos reintentables mantienen la misma fila, sin duplicar.
- El procesador de vencimientos usa exclusivamente la hora del servidor. Su
  endpoint protegido no acepta destinatarios, asunto, cuerpo ni fecha.

## Archivos y contratos que revisar primero

- `docs/PRD-MODULO-PROYECTOS-TAREAS.md`
- `docs/PLAN-MODULO-PROYECTOS-TAREAS.md`
- `packages/db/src/schema.ts`, `packages/db/src/pg-schema.ts`
- `packages/db/drizzle/0005_responsables_avisos.sql`
- `packages/db/drizzle-pg/0001_responsables_avisos.sql`
- `packages/db/src/repositories/tasks.ts`
- `apps/api/src/routes/board.ts`, `apps/api/src/routes/notifications.ts`,
  `apps/api/src/notifications.ts`
- `packages/tools/src/tools/tasks.ts`
- `apps/web/src/views/BoardView.tsx`, `apps/web/src/views/TaskDrawer.tsx`,
  `apps/web/src/App.tsx`

## Casos de QA obligatorios

1. Migración y dominio: confirma que tareas antiguas con
   `assignee_person_id` se retroalimentan a `task_assignees`, no se pierden y
   quedan como principal; prueba cero/uno/múltiples y principal válida.
2. Aislamiento y concurrencia: intenta persona de otra organización y versión
   obsoleta; deben rechazar sin mutación parcial. Confirma que
   `parent_task_id` no se reutiliza para dependencias.
3. API y MCP: verifica los contratos REST y `tasks.assign_people`/
   `tasks.set_due_date`, conservando autenticación, eventos y auditoría. Busca
   accesos SQL directos de esta funcionalidad fuera de repositorios.
4. Avisos: con doble de correo verifica destinatario restringido, sin proveedor
   verifica cero entregas, assignment sólo ante cambio real, due dentro de 24 h,
   tareas terminales excluidas, deduplicación, reintento tras fallo y rechazo
   del campo `now` por HTTP.
5. UI: revisa que no invente estados nuevos; el tablero y ficha representan los
   contratos reales. Valida teclado y foco del drawer. A 390 x 844 CSS no debe
   haber scroll horizontal de documento; la navegación móvil puede desplazar
   sólo su propio carril.
6. Regresión: no debe existir cliente, importación, webhook ni credencial de
   Notion en este módulo. No se debe afirmar integración con PostgreSQL en vivo
   ni entrega real de correo si sólo se ejecutaron pruebas con dobles.

## Evidencia mínima esperada

Ejecuta, sin modificar datos persistentes ni activar proveedores:

```powershell
pnpm typecheck
pnpm test
pnpm --filter @agentos/web build
git diff --check
```

Después entrega un reporte breve en español con este formato:

```text
VEREDICTO: PASS | FAIL | BLOCKED

P0/P1/P2 — título
Evidencia: archivo:línea y comando/salida relevante.
Impacto: qué contrato o usuario queda afectado.
Reproducción: pasos mínimos (si aplica).
Corrección sugerida: concreta, sin implementarla.

Cobertura confirmada: ...
Límites de entorno: PostgreSQL vivo / proveedor de correo (si no se probaron).
```

No marques PASS global si falta evidencia de migración, aislamiento de
organización, deduplicación/reintento, o la vista móvil de 390 px.
