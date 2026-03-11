import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Switch,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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

export default function SettingsScreen() {
  const [profile, setProfile] = useState<api.UserProfile | null>(null);
  const [integrations, setIntegrations] = useState<api.Integration[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const t = data.session?.access_token ?? null;
      setToken(t);
      if (t) loadData(t);
    });
  }, []);

  async function loadData(t: string) {
    try {
      const [p, ints] = await Promise.all([api.getProfile(t), api.getIntegrations(t)]);
      setProfile(p);
      setIntegrations(ints);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function toggleWebSearch(value: boolean) {
    if (!token || !profile) return;
    try {
      const updated = await api.updateProfile(token, { web_search: value });
      setProfile(updated);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }

  async function signOut() {
    Alert.alert("Sign out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await supabase.auth.signOut();
        },
      },
    ]);
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
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Profile */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.card}>
            <Text style={styles.name}>{profile?.display_name ?? "—"}</Text>
            <Text style={styles.plan}>
              Plan: <Text style={styles.planBadge}>{profile?.plan ?? "free"}</Text>
            </Text>
            <Text style={styles.detail}>Model: {profile?.ai_model ?? "—"}</Text>
            <Text style={styles.detail}>Timezone: {profile?.timezone ?? "—"}</Text>
          </View>
        </View>

        {/* Preferences */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Preferences</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <View>
                <Text style={styles.rowLabel}>Web search</Text>
                <Text style={styles.rowSub}>Let Roy search the web before answering</Text>
              </View>
              <Switch
                value={profile?.web_search ?? false}
                onValueChange={toggleWebSearch}
                trackColor={{ false: "#2A2A2A", true: "#6366F1" }}
                thumbColor="#fff"
              />
            </View>
          </View>
        </View>

        {/* Integrations */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Integrations</Text>
          <View style={styles.card}>
            {integrations.length === 0 ? (
              <Text style={styles.detail}>No integrations connected yet.</Text>
            ) : (
              integrations.map((int) => (
                <View key={int.id} style={styles.integrationRow}>
                  <Text style={styles.intIcon}>{INTEGRATION_ICONS[int.provider] ?? "🔗"}</Text>
                  <Text style={styles.intName}>{int.provider}</Text>
                  <View style={[styles.intBadge, int.enabled && styles.intBadgeOn]}>
                    <Text style={styles.intBadgeText}>
                      {int.enabled ? "Connected" : "Disabled"}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </View>

        {/* Sign out */}
        <TouchableOpacity style={styles.signOutBtn} onPress={signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  scroll: { padding: 16, paddingBottom: 40 },
  section: { marginBottom: 24 },
  sectionLabel: { color: "#666", fontSize: 12, fontWeight: "600", marginBottom: 8, letterSpacing: 0.5, textTransform: "uppercase" },
  card: {
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#2A2A2A",
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  name: { color: "#fff", fontSize: 17, fontWeight: "600" },
  plan: { color: "#888", fontSize: 14 },
  planBadge: { color: "#6366F1", fontWeight: "600" },
  detail: { color: "#888", fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: "#fff", fontSize: 15, fontWeight: "500" },
  rowSub: { color: "#666", fontSize: 12, marginTop: 2 },
  integrationRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
  },
  intIcon: { fontSize: 18, width: 30 },
  intName: { flex: 1, color: "#ccc", fontSize: 14, textTransform: "capitalize" },
  intBadge: {
    backgroundColor: "#2A2A2A",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  intBadgeOn: { backgroundColor: "#14532d" },
  intBadgeText: { color: "#ccc", fontSize: 11, fontWeight: "600" },
  signOutBtn: {
    borderWidth: 1,
    borderColor: "#EF4444",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  signOutText: { color: "#EF4444", fontWeight: "600", fontSize: 15 },
});
