/**
 * Blueprint mínimo VÁLIDO compartido por los tests de shared (base de las
 * mutaciones por regla). Estructura tipo consultoría: fan_out sobre áreas,
 * toggle ISO, gate de fase y entregables de cierre.
 */
export function makeBlueprint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    slug: "demo",
    version: 1,
    name: "Módulo demo",
    phase: "ENTENDER",
    project_type: "assessment",
    project: { name_tpl: "Assessment {{cliente}}", workspace_tpl: "workspaces/{{empresa}}" },
    methodology: { slug: "assessment-14d", version: null },
    budget: { phase_usd: 15, per_run_usd: 2, warning_thresholds_pct: [70, 90, 100] },
    roster: [
      { role: "orquestador", agent: "alex", layer: "consultoria", max_usd_per_run: 2 },
      { role: "diagnostico", agent: "sam", layer: "consultoria", max_usd_per_run: 2 },
      { role: "qa", agent: "quinn", layer: "meta", always: true },
    ],
    inputs: [
      { key: "empresa", label: "Empresa", type: "text", required: true },
      { key: "alias", label: "Alias", type: "text", default_from: "empresa" },
      {
        key: "areas",
        label: "Áreas",
        type: "multi_select",
        required: true,
        min_items: 2,
        options: ["direccion", "ventas", "operaciones"],
      },
      { key: "fecha_objetivo", label: "Fecha objetivo", type: "date", required: true },
    ],
    toggles: [
      {
        key: "iso9001",
        label: "ISO 9001",
        default: false,
        enables_templates: ["matriz_iso"],
        enables_deliverables: ["iso_clause"],
        methodology_add: "iso9001-prep",
      },
    ],
    templates: [
      {
        key: "kickoff",
        title: "Kickoff con {{cliente}}",
        dod: "Acta registrada.",
        stage: "ENTENDER",
        activity_type: "kickoff",
        priority: "high",
        assign: { role: "orquestador" },
        due_offset_days: 2,
      },
      {
        key: "entrevista",
        title: "Entrevista: {{area}}",
        dod: "Nota interview con citas.",
        stage: "ENTENDER",
        activity_type: "interview",
        assign: { role: "diagnostico" },
        depends_on: ["kickoff"],
        produces: ["interview"],
        fan_out: { over: "areas", as: "area" },
      },
      {
        key: "matriz_iso",
        title: "Matriz ISO",
        dod: "Matriz registrada.",
        stage: "ENTENDER",
        activity_type: "iso_gap",
        assign: { role: "diagnostico" },
        depends_on: ["entrevista"],
        produces: ["iso_clause"],
        when_toggle: "iso9001",
      },
      {
        key: "informe",
        title: "Informe de assessment",
        dod: "Informe citando doc ids.",
        stage: "ENTENDER",
        activity_type: "report",
        assign: { role: "diagnostico" },
        depends_on: ["entrevista", "matriz_iso"],
        produces: ["report"],
        gate: "g1",
        due_from_input: "fecha_objetivo",
      },
    ],
    gates: [{ name: "g1", when: "phase_close", fed_by: ["informe"], blocks_next_stage: "CONSTRUIR" }],
    closing_deliverables: [
      { kind: "interview", source: "knowledge_doc", min_from_input: "areas", produced_by: "entrevista" },
      { kind: "iso_clause", source: "knowledge_doc", min: 1, produced_by: "matriz_iso", when_toggle: "iso9001" },
      { kind: "report", source: "artifact", min: 1, produced_by: "informe" },
    ],
    ...over,
  };
}

/** Mutación profunda cómoda para los tests de reglas. */
export function mutateBlueprint(fn: (bp: any) => void): Record<string, unknown> {
  const bp = JSON.parse(JSON.stringify(makeBlueprint()));
  fn(bp);
  return bp;
}
