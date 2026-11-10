/**
 * The last two stops in the Express middleware pipeline:
 *   notFound      – no route matched → JSON 404
 *   errorHandler  – something threw   → JSON 4xx/500, logged, no internals leaked
 *
 * Every API error uses one consistent shape so clients can handle it uniformly:
 *   { "error": { "code": "NOT_FOUND", "message": "..." } }
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "../logger.js";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` },
  });
};

/** Does this error carry a client-error HTTP status (400–499)? e.g. malformed JSON → 400. */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return status;
  }
  return undefined;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express recognises an error handler by its FOUR parameters, so `_next`
  // must stay in the signature even though we never call it.
  return (err, req, res, _next) => {
    const status = clientErrorStatus(err);
    if (status !== undefined) {
      // The client sent something wrong. Their fault, so log at "warn", not "error".
      logger.warn({ err, path: req.path }, "client error");
      res.status(status).json({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
      return;
    }
    // Our fault. Log everything internally; tell the client nothing internal
    // (stack traces can reveal file paths, library versions, even SQL).
    logger.error({ err, path: req.path }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
}
