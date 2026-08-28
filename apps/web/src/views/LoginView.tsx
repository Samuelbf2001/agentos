/** Login del MVP: contraseña compartida + selector de persona del seed. */
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Person } from "../lib/types";
import { useStore } from "../state/store";
import { Spinner } from "../components/ui";

export default function LoginView() {
  const login = useStore((s) => s.login);
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

  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <form
        onSubmit={onSubmit}
        className="w-96 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-bold">AgentOS — Sixteam</h1>
        <p className="mt-1 text-xs text-slate-500">
          Contraseña compartida + persona del equipo (auth simple del MVP).
        </p>

        {people === null ? (
          <Spinner label="Cargando personas…" />
        ) : (
          <>
            <label className="mt-4 block text-xs font-medium text-slate-600" htmlFor="person">
              ¿Quién eres?
            </label>
            <select
              id="person"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                  {p.role ? ` — ${p.role}` : ""}
                </option>
              ))}
            </select>
            {loadError ? (
              <p className="mt-2 text-xs text-rose-600">
                {loadError}{" "}
                <button type="button" onClick={() => void loadPeople()} className="underline">
                  reintentar
                </button>
              </p>
            ) : null}

            <label className="mt-3 block text-xs font-medium text-slate-600" htmlFor="password">
              Contraseña compartida
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              autoFocus
            />

            {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}

            <button
              type="submit"
              disabled={busy || !personId || !password}
              className="mt-4 w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
