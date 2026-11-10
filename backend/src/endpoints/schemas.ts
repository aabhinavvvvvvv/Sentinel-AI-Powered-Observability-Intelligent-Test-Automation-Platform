/**
 * What a valid endpoint looks like, for creating (POST) and updating (PATCH).
 * Field names are snake_case to match the database columns exactly.
 */
import { z } from "zod";

// Each field's rules, WITHOUT defaults (see UpdateEndpointSchema for why).
const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" }).max(2048),
  method: z.enum(["GET", "HEAD"]),
  interval_seconds: z.number().int().min(30).max(3600),
  // Max timeout (30s) is below the min interval (30s), so a check always finishes before the next is due.
  timeout_ms: z.number().int().min(1000).max(30_000),
  expected_status: z.number().int().min(100).max(599),
  max_retries: z.number().int().min(0).max(3),
  failure_threshold: z.number().int().min(1).max(10), // failed checks in a row that open an incident
  paused: z.boolean(),
};

// POST: name and url are required; everything else falls back to a default.
// strictObject rejects unknown keys, so a typo like "intervalSeconds" is an error, not silently ignored.
export const CreateEndpointSchema = z.strictObject({
  ...fields,
  method: fields.method.default("GET"),
  interval_seconds: fields.interval_seconds.default(60),
  timeout_ms: fields.timeout_ms.default(5000),
  expected_status: fields.expected_status.default(200),
  max_retries: fields.max_retries.default(0),
  failure_threshold: fields.failure_threshold.default(3),
  paused: fields.paused.default(false),
});

// PATCH: every field optional, and NO defaults. If we built this from CreateEndpointSchema,
// Zod would fill in defaults for missing fields and silently reset them on every update.
export const UpdateEndpointSchema = z
  .strictObject(fields)
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, "Provide at least one field to update");

export type NewEndpoint = z.infer<typeof CreateEndpointSchema>;
export type EndpointChanges = z.infer<typeof UpdateEndpointSchema>;

/** A row of the `endpoints` table. */
export interface Endpoint extends NewEndpoint {
  id: number;
  created_at: Date;
  updated_at: Date;
}
