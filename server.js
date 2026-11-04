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
app.use(express.json({ limit: "6mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 25, standardHeaders: "draft-7", legacyHeaders: false }));
app.use(express.static("public"));

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

app.listen(PORT, () => {
  console.log(`Nova AI running on port ${PORT}`);
  if (!API_KEY) console.warn("Missing GEMINI_API_KEY.");
});
