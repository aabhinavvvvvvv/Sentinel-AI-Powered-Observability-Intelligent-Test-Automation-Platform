/**
 * What a valid test suite and test case look like.
 *
 * Assertions are a fixed menu of checks (no user code). Each one has a "type"
 * that says which kind it is; Zod's discriminatedUnion picks the right rules by that type.
 */
import { z } from "zod";

// "user.id" or "items.0.name": object keys and array positions joined with dots.
const JsonPath = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, 'must be a dot path like "user.id" or "items.0.name"');

export const AssertionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status_equals"), value: z.number().int().min(100).max(599) }),
  z.strictObject({ type: z.literal("response_time_below_ms"), value: z.number().int().min(1).max(60_000) }),
  z.strictObject({ type: z.literal("header_contains"), name: z.string().min(1).max(100), value: z.string().max(1000) }),
  z.strictObject({ type: z.literal("body_contains"), value: z.string().min(1).max(1000) }),
  z.strictObject({ type: z.literal("json_path_exists"), path: JsonPath }),
  z.strictObject({
    type: z.literal("json_path_equals"),
    path: JsonPath,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]), // simple values only
  }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

// Headers we never let users set: they're managed by the HTTP client itself.
const FORBIDDEN_HEADERS = ["host", "content-length", "connection", "transfer-encoding"];

const HeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/, "invalid header name").max(100), z.string().max(4000))
  .refine((h) => Object.keys(h).length <= 20, "at most 20 headers")
  .refine(
    (h) => Object.keys(h).every((name) => !FORBIDDEN_HEADERS.includes(name.toLowerCase())),
    `these headers can't be set: ${FORBIDDEN_HEADERS.join(", ")}`,
  );

export const TestCaseSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" }).max(2048),
    headers: HeadersSchema.default({}),
    body: z.string().max(100_000).nullable().default(null),
    timeout_ms: z.number().int().min(1000).max(30_000).default(5000),
    assertions: z.array(AssertionSchema).min(1, "add at least one assertion").max(20),
  })
  // HTTP clients refuse to send a body with GET or HEAD.
  .refine((c) => c.body === null || !["GET", "HEAD"].includes(c.method), {
    message: "GET and HEAD requests can't have a body",
    path: ["body"],
  });
export type NewTestCase = z.infer<typeof TestCaseSchema>;

export interface TestCase extends NewTestCase {
  id: number;
  suite_id: number;
  created_at: Date;
  updated_at: Date;
}

// The editable settings of a suite. schedule_minutes: run by itself every N minutes, or null = manual only.
export const SuiteSettingsSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  schedule_minutes: z.number().int().min(5).max(1440).nullable().default(null),
});
export type SuiteSettings = z.infer<typeof SuiteSettingsSchema>;

export const CreateSuiteSchema = SuiteSettingsSchema.extend({ endpoint_id: z.number().int().positive() });

export interface TestSuite extends SuiteSettings {
  id: number;
  endpoint_id: number;
  created_at: Date;
  updated_at: Date;
}
