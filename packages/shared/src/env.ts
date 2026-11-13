import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads `.env` from the repo root without a dotenv dependency.
 * Walking up from cwd (and from this module) means the same call works
 * from the root, from a package script, or from a packaged binary.
 */
export function loadEnvFiles(): string[] {
  const loaded: string[] = [];
  const seen = new Set<string>();
  const bases = [process.cwd(), path.dirname(process.execPath)];
  for (const base of bases) {
    let dir = base;
    for (let depth = 0; depth < 6; depth++) {
      const file = path.join(dir, ".env");
      if (!seen.has(file) && existsSync(file)) {
        process.loadEnvFile(file);
        loaded.push(file);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return loaded;
}
