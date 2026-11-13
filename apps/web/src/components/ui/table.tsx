import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-body-sm", className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b text-left text-column text-muted-foreground">{children}</thead>
  );
}

/** A row is a real <tr>, so a row that acts as a button carries its own aria/keyboard props. */
export function TR({ children, className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("border-b transition-colors last:border-0 hover:bg-fill-subtle", className)} {...rest}>
      {children}
    </tr>
  );
}

export function TH({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("h-table-header px-3 py-0 font-medium", className)}>{children}</th>;
}

export function TD({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("h-table-row px-3 py-2 align-middle", className)}>{children}</td>;
}
