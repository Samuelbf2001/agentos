/**
 * Método (PLAN-v1.5 §Navegación nueva): lo que Sixteam sabe hacer, que es de
 * Sixteam y no de ningún cliente. Hasta ahora vivía escondido en una pestaña
 * dentro del Contexto y en el Cerebro; es una de las cuatro entradas globales.
 *
 * Tres cosas: los módulos de fase que se pueden lanzar, las metodologías
 * versionadas que los agentes siguen, y las capacidades del sistema con la
 * fuente de la que dependen.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Markdown } from "../components/Markdown";
import { ActionButton, Card, Chip, SectionHead, STAGE_LABELS } from "../components/system";
import { EmptyState, ErrorBox, Spinner } from "../components/ui";
import { paths } from "../lib/paths";
import type { Methodology, ModuleSummary } from "../lib/types";

function PhaseModules() {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.modules();
        if (!cancelled) setModules(res.modules);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "No se pudieron cargar los módulos de fase");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (modules === null) return <Spinner label="Cargando módulos de fase…" />;
  if (modules.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay módulos de fase publicados"
        hint="Un módulo describe qué tareas nacen al arrancar una fase con un cliente. Se publican como datos versionados en modules/*.md."
      />
    );
  }

  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      {modules.map((m) => (
        <Card key={`${m.slug}@${m.version}`} className="p-4" data-testid={`asset-module-${m.slug}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-semibold text-ink">{m.name}</h3>
            <Chip tone="quiet">{STAGE_LABELS[m.phase]}</Chip>
            <span className="ml-auto text-small text-faint">v{m.version}</span>
          </div>
          <p className="mt-1.5 text-small text-muted">
            {m.templates_count} plantillas · metodología {m.methodology.slug} · proyectos de tipo{" "}
            {m.project_type}
          </p>
          <div className="mt-3">
            <ActionButton onClick={() => navigate(paths.nuevoProyecto({ modulo: m.slug }))}>
              Lanzar este módulo
            </ActionButton>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Methodologies() {
  const [items, setItems] = useState<Methodology[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Methodology | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.methodologies();
        if (cancelled) return;
        setItems(res.methodologies);
        setSelected(res.methodologies[0] ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "No se pudieron cargar las metodologías");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (items === null) return <Spinner label="Cargando metodologías…" />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="Todavía no hay metodologías publicadas"
        hint="La metodología de Sixteam vive como dato versionado que los agentes siguen al pie de la letra."
      />
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
      <ul className="grid content-start gap-1">
        {items.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => setSelected(m)}
              aria-pressed={selected?.id === m.id}
              className={`press w-full rounded-tight px-2.5 py-2 text-left text-small ${
                selected?.id === m.id ? "bg-canvas-deep font-semibold text-ink" : "text-muted hover:text-ink-2"
              }`}
            >
              {m.slug} <span className="text-faint">v{m.version}</span>
            </button>
          </li>
        ))}
      </ul>
      <Card className="min-w-0 p-4">
        {selected ? (
          <>
            <p className="text-label text-muted">
              {selected.slug} · versión {selected.version} · sólo lectura
            </p>
            <div className="mt-2 text-small">
              <Markdown>{selected.bodyMd}</Markdown>
            </div>
          </>
        ) : (
          <EmptyState title="Elige una metodología para leerla" />
        )}
      </Card>
    </div>
  );
}

export default function AssetView() {
  return (
    <div className="density-explorar mx-auto max-w-[1180px] px-4 pb-20 pt-6 sm:px-5">
      <h1 className="text-display text-ink">Método</h1>
      <p className="mt-1.5 max-w-[62ch] text-body text-muted">
        Lo que Sixteam sabe hacer: los módulos que arrancan una fase y las metodologías que siguen los
        agentes.
      </p>

      <SectionHead label="Módulos de fase" />
      <PhaseModules />

      <SectionHead label="Metodologías" />
      <Methodologies />
    </div>
  );
}
