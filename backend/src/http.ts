/** Small helpers shared by all routers: reading ids from the URL and sending standard errors. */
import type { Response } from "express";
import type { ZodError } from "zod";

/** "42" → 42. Anything else (e.g. "abc", "0", "-1", "1.5", too big for INTEGER) → null. */
export function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null; // Postgres INTEGER maximum
}

export function sendValidationError(res: Response, error: ZodError): void {
  res.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message: "Request body is invalid",
      details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    },
  });
}

export function sendInvalidId(res: Response): void {
  res.status(400).json({ error: { code: "INVALID_ID", message: "id must be a positive integer" } });
}

/** e.g. sendNotFound(res, "Endpoint", 5) → 404 "Endpoint 5 not found" */
export function sendNotFound(res: Response, what: string, id: number): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `${what} ${id} not found` } });
}
