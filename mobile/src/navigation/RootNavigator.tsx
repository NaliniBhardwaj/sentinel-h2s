import React, { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { LoginScreen } from '@/screens/LoginScreen';
import { HomeScreen } from '@/screens/HomeScreen';
import { ScanScreen } from '@/screens/ScanScreen';
import { MapScreen } from '@/screens/MapScreen';
import { InsightsScreen } from '@/screens/InsightsScreen';
import { SentiScreen } from '@/screens/SentiScreen';
import { ManagerDashboard } from '@/screens/ManagerDashboard';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { AlertsScreen } from '@/screens/AlertsScreen';
import { BottomNav, WorkerTab } from '@/components/BottomNav';
import { LoadingState } from '@/components/ScreenState';
import { isManagerRole } from '@/types';

export function RootNavigator() {
  const { isLoading, isAuthenticated, role, viewAsWorker, setViewAsWorker } = useAuth();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [tab, setTab] = useState<WorkerTab>('home');
  const [showSettings, setShowSettings] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <LoadingState />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isManager = isManagerRole(role);

  if (showSettings) {
    return <SettingsScreen onBack={() => setShowSettings(false)} />;
  }

  if (showAlerts) {
    return <AlertsScreen onBack={() => setShowAlerts(false)} />;
  }

  if (isManager && !viewAsWorker) {
    return <ManagerDashboard onOpenSettings={() => setShowSettings(true)} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {isManager && viewAsWorker && (
        <TouchableOpacity
          style={[styles.backToManager, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setViewAsWorker(false)}
        >
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>{t('nav_back_to_manager')}</Text>
        </TouchableOpacity>
      )}
      <View style={{ flex: 1 }}>
        {tab === 'home' && <HomeScreen onNavigate={setTab} onOpenSettings={() => setShowSettings(true)} onOpenAlerts={() => setShowAlerts(true)} />}
        {tab === 'scan' && <ScanScreen />}
        {tab === 'map' && <MapScreen />}
        {tab === 'insights' && <InsightsScreen />}
        {tab === 'senti' && <SentiScreen />}
      </View>
      <BottomNav active={tab} onChange={setTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  backToManager: { position: 'absolute', top: 50, left: 12, zIndex: 10, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
});
