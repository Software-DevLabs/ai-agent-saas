import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import type { Queue } from "@saas/core";
import { HttpError, badRequest, tooLarge } from "./http-error.ts";
import { addKnowledgeFile } from "./services/knowledge.ts";

/**
 * The upload half of knowledge, on its own encapsulated instance.
 *
 * A file is bigger than a JSON body, and that is the only reason it gets its own
 * scope: `createApp` sets a 1 MiB global `bodyLimit` because every other endpoint
 * takes a small document, and raising it for the whole API to let one upload through
 * would widen the surface of every route to fix a narrow one. Registering
 * `@fastify/multipart` inside `app.register(...)` hands the decorator, the parser and
 * the 8 MiB file cap to this route alone; everything outside the scope still answers
 * 413 at 1 MiB, which is what the test in `apps/api/test/knowledge.test.ts` asserts.
 *
 * `files: 1, fields: 1, parts: 2` is the other half of the same rule: one file plus an
 * optional title, so a request cannot park twenty streams in a process that has no
 * reason to hold them.
 */

/** 8 MiB of text is far more than `MAX_DOC_CHARS` can hold, so the file limit never decides alone. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const TOO_LARGE = new Set(["FST_REQ_FILE_TOO_LARGE", "FST_PARTS_LIMIT", "FST_FILES_LIMIT", "FST_FIELDS_LIMIT"]);

export interface UploadDeps {
  db: PrismaClient;
  queue: Queue;
  tenantId: string;
}

interface ReadFile {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  title?: string;
}

/** Reads the parts, refusing before anything is stored when the shape is wrong. */
async function readUpload(request: FastifyRequest): Promise<ReadFile> {
  let title: string | undefined;
  let file: ReadFile | null = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (file !== null) throw badRequest("knowledge_one_file", "one file per upload — send the rest as separate uploads");
        const buffer = await part.toBuffer();
        file = { filename: part.filename, mime: part.mimetype ?? "application/octet-stream", bytes: new Uint8Array(buffer) };
      } else if (part.fieldname === "title" && typeof part.value === "string") {
        title = part.value;
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw describe(error);
  }
  if (file === null) throw badRequest("knowledge_no_file", "the upload needs a file part");
  return title === undefined ? file : { ...file, title };
}

/**
 * A truncated upload is the failure an operator actually hits, and busboy reports it
 * mid-stream — so it is translated here rather than reaching the generic handler as a
 * 500 that says nothing about the size of the file.
 */
function describe(error: unknown): HttpError {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "the upload could not be read";
  if (TOO_LARGE.has(code)) {
    return tooLarge("knowledge_too_large", `that file is over the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit (${code})`);
  }
  if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
    return badRequest("knowledge_not_multipart", "send the file as multipart/form-data");
  }
  return badRequest("knowledge_upload_failed", message);
}

export function registerKnowledgeUpload(app: FastifyInstance, deps: UploadDeps): void {
  const { db, queue, tenantId } = deps;
  void app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2 } });
    scope.post<{ Params: { id: string } }>("/agents/:id/knowledge/upload", async (request, reply) => {
      const upload = await readUpload(request);
      const result = await addKnowledgeFile(db, queue, tenantId, request.params.id, upload);
      reply.status(201);
      return result;
    });
  });
}
