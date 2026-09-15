import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch } from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOffline } from '@/contexts/OfflineContext';
import { Card } from '@/components/Card';
import { SyncStatusPill } from '@/components/SyncStatusPill';
import { API_URL } from '@/config';
import type { ThemeMode } from '@/types';

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { colors, mode, setMode } = useTheme();
  const { lang, setLang, t } = useLanguage();
  const { fullName, role, logout, email } = useAuth();
  const { isOnline, manualOfflineOverride, setManualOfflineOverride, pendingCount, lastSyncAt, syncNow } = useOffline();

  const themeOptions: { key: ThemeMode; label: string }[] = [
    { key: 'system', label: t('settings_theme_system') },
    { key: 'light', label: t('settings_theme_light') },
    { key: 'dark', label: t('settings_theme_dark') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityRole="button">
          <ArrowLeft size={18} color={colors.foreground} />
          <Text style={{ color: colors.foreground, fontWeight: '600' }}>{t('common_back')}</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>{t('settings_title')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Card>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('settings_account')}</Text>
          <Text style={[styles.value, { color: colors.foreground }]}>{fullName ?? '—'}</Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>{email ?? ''}</Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>{role ?? ''}</Text>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('settings_theme')}</Text>
          <View style={styles.rowWrap}>
            {themeOptions.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[
                  styles.chip,
                  { borderColor: mode === opt.key ? colors.primary : colors.border, backgroundColor: colors.card },
                ]}
                onPress={() => setMode(opt.key)}
              >
                <Text style={{ color: mode === opt.key ? colors.primary : colors.foreground, fontWeight: '600', fontSize: 12 }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('settings_language')}</Text>
          <View style={styles.rowWrap}>
            {(['en', 'hi'] as const).map((l) => (
              <TouchableOpacity
                key={l}
                style={[
                  styles.chip,
                  { borderColor: lang === l ? colors.primary : colors.border },
                ]}
                onPress={() => setLang(l)}
              >
                <Text style={{ color: lang === l ? colors.primary : colors.foreground, fontWeight: '600', fontSize: 12 }}>
                  {l === 'en' ? 'English' : 'हिन्दी'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <View style={styles.rowBetween}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('settings_sync')}</Text>
            <SyncStatusPill />
          </View>
          <View style={[styles.rowBetween, { marginTop: 12 }]}>
            <Text style={{ color: colors.foreground, fontSize: 13 }}>{t('settings_offline_override')}</Text>
            <Switch
              value={manualOfflineOverride}
              onValueChange={setManualOfflineOverride}
              trackColor={{ true: colors.primary }}
            />
          </View>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 8 }}>
            {isOnline ? t('common_online') : t('common_offline')}
            {pendingCount > 0 ? ` · ${pendingCount} ${t('common_pending_sync')}` : ''}
          </Text>
          {lastSyncAt ? (
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
              {t('mgr_last_sync')}: {lastSyncAt.toLocaleString()}
            </Text>
          ) : null}
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.border }]}
            onPress={() => syncNow()}
          >
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>{t('settings_sync_now')}</Text>
          </TouchableOpacity>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('settings_api')}</Text>
          <Text style={{ color: colors.foreground, fontSize: 12, marginTop: 4 }}>{API_URL}</Text>
        </Card>

        <TouchableOpacity
          style={[styles.logout, { borderColor: colors.statusCritical }]}
          onPress={logout}
        >
          <Text style={{ color: colors.statusCritical, fontWeight: '700' }}>{t('settings_logout')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  title: { fontSize: 18, fontWeight: '700' },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  value: { fontSize: 16, fontWeight: '700', marginTop: 6 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  secondaryBtn: { marginTop: 12, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  logout: { marginTop: 24, borderWidth: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
});
