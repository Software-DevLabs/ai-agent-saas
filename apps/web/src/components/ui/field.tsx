import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const CONTROL =
  "w-full rounded-md bg-field px-2.5 text-body-sm text-foreground shadow-input transition-colors placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:bg-field-disabled disabled:opacity-70";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(CONTROL, "h-control-md", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(CONTROL, "min-h-28 resize-y py-2 leading-relaxed", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(CONTROL, "h-control-md appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-label text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-caption text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ease-calm shadow-inset disabled:opacity-50",
        checked ? "bg-success" : "bg-fill-active",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background-3 shadow-xs transition-transform duration-200 ease-calm",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-caption font-medium text-foreground/90">
          {label}
        </label>
        <span className="font-mono text-caption tabular text-muted-foreground">{value.toFixed(2)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
