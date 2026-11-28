import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, warn) {
        // This app runs entirely in the browser; RSC boundary directives are unnecessary.
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes('"use client"')
        )
          return;
        warn(warning);
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT || process.env.DEMO_PORT || 8787}`,
        changeOrigin: true,
        configure: (proxy) =>
          proxy.on("proxyReq", (request) => {
            request.removeHeader("origin");
          }),
      },
    },
  },
});
