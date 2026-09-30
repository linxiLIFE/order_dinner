import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  define: {
    __ORDER_DINNER_API_ORIGIN__: JSON.stringify(process.env.ORDER_DINNER_API_ORIGIN || "")
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000"
    }
  },
  build: {
    outDir: process.env.ORDER_DINNER_WEB_OUT_DIR || "dist",
    emptyOutDir: true
  }
});
