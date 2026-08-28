---
slug: assessment-14d
version: 2
---

# Metodología Sixteam — Assessment en 14 días

> Playbook operativo del assessment (etapa ENTENDER del ciclo
> Entender → Construir → Operar). Los agentes lo siguen vía `methodology.get`:
> Alex orquesta el backlog con estas fases, Sam ejecuta el diagnóstico,
> Clara apoya con inventarios y líneas base, Quinn audita evidencia.
> Regla transversal: todo entregable es un documento TIPADO del Context Hub
> con fuente (`[doc:<id>]`); una afirmación sin fuente se marca "no verificado".

## Resumen del ciclo

| Fase | Días | Objetivo | Entregables (kind) |
|---|---|---|---|
| 1. Kickoff | 1 | Alinear alcance, accesos y calendario | `note` (acta), `org_profile` |
| 2. Entrevistas + mapeo | 2-7 | Entender cómo trabaja la empresa hoy | `interview` (una por sesión), entidades `processes` as-is, `evidence` |
| 3. Análisis de fugas | 8-12 | Cuantificar qué se pierde y dónde | `finding` (uno por fuga), `iso_clause` (matriz, si aplica) |
| 4. Roadmap y entrega | 13-14 | Priorizar palancas y cerrar ENTENDER | informe de assessment (artefacto), roadmap (artefacto), `decision` |

El assessment termina en el **Gate 1**: la aprobación humana del informe +
roadmap cierra ENTENDER y habilita CONSTRUIR. Sin Gate 1 aprobado, ninguna
tarea de CONSTRUIR sale de BACKLOG.

---

## Fase 1 — Kickoff (día 1)

**Objetivo:** que el día 2 se pueda entrevistar sin fricción: alcance claro,
sponsor identificado, agenda de entrevistas confirmada y accesos pedidos.

Actividades:

1. Reunión inicial con el sponsor: alcance del assessment (¿toda la operación
   o un área?), expectativas, restricciones, interés en ISO 9001 (activa el
   módulo ISO de la Fase 3), calendario de entrevistas.
2. Perfil de la organización: industria, tamaño, estructura, productos o
   servicios, sistemas declarados, y clasificación inicial del caso —
   **CASO OPS** (ya tiene herramientas pero nadie las opera bien) o
   **CASO TRANSFORMACIÓN** (no tiene casi nada digital y hay que implementar
   desde cero). Esta clasificación orienta las preguntas y el roadmap.
3. Backlog del engagement creado y priorizado según esta metodología.
4. Solicitud de accesos e insumos (lecturas de CRM, reportes existentes,
   organigrama) — como pedidos registrados, no como supuestos.

**Entregables:**
- Acta de kickoff → `note` (fecha, participantes, alcance acordado, acuerdos).
- Perfil de organización → `org_profile` (con fuente por dato: quién lo
  declaró o de qué documento salió).

**Criterio de salida:** sponsor y alcance confirmados; agenda de entrevistas
con nombres y fechas; caso OPS/TRANSFORMACIÓN clasificado (o marcado
"pendiente de confirmar").

---

## Fase 2 — Entrevistas y mapeo (días 2-7)

**Objetivo:** reconstruir cómo trabaja la empresa HOY (as-is), con evidencia
citable, y dejarlo mapeado como entidades de proceso — no como prosa.

### Reglas de entrevista (estilo Sixteam)

- Una pregunta a la vez. Escuchar más que hablar. Confirmar con las palabras
  del entrevistado antes de avanzar ("entonces hoy pasa X, ¿correcto?").
- Empezar por lo fácil y descriptivo; el dolor y los números salen después.
- Ante algo específico, profundizar UNA vez: "¿me das un ejemplo concreto de
  cuándo pasó?".
- Cada afirmación relevante queda citable: quién lo dijo, cuándo.
- Cerrar siempre con: "¿qué no te pregunté que debería saber?".

### Guía de preguntas núcleo

**Comunes a toda área (base discovery Sixteam):**
1. ¿Cómo funciona tu área hoy, de punta a punta? Camíname un caso real.
2. ¿Qué herramientas o sistemas usan para eso? ¿Quién los opera?
3. ¿Qué se hace a mano que sientes que no debería hacerse a mano?
4. ¿Cuál es el mayor desafío de ese proceso hoy?
5. ¿Qué pasa cuando algo se cae o alguien falta? ¿Dónde se traba?
6. ¿Qué le cuesta eso a la empresa por mes? (ayudar a calcular en vivo si no
   hay número)
7. ¿Es algo que quieren resolver ahora o más adelante? ¿Qué tendría que pasar
   para que sea prioridad?
8. ¿Qué se ha intentado antes y por qué no funcionó?

**Dirección / gerencia:**
9. ¿Cuál es la prioridad del negocio este año y qué se lo impide?
10. ¿Qué números miras cada semana? ¿Confías en ellos? ¿De dónde salen?
11. ¿Qué decisiones se toman tarde por falta de información?
12. ¿Quién decide inversiones en tecnología o procesos? ¿Cómo?
13. Si esto sigue igual 6 meses, ¿qué impacto tiene?

**Operaciones / producción:**
9. ¿Cómo se planifica el trabajo de la semana? ¿En qué sistema vive el plan?
10. ¿Dónde se generan retrabajos o mermas? ¿Con qué frecuencia?
11. ¿Qué registros de calidad o control existen hoy? ¿Quién los llena?
12. ¿Cómo se entera producción de un cambio o un pedido urgente?
13. ¿Qué depende de una sola persona ("si falta X, se para Y")?

**Ventas / comercial:**
9. ¿Cómo llega un lead y qué pasa en la primera hora?
10. ¿Cuántas cotizaciones emiten al mes y qué seguimiento reciben?
11. ¿Qué pasa con los leads que no logran contactar a tiempo?
12. ¿Usan CRM? ¿Está al día? ¿Quién lo mantiene?
13. ¿Cómo saben si el mes viene bien o mal antes de que termine?

**Atención / servicio al cliente:**
9. ¿Por qué canales escriben los clientes y quién responde en cada uno?
10. ¿Cuánto tardan en responder? ¿Alguien lo mide?
11. ¿Qué preguntas se repiten todos los días?
12. ¿Cómo se entera el resto de la empresa de una queja grave?
13. ¿Qué pasa después de la venta: onboarding, seguimiento, recompra?

**Administración / finanzas:**
9. ¿Cómo va una venta desde factura hasta cobro? ¿Dónde se traba?
10. ¿Qué reportes arman a mano cada mes y cuánto tardan?
11. ¿Qué sistemas no se hablan entre sí y obligan a re-digitar?
12. ¿Cómo controlan pagos, vencimientos y cartera?
13. ¿Qué auditoría o requisito externo deben cumplir (contable, legal, ISO)?

### Mapeo de procesos (entidades `processes`, no prosa)

Cada proceso relevante se registra con `processes.upsert` usando esta
plantilla (campos de la entidad):

- `name`: nombre del proceso ("Cotización → cierre", "Planificación de
  producción").
- `owner_person`: dueño real del proceso (quien responde por él, no el cargo
  en el papel).
- `variant`: `as_is` en el assessment (los `to_be` nacen en CONSTRUIR).
- `steps` (base SIPOC, un objeto por paso): `paso` (qué se hace),
  `responsable` (quién), `sistema` (dónde: herramienta o "manual"),
  `entrada` (qué recibe), `salida` (qué produce y para quién).
- `systems`: sistemas implicados en el proceso completo.
- `pain_points`: dolores citados, cada uno con su fuente.
- `iso_refs`: cláusulas ISO 9001 relacionadas (si el módulo ISO está activo).
- `source_doc_ids`: entrevistas y documentos que sustentan el mapa —
  **obligatorio**: un proceso sin fuentes está incompleto (status `draft`).
- `status`: `draft` hasta que el dueño del proceso lo valide → `validated`.

**Entregables de la fase:**
- Una nota `interview` por sesión (hallazgos, citas atribuidas, sistemas,
  dolores).
- Procesos as-is en `processes` (mínimo: los 2-4 procesos core del alcance).
- Documentos aportados por el cliente (reportes, plantillas, manuales) →
  `evidence`.

**Criterio de salida:** entrevistas del alcance completadas; procesos core
mapeados con fuentes enlazadas; huecos de información listados explícitamente.

---

## Fase 3 — Análisis de fugas (días 8-12)

**Objetivo:** convertir lo entendido en una lista corta de fugas cuantificadas
y priorizadas — dinero, tiempo o clientes que se pierden hoy.

### Análisis de fugas

Consolidar entrevistas y mapas buscando patrones típicos: retrabajos, esperas
y cuellos de botella, fugas de margen (cotizaciones sin seguimiento, leads sin
contactar, cobros tardíos), dependencia de una sola persona, sistemas pagados
sin usar, información re-digitada, decisiones sin datos.

Cada fuga → un documento `finding` con:
- Descripción de la fuga y dónde ocurre (proceso y paso).
- **Cuantificación**: cuánto se pierde (horas/semana, $/mes, leads/mes), con
  el cálculo visible y sus fuentes `[doc:<id>]`. Si solo hay estimación del
  entrevistado, se usa y se marca como declarada; si no hay número posible,
  se marca "no cuantificado" — nunca se inventa.
- Causa probable (etiquetada como inferencia si es inferencia).
- Palanca propuesta (qué la resolvería, a alto nivel).

### Priorización de palancas: impacto × esfuerzo

Cada palanca se clasifica en una matriz 2×2:

| | Esfuerzo bajo | Esfuerzo alto |
|---|---|---|
| **Impacto alto** | **Quick win** — primeras del roadmap | **Proyecto mayor** — planificar en CONSTRUIR |
| **Impacto bajo** | Mejora oportunista — si sobra capacidad | **Descartar** (documentar por qué) |

- **Impacto**: usar la cuantificación del `finding` ($ o horas/mes
  recuperables); si no es cuantificable, juicio experto marcado como tal.
- **Esfuerzo**: días de implementación estimados + dependencias (accesos,
  integraciones, cambio de hábitos del equipo).
- Regla de desempate: gana la palanca que desbloquea otras (fundación antes
  que fachada).

### Módulo ISO 9001 (si el cliente lo pidió en kickoff)

**Alcance: PREPARACIÓN asistida.** Se mapean los procesos relevados contra
los requisitos de la norma, a nivel de brechas y evidencia — nada más.

Cláusulas a mapear contra los procesos (nivel preparación):
- **4.4** Sistema de gestión y sus procesos: ¿están definidos, con dueños,
  entradas/salidas y criterios? (los mapas `processes` son la base directa).
- **5** Liderazgo: política de calidad, roles y responsabilidades asignadas.
- **6** Planificación: riesgos y oportunidades identificados, objetivos de
  calidad medibles.
- **7.5** Información documentada: qué documentos/registros existen, cómo se
  controlan versiones y accesos.
- **8** Operación: control de la producción/servicio, requisitos del cliente,
  control de proveedores externos, trazabilidad.
- **9** Evaluación del desempeño: qué se mide, auditorías internas, revisión
  por la dirección.
- **10** Mejora: cómo se tratan no conformidades y acciones correctivas.

**Entregable:** matriz **cláusula ↔ proceso ↔ evidencia** como documento
`iso_clause`: por cada cláusula aplicable, qué proceso la cubre (o ninguno),
qué evidencia existe hoy (`[doc:<id>]` o `evidence`), tamaño de la brecha
(cubierto / parcial / ausente) y acción de preparación propuesta.

> **Disclaimer obligatorio (va literal en la matriz y en el informe):**
> "Este trabajo es preparación asistida para ISO 9001. La certificación la
> otorga únicamente un organismo de certificación acreditado, mediante su
> propia auditoría. Sixteam documenta, trazabiliza y detecta huecos; no
> certifica ni garantiza el resultado de la auditoría."

**Criterio de salida:** fugas cuantificadas (o marcadas no cuantificadas) con
fuente; palancas priorizadas en la matriz; matriz ISO completa si aplica.

---

## Fase 4 — Roadmap y entrega (días 13-14)

**Objetivo:** cerrar ENTENDER con dos artefactos aprobables y el Gate 1.

1. **Informe de assessment** (artefacto, pasa por REVIEW):
   - Resumen ejecutivo: el negocio, el caso (OPS/TRANSFORMACIÓN), las 3-5
     fugas principales con su costo.
   - Cómo trabaja la empresa hoy: procesos core con referencia a sus
     entidades y fuentes.
   - Fugas y hallazgos, cada uno citando sus `[doc:<id>]`.
   - Brechas ISO 9001 (si aplica) con la matriz y el disclaimer.
   - Provenance completo: el informe cita todos los documentos usados; lo no
     verificado queda marcado.
2. **Roadmap de transformación priorizado** (artefacto, pasa por REVIEW):
   - Palancas ordenadas por la matriz impacto × esfuerzo.
   - Secuencia Entender → Construir → Operar: qué se construye primero, qué
     se opera después, qué depende de qué.
   - Por palanca: resultado esperado, esfuerzo estimado, dependencias.
   - Sin fechas comprometidas que el backlog no sustente.
3. **Gate 1**: presentación al sponsor y decisión humana. Aprobado → se
   registra como `decision`, ENTENDER se cierra y CONSTRUIR se habilita.
   Rechazado con nota → el informe/roadmap vuelve a IN_PROGRESS con la nota
   como input.

**Criterio de salida:** ambos artefactos aprobados (Gate 1 = `approved`),
decisión registrada, backlog de CONSTRUIR esbozado a partir del roadmap.

---

## Criterios de calidad transversales

- Ninguna tarea del assessment se cierra sin su artefacto o documento tipado.
- Ningún número sin origen: fuente, fecha y cálculo visible. `null` = "sin
  dato", jamás cero.
- Hecho declarado ≠ inferencia del consultor: siempre etiquetados.
- Los huecos de información se listan como huecos — un assessment honesto con
  huecos vale más que uno completo inventado.
- Quinn puede auditar cualquier entregable de esta metodología contra estos
  criterios.
