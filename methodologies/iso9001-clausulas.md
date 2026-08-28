---
slug: iso9001-clausulas
version: 1
---

# Catálogo de cláusulas ISO 9001:2015 (4.1 – 10.3)

> Catálogo de referencia de las cláusulas auditables de ISO 9001:2015, para uso
> del diagnóstico de preparación (metodología `iso9001-prep`). Cada entrada trae
> el **título**, un **resumen del requisito en lenguaje llano** y el **tipo de
> evidencia esperada**. Sam lo consulta con `methodology.get('iso9001-clausulas')`
> al construir la matriz de brechas `iso_gap`. Las cláusulas 1–3 (objeto,
> referencias normativas, términos) no son requisitos auditables y no se listan.

> **DISCLAIMER (literal):** "Este trabajo es preparación asistida para ISO 9001.
> La certificación la otorga únicamente un organismo de certificación acreditado,
> mediante su propia auditoría. Sixteam documenta, trazabiliza y detecta huecos;
> no certifica ni garantiza el resultado de la auditoría."

## Tabla de cláusulas

| Cláusula | Título | Requisito (llano) | Evidencia esperada |
|---|---|---|---|
| 4.1 | Comprensión de la organización y su contexto | Determinar cuestiones internas y externas que afectan al SGC. | Análisis de contexto (FODA/PESTEL) |
| 4.2 | Necesidades y expectativas de las partes interesadas | Identificar partes interesadas pertinentes y sus requisitos. | Registro de partes interesadas |
| 4.3 | Alcance del sistema de gestión de la calidad | Definir y documentar límites y aplicabilidad del SGC; justificar exclusiones. | Documento de alcance del SGC (obligatorio) |
| 4.4 | SGC y sus procesos | Determinar los procesos, sus entradas/salidas, secuencia, criterios, recursos, dueños, riesgos. | Mapa de procesos (entidades `processes`) |
| 5.1 | Liderazgo y compromiso | La alta dirección demuestra liderazgo y enfoque al cliente, integra el SGC al negocio. | Evidencia de involucramiento de la dirección |
| 5.2 | Política de calidad | Establecer, comunicar y mantener una política apropiada al propósito. | Política de calidad documentada (obligatorio) |
| 5.3 | Roles, responsabilidades y autoridades | Asignar y comunicar responsabilidades y autoridades del SGC. | Matriz de roles / RACI |
| 6.1 | Acciones para abordar riesgos y oportunidades | Determinar riesgos/oportunidades y planificar acciones integradas en los procesos. | Registro de riesgos y oportunidades |
| 6.2 | Objetivos de la calidad y planificación | Objetivos medibles y coherentes con la política, con plan (qué, quién, cuándo). | Objetivos de calidad documentados (obligatorio) |
| 6.3 | Planificación de los cambios | Realizar los cambios al SGC de manera planificada. | Registro de gestión de cambios |
| 7.1 | Recursos | Proveer personas, infraestructura, ambiente y recursos de seguimiento y medición. | Inventario de recursos y equipos de medición |
| 7.2 | Competencia | Asegurar y evidenciar la competencia de quienes afectan el desempeño. | Matriz de competencias / registros de formación |
| 7.3 | Toma de conciencia | Que las personas conozcan la política, objetivos y su contribución. | Evidencia de comunicación/sensibilización |
| 7.4 | Comunicación | Determinar las comunicaciones internas y externas pertinentes al SGC. | Plan de comunicación |
| 7.5 | Información documentada | Crear, actualizar y controlar la información documentada (versiones, acceso). | Inventario y control documental |
| 8.1 | Planificación y control operacional | Planificar, implementar y controlar los procesos para cumplir requisitos. | Criterios de control en los mapas de proceso |
| 8.2 | Requisitos para los productos y servicios | Comunicar con el cliente, determinar y revisar requisitos antes de comprometerse. | Registro de revisión de pedidos/cotizaciones |
| 8.3 | Diseño y desarrollo | Controlar el diseño cuando aplique; justificar la no aplicabilidad si no diseñan. | Registros de diseño o justificación de exclusión |
| 8.4 | Control de proveedores externos | Evaluar, seleccionar, seguir y reevaluar a los proveedores externos. | Registro de evaluación de proveedores |
| 8.5 | Producción y provisión del servicio | Producir en condiciones controladas, con identificación y trazabilidad donde aplique. | Registros de producción y trazabilidad |
| 8.6 | Liberación de productos y servicios | Verificar criterios de aceptación antes de liberar; registrar quién libera. | Registro de liberación / control de calidad |
| 8.7 | Control de salidas no conformes | Identificar y controlar lo no conforme; registrar la no conformidad y la acción. | Registro de no conformes |
| 9.1 | Seguimiento, medición, análisis y evaluación | Medir el desempeño y la eficacia del SGC, incluida la satisfacción del cliente. | Tablero de indicadores + medición de satisfacción |
| 9.2 | Auditoría interna | Auditar el SGC a intervalos planificados con auditores objetivos. | Programa y registros de auditoría interna |
| 9.3 | Revisión por la dirección | La dirección revisa el SGC (entradas/salidas definidas) y decide acciones. | Acta de revisión por la dirección |
| 10.1 | Mejora — generalidades | Determinar y seleccionar oportunidades de mejora. | Registro de oportunidades de mejora |
| 10.2 | No conformidad y acción correctiva | Reaccionar, analizar causa, actuar y verificar eficacia; conservar registros. | Registro de acciones correctivas (causa raíz) |
| 10.3 | Mejora continua | Mejorar de forma continua la conveniencia, adecuación y eficacia del SGC. | Evidencia de mejoras implementadas |

## Bloque estructurado (parseable)

El mismo catálogo, en el shape `iso_clause_catalog` documentado en `iso9001-prep`
(§5.1), para materializarlo como documento `iso_clause` del Context Hub cuando un
engagement lo requiera:

```json
{
  "doc_type": "iso_clause_catalog",
  "norma": "ISO 9001:2015",
  "disclaimer": "Este trabajo es preparación asistida para ISO 9001. La certificación la otorga únicamente un organismo de certificación acreditado, mediante su propia auditoría. Sixteam documenta, trazabiliza y detecta huecos; no certifica ni garantiza el resultado de la auditoría.",
  "clausulas": [
    { "clausula": "4.1", "titulo": "Comprensión de la organización y su contexto", "requisito": "Determinar cuestiones internas y externas que afectan al SGC.", "evidencia_esperada": ["Análisis de contexto (FODA/PESTEL)"], "obligatoria_info_documentada": false },
    { "clausula": "4.2", "titulo": "Necesidades y expectativas de las partes interesadas", "requisito": "Identificar partes interesadas pertinentes y sus requisitos.", "evidencia_esperada": ["Registro de partes interesadas"], "obligatoria_info_documentada": false },
    { "clausula": "4.3", "titulo": "Alcance del sistema de gestión de la calidad", "requisito": "Definir y documentar límites y aplicabilidad del SGC; justificar exclusiones.", "evidencia_esperada": ["Documento de alcance del SGC"], "obligatoria_info_documentada": true },
    { "clausula": "4.4", "titulo": "SGC y sus procesos", "requisito": "Determinar los procesos, entradas/salidas, secuencia, criterios, recursos, dueños, riesgos.", "evidencia_esperada": ["Mapa de procesos"], "obligatoria_info_documentada": true },
    { "clausula": "5.1", "titulo": "Liderazgo y compromiso", "requisito": "La alta dirección demuestra liderazgo y enfoque al cliente.", "evidencia_esperada": ["Evidencia de involucramiento de la dirección"], "obligatoria_info_documentada": false },
    { "clausula": "5.2", "titulo": "Política de calidad", "requisito": "Establecer, comunicar y mantener una política apropiada al propósito.", "evidencia_esperada": ["Política de calidad documentada"], "obligatoria_info_documentada": true },
    { "clausula": "5.3", "titulo": "Roles, responsabilidades y autoridades", "requisito": "Asignar y comunicar responsabilidades y autoridades del SGC.", "evidencia_esperada": ["Matriz de roles / RACI"], "obligatoria_info_documentada": false },
    { "clausula": "6.1", "titulo": "Acciones para abordar riesgos y oportunidades", "requisito": "Determinar riesgos/oportunidades y planificar acciones integradas.", "evidencia_esperada": ["Registro de riesgos y oportunidades"], "obligatoria_info_documentada": false },
    { "clausula": "6.2", "titulo": "Objetivos de la calidad y planificación", "requisito": "Objetivos medibles y coherentes con la política, con plan.", "evidencia_esperada": ["Objetivos de calidad documentados"], "obligatoria_info_documentada": true },
    { "clausula": "6.3", "titulo": "Planificación de los cambios", "requisito": "Realizar los cambios al SGC de manera planificada.", "evidencia_esperada": ["Registro de gestión de cambios"], "obligatoria_info_documentada": false },
    { "clausula": "7.1", "titulo": "Recursos", "requisito": "Proveer personas, infraestructura, ambiente y recursos de medición.", "evidencia_esperada": ["Inventario de recursos y equipos de medición"], "obligatoria_info_documentada": false },
    { "clausula": "7.2", "titulo": "Competencia", "requisito": "Asegurar y evidenciar la competencia de quienes afectan el desempeño.", "evidencia_esperada": ["Matriz de competencias / registros de formación"], "obligatoria_info_documentada": true },
    { "clausula": "7.3", "titulo": "Toma de conciencia", "requisito": "Que las personas conozcan la política, objetivos y su contribución.", "evidencia_esperada": ["Evidencia de sensibilización"], "obligatoria_info_documentada": false },
    { "clausula": "7.4", "titulo": "Comunicación", "requisito": "Determinar las comunicaciones internas y externas pertinentes.", "evidencia_esperada": ["Plan de comunicación"], "obligatoria_info_documentada": false },
    { "clausula": "7.5", "titulo": "Información documentada", "requisito": "Crear, actualizar y controlar la información documentada (versiones, acceso).", "evidencia_esperada": ["Inventario y control documental"], "obligatoria_info_documentada": true },
    { "clausula": "8.1", "titulo": "Planificación y control operacional", "requisito": "Planificar, implementar y controlar los procesos para cumplir requisitos.", "evidencia_esperada": ["Criterios de control en los procesos"], "obligatoria_info_documentada": false },
    { "clausula": "8.2", "titulo": "Requisitos para los productos y servicios", "requisito": "Comunicar con el cliente, determinar y revisar requisitos antes de comprometerse.", "evidencia_esperada": ["Registro de revisión de pedidos/cotizaciones"], "obligatoria_info_documentada": true },
    { "clausula": "8.3", "titulo": "Diseño y desarrollo", "requisito": "Controlar el diseño cuando aplique; justificar la no aplicabilidad.", "evidencia_esperada": ["Registros de diseño o justificación de exclusión"], "obligatoria_info_documentada": false },
    { "clausula": "8.4", "titulo": "Control de proveedores externos", "requisito": "Evaluar, seleccionar, seguir y reevaluar a los proveedores externos.", "evidencia_esperada": ["Registro de evaluación de proveedores"], "obligatoria_info_documentada": true },
    { "clausula": "8.5", "titulo": "Producción y provisión del servicio", "requisito": "Producir en condiciones controladas, con trazabilidad donde aplique.", "evidencia_esperada": ["Registros de producción y trazabilidad"], "obligatoria_info_documentada": true },
    { "clausula": "8.6", "titulo": "Liberación de productos y servicios", "requisito": "Verificar criterios de aceptación antes de liberar; registrar quién libera.", "evidencia_esperada": ["Registro de liberación / control de calidad"], "obligatoria_info_documentada": true },
    { "clausula": "8.7", "titulo": "Control de salidas no conformes", "requisito": "Identificar y controlar lo no conforme; registrar la acción.", "evidencia_esperada": ["Registro de no conformes"], "obligatoria_info_documentada": true },
    { "clausula": "9.1", "titulo": "Seguimiento, medición, análisis y evaluación", "requisito": "Medir el desempeño y la eficacia del SGC, incluida la satisfacción del cliente.", "evidencia_esperada": ["Tablero de indicadores", "Medición de satisfacción"], "obligatoria_info_documentada": true },
    { "clausula": "9.2", "titulo": "Auditoría interna", "requisito": "Auditar el SGC a intervalos planificados con auditores objetivos.", "evidencia_esperada": ["Programa y registros de auditoría interna"], "obligatoria_info_documentada": true },
    { "clausula": "9.3", "titulo": "Revisión por la dirección", "requisito": "La dirección revisa el SGC y decide acciones.", "evidencia_esperada": ["Acta de revisión por la dirección"], "obligatoria_info_documentada": true },
    { "clausula": "10.1", "titulo": "Mejora — generalidades", "requisito": "Determinar y seleccionar oportunidades de mejora.", "evidencia_esperada": ["Registro de oportunidades de mejora"], "obligatoria_info_documentada": false },
    { "clausula": "10.2", "titulo": "No conformidad y acción correctiva", "requisito": "Reaccionar, analizar causa, actuar y verificar eficacia; conservar registros.", "evidencia_esperada": ["Registro de acciones correctivas"], "obligatoria_info_documentada": true },
    { "clausula": "10.3", "titulo": "Mejora continua", "requisito": "Mejorar de forma continua la conveniencia, adecuación y eficacia del SGC.", "evidencia_esperada": ["Evidencia de mejoras implementadas"], "obligatoria_info_documentada": false }
  ]
}
```
