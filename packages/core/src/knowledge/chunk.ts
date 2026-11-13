/**
 * Chunking: one document in, searchable pieces out.
 *
 * The rules are ported from the shape of Mastra's rag transformers — `maxSize` in
 * characters, a sentence-granular `overlap`, greedy grouping that flushes at 80 %
 * of the size, and never cutting inside a code fence or a table — not copied from
 * their code, and the class hierarchy is gone: a transformer per format, each with
 * its own options object, is a lot of machinery for one job. What is *not* ported is
 * the token counting and the LLM extractors. Counting tokens needs a tokenizer this
 * build does not ship, and an LLM that splits a document is a nondeterministic
 * indexer whose cost is unbilled. Both are replaced here by a character budget and a
 * stated estimate.
 *
 * Determinism is the property that matters. The same text must chunk the same way
 * twice, because a chunk id is what a run's tool step cites and a re-index that moved
 * the boundaries would make yesterday's recorded answer unexplainable.
 */

export type ChunkFormat = "markdown" | "plain" | "rows";

export interface ChunkDraft {
  seq: number;
  text: string;
  charCount: number;
  /** The heading the chunk sits under, when the document had headings. Kept as metadata *and* prefixed into `text`, so the index can find a chunk by the section it answers. */
  heading?: string;
}

export interface ChunkOptions {
  format?: ChunkFormat;
  maxSize?: number;
  overlap?: number;
}

/**
 * 1 400 characters is roughly 350 tokens of the models this build runs against, and
 * under `MAX_CHUNK_CHARS_RETURNED` in `search.ts` — so a hit reaches the model whole
 * rather than cut off mid-sentence.
 */
export const DEFAULT_MAX_SIZE = 1_400;
export const DEFAULT_OVERLAP = 200;
/** Below this, a piece is a fragment of the chunk before it, not a chunk. */
const MIN_USEFUL_SIZE = 80;

const SEPARATORS = ["\n\n", "\n", " ", ""] as const;
const SENTENCE_ENDERS = new Set([".", "!", "?"]);
/** Words that make a following capital look like a sentence start when it is not. */
const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd", "no"]);

export function chunkDocument(text: string, options: ChunkOptions = {}): ChunkDraft[] {
  const maxSize = Math.max(200, Math.trunc(options.maxSize ?? DEFAULT_MAX_SIZE));
  const overlap = Math.min(Math.max(0, Math.trunc(options.overlap ?? DEFAULT_OVERLAP)), maxSize - 1);
  const body = text.replace(/\r\n/g, "\n").replace(/\t/g, "    ").trim();
  if (body === "") return [];

  const format = options.format ?? guessFormat(body);
  const units =
    format === "rows" ? splitLines(body).map((line) => ({ text: line, heading: undefined as string | undefined }))
    : format === "markdown" ? markdownSections(body, maxSize)
    : [{ text: body, heading: undefined as string | undefined }];

  const drafts: ChunkDraft[] = [];
  for (const unit of units) {
    for (const piece of fill(unit.text, maxSize, overlap)) {
      const chunk = unit.heading === undefined ? piece : `${unit.heading}\n${piece}`;
      // A heading prefix can push a piece over budget on its own; the section is
      // already the smallest unit we have, so it goes in oversized rather than cut.
      if (chunk.trim() === "") continue;
      const previous = drafts[drafts.length - 1];
      if (previous !== undefined && previous.heading === unit.heading && previous.charCount + chunk.length + 1 <= maxSize) {
        previous.text = `${previous.text}\n${chunk}`;
        previous.charCount = previous.text.length;
        continue;
      }
      drafts.push({
        seq: drafts.length,
        text: chunk,
        charCount: chunk.length,
        ...(unit.heading === undefined ? {} : { heading: unit.heading }),
      });
    }
  }
  return renumber(dropFragments(drafts, maxSize));
}

/** A document with no markup but with delimited columns is read as rows, not prose. */
function guessFormat(body: string): ChunkFormat {
  const lines = splitLines(body);
  if (lines.some((line) => /^#{1,6}\s/.test(line))) return "markdown";
  const delimited = lines.filter((line) => (line.match(/[;,]/g) ?? []).length >= 1).length;
  return lines.length > 2 && delimited / lines.length > 0.6 ? "rows" : "plain";
}

/**
 * Markdown, split at headings, with the heading carried into its own chunks.
 *
 * Fenced code and table blocks are never cut: half a code sample retrieves badly and
 * misquotes the document. A block bigger than the budget is kept whole and marked,
 * because a chunk boundary inside a table is worse than an oversized chunk.
 */
function markdownSections(text: string, maxSize: number): { text: string; heading?: string }[] {
  const lines = splitLines(text);
  const out: { text: string; heading?: string }[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  let fenced = false;

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (body !== "") out.push({ text: body, ...(heading === undefined ? {} : { heading }) });
  };

  for (const line of lines) {
    const stripped = line.trim();
    if (isFence(stripped)) fenced = !fenced;
    const mark = fenced ? null : headingOf(stripped);
    if (mark !== null) {
      flush();
      heading = stripped;
      continue;
    }
    // A table or a fenced block is buffered whole; the heading still travels with it.
    buffer.push(line);
    if (!fenced && buffer.join("\n").length > maxSize * 3) flush();
  }
  flush();
  return out;
}

function isFence(stripped: string): boolean {
  return stripped.startsWith("```") || stripped.startsWith("~~~");
}

/** `#`-headings only — `startsWith` plus a space, so `#hashtag` in prose is not a title. */
function headingOf(stripped: string): string | null {
  if (!stripped.startsWith("#")) return null;
  const hashes = stripped.match(/^#{1,6}/);
  if (hashes === null) return null;
  const rest = stripped.slice(hashes[0].length);
  return rest === "" || rest.startsWith(" ") ? stripped : null;
}

/**
 * Greedy sentence packing with overlap.
 *
 * Fill until the next sentence would cross `maxSize`, emit, then carry the last
 * sentences back — enough to cover `overlap`, never so much that a chunk is only
 * the previous chunk's tail. A sentence too long for the budget falls back to
 * clauses, then words, then characters, which is the order a human would cut it in.
 *
 * Fenced code and table rows arrive as atomic units and are never sentence-split:
 * `markdownSections` buffers them whole, and this function must not undo that by
 * cutting at a `\n` inside the block.
 */
function fill(text: string, maxSize: number, overlap: number): string[] {
  const target = Math.floor(maxSize * 0.8);
  const units = fillUnits(text);
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;

  const emit = () => {
    const joined = current.join(" ").trim();
    if (joined !== "") chunks.push(joined);
    current = [];
    size = 0;
  };

  for (const unit of units) {
    if (unit.atomic) {
      if (current.length > 0) emit();
      // A block over the budget is a chunk of its own: cutting inside it is worse
      // than an oversized chunk, which is the rule the sectioner already applied.
      if (unit.text.length > maxSize) {
        chunks.push(unit.text);
        continue;
      }
      current = [unit.text];
      size = unit.text.length;
      continue;
    }
    const piece = unit.text.length > maxSize ? hardSplit(unit.text, maxSize) : [unit.text];
    for (const part of piece) {
      if (current.length > 0 && size + 1 + part.length > maxSize) {
        const carried = carry(current, overlap);
        emit();
        current = carried;
        size = carried.reduce((sum, entry) => sum + entry.length + 1, 0);
      }
      current.push(part);
      size += part.length + (current.length > 1 ? 1 : 0);
      if (size >= target) {
        const carried = carry(current, overlap);
        emit();
        current = carried;
        size = carried.reduce((sum, entry) => sum + entry.length + 1, 0);
      }
    }
  }
  emit();
  return chunks;
}

interface FillUnit {
  text: string;
  /** A fenced block or table run: kept as one piece whatever the budget says. */
  atomic: boolean;
}

/** Sentences, with fenced code and table lines lifted out as units that must stay whole. */
function fillUnits(text: string): FillUnit[] {
  const lines = text.split("\n");
  const units: FillUnit[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const body = prose.join("\n").trim();
    prose = [];
    if (body === "") return;
    for (const sentence of splitSentences(body)) units.push({ text: sentence, atomic: false });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const stripped = line.trim();
    if (isFence(stripped)) {
      flushProse();
      const block = [line];
      for (index += 1; index < lines.length; index += 1) {
        const inside = lines[index] as string;
        block.push(inside);
        if (isFence(inside.trim())) break;
      }
      units.push({ text: block.join("\n"), atomic: true });
      continue;
    }
    if (stripped.startsWith("|")) {
      flushProse();
      const block = [line];
      while (index + 1 < lines.length && (lines[index + 1] as string).trim().startsWith("|")) {
        index += 1;
        block.push(lines[index] as string);
      }
      units.push({ text: block.join("\n"), atomic: true });
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return units;
}

/** The tail of `sentences` that fits in `overlap`; empty when overlap is off. */
function carry(sentences: string[], overlap: number): string[] {
  if (overlap <= 0 || sentences.length <= 1) return [];
  const taken: string[] = [];
  let size = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index] as string;
    if (size + sentence.length + 1 > overlap) break;
    taken.unshift(sentence);
    size += sentence.length + 1;
  }
  // Never carry the whole chunk: that would emit it twice.
  return taken.length < sentences.length ? taken : taken.slice(1);
}

function hardSplit(sentence: string, maxSize: number): string[] {
  for (const separator of SEPARATORS) {
    if (separator === " ") {
      const words = sentence.split(" ").filter((word) => word !== "");
      if (words.length > 1) return pack(words, maxSize);
      continue;
    }
    const parts = sentence.split(separator).filter((part) => part.trim() !== "");
    if (parts.length > 1) return parts.map((part) => part.trim());
  }
  const pieces: string[] = [];
  for (let at = 0; at < sentence.length; at += maxSize) pieces.push(sentence.slice(at, at + maxSize));
  return pieces;
}

function pack(words: string[], maxSize: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current !== "" && `${current} ${word}`.length > maxSize) {
      out.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * Sentence boundaries, by walking rather than by one regex: a period is only an end
 * when what follows starts with a capital and the word before the period is not a
 * known abbreviation. `Dr. Smith answered.` must stay one sentence or the retrieval
 * quotes half of it.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buffer = "";
  const characters = [...text];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] as string;
    buffer += character;
    if (!SENTENCE_ENDERS.has(character)) continue;
    const rest = characters.slice(index + 1).join("");
    if (rest.trim() === "" || !/^\s+[A-Z]/.test(rest)) continue;
    const lastWord = buffer.trimEnd().slice(0, -1).split(/[\s(]/).pop() ?? "";
    if (ABBREVIATIONS.has(lastWord.toLowerCase().replace(/\.$/, ""))) continue;
    if (/^[A-Z](\.[A-Z])*$|^[A-Z]$/.test(lastWord)) continue;
    out.push(buffer.trim());
    buffer = "";
  }
  if (buffer.trim() !== "") out.push(buffer.trim());
  return out.filter((sentence) => sentence !== "");
}

/** A fragment is a piece of its neighbour, not an answer; join it back unless it is the only one. */
function dropFragments(drafts: ChunkDraft[], maxSize: number): ChunkDraft[] {
  if (drafts.length < 2) return drafts;
  const out: ChunkDraft[] = [];
  for (const draft of drafts) {
    const last = out[out.length - 1];
    // A merge across headings would file a section's text under the section above
    // it, and the heading is what retrieval quotes as the source.
    if (
      last !== undefined &&
      draft.heading === last.heading &&
      draft.charCount < MIN_USEFUL_SIZE &&
      last.charCount + draft.charCount + 1 <= maxSize * 1.5
    ) {
      last.text = `${last.text}\n${draft.text}`;
      last.charCount = last.text.length;
      continue;
    }
    out.push(draft);
  }
  return out;
}

function renumber(drafts: ChunkDraft[]): ChunkDraft[] {
  return drafts.map((draft, index) => ({ ...draft, seq: index }));
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * A character count, offered as an *estimate* of the model's token count rather than
 * a claim about it. This build has no tokenizer, and a number that looks like a token
 * count without being one is how a budget gets trusted and then fails.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
