/**
 * Roster de personas asignables a una tarea de un proyecto. Antes vivía
 * duplicado en la ficha y en el alta: el proyecto manda cuando la API dio su
 * roster (una tarea sólo admite responsables de la organización dueña del
 * proyecto); si no lo dio —servidor anterior o error— se vuelve al equipo
 * global más la persona de la sesión. Los responsables ya guardados se
 * conservan aunque no estén en el roster, para no esconder una asignación.
 */
import { useEffect, useMemo } from "react";
import { useStore } from "../state/store";
import type { Person } from "./types";

export function displayPersonName(person: { id: string; full_name?: string | null; fullName?: string | null }): string {
  return person.full_name || person.fullName || `Persona ${person.id.slice(0, 8)}`;
}

function sortByName(list: Person[]): Person[] {
  return [...list].sort((a, b) => displayPersonName(a).localeCompare(displayPersonName(b), "es"));
}

export interface ProjectRoster {
  people: Person[];
  loading: boolean;
  error: string | null;
  /** true cuando la lista sale del roster acotado al proyecto. */
  scoped: boolean;
  reload(): void;
}

/**
 * Carga (una vez por proyecto) el roster y devuelve las opciones ordenadas.
 * `extra` son personas que deben aparecer aunque no estén en el roster
 * (los responsables actuales de la tarea).
 */
export function useProjectRoster(projectId: string | null | undefined, extra: Person[] = []): ProjectRoster {
  const people = useStore((state) => state.people);
  const peopleLoading = useStore((state) => state.peopleLoading);
  const peopleError = useStore((state) => state.peopleError);
  const loadPeople = useStore((state) => state.loadPeople);
  const sessionPerson = useStore((state) => state.person);
  const projectPeople = useStore((state) => state.projectPeople);
  const projectPeopleId = useStore((state) => state.projectPeopleId);
  const loadProjectPeople = useStore((state) => state.loadProjectPeople);

  // Sin proyecto (diálogo cerrado) no se carga nada. El roster global sólo se
  // pide si aún no está: un roster vacío legítimo no reintenta en bucle.
  useEffect(() => {
    if (!projectId) return;
    if (projectPeopleId !== projectId) void loadProjectPeople(projectId);
    const snapshot = useStore.getState();
    if (snapshot.people.length === 0 && !snapshot.peopleLoading && !snapshot.peopleError) void snapshot.loadPeople();
  }, [projectId, projectPeopleId, loadProjectPeople]);

  const roster = projectId && projectPeopleId === projectId ? projectPeople : null;
  const extraKey = extra.map((person) => person.id).join("|");
  const options = useMemo(() => {
    const map = new Map<string, Person>();
    const base = roster ?? [...people, ...(sessionPerson ? [sessionPerson] : [])];
    for (const candidate of [...base, ...extra]) map.set(candidate.id, candidate);
    return sortByName([...map.values()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, people, sessionPerson, extraKey]);

  return {
    people: options,
    loading: peopleLoading,
    error: peopleError,
    scoped: roster !== null,
    reload: () => {
      void loadPeople();
      if (projectId) void loadProjectPeople(projectId);
    },
  };
}
