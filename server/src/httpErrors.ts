// Final Express error handler. Express's default handler answers with an HTML
// page that includes the stack trace and local file paths; this returns a
// short JSON error instead, which the frontend can display.
import type { ErrorRequestHandler } from "express";

export const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const details = (typeof error === "object" && error !== null ? error : {}) as {
    status?: unknown;
    type?: unknown;
  };
  const status =
    typeof details.status === "number" && details.status >= 400 && details.status < 600
      ? details.status
      : 500;

  let message = "Something went wrong on the server. Try again.";
  if (details.type === "entity.parse.failed") {
    message = "The request body is not valid JSON.";
  } else if (details.type === "entity.too.large") {
    message = "The request is too large.";
  } else if (status < 500) {
    message = "The request could not be processed.";
  }

  if (status >= 500) {
    console.error("Unhandled server error:", error instanceof Error ? error.message : "Unknown error");
  }

  res.status(status).json({ error: message });
};
