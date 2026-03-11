import React, { useState, useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "./lib/supabase";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import ChatPage from "./pages/ChatPage";
import ActionsPage from "./pages/ActionsPage";
import SettingsPage from "./pages/SettingsPage";

declare global {
  interface Window {
    electronAPI?: {
      onDeepLink: (cb: (url: string) => void) => void;
      removeDeepLinkListener: () => void;
    };
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // ── Auth state ──────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // ── Deep link handler from Electron main process ────────────────────────────

  useEffect(() => {
    async function handleDeepLink(url: string) {
      if (!url.includes("auth/callback")) return;
      const fragment = url.split("#")[1] ?? "";
      const params = new URLSearchParams(fragment);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token });
      }
    }

    window.electronAPI?.onDeepLink(handleDeepLink);
    return () => window.electronAPI?.removeDeepLinkListener();
  }, []);

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0A0A0A]">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <HashRouter>
      <Layout pendingCount={pendingCount} onPendingCount={setPendingCount} session={session}>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage session={session} />} />
          <Route path="/actions" element={<ActionsPage session={session} onPendingCount={setPendingCount} />} />
          <Route path="/settings" element={<SettingsPage session={session} />} />
        </Routes>
      </Layout>
    </HashRouter>
  );
}
