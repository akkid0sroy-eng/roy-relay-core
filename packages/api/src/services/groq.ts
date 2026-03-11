/**
 * Groq LLM service — chat completions with fallback model and timeout.
 *
 * Uses the server's GROQ_API_KEY by default, or a user-supplied key
 * if the user has connected a custom Groq integration.
 */

import Groq from "groq-sdk";
import type { HistoryMessage } from "@relay/core";

const DEFAULT_MODEL    = "llama-3.3-70b-versatile";
const FALLBACK_MODEL   = "llama-3.1-8b-instant";
const VISION_MODEL     = "llama-3.2-11b-vision-preview";
const WHISPER_MODEL    = "whisper-large-v3";
const TIMEOUT_MS       = 30_000;
const MAX_RETRY_ATTEMPTS = 2;

export interface CallGroqOptions {
  history?: HistoryMessage[];
  model?: string;
  /** User-supplied API key override; falls back to GROQ_API_KEY env var. */
  apiKey?: string;
}

export async function callGroq(
  prompt: string,
  options: CallGroqOptions = {}
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const groq = new Groq({ apiKey });
  const primaryModel = options.model ?? DEFAULT_MODEL;

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    ...(options.history ?? []),
    { role: "user", content: prompt },
  ];

  const callModel = async (model: string): Promise<string> => {
    const completion = await Promise.race([
      groq.chat.completions.create({ model, messages }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Groq timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
      ),
    ]);
    return (completion.choices[0]?.message?.content ?? "").trim();
  };

  const withRetry = async (model: string): Promise<string> => {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await callModel(model);
      } catch (err: any) {
        const isTransient =
          err.message?.includes("timeout") ||
          (err.status ?? 0) >= 500 ||
          err.code === "ECONNRESET";
        if (!isTransient || attempt === MAX_RETRY_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error("Unreachable");
  };

  try {
    return await withRetry(primaryModel);
  } catch (err: any) {
    if (err instanceof Groq.RateLimitError) {
      console.warn(`Rate limit on ${primaryModel}, falling back to ${FALLBACK_MODEL}`);
      try {
        return await withRetry(FALLBACK_MODEL);
      } catch {
        return "Rate limit reached. Please try again in a moment.";
      }
    }
    console.error("Groq error:", err.message);
    throw err;
  }
}

// ── Vision ─────────────────────────────────────────────────────────────────────

/**
 * Send a text prompt + image to the Groq vision model.
 * The image is passed as a base64 data-URL in the image_url content block.
 * History is not supported for vision calls (v1 limitation).
 */
export async function callGroqVision(
  prompt: string,
  image: { base64: string; mimeType: string },
  options: { apiKey?: string } = {}
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const groq = new Groq({ apiKey });
  const dataUrl = `data:${image.mimeType};base64,${image.base64}`;

  const completion = await Promise.race([
    groq.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text",      text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Groq vision timeout after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS
      )
    ),
  ]);

  return (completion.choices[0]?.message?.content ?? "").trim();
}

// ── Audio transcription ────────────────────────────────────────────────────────

/**
 * Transcribe audio using Groq Whisper.
 * Accepts any format Telegram sends (ogg/oga for voice, mp3/m4a for audio).
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  options: { apiKey?: string } = {}
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");

  const groq = new Groq({ apiKey });

  const transcription = await Promise.race([
    groq.audio.transcriptions.create({
      file:  new File([audioBuffer], filename),
      model: WHISPER_MODEL,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Groq transcription timeout after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS
      )
    ),
  ]);

  return transcription.text.trim();
}
