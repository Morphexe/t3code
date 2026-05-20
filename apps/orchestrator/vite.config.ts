import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const devPort = Number(process.env.VITE_DEV_PORT ?? process.env.UI_PORT ?? 5173);
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/ui",
  server: {
    host: "0.0.0.0",
    port: devPort,
    proxy: {
      "/api": apiTarget,
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
