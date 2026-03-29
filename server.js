import Fastify from "fastify";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

const PORT = Number(process.env.PORT || 3210);
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const MODE = "brave_api";

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health" || req.url === "/ready") return;

  const auth = req.headers.authorization ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/health", async () => {
  return {
    status: "ok",
    service: "neo-search-worker",
    mode: MODE,
    port: PORT,
  };
});

app.get("/ready", async () => {
  return {
    status: "ready",
    service: "neo-search-worker",
    mode: MODE,
    hasWorkerSecret: Boolean(WORKER_SECRET),
  };
});

app.post("/search", async (req, reply) => {
  const startedAt = Date.now();

  try {
    const body = req.body ?? {};
    const query =
      typeof body.query === "string" ? body.query.trim() : "";
    const site_url =
      typeof body.site_url === "string" ? body.site_url.trim() : "";

    if (!query) {
      return reply.code(400).send({
        error: "Missing required field: query",
      });
    }

    if (!site_url) {
      return reply.code(400).send({
        error: "Missing required field: site_url",
      });
    }

    req.log.info(
      {
        query,
        siteUrl: site_url,
        mode: MODE,
      },
      "[search] start"
    );

    const liveData = await browserSearchWithRetry({
      siteUrl: site_url,
      query,
      logger: req.log,
    });

    const confidence = liveData.ok ? 0.95 : 0;

    return reply.send({
      results: liveData.results || [],
      confidence,
      query,
      mode: MODE,
      live_search: {
        ok: Boolean(liveData.ok),
        reason: liveData.reason || null,
        elapsed_ms: liveData.elapsed_ms ?? null,
        engine_sequence: liveData.engine_sequence || [],
        failures: liveData.failures || [],
      },
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    req.log.error({ err }, "[search] request failed");

    return reply.code(500).send({
      error: "Search failed",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

async function start() {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });

    app.log.info(
      {
        port: PORT,
        hasWorkerSecret: Boolean(WORKER_SECRET),
        mode: MODE,
      },
      "NEO search worker online"
    );
  } catch (err) {
    app.log.error({ err }, "Failed to start NEO search worker");
    process.exit(1);
  }
}

async function shutdown(signal) {
  try {
    app.log.info({ signal }, "Shutting down NEO search worker");
    await closeBrowser();
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err, signal }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
