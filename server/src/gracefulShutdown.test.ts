// Tests for graceful shutdown on a local test server. `exit` and
// `closeResources` are recorded instead of ending the process or a database.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  SHUTTING_DOWN_ERROR,
  createGracefulShutdown,
  readShutdownGraceMs,
} from "./gracefulShutdown.js";
import { OrderRegistry } from "./orderRegistry.js";
import { createPaymentRouter, type RunCapture } from "./paymentRoutes.js";
import { capturePayPalOrder, type ExpectedAmount } from "./paypalCapture.js";
import { createCheckoutToken } from "./checkoutToken.js";

const silentLogger = { log() {}, error() {} };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(10);
  }
}

// A promise with its resolve function, for holding handlers open.
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

// A server whose /slow route waits until release() is called.
async function startServer(
  t: TestContext,
  options: { graceMs?: number; closeResources?: () => Promise<void> } = {},
) {
  const events: string[] = [];
  const logs: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let slowStarted!: () => void;
  const slowReached = new Promise<void>((resolve) => (slowStarted = resolve));
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => (exited = resolve));

  const shutdown = createGracefulShutdown({
    graceMs: options.graceMs ?? 5000,
    closeResources:
      options.closeResources ??
      (async () => {
        events.push("closeResources");
      }),
    exit: (code) => {
      events.push(`exit:${code}`);
      exited(code);
    },
    logger: {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
    },
  });

  const app = express();
  app.use(shutdown.middleware);
  app.get("/fast", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/slow", async (_req, res) => {
    slowStarted();
    await released;
    res.json({ ok: true });
    events.push("slow response sent");
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  shutdown.attach(server);
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });

  const port = (server.address() as AddressInfo).port;
  return { shutdown, server, port, events, logs, release, slowReached, exitCode };
}

// A raw HTTP/1.1 connection: send() writes request text, and `received`
// resolves with everything the server sent once it closes the connection.
function rawConnection(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  let data = "";
  socket.on("data", (chunk) => (data += chunk));
  const received = new Promise<string>((resolve, reject) => {
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  return { send: (text: string) => socket.write(text), received };
}

test("a request in progress finishes before the pool closes, and then the process exits cleanly", async (t) => {
  const { shutdown, port, events, release, slowReached, exitCode } = await startServer(t);

  const slow = fetch(`http://127.0.0.1:${port}/slow`);
  await slowReached;
  shutdown.shutdown("SIGTERM");
  assert.equal(shutdown.requestsInProgress(), 1);

  // Nothing is closed while the request is still running.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(events, []);

  release();
  const response = await slow;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(await exitCode, 0);
  assert.deepEqual(events, ["slow response sent", "closeResources", "exit:0"]);
});

test("while draining, new connections are refused and a request on an open connection gets 503", async (t) => {
  const { shutdown, port, release, slowReached, exitCode } = await startServer(t);

  // A connection that is busy when shutdown starts stays open, so a client
  // can still send another request on it.
  const connection = rawConnection(port);
  connection.send("GET /slow HTTP/1.1\r\nHost: test\r\n\r\n");
  await slowReached;
  shutdown.shutdown("SIGTERM");
  connection.send("GET /fast HTTP/1.1\r\nHost: test\r\n\r\n");

  await assert.rejects(fetch(`http://127.0.0.1:${port}/fast`), "new connections are refused");

  release();
  const received = await connection.received;
  const [first, second] = received.split(/(?=HTTP\/1\.1 )/);
  assert.match(first ?? "", /^HTTP\/1\.1 200/);
  assert.match(second ?? "", /^HTTP\/1\.1 503/);
  assert.match(second ?? "", /connection: close/i);
  assert.match(second ?? "", /retry-after: 5/i);
  assert.ok((second ?? "").includes(SHUTTING_DOWN_ERROR));
  assert.equal(await exitCode, 0);
});

test("a keep-alive connection is closed as soon as its request finishes, not after the keep-alive timeout", async (t) => {
  const { shutdown, server, port, events, release, slowReached, exitCode } = await startServer(t);
  server.keepAliveTimeout = 30_000;
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());

  const slow = new Promise<number>((resolve, reject) => {
    http
      .get({ port, host: "127.0.0.1", path: "/slow", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
  await slowReached;
  shutdown.shutdown("SIGINT");

  release();
  assert.equal(await slow, 200);
  const respondedAt = Date.now();
  assert.equal(await exitCode, 0);
  assert.ok(Date.now() - respondedAt < 2000, "closed promptly, well before the 30 s keep-alive timeout");
  assert.deepEqual(events, ["slow response sent", "closeResources", "exit:0"]);
});

test("if a request outlasts the grace period, the process exits without closing the pool under it", async (t) => {
  const { shutdown, port, events, logs, slowReached, exitCode } = await startServer(t, { graceMs: 300 });

  const slow = fetch(`http://127.0.0.1:${port}/slow`).catch(() => undefined);
  await slowReached;
  const started = Date.now();
  shutdown.shutdown("SIGTERM");

  assert.equal(await exitCode, 1);
  assert.ok(Date.now() - started >= 250, "waited for the grace period");
  assert.deepEqual(events, ["exit:1"], "resources are not closed while a request still uses them");
  assert.ok(logs.some((line) => /grace period \(0\.3 s\) ended with 1 request/.test(line)));
  void slow;
});

test("a repeated signal keeps waiting instead of cutting requests off", async (t) => {
  const { shutdown, port, events, logs, release, slowReached, exitCode } = await startServer(t);

  const slow = fetch(`http://127.0.0.1:${port}/slow`);
  await slowReached;
  shutdown.shutdown("SIGINT");
  shutdown.shutdown("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(events, [], "the second signal did not exit");
  assert.ok(logs.some((line) => /received again/.test(line)));

  release();
  assert.equal((await slow).status, 200);
  assert.equal(await exitCode, 0);
  assert.deepEqual(events, ["slow response sent", "closeResources", "exit:0"]);
});

test("with no requests in progress, shutdown closes the pool and exits at once", async (t) => {
  const { shutdown, port, events, exitCode } = await startServer(t);
  assert.equal((await fetch(`http://127.0.0.1:${port}/fast`)).status, 200);
  assert.equal(shutdown.requestsInProgress(), 0);

  const started = Date.now();
  shutdown.shutdown("SIGTERM");
  assert.equal(await exitCode, 0);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(events, ["closeResources", "exit:0"]);
});

test("a failure while closing the pool exits with an error code", async (t) => {
  const { shutdown, logs, exitCode } = await startServer(t, {
    closeResources: async () => {
      throw new Error("pool end failed");
    },
  });

  shutdown.shutdown("SIGTERM");
  assert.equal(await exitCode, 1);
  assert.ok(logs.some((line) => /Closing resources during shutdown failed: pool end failed/.test(line)));
});

test("SHUTDOWN_GRACE_MS is read as milliseconds, with a default for missing or invalid values", () => {
  const logs: string[] = [];
  const logger = { log() {}, error: (...args: unknown[]) => logs.push(args.join(" ")) };

  assert.equal(readShutdownGraceMs(undefined, logger), DEFAULT_SHUTDOWN_GRACE_MS);
  assert.equal(readShutdownGraceMs("", logger), DEFAULT_SHUTDOWN_GRACE_MS);
  assert.equal(readShutdownGraceMs("55000", logger), 55_000);
  assert.equal(logs.length, 0);

  for (const bad of ["abc", "0", "-5", "999", "2.5", "30s"]) {
    assert.equal(readShutdownGraceMs(bad, silentLogger), DEFAULT_SHUTDOWN_GRACE_MS, bad);
  }
  readShutdownGraceMs("30s", logger);
  assert.match(logs[0] ?? "", /SHUTDOWN_GRACE_MS must be a whole number/);
});

// --- Tracking handlers, not just responses ------------------------------------

// An app with the shutdown middleware first, routes added by `mount`, and a
// JSON error handler last, like index.ts.
async function startTrackedApp(
  t: TestContext,
  mount: (app: express.Express, shutdown: ReturnType<typeof createGracefulShutdown>) => void,
  closeResources: () => Promise<void> = async () => {},
) {
  const events: string[] = [];
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => (exited = resolve));
  const shutdown = createGracefulShutdown({
    graceMs: 5000,
    closeResources: async () => {
      await closeResources();
      events.push("closeResources");
    },
    exit: (code) => {
      events.push(`exit:${code}`);
      exited(code);
    },
    logger: silentLogger,
  });

  const app = express();
  app.use(shutdown.middleware);
  app.use((_req, res, next) => {
    res.once("close", () => events.push("response closed"));
    next();
  });
  app.use(express.json());
  mount(app, shutdown);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    events.push("error handler");
    res.status(500).json({ error: "failed" });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  shutdown.attach(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { shutdown, port: (server.address() as AddressInfo).port, events, exitCode };
}

// Opens a connection, sends `request`, and returns a function that drops it.
function sendAndDisconnect(port: number, request: string) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(request);
  return () => socket.destroy();
}

const ORDER_ID = "5O190127TN364715T";
const EXPECTED: ExpectedAmount = { value: "5.00", currency: "USD" };

test("a client disconnect mid-capture keeps the request in progress until the capture handler settles", async (t) => {
  const registry = new OrderRegistry();
  t.after(() => registry.close());
  const checkout = createCheckoutToken();
  await registry.register(ORDER_ID, EXPECTED, checkout.hash);

  // The capture waits on "PayPal" until paypalAnswers.open().
  const captureStarted = gate();
  const paypalAnswers = gate();
  const runCapture: RunCapture = async (orderID, expected) => {
    captureStarted.open();
    await paypalAnswers.opened;
    return capturePayPalOrder(orderID, expected, {
      baseUrl: "https://paypal.test",
      accessToken: "fake-access-token-for-tests",
      logger: silentLogger,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: orderID,
            status: "COMPLETED",
            purchase_units: [
              { payments: { captures: [{ id: "CAPTURE1", status: "COMPLETED", amount: { value: "5.00", currency_code: "USD" } }] } },
            ],
          }),
          { status: 201 },
        ),
    });
  };

  const { shutdown, port, events, exitCode } = await startTrackedApp(
    t,
    (app, s) => app.use(createPaymentRouter(registry, runCapture, s.trackHandler)),
    // Records the order's state at the moment the pool would be closed.
    async () => {
      events.push(`order ${(await registry.get(ORDER_ID))?.status} when resources close`);
    },
  );

  const body = JSON.stringify({ orderID: ORDER_ID, checkoutToken: checkout.token });
  const disconnect = sendAndDisconnect(
    port,
    `POST /api/payments/capture-order HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  await captureStarted.opened;
  disconnect();
  await waitFor("the response to close", () => events.includes("response closed"));

  assert.equal(shutdown.requestsInProgress(), 1, "the capture is still running after the client left");

  shutdown.shutdown("SIGTERM");
  await delay(200);
  assert.equal(shutdown.requestsInProgress(), 1);
  assert.ok(!events.includes("closeResources"), "resources stay open while the capture runs");

  paypalAnswers.open();
  assert.equal(await exitCode, 0);
  assert.equal(shutdown.requestsInProgress(), 0);
  assert.deepEqual(events, [
    "response closed",
    "order PAID when resources close",
    "closeResources",
    "exit:0",
  ]);
});

test("a rejected async handler stays in progress until it rejects, then is released once", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const started = gate();
  const fail = gate();
  const { shutdown, port, events } = await startTrackedApp(t, (app, s) => {
    app.get(
      "/reject",
      s.trackHandler(async () => {
        started.open();
        await fail.opened;
        throw new Error("capture failed");
      }),
    );
  });

  const response = fetch(`http://127.0.0.1:${port}/reject`);
  await started.opened;
  assert.equal(shutdown.requestsInProgress(), 1);

  fail.open();
  assert.equal((await response).status, 500, "Express still sends the rejection to the error handler");
  await waitFor("the request to end", () => shutdown.requestsInProgress() === 0);
  await delay(50);
  assert.equal(shutdown.requestsInProgress(), 0, "never decremented twice");
  assert.equal(events.filter((e) => e === "error handler").length, 1);
  assert.deepEqual(unhandled, [], "no unhandled rejection");
});

test("a handler that rejects after its client disconnected is still counted until it rejects", async (t) => {
  const started = gate();
  const fail = gate();
  const { shutdown, port, events } = await startTrackedApp(t, (app, s) => {
    app.get(
      "/reject",
      s.trackHandler(async () => {
        started.open();
        await fail.opened;
        throw new Error("capture failed");
      }),
    );
  });

  const disconnect = sendAndDisconnect(port, "GET /reject HTTP/1.1\r\nHost: test\r\n\r\n");
  await started.opened;
  disconnect();
  await waitFor("the response to close", () => events.includes("response closed"));
  assert.equal(shutdown.requestsInProgress(), 1);

  fail.open();
  await waitFor("the request to end", () => shutdown.requestsInProgress() === 0);
  await delay(50);
  assert.equal(shutdown.requestsInProgress(), 0);
});

test("a handler that throws synchronously is released, and the request ends after its error response", async (t) => {
  const { shutdown, port } = await startTrackedApp(t, (app, s) => {
    app.get(
      "/throw",
      s.trackHandler(() => {
        throw new Error("sync failure");
      }),
    );
  });

  assert.equal((await fetch(`http://127.0.0.1:${port}/throw`)).status, 500);
  await waitFor("the request to end", () => shutdown.requestsInProgress() === 0);
  await delay(50);
  assert.equal(shutdown.requestsInProgress(), 0);
});

test("many mixed requests, including chained tracked handlers, bring the count back to exactly zero", async (t) => {
  const { shutdown, port } = await startTrackedApp(t, (app, s) => {
    app.get("/ok", s.trackHandler(async (_req, res) => {
      await delay(5);
      res.json({ ok: true });
    }));
    app.get("/reject", s.trackHandler(async () => {
      await delay(5);
      throw new Error("rejected");
    }));
    app.get("/throw", s.trackHandler(() => {
      throw new Error("thrown");
    }));
    app.get(
      "/chain",
      s.trackHandler((_req, _res, next) => next()),
      s.trackHandler(async (_req, res) => {
        await delay(5);
        res.json({ ok: true });
      }),
    );
    app.get("/plain", (_req, res) => {
      res.json({ ok: true });
    });
  });

  const paths = ["/ok", "/reject", "/throw", "/chain", "/plain"];
  const statuses = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      fetch(`http://127.0.0.1:${port}${paths[i % paths.length]}`).then((r) => r.status),
    ),
  );
  assert.deepEqual(
    [...new Set(statuses)].sort(),
    [200, 500],
  );
  await waitFor("all requests to end", () => shutdown.requestsInProgress() === 0);
  await delay(50);
  assert.equal(shutdown.requestsInProgress(), 0);
});
