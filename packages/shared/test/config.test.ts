import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { ConfigError } from "../src/errors.ts";
import { loadConfig } from "../src/config.ts";

const key = () => randomBytes(32).toString("base64");
const validEnv = () => ({
  DATABASE_URL: "postgresql://user:pass@host/db?sslmode=require",
  CREDENTIALS_KEY: key(),
  SESSION_SECRET: key(),
});

describe("loadConfig", () => {
  it("parses a minimal valid environment with defaults filled", () => {
    const config = loadConfig(validEnv());
    expect(config.PORT).toBe(3000);
    expect(config.OLLAMA_MODEL).toBe("gemma4:31b-cloud");
    expect(config.OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("names every missing variable instead of a stack of undefined", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://nope" })).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("CREDENTIALS_KEY");
      expect(message).toContain("SESSION_SECRET");
    }
  });

  it("rejects a non-base64 credentials key", () => {
    expect(() => loadConfig({ ...validEnv(), CREDENTIALS_KEY: "not base64 at all" })).toThrow(/CREDENTIALS_KEY/);
  });

  it("coerces numeric strings and validates the port range", () => {
    expect(loadConfig({ ...validEnv(), PORT: "8080" }).PORT).toBe(8080);
    expect(() => loadConfig({ ...validEnv(), PORT: "99999" })).toThrow(/PORT/);
  });
});
