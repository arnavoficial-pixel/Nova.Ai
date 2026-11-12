import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.set("trust proxy", 1);
app.use(express.json({ limit: "6mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 25, standardHeaders: "draft-7", legacyHeaders: false }));
app.use(express.static("public"));
app.use("/siara", express.static("siara", { index: "index.html" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, aiConfigured: Boolean(ai) }));

app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) return res.status(503).json({ error: "AI is not configured. Add GEMINI_API_KEY in the host environment." });
    const { messages, model } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20)
      return res.status(400).json({ error: "Send between 1 and 20 conversation messages." });

    const safeMessages = messages.map((m) => {
      if (!["user", "model"].includes(m?.role) || !Array.isArray(m?.parts)) throw new Error("Invalid message format.");
      const parts = m.parts.map((p) => {
        if (typeof p.text === "string") {
          if (p.text.length > 20000) throw new Error("Message is too long.");
          return { text: p.text };
        }
        if (p.inlineData && typeof p.inlineData.data === "string") {
          const mimeType = p.inlineData.mimeType;
          if (!["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(mimeType))
            throw new Error("Unsupported attachment type.");
          if (p.inlineData.data.length > 5_600_000) throw new Error("Attachment is too large.");
          return { inlineData: { mimeType, data: p.inlineData.data } };
        }
        throw new Error("Unsupported message part.");
      });
      return { role: m.role, parts };
    });
    const chosenModel = model === "gemini-3.7-flash" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const result = await ai.models.generateContent({
      model: chosenModel,
      contents: safeMessages,
      config: {
        systemInstruction: "You are Nova AI, a helpful, accurate, friendly assistant. Explain clearly, admit uncertainty, and use the user's language when practical. Do not claim to be ChatGPT or OpenAI.",
        temperature: 0.7
      }
    });
    return res.json({ text: result.text ?? "" });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({ error: String(error?.message || "Unexpected server error").slice(0, 500) });
  }
});


const fixedSearchProviders = [
  process.env.SEARXNG_URL,
  "https://searx.be", "https://search.sapti.me", "https://searx.tiekoetter.com",
  "https://search.bus-hit.me", "https://searxng.site"
].filter(Boolean);

const decodeHtml = (value = "") => String(value)
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function parseHtmlSearch(html, category) {
  const results = [];
  const re = /<a[^>]+class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      let url = decodeHtml(m[1]);
      if (url.startsWith("//")) url = "https:" + url;
      if (url.startsWith("/url?")) url = new URL(url, "https://html.duckduckgo.com").searchParams.get("uddg") || url;
      const title = decodeHtml(m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
      if (!title || !["http:", "https:"].includes(new URL(url).protocol)) continue;
      results.push({ title, url, snippet: "", source: new URL(url).hostname, category });
    } catch {}
  }
  return results;
}

let cachedInstances = [];
let instanceCacheAt = 0;
async function getSearxInstances() {
  if (cachedInstances.length && Date.now() - instanceCacheAt < 600000) return cachedInstances;
  try {
    const response = await fetch("https://searx.space/data/instances.json", {
      headers: { "Accept": "application/json", "User-Agent": "SIARA/1.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) {
      const data = await response.json();
      const entries = Object.entries(data.instances || {}).filter(([url, info]) =>
        /^https:\/\//.test(url) && !info?.network_type?.includes("onion") &&
        (info?.http?.status_code === 200 || info?.http?.status_code == null)
      );
      cachedInstances = entries.slice(0, 30).map(([url]) => url.replace(/\/$/, ""));
      instanceCacheAt = Date.now();
    }
  } catch {}
  return [...new Set([...fixedSearchProviders, ...cachedInstances])];
}

app.get("/api/siara/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 240);
  const mode = String(req.query.category || "web").toLowerCase();
  if (!q) return res.status(400).json({ error: "Type something to search." });
  const categoryMap = { web: "general", general: "general", images: "images", videos: "videos", news: "news", academic: "science", social: "general" };
  const category = categoryMap[mode] || "general";
  const query = mode === "social" ? q + " site:reddit.com OR site:quora.com" : q;
  const providers = await getSearxInstances();
  let lastError = "Search sources are temporarily busy.";

  for (const base of providers.slice(0, 14)) {
    try {
      const endpoint = new URL("/search", base);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("categories", category);
      endpoint.searchParams.set("language", "en");
      const response = await fetch(endpoint, {
        headers: {
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
          "User-Agent": "Mozilla/5.0 (compatible; SIARA/1.0; integrated search)",
          "Referer": base + "/"
        },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { lastError = "Search source returned " + response.status + "."; continue; }
      const raw = await response.text();
      let items = [];
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.results)) items = data.results.map(item => ({
          title: String(item.title || "Untitled result").slice(0, 300),
          url: String(item.url || ""),
          snippet: String(item.content || item.title || "").slice(0, 700),
          source: String(item.engine || item.source || "Web"),
          category: String(item.category || category),
          thumbnail: typeof item.thumbnail === "string" ? item.thumbnail : null,
          publishedDate: item.publishedDate || null
        }));
      } catch {
        items = parseHtmlSearch(raw, category);
      }
      items = items.filter(item => {
        try { return ["http:", "https:"].includes(new URL(item.url).protocol); } catch { return false; }
      });
      if (items.length) return res.json({ query: q, category: mode, results: items.slice(0, 20), provider: new URL(base).hostname });
      lastError = "Search source returned no readable results.";
    } catch (error) {
      lastError = String(error?.message || lastError).slice(0, 180);
    }
  }

  try {
    const endpoint = new URL("https://html.duckduckgo.com/html/");
    endpoint.searchParams.set("q", query);
    const response = await fetch(endpoint, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(9000)
    });
    if (response.ok) {
      const html = await response.text();
      const results = parseHtmlSearch(html, category).slice(0, 20);
      if (results.length) return res.json({ query: q, category: mode, results, provider: "DuckDuckGo HTML" });
      lastError = "Search providers did not return readable results.";
    } else lastError = "Fallback search returned " + response.status + ".";
  } catch (error) {
    lastError = String(error?.message || lastError).slice(0, 180);
  }

  return res.status(503).json({ error: lastError, hint: "Search providers are temporarily unavailable. Please retry in a moment." });
});

app.listen(PORT, () => {
  console.log(`Nova AI running on port ${PORT}`);
  if (!API_KEY) console.warn("Missing GEMINI_API_KEY.");
});
