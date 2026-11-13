import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import ExternalLinkIcon from "@hugeicons/core-free-icons/ExternalLinkIcon";
import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import InfoIcon from "@hugeicons/core-free-icons/InfoIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import { ApiError } from "@/lib/api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { useAgentSite, useDeleteAgentSite, useSaveAgentSite } from "@/lib/queries";
import type { AgentSite, SiteCrawlStatus } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

/**
 * The site tab: the crawl that gives `find_page` something true to offer.
 *
 * A URL typed here is not a hint to the model — it is a job. The crawl writes the
 * page rows, and those rows are the only URLs the server will ever let leave as a
 * routing button. `status` and `error` are the worker's own columns, so "why does
 * it not know my login page" is answered by the row rather than guessed at.
 */

const STATUS_LOOK: Record<SiteCrawlStatus, { tone: Tone; dot: StatusTone; label: string }> = {
  PENDING: { tone: "neutral", dot: "neutral", label: "Queued" },
  CRAWLING: { tone: "info", dot: "active", label: "Crawling" },
  READY: { tone: "success", dot: "success", label: "Ready" },
  FAILED: { tone: "danger", dot: "danger", label: "Failed" },
};

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive">
      <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
      {reason(error)}
    </p>
  );
}

function SiteHeader({ site }: { site: AgentSite }) {
  const look = STATUS_LOOK[site.status];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-muted-foreground">
      <Badge tone={look.tone}>
        <StatusDot tone={look.dot} pulse={site.status === "CRAWLING"} />
        {look.label}
      </Badge>
      <a
        href={site.rootUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 font-mono text-[11.5px] text-foreground underline-offset-2 hover:underline"
      >
        {site.host}
        <HugeiconsIcon icon={ExternalLinkIcon} size={12} strokeWidth={1.6} />
      </a>
      <span>{site.pageCount} page{site.pageCount === 1 ? "" : "s"}</span>
      <span>{site.crawledAt === null ? "never crawled" : `crawled ${formatDate(site.crawledAt)}`}</span>
      {site.manualUrls.length > 0 && <span>{site.manualUrls.length} manual page{site.manualUrls.length === 1 ? "" : "s"}</span>}
    </div>
  );
}

export function SitePanel({ agentId }: { agentId: string }) {
  const site = useAgentSite(agentId);
  const save = useSaveAgentSite(agentId);
  const remove = useDeleteAgentSite(agentId);

  const [rootUrl, setRootUrl] = useState("");
  const [manual, setManual] = useState("");
  const [last, setLast] = useState<{ queued: boolean; queue: string } | null>(null);

  const current = site.data ?? null;
  const crawling = current !== null && (current.status === "CRAWLING" || current.status === "PENDING");

  const submit = () => {
    const manualUrls = manual
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    save.mutate(
      { rootUrl: rootUrl.trim(), manualUrls },
      {
        onSuccess: (saved) => {
          setLast({ queued: saved.queued, queue: saved.queue });
          setManual("");
        },
      },
    );
  };

  const beginEdit = () => {
    if (current === null) return;
    setRootUrl(current.rootUrl);
    setManual(current.manualUrls.join("\n"));
  };

  return (
    <QueryState error={site.error} pending={site.isPending}>
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Globe02Icon} size={15} strokeWidth={1.6} />
                Website
              </CardTitle>
              <CardDescription>
                The crawl that feeds page routing. Saving queues a fresh crawl; only a finished crawl is offered to
                the model, and every button it can emit points at a page from this list.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => void site.refetch()}>
                <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.6} />
                Refresh
              </Button>
              {current !== null && (
                <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
                  <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.6} />
                  Remove site
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {current === null ? (
              <EmptyState
                title="No site yet"
                body="Give this agent the root URL of your website. It will crawl same-host pages, obey robots.txt, and use the result to send visitors to the right page."
              />
            ) : (
              <>
                <SiteHeader site={current} />
                {current.error !== null && (
                  <p className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] leading-relaxed text-destructive">
                    <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
                    {current.error}
                  </p>
                )}
                {current.status === "READY" && current.pages.length === 0 && (
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    The crawl finished with no pages — try a root URL that answers with HTML.
                  </p>
                )}
              </>
            )}
            <Problem error={remove.error} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Globe02Icon} size={15} strokeWidth={1.6} />
                {current === null ? "Crawl a site" : "Re-crawl this site"}
              </CardTitle>
              <CardDescription>
                The root URL and, optionally, pages the crawl may not reach by following links. Every manual page
                must share the root host. Saving replaces the page list whole once the crawl finishes.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Root URL" hint="http or https. Private and reserved addresses are refused unless the crawler was started with SITE_ALLOW_PRIVATE_IPS=1.">
              <Input
                value={rootUrl}
                onChange={(event) => setRootUrl(event.target.value)}
                placeholder="https://shop.example"
                aria-label="Site root URL"
                className="max-w-md"
              />
            </Field>
            <Field label="Manual pages" hint="One URL per line. Relative paths are resolved against the root: /login is enough.">
              <Textarea
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                placeholder={"/login\n/pricing\nhttps://shop.example/help"}
                aria-label="Manual page URLs"
                className="min-h-24 max-w-md font-mono text-[12px]"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              {current !== null && (
                <Button variant="ghost" size="sm" onClick={beginEdit}>
                  Use current URLs
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={rootUrl.trim() === "" || crawling}
                loading={save.isPending}
                onClick={submit}
              >
                Save and crawl
              </Button>
              {crawling && (
                <span className="text-[11.5px] text-muted-foreground">
                  a crawl is running; the form unlocks when it finishes
                </span>
              )}
            </div>
            <Problem error={save.error} />
            {last !== null && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] leading-relaxed">
                <HugeiconsIcon icon={InfoIcon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
                <span>
                  {last.queued ? "Crawl queued." : "Nothing new was queued."} Queue: {last.queue}. The status above
                  refreshes while the worker holds the job.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {current !== null && current.pages.length > 0 && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={Globe02Icon} size={15} strokeWidth={1.6} />
                  Pages the agent may offer
                </CardTitle>
                <CardDescription>
                  Exactly the rows `find_page` can route to. A URL the model invents that is not in this table is
                  refused by the server and recorded as a failed tool call.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Path</TH>
                      <TH>Page</TH>
                      <TH>Intent</TH>
                      <TH className="text-right">Open</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {current.pages.map((page) => (
                      <TR key={page.url}>
                        <TD className="whitespace-nowrap font-mono text-[11.5px]">{page.path}</TD>
                        <TD>
                          <p className="text-[12.5px] font-medium">{page.title}</p>
                          {page.summary !== "" && (
                            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{page.summary}</p>
                          )}
                        </TD>
                        <TD className="max-w-56 text-[11.5px] leading-relaxed text-muted-foreground">{page.intent}</TD>
                        <TD className="whitespace-nowrap text-right">
                          <a
                            href={page.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            visit
                            <HugeiconsIcon icon={ExternalLinkIcon} size={12} strokeWidth={1.6} />
                          </a>
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
                {current.pages.length} page{current.pages.length === 1 ? "" : "s"} indexed from {current.host}. The
                crawl stays on this host, obeys robots.txt, and reads at most a few dozen pages per run.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </QueryState>
  );
}
