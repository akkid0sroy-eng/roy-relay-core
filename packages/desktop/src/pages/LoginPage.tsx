import React, { useState } from "react";
import { supabase } from "../lib/supabase";

type Step = "email" | "code";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      setStep("code");
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: "email",
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#0A0A0A]">
      <div className="drag-region fixed top-0 left-0 right-0 h-9" />

      <div className="w-full max-w-sm px-8">
        <div className="text-center mb-10">
          <img
            src="./roy-dark.png"
            alt="Roy"
            className="w-24 h-24 rounded-2xl mx-auto mb-4 object-cover"
          />
          <h1 className="text-3xl font-bold text-white tracking-tight">Roy</h1>
          <p className="text-[#666] mt-1 text-sm">Your personal AI companion</p>
        </div>

        {step === "email" ? (
          <form onSubmit={handleSendCode} className="space-y-4">
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#141414] border border-[#2A2A2A] rounded-xl px-4 py-3 text-white placeholder-[#555] focus:outline-none focus:border-indigo-500 transition-colors"
              autoFocus
              disabled={loading}
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
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
                "Send login code"
              )}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyCode} className="space-y-4">
            <div className="text-center mb-6">
              <p className="text-[#888] text-sm leading-relaxed">
                We sent a login code to{" "}
                <span className="text-white font-medium">{email}</span>
              </p>
            </div>
            <input
              type="text"
              placeholder="Enter login code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              className="w-full bg-[#141414] border border-[#2A2A2A] rounded-xl px-4 py-3 text-white placeholder-[#555] focus:outline-none focus:border-indigo-500 transition-colors text-center text-xl tracking-widest font-mono"
              autoFocus
              disabled={loading}
              maxLength={8}
            />
            {error && <p className="text-red-400 text-sm text-center">{error}</p>}
            <button
              type="submit"
              disabled={loading || code.length < 6}
              className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 transition-colors"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Verifying…
                </span>
              ) : (
                "Verify code"
              )}
            </button>
            <button
              type="button"
              onClick={() => { setStep("email"); setCode(""); setError(null); }}
              className="w-full text-[#666] text-sm hover:text-white transition-colors py-1"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
