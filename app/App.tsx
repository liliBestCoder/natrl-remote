import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import HomeScreen from "./src/screens/HomeScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <HomeScreen />
    </SafeAreaProvider>
  );
}
