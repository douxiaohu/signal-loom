import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./test/setup.ts",
    restoreMocks: true,
    exclude: ["test/ui-source.test.mjs", "e2e/**", "node_modules/**"]
  },
  build: {
    chunkSizeWarningLimit: 250,
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: {
        public: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin/index.html"),
        github: resolve(__dirname, "github/index.html")
      },
      output: {
        manualChunks: { react: ["react", "react-dom"] }
      }
    }
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false }
    }
  }
});
