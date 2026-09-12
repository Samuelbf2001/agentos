/**
 * Selector de responsables sin store: el mismo roster y la misma marca de
 * principal para la ficha (`PeoplePicker`, que guarda al cerrar el popover) y
 * para el alta de tarea (que sólo arma el borrador). La lógica de roster vive
 * una sola vez, en `useProjectRoster`.
 *
 * Dos formas de la MISMA lista:
 * - `rows`: filas con casilla, dentro del popover de la ficha.
 * - `chips`: fichas que se encienden al pulsarlas, para el formulario de alta
 *   ("sin checkboxes": en una ventana de alta la casilla es un control de más).
 */
import { useMemo, useState } from "react";
import { PopoverSearch } from "../../components/ui/InlinePopover";
import { PersonAvatar } from "../../components/ui";
import { displayPersonName, useProjectRoster } from "../../lib/roster";
import { normalizar } from "../../lib/tareas";
import type { Person } from "../../lib/types";

export interface PeopleEditorProps {
  projectId: string | null;
  /** Personas que deben aparecer aunque no estén en el roster (ya asignadas). */
  extra?: Person[];
  ids: string[];
  primary: string;
  onChange(ids: string[], primary: string): void;
  variant?: "rows" | "chips";
}

export function PeopleEditor({
  projectId,
  extra = [],
  ids,
  primary,
  onChange,
  variant = "rows",
}: PeopleEditorProps) {
  const roster = useProjectRoster(projectId, extra);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = normalizar(query);
    return roster.people.filter(
      (person) => !needle || normalizar(displayPersonName(person)).includes(needle),
    );
  }, [roster.people, query]);

  function toggle(personId: string, checked: boolean): void {
    const next = checked ? [...ids, personId] : ids.filter((id) => id !== personId);
    onChange(next, next.includes(primary) ? primary : next[0] ?? "");
  }

  const avisos = (
    <>
      {roster.loading ? <p className="px-2 py-1 text-small text-faint">Cargando equipo…</p> : null}
      {roster.error ? (
        <div
          className="mx-1 my-1 rounded-tight border border-work-line bg-work-bg p-2 text-label text-work"
          role="alert"
        >
          <p>{roster.error}</p>
          <button type="button" onClick={roster.reload} className="mt-1 font-semibold underline">
            Reintentar roster
          </button>
        </div>
      ) : null}
      {!roster.loading && roster.people.length === 0 ? (
        <p className="px-2 py-1 text-small text-work" data-testid="no-project-people">
          La organización de este proyecto no tiene personas registradas: una tarea sólo admite
          responsables de la organización dueña del proyecto.
        </p>
      ) : null}
    </>
  );

  if (variant === "chips") {
    return (
      <div data-testid="people-editor">
        {avisos}
        <div className="flex flex-wrap gap-1.5">
          {visible.map((person) => {
            const name = displayPersonName(person);
            const checked = ids.includes(person.id);
            return (
              <span key={person.id} className="inline-flex items-center">
                <button
                  type="button"
                  aria-pressed={checked}
                  data-testid={`person-chip-${person.id}`}
                  onClick={() => toggle(person.id, !checked)}
                  className={`press inline-flex min-h-9 items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-small focus:outline-none focus:ring-2 focus:ring-link ${
                    checked
                      ? "border-link bg-link-bg font-semibold text-link"
                      : "border-line bg-surface text-ink-2 hover:border-link"
                  }`}
                >
                  <PersonAvatar name={name} size={5} />
                  <span className="max-w-[10rem] truncate">{name}</span>
                </button>
                {checked && ids.length > 1 ? (
                  <button
                    type="button"
                    aria-pressed={primary === person.id}
                    aria-label={`Marcar a ${name} como responsable principal`}
                    title={primary === person.id ? "Responsable principal" : "Hacer principal"}
                    data-testid={`person-primary-${person.id}`}
                    onClick={() => onChange(ids, person.id)}
                    className={`press -ml-1 inline-flex min-h-9 min-w-9 items-center justify-center rounded-full text-small focus:outline-none focus:ring-2 focus:ring-link ${
                      primary === person.id ? "text-link" : "text-faint hover:text-muted"
                    }`}
                  >
                    <span aria-hidden="true">★</span>
                  </button>
                ) : null}
              </span>
            );
          })}
          {!roster.loading && roster.people.length > 0 && visible.length === 0 ? (
            <p className="px-1 py-1 text-small text-faint">Nadie coincide.</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PopoverSearch
        value={query}
        onChange={setQuery}
        label="Buscar persona"
        placeholder="Buscar persona…"
        testId="people-search"
      />
      {avisos}
      <div className="max-h-64 overflow-y-auto">
        {visible.map((person) => {
          const checked = ids.includes(person.id);
          const name = displayPersonName(person);
          return (
            <div key={person.id} className="flex min-h-10 items-center gap-2 rounded-tight px-2 hover:bg-surface-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => toggle(person.id, event.target.checked)}
                  className="h-4 w-4 rounded border-line text-ink focus:ring-link"
                />
                <PersonAvatar name={name} size={5} />
                <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">{name}</span>
              </label>
              {checked ? (
                <button
                  type="button"
                  aria-pressed={primary === person.id}
                  aria-label={`Marcar a ${name} como principal`}
                  onClick={() => onChange(ids, person.id)}
                  className={`min-h-8 rounded-tight px-1.5 text-label font-semibold focus:outline-none focus:ring-2 focus:ring-link ${
                    primary === person.id ? "text-link" : "text-faint hover:text-muted"
                  }`}
                >
                  {primary === person.id ? "principal" : "hacer principal"}
                </button>
              ) : null}
            </div>
          );
        })}
        {!roster.loading && roster.people.length > 0 && visible.length === 0 ? (
          <p className="px-2 py-1 text-small text-faint">Nadie coincide con «{query}».</p>
        ) : null}
      </div>
    </div>
  );
}

export default PeopleEditor;
