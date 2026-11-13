import { PrismaClient } from "@prisma/client";
import type { AppConfig } from "@saas/shared";

/**
 * One client per process. `log: ["warn","error"]` keeps Prisma's own noise
 * out of the structured stream; slow-query visibility is a Phase 8 concern.
 */
export function makeDb(config: Pick<AppConfig, "DATABASE_URL">): PrismaClient {
  return new PrismaClient({
    datasourceUrl: config.DATABASE_URL,
    log: ["warn", "error"],
  });
}

export type Db = PrismaClient;
