import { fileURLToPath } from "node:url";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Static serving for one thing only: the widget bundle a visitor's page loads.
 *
 * It lives under its own prefix rather than at `/` because the console's client
 * routes and the API's resource routes are the same paths — `/agents/:id` is a
 * page and a REST resource — so mounting the built console here would make one
 * of the two answer first. The console is served by Vite in development and by
 * whatever hosts `apps/web/dist` in production; the widget has no such second
 * home, and its `<script src>` must come from the origin that will answer it.
 */

export interface EmbedBundleInfo {
  /** Whether a bundle exists at all — a console that offers a snippet says so. */
  served: boolean;
  /** Path inside the static root, e.g. `v1a2b3c4/embed.js`. */
  file: string;
  /** True when the build wrote a content-addressed path, which is what makes immutable caching honest. */
  versioned: boolean;
  note: string;
}

export interface EmbedServing {
  served: boolean;
  root: string;
  /** Why the bundle is missing, or what was mounted. Logged, never swallowed. */
  note: string;
}

/** `<repo>/apps/web/dist/embed`, resolved from this module rather than the cwd. */
export function defaultEmbedRoot(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../apps/web/dist/embed");
}

/**
 * The build stamps a manifest naming a content-addressed file. Reading it here
 * rather than guessing `embed.js` is what lets the snippet point at a URL whose
 * bytes can never change — the only condition under which a year of immutable
 * caching is true.
 */
export async function inspectEmbedBundle(root: string): Promise<EmbedBundleInfo> {
  try {
    const raw = await readFile(path.join(root, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { file?: unknown };
    if (typeof parsed.file === "string" && parsed.file !== "") {
      await access(path.join(root, parsed.file));
      return { served: true, file: parsed.file, versioned: true, note: `serving ${parsed.file}` };
    }
  } catch {
    // No manifest (or an unreadable one): fall through to the plain entry.
  }
  try {
    await access(path.join(root, "embed.js"));
    return { served: true, file: "embed.js", versioned: false, note: "serving embed.js — rebuild to get a versioned manifest" };
  } catch {
    return {
      served: false,
      file: "embed.js",
      versioned: false,
      note: "no embed.js here — build it with `pnpm --filter @saas/web build:embed`",
    };
  }
}

export async function serveEmbedBundle(
  app: FastifyInstance,
  root: string,
  opts: { immutable: boolean },
): Promise<EmbedServing> {
  const info = await inspectEmbedBundle(root);
  if (!info.served) return { served: false, root, note: info.note };

  await app.register(fastifyStatic, {
    root,
    prefix: "/embed/",
    // No directory index: `/embed/` must 404 rather than hand back a file
    // listing or whatever happens to be named index.html.
    index: false,
    setHeaders: (res) => {
      // Not immutable in development: a reload would otherwise keep serving a
      // widget nobody asked for. In production `dist/embed` is written by the
      // build that is deployed, so a file it names cannot change under a running
      // process and a year of freshness is the truth. The snippet carries a
      // versioned path anyway, so a release moves the URL rather than waiting on
      // somebody's cache.
      res.setHeader("cache-control", opts.immutable ? "public, max-age=31536000, immutable" : "no-store");
    },
  });

  return { served: true, root, note: `mounted at /embed/ — ${info.note}` };
}
