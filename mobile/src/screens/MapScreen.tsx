import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import Svg, { Rect, Text as SvgText, Path } from 'react-native-svg';
import { Navigation, Users } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useOffline } from '@/contexts/OfflineContext';
import { api, ZoneResponse } from '@/api/client';
import { riskColor } from '@/theme/palette';
import type { RiskLevel } from '@/types';
import { Card } from '@/components/Card';
import { RiskBadge } from '@/components/RiskBadge';
import { EmptyState } from '@/components/ScreenState';
import { ZONE_LAYOUT, SAFE_ROUTE_PATH } from '@/data/plant';

export function MapScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { isOnline } = useOffline();
  const [zones, setZones] = useState<ZoneResponse[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isOnline) return;
    try {
      const z = await api.zones();
      setZones(z);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load zones');
    }
  }, [isOnline]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const selectedZone = zones.find((z) => z.code === selected);
  const totalWorkers = zones.reduce((sum, z) => sum + z.worker_count, 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>{t('map_title')}</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {t('map_live')} · {totalWorkers} {t('map_on_shift')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <Svg width="100%" height={260} viewBox="0 0 360 320">
          <Rect x={0} y={0} width={360} height={320} fill={colors.card} />
          {Object.entries(ZONE_LAYOUT).map(([code, def]) => {
            const zoneData = zones.find((z) => z.code === code);
            const risk = (zoneData?.risk_level as RiskLevel) ?? 'LOW';
            const c = riskColor(colors, risk);
            const isSelected = selected === code;
            return (
              <React.Fragment key={code}>
                <Rect
                  x={def.x}
                  y={def.y}
                  width={def.w}
                  height={def.h}
                  rx={8}
                  fill={c.bg}
                  stroke={isSelected ? colors.primary : c.text}
                  strokeWidth={isSelected ? 2.5 : 1.2}
                  onPress={() => setSelected(code)}
                />
                <SvgText
                  x={def.x + def.w / 2}
                  y={def.y + def.h / 2}
                  fontSize={10}
                  fill={c.text}
                  textAnchor="middle"
                  fontWeight="600"
                >
                  {def.label}
                </SvgText>
              </React.Fragment>
            );
          })}
          {showRoute && (
            <Path d={SAFE_ROUTE_PATH} stroke={colors.primary} strokeWidth={3} strokeDasharray="6,4" fill="none" />
          )}
        </Svg>

        <TouchableOpacity
          style={[styles.routeToggle, { borderColor: colors.border, backgroundColor: colors.card }]}
          onPress={() => setShowRoute((s) => !s)}
        >
          <Navigation size={16} color={colors.primary} />
          <Text style={{ color: colors.foreground, marginLeft: 8, fontWeight: '600', fontSize: 13 }}>
            {t('map_show_route')}
          </Text>
        </TouchableOpacity>
        {showRoute && (
          <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4, textAlign: 'center' }}>
            Suggested safer route — not a guaranteed safe route.
          </Text>
        )}

        {selectedZone && (
          <Card style={{ marginTop: 16 }}>
            <View style={styles.rowBetween}>
              <Text style={[styles.zoneName, { color: colors.foreground }]}>{selectedZone.name}</Text>
              <RiskBadge risk={(selectedZone.risk_level as RiskLevel) ?? 'LOW'} size="sm" />
            </View>
            <View style={[styles.rowBetween, { marginTop: 10 }]}>
              <View style={styles.metaRow}>
                <Users size={14} color={colors.mutedForeground} />
                <Text style={{ color: colors.mutedForeground, marginLeft: 6, fontSize: 12 }}>
                  {selectedZone.worker_count} {t('common_workers').toLowerCase()}
                </Text>
              </View>
              <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                Avg {selectedZone.avg_ppm.toFixed(1)} ppm (4h)
              </Text>
            </View>
          </Card>
        )}

        {zones.length === 0 && (
          <View style={{ marginTop: 16 }}>
            <EmptyState title={t('map_empty')} body={error ?? undefined} />
          </View>
        )}

        <View style={styles.legendRow}>
          {(['LOW', 'ELEVATED', 'HIGH', 'CRITICAL'] as RiskLevel[]).map((r) => {
            const c = riskColor(colors, r);
            return (
              <View key={r} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: c.text }]} />
                <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>{r}</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 3 },
  routeToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 14 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  zoneName: { fontSize: 15, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  legendRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 18 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
});
