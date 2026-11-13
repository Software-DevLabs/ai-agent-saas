import { cn } from "@/lib/utils";

function initialsOf(name: string | undefined): string {
  const words = (name ?? "").split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return "··";
  return (words[0]![0]! + (words[1]?.[0] ?? words[0]![1] ?? "")).toUpperCase();
}

/**
 * Initials for a workspace or agent. Initials are decoration over the name the
 * row also renders, so the glyph itself is hidden from assistive tech.
 */
export function Avatar({
  name,
  size = "md",
  tone = "neutral",
  className,
}: {
  name: string | undefined;
  size?: "sm" | "md" | "lg";
  tone?: "neutral" | "brand";
  className?: string;
}) {
  const sizes = {
    sm: "h-6 w-6 text-meta",
    md: "h-8 w-8 text-caption",
    lg: "h-10 w-10 text-label",
  } as const;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium",
        sizes[size],
        tone === "brand" ? "bg-brand-green text-black" : "bg-fill text-muted-foreground shadow-inset",
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
