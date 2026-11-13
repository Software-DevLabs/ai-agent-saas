import type { ModelProvider, ProviderFactory } from "./types.ts";

/**
 * The provider registry.
 *
 * Duplicate registration is FATAL, not last-wins: a silent overwrite lets a
 * later module shadow an adapter that callers believe they resolved — the
 * billing effect is charging Gemini prices for Groq calls, or skipping the
 * validation one adapter does and the other does not. Same rule the guard
 * notes for tool maps: a collision must be loud at boot or it is quiet at
 * runtime, and quiet is what hurts.
 */

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (registry.has(name)) throw new Error(`provider "${name}" is already registered — refusing to shadow it`);
  registry.set(name, factory);
}

export function resolveProvider(name: string, deps: { config: import("./types.ts").ProviderConfig; log?: unknown }): ModelProvider {
  const factory = registry.get(name);
  if (!factory) {
    const known = [...registry.keys()].join(", ") || "none";
    throw new Error(`unknown provider "${name}" (registered: ${known})`);
  }
  return factory(deps);
}

export function registeredProviders(): string[] {
  return [...registry.keys()];
}

/** Test seam: wipe the registry so a test can prove the duplicate rule. */
export function __resetProviderRegistry(): void {
  registry.clear();
}
