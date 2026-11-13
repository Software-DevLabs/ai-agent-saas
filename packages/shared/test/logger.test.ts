import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";

function memorySink() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

describe("createLogger", () => {
  it("redacts secrets nested under any key, not just top level", () => {
    const sink = memorySink();
    const logger = createLogger({ LOG_LEVEL: "info", LOG_PRETTY: "0" }, sink);
    logger.info({ bot: { token: "SECRET123" }, credentialsEncrypted: "v1:k1:x:y", keep: "visible" }, "event");
    const printed = sink.lines.join("\n");
    expect(printed).not.toContain("SECRET123");
    expect(printed).not.toContain("v1:k1:x:y");
    expect(printed).toContain("visible");
    expect(printed).toContain("[redacted]");
  });

  it("redacts an api key and a refresh token in one line", () => {
    const sink = memorySink();
    const logger = createLogger({ LOG_LEVEL: "debug", LOG_PRETTY: "0" }, sink);
    logger.debug({ integration: { apiKey: "gsk_live_abc", refresh_token: "ya29.xyz" } });
    const printed = sink.lines.join("\n");
    expect(printed).not.toContain("gsk_live_abc");
    expect(printed).not.toContain("ya29.xyz");
  });

  it("honors LOG_LEVEL so debug lines never reach production output", () => {
    const sink = memorySink();
    const logger = createLogger({ LOG_LEVEL: "info", LOG_PRETTY: "0" }, sink);
    logger.debug({ noise: true });
    logger.info({ real: true });
    expect(sink.lines).toHaveLength(1);
  });
});
