/**
 * Menú lateral del shell (estilo GoHighLevel/HubSpot): marca, selector de
 * perspectiva, navegación por grupos y pie con la persona y el estado de la
 * conexión en vivo. `groups` llega ya filtrado por capacidad (§App.tsx):
 * aquí sólo se pinta.
 */
import { ExternalLink, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { NavGroup, NavItem, Perspective } from "../../lib/nav";
import { useStore } from "../../state/store";
import { PersonAvatar } from "../ui";
import { PerspectiveSwitch } from "./PerspectiveSwitch";

function NavBadge({ count, tone }: { count: number; tone: "decide" | "broken" }) {
  if (count <= 0) return null;
  return (
    <span
      className={`ml-auto inline-flex min-w-4 items-center justify-center rounded-full px-1 text-label font-bold tabular-nums ${
        tone === "decide" ? "bg-decide text-surface" : "bg-broken text-surface"
      }`}
    >
      {count}
    </span>
  );
}

function isActive(item: Pick<NavItem, "to" | "match">, pathname: string): boolean {
  return item.match?.(pathname) ?? pathname.startsWith(item.to.split("?")[0] ?? item.to);
}

function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={16} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />;
}

function NavRow({
  item,
  active,
  badges,
  indent,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  badges: { decisions: number; failed: number };
  indent?: boolean;
  onNavigate?: () => void;
}) {
  const classes = `flex items-center gap-2.5 rounded-tight py-1.5 text-small font-medium ${
    indent ? "pl-9 pr-2.5" : "px-2.5"
  } ${active ? "bg-link-bg text-link" : "text-ink-2 hover:bg-canvas-deep"}`;

  const content = (
    <>
      <ItemIcon icon={item.icon} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge ? (
        <NavBadge count={badges[item.badge]} tone={item.badge === "decisions" ? "decide" : "broken"} />
      ) : null}
      {item.external ? (
        <ExternalLink size={12} className="shrink-0 text-faint" aria-hidden="true" />
      ) : null}
    </>
  );

  if (item.external) {
    return (
      <a href={item.to} target="_blank" rel="noreferrer" className={classes}>
        {content}
      </a>
    );
  }

  return (
    <NavLink
      to={item.to}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={() => classes}
    >
      {content}
    </NavLink>
  );
}

function NavGroupBlock({
  group,
  pathname,
  badges,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  badges: { decisions: number; failed: number };
  onNavigate?: () => void;
}) {
  return (
    <div className="mt-1 first:mt-0">
      {group.label ? (
        <div className="mt-3 px-2 text-label uppercase text-faint">{group.label}</div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        {group.items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <div key={item.id}>
              <NavRow item={item} active={active} badges={badges} onNavigate={onNavigate} />
              {item.children && active ? (
                <div className="flex flex-col gap-0.5">
                  {item.children.map((child) => (
                    <NavRow
                      key={child.id}
                      item={child}
                      active={isActive(child, pathname)}
                      badges={badges}
                      indent
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Sidebar({
  perspective,
  groups,
  badges,
  onNavigate,
}: {
  perspective: Perspective;
  groups: NavGroup[];
  badges: { decisions: number; failed: number };
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const person = useStore((s) => s.person);
  const sandbox = useStore((s) => s.sandbox);
  const wsStatus = useStore((s) => s.wsStatus);
  const logout = useStore((s) => s.logout);

  return (
    <aside className="flex h-full w-[248px] flex-col border-r border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-soft px-3 font-semibold tracking-tight">
        <span
          aria-hidden="true"
          className="block h-[22px] w-[22px] shrink-0 rounded-[7px] bg-gradient-to-br from-ink to-muted"
        />
        AgentOS
        {sandbox ? (
          <kbd
            title="Entorno de pruebas: copia de datos, sin efectos reales"
            className="rounded border border-line bg-canvas-deep px-1 font-sans text-label text-faint"
          >
            Pruebas
          </kbd>
        ) : null}
      </div>

      <PerspectiveSwitch perspective={perspective} onNavigate={onNavigate} />

      <nav aria-label="Navegación principal" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map((group) => (
          <NavGroupBlock
            key={group.id}
            group={group}
            pathname={location.pathname}
            badges={badges}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="border-t border-line-soft px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            title={
              wsStatus === "open"
                ? "Conexión en vivo"
                : wsStatus === "connecting"
                  ? "Conectando"
                  : "Sin conexión en vivo"
            }
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              wsStatus === "open" ? "bg-done" : wsStatus === "connecting" ? "bg-work" : "bg-broken"
            }`}
          />
          <PersonAvatar name={person?.full_name ?? "?"} size={6} />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-2">
            {person?.full_name}
          </span>
          <button onClick={logout} className="press shrink-0 text-label text-faint hover:text-muted">
            Salir
          </button>
        </div>
      </div>
    </aside>
  );
}
