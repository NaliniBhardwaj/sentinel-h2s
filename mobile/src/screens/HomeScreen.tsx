import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { ScanLine, ChevronRight, Settings as SettingsIcon, Bell } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { Card } from '@/components/Card';
import { RiskBadge } from '@/components/RiskBadge';
import { SyncStatusPill } from '@/components/SyncStatusPill';
import { getAllScans, LocalScan } from '@/db/sqlite';
import { useExposureSummary } from '@/hooks/useExposureSummary';
import { api, StripResponse } from '@/api/client';
import type { TranslationKey } from '@/i18n/translations';
import type { WorkerTab } from '@/components/BottomNav';
import type { RiskLevel } from '@/types';

/** Display-only mapping from authoritative risk → score. Not an independent risk calculation. */
const SCORE_FROM_RISK: Record<RiskLevel, number> = { LOW: 92, ELEVATED: 74, HIGH: 48, CRITICAL: 20 };

function greetingKey(): TranslationKey {
  const hour = new Date().getHours();
  if (hour < 12) return 'home_good_morning';
  if (hour < 17) return 'home_good_afternoon';
  return 'home_good_evening';
}

export function HomeScreen({
  onNavigate,
  onOpenSettings,
  onOpenAlerts,
}: {
  onNavigate: (tab: WorkerTab) => void;
  onOpenSettings: () => void;
  onOpenAlerts: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { fullName, activeStripCode } = useAuth();
  const { unreadCount } = useNotifications();
  const { summary, reload } = useExposureSummary();
  const [lastScan, setLastScan] = useState<LocalScan | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [strip, setStrip] = useState<StripResponse | null>(null);

  useEffect(() => {
    if (!activeStripCode) return;
    api.getStrip(activeStripCode).then(setStrip).catch(() => setStrip(null));
  }, [activeStripCode]);

  const loadLocal = useCallback(async () => {
    const localScans = await getAllScans(1);
    setLastScan(localScans[0] ?? null);
  }, []);

  useEffect(() => {
    loadLocal();
  }, [loadLocal]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([reload(), loadLocal()]);
    setRefreshing(false);
  };

  const lastRisk = summary?.riskLevel ?? lastScan?.risk ?? null;
  const safetyScore = lastRisk ? SCORE_FROM_RISK[lastRisk] : 92;
  const cumulativeDose = summary?.cumulativeDosePpmMinToday ?? 0;
  const scanCount = summary?.scanCountToday ?? 0;

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>{t(greetingKey())}</Text>
          <Text style={[styles.name, { color: colors.foreground }]}>{fullName ?? '—'}</Text>
        </View>
        <View style={styles.headerActions}>
          <SyncStatusPill />
          <TouchableOpacity onPress={onOpenAlerts} accessibilityLabel={t('alerts_title')} style={styles.iconBtn}>
            <View>
              <Bell size={18} color={colors.mutedForeground} />
              {unreadCount > 0 ? <View style={[styles.dot, { backgroundColor: colors.statusCritical }]} /> : null}
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenSettings} accessibilityLabel={t('settings_title')} style={styles.iconBtn}>
            <SettingsIcon size={18} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      </View>

      <Card style={styles.scoreCard}>
        <Text style={[styles.scoreLabel, { color: colors.mutedForeground }]}>{t('home_safety_score')}</Text>
        <Text style={[styles.scoreValue, { color: colors.primary }]}>{safetyScore}</Text>
        {lastRisk ? <RiskBadge risk={lastRisk} /> : (
          <Text style={{ color: colors.statusLow, fontWeight: '700', fontSize: 13 }}>{t('home_low_exposure')}</Text>
        )}
      </Card>

      <Card style={styles.doseCard}>
        <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>{t('home_cumulative')}</Text>
        <Text style={[styles.doseValue, { color: colors.foreground }]}>
          {cumulativeDose.toFixed(1)} <Text style={styles.doseUnit}>ppm·min</Text>
        </Text>
        <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>
          {scanCount} {t('common_today').toLowerCase()}
        </Text>
      </Card>

      <View style={styles.deviceStripRow}>
        <Card style={{ ...styles.deviceStripCard, flex: 1 }}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>{t('home_strip')}</Text>
          {strip ? (
            <>
              <Text style={[styles.deviceValue, { color: colors.foreground }]}>
                {strip.days_remaining !== null ? Math.max(strip.days_remaining, 0) : '—'}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                {t('home_days_remaining')} · {strip.strip_code} · {strip.status}
              </Text>
            </>
          ) : (
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 6 }}>{t('home_no_active_strip')}</Text>
          )}
        </Card>
      </View>

      <TouchableOpacity
        style={[styles.scanCta, { backgroundColor: colors.primary }]}
        onPress={() => onNavigate('scan')}
        activeOpacity={0.85}
      >
        <ScanLine size={22} color={colors.primaryForeground} />
        <Text style={[styles.scanCtaText, { color: colors.primaryForeground }]}>{t('home_scan_cta')}</Text>
      </TouchableOpacity>

      {lastScan && (
        <Card style={{ marginTop: 16 }}>
          <View style={styles.rowBetween}>
            <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>{t('home_last_scan')}</Text>
            {lastScan.risk && <RiskBadge risk={lastScan.risk} size="sm" />}
          </View>
          <Text style={{ color: colors.foreground, marginTop: 6 }}>
            {lastScan.estimated_ppm !== null
              ? `${lastScan.estimated_ppm.toFixed(1)} ppm est.`
              : 'Quality insufficient'}
            {lastScan.is_demo ? '  ·  DEMO / SIMULATED' : ''}
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
            {new Date(lastScan.timestamp).toLocaleString()}
          </Text>
        </Card>
      )}

      <TouchableOpacity style={[styles.sentiRow, { borderColor: colors.border }]} onPress={() => onNavigate('senti')}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{t('home_ask_senti')}</Text>
        <ChevronRight size={18} color={colors.mutedForeground} />
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconBtn: { padding: 6 },
  dot: { position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: 4 },
  greeting: { fontSize: 13 },
  name: { fontSize: 20, fontWeight: '700', marginTop: 2 },
  scoreCard: { alignItems: 'center', paddingVertical: 24, gap: 6 },
  scoreLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  scoreValue: { fontSize: 44, fontWeight: '800' },
  doseCard: { marginTop: 14 },
  deviceStripRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  deviceStripCard: { flex: 1 },
  deviceValue: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  cardLabel: { fontSize: 12, fontWeight: '600' },
  doseValue: { fontSize: 28, fontWeight: '700', marginTop: 4 },
  doseUnit: { fontSize: 14, fontWeight: '500' },
  cardSub: { fontSize: 12, marginTop: 4 },
  scanCta: { marginTop: 18, borderRadius: 10, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  scanCtaText: { fontWeight: '700', fontSize: 15, letterSpacing: 0.5 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sentiRow: { marginTop: 16, borderWidth: 1, borderRadius: 10, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
