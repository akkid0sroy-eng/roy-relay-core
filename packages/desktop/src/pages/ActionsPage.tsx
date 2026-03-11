import React, { useState, useEffect, useCallback } from "react";
import type { Session } from "@supabase/supabase-js";
import * as api from "../lib/api";

const ACTION_ICONS: Record<string, string> = {
  email_send: "📧",
  calendar_create: "📅",
  notion_create: "📝",
  phone_call: "📞",
  note: "📌",
  reminder: "⏰",
};

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const m = Math.floor(diff / 60000);
  return m < 1 ? "< 1 min" : `${m} min left`;
}

interface Props {
  session: Session;
  onPendingCount: (n: number) => void;
}

export default function ActionsPage({ session, onPendingCount }: Props) {
  const [actions, setActions] = useState<api.Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.listActions(session.access_token);
      setActions(data);
      onPendingCount(data.length);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [session.access_token, onPendingCount]);

  useEffect(() => { load(); }, [load]);

  async function approve(id: string) {
    setLoadingId(id);
    try {
      await api.approveAction(session.access_token, id);
      await load();
    } catch {
      // silent
    } finally {
      setLoadingId(null);
    }
  }

  async function reject(id: string) {
    setLoadingId(id);
    try {
      await api.rejectAction(session.access_token, id);
      await load();
    } catch {
      // silent
    } finally {
      setLoadingId(null);
    }
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
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-white">Pending actions</h1>
          {actions.length > 0 && (
            <span className="bg-indigo-500 text-white text-xs font-bold px-2 py-1 rounded-full">
              {actions.length}
            </span>
          )}
        </div>

        {actions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-4xl mb-4">⚡</p>
            <p className="text-white font-semibold mb-2">No pending actions</p>
            <p className="text-[#666] text-sm max-w-xs">
              When Roy proposes an action, it will appear here for your approval.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {actions.map((action) => {
              const busy = loadingId === action.id;
              return (
                <div
                  key={action.id}
                  className="bg-[#141414] border border-[#2A2A2A] rounded-2xl p-5"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <span className="text-2xl">
                      {ACTION_ICONS[action.type] ?? "⚡"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-indigo-400 text-xs font-semibold capitalize mb-0.5">
                        {action.type.replace("_", " ")}
                      </p>
                      <p className="text-white text-sm leading-relaxed">
                        {action.description}
                      </p>
                    </div>
                    <span className="text-[#555] text-xs flex-shrink-0">
                      {timeLeft(action.expires_at)}
                    </span>
                  </div>

                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => approve(action.id)}
                      disabled={busy}
                      className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-xl transition-colors"
                    >
                      {busy ? "…" : "✓ Approve"}
                    </button>
                    <button
                      onClick={() => reject(action.id)}
                      disabled={busy}
                      className="flex-1 bg-[#1a1a1a] border border-[#3A3A3A] hover:border-red-500/40 disabled:opacity-50 text-red-400 text-sm font-semibold py-2 rounded-xl transition-colors"
                    >
                      ✕ Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
