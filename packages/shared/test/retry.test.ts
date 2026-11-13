import { describe, expect, it } from "vitest";
import { TransientError, UsageUnavailableError } from "../src/errors.ts";
import { withRetry } from "../src/retry.ts";

function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const { sleep, waits } = fakeSleep();
    const out = await withRetry(async () => "ok", { retries: 2, backoffMs: 100, sleep, random: () => 0.5 });
    expect(out).toBe("ok");
    expect(waits).toHaveLength(0);
  });

  it("retries transient failures and succeeds within budget", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientError("429");
        return "third-time-lucky";
      },
      { retries: 2, backoffMs: 100, sleep, random: () => 0.5 },
    );
    expect(out).toBe("third-time-lucky");
    expect(calls).toBe(3);
  });

  it("throws the last transient error once retries are spent", async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientError("boom");
        },
        { retries: 2, backoffMs: 100, sleep, random: () => 1 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[1]! > waits[0]!).toBe(true);
  });

  it("never retries a hard failure — a usage error is not a network blip", async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new UsageUnavailableError("no counts", "ollama");
        },
        { retries: 5, backoffMs: 100, sleep },
      ),
    ).rejects.toThrow(UsageUnavailableError);
    expect(calls).toBe(1);
    expect(waits).toHaveLength(0);
  });

  it("honors a retryAfterMs larger than the backoff curve", async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new TransientError("slow down", 4200);
        return "ok";
      },
      { retries: 2, backoffMs: 100, sleep, random: () => 0 },
    );
    expect(waits[0]).toBe(4200);
  });
});
