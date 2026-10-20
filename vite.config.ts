import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";
import process from "node:process";

export default defineConfig(({ mode }) => {
  // Config-time only (not exposed to client code): `PREVIEW_PORT` from the
  // shell or .env sets the port for `vite preview`.
  const env = loadEnv(mode, process.cwd(), "");
  const previewPort = env.PREVIEW_PORT ? Number(env.PREVIEW_PORT) : undefined;

  // Comma-separated hostnames `vite preview` accepts (Host-header check).
  const allowedHosts = (env.PREVIEW_ALLOWED_HOSTS ?? "rampart.maremosso.net")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
  base: process.env.GITHUB_ACTIONS ? "/rebuild-and-ruin/" : "/",
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        "sprite-viewer": resolve(__dirname, "sprite-viewer.html"),
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/ws/play": {
        target: "ws://localhost:8001",
        ws: true,
      },
      "/api": {
        target: "http://localhost:8001",
      },
    },
  },
  preview: {
    host: true,
    allowedHosts,
    port: previewPort,
    strictPort: previewPort !== undefined,
  },
  };
});
