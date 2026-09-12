/**
 * Prompts del asistente de IA de una tarea (en español, como todo lo que lee
 * el equipo).
 *
 * Dos modos:
 * - `enrich`: mejora UN campo del borrador (título, descripción o definición de
 *   terminado) y devuelve SÓLO el texto de ese campo.
 * - `execution_prompt`: redacta un prompt listo para pegar en Claude Code, con
 *   el contexto del cliente ya dentro y las URL de las referencias en absoluto.
 *
 * Reglas que no se negocian en ninguno de los dos:
 * - Lo que escribió el humano se conserva: el asistente amplía, no reemplaza.
 * - Nada inventado sobre el cliente. Lo que falte se pregunta en "Por confirmar".
 *
 * `plantillaPromptEjecucion` arma el mismo documento SIN modelo: es el plan B
 * cuando el proveedor está caído, para que "Copiar prompt" nunca se quede sin
 * respuesta.
 */
import type { TaskAssistBodyT, TaskAssistContext, TaskAssistFieldT } from "./assist-context.js";

/** Base pública de la instalación; las referencias del prompt van en absoluto. */
export const DEFAULT_PUBLIC_URL = "https://agentos.sixteam.pro";

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENTOS_PUBLIC_URL?.trim();
  return (raw || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
}

/** Convierte `/api/uploads/x` en `https://…/api/uploads/x`; deja intacto lo ya absoluto. */
export function absolutizarUrl(url: string, base: string = publicBaseUrl()): string {
  const limpio = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(limpio)) return limpio;
  return `${base}${limpio.startsWith("/") ? "" : "/"}${limpio}`;
}

/** Reescribe las URL de enlaces e imágenes Markdown a absolutas. */
export function absolutizarMarkdown(texto: string, base: string = publicBaseUrl()): string {
  return texto.replace(
    /(!?\[[^\]]*\]\()\s*<?([^)\s<>]+)>?([^)]*)\)/g,
    (_m, apertura: string, url: string, resto: string) =>
      `${apertura}${absolutizarUrl(url, base)}${resto})`,
  );
}

const NOMBRE_CAMPO: Record<TaskAssistFieldT, string> = {
  title: "título",
  description: "descripción",
  definition_of_done: "definición de terminado",
};

/**
 * Sección `## Cómo trabajar`: metodología fija para la sesión de Claude Code
 * que pega este prompt. Va SIEMPRE, literal, entre `## Detalle y pasos` y
 * `## Definición de terminado` — ni el modelo (`SYSTEM_PROMPT_EJECUCION`) ni la
 * plantilla determinista (`plantillaPromptEjecucion`) la reescriben.
 */
export const COMO_TRABAJAR_LINEAS = [
  "## Cómo trabajar",
  "- Empieza fijando las metas de esta sesión con `/goal` (3 a 5 metas verificables, sacadas de la definición de terminado) y ve marcándolas a medida que se cumplan.",
  "- Avanza en secuencia, un punto a la vez. Antes de cada paso di en una línea qué vas a hacer y por qué, sin términos técnicos innecesarios.",
  "- Resume. No expliques en detalle salvo que se te pida: respuestas cortas para gastar menos tokens.",
  "- Pregunta los datos que te falten (accesos, decisiones, criterios) agrupados en un solo mensaje, antes de asumir.",
  "- Cuando menciones una tarea, un proyecto o un documento, enlázalo (las URL están en Referencias).",
  "- Lo que haya que hacer en la web (CRM, paneles, formularios) hazlo con la extensión del navegador. Lo que sea muy difícil o tarde demasiado, pídeselo a una persona con instrucciones claras en vez de insistir.",
  "- Delega el trabajo sucio (buscar, leer archivos largos, borradores, pruebas repetitivas) a subagentes de menor consumo (Sonnet o Haiku); tú supervisas, revisas y apruebas antes de aplicar cualquier cambio.",
  "- No hagas nada irreversible (borrar, publicar, enviar, desplegar, pagar) sin confirmación explícita.",
];

// ── Sistema ─────────────────────────────────────────────────────────────────

export const SYSTEM_ENRIQUECER = [
  "Eres el asistente de operaciones de la agencia Sixteam. Ayudas a un miembro",
  "del equipo a dejar bien escrita UNA tarea para un cliente concreto.",
  "",
  "Reglas, en orden de importancia:",
  "1. CONSERVA lo que escribió la persona. Amplías y ordenas; no borras su",
  "   intención ni cambias el sentido de lo que ya puso.",
  "2. NO INVENTES datos del cliente: ni nombres, ni cifras, ni fechas, ni",
  "   herramientas, ni acuerdos que no estén en el contexto que te doy.",
  "3. Si falta información para dejar la tarea accionable, añade AL FINAL una",
  "   sección `## Por confirmar` con preguntas concretas (una por línea, con",
  "   viñeta). Preguntar es mejor que rellenar el hueco con algo verosímil.",
  "4. Escribes en español neutro, directo y sin relleno. Nada de «en el marco",
  "   de», «sinergia», ni preámbulos sobre lo que vas a hacer.",
  "5. Devuelves SOLO el texto del campo pedido. Sin comillas alrededor, sin",
  "   explicación previa, sin encabezado con el nombre del campo.",
  "",
  "Formato por campo:",
  "- `title`: UNA sola línea, corta y accionable (verbo + objeto). Sin punto",
  "  final, sin Markdown, sin el nombre del cliente si ya se sabe cuál es.",
  "- `description`: Markdown con estas secciones, en este orden:",
  "  `## Contexto` (por qué se hace, con lo que sepas del cliente),",
  "  `## Qué hay que hacer` (pasos NUMERADOS, concretos),",
  "  `## Referencias` (enlaces e imágenes). En Referencias MANTIENES tal cual",
  "  los enlaces e imágenes que ya estaban en el borrador, con su sintaxis",
  "  `![alt](url)` o `[texto](url)`: no los reescribas ni los quites.",
  "- `definition_of_done`: lista de criterios VERIFICABLES (uno por línea, con",
  "  `- `). Cada criterio se puede comprobar mirando algo: un archivo, una",
  "  pantalla, un mensaje enviado. Nada de «quedar bien» ni «revisado».",
  "",
  "Si te paso imágenes: son capturas que la persona pegó en la descripción.",
  "Descríbelas por lo que aportan a la tarea (qué pantalla es, qué se ve mal,",
  "qué dato aparece) y úsalo en el texto. No describas el aspecto por describir.",
].join("\n");

export const SYSTEM_PROMPT_EJECUCION = [
  "Eres el asistente de operaciones de la agencia Sixteam. Tu tarea es redactar",
  "un PROMPT que otra persona pegará en Claude Code para ejecutar el trabajo.",
  "",
  "Devuelves SOLO el prompt, en Markdown, sin comillas alrededor y sin explicar",
  "lo que has hecho. El prompt tiene EXACTAMENTE estas secciones, en este orden:",
  "",
  "`# Tarea: <título>`",
  "`## Contexto del cliente` — organización, proyecto y lo RELEVANTE de los",
  "documentos que te doy. Nada que no esté en el contexto.",
  "`## Objetivo` — una o dos frases: qué se consigue cuando esto esté hecho.",
  "`## Detalle y pasos` — pasos numerados y concretos.",
  "`## Cómo trabajar` — va SIEMPRE, con este contenido EXACTO, sin reescribirlo,",
  "resumirlo ni cambiarle una palabra (cópialo tal cual, viñeta por viñeta):",
  "",
  ...COMO_TRABAJAR_LINEAS,
  "",
  "`## Definición de terminado` — criterios verificables, uno por línea.",
  "`## Referencias` — enlaces e imágenes con URL ABSOLUTA. Te los doy YA armados",
  "en el contexto (tarea, proyecto, documentos y lo que traiga el borrador):",
  "cópialos TAL CUAL, uno por línea, en el orden en que te llegan. No inventes",
  "ninguno ni los reescribas.",
  "`## Restricciones` — no inventar datos; preguntar antes de cualquier decisión",
  "irreversible; tocar sólo lo necesario para esta tarea.",
  "`## Al terminar` — resumen de lo hecho y qué evidencia adjuntar como",
  "artefacto a la tarea en AgentOS.",
  "",
  "Reglas: conservas lo que escribió la persona, no inventas datos del cliente",
  "y, si falta información, la pides dentro de `## Restricciones` en vez de",
  "rellenarla. Las URL van completas (https://…), nunca relativas.",
].join("\n");

// ── Descripción del contexto (compartida por los dos modos) ─────────────────

function seccion(titulo: string, lineas: string[]): string[] {
  return lineas.length > 0 ? ["", titulo, ...lineas] : [];
}

function fecha(ms: number | null | undefined): string {
  if (!ms) return "sin fecha";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Bloque de texto plano con todo lo que el modelo sabe del cliente. */
export function describirContexto(ctx: TaskAssistContext, base: string = publicBaseUrl()): string {
  const lineas: string[] = [];

  lineas.push("## Cliente y proyecto");
  if (ctx.org) {
    lineas.push(
      `- Cliente: ${ctx.org.name}${ctx.org.industry ? ` (sector: ${ctx.org.industry})` : ""}`,
    );
    if (ctx.org.notes) lineas.push(`- Notas del cliente: ${ctx.org.notes}`);
  } else {
    lineas.push("- Cliente: no determinado (la tarea todavía no tiene proyecto).");
  }
  if (ctx.project) {
    lineas.push(
      `- Proyecto: ${ctx.project.name} — tipo ${ctx.project.type}, etapa ${ctx.project.stage}`,
    );
  }
  if (ctx.assignees.length > 0) {
    lineas.push(`- Responsables: ${ctx.assignees.join(", ")}`);
  }

  lineas.push(
    ...seccion(
      "## Documentos del cliente (Context Hub)",
      ctx.docs.map(
        (doc) =>
          `- [doc:${doc.id}] (${doc.scope === "org" ? "cliente" : "proyecto"}/${doc.kind}) ${doc.title}\n  ${doc.body_md.replace(/\n/g, "\n  ")}${doc.truncated ? "\n  […recortado]" : ""}`,
      ),
    ),
  );

  lineas.push(
    ...seccion(
      "## Otras tareas del proyecto (para que entiendas de qué va)",
      ctx.siblingTasks.map(
        (task) => `- [${task.status}] ${task.title} (vence: ${fecha(task.due_at)})`,
      ),
    ),
  );

  if (ctx.task) {
    lineas.push("");
    lineas.push("## Tarea ya guardada en AgentOS");
    lineas.push(`- id: ${ctx.task.id}`);
    lineas.push(`- Título: ${ctx.task.title}`);
    lineas.push(`- Estado: ${ctx.task.status} / etapa ${ctx.task.stage} / prioridad ${ctx.task.priority}`);
    lineas.push(`- Vence: ${fecha(ctx.task.due_at)}`);
    if (ctx.task.description) lineas.push(`- Descripción guardada:\n  ${ctx.task.description.replace(/\n/g, "\n  ")}`);
    if (ctx.task.definition_of_done) {
      lineas.push(`- Definición de terminado guardada:\n  ${ctx.task.definition_of_done.replace(/\n/g, "\n  ")}`);
    }
  }

  lineas.push(
    ...seccion(
      "## Últimos movimientos y comentarios de la tarea",
      ctx.events.map(
        (event) => `- ${fecha(event.created_at)} ${event.kind} por ${event.actor}${event.text ? `: ${event.text}` : ""}`,
      ),
    ),
  );

  lineas.push(
    ...seccion(
      "## Artefactos adjuntos",
      ctx.artifacts.map(
        (artifact) =>
          `- (${artifact.kind}) ${artifact.title}${artifact.url ? ` → ${absolutizarUrl(artifact.url, base)}` : ""}${artifact.content ? `\n  ${artifact.content.replace(/\n/g, "\n  ")}` : ""}`,
      ),
    ),
  );

  lineas.push(
    ...seccion(
      "## Imágenes adjuntas a este mensaje",
      ctx.images.map(
        (image, i) => `- Imagen ${i + 1}: ${image.alt || "sin descripción"} (${absolutizarUrl(image.source, base)})`,
      ),
    ),
  );

  lineas.push(
    ...seccion(
      "## Imágenes externas (NO se han leído; sólo son enlaces)",
      ctx.externalImages.map((url) => `- ${url}`),
    ),
  );

  return lineas.join("\n");
}

function describirBorrador(body: TaskAssistBodyT): string[] {
  const draft = body.draft ?? {};
  const lineas: string[] = ["## Borrador actual (lo que escribió la persona)"];
  lineas.push(`- Título: ${draft.title?.trim() || "(vacío)"}`);
  lineas.push(`- Descripción:\n${draft.description?.trim() || "(vacía)"}`);
  lineas.push(`- Definición de terminado:\n${draft.definition_of_done?.trim() || "(vacía)"}`);
  if (draft.priority) lineas.push(`- Prioridad: ${draft.priority}`);
  if (draft.due_at) lineas.push(`- Vence: ${fecha(draft.due_at)}`);
  if (draft.labels && draft.labels.length > 0) lineas.push(`- Etiquetas: ${draft.labels.join(", ")}`);
  return lineas;
}

// ── Prompts de usuario ──────────────────────────────────────────────────────

export function construirPromptEnriquecer(
  ctx: TaskAssistContext,
  body: TaskAssistBodyT,
  base: string = publicBaseUrl(),
): string {
  const field = (body.field ?? "description") as TaskAssistFieldT;
  const lineas = [
    `Mejora el campo **${NOMBRE_CAMPO[field]}** (\`${field}\`) de esta tarea.`,
    "",
    describirContexto(ctx, base),
    "",
    ...describirBorrador(body),
  ];
  if (body.instructions?.trim()) {
    lineas.push("");
    lineas.push("## Indicación de la persona (tiene prioridad sobre el resto)");
    lineas.push(body.instructions.trim());
  }
  lineas.push("");
  lineas.push(
    `Devuelve SOLO el texto final del campo \`${field}\`, con el formato que te pide el sistema. Nada más.`,
  );
  return lineas.join("\n");
}

export function construirPromptEjecucion(
  ctx: TaskAssistContext,
  body: TaskAssistBodyT,
  base: string = publicBaseUrl(),
): string {
  const lineas = [
    "Redacta el prompt de ejecución para esta tarea.",
    "",
    describirContexto(ctx, base),
    "",
    ...describirBorrador(body),
    "",
    "## Referencias que debes conservar (ya en absoluto)",
    ...referenciasAbsolutas(ctx, body, base).map((ref) => `- ${ref}`),
  ];
  if (body.instructions?.trim()) {
    lineas.push("");
    lineas.push("## Indicación de la persona (tiene prioridad sobre el resto)");
    lineas.push(body.instructions.trim());
  }
  lineas.push("");
  lineas.push(
    `La tarea en AgentOS es \`${ctx.task?.id ?? "(todavía sin guardar)"}\`: nómbrala en \`## Al terminar\` para que la evidencia se adjunte donde toca.`,
  );
  lineas.push("Devuelve SOLO el prompt en Markdown, con las secciones exactas que pide el sistema.");
  return lineas.join("\n");
}

/**
 * Enlaces del contexto (tarea, proyecto, documentos) más los del borrador y de
 * los artefactos, todos ya absolutos. En este orden: tarea en AgentOS (si ya
 * tiene id), proyecto, documentos del proyecto, cada doc citado (máx. 5) y
 * luego lo que ya había en el Markdown (enlaces, imágenes locales y externas).
 */
export function referenciasAbsolutas(
  ctx: TaskAssistContext,
  body: TaskAssistBodyT,
  base: string = publicBaseUrl(),
): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  const push = (valor: string): void => {
    if (!vistos.has(valor)) {
      vistos.add(valor);
      out.push(valor);
    }
  };

  const taskId = ctx.task?.id ?? body.task_id;
  if (taskId) push(`Tarea en AgentOS: ${base}/tareas?tarea=${taskId}`);
  if (ctx.project) {
    push(`Proyecto: ${base}/proyectos/${ctx.project.id}/ruta`);
    push(`Documentos del proyecto: ${base}/proyectos/${ctx.project.id}/contexto/documentos`);
  }
  for (const doc of ctx.docs.slice(0, 5)) push(`[doc:${doc.id}] ${doc.title}`);

  const textos = [body.draft?.description ?? "", ctx.task?.description ?? ""];
  for (const texto of textos) {
    for (const match of texto.matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s<>]+)>?[^)]*\)/g)) {
      const esImagen = match[1] === "!";
      const alt = (match[2] ?? "").trim();
      const url = absolutizarUrl(match[3] ?? "", base);
      push(`${esImagen ? "!" : ""}[${alt || (esImagen ? "imagen" : "enlace")}](${url})`);
    }
  }
  for (const artifact of ctx.artifacts) {
    if (artifact.url) push(`[${artifact.title}](${absolutizarUrl(artifact.url, base)})`);
  }
  for (const image of ctx.images) {
    push(`![${image.alt || "imagen"}](${absolutizarUrl(image.source, base)})`);
  }
  for (const url of ctx.externalImages) push(`![imagen externa](${url})`);
  return out;
}

// ── Plan B determinista ─────────────────────────────────────────────────────

/**
 * El mismo documento, armado en código. Se usa cuando el proveedor falla en
 * modo `execution_prompt`: el botón "Copiar prompt" tiene que funcionar SIEMPRE,
 * aunque sea con una plantilla honesta en vez de un texto redactado.
 */
export function plantillaPromptEjecucion(
  ctx: TaskAssistContext,
  body: TaskAssistBodyT,
  base: string = publicBaseUrl(),
): string {
  const draft = body.draft ?? {};
  const titulo = draft.title?.trim() || ctx.task?.title || "Tarea sin título";
  const descripcion = draft.description?.trim() || ctx.task?.description?.trim() || "";
  const dod = draft.definition_of_done?.trim() || ctx.task?.definition_of_done?.trim() || "";
  const referencias = referenciasAbsolutas(ctx, body, base);
  const taskId = ctx.task?.id ?? body.task_id ?? "(aún sin guardar)";

  const lineas: string[] = [];
  lineas.push(`# Tarea: ${titulo}`);

  lineas.push("");
  lineas.push("## Contexto del cliente");
  lineas.push(`- Cliente: ${ctx.org?.name ?? "sin determinar"}`);
  if (ctx.org?.industry) lineas.push(`- Sector: ${ctx.org.industry}`);
  if (ctx.project) {
    lineas.push(`- Proyecto: ${ctx.project.name} (${ctx.project.type}, etapa ${ctx.project.stage})`);
  }
  if (ctx.assignees.length > 0) lineas.push(`- Responsables: ${ctx.assignees.join(", ")}`);
  for (const doc of ctx.docs.slice(0, 5)) {
    lineas.push(`- [doc:${doc.id}] ${doc.title}: ${doc.body_md.split("\n")[0] ?? ""}`);
  }
  if (ctx.siblingTasks.length > 0) {
    lineas.push("- Otras tareas del proyecto:");
    for (const task of ctx.siblingTasks.slice(0, 8)) {
      lineas.push(`  - [${task.status}] ${task.title}`);
    }
  }

  lineas.push("");
  lineas.push("## Objetivo");
  lineas.push(titulo);

  lineas.push("");
  lineas.push("## Detalle y pasos");
  lineas.push(
    descripcion
      ? absolutizarMarkdown(descripcion, base)
      : "1. (Sin detalle en la tarea: revisa el contexto del cliente y pregunta lo que falte antes de actuar.)",
  );

  lineas.push("", ...COMO_TRABAJAR_LINEAS);

  lineas.push("");
  lineas.push("## Definición de terminado");
  lineas.push(dod || "- (Sin criterios definidos: acuérdalos con quien pidió la tarea antes de darla por cerrada.)");

  lineas.push("");
  lineas.push("## Referencias");
  if (referencias.length > 0) for (const ref of referencias) lineas.push(`- ${ref}`);
  else lineas.push("- (Sin referencias adjuntas.)");

  lineas.push("");
  lineas.push("## Restricciones");
  lineas.push("- No inventes datos del cliente: lo que no esté aquí, se pregunta.");
  lineas.push("- Pregunta antes de cualquier decisión irreversible (borrar, publicar, enviar, desplegar).");
  lineas.push("- Toca sólo lo necesario para esta tarea.");

  lineas.push("");
  lineas.push("## Al terminar");
  lineas.push("- Escribe un resumen de lo que hiciste y de lo que decidiste por el camino.");
  lineas.push(
    `- Adjunta la evidencia (archivo, captura o enlace) como artefacto de la tarea \`${taskId}\` en AgentOS.`,
  );

  return lineas.join("\n");
}
