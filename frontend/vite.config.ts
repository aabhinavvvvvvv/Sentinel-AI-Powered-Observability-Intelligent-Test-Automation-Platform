import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // The page calls "/api/endpoints"; Vite forwards that to the backend as "/endpoints".
    // Page and API then look like ONE website to the browser, so no CORS setup is needed.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom", // a fake browser for tests
  },
});
