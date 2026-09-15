import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Users, AlertTriangle, MapPin, ShieldCheck, FileText, Settings as SettingsIcon } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { Card } from '@/components/Card';
import { RiskBadge } from '@/components/RiskBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ScreenState';
import { api, ManagerOverview, ManagerWorker, ZoneResponse, AlertResponse } from '@/api/client';
import type { RiskLevel } from '@/types';
import type { ThemePalette } from '@/theme/palette';
import type { LucideIcon } from 'lucide-react-native';

type MgrTab = 'overview' | 'workers' | 'zones' | 'alerts' | 'reports';

export function ManagerDashboard({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { logout, fullName, setViewAsWorker } = useAuth();
  const { refreshRemote: refreshNotifications } = useNotifications();
  const [tab, setTab] = useState<MgrTab>('overview');
  const [overview, setOverview] = useState<ManagerOverview | null>(null);
  const [workers, setWorkers] = useState<ManagerWorker[]>([]);
  const [zones, setZones] = useState<ZoneResponse[]>([]);
  const [alerts, setAlerts] = useState<AlertResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reportPayload, setReportPayload] = useState<{ bullets: string[]; recommendations: string[] } | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ov, wk, zn, al] = await Promise.all([
        api.managerOverview(),
        api.managerWorkers(),
        api.zones(),
        api.managerAlerts(),
      ]);
      setOverview(ov);
      setWorkers(wk);
      setZones(zn);
      setAlerts(al);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load manager data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const acknowledge = async (id: string) => {
    try {
      await api.acknowledgeAlert(id);
      setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)));
      await refreshNotifications();
    } catch {
      // ignore, will re-sync on next refresh
    }
  };

  const generateReport = async () => {
    setGeneratingReport(true);
    try {
      const report = await api.createReport('Daily Safety Briefing');
      setReportPayload(report.payload);
    } catch {
      // keep prior report state on failure
    } finally {
      setGeneratingReport(false);
    }
  };

  const tabLabel: Record<MgrTab, string> = {
    overview: t('mgr_overview'),
    workers: t('mgr_workers'),
    zones: t('mgr_zones'),
    alerts: t('mgr_alerts'),
    reports: t('mgr_reports'),
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        <View>
          <Text style={[styles.title, { color: colors.foreground }]}>{t('mgr_title')}</Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{t('mgr_subtitle')} · {fullName}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {onOpenSettings ? (
            <TouchableOpacity onPress={onOpenSettings} accessibilityLabel={t('settings_title')}>
              <SettingsIcon size={18} color={colors.foreground} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={logout}>
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>{t('settings_logout')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.tabRow, { borderColor: colors.border }]}>
        {(['overview', 'workers', 'zones', 'alerts', 'reports'] as MgrTab[]).map((tb) => (
          <TouchableOpacity key={tb} onPress={() => setTab(tb)} style={styles.tabItem}>
            <Text style={{ color: tab === tb ? colors.primary : colors.mutedForeground, fontWeight: '700', fontSize: 13 }}>
              {tabLabel[tb]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <LoadingState />
      ) : error && !overview ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {tab === 'overview' && overview && (
            <>
              <View style={styles.statGrid}>
                <StatTile icon={Users} label={t('mgr_active_workers')} value={String(overview.active_workers)} colors={colors} />
                <StatTile icon={AlertTriangle} label={t('mgr_at_risk')} value={String(overview.workers_at_risk)} colors={colors} accent="critical" />
                <StatTile icon={MapPin} label={t('mgr_zones_attention')} value={String(overview.zones_attention)} colors={colors} accent="elevated" />
                <StatTile icon={ShieldCheck} label={t('mgr_valid_sensors')} value={`${overview.valid_strips_pct}%`} colors={colors} />
              </View>

              <Card style={{ marginTop: 16 }}>
                <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('mgr_zone_ranking')}</Text>
                {zones.length === 0 ? (
                  <EmptyState title={t('mgr_empty_zones')} />
                ) : (
                  [...zones]
                    .sort((a, b) => b.avg_ppm - a.avg_ppm)
                    .map((z) => (
                      <View key={z.id} style={[styles.zoneRow, { borderColor: colors.border }]}>
                        <Text style={{ color: colors.foreground, fontSize: 13 }}>{z.name}</Text>
                        <RiskBadge risk={z.risk_level as RiskLevel} size="sm" />
                      </View>
                    ))
                )}
              </Card>
            </>
          )}

          {tab === 'workers' && (
            <>
              {workers.map((w) => (
                <Card key={w.worker_id} style={{ marginBottom: 10 }}>
                  <View style={styles.rowBetween}>
                    <View>
                      <Text style={{ color: colors.foreground, fontWeight: '700', fontSize: 14 }}>{w.name}</Text>
                      <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{w.display_id} · {w.zone ?? '—'}</Text>
                    </View>
                    {w.risk_level ? <RiskBadge risk={w.risk_level as RiskLevel} size="sm" /> : null}
                  </View>
                  <View style={[styles.rowBetween, { marginTop: 8 }]}>
                    <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                      {w.estimated_ppm !== null ? `${w.estimated_ppm?.toFixed(1)} ppm` : '—'} · {w.dose_ppm_min?.toFixed(1) ?? '—'} ppm·min
                    </Text>
                    <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                      {w.last_scan_at ? new Date(w.last_scan_at).toLocaleTimeString() : t('common_last_scan')}
                    </Text>
                  </View>
                </Card>
              ))}
              {workers.length === 0 && <EmptyState title={t('mgr_empty_workers')} />}
            </>
          )}

          {tab === 'zones' && (
            <>
              {zones.map((z) => (
                <Card key={z.id} style={{ marginBottom: 10 }}>
                  <View style={styles.rowBetween}>
                    <Text style={{ color: colors.foreground, fontWeight: '700' }}>{z.name}</Text>
                    <RiskBadge risk={z.risk_level as RiskLevel} size="sm" />
                  </View>
                  <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 6 }}>
                    {z.worker_count} {t('common_workers').toLowerCase()} · avg {z.avg_ppm.toFixed(1)} ppm
                  </Text>
                </Card>
              ))}
              {zones.length === 0 && <EmptyState title={t('mgr_empty_zones')} />}
            </>
          )}

          {tab === 'alerts' && (
            <>
              {alerts.length === 0 && <EmptyState title={t('mgr_no_alerts')} />}
              {alerts.map((a) => (
                <Card key={a.id} style={{ marginBottom: 10, opacity: a.acknowledged ? 0.55 : 1 }}>
                  <View style={styles.rowBetween}>
                    <Text style={{ color: colors.foreground, fontWeight: '700', fontSize: 13, flex: 1 }}>{a.title}</Text>
                    <RiskBadge risk={a.type as RiskLevel} size="sm" />
                  </View>
                  <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 6 }}>{a.body}</Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
                    {new Date(a.created_at).toLocaleString()}
                  </Text>
                  {!a.acknowledged && (
                    <TouchableOpacity
                      style={[styles.ackBtn, { borderColor: colors.border }]}
                      onPress={() => acknowledge(a.id)}
                    >
                      <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 12 }}>{t('common_acknowledge')}</Text>
                    </TouchableOpacity>
                  )}
                  {a.acknowledged && (
                    <Text style={{ color: colors.statusLow, fontSize: 12, marginTop: 8, fontWeight: '600' }}>
                      {t('common_acknowledged')}
                    </Text>
                  )}
                </Card>
              ))}
            </>
          )}

          {tab === 'reports' && (
            <Card>
              <View style={styles.rowBetween}>
                <FileText size={18} color={colors.primary} />
                <Text />
              </View>
              <Text style={[styles.cardHeading, { color: colors.foreground, marginTop: 8 }]}>{t('mgr_reports_title')}</Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 4 }}>{t('mgr_reports_subtitle')}</Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 14 }]}
                onPress={generateReport}
                disabled={generatingReport}
              >
                {generatingReport ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{t('mgr_generate_report')}</Text>
                )}
              </TouchableOpacity>

              {reportPayload && (
                <View style={{ marginTop: 16 }}>
                  <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('mgr_daily_brief')}</Text>
                  {reportPayload.bullets.map((b, i) => (
                    <Text key={i} style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 6 }}>• {b}</Text>
                  ))}
                  <Text style={[styles.cardHeading, { color: colors.foreground, marginTop: 12 }]}>{t('mgr_recommended')}</Text>
                  {reportPayload.recommendations.map((r, i) => (
                    <Text key={i} style={{ color: colors.foreground, fontSize: 12, marginTop: 6 }}>• {r}</Text>
                  ))}
                </View>
              )}
            </Card>
          )}
        </ScrollView>
      )}

      <TouchableOpacity style={[styles.workerViewToggle, { borderColor: colors.border, backgroundColor: colors.card }]} onPress={() => setViewAsWorker(true)}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{t('mgr_switch_worker')}</Text>
      </TouchableOpacity>
    </View>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  colors,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  colors: ThemePalette;
  accent?: 'critical' | 'elevated';
}) {
  const accentColor = accent === 'critical' ? colors.statusCritical : accent === 'elevated' ? colors.statusElevated : colors.primary;
  return (
    <Card style={styles.statTile}>
      <Icon size={16} color={accentColor} />
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={{ color: colors.mutedForeground, fontSize: 11, textAlign: 'center' }}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { fontSize: 17, fontWeight: '700' },
  tabRow: { flexGrow: 0, borderBottomWidth: 1, paddingHorizontal: 16 },
  tabItem: { paddingVertical: 12, marginRight: 20 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statTile: { width: '47%', alignItems: 'center', gap: 6, paddingVertical: 16 },
  statValue: { fontSize: 22, fontWeight: '800' },
  cardHeading: { fontSize: 13, fontWeight: '700' },
  zoneRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ackBtn: { marginTop: 10, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  primaryBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  workerViewToggle: { position: 'absolute', bottom: 16, right: 16, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
});
