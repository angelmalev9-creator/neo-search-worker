import Fastify from "fastify";
import { createClient } from "@supabase/supabase-js";

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024,
});

// ── Auth middleware ───────────────────────────────────────────────────────────
const WORKER_SECRET = process.env.WORKER_SECRET;

app.addHook("preHandler", async (req, reply) => {
  if (req.url === "/health") return;

  const auth = req.headers["authorization"] ?? "";
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Supabase client ───────────────────────────────────────────────────────────
let supabaseSingleton = null;

function getSupabase() {
  if (supabaseSingleton) return supabaseSingleton;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  supabaseSingleton = createClient(url, key, {
    auth: { persistSession: false },
  });

  return supabaseSingleton;
}

// ── Generic query understanding helpers ──────────────────────────────────────
const STOP = new Set([
  "и", "в", "на", "се", "за", "от", "с", "е", "да", "не", "ли", "но", "а", "или",
  "как", "какво", "кой", "коя", "кои", "ще", "сте", "има", "имате", "при", "до", "по",
  "искам", "търся", "търси", "потърси", "кажи", "покажи", "дали", "може", "можете", "моля",
  "the", "a", "an", "of", "in", "is", "for", "to", "what", "how", "with", "and", "or",
  "show", "find", "search", "tell", "about", "have", "any", "please",
]);

const PRODUCTISH_HINTS = [
  "цена", "цени", "размер", "размери", "модел", "налич", "брой", "цвят", "материал",
  "купя", "продукт", "продукти", "артикул", "см", "mm", "мм", "cm", "x",
  "price", "prices", "size", "sizes", "model", "stock", "buy", "product", "products",
];

const PAGE_TYPE_WEIGHTS = {
  product: 20,
  products: 20,
  category: 10,
  collection: 10,
  listing: 10,
  service: 8,
  package: 8,
  booking: 8,
  general: 0,
};

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[“”„"'`´]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/[×х]/g, "x")
    .replace(/[()\[\]{}|/\\,:;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenise(query) {
  return [...new Set(
    normalizeText(query)
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
  )];
}

function parseDimensions(query) {
  const q = normalizeText(query);
  const dims = [];
  const re = /(\d{1,4})\s*(?:x|на)\s*(\d{1,4})(?:\s*(см|cm|мм|mm|m))?/g;
  let m;

  while ((m = re.exec(q))) {
    const a = m[1];
    const b = m[2];
    const unit = m[3] || "";

    dims.push({
      a,
      b,
      unit,
      canonical: `${a}x${b}${unit ? unit : ""}`,
      variants: [...new Set([
        `${a}x${b}`,
        `${a} x ${b}`,
        `${a} на ${b}`,
        `${a}/${b}`,
        unit ? `${a}x${b}${unit}` : "",
        unit ? `${a} x ${b} ${unit}` : "",
        unit ? `${a} ${unit} x ${b} ${unit}` : "",
      ].filter(Boolean))],
    });
  }

  return dims;
}

function buildIntent(query) {
  const normalized = normalizeText(query);
  const tokens = tokenise(query);
  const dimensions = parseDimensions(query);
  const productish =
    PRODUCTISH_HINTS.some((h) => normalized.includes(h)) || dimensions.length > 0;

  return {
    raw: String(query ?? ""),
    normalized,
    tokens,
    dimensions,
    productish,
  };
}

function excerptAround(text, idx, len = 160) {
  const raw = String(text ?? "");
  const start = Math.max(0, idx - len);
  const end = Math.min(raw.length, idx + len);
  return raw.slice(start, end).replace(/\s+/g, " ").trim();
}

function addExcerpt(excerpts, value) {
  if (!value) return;
  if (!excerpts.includes(value)) excerpts.push(value);
}

function classifyDocument({ title, url, pageType, text }) {
  const hay = normalizeText(`${title || ""} ${url || ""} ${pageType || ""} ${text || ""}`);

  const productSignals = [
    /\b(product|products|shop|sku|ean|модел|артикул|купи|добави в количката|цена|лв|€|eur|usd|налич)/,
    /\b(размер|размери|см|cm|мм|mm|цвят|материал|марка|бренд)/,
  ];

  const serviceSignals = [
    /\b(service|services|услуга|услуги|процедура|package|packages|пакет|пакети|лечение|консултация)/,
  ];

  const faqSignals = [
    /\b(faq|въпроси|често задавани|questions|answers)/,
  ];

  const bookingSignals = [
    /\b(book|booking|reserve|reservation|резервац|настаняване|нощувк|check-in|check out)/,
  ];

  let kind = "general";
  if (productSignals.some((re) => re.test(hay))) kind = "productish";
  else if (bookingSignals.some((re) => re.test(hay))) kind = "booking";
  else if (serviceSignals.some((re) => re.test(hay))) kind = "service";
  else if (faqSignals.some((re) => re.test(hay))) kind = "faq";

  return { kind };
}

function scoreDocument({ text, title = "", url = "", pageType = "general", intent, source = "page" }) {
  const fullText = String(text ?? "");
  const lower = normalizeText(`${title} ${url} ${pageType} ${fullText}`);
  const excerpts = [];
  const matched = [];
  let score = 0;

  const classification = classifyDocument({ title, url, pageType, text: fullText });

  score += PAGE_TYPE_WEIGHTS[String(pageType || "general").toLowerCase()] || 0;

  if (intent.productish) {
    if (classification.kind === "productish") score += 18;
    if (classification.kind === "faq") score -= 8;
  }

  if (intent.normalized && lower.includes(intent.normalized)) {
    score += 60;
    matched.push(intent.normalized);
    addExcerpt(excerpts, excerptAround(fullText, Math.max(0, lower.indexOf(intent.normalized))));
  }

  let tokenHits = 0;
  for (const token of intent.tokens) {
    const idx = lower.indexOf(token);
    if (idx === -1) continue;

    tokenHits += 1;
    matched.push(token);

    const titleNorm = normalizeText(title);
    const urlNorm = normalizeText(url);

    if (titleNorm.includes(token)) score += 16;
    else if (urlNorm.includes(token)) score += 12;
    else score += 7;

    addExcerpt(excerpts, excerptAround(fullText, Math.max(0, idx)));
  }

  if (tokenHits >= 2) score += tokenHits * 6;
  if (tokenHits >= 4) score += 14;

  let dimensionHits = 0;
  for (const dim of intent.dimensions) {
    let hit = false;

    for (const variant of dim.variants) {
      const idx = lower.indexOf(variant);
      if (idx !== -1) {
        hit = true;
        dimensionHits += 1;
        score += 35;
        matched.push(variant);
        addExcerpt(excerpts, excerptAround(fullText, Math.max(0, idx)));
        break;
      }
    }

    if (!hit && lower.includes(dim.a) && lower.includes(dim.b)) {
      dimensionHits += 1;
      score += 14;
      matched.push(`${dim.a}+${dim.b}`);
    }
  }

  if (source === "structured") score += 8;
  if (source === "summary") score -= 4;

  if (intent.tokens.length >= 2 && tokenHits === 1) score -= 10;
  if (intent.productish && classification.kind === "general" && tokenHits < 2 && dimensionHits === 0) {
    score -= 16;
  }

  return {
    score,
    matched: [...new Set(matched)].slice(0, 12),
    excerpts: excerpts.slice(0, 4),
    classification,
    tokenHits,
    dimensionHits,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function flattenValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(flattenValue).filter(Boolean).join(" ");
  }
  return "";
}

function toSearchDocuments(session) {
  const docs = [];
  const structured = session?.structured_data ?? {};
  const summary = String(session?.summary ?? "");
  const pageMap = safeArray(structured?.page_map ?? structured?.pages);

  for (const p of pageMap) {
    const title = p?.title || p?.name || "";
    const url = p?.url || p?.link || "";
    const pageType = p?.page_type || p?.type || "general";
    const text = [
      p?.summary,
      p?.content,
      p?.text,
      p?.description,
      Array.isArray(p?.bullets) ? p.bullets.join(" ") : "",
      flattenValue(p?.metadata),
    ].filter(Boolean).join(" \n ");

    if (title || url || text) {
      docs.push({
        id: `page:${url || title}`,
        title,
        url,
        pageType,
        text,
        source: "structured",
      });
    }
  }

  const sections = [
    ["products", structured?.products],
    ["services", structured?.services],
    ["packages", structured?.packages],
    ["pricing", structured?.pricing],
    ["faq", structured?.faq],
    ["rooms", structured?.rooms],
    ["categories", structured?.categories],
  ];

  for (const [sectionName, items] of sections) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const title = item?.title || item?.name || item?.label || "";
      const url = item?.url || item?.link || "";
      const pageType = sectionName === "products" ? "product" : sectionName;
      const text = [
        item?.summary,
        item?.description,
        item?.details,
        item?.price,
        item?.price_text,
        item?.availability,
        item?.sku,
        item?.model,
        Array.isArray(item?.features) ? item.features.join(" ") : "",
        Array.isArray(item?.bullets) ? item.bullets.join(" ") : "",
        flattenValue(item),
      ].filter(Boolean).join(" \n ");

      if (title || url || text) {
        docs.push({
          id: `${sectionName}:${url || title}`,
          title,
          url,
          pageType,
          text,
          source: "structured",
        });
      }
    }
  }

  if (summary) {
    docs.push({
      id: "summary:root",
      title: session?.site_url || "Site summary",
      url: session?.site_url || "",
      pageType: "general",
      text: summary,
      source: "summary",
    });
  }

  return docs;
}

function rankDocuments(documents, intent) {
  const ranked = [];

  for (const doc of documents) {
    const scored = scoreDocument({
      text: doc.text,
      title: doc.title,
      url: doc.url,
      pageType: doc.pageType,
      intent,
      source: doc.source,
    });

    if (scored.score <= 0) continue;

    ranked.push({
      ...doc,
      ...scored,
    });
  }

  ranked.sort((a, b) => b.score - a.score);

  const deduped = [];
  const seen = new Set();

  for (const item of ranked) {
    const key = `${item.url || ""}::${normalizeText(item.title || "")}::${item.source || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 8) break;
  }

  return deduped;
}

function buildSearchResponse(results, intent, startedAt) {
  const top = results[0];

  const confidence = !top
    ? 0
    : Math.min(
        1,
        (
          top.score >= 120 ? 0.94 :
          top.score >= 90 ? 0.84 :
          top.score >= 70 ? 0.72 :
          top.score >= 50 ? 0.58 : 0.42
        )
      );

  const needs_clarification =
    results.length === 0 ||
    confidence < 0.6 ||
    (intent.productish && (top?.dimensionHits ?? 0) === 0 && intent.dimensions.length > 0);

  return {
    ok: true,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      page_type: r.pageType,
      score: r.score,
      matched: r.matched,
      excerpts: r.excerpts,
      source: r.source,
      kind: r.classification?.kind || "general",
    })),
    confidence,
    needs_clarification,
    intent,
    elapsed_ms: Date.now() - startedAt,
  };
}

async function loadSessionById(supabase, sessionId) {
  const attempts = [
    () =>
      supabase
        .from("demo_sessions")
        .select("id, site_url, summary, structured_data")
        .eq("id", sessionId)
        .maybeSingle(),

    // fallback ако някъде schema е стар/смесен
    () =>
      supabase
        .from("demo_sessions")
        .select("*")
        .eq("id", sessionId)
        .maybeSingle(),
  ];

  let lastError = null;

  for (const attempt of attempts) {
    const { data, error } = await attempt();
    if (!error && data) return data;
    if (error) lastError = error;
  }

  if (lastError) {
    throw new Error(lastError.message || "Failed to load session");
  }

  return null;
}

app.get("/health", async () => ({
  ok: true,
  service: "neo-search-worker",
}));

app.post("/search", async (req, reply) => {
  const startedAt = Date.now();

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const session_id = String(body.session_id || "").trim();
    const query = String(body.query || "").trim();
    const site_url = String(body.site_url || "").trim();

    if (!session_id || !query) {
      return reply.code(400).send({
        error: "session_id and query are required",
      });
    }

    const supabase = getSupabase();
    const session = await loadSessionById(supabase, session_id);

    if (!session) {
      return reply.code(404).send({
        error: "Session not found",
        details: `No demo_sessions row found for id=${session_id}`,
      });
    }

    const intent = buildIntent(query);
    const docs = toSearchDocuments({
      ...session,
      site_url: site_url || session.site_url || "",
    });

    if (!docs.length) {
      return reply.send({
        ok: true,
        results: [],
        confidence: 0,
        needs_clarification: true,
        intent,
        elapsed_ms: Date.now() - startedAt,
        warning: "Session has no searchable summary or structured_data",
      });
    }

    const ranked = rankDocuments(docs, intent);
    const response = buildSearchResponse(ranked, intent, startedAt);

    return reply.send(response);
  } catch (err) {
    req.log.error(err, "search failed");

    return reply.code(500).send({
      error: "Search failed",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

const port = Number(process.env.PORT || 3210);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`neo-search-worker listening on :${port}`);
});
