#!/usr/bin/env bash
# Copia consistente de la SQLite de AgentOS + retención.
#
# Solo aplica cuando AGENTOS_DB_DRIVER=sqlite. Con el motor de producción
# (postgres) el respaldo es pg_dump contra agentos-db; ver deploy/README.md.
#
# Por qué no sirve `cp`: la DB corre en WAL, así que copiar el .db mientras la
# API escribe produce un archivo truncado o incoherente. Se usa la API de
# backup online de SQLite (`.backup` / better-sqlite3 `db.backup()`), que toma
# una instantánea consistente sin detener la API.
#
# Uso (en el VPS, como root):
#   ./backup-sqlite.sh
#   AGENTOS_BACKUP_RETENTION_DAYS=30 ./backup-sqlite.sh
#
# Variables (todas con valor por defecto):
#   AGENTOS_DATA_DIR               volumen de datos en el host
#   AGENTOS_DB_FILE                archivo .db dentro de ese volumen
#   AGENTOS_BACKUP_DIR             destino de las copias
#   AGENTOS_API_CONTAINER          contenedor de la API (modo docker)
#   AGENTOS_BACKUP_RETENTION_DAYS  días de retención (14 por defecto)

set -euo pipefail

DATA_DIR="${AGENTOS_DATA_DIR:-/etc/easypanel/projects/whatsfull/agentos-api/data}"
DB_FILE="${AGENTOS_DB_FILE:-$DATA_DIR/agentos.db}"
BACKUP_DIR="${AGENTOS_BACKUP_DIR:-$DATA_DIR/backups}"
CONTAINER="${AGENTOS_API_CONTAINER:-agentos-api}"
RETENTION_DAYS="${AGENTOS_BACKUP_RETENTION_DAYS:-14}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="agentos-${STAMP}.db"
DEST="$BACKUP_DIR/$NAME"

log() { printf '[backup-sqlite] %s\n' "$*"; }
fail() { printf '[backup-sqlite] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$DB_FILE" ] || fail "no existe $DB_FILE (¿el motor es postgres, o cambió AGENTOS_DB_PATH?)"
mkdir -p "$BACKUP_DIR"

if command -v sqlite3 >/dev/null 2>&1; then
  # Modo 1: sqlite3 en el host. .backup respeta el WAL y los locks.
  log "sqlite3 del host → $DEST"
  sqlite3 "$DB_FILE" ".backup '$DEST'"
elif command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  # Modo 2: better-sqlite3 dentro del contenedor de la API. Escribe en
  # /app/data/backups, que es el mismo directorio del host por el bind mount.
  log "better-sqlite3 dentro de $CONTAINER → $DEST"
  docker exec -i -e BACKUP_NAME="$NAME" "$CONTAINER" \
    sh -c 'cd /app/packages/db && node -' <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const source = process.env.AGENTOS_DB_PATH_ABS || "/app/data/agentos.db";
const dir = "/app/data/backups";
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, process.env.BACKUP_NAME);

const db = new Database(source, { readonly: true });
db.backup(dest)
  .then(() => {
    db.close();
    console.log("copia consistente en " + dest);
  })
  .catch((err) => {
    db.close();
    console.error(err);
    process.exit(1);
  });
NODE
else
  fail "no hay sqlite3 en el host ni contenedor '$CONTAINER' accesible"
fi

[ -s "$DEST" ] || fail "la copia $DEST quedó vacía"

# Verificación: una copia que no pasa integrity_check no cuenta como respaldo.
if command -v sqlite3 >/dev/null 2>&1; then
  RESULT="$(sqlite3 "$DEST" 'PRAGMA integrity_check;' | head -1)"
  [ "$RESULT" = "ok" ] || fail "integrity_check falló en $DEST: $RESULT"
  log "integrity_check: ok"
fi

gzip -9 -f "$DEST"
DEST="$DEST.gz"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$DEST")" >> SHA256SUMS )
fi
log "listo: $DEST ($(du -h "$DEST" | cut -f1))"

# Retención: se borran copias más viejas que N días, nunca la última que quede.
REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'agentos-*.db.gz' | wc -l)"
if [ "$REMAINING" -gt 1 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'agentos-*.db.gz' -mtime "+$RETENTION_DAYS" -print -delete
fi
log "retención: $RETENTION_DAYS días; quedan $(find "$BACKUP_DIR" -maxdepth 1 -name 'agentos-*.db.gz' | wc -l) copias"
