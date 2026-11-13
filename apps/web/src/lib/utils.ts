import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `text-body-sm` and the rest of our type scale are font sizes, but
 * tailwind-merge cannot recognise an unregistered size and files it under text
 * colours — so the size that came after `text-primary-foreground` in a variant
 * overwrote the colour, and a primary button rendered its label in the fill of
 * its own background. Registering the scale keeps both.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "label",
            "menu",
            "body-sm",
            "body",
            "subheading",
            "heading",
            "title",
            "display",
            "column",
            "caption",
            "eyebrow",
            "meta",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent);
  // 99.72% must not print as 100% — a quota that rounds up reads as "full".
  if (Math.abs(percent - rounded) < 0.05) return `${rounded}%`;
  return `${percent.toFixed(1)}%`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * The console renders ids from API payloads that Prisma types as BigInt. A
 * number is friendlier in a table cell, but the string must survive a copy
 * into a request, so we keep both.
 */
export function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-3)}`;
}
