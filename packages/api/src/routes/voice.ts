/**
 * Voice routes
 *
 * POST /api/voice/transcribe  — accepts audio blob, returns { text }
 * POST /api/voice/tts         — accepts { text }, returns audio/mpeg from ElevenLabs
 */

import { Hono } from "hono";
import { transcribeAudio } from "../services/groq.ts";
import { getSecrets } from "../db/integrations.ts";

const voice = new Hono();

// ── STT: audio → text via Groq Whisper ───────────────────────────────────────
voice.post("/transcribe", async (c) => {
  const userId = c.get("userId");

  const formData = await c.req.formData();
  const file = formData.get("audio") as File | null;
  if (!file) return c.json({ error: "No audio file" }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = (file as any).name ?? "audio.webm";

  // Use user's Groq key if available, fall back to server key
  const groqSecrets = await getSecrets<{ api_key: string }>(userId, "groq");
  const apiKey = groqSecrets?.api_key ?? process.env.GROQ_API_KEY;

  try {
    const text = await transcribeAudio(buffer, filename, { apiKey });
    return c.json({ text });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── TTS: text → audio via ElevenLabs ─────────────────────────────────────────
voice.post("/tts", async (c) => {
  const userId = c.get("userId");
  const { text } = await c.req.json<{ text: string }>();
  if (!text) return c.json({ error: "No text" }, 400);

  const secrets = await getSecrets<{ api_key: string; voice_id?: string }>(userId, "elevenlabs");
  if (!secrets?.api_key) return c.json({ error: "ElevenLabs not configured" }, 404);

  const voiceId = secrets.voice_id ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel (default)

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": secrets.api_key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) return c.json({ error: "ElevenLabs error" }, 502);

  const audio = await res.arrayBuffer();
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
});

export default voice;
