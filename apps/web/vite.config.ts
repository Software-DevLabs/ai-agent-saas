import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      // The console talks to the API same-origin; the dev server forwards it.
      "/api": { target: API_TARGET, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          motion: ["motion"],
          query: ["@tanstack/react-query"],
          // Named rather than left to the dynamic import, so the canvas chunk
          // stays cacheable when the page code around it changes.
          xyflow: ["@xyflow/react"],
        },
      },
    },
  },
});
