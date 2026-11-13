import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { chunkDocument, splitSentences } from "../src/knowledge/chunk.ts";
import { toPlainText } from "../src/knowledge/decode.ts";
import { snippetOf, vectorSearch, searchKnowledge, MIN_VECTOR_SIMILARITY, type SearchHit } from "../src/knowledge/search.ts";
import { formatHits, knowledgeSearchSpec, MAX_TOOL_RESULT_CHARS } from "../src/knowledge/tools.ts";

/**
 * The keyword path, tested where it is decided: bytes to text, text to chunks, chunks
 * to a ranked answer, and the answer to what the model reads.
 *
 * The assertions are about properties a customer would notice — a PDF refused instead
 * of silently storing nothing, a code block kept whole, "Dr." not ending a sentence —
 * rather than about the shape of the implementation, so the chunker can be tuned
 * without these becoming fiction.
 */

const sentence = (n: number) => `Rule ${n} says the customer account is credited within fourteen days of the return arriving at the depot.`;

describe("decode: bytes to text", () => {
  it("refuses a PDF rather than storing something that indexes as nothing", () => {
    const decoded = toPlainText("application/pdf", new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("text/plain");
  });

  it("decides an unknown text type by the bytes", () => {
    const html = toPlainText("application/octet-stream", Buffer.from("<html><body><p>Refunds take 14 days.</p></body></html>"));
    expect(html).toMatchObject({ ok: true, mime: "text/html", text: "Refunds take 14 days." });
  });

  it("drops script and style whole, because a stylesheet is not an answer", () => {
    const decoded = toPlainText(
      "text/html",
      Buffer.from("<h1>Shipping</h1><script>alert(1)</script><style>p{color:red}</style><p>Two to four days.</p>"),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.text).toContain("Shipping");
      expect(decoded.text).toContain("Two to four days.");
      expect(decoded.text).not.toContain("alert");
      expect(decoded.text).not.toContain("color:red");
    }
  });

  it("refuses binary claimed as text", () => {
    const bytes = new Uint8Array([0, 1, 2, 0, 4, 5]);
    expect(toPlainText("text/plain", bytes).ok).toBe(false);
  });

  it("refuses a document too large to index in one job", () => {
    const big = "a".repeat(400_001);
    const decoded = toPlainText("text/plain", Buffer.from(big));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain("400000");
  });
});

describe("chunking", () => {
  const prose = Array.from({ length: 20 }, (_, index) => sentence(index + 1)).join(" ");

  it("is deterministic: the same text chunks the same way twice", () => {
    expect(chunkDocument(prose)).toEqual(chunkDocument(prose));
  });

  it("keeps every piece inside the budget and loses no sentence", () => {
    const chunks = chunkDocument(prose, { maxSize: 600, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.charCount).toBeLessThanOrEqual(600);
    const joined = chunks.map((chunk) => chunk.text).join(" ");
    for (let n = 1; n <= 20; n += 1) expect(joined).toContain(`Rule ${n} says`);
  });

  it("numbers chunks from zero, in order", () => {
    const chunks = chunkDocument(prose, { maxSize: 600 });
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
  });

  it("never cuts inside a fenced code block, even when it exceeds the budget", () => {
    const code = [
      "```js",
      ...Array.from({ length: 40 }, (_, index) => `const value${index} = compute(${index});`),
      "```",
    ].join("\n");
    const chunks = chunkDocument(`# Deploy\n\nBefore you start.\n\n${code}\n\nAfter.`, { format: "markdown", maxSize: 300 });
    const fenced = chunks.filter((chunk) => chunk.text.includes("```"));
    expect(fenced).toHaveLength(1);
    expect(fenced[0]!.text).toContain("const value39 = compute(39);");
    expect(fenced[0]!.text).toContain("const value0 = compute(0);");
  });

  it("carries the heading into each of its chunks", () => {
    const chunks = chunkDocument(`# Refunds\n\n${prose.slice(0, 400)}\n\n# Shipping\n\nParcels leave the depot on weekdays.`, {
      format: "markdown",
      maxSize: 500,
    });
    expect(chunks[0]!.text.startsWith("# Refunds")).toBe(true);
    const shipping = chunks.find((chunk) => chunk.text.includes("Parcels leave"));
    expect(shipping?.text.startsWith("# Shipping")).toBe(true);
    expect(shipping?.heading).toBe("# Shipping");
  });

  it("keeps an abbreviation inside its sentence", () => {
    expect(splitSentences("Dr. Smith answered. Then he left.")).toEqual(["Dr. Smith answered.", "Then he left."]);
  });
});

describe("snippetOf", () => {
  it("windows the text around the first matched word, with ellipses", () => {
    const text = `${"filler ".repeat(60)}refund please${" filler".repeat(60)}`;
    const snippet = snippetOf(text, "refund", 120);
    expect(snippet).toContain("refund please");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(140);
  });

  it("falls back to the opening when the words do not match", () => {
    const snippet = snippetOf("The policy begins here and goes on.", "zebra", 40);
    expect(snippet.startsWith("The policy")).toBe(true);
  });
});

describe("what the model reads", () => {
  const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
    chunkId: "chunk_1",
    docId: "doc_1",
    seq: 2,
    title: "Refund policy",
    text: "Refunds are issued within 14 days.",
    snippet: "Refunds are issued…",
    score: 0.8774,
    backend: "keyword",
    ...over,
  });

  it("says NO_MATCHES in words, and forbids inventing an answer", () => {
    const text = formatHits("where do refunds go", [], "none");
    expect(text.startsWith("NO_MATCHES")).toBe(true);
    expect(text).toContain("do not invent");
  });

  it("names the source, the chunk and the score for each passage", () => {
    const text = formatHits("refunds", [hit()], "keyword");
    expect(text).toContain('KEYWORD retrieval — 1 passage(s) for "refunds"');
    expect(text).toContain('[1] "Refund policy" · chunk 3 of doc_1 (score 0.877)');
    expect(text).toContain("Refunds are issued within 14 days.");
  });

  it("leaves passages out rather than overflowing the turn, and says how many", () => {
    const big = Array.from({ length: 6 }, (_, index) =>
      hit({ chunkId: `c${index}`, docId: `d${index}`, text: "x".repeat(2_000) }),
    );
    const text = formatHits("refunds", big, "keyword");
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 200);
    expect(text).toMatch(/further passage\(s\) left out of the token budget/);
  });
});

describe("the knowledge_search tool", () => {
  it("refuses to be built when no document is granted, and says why", () => {
    const unmet: string[] = [];
    const built = knowledgeSearchSpec.build(
      { db: {} as PrismaClient, tenantId: "t1", agentId: "a1", skills: new Map(), knowledge: { docIds: [], titles: [] } },
      (why) => unmet.push(why),
    );
    expect(built).toBeNull();
    expect(unmet[0]).toContain("no indexed knowledge source");
  });

  it("asks the database for the assembled scope and formats what comes back", async () => {
    const queries: unknown[] = [];
    const db = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(values);
        return [
          { chunkId: "chunk_9", docId: "doc_9", seq: 0, title: "Terms", text: "Refunds take 14 days.", score: 0.5 },
        ];
      },
    } as unknown as PrismaClient;
    const built = knowledgeSearchSpec.build(
      {
        db,
        tenantId: "t1",
        agentId: "a1",
        skills: new Map(),
        knowledge: { docIds: ["doc_9"], titles: ["Terms"] },
      },
      () => undefined,
    );
    expect(built).not.toBeNull();
    const result = await built!.execute({ query: "refunds" });
    expect(result).toContain('"Terms"');
    expect(result).toContain("Refunds take 14 days.");
    // The tenant and the document list are bound parameters, not interpolated text.
    const bound = queries[0] as unknown[];
    expect(bound).toContain("t1");
    expect(bound).toContainEqual(["doc_9"]);
  });

  it("rejects a blank query without touching the database", async () => {
    let called = 0;
    const db = { $queryRaw: async () => { called += 1; return []; } } as unknown as PrismaClient;
    const built = knowledgeSearchSpec.build(
      { db, tenantId: "t1", agentId: "a1", skills: new Map(), knowledge: { docIds: ["doc_1"], titles: ["T"] } },
      () => undefined,
    );
    const result = await built!.execute({ query: "   " });
    expect(result).toContain("TOOL_ERROR");
    expect(called).toBe(0);
  });
});

describe("vector retrieval", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    chunkId: "chunk_9",
    docId: "doc_9",
    seq: 0,
    title: "Terms",
    text: "Refunds take 14 days.",
    score: 0.82,
    ...over,
  });

  /**
   * A `$queryRaw` double that answers by statement: the vector statement is
   * recognised by its table, so a test can say what each engine would have found.
   */
  function fakeDb(found: { vector?: unknown[]; keyword?: unknown[] }) {
    const seen: { sql: string; values: unknown[] }[] = [];
    const db = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        seen.push({ sql, values });
        return (sql.includes("KnowledgeChunkEmbedding") ? found.vector : found.keyword) ?? [];
      },
    } as unknown as PrismaClient;
    return { db, seen };
  }

  const query = { vector: [0.1, 0.2, 0.3], model: "nomic-embed-text", dim: 3 };

  it("binds the tenant, the scope, the model, the dim and the literal — and reports backend:vector", async () => {
    const { db, seen } = fakeDb({ vector: [row()] });
    const found = await searchKnowledge(db, { tenantId: "t1", docIds: ["doc_9"] }, "refunds", query);
    expect(found.backend).toBe("vector");
    expect(found.hits[0]!.snippet).toContain("Refunds take 14 days.");
    const values = seen[0]!.values;
    expect(values).toContain("t1");
    expect(values).toContainEqual(["doc_9"]);
    expect(values).toContain("nomic-embed-text");
    expect(values).toContain(3);
    expect(values).toContain("[0.1,0.2,0.3]");
    expect(seen).toHaveLength(1);
  });

  it("drops noise below the similarity floor instead of answering with something", async () => {
    const { db } = fakeDb({ vector: [row({ score: MIN_VECTOR_SIMILARITY - 0.01 })], keyword: [] });
    expect(await vectorSearch(db, { tenantId: "t1", docIds: ["doc_9"] }, query)).toEqual([]);
  });

  it("falls back to keyword when nothing clears the floor, and says keyword answered", async () => {
    const { db, seen } = fakeDb({ vector: [row({ score: 0.1 })], keyword: [row({ score: 0.4 })] });
    const found = await searchKnowledge(db, { tenantId: "t1", docIds: ["doc_9"] }, "refunds", query);
    expect(found.backend).toBe("keyword");
    expect(found.hits).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it("reports none — not a silent empty vector search — when neither engine matched", async () => {
    const { db } = fakeDb({ vector: [row({ score: 0.1 })], keyword: [] });
    const found = await searchKnowledge(db, { tenantId: "t1", docIds: ["doc_9"] }, "zebra", query);
    expect(found).toEqual({ hits: [], backend: "none" });
  });

  it("refuses a truncated vector rather than letting Postgres compare two dimensions", async () => {
    const { db, seen } = fakeDb({ vector: [row()] });
    expect(await vectorSearch(db, { tenantId: "t1", docIds: ["doc_9"] }, { ...query, dim: 768 })).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("degrades to keyword when the embedder throws, and the result names the engine that answered", async () => {
    const { db, seen } = fakeDb({ keyword: [row({ score: 0.5 })] });
    const built = knowledgeSearchSpec.build(
      {
        db,
        tenantId: "t1",
        agentId: "a1",
        skills: new Map(),
        knowledge: { docIds: ["doc_9"], titles: ["Terms"] },
        embed: async () => {
          throw new Error("ollama is down");
        },
      },
      () => undefined,
    );
    const result = await built!.execute({ query: "refunds" });
    expect(result).toContain("KEYWORD retrieval");
    expect(result).not.toContain("TOOL_ERROR");
    expect(seen.every((entry) => !entry.sql.includes("KnowledgeChunkEmbedding"))).toBe(true);
  });

  it("uses the vector when the embedder answers, so the same tool has one behaviour per world state", async () => {
    const { db } = fakeDb({ vector: [row()], keyword: [row({ score: 0.2 })] });
    const built = knowledgeSearchSpec.build(
      {
        db,
        tenantId: "t1",
        agentId: "a1",
        skills: new Map(),
        knowledge: { docIds: ["doc_9"], titles: ["Terms"] },
        embed: async () => query,
      },
      () => undefined,
    );
    const result = await built!.execute({ query: "refunds" });
    expect(result).toContain("VECTOR retrieval");
  });
});
