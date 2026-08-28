---
slug: iso9001-prep
version: 1
---

# Metodología Sixteam — Preparación ISO 9001:2015

> Playbook dedicado de **PREPARACIÓN asistida** para un Sistema de Gestión de la
> Calidad (SGC) conforme a ISO 9001:2015. Profundiza el "Módulo ISO 9001" de la
> metodología `assessment-14d`: donde el assessment produce una matriz de brechas
> de alto nivel, aquí se define el trabajo cláusula por cláusula, la información
> documentada obligatoria y el plan de cierre por fases. Sam ejecuta el
> diagnóstico siguiendo este documento vía `methodology.get('iso9001-prep')`;
> Alex lo orquesta en el backlog; Quinn audita cada entregable.

> **DISCLAIMER OBLIGATORIO (va literal en TODO entregable ISO y en el informe):**
> "Este trabajo es preparación asistida para ISO 9001. La certificación la
> otorga únicamente un organismo de certificación acreditado, mediante su propia
> auditoría. Sixteam documenta, trazabiliza y detecta huecos; no certifica ni
> garantiza el resultado de la auditoría."

**Qué NO es esto.** No es certificación, no es auditoría de tercera parte, no es
una garantía de aprobación. Sixteam prepara: mapea procesos, ordena la
información documentada, detecta huecos contra la norma y propone un plan de
cierre. Certifica únicamente un organismo acreditado, con su propia auditoría.

---

## 1. Principios de gestión de la calidad (los 7)

La norma se apoya en siete principios; el diagnóstico los usa como lente para
leer la organización. No son cláusulas auditables una a una, pero explican el
"por qué" de los requisitos.

1. **Enfoque al cliente.** Cumplir requisitos del cliente y aspirar a superar sus
   expectativas. Señal: ¿se conocen y miden los requisitos del cliente?
2. **Liderazgo.** La dirección fija propósito y dirección, y crea las condiciones
   para lograr los objetivos de calidad. Señal: ¿la alta dirección se involucra o
   delega calidad a un documento muerto?
3. **Compromiso de las personas.** Personas competentes, facultadas y
   comprometidas en todos los niveles. Señal: ¿la gente conoce su rol en la
   calidad?
4. **Enfoque a procesos.** Resultados coherentes y predecibles cuando las
   actividades se gestionan como procesos interrelacionados (ver §2).
5. **Mejora.** La organización mejora de forma continua su desempeño. Señal:
   ¿existe un mecanismo real de mejora, o los problemas se repiten?
6. **Toma de decisiones basada en la evidencia.** Decidir sobre datos y análisis,
   no sobre percepción. Señal: ¿hay indicadores confiables?
7. **Gestión de las relaciones.** Gestionar la relación con partes interesadas
   pertinentes (proveedores, aliados) para sostener el desempeño.

En el diagnóstico, cada principio débil se traduce en hallazgos concretos
(`finding`) y en brechas de cláusula (`iso_gap`), nunca en juicios vagos.

---

## 2. Enfoque a procesos y pensamiento basado en riesgos

Estos dos conceptos son el corazón operativo de ISO 9001:2015 y la razón por la
que la plataforma modela **procesos como entidades** (`processes`), no como prosa.

**Enfoque a procesos.** Cada actividad se entiende como un proceso con:
entradas, salidas, dueño, recursos, controles y criterios de desempeño, y su
interacción con otros procesos (la salida de uno es la entrada de otro). Los
mapas SIPOC de `processes` (paso, responsable, sistema, entrada, salida) son la
evidencia directa de la cláusula 4.4. Un SGC "de papel" describe procesos que no
coinciden con la operación real; la preparación Sixteam parte de los procesos
**as-is reales** ya mapeados en el assessment.

**Pensamiento basado en riesgos.** La norma sustituye la "acción preventiva"
clásica por riesgos y oportunidades identificados y tratados (cláusula 6.1) e
integrados en los procesos. En preparación:
- Por cada proceso core se listan sus riesgos (qué puede salir mal, con qué
  impacto) y oportunidades de mejora.
- Se registran como `finding` (riesgo cuantificado cuando se pueda) y se enlazan
  al proceso (`iso_refs` incluye "6.1").
- No se inventa una matriz de riesgos genérica: se derivan de los dolores y
  fugas ya relevados, con fuente `[doc:<id>]`.

**Ciclo PHVA (Planificar–Hacer–Verificar–Actuar).** La norma se estructura sobre
PHVA: Planificar (cláusulas 4, 5, 6, 7), Hacer (8), Verificar (9), Actuar (10).
El plan de cierre (§6) ordena las brechas siguiendo este ciclo.

---

## 3. Información documentada obligatoria

ISO 9001:2015 exige mantener (documentos) y conservar (registros) cierta
"información documentada". La preparación inventaría qué existe, qué falta y en
qué estado. Lista núcleo que el diagnóstico verifica siempre:

**Documentos que se deben MANTENER:**
- **Alcance del SGC** (4.3): qué productos/servicios y ubicaciones cubre, con las
  exclusiones justificadas.
- **Política de calidad** (5.2): declaración de la dirección, comunicada y
  disponible.
- **Objetivos de calidad** (6.2): medibles, con plan (qué, quién, cuándo, con qué
  recursos, cómo se evalúa).
- **Información documentada para la operación de los procesos** (4.4): los mapas
  de proceso, procedimientos e instructivos donde sean necesarios para asegurar
  resultados coherentes.

**Registros que se deben CONSERVAR (evidencia de que el SGC opera):**
- Evidencia de aptitud para el seguimiento y medición (7.1.5).
- Competencia del personal: educación, formación, experiencia (7.2).
- Revisión de requisitos del producto/servicio (8.2.3).
- Elementos de diseño y desarrollo, si aplica (8.3).
- Evaluación y reevaluación de proveedores externos (8.4.1).
- Trazabilidad / identificación del producto cuando se requiera (8.5.2).
- Cambios en producción/prestación del servicio (8.5.6).
- Conformidad del producto con los criterios de aceptación / liberación (8.6).
- Salidas no conformes y acciones tomadas (8.7.2).
- Resultados de seguimiento y medición (9.1).
- Programa y resultados de auditoría interna (9.2).
- Resultados de la revisión por la dirección (9.3).
- No conformidades y acciones correctivas (10.2).

**Regla Sixteam de información documentada:** cada ítem del inventario se marca
`existe` / `parcial` / `ausente`, con su fuente (`evidence` o `[doc:<id>]`) y su
control de versiones/acceso. Un documento que "existe" pero nadie usa ni versiona
se marca **parcial**, no conforme.

> La norma NO obliga a un formato ni a un "manual de calidad" único: la extensión
> de la información documentada depende del tamaño y complejidad de la
> organización. La preparación evita el papeleo innecesario.

---

## 4. Diagnóstico cláusula por cláusula (4 → 10)

Para cada cláusula aplicable el diagnóstico produce, de forma consistente:
**(a) qué exige la norma** en lenguaje llano, **(b) qué evidencia/documento
produce Sixteam**, **(c) cómo se mapea a los `processes` del cliente**, y
**(d) preguntas de auditoría interna** que Sam usa para sondear la brecha.

Las cláusulas 1–3 (objeto, referencias, términos) no son auditables como
requisito y no se diagnostican. El SGC arranca en la 4.

### Cláusula 4 — Contexto de la organización

**4.1 Comprensión de la organización y su contexto.**
- (a) Determinar cuestiones internas y externas pertinentes al propósito y que
  afectan la capacidad de lograr los resultados del SGC.
- (b) Análisis de contexto (FODA/PESTEL sintético) → `note` o sección del
  `org_profile`.
- (c) No mapea a un proceso; usa el `org_profile` del assessment como base.
- (d) ¿Qué factores externos (mercado, regulación, proveedores) e internos
  (cultura, capacidades) afectan su calidad hoy?

**4.2 Comprensión de las necesidades y expectativas de las partes interesadas.**
- (a) Identificar partes interesadas pertinentes al SGC y sus requisitos.
- (b) Registro de partes interesadas y requisitos → `note`.
- (c) Alimenta requisitos de los procesos de venta y servicio.
- (d) ¿Quiénes influyen en su calidad (clientes, reguladores, casa matriz) y qué
  esperan?

**4.3 Determinación del alcance del SGC.**
- (a) Definir límites y aplicabilidad; documentar el alcance y justificar
  exclusiones.
- (b) **Alcance del SGC** (información documentada obligatoria) → `decision` +
  sección del informe.
- (c) Define qué procesos entran al SGC.
- (d) ¿Qué áreas, sedes y líneas de producto entrarían al alcance? ¿Qué queda
  fuera y por qué?

**4.4 Sistema de gestión de la calidad y sus procesos.**
- (a) Establecer, mantener y mejorar el SGC: procesos necesarios, sus entradas y
  salidas, secuencia e interacción, criterios y métodos, recursos, dueños,
  riesgos y oportunidades.
- (b) **Mapa de procesos del SGC** → entidades `processes` (variant `as_is` en
  diagnóstico) con `iso_refs`.
- (c) Mapeo directo: cada `processes` es la evidencia de esta cláusula.
- (d) ¿Puede nombrar sus procesos core, quién responde por cada uno y cómo se
  encadenan?

### Cláusula 5 — Liderazgo

**5.1 Liderazgo y compromiso.**
- (a) La alta dirección debe demostrar liderazgo y compromiso con el SGC y el
  enfoque al cliente (rendición de cuentas, integración en el negocio, recursos).
- (b) Evidencia de involucramiento de la dirección → `interview` (dirección) +
  `finding`.
- (c) Transversal a todos los procesos.
- (d) ¿Cómo participa la dirección en calidad hoy, más allá de firmar?

**5.2 Política de calidad.**
- (a) Establecer, comunicar y mantener una política apropiada al propósito,
  marco para los objetivos, con compromiso de cumplir requisitos y mejorar.
- (b) **Política de calidad** (información documentada obligatoria) → `decision` /
  artefacto.
- (c) Encabeza el SGC; no mapea a un proceso.
- (d) ¿Existe una política de calidad? ¿La conoce el equipo o vive en un cajón?

**5.3 Roles, responsabilidades y autoridades en la organización.**
- (a) Asignar y comunicar responsabilidades y autoridades para los roles
  pertinentes.
- (b) Matriz de roles/RACI del SGC → `note`.
- (c) Se refleja en `owner_person` de cada `processes`.
- (d) ¿Quién responde por que cada proceso cumpla, y lo sabe?

### Cláusula 6 — Planificación

**6.1 Acciones para abordar riesgos y oportunidades.**
- (a) Determinar riesgos y oportunidades y planificar acciones para tratarlos e
  integrarlas en los procesos.
- (b) Riesgos por proceso → `finding` (enlazados con `iso_refs: ["6.1"]`).
- (c) Se adjunta a cada `processes` core.
- (d) ¿Qué puede salir mal en este proceso y qué hacen para evitarlo?

**6.2 Objetivos de la calidad y planificación para lograrlos.**
- (a) Objetivos medibles, coherentes con la política, con plan (qué, recursos,
  responsable, plazo, evaluación).
- (b) **Objetivos de calidad** (información documentada obligatoria) → `decision`.
- (c) Se miden sobre los procesos (indicadores de 9.1).
- (d) ¿Tienen metas de calidad medibles o solo intenciones?

**6.3 Planificación de los cambios.**
- (a) Los cambios al SGC se hacen de manera planificada.
- (b) Registro de gestión de cambios → `note`.
- (c) Se refleja en procesos `to_be` (etapa CONSTRUIR).
- (d) ¿Cómo introducen un cambio en un proceso sin romper otra cosa?

### Cláusula 7 — Apoyo

**7.1 Recursos** (personas, infraestructura, ambiente, recursos de seguimiento y
medición, conocimientos de la organización).
- (a) Proporcionar los recursos necesarios para el SGC.
- (b) Inventario de recursos y equipos de medición → `evidence` / `note`.
- (c) Recursos declarados en `systems` de cada proceso.
- (d) ¿Con qué equipos miden calidad y cómo aseguran que miden bien?

**7.2 Competencia.**
- (a) Determinar y asegurar la competencia de las personas que afectan el
  desempeño; conservar evidencia.
- (b) Matriz de competencias / registros de formación → `evidence`.
- (c) Se cruza con `owner_person` y responsables de pasos.
- (d) ¿Cómo saben que quien hace la tarea está capacitado?

**7.3 Toma de conciencia** y **7.4 Comunicación.**
- (a) Que las personas conozcan la política, objetivos y su contribución;
  determinar comunicaciones internas y externas.
- (b) Plan de comunicación del SGC → `note`.
- (c) Transversal.
- (d) ¿El equipo sabe qué es la política de calidad y por qué importa?

**7.5 Información documentada.**
- (a) Crear, actualizar y controlar la información documentada (identificación,
  formato, revisión/aprobación, control de versiones, acceso, conservación).
- (b) **Inventario de información documentada** (ver §3) → `evidence` + matriz.
- (c) Los `source_refs` y versiones de los `knowledge_docs` son el ejemplo vivo
  de control documental.
- (d) ¿Cómo controlan versiones y acceso de sus documentos clave?

### Cláusula 8 — Operación

**8.1 Planificación y control operacional.**
- (a) Planificar, implementar y controlar los procesos para cumplir requisitos.
- (b) Se evidencia en los mapas `processes` con criterios de control.
- (c) Mapeo directo a procesos operativos core.
- (d) ¿Cómo aseguran que cada corrida del proceso cumple lo pedido?

**8.2 Requisitos para los productos y servicios** (comunicación con el cliente,
determinación y revisión de requisitos, cambios).
- (a) Determinar y revisar los requisitos antes de comprometerse; gestionar
  cambios.
- (b) Registro de revisión de pedidos/cotizaciones → `evidence`.
- (c) Mapea al proceso comercial (cotización → cierre).
- (d) ¿Cómo confirman lo que el cliente pidió antes de producir?

**8.3 Diseño y desarrollo** (si aplica).
- (a) Controlar el diseño de productos/servicios cuando corresponda; si no
  diseñan, se justifica la no aplicabilidad.
- (b) Registros de diseño → `evidence`, o justificación de exclusión.
- (c) Mapea a un proceso de diseño si existe.
- (d) ¿Diseñan producto propio o fabrican a especificación del cliente?

**8.4 Control de los procesos, productos y servicios suministrados externamente.**
- (a) Asegurar que lo provisto por terceros cumple requisitos: criterios de
  evaluación, selección, seguimiento y reevaluación de proveedores.
- (b) Registro de evaluación de proveedores → `evidence`.
- (c) Mapea al proceso de compras/abastecimiento.
- (d) ¿Cómo eligen y controlan a sus proveedores críticos?

**8.5 Producción y provisión del servicio** (control, identificación y
trazabilidad, propiedad del cliente, preservación, actividades posteriores,
control de cambios).
- (a) Producir en condiciones controladas, con trazabilidad donde se requiera.
- (b) Registros de producción y trazabilidad → `evidence`.
- (c) Mapea al proceso de producción/prestación.
- (d) Si un cliente reclama por un lote, ¿pueden rastrear qué pasó y cuándo?

**8.6 Liberación de los productos y servicios.**
- (a) Verificar el cumplimiento de criterios de aceptación antes de liberar;
  conservar evidencia y quién libera.
- (b) Registro de liberación / control de calidad → `evidence`.
- (c) Paso final del proceso de producción.
- (d) ¿Quién autoriza que un producto salga y con qué criterio?

**8.7 Control de las salidas no conformes.**
- (a) Identificar y controlar lo que no cumple para prevenir su uso o entrega;
  registrar la no conformidad y la acción.
- (b) Registro de no conformes → `evidence` / `finding`.
- (c) Mapea al control de calidad del proceso.
- (d) ¿Qué hacen con un producto defectuoso y dónde queda registrado?

### Cláusula 9 — Evaluación del desempeño

**9.1 Seguimiento, medición, análisis y evaluación** (incluye satisfacción del
cliente).
- (a) Determinar qué medir, cuándo y cómo; evaluar el desempeño y la eficacia del
  SGC; medir la percepción del cliente.
- (b) Tablero de indicadores + medición de satisfacción → `note` / `finding`.
- (c) Los indicadores se definen sobre los `processes` y objetivos (6.2).
- (d) ¿Qué números miran para saber si la calidad va bien? ¿Confían en ellos?

**9.2 Auditoría interna.**
- (a) Auditar el SGC a intervalos planificados: programa, criterios, objetividad,
  registros, corrección de hallazgos.
- (b) Programa y registros de auditoría interna → `evidence`.
- (c) Audita la conformidad de los procesos.
- (d) ¿Alguien revisa internamente si se cumple lo definido, o solo se apaga
  fuego?

**9.3 Revisión por la dirección.**
- (a) La alta dirección revisa el SGC a intervalos planificados (entradas y
  salidas definidas por la norma) y decide acciones.
- (b) Acta de revisión por la dirección → `decision` / `note`.
- (c) Cierra el ciclo sobre todos los procesos e indicadores.
- (d) ¿La dirección revisa formalmente el desempeño de la calidad y decide sobre
  datos?

### Cláusula 10 — Mejora

**10.1 Generalidades.** Determinar y seleccionar oportunidades de mejora.
**10.2 No conformidad y acción correctiva.**
- (a) Ante una no conformidad: reaccionar, evaluar causa, implementar acción,
  revisar eficacia; conservar registros.
- (b) Registro de acciones correctivas (con análisis de causa raíz) → `evidence`.
- (c) Mapea al mecanismo de mejora sobre los procesos.
- (d) Cuando algo falla, ¿atacan la causa o solo el síntoma? ¿queda registro?

**10.3 Mejora continua.** Mejorar de manera continua la conveniencia, adecuación
y eficacia del SGC. Señal: ¿los mismos problemas se repiten mes a mes?

---

## 5. Entregables tipados de la preparación

### 5.1 Catálogo de cláusulas — `kind='iso_clause'`

Referencia de las cláusulas 4.1–10.3 (título, resumen del requisito, tipo de
evidencia esperada). El catálogo canónico vive como metodología versionada,
legible con `methodology.get('iso9001-clausulas')`. Cuando un engagement necesita
el catálogo dentro de su Context Hub, se materializa como documento `iso_clause`
con este cuerpo (JSON dentro del `body_md`, parseable y auditable):

```json
{
  "doc_type": "iso_clause_catalog",
  "norma": "ISO 9001:2015",
  "disclaimer": "Este trabajo es preparación asistida para ISO 9001. La certificación la otorga únicamente un organismo de certificación acreditado, mediante su propia auditoría. Sixteam documenta, trazabiliza y detecta huecos; no certifica ni garantiza el resultado de la auditoría.",
  "clausulas": [
    {
      "clausula": "8.4",
      "titulo": "Control de procesos, productos y servicios suministrados externamente",
      "requisito": "Asegurar que lo provisto por terceros cumple requisitos: criterios de evaluación, selección, seguimiento y reevaluación de proveedores.",
      "evidencia_esperada": ["Registro de evaluación de proveedores", "Criterios de selección"],
      "obligatoria_info_documentada": true
    }
  ]
}
```

`tags` del doc: `["iso9001", "catalogo-clausulas"]`.

### 5.2 Matriz de brechas — `kind='iso_gap'` (entregable principal)

Es el corazón de la preparación: la matriz **cláusula ↔ proceso ↔ estado ↔
evidencia ↔ acción de cierre ↔ responsable ↔ fecha**. Se registra como un único
documento `iso_gap` por engagement (una fila por cláusula aplicable). El cuerpo
es markdown con **(1)** el disclaimer, **(2)** un bloque JSON estructurado
(fuente de verdad, parseable) y **(3)** una tabla renderizada para humanos.

**Shape del bloque JSON (fuente de verdad):**

```json
{
  "doc_type": "iso_gap_matrix",
  "norma": "ISO 9001:2015",
  "alcance_sgc": "Producción y comercialización de <...> en la planta de <...>",
  "disclaimer": "Este trabajo es preparación asistida para ISO 9001. La certificación la otorga únicamente un organismo de certificación acreditado, mediante su propia auditoría. Sixteam documenta, trazabiliza y detecta huecos; no certifica ni garantiza el resultado de la auditoría.",
  "filas": [
    {
      "clausula": "8.4",
      "titulo": "Control de procesos, productos y servicios suministrados externamente",
      "proceso_id": "proc_a1b2",
      "proceso_nombre": "Compras y abastecimiento",
      "estado": "parcial",
      "evidencia": ["[doc:e4f2]", "evidence:contrato-proveedor-2025"],
      "brecha": "Hay contratos pero no criterios formales de evaluación ni reevaluación periódica de proveedores.",
      "accion_cierre": "Definir criterios de evaluación y una reevaluación semestral registrada.",
      "responsable": "person:8f21 (Jefe de Compras)",
      "fecha_objetivo": "2026-11-30",
      "prioridad": "alta"
    }
  ]
}
```

**Campos y valores permitidos por fila:**
- `clausula` (string, requerido): id de la cláusula, p. ej. `"8.4"`.
- `titulo` (string, requerido): título corto de la cláusula.
- `proceso_id` (string | null): id de la entidad `processes` que la cubre, o
  `null` si ninguna la cubre todavía.
- `proceso_nombre` (string | null): nombre legible del proceso.
- `estado` (enum, requerido): `"conforme"` | `"parcial"` | `"ausente"` |
  `"no_aplica"`. `"no_aplica"` exige justificación en `brecha` (p. ej. 8.3 si no
  hay diseño).
- `evidencia` (string[]): referencias `[doc:<id>]`, `evidence:<slug>` o
  `process:<id>`. Vacío = sin evidencia hoy (coherente con `ausente`).
- `brecha` (string): qué falta, en llano. Para `conforme`, puede quedar vacío.
- `accion_cierre` (string | null): qué hacer para cerrar; `null` si `conforme`.
- `responsable` (string | null): `person:<id>` o rol declarado.
- `fecha_objetivo` (ISO date string | null): sin fecha inventada; `null` si no
  hay compromiso sustentado.
- `prioridad` (enum): `"alta"` | `"media"` | `"baja"`, derivada del riesgo y del
  esfuerzo de cierre (mismo criterio impacto×esfuerzo del assessment).

`tags` del doc: `["iso9001", "matriz-brechas"]`. `source_refs`: los documentos y
procesos usados para poblar la matriz (provenance obligatoria).

**Reglas anti-alucinación de la matriz:**
- Ninguna fila `conforme` sin al menos una `evidencia` citada.
- Ningún `fecha_objetivo` ni `responsable` inventado: si no está acordado, `null`.
- Toda `brecha` se sustenta en un hallazgo o proceso real, no en un supuesto.
- La herramienta `iso.gap_matrix_template` genera el esqueleto (una fila por
  cláusula, pre-enlazando procesos por `iso_refs`); Sam lo completa con evidencia
  y estado — el esqueleto NO es un entregable, es un punto de partida.

---

## 6. Plan de cierre de brechas por fases

El plan ordena las acciones de cierre siguiendo PHVA y la matriz impacto×esfuerzo.
Es un **artefacto** (pasa por REVIEW), coherente con la matriz `iso_gap`. Nunca
promete certificación ni fechas que el backlog no sustente.

- **Fase 0 — Fundaciones de liderazgo (cláusulas 4, 5).** Alcance del SGC,
  política de calidad, roles/autoridades, contexto y partes interesadas. Sin esto
  el resto no ancla. Salida: alcance + política + RACI aprobados por la dirección.
- **Fase 1 — Planificación (cláusula 6).** Riesgos y oportunidades por proceso,
  objetivos de calidad medibles con su plan. Salida: objetivos y matriz de riesgos
  vivos.
- **Fase 2 — Información documentada y competencia (cláusula 7).** Cerrar el
  inventario documental (§3), control de versiones/acceso, matriz de competencias.
  Salida: información documentada obligatoria completa y controlada.
- **Fase 3 — Control operacional (cláusula 8).** Cerrar brechas de operación:
  revisión de requisitos, control de proveedores, trazabilidad, liberación,
  no conformes. Salida: procesos operando en condiciones controladas con registro.
- **Fase 4 — Evaluación y mejora (cláusulas 9, 10).** Indicadores y satisfacción,
  auditoría interna, revisión por la dirección, acciones correctivas. Salida: al
  menos un ciclo completo de auditoría interna + revisión por la dirección
  ejecutado, con registros.

Cada fase declara: brechas que cierra (filas de la matriz), entregables,
responsable y criterio de salida. La organización queda **lista para solicitar la
auditoría de certificación a un organismo acreditado** — que es quien decide.

> Recordatorio final (literal): "Este trabajo es preparación asistida para ISO
> 9001. La certificación la otorga únicamente un organismo de certificación
> acreditado, mediante su propia auditoría. Sixteam documenta, trazabiliza y
> detecta huecos; no certifica ni garantiza el resultado de la auditoría."

---

## 7. Criterios de calidad transversales (heredados del assessment)

- Todo entregable ISO es un documento **tipado** (`iso_clause`, `iso_gap`,
  `evidence`, `finding`, `note`, `decision`) con fuente `[doc:<id>]`; sin fuente
  se marca "no verificado".
- El disclaimer va **literal** en cada matriz, en el plan de cierre y en el
  informe. Nunca se sugiere que Sixteam certifica.
- `estado` y `evidencia` deben ser coherentes: `conforme` exige evidencia;
  `ausente` implica evidencia vacía.
- Los huecos se listan como huecos: una matriz honesta con cláusulas `ausente`
  vale más que una "toda verde" inventada.
- Quinn puede auditar cualquier `iso_gap` contra estos criterios (coherencia
  estado/evidencia, disclaimer presente, provenance completa).
