import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Table01Icon from "@hugeicons/core-free-icons/Table01Icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { useProjectIntegrations, useProjectSheets, usePushSheet, useSheet } from "@/lib/queries";
import type { SheetCell, SheetDetail, SheetRow } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

/**
 * The Sheets tab: tables an agent produced with `make_sheet`, rendered from the
 * rows the server stored.
 *
 * Nothing here composes or edits a sheet — the tool is the only writer, and the
 * count shown is the row count the write path recorded. CSV export is generated
 * from the same rows on screen, with formula-leading cells neutralized so a model
 * that wrote `=HYPERLINK(...)` hands the operator text rather than a live formula.
 */

const CSV_FORMULA = /^[=+\-@\t\r]/;

function csvCell(cell: SheetCell): string {
  let text = cell === null ? "" : String(cell);
  if (CSV_FORMULA.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sheetToCsv(columns: string[], rows: SheetRow[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((_, index) => csvCell(row.cells[index] ?? null)).join(","));
  return lines.join("\r\n");
}

function downloadCsv(detail: SheetDetail) {
  // The BOM is for Excel, which otherwise reads a UTF-8 CSV as the system codepage.
  const blob = new Blob([`\uFEFF${sheetToCsv(detail.columns, detail.rows)}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const slug = detail.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sheet";
  anchor.download = `${slug}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Cell({ value }: { value: SheetCell }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  if (typeof value === "number") {
    return <span className="font-mono text-[11.5px] tabular">{String(value)}</span>;
  }
  if (typeof value === "boolean") return <span className="font-mono text-[11.5px]">{String(value)}</span>;
  return <span className="whitespace-pre-wrap break-words">{value}</span>;
}

/**
 * The Google Sheets sink, as one explicit action on one sheet.
 *
 * The push appends the header and every stored row; it never deletes, edits or
 * reorders anything in the spreadsheet, and the in-app table is never touched by
 * an export. The last outcome is read from the sheet row, so a failed push is
 * still visible after a reload and is not confused with "never sent".
 */
function ExportCard({ detail, projectId }: { detail: SheetDetail; projectId: string }) {
  const integrations = useProjectIntegrations(projectId);
  const push = usePushSheet();
  const [picked, setPicked] = useState("");
  const [spreadsheet, setSpreadsheet] = useState("");
  const [tab, setTab] = useState("Sheet1");

  const connections = (integrations.data ?? []).filter(
    (entry) => entry.type === "SHEETS_OUT" && entry.status === "CONNECTED",
  );
  const chosen =
    picked !== "" && connections.some((entry) => entry.id === picked)
      ? picked
      : connections.length === 1
        ? connections[0]!.id
        : "";

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Push to Google Sheets</CardTitle>
          <CardDescription>
            Append the header and {detail.rowCount} row(s) to a spreadsheet. The table above stays the source of
            truth — a push copies it and never changes it.
          </CardDescription>
        </div>
        {detail.export.exportedAt !== null && (
          <Badge tone="success">pushed {formatDate(detail.export.exportedAt)}</Badge>
        )}
        {detail.export.error !== null && <Badge tone="danger">last push failed</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {integrations.isPending ? (
          <p className="text-[12px] text-muted-foreground">Checking this project's connections…</p>
        ) : connections.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            No connected Google Sheets connection in this project. Add one in Connections with an OAuth client JSON
            (<code className="font-mono">clientId</code>, <code className="font-mono">clientSecret</code>,{" "}
            <code className="font-mono">refreshToken</code>), then push this sheet.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Connection" htmlFor="sheet-export-connection">
                <Select
                  id="sheet-export-connection"
                  value={chosen}
                  onChange={(event) => setPicked(event.target.value)}
                  className="h-9 text-[12px]"
                >
                  {connections.length > 1 && <option value="">Choose a connection…</option>}
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.externalId ?? connection.credentialPreview ?? connection.id}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Spreadsheet"
                htmlFor="sheet-export-spreadsheet"
                hint="An id or a docs.google.com URL. Blank uses the connection's own spreadsheet."
              >
                <Input
                  id="sheet-export-spreadsheet"
                  value={spreadsheet}
                  placeholder="1AbC… or https://docs.google.com/spreadsheets/d/…"
                  onChange={(event) => setSpreadsheet(event.target.value)}
                />
              </Field>
              <Field label="Tab" htmlFor="sheet-export-tab" hint="Rows are appended below the existing content.">
                <Input
                  id="sheet-export-tab"
                  value={tab}
                  maxLength={100}
                  onChange={(event) => setTab(event.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={push.isPending}
                disabled={chosen === ""}
                onClick={() => {
                  push.mutate({
                    id: detail.id,
                    ...(chosen === "" ? {} : { integrationId: chosen }),
                    ...(spreadsheet.trim() === "" ? {} : { spreadsheetId: spreadsheet.trim() }),
                    ...(tab.trim() === "" ? {} : { sheetName: tab.trim() }),
                  });
                }}
              >
                <HugeiconsIcon icon={Table01Icon} size={14} strokeWidth={1.7} />
                {push.isPending ? "Pushing…" : `Append header + ${detail.rowCount} row(s)`}
              </Button>
              {detail.export.url !== null && (
                <a
                  href={detail.export.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] font-medium text-primary underline-offset-2 hover:underline"
                >
                  Open spreadsheet
                </a>
              )}
            </div>
          </>
        )}

        {detail.export.error !== null && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-destructive">
            {detail.export.error}
          </p>
        )}
        {push.data !== undefined && push.data !== null && push.isSuccess && (
          <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-[11.5px] leading-relaxed">
            Appended {push.data.rowsAppended} data row(s) to “{push.data.sheetName}” —{" "}
            <a href={push.data.url} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
              open the spreadsheet
            </a>
            .
          </p>
        )}
        {push.isError && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-destructive">
            {push.error instanceof Error ? push.error.message : "the push failed"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SheetDetailCard({ detail, projectId }: { detail: SheetDetail; projectId: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="truncate">{detail.title}</CardTitle>
            <CardDescription>
              Made by {detail.agentName} · {formatDate(detail.createdAt)} · {detail.columns.length} column(s),{" "}
              {detail.rowCount} row(s)
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => downloadCsv(detail)} disabled={detail.columns.length === 0}>
            <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={1.7} />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {detail.columns.length === 0 || detail.rows.length === 0 ? (
            <EmptyState
              title="This sheet has no rows"
              body="The agent created the sheet with headers but stored no rows. It is still here so the table it proposed is visible rather than silently missing."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="w-10 text-right">#</TH>
                  {detail.columns.map((column, index) => (
                    <TH key={index}>{column}</TH>
                  ))}
                </TR>
              </THead>
              <tbody>
                {detail.rows.map((row) => (
                  <TR key={row.rowIndex} className="align-top">
                    <TD className="text-right font-mono text-[11px] tabular text-muted-foreground">{row.rowIndex + 1}</TD>
                    {detail.columns.map((column, index) => (
                      <TD key={index} className="max-w-[360px] text-[12px] leading-relaxed">
                        <Cell value={row.cells[index] ?? null} />
                      </TD>
                    ))}
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
      <ExportCard key={detail.id} detail={detail} projectId={projectId} />
    </div>
  );
}

export function SheetsPanel({ projectId }: { projectId: string }) {
  const sheets = useProjectSheets(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = sheets.data?.sheets ?? [];
  const activeId = selectedId !== null && list.some((sheet) => sheet.id === selectedId) ? selectedId : (list[0]?.id ?? null);
  const detail = useSheet(activeId);

  return (
    <div className="space-y-4">
      <QueryState error={sheets.error} pending={sheets.isPending}>
        {list.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                title="No sheets yet"
                body="Give an agent the “Create a table (sheet)” capability, then ask it for a table. Every row it proposes is stored here, and the count on each sheet is read back from the database."
              />
            </CardContent>
          </Card>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Sheets</CardTitle>
                  <CardDescription>Newest first. Select one to read it.</CardDescription>
                </div>
                <Badge tone="neutral">{list.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {list.map((sheet) => (
                  <button
                    key={sheet.id}
                    type="button"
                    onClick={() => setSelectedId(sheet.id)}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      sheet.id === activeId
                        ? "border-primary/40 bg-fill-subtle"
                        : "border-border hover:bg-fill-subtle"
                    }`}
                  >
                    <p className="truncate text-[13px] font-medium">{sheet.title}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {sheet.rowCount} row(s) · {sheet.columns.length} col(s) · {sheet.agentName}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">{formatDate(sheet.createdAt)}</p>
                  </button>
                ))}
              </CardContent>
            </Card>

            <QueryState error={detail.error} pending={detail.isPending && activeId !== null}>
              {detail.data ? (
                <SheetDetailCard detail={detail.data} projectId={projectId} />
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <EmptyState title="Nothing selected" body="Pick a sheet on the left to read its rows." />
                  </CardContent>
                </Card>
              )}
            </QueryState>
          </div>
        )}
      </QueryState>

      <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
        <HugeiconsIcon icon={InformationCircleIcon} size={12} strokeWidth={1.7} className="mt-0.5 shrink-0" />
        make_sheet is a write tool the agent has to be granted. It re-validates every header and cell server-side and
        stores all rows or none: a table over 500 rows or 24 columns is refused rather than trimmed. The row count on
        each sheet is the number the insert wrote, not the number the agent said.
      </p>
    </div>
  );
}
