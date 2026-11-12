// Graceful shutdown for the HTTP server. On SIGINT or SIGTERM the server
// stops taking requests, lets the ones in progress finish (a PayPal capture
// can take up to about 45 seconds), and only then closes resources such as
// the PostgreSQL pool.
//
// If requests are still running when the grace period ends, the process
// exits anyway rather than waiting to be killed. That is safe for captures:
// PostgreSQL rolls back the unfinished transaction and releases its lock,
// nothing is recorded as paid, and a retry reuses the same PayPal-Request-Id,
// so PayPal returns the earlier result instead of charging again.
import type { Server } from "node:http";
import type { RequestHandler } from "express";

// Fits the common 30-second platform grace period (for example the Kubernetes
// default) with time to spare. Set SHUTDOWN_GRACE_MS a few seconds below
// your host's grace period; covering a worst-case capture needs about 50.
export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;

export const SHUTTING_DOWN_ERROR =
  "The server is restarting and did not process this request. Try again in a moment.";

type Logger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

// Reads SHUTDOWN_GRACE_MS: a whole number of milliseconds, at least 1000.
export function readShutdownGraceMs(value: string | undefined, logger: Logger = console): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SHUTDOWN_GRACE_MS;
  const ms = Number(value);
  if (Number.isInteger(ms) && ms >= 1000) return ms;
  logger.error(
    `SHUTDOWN_GRACE_MS must be a whole number of milliseconds of at least 1000; using ${DEFAULT_SHUTDOWN_GRACE_MS}.`,
  );
  return DEFAULT_SHUTDOWN_GRACE_MS;
}

// Wraps a route handler so shutdown waits for it; see trackHandler below.
export type HandlerTracker = <H extends RequestHandler<any, any, any, any, any>>(handler: H) => H;

export type GracefulShutdownOptions = {
  graceMs: number;
  // Runs once the HTTP server has closed and every tracked request handler
  // has settled, so no request is still using them.
  closeResources: () => Promise<void>;
  exit?: (code: number) => void;
  logger?: Logger;
  // How often connections that finished their request are closed while
  // draining, instead of staying open until the keep-alive timeout.
  idleSweepMs?: number;
};

export function createGracefulShutdown(options: GracefulShutdownOptions) {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const logger = options.logger ?? console;
  const graceSeconds = `${options.graceMs / 1000} s`;
  let server: Server | undefined;
  let draining = false;

  // A request is in progress until its response has closed AND every
  // tracked handler for it has settled. The response alone is not enough:
  // its "close" event also fires when the client disconnects, while an async
  // handler (such as a capture waiting on PayPal) is still running.
  // Each part holds the request; the last release ends it, exactly once.
  let inFlight = 0;
  const holdsByRequest = new WeakMap<object, { holds: number }>();
  let onIdle: Array<() => void> = [];

  function hold(req: object): () => void {
    let request = holdsByRequest.get(req);
    if (!request || request.holds === 0) {
      request = { holds: 0 };
      holdsByRequest.set(req, request);
      inFlight++;
    }
    const held = request;
    held.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holds--;
      if (held.holds > 0) return;
      inFlight--;
      if (inFlight === 0) {
        const waiting = onIdle;
        onIdle = [];
        for (const resolve of waiting) resolve();
      }
    };
  }

  const whenIdle = () =>
    inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => onIdle.push(resolve));

  // Register before the routes. While draining, requests that arrive on
  // connections that are still open get a 503 before any work starts, so no
  // new capture begins during shutdown.
  const middleware: RequestHandler = (req, res, next) => {
    if (draining) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: SHUTTING_DOWN_ERROR });
      return;
    }
    res.once("close", hold(req));
    next();
  };

  // Wraps a route handler so its request stays in progress until the
  // handler has finished: when its returned promise settles (resolved or
  // rejected), or when it returns or throws synchronously. The handler's own
  // result is passed on, so Express still sends a rejection or a thrown
  // error to the error handler.
  function trackHandler<H extends RequestHandler<any, any, any, any, any>>(handler: H): H {
    const tracked: RequestHandler<any, any, any, any, any> = (req, res, next) => {
      const release = hold(req);
      let result: unknown;
      try {
        result = handler(req, res, next);
      } catch (error) {
        release();
        throw error;
      }
      if (result instanceof Promise) {
        // Both callbacks are given so this branch never adds an unhandled
        // rejection; Express handles the rejection on the returned promise.
        result.then(release, release);
      } else {
        release();
      }
      return result;
    };
    return tracked as H;
  }

  function shutdown(signal: string) {
    if (draining) {
      // Some tools deliver Ctrl+C twice (the terminal and npm both send it),
      // so a repeated signal keeps waiting instead of cutting requests off.
      logger.log(`${signal} received again; still waiting for ${inFlight} request(s) to finish.`);
      return;
    }
    draining = true;
    logger.log(
      `${signal} received: refusing new requests, waiting up to ${graceSeconds} for ${inFlight} request(s) in progress, then closing the database pool.`,
    );

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceExit);
      clearInterval(sweep);
      exit(code);
    };

    const forceExit = setTimeout(() => {
      logger.error(
        `Shutdown grace period (${graceSeconds}) ended with ${inFlight} request(s) still in progress; exiting. An unfinished capture is rolled back and is safe to retry.`,
      );
      finish(1);
    }, options.graceMs);

    const closeResources = () => {
      options.closeResources().then(
        () => finish(0),
        (error: unknown) => {
          logger.error(
            "Closing resources during shutdown failed:",
            error instanceof Error ? error.message : "Unknown error",
          );
          finish(1);
        },
      );
    };

    const sweep = setInterval(() => server?.closeIdleConnections(), options.idleSweepMs ?? 100);

    if (!server) {
      closeResources();
      return;
    }
    // The callback runs once every connection has closed. A handler can
    // still be running after its client disconnected, so the pool is closed
    // only once every tracked handler has also settled.
    server.close(() => {
      void whenIdle().then(closeResources);
    });
    server.closeIdleConnections();
  }

  return {
    middleware,
    trackHandler,
    shutdown,
    attach(listening: Server) {
      server = listening;
    },
    requestsInProgress: () => inFlight,
  };
}
