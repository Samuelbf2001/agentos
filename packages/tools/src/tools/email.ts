/**
 * email.send — STUB de efecto externo (día 1, para ejercitar Gate 2).
 * El gateway NUNCA ejecuta este handler directamente: crea la aprobación y
 * devuelve pending_approval. El handler solo corre vía executeApproved (B4)
 * y aun entonces SOLO SIMULA el envío (fuera de alcance del MVP: PRD §6.7).
 */
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { defineTool as def } from "../catalog.js";

export const emailTools: ToolDefinition[] = [
  def({
    name: "email.send",
    description:
      "Envía un email (EFECTO EXTERNO: crea aprobación humana y devuelve pending_approval; nunca ejecuta sin aprobación). En el MVP el envío es simulado.",
    schema: z.object({
      to: z.string().min(3),
      subject: z.string().min(1),
      body: z.string().min(1),
    }),
    flags: { read_only: false, external_effect: true, requires_approval: true },
    // "none": un email no pertenece a un proyecto; su cinturón es el Gate 2 (aprobación humana).
    projectScope: "none",
    handler(_ctx, args) {
      // Stub deliberado: simula, jamás envía.
      return {
        simulated: true,
        to: args.to,
        subject: args.subject,
        message: "Envío SIMULADO (stub MVP): ningún email salió de la plataforma",
      };
    },
  }),
];
