/**
 * Configuration: read environment variables ONCE at startup, validate them,
 * and expose a typed, read-only object to the rest of the app.
 *
 * Why: a typo in DATABASE_URL should stop the app immediately with a clear
 * message ("fail fast"), not cause a confusing error minutes later.
 */
import { z } from "zod";

// The schema describes what a valid environment looks like.
// `z.coerce.number()` converts the string "3000" into the number 3000,
// because environment variables are ALWAYS strings.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "must be a postgres:// or postgresql:// URL",
  }),
  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" })
    .default("redis://localhost:6379"),
  // Email alerts. Locally this points at Mailpit (a fake inbox in Docker).
  SMTP_URL: z
    .url({ protocol: /^smtps?$/, error: "must be an smtp:// or smtps:// URL" })
    .default("smtp://localhost:1025"),
  ALERT_EMAIL_FROM: z.string().min(1).default("Sentinel <sentinel@localhost>"),
  // Comma-separated list of who gets alerts. Empty = alerts turned off.
  ALERT_EMAIL_TO: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((address) => address.trim())
        .filter((address) => address !== ""),
    )
    .pipe(z.array(z.email({ error: "must be a comma-separated list of email addresses" }))),
  // The Python analytics service (analytics/).
  ANALYTICS_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:8000"),
  HEALTHCHECK_DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
});

// TypeScript type derived from the schema, so the two can never drift apart.
export type Config = Readonly<z.infer<typeof EnvSchema>>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Parse and validate configuration.
 * `env` is a parameter (defaulting to the real process.env) so tests can pass a fake one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    // Turn Zod's detailed issues into one readable message per bad variable.
    // We deliberately never print the VALUES, because they may contain secrets.
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  return Object.freeze(result.data);
}
