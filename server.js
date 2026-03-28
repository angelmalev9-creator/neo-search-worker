import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

// ── Auth & Config ────────────────────────────────────────────────────────────
const WORKER_SECRET = process.env.WORKER_SECRET;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const isProductIntent = (q) => /цена|цени|цена|lv|лв|колко струва/i.test(q);

app.post("/search", async (req, reply) => {
  const { session_id, query, site_url } = req.body;
  const startedAt = Date.now();

  try {
    // 1. Existing Logic: Search Supabase Structured Data
    const { data: dbResults } = await supabase.rpc('search_site_content', { 
      search_query: query, 
      session_id: session_id 
    });

    let response = {
      results: dbResults || [],
      confidence: (dbResults?.length > 0) ? 0.85 : 0,
      query
    };

    // 2. REQUIRED NEW BEHAVIOR: Trigger Fallback
    const hasResults = response.results.length > 0;
    const isLowConfidence = response.confidence < 0.6;
    const isMissingPrice = isProductIntent(query) && !response.results.some(r => r.price || r.structured_data?.price);

    if ((!hasResults || isLowConfidence || isMissingPrice) && site_url) {
      req.log.info({ 
        reason: !hasResults ? "no_results" : isMissingPrice ? "missing_price" : "low_confidence",
        query 
      }, "[fallback] triggering live browser search");

      const liveData = await browserSearchWithRetry({
        siteUrl: site_url,
        query: query,
        logger: req.log
      });

      if (liveData.ok && liveData.results.length > 0) {
        // Merge results, prioritizing live data for freshness
        return reply.send({
          ...response,
          results: [...liveData.results, ...response.results].slice(0, 5),
          fallback_triggered: true,
          confidence: 0.95,
          elapsed_ms: Date.now() - startedAt
        });
      }
    }

    return reply.send({
      ...response,
      fallback_triggered: false,
      elapsed_ms: Date.now() - startedAt
    });

  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Search failed", details: err.message });
  }
});

app.get("/health", async () => ({ status: "ok" }));

const port = process.env.PORT || 3210;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`NEO search worker online on ${port}`);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
