/** Setup jsdom: polyfills que @xyflow/react y dnd-kit esperan del navegador. */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom no implementa PointerEvent: sin él, `fireEvent.pointerDown` llega como
// Event plano (sin button ni clientX) y el tirador de la ficha no se entera.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
}

// jsdom no implementa scrollIntoView.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});
