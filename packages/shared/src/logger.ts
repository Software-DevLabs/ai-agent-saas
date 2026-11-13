import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.ts";

export type AppLogger = Logger;

interface LineSink {
  write(line: string): void;
}

/**
 * Redaction is a property of the logger, not a rule for callers: a route
 * that accidentally logs `req.body` with a bot token in it must still print
 * `[redacted]`. fast-redact resolves `*` one level deep, so every known
 * secret name is pinned at depths 0–3 rather than trusting a recursive glob.
 */
const SECRET_NAMES = [
  "token",
  "tokens",
  "refresh_token",
  "accessToken",
  "botToken",
  "apiKey",
  "api_key",
  "password",
  "passwordHash",
  "secret",
  "session_secret",
  "authorization",
  "credentials",
  "credentialsEncrypted",
];

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const name of SECRET_NAMES) {
    paths.push(name, `*.${name}`, `*.*.${name}`, `*.*.*.${name}`);
  }
  return paths;
}
export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "LOG_PRETTY">, sink?: LineSink): AppLogger {
  const options = {
    level: config.LOG_LEVEL,
    ...(config.LOG_PRETTY === "1" && !sink
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
      : {}),
    redact: {
      paths: redactPaths(),
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return sink ? pino(options, sink) : pino(options);
}
