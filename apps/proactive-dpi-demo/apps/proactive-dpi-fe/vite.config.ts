import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  server: { host: "0.0.0.0" },
  build: { outDir: "dist", emptyOutDir: true },
});
