import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";

const app = Fastify({ logger: true });

const WORKER_SECRET = process.env.WORKER_SECRET;

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;
  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/\bсм\.?\b/giu, " cm ")
    .replace(/[^\p{L}\p{N}\s.x-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenise(query) {
  const STOP = new Set([
    "и", "в", "на", "се", "за", "от", "с", "е", "да", "не", "ли",
    "но", "а", "или", "как", "що", "ще", "сте", "има", "при", "до",
    "искам", "търся", "търсите", "търсяте", "кажи", "кажете", "покажи", "дай",
    "има", "ако", "като", "about", "the", "a", "an", "of", "in", "is",
    "for", "to", "what", "how", "with", "have", "has",
  ]);

  const base = normalizeText(query)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));

  const dims = extractDimensionTokens(query);
  return [...new Set([...base, ...dims])];
}

function extractDimensionTokens(text) {
  const out = new Set();
  const raw = String(text ?? "").toLowerCase().replace(/×/g, "x");

  for (const m of raw.matchAll(/\b(\d{1,4})\s*[xх]\s*(\d{1,4})\b/gu)) {
    out.add(`${m[1]}x${m[2]}`);
    out.add(`${m[1]} ${m[2]}`);
  }

  for (const m of raw.matchAll(/\b(\d{1,4})\s+на\s+(\d{1,4})\b/gu)) {
    out.add(`${m[1]}x${m[2]}`);
    out.add(`${m[1]} ${m[2]}`);
  }

  return [...out];
}

function inferIntent(tokens) {
  const set = new Set(tokens);
  return {
    wantsCarpet: ["килим", "килими", "пътека", "пътеки", "runner", "carpet", "rug"].some((t) => set.has(t)),
    wantsFurniture: ["гардероб", "легло", "диван", "маса", "стол"].some((t) => set.has(t)),
    wantsPromo: ["промо", "промоция", "намаление", "оферта", "offers", "sale"].some((t) => set.has(t)),
  };
}

function stringifySafe(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

function makeExcerpt(text, tokens, maxLen = 220) {
  const original = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!original) return "";
  const lower = normalizeText(original);

  let bestIdx = 0;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1) {
      bestIdx = idx;
      break;
    }
  }

  const start = Math.max(0, bestIdx - 80);
  const end = Math.min(original.length, start + maxLen);
  return original.slice(start, end).trim();
}

function scoreCandidate(candidate, tokens, queryDims, intent) {
  const hay = normalizeText(candidate.searchText);
  if (!hay) return { score: 0, matched: [] };

  let score = 0;
  const matched = [];

  for (const token of tokens) {
    if (!token) continue;
    if (hay.includes(token)) {
      score += token.length >= 5 ? 3 : 2;
      matched.push(token);
    }
  }

  for (const dim of queryDims) {
    if (hay.includes(dim)) {
      score += 6;
      matched.push(dim);
    }
  }

  if (candidate.kind === "product") score += 4;
  if (candidate.kind === "category") score += 2;
  if (candidate.kind === "page") score += 1;

  const title = normalizeText(candidate.title);
  const url = normalizeText(candidate.url);

  if (intent.wantsCarpet) {
    if (hay.includes("килим") || hay.includes("пътека") || title.includes("килим") || title.includes("пътека") || url.includes("kilim") || url.includes("carpet")) {
      score += 8;
    } else {
      score -= 6;
    }
  }

  if (intent.wantsFurniture) {
    if (hay.includes("гардероб") || hay.includes("легло") || hay.includes("диван")) score += 8;
  }

  if (intent.wantsPromo && (hay.includes("промо") || hay.includes("намал") || url.includes("promotions"))) {
    score += 5;
  }

  if (candidate.kind === "summary") score -= 4;
  if (candidate.kind === "page" && url.includes("/promotions")) score -= 2;

  return { score, matched: [...new Set(matched)] };
}

function pushCandidate(list, candidate) {
  const searchText = [candidate.title, candidate.subtitle, candidate.text, candidate.metaText, candidate.url]
    .filter(Boolean)
    .join(" \n ");

  if (!searchText.trim()) return;

  list.push({
    kind: candidate.kind || "block",
    url: candidate.url || "",
    title: candidate.title || "",
    subtitle: candidate.subtitle || "",
    text: candidate.text || "",
    metaText: candidate.metaText || "",
    searchText,
  });
}

function flattenStructuredData(structuredData) {
  const items = [];
  if (!structuredData || typeof structuredData !== "object") return items;

  const pages = asArray(structuredData.pages);
  for (const page of pages) {
    const pageText = [
      page.title,
      page.url,
      page.pageType,
      page.content,
      stringifySafe(page.structured),
    ].filter(Boolean).join(" \n ");

    pushCandidate(items, {
      kind: "page",
      url: page.url,
      title: page.title || page.pageType || "Page",
      text: pageText,
    });
  }

  const sections = asArray(structuredData.sections);
  for (const section of sections) {
    pushCandidate(items, {
      kind: "section",
      url: section.url || "",
      title: section.title || section.name || "Section",
      subtitle: section.type || "",
      text: stringifySafe(section),
    });
  }

  const products = [
    ...asArray(structuredData.products),
    ...asArray(structuredData.catalog_products),
    ...asArray(structuredData.featured_products),
    ...asArray(structuredData.promotions),
    ...asArray(structuredData.offers),
  ];

  for (const product of products) {
    pushCandidate(items, {
      kind: "product",
      url: product.url || product.link || "",
      title: product.title || product.name || product.product_name || "Product",
      subtitle: [product.category, product.brand, product.color, product.size].filter(Boolean).join(" • "),
      text: stringifySafe(product),
      metaText: [product.price, product.currency, product.sku].filter(Boolean).join(" "),
    });
  }

  const categories = [
    ...asArray(structuredData.categories),
    ...asArray(structuredData.catalog_categories),
    ...asArray(structuredData.navigation),
  ];

  for (const cat of categories) {
    pushCandidate(items, {
      kind: "category",
      url: cat.url || cat.link || "",
      title: cat.title || cat.name || cat.label || "Category",
      text: stringifySafe(cat),
    });
  }

  const faqs = asArray(structuredData.faq || structuredData.faqs);
  for (const faq of faqs) {
    pushCandidate(items, {
      kind: "faq",
      title: faq.question || faq.q || "FAQ",
      text: [faq.question, faq.answer].filter(Boolean).join(" \n "),
    });
  }

  const genericKeys = [
    "services",
    "packages",
    "pricing",
    "pricing_cards",
    "offers_by_category",
    "inventory",
  ];

  for (const key of genericKeys) {
    for (const entry of asArray(structuredData[key])) {
      pushCandidate(items, {
        kind: key,
        url: entry.url || entry.link || "",
        title: entry.title || entry.name || key,
        text: stringifySafe(entry),
      });
    }
  }

  return items;
}

function searchStructuredData(structuredData, query, limit = 8) {
  const tokens = tokenise(query);
  const queryDims = extractDimensionTokens(query);
  const intent = inferIntent(tokens);
  const candidates = flattenStructuredData(structuredData);

  const scored = [];
  for (const candidate of candidates) {
    const { score, matched } = scoreCandidate(candidate, tokens, queryDims, intent);
    if (score <= 0) continue;

    scored.push({
      source: "structured_data",
      kind: candidate.kind,
      url: candidate.url,
      title: candidate.title,
      subtitle: candidate.subtitle,
      score,
      matched,
      excerpts: [makeExcerpt(candidate.searchText, matched.length ? matched : tokens)],
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchSummary(summary, query) {
  const tokens = tokenise(query);
  if (!summary || !tokens.length) return [];

  const hay = normalizeText(summary);
  let score = 0;
  const matched = [];
  for (const token of tokens) {
    if (hay.includes(token)) {
      score += token.length >= 5 ? 2 : 1;
      matched.push(token);
    }
  }

  if (!score) return [];
  return [{
    source: "summary",
    kind: "summary",
    score,
    matched,
    excerpts: [makeExcerpt(summary, matched.length ? matched : tokens, 260)],
  }];
}

async function liveFetch(siteUrl, query, limit = 3) {
  try {
    const tokens = tokenise(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(siteUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "NEO-SearchWorker/2.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s{2,}/g, " ");

    const hay = normalizeText(text);
    let score = 0;
    const matched = [];
    for (const token of tokens) {
      if (hay.includes(token)) {
        score += 1;
        matched.push(token);
      }
    }

    if (!score) return [];
    return [{
      source: "live_fetch",
      kind: "live_fetch",
      url: siteUrl,
      score,
      matched,
      excerpts: [makeExcerpt(text, matched.length ? matched : tokens, 220)],
    }].slice(0, limit);
  } catch {
    return [];
  }
}

function dedupeResults(results, limit = 8) {
  const seen = new Set();
  return results
    .filter((r) => {
      const key = [r.source, r.kind, r.url || "", r.title || "", (r.excerpts || [])[0] || ""].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

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

  const { data: session, error } = await supabase
    .from("demo_sessions")
    .select("summary, structured_data, url")
    .eq("id", session_id)
    .single();

  if (error || !session) {
    app.log.warn({ session_id, error: error?.message }, "Session not found");
  } else {
    const structuredData = session.structured_data ?? {};
    const summary = structuredData.cleaned_summary ?? session.summary ?? "";
    const sessionSiteUrl = site_url || session.url || "";

    const structuredHits = searchStructuredData(structuredData, query, 8);
    results.push(...structuredHits);

    if (results.length < 3) {
      const summaryHits = searchSummary(summary, query);
      results.push(...summaryHits);
    }

    if (results.length === 0 && sessionSiteUrl) {
      app.log.info({ sessionSiteUrl, keywords }, "No local results — trying live fetch");
      const liveHits = await liveFetch(sessionSiteUrl, query, 3);
      results.push(...liveHits);
    }
  }

  const deduped = dedupeResults(results, 8);

  return reply.send({
    results: deduped,
    keywords,
    elapsed_ms: Date.now() - t0,
  });
});

app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

const PORT = parseInt(process.env.PORT ?? "3210");
await app.listen({ port: PORT, host: "0.0.0.0" });
