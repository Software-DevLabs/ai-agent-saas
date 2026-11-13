/**
 * HTML → the four things routing needs: a title, a description, an h1 and the
 * links that make up the rest of the crawl. No DOM parser, no headless browser:
 * a support site's pages are ordinary documents, and a dependency that renders
 * them would be a second runtime to keep alive for one regex pass.
 *
 * The extraction is deliberately lossy. A page is stored as text for summaries,
 * not as a searchable copy — knowledge documents are where page content belongs.
 */

export interface ExtractedPage {
  title: string;
  description: string;
  h1: string;
  text: string;
  /** Absolute http(s) links found on the page, with fragments removed. */
  links: string[];
}

/** What a page is *for*, when it says so: the h1, else the title, else its path. */
export function intentOf(extracted: Pick<ExtractedPage, "title" | "h1">, path: string): string {
  const chosen = extracted.h1.trim() !== "" ? extracted.h1 : extracted.title.trim() !== "" ? extracted.title : path;
  return clean(chosen).slice(0, 160);
}

/** A page's one-line summary: its own meta description, else the first of its text. */
export function summaryOf(extracted: Pick<ExtractedPage, "description" | "text">, path: string): string {
  const chosen = extracted.description.trim() !== "" ? extracted.description : extracted.text;
  return clean(chosen).slice(0, 280);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags whose closing boundary is a line break in the extracted text. */
const BLOCKS = /<\/(?:p|div|section|article|header|footer|main|aside|nav|li|tr|h[1-6]|table|ul|ol|blockquote|pre|figure)\s*>/gi;

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "));
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match === null ? null : (match[2] ?? match[3] ?? match[4] ?? "");
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  return match?.[1] === undefined ? "" : clean(stripTags(match[1]));
}

export function extractHtml(html: string, baseUrl: string): ExtractedPage {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|form)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const title = firstMatch(withoutNoise, /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const h1 = firstMatch(withoutNoise, /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  let description = "";
  for (const match of withoutNoise.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if ((attr(tag, "name") ?? "").toLowerCase() !== "description") continue;
    description = clean(decodeEntities(attr(tag, "content") ?? ""));
    break;
  }

  const base = new URL(baseUrl);
  const links: string[] = [];
  for (const match of withoutNoise.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(match[0], "href");
    if (href === null || href.trim() === "") continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      if (resolved.username !== "" || resolved.password !== "") continue;
      resolved.hash = "";
      links.push(resolved.toString());
    } catch {
      // A malformed href is a dead link on the operator's site, not a crawl error.
    }
  }

  const text = withoutNoise
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCKS, "\n")
    .replace(/<[^>]*>/g, " ");
  const lines = decodeEntities(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "");

  return {
    title: title.slice(0, 200),
    description: description.slice(0, 400),
    h1: h1.slice(0, 200),
    text: lines.join("\n").slice(0, 20_000),
    links: [...new Set(links)],
  };
}
