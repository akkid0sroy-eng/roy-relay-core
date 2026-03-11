import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
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
  if (m < 1) return "< 1 min left";
  return `${m} min left`;
}

export default function ActionsScreen() {
  const [actions, setActions] = useState<api.Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const t = data.session?.access_token ?? null;
      setToken(t);
      if (t) load(t);
    });
  }, []);

  async function load(t: string) {
    try {
      const data = await api.listActions(t);
      setActions(data);
    } catch {
      // no-op
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const onRefresh = useCallback(() => {
    if (!token) return;
    setRefreshing(true);
    load(token);
  }, [token]);

  async function approve(id: string) {
    if (!token) return;
    try {
      const result = await api.approveAction(token, id);
      Alert.alert("Done ✓", result.result || "Action completed.");
      load(token);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }

  async function reject(id: string) {
    if (!token) return;
    try {
      await api.rejectAction(token, id);
      load(token);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color="#6366F1" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Pending actions</Text>
        <Text style={styles.headerCount}>{actions.length}</Text>
      </View>

      <FlatList
        data={actions}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#6366F1"
          />
        }
        contentContainerStyle={actions.length === 0 && styles.emptyContainer}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>⚡</Text>
            <Text style={styles.emptyTitle}>No pending actions</Text>
            <Text style={styles.emptyBody}>
              When Roy proposes an action, it will appear here for your approval.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardIcon}>
                {ACTION_ICONS[item.type] ?? "⚡"}
              </Text>
              <View style={styles.cardMeta}>
                <Text style={styles.cardType}>{item.type.replace("_", " ")}</Text>
                <Text style={styles.cardExpiry}>{timeLeft(item.expires_at)}</Text>
              </View>
            </View>
            <Text style={styles.cardDesc}>{item.description}</Text>
            <View style={styles.cardButtons}>
              <TouchableOpacity
                style={styles.approveBtn}
                onPress={() => approve(item.id)}
              >
                <Text style={styles.approveTxt}>✓ Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.rejectBtn}
                onPress={() => reject(item.id)}
              >
                <Text style={styles.rejectTxt}>✕ Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  center: { alignItems: "center", justifyContent: "center" },
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
  headerCount: {
    backgroundColor: "#6366F1",
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptyBody: { fontSize: 14, color: "#666", textAlign: "center", lineHeight: 20 },
  card: {
    margin: 12,
    marginBottom: 0,
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#2A2A2A",
    borderRadius: 16,
    padding: 16,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  cardIcon: { fontSize: 28, marginRight: 12 },
  cardMeta: { flex: 1 },
  cardType: {
    color: "#6366F1",
    fontWeight: "600",
    fontSize: 13,
    textTransform: "capitalize",
  },
  cardExpiry: { color: "#666", fontSize: 12, marginTop: 2 },
  cardDesc: { color: "#ccc", fontSize: 14, lineHeight: 20, marginBottom: 14 },
  cardButtons: { flexDirection: "row", gap: 8 },
  approveBtn: {
    flex: 1,
    backgroundColor: "#22C55E",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  approveTxt: { color: "#fff", fontWeight: "700", fontSize: 14 },
  rejectBtn: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderWidth: 1,
    borderColor: "#3A3A3A",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  rejectTxt: { color: "#EF4444", fontWeight: "700", fontSize: 14 },
});
