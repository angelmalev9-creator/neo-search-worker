import Fastify from "fastify";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

const PORT = Number(process.env.PORT || 3210);
const WORKER_SECRET = process.env.WORKER_SECRET || "";

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
    mode: "browser_only",
    port: PORT,
  };
});

app.get("/ready", async (_req, reply) => {
  if (!WORKER_SECRET) {
    return reply.code(500).send({
      status: "error",
      error: "Missing WORKER_SECRET",
    });
  }

  return {
    status: "ready",
    service: "neo-search-worker",
    mode: "browser_only",
  };
});

app.post("/search", async (req, reply) => {
  const startedAt = Date.now();

  try {
    const body = req.body ?? {};
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const siteUrl = typeof body.site_url === "string" ? body.site_url.trim() : "";
    const language = typeof body.language === "string" ? body.language.trim() : "";

    if (!query) {
      return reply.code(400).send({
        error: "Missing required field: query",
      });
    }

    if (!siteUrl) {
      return reply.code(400).send({
        error: "Missing required field: site_url",
      });
    }

    req.log.info(
      {
        query,
        siteUrl,
        sessionId: sessionId || null,
        language: language || null,
      },
      "[search] starting browser-only search"
    );

    const liveData = await browserSearchWithRetry({
      siteUrl,
      query,
      language,
      logger: req.log,
    });

    const results = Array.isArray(liveData?.results) ? liveData.results : [];
    const ok = Boolean(liveData?.ok) && results.length > 0;
    const confidence = typeof liveData?.confidence === "number"
      ? liveData.confidence
      : ok
        ? 0.92
        : 0;

    return reply.send({
      ok,
      browser_only: true,
      query,
      site_url: siteUrl,
      results,
      confidence,
      engine_sequence: Array.isArray(liveData?.engine_sequence) ? liveData.engine_sequence : [],
      fallback_reason: liveData?.reason || null,
      debug: liveData?.debug || {},
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
        mode: "browser_only",
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

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await start();
