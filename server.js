import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";

const app = Fastify({ logger: true });

// ── Auth middleware ───────────────────────────────────────────────────────────
const WORKER_SECRET = process.env.WORKER_SECRET;

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return; // health check skips auth
  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Supabase client ───────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

// ── Text search helpers ───────────────────────────────────────────────────────

/**
 * Score a text block against query keywords.
 * Returns { score, excerpts[] }
 */
function scoreText(text, keywords) {
  if (!text || !keywords.length) return { score: 0, excerpts: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const excerpts = [];

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    let idx = lower.indexOf(kwLower);
    while (idx !== -1) {
      score += 1;
      // Extract ±120 chars around the match
      const start = Math.max(0, idx - 120);
      const end = Math.min(text.length, idx + kw.length + 120);
      const excerpt = text.slice(start, end).trim();
      if (!excerpts.includes(excerpt)) excerpts.push(excerpt);
      idx = lower.indexOf(kwLower, idx + 1);
    }
  }

  return { score, excerpts: excerpts.slice(0, 5) };
}

/**
 * Tokenise a natural-language query into keywords.
 * Removes stop words, returns unique stems ≥3 chars.
 */
function tokenise(query) {
  const STOP = new Set([
    "и", "в", "на", "се", "за", "от", "с", "е", "да", "не", "ли",
    "но", "а", "или", "как", "що", "ще", "сте", "има", "при", "до",
    "the", "a", "an", "of", "in", "is", "for", "to", "what", "how",
  ]);
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\w\sа-яА-Я]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
    ),
  ];
}

/**
 * Search through pages[] inside structured_data of a session.
 */
function searchPages(pages, keywords, limit = 5) {
  const results = [];

  for (const page of pages ?? []) {
    const content =
      (page.content ?? "") +
      " " +
      JSON.stringify(page.structured ?? {});

    const { score, excerpts } = scoreText(content, keywords);
    if (score > 0) {
      results.push({
        url: page.url ?? "",
        title: page.title ?? "",
        pageType: page.pageType ?? "general",
        score,
        excerpts,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Search the SUMMARY text of a session.
 */
function searchSummary(summary, keywords) {
  if (!summary) return [];
  const { score, excerpts } = scoreText(summary, keywords);
  if (score === 0) return [];
  return [{ source: "summary", score, excerpts }];
}

// ── Live fetch fallback ───────────────────────────────────────────────────────
async function liveFetch(siteUrl, keywords, limit = 3) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(siteUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "NEO-SearchWorker/1.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const html = await res.text();
    // Strip tags, decode entities crudely
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s{2,}/g, " ");

    const { score, excerpts } = scoreText(text, keywords);
    if (score === 0) return [];
    return [{ source: "live_fetch", url: siteUrl, score, excerpts: excerpts.slice(0, limit) }];
  } catch {
    return [];
  }
}

// ── Main search endpoint ──────────────────────────────────────────────────────
// POST /search
// Body: { session_id, query, site_url? }
// Returns: { results[], keywords[], elapsed_ms }
app.post("/search", async (req, reply) => {
  const t0 = Date.now();
  const { session_id, query, site_url } = req.body ?? {};

  if (!session_id || !query) {
    return reply.code(400).send({ error: "session_id and query are required" });
  }

  const keywords = tokenise(query);
  if (!keywords.length) {
    return reply.send({ results: [], keywords, elapsed_ms: Date.now() - t0 });
  }

  const supabase = getSupabase();
  let results = [];

  // 1️⃣ Fetch session from Supabase
  const { data: session, error } = await supabase
    .from("demo_sessions")
    .select("summary, structured_data, url")
    .eq("id", session_id)
    .single();

  if (error || !session) {
    app.log.warn({ session_id, error: error?.message }, "Session not found");
  } else {
    const pages = session.structured_data?.pages ?? [];
    const summary = session.structured_data?.cleaned_summary ?? session.summary ?? "";
    const sessionSiteUrl = site_url || session.url || "";

    // 2️⃣ Search summary
    const summaryHits = searchSummary(summary, keywords);
    results.push(...summaryHits);

    // 3️⃣ Search crawled pages
    const pageHits = searchPages(pages, keywords, 8);
    results.push(...pageHits);

    // 4️⃣ If no results and we have a site URL → live fetch
    if (results.length === 0 && sessionSiteUrl) {
      app.log.info({ sessionSiteUrl, keywords }, "No local results — trying live fetch");
      const liveHits = await liveFetch(sessionSiteUrl, keywords, 3);
      results.push(...liveHits);
    }
  }

  // Deduplicate and sort by score
  const seen = new Set();
  const deduped = results
    .filter((r) => {
      const key = r.url ?? r.source ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  return reply.send({
    results: deduped,
    keywords,
    elapsed_ms: Date.now() - t0,
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3210");
await app.listen({ port: PORT, host: "0.0.0.0" });
