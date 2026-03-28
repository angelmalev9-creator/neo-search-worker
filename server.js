import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

const WORKER_SECRET = process.env.WORKER_SECRET;

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// Helper to determine if we need live fallback
function needsFallback(dbResponse, query) {
  if (!dbResponse.results || dbResponse.results.length === 0) return "empty_results";
  if (dbResponse.confidence < 0.6) return "low_confidence";
  
  const isProductQuery = /цена|цени|цена|lv|лв/i.test(query);
  const hasPrice = dbResponse.results.some(r => r.price || (r.structured_data && r.structured_data.price));
  if (isProductQuery && !hasPrice) return "missing_pricing";
  
  return null;
}

app.post("/search", async (req, reply) => {
  const { session_id, query, site_url } = req.body;
  const startedAt = Date.now();

  try {
    // 1. Perform existing Supabase structured search
    // (Assuming logic from existing search worker)
    const dbResponse = await performStructuredSearch(session_id, query); 

    // 2. Evaluate fallback trigger
    const fallbackReason = needsFallback(dbResponse, query);

    if (fallbackReason && site_url) {
      req.log.info({ fallbackReason, query }, "[fallback] triggering live browser search");
      
      const liveResults = await browserSearchWithRetry({
        siteUrl: site_url,
        query: query,
        logger: req.log
      });

      if (liveResults.ok && liveResults.results.length > 0) {
        return reply.send({
          ...dbResponse,
          results: [...liveResults.results, ...dbResponse.results].slice(0, 5),
          fallback_triggered: true,
          fallback_reason: fallbackReason,
          confidence: 0.9,
          elapsed_ms: Date.now() - startedAt
        });
      }
    }

    return reply.send({
      ...dbResponse,
      fallback_triggered: false,
      elapsed_ms: Date.now() - startedAt
    });

  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "Search execution failed" });
  }
});

app.listen({ port: 3210, host: "0.0.0.0" });

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
