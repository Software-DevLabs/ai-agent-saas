import { useCallback, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

/**
 * One theme, many readers. The topbar, the command palette and the user menu
 * each render a toggle, so the value cannot live in a single component's state:
 * two `useState` copies would disagree the moment one of them flipped the class.
 */
function read(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  // Dark is the console's default, like the reference studio; the toggle
  // persists a light preference once the user makes it.
  return "dark";
}

let current: Theme = read();
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("theme", theme);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTheme(theme: Theme) {
  if (theme === current) return;
  current = theme;
  apply(theme);
  for (const listener of listeners) listener();
}

apply(current);

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);
  const toggle = useCallback(() => setTheme(current === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}
