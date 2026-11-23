// Groq-backed helpers: reply drafting and speech transcription.
// Both return null on any failure or when no key is configured, so callers
// can fall back deterministically.

const CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const AUDIO_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const CHAT_MODEL = "llama-3.3-70b-versatile";
const AUDIO_MODEL = "whisper-large-v3-turbo";

const SYSTEM_PROMPT =
  "Draft a brief friendly reply to the message, one or two sentences, ready to send. " +
  "Do not put quotes around it and do not add any preamble.";

function contextText(ctx) {
  if (!ctx) return "";
  const message = ctx.message ?? ctx;
  const lines = [];
  if (ctx.source?.title) lines.push(`Chat: ${ctx.source.title}`);
  if (message.from) lines.push(`From: ${message.from}`);
  if (message.text) lines.push(`Message: ${message.text}`);
  if (Array.isArray(ctx.recent)) {
    for (const m of ctx.recent) {
      if (m?.text) lines.push(`- ${m.from ?? ""}: ${m.text}`);
    }
  }
  return lines.join("\n");
}

export function createAi({ groqKey, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function draftReply(ctx) {
    if (!groqKey || typeof doFetch !== "function") return null;
    try {
      const res = await doFetch(CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          temperature: 0.7,
          max_tokens: 120,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: contextText(ctx) || "Draft a short friendly reply." },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      let text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") return null;
      text = text.trim();
      if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        text = text.slice(1, -1).trim();
      }
      return text ? text : null;
    } catch {
      return null;
    }
  }

  async function transcribe(wavBytes) {
    if (!groqKey || typeof doFetch !== "function") return null;
    try {
      const bytes =
        wavBytes instanceof Uint8Array
          ? wavBytes
          : new Uint8Array(wavBytes instanceof ArrayBuffer ? wavBytes : []);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
      form.append("model", AUDIO_MODEL);
      const res = await doFetch(AUDIO_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${groqKey}` },
        body: form,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      return text ? text : null;
    } catch {
      return null;
    }
  }

  return { draftReply, transcribe };
}
