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

const MODE = hasSupabase ? "hybrid_browser_first" : "browser_first";

const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function normalizeDbResults(dbResults) {
  if (!Array.isArray(dbResults)) return [];
  return dbResults
    .filter(Boolean)
    .map((row) => ({
      ...row,
      source: row.source || "supabase_retrieval",
    }));
}

function mergeResults(...groups) {
  const out = [];
  const seen = new Set();

  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      if (!item) continue;

      const key =
        String(item.url || "").trim().toLowerCase() ||
        String(item.title || "").trim().toLowerCase() ||
        JSON.stringify(item);

      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }

  return out.slice(0, 5);
}

async function searchSupabase({ query, session_id, req }) {
  if (!supabase || !session_id) {
    return {
      results: [],
      retrieval_error: null,
    };
  }

  try {
    const { data, error } = await supabase.rpc("search_site_content", {
      search_query: query,
      session_id,
    });

    if (error) {
      req.log.error(
        { error, query, session_id },
        "[search] supabase rpc failed"
      );

      return {
        results: [],
        retrieval_error: error.message || String(error),
      };
    }

    return {
      results: normalizeDbResults(data),
      retrieval_error: null,
    };
  } catch (err) {
    req.log.error(
      { err, query, session_id },
      "[search] supabase rpc threw"
    );

    return {
      results: [],
      retrieval_error: err instanceof Error ? err.message : String(err),
    };
  }
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
    mode: MODE,
    port: PORT,
  };
});

app.get("/ready", async () => {
  return {
    status: "ready",
    service: "neo-search-worker",
    mode: MODE,
    hasSupabase,
    hasWorkerSecret: Boolean(WORKER_SECRET),
  };
});

app.post("/search", async (req, reply) => {
  const startedAt = Date.now();

  try {
    const body = req.body ?? {};
    const session_id =
      typeof body.session_id === "string" ? body.session_id.trim() : "";
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const site_url =
      typeof body.site_url === "string" ? body.site_url.trim() : "";

    if (!query) {
      return reply.code(400).send({
        error: "Missing required field: query",
      });
    }

    if (!site_url && !hasSupabase) {
      return reply.code(400).send({
        error: "Missing site_url. Browser-first mode requires site_url.",
      });
    }

    req.log.info(
      {
        query,
        siteUrl: site_url || null,
        sessionId: session_id || null,
        mode: MODE,
      },
      "[search] start"
    );

    let liveData = {
      ok: false,
      results: [],
      reason: "skipped_no_site_url",
      elapsed_ms: 0,
      engine_sequence: [],
      failures: [],
    };

    if (site_url) {
      liveData = await browserSearchWithRetry({
        siteUrl: site_url,
        query,
        logger: req.log,
      });
    }

    const dbData = await searchSupabase({ query, session_id, req });

    const finalResults = liveData.ok
      ? mergeResults(liveData.results, dbData.results)
      : mergeResults(dbData.results, liveData.results);

    const confidence = liveData.ok
      ? 0.95
      : finalResults.length > 0
        ? 0.75
        : 0;

    return reply.send({
      results: finalResults,
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
      retrieval_error: dbData.retrieval_error,
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
