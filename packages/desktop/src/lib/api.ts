const API_URL = (import.meta.env.VITE_API_URL as string) ?? "http://100.76.98.4:3000";

async function req<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(text), { status: res.status });
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface SendMessageResult {
  reply: string;
  action_id?: string;
  action_description?: string;
}

export interface Action {
  id: string;
  type: string;
  description: string;
  status: "pending" | "executing" | "approved" | "rejected" | "expired";
  result?: string;
  error?: string;
  created_at: string;
  expires_at: string;
}

export interface UserProfile {
  user_id: string;
  display_name?: string;
  timezone: string;
  ai_model: string;
  max_history: number;
  web_search: boolean;
  voice_mode: boolean;
  plan: "free" | "pro" | "team";
}

export interface Integration {
  id: string;
  provider: string;
  enabled: boolean;
  meta: Record<string, unknown>;
}

export const sendMessage = (token: string, content: string) =>
  req<SendMessageResult>("/api/messages", token, {
    method: "POST",
    body: JSON.stringify({ content, channel: "api" }),
  });

export const getHistory = (token: string, limit = 30) =>
  req<Message[]>(`/api/messages/history?limit=${limit}`, token);

export const listActions = (token: string) =>
  req<Action[]>("/api/actions", token);

export const approveAction = (token: string, id: string) =>
  req<{ ok: boolean; result: string }>(`/api/actions/${id}/approve`, token, { method: "POST" });

export const rejectAction = (token: string, id: string) =>
  req<{ ok: boolean }>(`/api/actions/${id}/reject`, token, { method: "POST" });

export const getProfile = (token: string) =>
  req<UserProfile>("/api/users/me", token);

export const updateProfile = (token: string, updates: Partial<UserProfile>) =>
  req<UserProfile>("/api/users/me", token, { method: "PATCH", body: JSON.stringify(updates) });

export const getIntegrations = (token: string) =>
  req<Integration[]>("/api/integrations", token);

export const connectIntegration = (token: string, provider: string, body: Record<string, string>) =>
  req<Integration>(`/api/integrations/${provider}/connect`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const disconnectIntegration = (token: string, provider: string) =>
  req<{ provider: string; connected: boolean }>(`/api/integrations/${provider}`, token, {
    method: "DELETE",
  });

export async function transcribeAudio(token: string, blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "audio.webm");
  const res = await fetch(`${API_URL}/api/voice/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  const { text } = await res.json();
  return text;
}

export async function textToSpeech(token: string, text: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${API_URL}/api/voice/tts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 404) return null; // ElevenLabs not configured
  if (!res.ok) return null;
  return res.arrayBuffer();
}
