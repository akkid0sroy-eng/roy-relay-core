import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import * as api from "../lib/api";

interface ChatMessage extends api.Message {
  id: string;
  action_id?: string;
  action_description?: string;
  pending?: boolean;
}

const ACTION_ICONS: Record<string, string> = {
  email_send: "📧",
  calendar_create: "📅",
  notion_create: "📝",
  phone_call: "📞",
  note: "📌",
  reminder: "⏰",
};

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
      if (data.session?.access_token) {
        loadHistory(data.session.access_token);
      }
    });
  }, []);

  async function loadHistory(t: string) {
    try {
      const history = await api.getHistory(t);
      setMessages(
        history.map((m, i) => ({ ...m, id: `h-${i}` }))
      );
    } catch {
      // silent — new user has no history
    }
  }

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  async function send() {
    if (!input.trim() || sending || !token) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: Date.now().toString(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();

    try {
      const result = await api.sendMessage(token, text);
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: result.reply,
        action_id: result.action_id,
        action_description: result.action_description,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Something went wrong: ${err.message}`,
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }

  async function handleApprove(actionId: string) {
    if (!token) return;
    try {
      const result = await api.approveAction(token, actionId);
      Alert.alert("Done", result.result || "Action completed.");
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }

  async function handleReject(actionId: string) {
    if (!token) return;
    try {
      await api.rejectAction(token, actionId);
      Alert.alert("Rejected", "Action cancelled.");
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }

  function renderItem({ item }: { item: ChatMessage }) {
    const isUser = item.role === "user";
    return (
      <View style={styles.msgWrapper}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={[styles.bubbleText, isUser && styles.userText]}>
            {item.content}
          </Text>
        </View>
        {item.action_id && item.action_description && (
          <View style={styles.actionCard}>
            <Text style={styles.actionTitle}>
              {ACTION_ICONS[item.action_id.split("-")[0]] ?? "⚡"} Pending action
            </Text>
            <Text style={styles.actionDesc}>{item.action_description}</Text>
            <View style={styles.actionButtons}>
              <TouchableOpacity
                style={styles.approveBtn}
                onPress={() => handleApprove(item.action_id!)}
              >
                <Text style={styles.approveTxt}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.rejectBtn}
                onPress={() => handleReject(item.action_id!)}
              >
                <Text style={styles.rejectTxt}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Roy</Text>
        {sending && <ActivityIndicator color="#6366F1" size="small" />}
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={scrollToBottom}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="Message Roy..."
            placeholderTextColor="#555"
            value={input}
            onChangeText={setInput}
            multiline
            returnKeyType="send"
            onSubmitEditing={send}
            editable={!sending}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || sending) && styles.sendDisabled]}
            onPress={send}
            disabled={!input.trim() || sending}
          >
            <Text style={styles.sendIcon}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  list: { padding: 16, gap: 8 },
  msgWrapper: { marginBottom: 8 },
  bubble: {
    maxWidth: "82%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: { backgroundColor: "#6366F1", alignSelf: "flex-end", borderBottomRightRadius: 4 },
  aiBubble: { backgroundColor: "#141414", alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, color: "#e5e5e5", lineHeight: 22 },
  userText: { color: "#fff" },
  actionCard: {
    marginTop: 8,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#6366F1",
    borderRadius: 12,
    padding: 14,
    alignSelf: "flex-start",
    maxWidth: "90%",
  },
  actionTitle: { color: "#6366F1", fontWeight: "600", fontSize: 13, marginBottom: 4 },
  actionDesc: { color: "#ccc", fontSize: 14, marginBottom: 12 },
  actionButtons: { flexDirection: "row", gap: 8 },
  approveBtn: {
    flex: 1,
    backgroundColor: "#22C55E",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  approveTxt: { color: "#fff", fontWeight: "600", fontSize: 14 },
  rejectBtn: {
    flex: 1,
    backgroundColor: "#2A2A2A",
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  rejectTxt: { color: "#EF4444", fontWeight: "600", fontSize: 14 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#2A2A2A",
    gap: 8,
    backgroundColor: "#0A0A0A",
  },
  input: {
    flex: 1,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#2A2A2A",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: "#fff",
    maxHeight: 120,
  },
  sendBtn: {
    width: 40,
    height: 40,
    backgroundColor: "#6366F1",
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { backgroundColor: "#2A2A2A" },
  sendIcon: { color: "#fff", fontSize: 18, fontWeight: "700" },
});
