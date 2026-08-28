/**
 * Tools de preparación ISO 9001 (§8b, metodología `iso9001-prep`).
 *
 * `iso.gap_matrix_template` devuelve el ESQUELETO de la matriz de brechas para
 * un proyecto, a partir de sus `processes`: una fila por cláusula (4.1–10.3),
 * pre-enlazando los procesos cuyo `iso_refs` menciona la cláusula. NO es un
 * entregable: Sam lo completa con estado/evidencia/acciones y lo persiste como
 * documento `kind='iso_gap'` (ver `iso9001-prep` §5.2). Alcance: preparación
 * asistida, nunca certificación.
 */
import { z } from "zod";
import { listProcesses } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

/** Disclaimer literal y obligatorio en todo entregable ISO (idéntico en toda la metodología). */
export const ISO_DISCLAIMER =
  "Este trabajo es preparación asistida para ISO 9001. La certificación la otorga " +
  "únicamente un organismo de certificación acreditado, mediante su propia auditoría. " +
  "Sixteam documenta, trazabiliza y detecta huecos; no certifica ni garantiza el " +
  "resultado de la auditoría.";

/** Catálogo de cláusulas auditables de ISO 9001:2015 (4.1–10.3), fuente del esqueleto. */
export const ISO9001_CLAUSES: readonly { clausula: string; titulo: string }[] = [
  { clausula: "4.1", titulo: "Comprensión de la organización y su contexto" },
  { clausula: "4.2", titulo: "Necesidades y expectativas de las partes interesadas" },
  { clausula: "4.3", titulo: "Alcance del sistema de gestión de la calidad" },
  { clausula: "4.4", titulo: "SGC y sus procesos" },
  { clausula: "5.1", titulo: "Liderazgo y compromiso" },
  { clausula: "5.2", titulo: "Política de calidad" },
  { clausula: "5.3", titulo: "Roles, responsabilidades y autoridades" },
  { clausula: "6.1", titulo: "Acciones para abordar riesgos y oportunidades" },
  { clausula: "6.2", titulo: "Objetivos de la calidad y planificación" },
  { clausula: "6.3", titulo: "Planificación de los cambios" },
  { clausula: "7.1", titulo: "Recursos" },
  { clausula: "7.2", titulo: "Competencia" },
  { clausula: "7.3", titulo: "Toma de conciencia" },
  { clausula: "7.4", titulo: "Comunicación" },
  { clausula: "7.5", titulo: "Información documentada" },
  { clausula: "8.1", titulo: "Planificación y control operacional" },
  { clausula: "8.2", titulo: "Requisitos para los productos y servicios" },
  { clausula: "8.3", titulo: "Diseño y desarrollo" },
  { clausula: "8.4", titulo: "Control de proveedores externos" },
  { clausula: "8.5", titulo: "Producción y provisión del servicio" },
  { clausula: "8.6", titulo: "Liberación de productos y servicios" },
  { clausula: "8.7", titulo: "Control de salidas no conformes" },
  { clausula: "9.1", titulo: "Seguimiento, medición, análisis y evaluación" },
  { clausula: "9.2", titulo: "Auditoría interna" },
  { clausula: "9.3", titulo: "Revisión por la dirección" },
  { clausula: "10.1", titulo: "Mejora — generalidades" },
  { clausula: "10.2", titulo: "No conformidad y acción correctiva" },
  { clausula: "10.3", titulo: "Mejora continua" },
];

export const isoTools: ToolDefinition[] = [
  def({
    name: "iso.gap_matrix_template",
    description:
      "Devuelve el esqueleto de la matriz de brechas ISO 9001 (una fila por cláusula 4.1–10.3) " +
      "para una organización, pre-enlazando sus procesos por iso_refs. Punto de partida para el " +
      "documento kind='iso_gap' — NO es un entregable: hay que completar estado/evidencia/acciones.",
    schema: z.object({
      org_id: z.string().min(1),
      alcance_sgc: z.string().optional().describe("alcance del SGC declarado, si ya se conoce"),
      clausulas: z
        .array(z.string().min(1))
        .optional()
        .describe("subconjunto de cláusulas a incluir; por defecto todas (4.1–10.3)"),
    }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const procesos = listProcesses(ctx.db, args.org_id);
      const wanted = args.clausulas ? new Set(args.clausulas) : null;
      const clausulas = wanted
        ? ISO9001_CLAUSES.filter((c) => wanted.has(c.clausula))
        : ISO9001_CLAUSES;

      const filas = clausulas.map((c) => {
        // Procesos cuyo iso_refs menciona esta cláusula (o su capítulo, p. ej. "8").
        const capitulo = c.clausula.split(".")[0]!;
        const relacionados = procesos
          .filter((p) => (p.isoRefs ?? []).some((r) => r === c.clausula || r === capitulo))
          .map((p) => ({ id: p.id, name: p.name }));
        return {
          clausula: c.clausula,
          titulo: c.titulo,
          proceso_id: relacionados[0]?.id ?? null,
          proceso_nombre: relacionados[0]?.name ?? null,
          procesos_relacionados: relacionados,
          estado: null, // Sam completa: conforme | parcial | ausente | no_aplica
          evidencia: [] as string[],
          brecha: "",
          accion_cierre: null as string | null,
          responsable: null as string | null,
          fecha_objetivo: null as string | null,
          prioridad: null as string | null,
        };
      });

      return {
        doc_type: "iso_gap_matrix",
        norma: "ISO 9001:2015",
        alcance_sgc: args.alcance_sgc ?? null,
        disclaimer: ISO_DISCLAIMER,
        generado_por: "iso.gap_matrix_template",
        procesos_considerados: procesos.length,
        filas,
        nota:
          "Esqueleto de partida: completa estado/evidencia/brecha/accion_cierre/responsable/" +
          "fecha_objetivo antes de persistir como knowledge_doc kind='iso_gap'. No es un entregable.",
      };
    },
  }),
];
