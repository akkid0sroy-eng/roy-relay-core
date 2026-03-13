import React, { useState, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import * as api from "../lib/api";

interface Props {
  session: Session;
}

interface IntegrationConfig {
  provider: string;
  label: string;
  icon: string;
  description: string;
  fields: { key: string; label: string; placeholder: string; type?: string }[];
}

const INTEGRATIONS: IntegrationConfig[] = [
  {
    provider: "groq",
    label: "Groq",
    icon: "🤖",
    description: "Powers Roy's AI responses. Required for chat to work.",
    fields: [{ key: "api_key", label: "API Key", placeholder: "gsk_..." }],
  },
  {
    provider: "google",
    label: "Google",
    icon: "🔵",
    description: "Send Gmail emails and create Google Calendar events.",
    fields: [{ key: "api_key", label: "OAuth Token", placeholder: "Connect via Google OAuth" }],
  },
  {
    provider: "notion",
    label: "Notion",
    icon: "⬛",
    description: "Create and update Notion pages and databases.",
    fields: [{ key: "token", label: "Integration Token", placeholder: "secret_..." }],
  },
  {
    provider: "vapi",
    label: "VAPI",
    icon: "📞",
    description: "Make AI-powered phone calls on your behalf.",
    fields: [
      { key: "api_key", label: "API Key", placeholder: "vapi_..." },
      { key: "phone_number_id", label: "Phone Number ID", placeholder: "From VAPI dashboard" },
      { key: "destination_phone", label: "Your Phone Number", placeholder: "+1234567890" },
    ],
  },
  {
    provider: "tavily",
    label: "Tavily",
    icon: "🔍",
    description: "Lets Roy search the web before answering questions.",
    fields: [{ key: "api_key", label: "API Key", placeholder: "tvly-..." }],
  },
  {
    provider: "elevenlabs",
    label: "ElevenLabs",
    icon: "🔊",
    description: "High-quality AI voice synthesis.",
    fields: [{ key: "api_key", label: "API Key", placeholder: "Your ElevenLabs key" }],
  },
];

export default function SettingsPage({ session }: Props) {
  const [profile, setProfile] = useState<api.UserProfile | null>(null);
  const [integrations, setIntegrations] = useState<api.Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    async function load() {
      try {
        const [p, ints] = await Promise.all([
          api.getProfile(session.access_token),
          api.getIntegrations(session.access_token),
        ]);
        setProfile(p);
        setIntegrations(ints);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [session.access_token]);

  async function toggleWebSearch() {
    if (!profile) return;
    const updated = await api.updateProfile(session.access_token, {
      web_search: !profile.web_search,
    });
    setProfile(updated);
  }

  function setField(provider: string, key: string, value: string) {
    setFieldValues((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? {}), [key]: value },
    }));
  }

  async function handleConnect(cfg: IntegrationConfig) {
    const body = fieldValues[cfg.provider] ?? {};
    // For Notion, the field key is "token" not "api_key"
    setSaving((s) => ({ ...s, [cfg.provider]: true }));
    setErrors((e) => ({ ...e, [cfg.provider]: "" }));
    try {
      await api.connectIntegration(session.access_token, cfg.provider, body);
      const ints = await api.getIntegrations(session.access_token);
      setIntegrations(ints);
      setExpanded(null);
      setFieldValues((prev) => ({ ...prev, [cfg.provider]: {} }));
    } catch (err: any) {
      let msg = err.message;
      try { msg = JSON.parse(err.message)?.error ?? msg; } catch {}
      setErrors((e) => ({ ...e, [cfg.provider]: msg }));
    } finally {
      setSaving((s) => ({ ...s, [cfg.provider]: false }));
    }
  }

  async function handleDisconnect(provider: string) {
    setSaving((s) => ({ ...s, [provider]: true }));
    try {
      await api.disconnectIntegration(session.access_token, provider);
      setIntegrations((prev) => prev.filter((i) => i.provider !== provider));
    } catch {
      // silent
    } finally {
      setSaving((s) => ({ ...s, [provider]: false }));
    }
  }

  const connectedMap = new Map(integrations.map((i) => [i.provider, i]));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="max-w-xl mx-auto space-y-6">
        <h1 className="text-xl font-bold text-white">Settings</h1>

        {/* Account */}
        <section>
          <p className="text-[#555] text-xs font-semibold uppercase tracking-widest mb-3">Account</p>
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-2xl p-5 space-y-2">
            <p className="text-white font-semibold">{profile?.display_name ?? session.user?.email}</p>
            <p className="text-[#888] text-sm">
              Plan: <span className="text-indigo-400 font-medium capitalize">{profile?.plan ?? "free"}</span>
            </p>
            <p className="text-[#666] text-sm">Model: {profile?.ai_model ?? "—"}</p>
          </div>
        </section>

        {/* Preferences */}
        <section>
          <p className="text-[#555] text-xs font-semibold uppercase tracking-widest mb-3">Preferences</p>
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-2xl">
            <div className="flex items-center justify-between px-5 py-4">
              <div>
                <p className="text-white text-sm font-medium">Web search</p>
                <p className="text-[#666] text-xs mt-0.5">Let Roy search the web before answering</p>
              </div>
              <button
                onClick={toggleWebSearch}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  profile?.web_search ? "bg-indigo-500" : "bg-[#2A2A2A]"
                }`}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  profile?.web_search ? "translate-x-5" : "translate-x-0.5"
                }`} />
              </button>
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section>
          <p className="text-[#555] text-xs font-semibold uppercase tracking-widest mb-3">Integrations</p>
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-2xl divide-y divide-[#2A2A2A]">
            {INTEGRATIONS.map((cfg) => {
              const connected = connectedMap.has(cfg.provider);
              const open = expanded === cfg.provider;
              const isSaving = saving[cfg.provider];
              const errMsg = errors[cfg.provider];
              const vals = fieldValues[cfg.provider] ?? {};

              return (
                <div key={cfg.provider}>
                  <button
                    onClick={() => setExpanded(open ? null : cfg.provider)}
                    className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-[#1a1a1a] transition-colors text-left"
                  >
                    <span className="text-lg">{cfg.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium">{cfg.label}</p>
                      <p className="text-[#666] text-xs mt-0.5 truncate">{cfg.description}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-md ${
                        connected ? "bg-green-900/40 text-green-400" : "bg-[#2A2A2A] text-[#666]"
                      }`}>
                        {connected ? "Connected" : "Not set up"}
                      </span>
                      <span className={`text-[#555] text-xs transition-transform inline-block ${open ? "rotate-180" : ""}`}>▾</span>
                    </div>
                  </button>

                  {open && (
                    <div className="px-5 pb-5 pt-2 bg-[#0f0f0f] space-y-3">
                      {connected ? (
                        <div className="flex items-center justify-between">
                          <p className="text-green-400 text-sm">✓ {cfg.label} is connected</p>
                          <button
                            onClick={() => handleDisconnect(cfg.provider)}
                            disabled={isSaving}
                            className="text-red-400 hover:text-red-300 text-sm font-medium disabled:opacity-50 transition-colors"
                          >
                            {isSaving ? "Disconnecting…" : "Disconnect"}
                          </button>
                        </div>
                      ) : (
                        <>
                          {cfg.fields.map((f) => (
                            <div key={f.key}>
                              <label className="text-[#888] text-xs mb-1 block">{f.label}</label>
                              <input
                                type={f.type ?? "text"}
                                placeholder={f.placeholder}
                                value={vals[f.key] ?? ""}
                                onChange={(e) => setField(cfg.provider, f.key, e.target.value)}
                                className="w-full bg-[#1a1a1a] border border-[#2A2A2A] rounded-lg px-3 py-2 text-white placeholder-[#444] text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                              />
                            </div>
                          ))}
                          {errMsg && <p className="text-red-400 text-xs">{errMsg}</p>}
                          <button
                            onClick={() => handleConnect(cfg)}
                            disabled={isSaving || cfg.fields.some((f) => !vals[f.key]?.trim())}
                            className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors"
                          >
                            {isSaving ? "Connecting…" : `Connect ${cfg.label}`}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Sign out */}
        <button
          onClick={() => supabase.auth.signOut()}
          className="w-full border border-red-500/40 hover:border-red-500 text-red-400 font-semibold py-3 rounded-xl transition-colors text-sm"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
