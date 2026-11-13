import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The widget's own build: one IIFE, one CSS string inlined, no shared chunks.
 *
 * It is a second config rather than a second entry in the console build because
 * the two have opposite goals. The console wants vendor chunking and React; the
 * widget wants a single file under 40 kB that a stranger's page can load with
 * one tag, and any shared chunk would be a second request that tag does not make.
 *
 * `stampBundle` turns the output into what the snippet contract promises: a
 * content-addressed `v<sha8>/embed.js` and a manifest naming it, so the API can
 * print a URL whose bytes are allowed to be cached for a year.
 */

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const outDir = path.join(appRoot, "dist", "embed");

function stampBundle(): Plugin {
  return {
    name: "stamp-embed-bundle",
    apply: "build",
    async closeBundle() {
      const built = await readFile(path.join(outDir, "embed.js"));
      const sha8 = createHash("sha256").update(built).digest("hex").slice(0, 8);
      const file = `v${sha8}/embed.js`;
      await mkdir(path.join(outDir, `v${sha8}`), { recursive: true });
      await copyFile(path.join(outDir, "embed.js"), path.join(outDir, file));
      await writeFile(
        path.join(outDir, "manifest.json"),
        JSON.stringify({ file, sha8, bytes: built.byteLength, builtAt: new Date().toISOString() }, null, 2),
      );
    },
  };
}

export default defineConfig({
  plugins: [stampBundle()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: false,
    lib: {
      entry: path.join(appRoot, "embed", "embed.ts"),
      name: "SaasEmbed",
      formats: ["iife"],
      fileName: () => "embed.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
