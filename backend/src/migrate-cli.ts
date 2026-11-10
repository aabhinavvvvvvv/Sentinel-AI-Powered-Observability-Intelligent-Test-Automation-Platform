/** `npm run migrate`: apply pending migrations to DATABASE_URL. */
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig();
const applied = await runMigrations(config.DATABASE_URL);
console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
