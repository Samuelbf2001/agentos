/**
 * Auth simple del MVP (PRD §6.3, fuera de alcance el SSO/RBAC):
 * contraseña compartida (env AGENTOS_SHARED_PASSWORD) + selección de persona
 * del equipo → token de sesión firmado (HMAC-SHA256) que viaja como cookie
 * `agentos_session` o como `Authorization: Bearer`.
 *
 * El token NO contiene secretos: {pid, name, exp} en base64url + firma.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DAY_MS, nowMs } from "@agentos/shared";

export const SESSION_COOKIE = "agentos_session";
export const SESSION_TTL_MS = 7 * DAY_MS;

export interface Session {
  personId: string;
  personName: string;
  /** epoch ms */
  expiresAt: number;
}

export interface AuthService {
  verifyPassword(candidate: string): boolean;
  issueToken(person: { id: string; fullName: string }, now?: number): string;
  verifyToken(token: string | undefined | null, now?: number): Session | null;
  cookieFor(token: string): string;
  /** Cookie de borrado (logout): MISMOS atributos que la de emisión. */
  clearCookie(): string;
  /** true si las cookies se emiten con `Secure` (producción / HTTPS). */
  readonly cookieSecure: boolean;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createAuthService(opts: {
  sharedPassword: string;
  sessionSecret?: string;
  /** Emite las cookies con `Secure` (obligatorio en producción / detrás de HTTPS). */
  cookieSecure?: boolean;
}): AuthService {
  const password = opts.sharedPassword;
  // Secreto de firma: explícito (AGENTOS_SESSION_SECRET, obligatorio en
  // producción) o derivado de la contraseña en desarrollo — suficiente para un
  // workspace local mono-usuario; jamás se persiste. Rotar el secreto invalida
  // TODAS las sesiones emitidas con el anterior (las firmas dejan de casar).
  const secret =
    opts.sessionSecret ?? createHash("sha256").update(`agentos-session:${password}`).digest("hex");
  const cookieSecure = opts.cookieSecure === true;
  const secureAttr = cookieSecure ? "; Secure" : "";

  function sign(payloadB64: string): string {
    return b64url(createHmac("sha256", secret).update(payloadB64).digest());
  }

  return {
    cookieSecure,

    verifyPassword(candidate: string): boolean {
      return typeof candidate === "string" && safeEqual(candidate, password);
    },

    issueToken(person, now = nowMs()): string {
      const payload: Session = {
        personId: person.id,
        personName: person.fullName,
        expiresAt: now + SESSION_TTL_MS,
      };
      const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
      return `${payloadB64}.${sign(payloadB64)}`;
    },

    verifyToken(token, now = nowMs()): Session | null {
      if (!token) return null;
      const dot = token.lastIndexOf(".");
      if (dot <= 0) return null;
      const payloadB64 = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      if (!safeEqual(signature, sign(payloadB64))) return null;
      try {
        const session = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Session;
        if (typeof session.personId !== "string" || typeof session.expiresAt !== "number") return null;
        if (session.expiresAt <= now) return null;
        return session;
      } catch {
        return null;
      }
    },

    cookieFor(token: string): string {
      return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax${secureAttr}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },

    clearCookie(): string {
      return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax${secureAttr}; Max-Age=0`;
    },
  };
}

/**
 * ¿Se emiten cookies con `Secure`? `AGENTOS_COOKIE_SECURE` manda (1/true → sí,
 * 0/false → no); sin la variable, se activa solo en producción. Un despliegue
 * detrás de HTTPS jamás debe emitir la cookie de sesión sin `Secure`.
 */
export function resolveCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENTOS_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return (env.NODE_ENV ?? "").toLowerCase() === "production";
}

/** Extrae el token de Authorization: Bearer o de la cookie de sesión. */
export function extractToken(headers: {
  authorization?: string;
  cookie?: string;
}): string | null {
  const auth = headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) return rest.join("=");
    }
  }
  return null;
}
