import React, { useState, useEffect, useRef } from "react";
import type { Session } from "@supabase/supabase-js";
import * as api from "../lib/api";

interface ChatMessage extends api.Message {
  id: string;
  action_id?: string;
  action_description?: string;
}

const ACTION_ICONS: Record<string, string> = {
  email_send: "📧",
  calendar_create: "📅",
  notion_create: "📝",
  phone_call: "📞",
  note: "📌",
  reminder: "⏰",
};

interface Props {
  session: Session;
}

export default function ChatPage({ session }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [actionStates, setActionStates] = useState<Record<string, "done" | "rejected" | "loading">>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadHistory();
  }, [session.access_token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadHistory() {
    try {
      const history = await api.getHistory(session.access_token);
      setMessages(history.map((m, i) => ({ ...m, id: `h-${i}` })));
    } catch {
      // new user — no history
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const result = await api.sendMessage(session.access_token, text);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: result.reply,
          action_id: result.action_id,
          action_description: result.action_description,
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { id: (Date.now() + 1).toString(), role: "assistant", content: `Error: ${err.message}` },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function handleApprove(actionId: string) {
    setActionStates((s) => ({ ...s, [actionId]: "loading" }));
    try {
      await api.approveAction(session.access_token, actionId);
      setActionStates((s) => ({ ...s, [actionId]: "done" }));
    } catch {
      setActionStates((s) => ({ ...s, [actionId]: "done" }));
    }
  }

  async function handleReject(actionId: string) {
    setActionStates((s) => ({ ...s, [actionId]: "loading" }));
    try {
      await api.rejectAction(session.access_token, actionId);
      setActionStates((s) => ({ ...s, [actionId]: "rejected" }));
    } catch {
      setActionStates((s) => ({ ...s, [actionId]: "rejected" }));
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-4xl mb-4">👋</p>
            <p className="text-[#888] text-sm">Say hi to Roy.</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div className="max-w-[70%] space-y-2">
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-indigo-500 text-white rounded-br-sm"
                    : "bg-[#141414] text-[#e5e5e5] rounded-bl-sm"
                }`}
              >
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>

              {msg.action_id && msg.action_description && (() => {
                const state = actionStates[msg.action_id];
                return (
                  <div className="border border-indigo-500/40 bg-[#141414] rounded-xl p-4">
                    <p className="text-indigo-400 text-xs font-semibold mb-1">
                      {ACTION_ICONS[msg.action_id.split("-")[0]] ?? "⚡"} Pending action
                    </p>
                    <p className="text-[#ccc] text-sm mb-3">{msg.action_description}</p>
                    {!state && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApprove(msg.action_id!)}
                          className="flex-1 bg-green-600 hover:bg-green-500 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
                        >
                          ✓ Approve
                        </button>
                        <button
                          onClick={() => handleReject(msg.action_id!)}
                          className="flex-1 bg-[#1f1f1f] border border-[#3A3A3A] hover:border-red-500/50 text-red-400 text-sm font-semibold py-2 rounded-lg transition-colors"
                        >
                          ✕ Reject
                        </button>
                      </div>
                    )}
                    {state === "loading" && (
                      <p className="text-[#666] text-xs">Processing…</p>
                    )}
                    {state === "done" && (
                      <p className="text-green-400 text-xs font-semibold">✓ Approved & executed</p>
                    )}
                    {state === "rejected" && (
                      <p className="text-[#666] text-xs">Cancelled.</p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#141414] rounded-2xl rounded-bl-sm px-4 py-3">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 bg-[#666] rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 pb-5 pt-3 border-t border-[#2A2A2A]">
        <div className="flex items-end gap-3 bg-[#141414] border border-[#2A2A2A] rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Roy… (Enter to send, Shift+Enter for new line)"
            rows={1}
            className="flex-1 bg-transparent text-white placeholder-[#555] resize-none focus:outline-none text-sm leading-relaxed max-h-32"
            style={{ scrollbarWidth: "none" }}
            disabled={sending}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="w-8 h-8 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-30 disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 5v14M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
