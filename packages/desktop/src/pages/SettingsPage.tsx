import React, { useState, useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import * as api from "../lib/api";

const INTEGRATION_ICONS: Record<string, string> = {
  google: "🔵",
  notion: "⬛",
  vapi: "📞",
  groq: "🤖",
  tavily: "🔍",
  elevenlabs: "🔊",
};

interface Props {
  session: Session;
}

export default function SettingsPage({ session }: Props) {
  const [profile, setProfile] = useState<api.UserProfile | null>(null);
  const [integrations, setIntegrations] = useState<api.Integration[]>([]);
  const [loading, setLoading] = useState(true);

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

  async function signOut() {
    await supabase.auth.signOut();
  }

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
              Plan:{" "}
              <span className="text-indigo-400 font-medium capitalize">{profile?.plan ?? "free"}</span>
            </p>
            <p className="text-[#666] text-sm">Model: {profile?.ai_model ?? "—"}</p>
            <p className="text-[#666] text-sm">Timezone: {profile?.timezone ?? "—"}</p>
          </div>
        </section>

        {/* Preferences */}
        <section>
          <p className="text-[#555] text-xs font-semibold uppercase tracking-widest mb-3">Preferences</p>
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-2xl divide-y divide-[#2A2A2A]">
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
                <span
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    profile?.web_search ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section>
          <p className="text-[#555] text-xs font-semibold uppercase tracking-widest mb-3">Integrations</p>
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-2xl divide-y divide-[#2A2A2A]">
            {integrations.length === 0 ? (
              <p className="px-5 py-4 text-[#666] text-sm">No integrations connected yet.</p>
            ) : (
              integrations.map((int) => (
                <div key={int.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="text-lg">{INTEGRATION_ICONS[int.provider] ?? "🔗"}</span>
                  <span className="flex-1 text-white text-sm capitalize">{int.provider}</span>
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded-md ${
                      int.enabled
                        ? "bg-green-900/40 text-green-400"
                        : "bg-[#2A2A2A] text-[#666]"
                    }`}
                  >
                    {int.enabled ? "Connected" : "Disabled"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Sign out */}
        <button
          onClick={signOut}
          className="w-full border border-red-500/40 hover:border-red-500 text-red-400 font-semibold py-3 rounded-xl transition-colors text-sm"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
