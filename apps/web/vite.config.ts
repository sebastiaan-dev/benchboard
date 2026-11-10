import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Recharts dominates the chart chunk; it is loaded lazily with the pages that plot.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5319,
    proxy: { "/graphql": { target: "http://localhost:4319", changeOrigin: false } },
  },
});
