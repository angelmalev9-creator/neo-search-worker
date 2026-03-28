import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

const PORT = Number(process.env.PORT || 3210);
const WORKER_SECRET = process.env.WORKER_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const hasSupabase =
  Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY);

const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function isProductIntent(query = "") {
  return /(цена|цени|колко струва|лв|lv|price|pricing|cost)/i.test(query);
}

function normalizeDbResults(dbResults) {
  if (!Array.isArray(dbResults)) return [];
  return dbResults.filter(Boolean).map((row) => ({
    ...row,
    source: row.source || "supabase_retrieval",
  }));
}

function hasPrice(result) {
  if (!result || typeof result !== "object") return false;

  if (result.price != null && String(result.price).trim() !== "") return true;

  if (
    result.structured_data &&
    typeof result.structured_data === "object" &&
    result.structured_data.price != null &&
    String(result.structured_data.price).trim() !== ""
  ) {
    return true;
  }

  if (Array.isArray(result.excerpts)) {
    return result.excerpts.some((text) =>
      /(лв|lv|eur|€|\b\d+[.,]?\d*\s?(лв|lv|eur|€))/i.test(String(text || ""))
    );
  }

  return false;
}

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

  if (!hasSupabase) {
    return reply.code(500).send({
      status: "error",
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  return {
    status: "ready",
    service: "neo-search-worker",
  };
});

app.post("/search", async (req, reply) => {
  const startedAt = Date.now();

  try {
    const body = req.body ?? {};
    const session_id = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const site_url = typeof body.site_url === "string" ? body.site_url.trim() : "";

    if (!query) {
      return reply.code(400).send({
        error: "Missing required field: query",
      });
    }

    if (!supabase) {
      return reply.code(500).send({
        error: "Supabase is not configured",
      });
    }

    let dbResults = [];
    let retrievalError = null;

    try {
      const { data, error } = await supabase.rpc("search_site_content", {
        search_query: query,
        session_id,
      });

      if (error) {
        retrievalError = error.message || String(error);
        req.log.error(
          { error, query, session_id },
          "[search] supabase rpc failed"
        );
      } else {
        dbResults = normalizeDbResults(data);
      }
    } catch (err) {
      retrievalError = err instanceof Error ? err.message : String(err);
      req.log.error(
        { err, query, session_id },
        "[search] supabase rpc threw"
      );
    }

    const baseConfidence = dbResults.length > 0 ? 0.85 : 0;
    const hasResults = dbResults.length > 0;
    const lowConfidence = baseConfidence < 0.6;
    const missingPrice =
      isProductIntent(query) && !dbResults.some((item) => hasPrice(item));

    let finalResults = dbResults;
    let confidence = baseConfidence;
    let fallbackTriggered = false;
    let fallbackReason = null;
    let fallbackMeta = null;

    const shouldFallback =
      Boolean(site_url) && (!hasResults || lowConfidence || missingPrice);

    if (shouldFallback) {
      fallbackTriggered = true;
      fallbackReason = !hasResults
        ? "no_results"
        : missingPrice
          ? "missing_price"
          : "low_confidence";

      req.log.info(
        {
          query,
          site_url,
          fallbackReason,
        },
        "[fallback] triggering live browser search"
      );

      const liveData = await browserSearchWithRetry({
        siteUrl: site_url,
        query,
        logger: req.log,
      });

      fallbackMeta = {
        ok: Boolean(liveData?.ok),
        reason: liveData?.reason || null,
        elapsed_ms: liveData?.elapsed_ms ?? null,
      };

      if (liveData?.ok && Array.isArray(liveData.results) && liveData.results.length > 0) {
        finalResults = [...liveData.results, ...dbResults].slice(0, 5);
        confidence = 0.95;
      }
    }

    return reply.send({
      results: finalResults,
      confidence,
      query,
      fallback_triggered: fallbackTriggered,
      fallback_reason: fallbackReason,
      fallback_meta: fallbackMeta,
      retrieval_error: retrievalError,
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
        hasSupabase,
        hasWorkerSecret: Boolean(WORKER_SECRET),
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
