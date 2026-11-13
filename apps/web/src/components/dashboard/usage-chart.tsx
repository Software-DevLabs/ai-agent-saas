import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { DailyPoint } from "@/lib/domain";
import { formatTokens } from "@/lib/utils";

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = { top: 14, right: 8, bottom: 22, left: 8 };

/**
 * Hand-rolled SVG instead of a chart library: one series, one gradient, and the
 * axis labels are the only text we need. Fewer dependencies, exact styling.
 */
export function UsageChart({ points, label = "tokens" }: { points: DailyPoint[]; label?: string }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) return null;

  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;
  const max = Math.max(...points.map((p) => p.tokens)) * 1.15;
  const x = (index: number) => PADDING.left + (index / (points.length - 1)) * innerW;
  const y = (value: number) => PADDING.top + innerH - (value / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${PADDING.top + innerH} L${x(0).toFixed(1)},${PADDING.top + innerH} Z`;

  const active = hover === null ? null : points[hover];
  const total = points.reduce((sum, point) => sum + point.tokens, 0);
  const peak = points.reduce((best, point) => (point.tokens > best.tokens ? point : best), points[0]!);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[200px] w-full"
        role="img"
        aria-label={`${label} per day over the last ${points.length} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const index = Math.round(ratio * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(var(--primary))" stopOpacity="0.22" />
            <stop offset="100%" stopColor="oklch(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={PADDING.top + innerH * (1 - fraction)}
            y2={PADDING.top + innerH * (1 - fraction)}
            stroke="oklch(var(--muted-foreground))"
            strokeOpacity="0.22"
            strokeDasharray="3 5"
          />
        ))}

        <motion.path
          d={area}
          fill="url(#usage-fill)"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        />
        <motion.path
          d={line}
          fill="none"
          stroke="oklch(var(--primary))"
          strokeWidth={1.6}
          strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />

        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              stroke="oklch(var(--muted-foreground))"
              strokeOpacity="0.35"
            />
            <circle cx={x(hover)} cy={y(points[hover]!.tokens)} r={3.5} fill="oklch(var(--card))" stroke="oklch(var(--primary))" strokeWidth={1.6} />
          </g>
        )}

        {points.map((p, i) =>
          i % 6 === 0 || i === points.length - 1 ? (
            <text
              key={p.date}
              x={x(i)}
              y={HEIGHT - 4}
              textAnchor="middle"
              className="fill-muted-foreground font-mono"
              style={{ fontSize: 9 }}
            >
              {p.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-pop"
          style={{ left: `${(x(hover ?? points.length - 1) / WIDTH) * 100}%`, transform: "translateX(-50%)" }}
        >
          <p className="font-mono text-[11px] text-muted-foreground">{active.date}</p>
          <p className="font-mono text-[13px] tabular">{formatTokens(active.tokens)} tokens</p>
          <p className="text-[11px] text-muted-foreground">{active.calls} calls</p>
        </div>
      )}

      <dl className="mt-2 grid grid-cols-3 divide-x divide-border border-t border-border pt-3">
        {[
          { label: "Total", value: formatTokens(total) },
          { label: "Daily average", value: formatTokens(Math.round(total / points.length)) },
          { label: "Peak day", value: `${peak.date.slice(5)} · ${formatTokens(peak.tokens)}` },
        ].map((row) => (
          <div key={row.label} className="px-1 first:pl-0">
            <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
            <dd className="mt-0.5 font-mono text-[13px] tabular">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
