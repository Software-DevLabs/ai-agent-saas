import type { PrismaClient } from "@prisma/client";

/**
 * The token bucket a public widget needs, kept in Postgres.
 *
 * The queue already lives in Postgres (decision D7), and a rate limit that needs
 * Redis is a rate limit that is silently absent the day Redis is. One statement
 * both refills and spends: `ON CONFLICT` reads the previous timestamp, adds the
 * tokens the elapsed time earns, caps at the capacity and subtracts one — all
 * under a row lock, so two concurrent requests cannot both see the same balance.
 *
 * The `WHERE` on the upsert is the refusal: when the refilled balance is below
 * one, the update matches nothing and `RETURNING` comes back empty. A refusal does
 * not move `updatedAt` — moving it would throw away the refill the row earned —
 * it increments `rejected` instead, which is the number the console shows and the
 * verification script compares against the 429s it actually saw.
 */

export interface RatePolicy {
  capacity: number;
  refillPerMinute: number;
}

export const DEFAULT_RATE_POLICY: RatePolicy = { capacity: 20, refillPerMinute: 8 };

export interface RateLimiter {
  /** True means the call may proceed; false means this address is out of tokens. */
  take(embedId: string, ipHash: string): Promise<boolean>;
}

export function createPgRateLimiter(db: PrismaClient, policy: RatePolicy = DEFAULT_RATE_POLICY): RateLimiter {
  const refillPerSecond = policy.refillPerMinute / 60;
  return {
    async take(embedId, ipHash) {
      const rows = await db.$queryRaw<{ tokens: number }[]>`
        INSERT INTO "EmbedRate" ("embedId", "ipHash", "tokens", "rejected", "updatedAt")
        VALUES (${embedId}, ${ipHash}, ${policy.capacity - 1}, 0, now())
        ON CONFLICT ("embedId", "ipHash") DO UPDATE
        SET "tokens" = LEAST(
              ${policy.capacity}::double precision,
              "EmbedRate"."tokens" + EXTRACT(EPOCH FROM (now() - "EmbedRate"."updatedAt")) * ${refillPerSecond}
            ) - 1,
            "updatedAt" = now()
        WHERE LEAST(
              ${policy.capacity}::double precision,
              "EmbedRate"."tokens" + EXTRACT(EPOCH FROM (now() - "EmbedRate"."updatedAt")) * ${refillPerSecond}
            ) >= 1
        RETURNING "tokens"`;
      if (rows.length > 0) return true;
      // The bucket refused. The counter is best-effort: a failed counter write
      // must not turn a refusal into an allowed call.
      await db
        .$executeRaw`UPDATE "EmbedRate" SET "rejected" = "rejected" + 1 WHERE "embedId" = ${embedId} AND "ipHash" = ${ipHash}`
        .catch(() => undefined);
      return false;
    },
  };
}
