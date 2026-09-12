/**
 * Responsables humanos en la ficha: chips con el valor actual y, al abrir, la
 * lista compartida (`PeopleEditor`) con búsqueda, avatares, selección múltiple
 * y marca de principal. Guarda al cerrar el popover si cambió (`POST /assign`
 * con `expected_version`). El roster sale de `useProjectRoster`, el mismo que
 * usa el alta de tarea.
 */
import { useMemo, useState } from "react";
import { PersonAvatar } from "../../components/ui";
import { displayPersonName, useProjectRoster } from "../../lib/roster";
import { getTaskAssignees, taskAssigneeIsPrimary, taskAssigneePersonId, type Person, type Task } from "../../lib/types";
import { useStore } from "../../state/store";
import { PeopleEditor } from "./PeopleEditor";
import { PropertyRow, useInlineCommit } from "./PropertyRow";

function assignmentOf(task: Task): { ids: string[]; primary: string } {
  const assignees = getTaskAssignees(task);
  const ids = assignees.map(taskAssigneePersonId).filter((id): id is string => Boolean(id));
  const primary = assignees.find(taskAssigneeIsPrimary);
  return { ids, primary: primary ? taskAssigneePersonId(primary) ?? ids[0] ?? "" : ids[0] ?? "" };
}

function embeddedPeople(task: Task): Person[] {
  return getTaskAssignees(task).flatMap((assignee) => {
    if (!assignee.person) return [];
    return [{ ...assignee.person, full_name: displayPersonName(assignee.person), role: assignee.person.role ?? null }];
  });
}

export function PeoplePicker({ task }: { task: Task }) {
  const assignTaskPeople = useStore((state) => state.assignTaskPeople);
  const { open, setOpen, notice, commit } = useInlineCommit(task.id);
  const extra = useMemo(() => embeddedPeople(task), [task]);
  const roster = useProjectRoster(task.projectId, extra);
  const [ids, setIds] = useState<string[]>([]);
  const [primary, setPrimary] = useState("");

  const byId = useMemo(() => new Map(roster.people.map((person) => [person.id, person])), [roster.people]);
  const current = assignmentOf(task);

  function describeCurrent(): string {
    const latest = useStore.getState().taskDetail?.task ?? task;
    const names = assignmentOf(latest).ids.map((id) => (byId.get(id) ? displayPersonName(byId.get(id)!) : id));
    return names.length ? names.join(", ") : "nadie";
  }

  function handleOpenChange(value: boolean): void {
    if (value) {
      setIds(current.ids);
      setPrimary(current.primary);
      setOpen(true);
      return;
    }
    setOpen(false);
    const changed = ids.join("|") !== current.ids.join("|") || (primary || "") !== (current.primary || "");
    if (!changed) return;
    void commit(() => assignTaskPeople(task.id, ids, primary || null), describeCurrent);
  }

  const assigned = current.ids.map((id) => byId.get(id)).filter((person): person is Person => Boolean(person));

  return (
    <PropertyRow
      icon="◉"
      label="Asignado"
      testId="prop-assignees"
      open={open}
      onOpenChange={handleOpenChange}
      notice={notice}
      empty={current.ids.length === 0}
      popoverClassName="w-[min(92vw,22rem)]"
      editor={
        <PeopleEditor
          projectId={task.projectId}
          extra={extra}
          ids={ids}
          primary={primary}
          onChange={(nextIds, nextPrimary) => {
            setIds(nextIds);
            setPrimary(nextPrimary);
          }}
        />
      }
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {assigned.map((person) => (
          <span key={person.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface pl-0.5 pr-2 py-0.5 text-label font-medium text-ink-2">
            <PersonAvatar name={displayPersonName(person)} size={5} />
            <span className="max-w-[10rem] truncate">{displayPersonName(person)}</span>
            {current.primary === person.id && assigned.length > 1 ? <span className="text-faint" title="Principal">★</span> : null}
          </span>
        ))}
        {current.ids.filter((id) => !byId.has(id)).map((id) => (
          <span key={id} className="rounded-full border border-line bg-surface px-2 py-0.5 text-label text-muted">Persona {id.slice(0, 8)}</span>
        ))}
      </span>
    </PropertyRow>
  );
}
