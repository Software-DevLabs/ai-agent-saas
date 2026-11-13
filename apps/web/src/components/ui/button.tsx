import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

/**
 * Reference buttons are pills. The primary fill is the inverse surface (white
 * on dark, near-black on light); everything else is a fill rung of the tint,
 * so a button composes on any card without its own border colour.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(100%_0_0/0.18)] hover:bg-primary/90",
  secondary: "bg-fill text-foreground shadow-inset hover:bg-fill-hover",
  outline: "bg-fill-subtle text-foreground shadow-inset hover:bg-fill-hover",
  ghost: "text-muted-foreground hover:bg-fill hover:text-foreground",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 rounded-full px-3 text-body-sm",
  md: "h-8 rounded-full px-3.5 text-body-sm",
  lg: "h-9 rounded-full px-4 text-body",
  icon: "h-8 w-8 rounded-full",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "outline", size = "md", loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 font-medium transition-[background,color,border-color,transform] duration-200 ease-calm active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <HugeiconsIcon icon={Loading03Icon} size={14} className="animate-spin" />}
      {children}
    </button>
  );
});
