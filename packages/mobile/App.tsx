import "react-native-url-polyfill/auto";
import React, { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "./src/lib/supabase";
import * as api from "./src/lib/api";
import Navigation from "./src/navigation";

const prefix = Linking.createURL("/");

const linking = {
  prefixes: [prefix, "roy://"],
  config: {
    screens: {
      Main: {
        screens: {
          Chat: "chat",
          Actions: "actions",
          Settings: "settings",
        },
      },
      Login: "login",
    },
  },
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // ── Auth state ────────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // ── Deep link handler — catches roy://auth/callback#access_token=...&refresh_token=... ──

  useEffect(() => {
    async function handleUrl(url: string) {
      if (!url.includes("auth/callback")) return;

      // Supabase appends tokens in the URL fragment
      const fragment = url.split("#")[1] ?? "";
      const params = new URLSearchParams(fragment);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");

      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token });
      }
    }

    // Handle URL that opened the app cold
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });

    // Handle URL when app is already running
    const sub = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

  // ── Poll pending action count when logged in ──────────────────────────────────

  useEffect(() => {
    if (!session) {
      setPendingCount(0);
      return;
    }

    async function poll() {
      const token = session!.access_token;
      try {
        const actions = await api.listActions(token);
        setPendingCount(actions.length);
      } catch {
        // silent
      }
    }

    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [session]);

  if (!ready) return null;

  return (
    <>
      <StatusBar style="light" />
      <Navigation
        isLoggedIn={!!session}
        pendingCount={pendingCount}
        linking={linking}
      />
    </>
  );
}
