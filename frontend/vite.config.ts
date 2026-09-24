import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".");

  // Dev server port; run-all sets VITE_DEV_PORT, standalone `npm run dev`
  // keeps Vite's default (5173).
  const devPort = Number(env.VITE_DEV_PORT) || 5173;

  // Backend port the /api proxy forwards to. run-all sets VITE_BACKEND_PORT
  // to match its backend; standalone dev assumes the default backend (3001).
  const backendPort = env.VITE_BACKEND_PORT || "3001";

  return {
    plugins: [react()],
    server: {
      port: devPort,
      proxy: {
        // Forward API calls (REST + SSE) to the backend, so cookies stay
        // same-origin and no CORS configuration is needed.
        "/api": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
