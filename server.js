import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";
import { browserSearchWithRetry, closeBrowser } from "./browser-search.js";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

// -- Auth Middleware --
const WORKER_SECRET = process.env.WORKER_SECRET;
app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// -- Supabase Client --
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -- Helper: Detect Product Intent --
const isProductIntent = (query) => {
  const keywords = ["цена", "цени", "lv", "лв", "колко", "price", "buy", "купи"];
  return keywords.some(k => query.toLowerCase().includes(k));
};

app.post("/search", async (req, reply) => {
  const { session_id, query, site_url } = req.body;
  const startedAt = Date.now();

  try {
    // 1. Perform Original Structured Search (e.g., Supabase query)
    // Replace this with your specific DB search logic if it differs
    const { data: dbData } = await supabase
      .from("structured_data")
      .select("*")
      .textSearch("summary", query)
      .limit(3);

    let response = {
      results: dbData || [],
      confidence: dbData?.length > 0 ? 0.8 : 0,
      query
    };

    // 2. CHECK FALLBACK CONDITIONS
    const hasNoResults = response.results.length === 0;
    const isLowConfidence = response.confidence < 0.6;
    const isMissingPrice = isProductIntent(query) && !response.results.some(r => r.price);

    if ((hasNoResults || isLowConfidence || isMissingPrice) && site_url) {
      req.log.info({ query, reason: hasNoResults ? "none" : isMissingPrice ? "no_price" : "low_conf" }, "[fallback] Triggering Playwright");

      const liveData = await browserSearchWithRetry({
        siteUrl: site_url,
        query: query,
        logger: req.log
      });

      if (liveData.ok && liveData.results.length > 0) {
        return reply.send({
          results: [...liveData.results, ...response.results],
          confidence: 0.95,
          fallback_triggered: true,
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
app.listen({ port, host: "0.0.0.0" });

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
