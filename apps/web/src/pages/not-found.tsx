import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <PageTransition>
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
          <HugeiconsIcon icon={AlertCircleIcon} size={18} strokeWidth={1.6} />
        </span>
        <h2 className="text-lg font-semibold">Nothing routed here</h2>
        <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          The console only knows the sections in the sidebar. A bad tenant id lands here rather than on an empty agent
          page.
        </p>
        <Link to="/">
          <Button variant="outline" size="sm" className="mt-2">
            Back to overview
          </Button>
        </Link>
      </div>
    </PageTransition>
  );
}
