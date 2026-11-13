/**
 * Uploaded bytes in, chunkable text out.
 *
 * Only formats this build can read losslessly are accepted: plain text, markdown,
 * HTML, CSV. A PDF or DOCX is refused rather than stored as its own binary with a
 * guessed title — a document that indexes as zero chunks is the kind of failure that
 * hides for months, and a decoder that guesses is worse than no decoder. The refusal
 * names the formats that work, so the operator knows what to change.
 */

export const ACCEPTED_MIMES = ["text/plain", "text/markdown", "text/html", "text/csv"] as const;
export type AcceptedMime = (typeof ACCEPTED_MIMES)[number];

/** 400 000 characters is a very large document and still a bounded index job. */
export const MAX_DOC_CHARS = 400_000;

export type Decoded = { ok: true; text: string; mime: AcceptedMime; chars: number } | { ok: false; reason: string };

export function toPlainText(claimedMime: string, bytes: Uint8Array): Decoded {
  if (bytes.byteLength === 0) return { ok: false, reason: "the file is empty" };
  const raw = Buffer.from(bytes).toString("utf8");
  const mime = normalize(claimedMime, raw);
  if (mime === null) {
    return {
      ok: false,
      reason: `this build indexes ${ACCEPTED_MIMES.join(", ")} — a PDF or Word file has to be pasted as text or saved as one of those first`,
    };
  }
  const text = (mime === "text/html" ? htmlToText(raw) : raw.replace(/\r\n/g, "\n")).trim();
  if (text === "") {
    return { ok: false, reason: mime === "text/html" ? "that HTML has no visible text in it" : "there was no text to read in that file" };
  }
  if (text.length > MAX_DOC_CHARS) {
    return { ok: false, reason: `${text.length} characters is over the ${MAX_DOC_CHARS} limit for one document — split it rather than have it answered from half` };
  }
  return { ok: true, text, mime, chars: text.length };
}

/**
 * The MIME a browser reports is a *claim*, so a type this build does not know is
 * decided by the bytes: no NULs, few control characters, no replacement characters.
 * `application/octet-stream` is the browser's way of saying "I do not know", which
 * is exactly the case the bytes are for; a known binary type is refused by name.
 */
function normalize(claimed: string, raw: string): AcceptedMime | null {
  const base = claimed.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "text/markdown") return "text/markdown";
  if (base === "text/html") return "text/html";
  if (base === "text/csv") return "text/csv";
  if (base === "text/plain") return looksTextual(raw) ? "text/plain" : null;
  if (!SNIFFABLE.has(base) && !base.startsWith("text/")) return null;
  // A PDF header is printable, so its magic has to be read before the byte heuristic.
  if (raw.startsWith("%PDF-")) return null;
  if (!looksTextual(raw)) return null;
  return /<\s*(?:html|body|div|p|h[1-6]|ul|li|table|article)[\s>]/i.test(raw) ? "text/html" : "text/plain";
}

/** Types that carry no format of their own, so the only honest source is the bytes. */
const SNIFFABLE = new Set(["", "application/octet-stream", "binary/octet-stream"]);

function looksTextual(raw: string): boolean {
  const sample = raw.slice(0, 8000);
  const nul = String.fromCharCode(0);
  if (sample.includes(nul)) return false;
  const replacement = String.fromCharCode(0xfffd);
  const damaged = sample.split("").filter((character) => character === replacement).length;
  if (damaged / Math.max(1, sample.length) > 0.02) return false;
  let invisible = 0;
  for (const character of sample) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) invisible += 1;
  }
  return invisible / Math.max(1, sample.length) < 0.02;
}

/**
 * HTML to the text a visitor would have read. Tags go, block tags leave a line
 * break, and `script`/`style`/`noscript` are dropped whole — a stylesheet is not an
 * answer to a customer's question, and indexing it makes one look like the other.
 *
 * The result is *content*, not a security boundary: everything retrieved from a page
 * reaches the model as a tool message, and the output contract in `assemble.ts` is
 * what tells the model not to obey it.
 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
  const withBreaks = withoutScripts
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const text = withBreaks.replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The handful of entities that appear in real prose. A named-entity table is a dependency. */
export function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷" };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => codePoint(Number.parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, digits: string) => codePoint(Number.parseInt(digits, 10), whole))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 32 || value > 0x10_ff_ff) return fallback;
  return String.fromCodePoint(value);
}


