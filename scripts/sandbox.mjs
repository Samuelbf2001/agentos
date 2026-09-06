#!/usr/bin/env node
/**
 * Modo pruebas (sandbox) de AgentOS: copia local de `data/agentos.db`,
 * puertos propios (API 4310, web 4311), entrada sin contraseña.
 *
 * Uso: node scripts/sandbox.mjs <reset|api|web|status> [--agentes]
 *
 * Node >= 20, ESM, sin dependencias nuevas.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync, copyFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const SANDBOX_DB = join(DATA_DIR, "sandbox.db");
const API_PORT = 4310;
const WEB_PORT = 4311;

// ── .env de la raíz (parser mínimo, no sobreescribe variables ya presentes) ──
function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) continue; // el entorno ya presente manda
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveSourceDbPath() {
  const configured = process.env.AGENTOS_DB_PATH;
  const raw = configured && configured.trim() ? configured.trim() : "./data/agentos.db";
  return isAbsolute(raw) ? raw : join(ROOT, raw);
}

/** Copia `origin` (+ -wal/-shm si existen) a `data/sandbox.db`. Jamás toca el origen. */
function reset() {
  const origin = resolveSourceDbPath();
  if (!existsSync(origin)) {
    console.error(`[sandbox] No existe el origen: ${origin}`);
    console.error("[sandbox] Nada que copiar. Arranca apps/api al menos una vez o define AGENTOS_DB_PATH.");
    process.exitCode = 1;
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(SANDBOX_DB)) {
    const backup = `${SANDBOX_DB}.bak-${Date.now()}`;
    renameSync(SANDBOX_DB, backup);
    console.log(`[sandbox] sandbox.db existente → ${backup}`);
  }

  copyFileSync(origin, SANDBOX_DB);
  for (const ext of ["-wal", "-shm"]) {
    const originSide = `${origin}${ext}`;
    if (existsSync(originSide)) {
      copyFileSync(originSide, `${SANDBOX_DB}${ext}`);
    }
  }

  const size = statSync(SANDBOX_DB).size;
  console.log(`[sandbox] origen : ${origin}`);
  console.log(`[sandbox] destino: ${SANDBOX_DB}`);
  console.log(`[sandbox] tamaño : ${formatBytes(size)}`);
}

/** Spawn con stdio heredado; shell:true en Windows para resolver `pnpm`. */
function run(command, args, extraEnv) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

function api(agentesFlag) {
  if (!existsSync(SANDBOX_DB)) {
    console.log("[sandbox] data/sandbox.db no existe: ejecutando reset primero.");
    reset();
    if (process.exitCode) return; // reset falló (sin origen): no arrancar nada
  }

  if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    console.warn(
      "[sandbox] NODE_ENV=production venía del entorno: se sobreescribe a development (el modo pruebas jamás arranca en producción).",
    );
  }

  const extraEnv = {
    NODE_ENV: "development",
    AGENTOS_SANDBOX: "1",
    AGENTOS_DB_DRIVER: "sqlite",
    AGENTOS_DB_PATH: "./data/sandbox.db",
    AGENTOS_API_PORT: String(API_PORT),
    AGENTOS_WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
    AGENTOS_NOTIFICATIONS_INTERVAL_MS: "0",
  };

  if (agentesFlag) {
    console.warn(
      "[sandbox] --agentes: el despachador queda ACTIVO. Los agentes consumirán presupuesto real (LLM de verdad).",
    );
  } else {
    extraEnv.AGENTOS_DISPATCHER_DISABLED = "1";
  }

  console.log(`[sandbox] arrancando apps/api en :${API_PORT} contra data/sandbox.db`);
  run("pnpm", ["--filter", "@agentos/api", "dev"], extraEnv);
}

function web() {
  console.log(`[sandbox] arrancando apps/web en :${WEB_PORT} contra la API de :${API_PORT}`);
  run(
    "pnpm",
    ["--filter", "@agentos/web", "exec", "vite", "--port", String(WEB_PORT), "--strictPort"],
    { VITE_AGENTOS_API_URL: `http://localhost:${API_PORT}` },
  );
}

async function checkHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return null;
  }
}

async function status() {
  const originDb = resolveSourceDbPath();
  for (const [label, path] of [
    ["data/agentos.db (real)", originDb],
    ["data/sandbox.db (copia)", SANDBOX_DB],
  ]) {
    if (existsSync(path)) {
      const st = statSync(path);
      console.log(`[sandbox] ${label}: ${formatBytes(st.size)}, modificado ${st.mtime.toISOString()}`);
    } else {
      console.log(`[sandbox] ${label}: no existe (${path})`);
    }
  }

  const health = await checkHttp(`http://localhost:${API_PORT}/api/health`);
  if (health) {
    console.log(
      `[sandbox] API :${API_PORT} responde — sandbox=${health.body?.sandbox ?? "?"}, ok=${health.ok}`,
    );
  } else {
    console.log(`[sandbox] API :${API_PORT} no responde.`);
  }

  const webResp = await checkHttp(`http://localhost:${WEB_PORT}`);
  console.log(`[sandbox] web :${WEB_PORT} ${webResp ? "responde" : "no responde"}.`);
}

function main() {
  loadDotEnv();
  const [, , command, ...rest] = process.argv;
  const agentesFlag = rest.includes("--agentes");

  switch (command) {
    case "reset":
      reset();
      break;
    case "api":
      api(agentesFlag);
      break;
    case "web":
      web();
      break;
    case "status":
      void status();
      break;
    default:
      console.error("Uso: node scripts/sandbox.mjs <reset|api|web|status> [--agentes]");
      process.exitCode = 1;
  }
}

main();
