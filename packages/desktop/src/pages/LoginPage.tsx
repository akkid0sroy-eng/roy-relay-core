import React, { useState } from "react";
import { supabase } from "../lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: "roy://auth/callback" },
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      setSent(true);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#0A0A0A]">
      {/* Drag region for frameless window */}
      <div className="drag-region fixed top-0 left-0 right-0 h-9" />

      <div className="w-full max-w-sm px-8">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-bold text-white tracking-tight">Roy</h1>
          <p className="text-[#666] mt-2 text-sm">Your AI relay</p>
        </div>

        {!sent ? (
          <form onSubmit={handleSend} className="space-y-4">
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#141414] border border-[#2A2A2A] rounded-xl px-4 py-3 text-white placeholder-[#555] focus:outline-none focus:border-indigo-500 transition-colors"
              autoFocus
              disabled={loading}
            />

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Sending…
                </span>
              ) : (
                "Send magic link"
              )}
            </button>
          </form>
        ) : (
          <div className="text-center space-y-4">
            <div className="text-5xl">✉️</div>
            <h2 className="text-xl font-bold text-white">Check your email</h2>
            <p className="text-[#888] text-sm leading-relaxed">
              We sent a sign-in link to{" "}
              <span className="text-white font-medium">{email}</span>.
              <br />
              Click it to open Roy automatically.
            </p>
            <button
              onClick={() => setSent(false)}
              className="text-indigo-400 text-sm hover:text-indigo-300 transition-colors"
            >
              Use a different email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
