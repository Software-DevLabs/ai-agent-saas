import { useEffect, useState } from "react";

/**
 * Whether the tab is actually on screen. Polling hooks multiply it into their
 * intervals, so a console left in a background tab stops asking the API for a
 * run's progress every second and resumes the moment it is focused again.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
