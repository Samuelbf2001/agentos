/**
 * ¿La pantalla es de celular? Alineado con el breakpoint `lg` de Tailwind
 * (1024px): por debajo de eso, `NotasView` cambia a la versión táctil
 * (Inicio/Revisar fotos/pestañas) en vez del lienzo + panel lateral de
 * escritorio. Escucha cambios (girar el celular, o una tableta que cruza el
 * breakpoint) y en un entorno sin `matchMedia` (jsdom en los tests) responde
 * siempre `false`, como escritorio.
 */
import { useEffect, useState } from "react";

const CONSULTA = "(max-width: 1023px)";

function celularAhora(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(CONSULTA).matches;
}

export function useEsCelular(): boolean {
  const [esCelular, setEsCelular] = useState(celularAhora);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(CONSULTA);
    const onChange = () => setEsCelular(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return esCelular;
}
