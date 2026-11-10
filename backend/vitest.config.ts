import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load ../.env (Node's built-in loader) so tests can read TEST_DATABASE_URL.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    globalSetup: "./tests/global-setup.ts", // create + migrate the test database once
    fileParallelism: false, // test files share one database, so run them one at a time
  },
});
