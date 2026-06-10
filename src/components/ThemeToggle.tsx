"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

/**
 * Client island that flips `data-theme` on <html> and persists the choice to
 * localStorage under `slate-theme` — the same key the no-flash <head> script in
 * layout.tsx reads before first paint. Mounted by internal pages (Phase 3).
 *
 * The current theme is read from <html data-theme> via useSyncExternalStore so
 * the value is SSR-safe (server snapshot is always "light", matching the SSR
 * default) and never touches `document` during render.
 */

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("slate-theme", next);
    } catch {
      // localStorage may be unavailable (private mode); theme still flips for the session.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className="pn-btn pn-btn--small pn-btn--additional"
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
