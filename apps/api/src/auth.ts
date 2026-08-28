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

export function createAuthService(opts: { sharedPassword: string; sessionSecret?: string }): AuthService {
  const password = opts.sharedPassword;
  // Secreto de firma: explícito o derivado de la contraseña (suficiente para
  // un workspace local mono-usuario; jamás se persiste).
  const secret =
    opts.sessionSecret ?? createHash("sha256").update(`agentos-session:${password}`).digest("hex");

  function sign(payloadB64: string): string {
    return b64url(createHmac("sha256", secret).update(payloadB64).digest());
  }

  return {
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
      return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },
  };
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
