import { uuidv7 } from "uuidv7";

/**
 * Genera un ID nuevo para cualquier entidad (regla de portabilidad ARCHITECTURE §5):
 * uuidv7 TEXT — ordenable por tiempo, portable a Postgres sin cambios.
 */
export function newId(): string {
  return uuidv7();
}

export { uuidv7 };
