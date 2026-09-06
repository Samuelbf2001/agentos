/** Login del MVP: contraseña compartida + selector de persona del seed. */
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Person } from "../lib/types";
import { useStore } from "../state/store";
import { Spinner } from "../components/ui";

export default function LoginView() {
  const login = useStore((s) => s.login);
  const loginSandbox = useStore((s) => s.loginSandbox);
  const sandbox = useStore((s) => s.sandbox);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [personId, setPersonId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPeople() {
    setLoadError(null);
    try {
      const res = await api.people();
      setPeople(res.people);
      if (res.people[0]) setPersonId(res.people[0].id);
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : "No se pudo contactar la API en el puerto 4300",
      );
      setPeople([]);
    }
  }

  useEffect(() => {
    void loadPeople();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(password, personId);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "invalid_credentials"
            ? "Contraseña incorrecta"
            : `${err.code}: ${err.message}`
          : "Error de red",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSandboxLogin() {
    setError(null);
    setBusy(true);
    try {
      await loginSandbox(personId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Error de red");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-line-soft">
      <form
        onSubmit={onSubmit}
        className="w-96 rounded-panel border border-line bg-surface p-6 shadow-rest"
      >
        <h1 className="text-title font-bold">AgentOS — Sixteam</h1>
        <p className="mt-1 text-small text-muted">
          Contraseña compartida + persona del equipo (auth simple del MVP).
        </p>

        {sandbox ? (
          <p className="mt-3 rounded-tight border border-line bg-canvas-deep px-2.5 py-1.5 text-small text-muted">
            Entorno de pruebas: los datos son una copia y los cambios no llegan al sistema real.
          </p>
        ) : null}

        {people === null ? (
          <Spinner label="Cargando personas…" />
        ) : (
          <>
            <label className="mt-4 block text-small font-medium text-muted" htmlFor="person">
              ¿Quién eres?
            </label>
            <select
              id="person"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="mt-1 w-full rounded-tight border border-line px-2 py-1.5 text-body"
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                  {p.role ? ` — ${p.role}` : ""}
                </option>
              ))}
            </select>
            {loadError ? (
              <p className="mt-2 text-small text-broken">
                {loadError}{" "}
                <button type="button" onClick={() => void loadPeople()} className="underline">
                  reintentar
                </button>
              </p>
            ) : null}

            {sandbox ? (
              <button
                type="button"
                onClick={() => void onSandboxLogin()}
                disabled={busy || !personId}
                className="mt-3 w-full rounded-tight border border-line bg-surface py-2 text-body font-medium text-ink hover:bg-ink-2 hover:text-surface disabled:opacity-40"
              >
                Entrar sin contraseña
              </button>
            ) : null}

            <label className="mt-3 block text-small font-medium text-muted" htmlFor="password">
              Contraseña compartida
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-tight border border-line px-2 py-1.5 text-body"
              autoFocus
            />

            {error ? <p className="mt-2 text-small text-broken">{error}</p> : null}

            <button
              type="submit"
              disabled={busy || !personId || !password}
              className="mt-4 w-full rounded-tight bg-ink py-2 text-body font-medium text-surface hover:bg-ink-2 disabled:opacity-40"
            >
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
