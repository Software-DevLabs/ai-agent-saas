import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { EMBED_TURN_LANE, projectEmbedMessage, type Queue } from "@saas/core";
import { HttpError, badRequest, notFound } from "../http-error.ts";
import { assertEmbedServing, originAllowed, resolveEmbedByKey, type ResolvedEmbed } from "./resolve.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { hashVisitorIp } from "./resolve.ts";

/**
 * The public surface: three routes a stranger's browser may call, and nothing else.
 *
 * It is registered outside the console's tenant-scoped routes on purpose. There is
 * no session here and no `tenantId` in any body — a key resolves to a row, and that
 * row decides the tenant, the project, the agent, the origins and the budget. The
 * `Origin` gate is enforced before anything is read from the body, and the header
 * that makes a browser reveal the response is set only for an origin the row names.
 *
 * A turn is queued, not run here: the API answers 202 with an id, and the widget
 * polls until the worker's row says ANSWERED. That is the same split the rest of
 * the system uses, so a slow local model cannot hold an HTTP request open past
 * every proxy's timeout.
 */

const keyQuery = z.object({ key: z.string().min(16).max(200) });
const pollQuery = z.object({ key: z.string().min(16).max(200), session: z.string().min(8).max(64) });
const messageBody = z.object({
  sessionId: z.string().min(8).max(64),
  message: z.string().trim().min(1, "a message is required").max(2_000),
});

export interface EmbedApiDeps {
  db: PrismaClient;
  queue: Queue;
  limiter: RateLimiter;
  /** Mixed into the IP hash so the bucket keys are not reversible rainbow tables. */
  ipSalt: string;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("validation_failed", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), result.error.issues);
  }
  return result.data;
}

function corsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "origin" };
}

/**
 * Resolve, gate and decorate in one place, so no route can forget the order.
 * A refused origin leaves with no `access-control-allow-origin` header at all —
 * the browser then refuses to hand the body to the page, which is the actual
 * enforcement; the 403 is for a human reading curl output. The header is set
 * only after the allowlist says yes; setting it first and refusing later would
 * hand every refused page the header that makes its response readable.
 */
async function open(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: EmbedApiDeps,
  key: string,
): Promise<ResolvedEmbed> {
  const originHeader = request.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : null;
  const embed = await resolveEmbedByKey(deps.db, key);
  if (origin === null || !originAllowed(embed.origins, origin)) {
    // `vary` even on a refusal: a cache that stored this response must not reuse
    // it for another origin.
    reply.headers({ vary: "origin" });
    throw new HttpError(403, "embed_origin_denied", "this website is not allowed to use this widget", {
      origin: origin ?? null,
    });
  }
  reply.headers(corsHeaders(origin));
  return embed;
}

export function registerEmbedApi(app: FastifyInstance, deps: EmbedApiDeps): void {
  void app.register(
    async (scope) => {
      scope.get<{ Querystring: { key?: string } }>("/config", async (request, reply) => {
        const { key } = parse(keyQuery, request.query ?? {});
        const embed = await open(request, reply, deps, key);
        const ready = embed.status === "ACTIVE" && embed.agent.status === "ACTIVE";
        return {
          widget: embed.name,
          agent: embed.agent.name,
          // The widget renders its own copy; this only says whether to greet or
          // to say the assistant is unavailable.
          ready,
        };
      });

      scope.options<{ Querystring: { key?: string } }>("/message", async (request, reply) => {
        const parsed = keyQuery.safeParse(request.query ?? {});
        if (!parsed.success) return reply.status(204).headers({ vary: "origin" }).send();
        const originHeader = request.headers.origin;
        const origin = typeof originHeader === "string" ? originHeader : null;
        const embed = await resolveEmbedByKey(deps.db, parsed.data.key);
        if (origin === null || !originAllowed(embed.origins, origin)) {
          // No ACAO on purpose: the preflight fails in the browser, which is the point.
          return reply.status(403).headers({ vary: "origin" }).send({ error: "embed_origin_denied" });
        }
        return reply
          .status(204)
          .headers({
            ...corsHeaders(origin),
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "600",
          })
          .send();
      });

      scope.post<{ Querystring: { key?: string } }>("/message", async (request, reply) => {
        const { key } = parse(keyQuery, request.query ?? {});
        const embed = await open(request, reply, deps, key);
        assertEmbedServing(embed);

        // The bucket is checked before the body is parsed: the resource being
        // limited is requests reaching this endpoint, and refusing one should not
        // first spend JSON parsing on it. A malformed flood therefore drains the
        // same bucket a real visitor draws from — which is the point of a limit.
        const ipHash = hashVisitorIp(request.ip, deps.ipSalt);
        if (!(await deps.limiter.take(embed.id, ipHash))) {
          throw new HttpError(429, "embed_rate_limited", "too many messages from this address — wait a moment and try again");
        }

        const body = parse(messageBody, request.body ?? {});

        const created = await deps.db.embedMessage.create({
          data: {
            tenantId: embed.tenantId,
            embedId: embed.id,
            sessionId: body.sessionId,
            question: body.message,
            status: "PENDING",
          },
          select: { id: true },
        });

        try {
          await deps.queue.enqueue({
            lane: EMBED_TURN_LANE,
            tenantId: embed.tenantId,
            source: "embed",
            // One row per message id: a retried HTTP call must not pay twice.
            externalMessageId: `${embed.id}:${created.id}`,
            payload: { messageId: created.id },
            maxAttempts: 2,
          });
        } catch {
          // The visitor has a message id; the row says FAILED so the poll answers
          // something true instead of hanging on a job that was never queued.
          await deps.db.embedMessage.update({
            where: { id: created.id },
            data: { status: "FAILED", error: "the assistant could not be reached — try again in a moment" },
          });
          throw new HttpError(503, "embed_enqueue_failed", "the assistant is not accepting messages right now");
        }

        reply.status(202);
        return {
          messageId: created.id,
          status: "PENDING",
          poll: `/embed/v1/message/${created.id}`,
        };
      });

      scope.get<{ Params: { id: string }; Querystring: { key?: string; session?: string } }>(
        "/message/:id",
        async (request, reply) => {
          const { key, session } = parse(pollQuery, request.query ?? {});
          const embed = await open(request, reply, deps, key);
          // The session token is the visitor's own; requiring it means one visitor
          // cannot read another's answer by guessing a message id.
          const row = await deps.db.embedMessage.findFirst({
            where: { id: request.params.id, embedId: embed.id, sessionId: session },
            select: { id: true, status: true, answer: true, error: true, actions: true, citations: true },
          });
          if (row === null) throw notFound("embed_message_not_found", "no such message for this widget and session");
          return projectEmbedMessage(row);
        },
      );
    },
    { prefix: "/embed/v1" },
  );
}
