import React, { useEffect } from "react";
import { NavLink } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { listActions } from "../lib/api";

interface Props {
  children: React.ReactNode;
  session: Session;
  pendingCount: number;
  onPendingCount: (n: number) => void;
}

const NAV = [
  { to: "/chat",     label: "Chat",    icon: "💬" },
  { to: "/actions",  label: "Actions", icon: "⚡" },
  { to: "/settings", label: "Settings",icon: "⚙️" },
];

export default function Layout({ children, session, pendingCount, onPendingCount }: Props) {
  // Poll pending actions count every 30 s
  useEffect(() => {
    async function poll() {
      try {
        const actions = await listActions(session.access_token);
        onPendingCount(actions.length);
      } catch {
        // silent
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [session.access_token, onPendingCount]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex flex-col bg-[#141414] border-r border-[#2A2A2A]">
        {/* Title bar drag area */}
        <div className="drag-region h-9" />

        {/* Logo */}
        <div className="px-5 pb-4">
          <span className="text-2xl font-bold text-white tracking-tight">Roy</span>
          <span className="ml-2 text-xs text-[#666] font-medium">alpha</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 space-y-1">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `no-drag flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-500/20 text-indigo-400"
                    : "text-[#888] hover:text-white hover:bg-[#1f1f1f]"
                }`
              }
            >
              <span className="text-base">{icon}</span>
              <span className="flex-1">{label}</span>
              {label === "Actions" && pendingCount > 0 && (
                <span className="bg-indigo-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">
                  {pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-[#2A2A2A]">
          <p className="text-xs text-[#444] truncate">{session.user?.email}</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden bg-[#0A0A0A]">
        {/* Title bar drag area for main area */}
        <div className="drag-region h-9 absolute top-0 left-56 right-0 z-10" />
        <div className="h-full pt-9 overflow-hidden">
          {children}
        </div>
      </main>
    </div>
  );
}
