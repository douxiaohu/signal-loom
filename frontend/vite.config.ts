import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

function mpaEntryRoutes(): Plugin {
  return {
    name: "mpa-entry-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || "";
        const bare = url.split("?")[0];
        const suffix = url.slice(bare.length);
        if (bare === "/admin" && !url.includes(".")) {
          req.url = bare + "/index.html" + suffix;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), mpaEntryRoutes()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") }
  },
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
        admin: resolve(__dirname, "admin/index.html")
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
