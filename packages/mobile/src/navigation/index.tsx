import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";

import LoginScreen from "../screens/LoginScreen";
import ChatScreen from "../screens/ChatScreen";
import ActionsScreen from "../screens/ActionsScreen";
import SettingsScreen from "../screens/SettingsScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function TabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.4 }}>{icon}</Text>
  );
}

function MainTabs({ pendingCount }: { pendingCount: number }) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#141414",
          borderTopColor: "#2A2A2A",
        },
        tabBarActiveTintColor: "#6366F1",
        tabBarInactiveTintColor: "#666",
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon icon="💬" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Actions"
        component={ActionsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon icon="⚡" focused={focused} />,
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          tabBarBadgeStyle: { backgroundColor: "#6366F1" },
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon icon="⚙️" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

interface Props {
  isLoggedIn: boolean;
  pendingCount: number;
  linking: object;
}

export default function Navigation({ isLoggedIn, pendingCount, linking }: Props) {
  return (
    <NavigationContainer linking={linking as any}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isLoggedIn ? (
          <Stack.Screen name="Main">
            {() => <MainTabs pendingCount={pendingCount} />}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
