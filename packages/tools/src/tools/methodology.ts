/** Metodología Sixteam como datos versionados (§8b): methodology.get/list. */
import { z } from "zod";
import { errors } from "@agentos/shared";
import { getMethodology, listMethodologies } from "@agentos/db";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const methodologyTools: ToolDefinition[] = [
  def({
    name: "methodology.get",
    description: "Lee una metodología por slug (última versión si no se indica version).",
    schema: z.object({ slug: z.string().min(1), version: z.number().int().positive().optional() }),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx, args) {
      const m = getMethodology(ctx.db, args.slug, args.version);
      if (!m) throw errors.notFound("methodology", `${args.slug}${args.version ? `@${args.version}` : ""}`);
      return m;
    },
  }),

  def({
    name: "methodology.list",
    description: "Lista todas las metodologías registradas (slug + versiones).",
    schema: z.object({}),
    flags: { read_only: true, external_effect: false, requires_approval: false },
    handler(ctx) {
      return listMethodologies(ctx.db);
    },
  }),
];
