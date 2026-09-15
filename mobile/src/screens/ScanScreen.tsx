import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Alert, Platform } from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { RefreshCw, Camera as CameraIcon, CheckCircle2, XCircle } from 'lucide-react-native';

import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOffline } from '@/contexts/OfflineContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { Card } from '@/components/Card';
import { RiskBadge } from '@/components/RiskBadge';

import { api, ApiError, ScanResponse, StripResponse } from '@/api/client';
import { insertScan, getCumulativeDoseToday, markSynced, cacheStripValidation, getCachedStrip } from '@/db/sqlite';
import { analyzeStripImage } from '@/cv/analyze';
import { guideToStyle, REF_PATCH_GUIDES, STRIP_GUIDE, CHECKERBOARD_GUIDE } from '@/cv/layout';
import { applyCurve, DEMO_CALIBRATION_PROFILE } from '@/cv/calibration';
import { getOfflineModelVersion, isOfflineModelAvailable, predictOffline } from '@/ml/inference';
import { evaluateRisk } from '@/risk/riskEngine';
import { parseStripQr } from '@/screens/scan/types';
import type { ScanResultView } from '@/screens/scan/types';
import type { RiskLevel } from '@/types';
import { DEMO_STRIP_CODE, ML_ENABLED } from '@/config';

type Stage = 'qr' | 'validating' | 'invalid' | 'details' | 'capture' | 'processing' | 'result';

// Mirrors backend WARN_THRESHOLD_DAYS (routers/strips.py) for offline-cached validity checks.
const OFFLINE_WARN_THRESHOLD_DAYS = 30;

function offlineStatusFromExpiry(expiresAt: string | null): 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN' {
  if (!expiresAt) return 'UNKNOWN';
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86400000);
  if (days < 0) return 'EXPIRED';
  if (days < OFFLINE_WARN_THRESHOLD_DAYS) return 'EXPIRING_SOON';
  return 'VALID';
}

const DEMO_RESPONSE_FOR_RISK: Record<RiskLevel, number> = {
  LOW: 0.1,
  ELEVATED: 0.45,
  HIGH: 0.68,
  CRITICAL: 0.92,
};

export function ScanScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { workerId, zoneCode, activeStripCode, refreshMe } = useAuth();
  const { isOnline, syncNow } = useOffline();
  const { pushLocal } = useNotifications();

  const [stage, setStage] = useState<Stage>('qr');
  const [permission, requestPermission] = useCameraPermissions();
  const [strip, setStrip] = useState<StripResponse | null>(null);
  const [stripCode, setStripCode] = useState<string | null>(null);
  const [invalidReason, setInvalidReason] = useState<string>('');
  const [result, setResult] = useState<ScanResultView | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState<number>(Date.now());
  const cameraRef = useRef<CameraView>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const qrLockRef = useRef(false);

  const resetToStart = () => {
    qrLockRef.current = false;
    setStage('qr');
    setStrip(null);
    setStripCode(null);
    setResult(null);
    setInvalidReason('');
  };

  const handleBarcodeScanned = useCallback(async (event: BarcodeScanningResult) => {
    if (qrLockRef.current) return;
    qrLockRef.current = true;
    const parsed = parseStripQr(event.data);
    if (!parsed) {
      setInvalidReason('QR code is not a recognized SENTINEL strip code.');
      setStage('invalid');
      return;
    }
    setStripCode(parsed.strip_id);
    setStage('validating');
    try {
      const validated = await api.validateStrip(parsed.strip_id, parsed.batch_id);
      setStrip(validated);
      await cacheStripValidation({
        strip_code: validated.strip_code,
        batch_code: validated.batch_code ?? null,
        manufacture_date: validated.manufacture_date ?? null,
        expires_at: validated.expires_at ?? null,
        calibration_profile_name: validated.calibration_profile_name ?? null,
        status: validated.status,
      });
      if (validated.status === 'VALID' || validated.status === 'EXPIRING_SOON') {
        setStage('details');
      } else if (validated.status === 'EXPIRED') {
        setInvalidReason(t('scan_expired_message'));
        setStage('invalid');
      } else {
        setInvalidReason(`Strip status: ${validated.status}. Replace strip and rescan.`);
        setStage('invalid');
      }
    } catch (e: unknown) {
      if (!isOnline) {
        // Offline: only trust a strip that was previously validated online
        // and is still cached on-device. An unknown strip is never trusted.
        const cached = await getCachedStrip(parsed.strip_id);
        if (!cached) {
          setInvalidReason(t('scan_offline_unknown_strip'));
          setStage('invalid');
          return;
        }
        const offlineStatus = offlineStatusFromExpiry(cached.expires_at);
        const offlineStrip: StripResponse = {
          id: cached.strip_code,
          strip_code: cached.strip_code,
          batch_code: cached.batch_code ?? '',
          status: offlineStatus,
          health_pct: 100,
          manufacture_date: cached.manufacture_date,
          activated_at: null,
          expires_at: cached.expires_at,
          days_remaining: cached.expires_at
            ? Math.floor((new Date(cached.expires_at).getTime() - Date.now()) / 86400000)
            : null,
          warn_threshold_days: OFFLINE_WARN_THRESHOLD_DAYS,
          calibration_profile_id: null,
          calibration_profile_name: cached.calibration_profile_name,
          calibration_is_validated: null,
        };
        setStrip(offlineStrip);
        if (offlineStatus === 'EXPIRED') {
          setInvalidReason(t('scan_expired_message'));
          setStage('invalid');
        } else {
          setStage('details');
        }
      } else {
        const message = e instanceof Error ? e.message : 'Could not validate strip.';
        setInvalidReason(message);
        setStage('invalid');
      }
    }
  }, [isOnline]);

  const runPipelineAndSave = useCallback(
    async (opticalResponse: number | null, qualityOk: boolean, qualityReason: string | undefined, isDemo: boolean) => {
      if (!workerId) return;
      const durationSeconds = Math.max(1, Math.round((Date.now() - scanStartedAt) / 1000));
      const calibration = DEMO_CALIBRATION_PROFILE;
      const stripValid = strip ? strip.status === 'VALID' || strip.status === 'EXPIRING_SOON' : true;
      // Live captures never use demo curve; only explicit demo scenario chips do.
      const calibrationValid = isDemo;

      const estimatedPpm =
        isDemo && qualityOk && opticalResponse !== null
          ? applyCurve(opticalResponse, calibration.curvePoints)
          : null;

      const edgePenalty = opticalResponse !== null ? Math.min(opticalResponse, 1 - opticalResponse) : 0;
      const confidence = qualityOk ? Math.min(0.99, 0.55 + edgePenalty * 0.9) : 0;

      const cumulativeBefore = await getCumulativeDoseToday(workerId);

      const risk = evaluateRisk({
        estimatedPpm,
        durationSeconds,
        cumulativeDosePpmMinBefore: cumulativeBefore,
        confidence: qualityOk ? confidence : null,
        stripValid,
        calibrationValid,
        qualityOk,
      });

      const dosePpmMin = estimatedPpm !== null ? estimatedPpm * (durationSeconds / 60) : null;
      const scanId = Crypto.randomUUID();
      const capturedAtIso = new Date().toISOString();
      const effectiveStripCode = stripCode ?? (isDemo ? DEMO_STRIP_CODE : null);

      await insertScan({
        scan_id: scanId,
        worker_id: workerId,
        strip_id: strip?.id ?? null,
        strip_code: effectiveStripCode,
        zone_code: zoneCode,
        timestamp: capturedAtIso,
        duration_seconds: durationSeconds,
        optical_response: opticalResponse,
        estimated_ppm: estimatedPpm,
        dose_ppm_min: dosePpmMin,
        cumulative_dose_ppm_min_before: cumulativeBefore,
        risk: risk.riskLevel,
        confidence: qualityOk ? confidence : 0,
        temperature: null,
        humidity: null,
        calibration_profile: calibration.name,
        is_demo: isDemo || !calibration.isValidated,
        quality_ok: qualityOk,
        risk_explanation: risk.explanation,
        recommended_action: risk.recommendedAction,
        sync_status: 'PENDING',
      });

      let syncedImmediately = false;
      if (isOnline) {
        try {
          await api.createScan({
            client_scan_uuid: scanId,
            strip_code: effectiveStripCode ?? undefined,
            zone_code: zoneCode ?? undefined,
            captured_at: capturedAtIso,
            duration_seconds: durationSeconds,
            optical_response: opticalResponse ?? undefined,
            quality_ok: qualityOk,
            is_demo: isDemo || !calibration.isValidated,
            cumulative_dose_ppm_min_before: cumulativeBefore,
          });
          await markSynced(scanId);
          syncedImmediately = true;
        } catch {
          // stays PENDING locally; background sync will retry
        }
      }

      if (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL') {
        pushLocal({
          title: `${risk.riskLevel} exposure`,
          body: risk.recommendedAction,
          riskLevel: risk.riskLevel,
        });
      }

      setResult({
        scanId,
        estimatedPpm,
        durationSeconds,
        dosePpmMin,
        risk: risk.riskLevel,
        confidence: qualityOk ? confidence : null,
        explanation: risk.explanation,
        recommendedAction: risk.recommendedAction,
        isDemo: isDemo || !calibration.isValidated,
        calibrationIsValidated: calibration.isValidated,
        qualityOk,
        syncedImmediately,
        stripCode: effectiveStripCode,
        stripStatus: strip?.status ?? null,
        stripDaysRemaining: strip?.days_remaining ?? null,
        calibrationProfileName: calibration.name,
        analysisSource: 'local',
        mlStatus: isDemo ? null : null,
        modelVersion: null,
        analysisNote: isDemo ? null : t('scan_offline_no_ml'),
      });
      setStage('result');
    },
    [workerId, scanStartedAt, strip, stripCode, zoneCode, isOnline, syncNow, pushLocal, t]
  );

  const saveScanFromServer = useCallback(
    async (serverScan: ScanResponse, analysisSource: 'ml' | 'local', cumulativeBefore = 0) => {
      if (!workerId) return;
      const scanId = serverScan.client_scan_uuid;
      const risk = (serverScan.risk_level ?? 'LOW') as RiskLevel;

      await insertScan({
        scan_id: scanId,
        worker_id: workerId,
        strip_id: serverScan.strip_id,
        strip_code: stripCode,
        zone_code: zoneCode,
        timestamp: serverScan.captured_at,
        duration_seconds: serverScan.duration_seconds,
        optical_response: serverScan.optical_response,
        estimated_ppm: serverScan.estimated_ppm,
        dose_ppm_min: serverScan.dose_ppm_min,
        cumulative_dose_ppm_min_before: cumulativeBefore,
        risk,
        confidence: serverScan.confidence ?? 0,
        temperature: null,
        humidity: null,
        calibration_profile: strip?.calibration_profile_name ?? DEMO_CALIBRATION_PROFILE.name,
        is_demo: serverScan.is_demo,
        quality_ok: serverScan.quality_ok,
        risk_explanation: serverScan.risk_explanation ?? '',
        recommended_action: serverScan.recommended_action ?? '',
        sync_status: 'SYNCED',
      });
      await markSynced(scanId);

      if (risk === 'HIGH' || risk === 'CRITICAL') {
        pushLocal({
          title: `${risk} exposure`,
          body: serverScan.recommended_action ?? 'Notify your supervisor.',
          riskLevel: risk,
        });
      }

      setResult({
        scanId,
        estimatedPpm: serverScan.estimated_ppm,
        durationSeconds: serverScan.duration_seconds,
        dosePpmMin: serverScan.dose_ppm_min,
        risk,
        confidence: serverScan.confidence,
        explanation: serverScan.risk_explanation ?? '',
        recommendedAction: serverScan.recommended_action ?? '',
        isDemo: serverScan.is_demo,
        calibrationIsValidated: serverScan.calibration_is_validated ?? false,
        qualityOk: serverScan.quality_ok,
        syncedImmediately: true,
        stripCode: stripCode,
        stripStatus: strip?.status ?? null,
        stripDaysRemaining: strip?.days_remaining ?? null,
        calibrationProfileName: strip?.calibration_profile_name ?? DEMO_CALIBRATION_PROFILE.name,
        analysisSource,
        mlStatus: (serverScan.ml_status as ScanResultView['mlStatus']) ?? (analysisSource === 'ml' ? 'OK' : null),
        modelVersion: serverScan.model_version ?? null,
        datasetType: serverScan.dataset_type ?? null,
        qualityState: serverScan.quality_state ?? null,
        analysisNote: serverScan.analysis_note ?? null,
        stripRgb: serverScan.ml_proof?.strip_rgb ?? null,
        refPatchRgb: serverScan.ml_proof?.reference_patches_measured ?? null,
        testMae: serverScan.ml_proof?.test_mae ?? null,
        testRmse: serverScan.ml_proof?.test_rmse ?? null,
        testR2: serverScan.ml_proof?.test_r2 ?? null,
      });
      setStage('result');
    },
    [workerId, strip, stripCode, zoneCode, pushLocal]
  );

  const handleCapture = async () => {
    if (!cameraRef.current || captureBusy) return;
    setCaptureBusy(true);
    setStage('processing');
    try {
      const useMl = isOnline && ML_ENABLED;
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: useMl ? 0.88 : 0.7,
        skipProcessing: true,
      });
      if (!photo?.base64) throw new Error('Capture failed');

      if (useMl && photo.uri && workerId) {
        try {
          const scanId = Crypto.randomUUID();
          const cumulativeBefore = await getCumulativeDoseToday(workerId);
          const capturedAtIso = new Date().toISOString();
          const durationSeconds = Math.max(1, Math.round((Date.now() - scanStartedAt) / 1000));
          const serverScan = await api.createScanFromImage(photo.uri, {
            client_scan_uuid: scanId,
            strip_code: stripCode ?? undefined,
            zone_code: zoneCode ?? undefined,
            captured_at: capturedAtIso,
            duration_seconds: durationSeconds,
            cumulative_dose_ppm_min_before: cumulativeBefore,
            is_demo: false,
          });
          await saveScanFromServer(serverScan, 'ml', cumulativeBefore);
          return;
        } catch (e: unknown) {
          if (e instanceof ApiError) {
            if (e.status === 422) {
              Alert.alert('Retake photo', e.message);
              setStage('capture');
              return;
            }
            if (e.status === 503) {
              Alert.alert(t('scan_ml_unavailable'), e.message);
              setStage('capture');
              return;
            }
            throw e;
          } else {
            throw e;
          }
        }
      }

      const analysis = await analyzeStripImage(photo.base64);
      if (!analysis.qualityOk) {
        Alert.alert('Retake photo', analysis.qualityReason ?? 'Image quality insufficient.');
        setStage('capture');
        return;
      }

      if (isOfflineModelAvailable() && analysis.featureVector) {
        const ppm = predictOffline(analysis.featureVector);
        if (ppm !== null && workerId) {
          const durationSeconds = Math.max(1, Math.round((Date.now() - scanStartedAt) / 1000));
          const cumulativeBefore = await getCumulativeDoseToday(workerId);
          const stripValid = strip ? strip.status === 'VALID' || strip.status === 'EXPIRING_SOON' : true;
          const dosePpmMin = ppm * (durationSeconds / 60);
          const risk = evaluateRisk({
            estimatedPpm: ppm,
            durationSeconds,
            cumulativeDosePpmMinBefore: cumulativeBefore,
            confidence: null,
            stripValid,
            calibrationValid: true,
            qualityOk: true,
          });
          const scanId = Crypto.randomUUID();
          const capturedAtIso = new Date().toISOString();
          await insertScan({
            scan_id: scanId,
            worker_id: workerId,
            strip_id: strip?.id ?? null,
            strip_code: stripCode,
            zone_code: zoneCode,
            timestamp: capturedAtIso,
            duration_seconds: durationSeconds,
            optical_response: analysis.opticalResponse,
            estimated_ppm: ppm,
            dose_ppm_min: dosePpmMin,
            cumulative_dose_ppm_min_before: cumulativeBefore,
            risk: risk.riskLevel,
            confidence: 0,
            temperature: null,
            humidity: null,
            calibration_profile: strip?.calibration_profile_name ?? DEMO_CALIBRATION_PROFILE.name,
            is_demo: false,
            quality_ok: true,
            risk_explanation: risk.explanation,
            recommended_action: risk.recommendedAction,
            sync_status: 'PENDING',
          });
          setResult({
            scanId,
            estimatedPpm: ppm,
            durationSeconds,
            dosePpmMin,
            risk: risk.riskLevel,
            confidence: null,
            explanation: risk.explanation,
            recommendedAction: risk.recommendedAction,
            isDemo: false,
            calibrationIsValidated: false,
            qualityOk: true,
            syncedImmediately: false,
            stripCode,
            stripStatus: strip?.status ?? null,
            stripDaysRemaining: strip?.days_remaining ?? null,
            calibrationProfileName: strip?.calibration_profile_name ?? DEMO_CALIBRATION_PROFILE.name,
            analysisSource: 'local',
            mlStatus: 'OK',
            modelVersion: getOfflineModelVersion(),
            datasetType: 'synthetic_development',
            qualityState: analysis.qualityState,
            analysisNote: t('scan_offline_ml_note'),
            stripRgb: [analysis.stripRoiRgbNormalized.r, analysis.stripRoiRgbNormalized.g, analysis.stripRoiRgbNormalized.b],
            refPatchRgb: analysis.referencePatchRgb.map((p) => [p.r, p.g, p.b]),
          });
          setStage('result');
          return;
        }
      }

      Alert.alert(t('scan_offline_no_ml'), t('scan_offline_no_ml'));
      setStage('capture');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Please try again.';
      Alert.alert('Capture failed', message);
      setStage('capture');
    } finally {
      setCaptureBusy(false);
    }
  };

  const runDemoScenario = async (risk: RiskLevel) => {
    setStage('processing');
    setScanStartedAt(Date.now() - 8 * 60 * 1000); // simulate an 8-minute exposure window
    if (!stripCode) setStripCode(DEMO_STRIP_CODE);
    await runPipelineAndSave(DEMO_RESPONSE_FOR_RISK[risk], true, undefined, true);
  };

  if (stage === 'qr') {
    if (Platform.OS === 'web') {
      return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Web demo mode</Text>
          <Text style={{ color: colors.mutedForeground, marginTop: 8, lineHeight: 20 }}>
            Camera/QR are not available in the browser. Use demo scenarios below — they run the same calibration and risk pipeline as the mobile app.
          </Text>
          <View style={{ marginTop: 24, gap: 12 }}>
            {(['LOW', 'ELEVATED', 'HIGH', 'CRITICAL'] as RiskLevel[]).map((r) => (
              <TouchableOpacity
                key={r}
                style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                onPress={() => runDemoScenario(r)}
              >
                <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>Demo: {r}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      );
    }
    if (!permission) {
      return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /></View>;
    }
    if (!permission.granted) {
      return (
        <View style={[styles.center, { backgroundColor: colors.background, padding: 24 }]}>
          <Text style={{ color: colors.foreground, textAlign: 'center', marginBottom: 16 }}>
            {t('scan_camera_required')}
          </Text>
          <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={requestPermission}>
            <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{t('scan_grant_camera')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.overlayTop}>
          <Text style={styles.overlayText}>{t('scan_aligned')}</Text>
        </View>
        <View style={styles.qrFrame} pointerEvents="none" />
        <View style={styles.overlayBottom}>
          <Text style={styles.overlayTextMuted}>{t('scan_auto_detecting')}</Text>
        </View>
        <ScrollView horizontal style={styles.demoBar} showsHorizontalScrollIndicator={false}>
          {(['LOW', 'ELEVATED', 'HIGH', 'CRITICAL'] as RiskLevel[]).map((r) => (
            <TouchableOpacity key={r} style={styles.demoChip} onPress={() => runDemoScenario(r)}>
              <Text style={styles.demoChipText}>Demo: {r}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  }

  if (stage === 'validating') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={{ color: colors.foreground, marginTop: 16 }}>Validating strip…</Text>
      </View>
    );
  }

  if (stage === 'invalid') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: 24 }]}>
        <XCircle size={48} color={colors.statusCritical} />
        <Text style={[styles.title, { color: colors.foreground, marginTop: 12 }]}>{t('scan_expired_title')}</Text>
        <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: 8 }}>{invalidReason}</Text>
        <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: 4, fontSize: 12 }}>
          {t('scan_do_not_use')}
        </Text>
        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 20 }]} onPress={resetToStart}>
          <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{t('scan_replace')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (stage === 'details' && strip) {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Card style={{ alignItems: 'center', paddingVertical: 20 }}>
          <CheckCircle2 size={32} color={colors.statusLow} />
          <Text style={[styles.title, { color: colors.foreground, marginTop: 10 }]}>{t('scan_strip_details')}</Text>
        </Card>
        <Card style={{ marginTop: 14 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{t('scan_strip_label')}</Text>
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: '700', marginTop: 2 }}>{strip.strip_code}</Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('scan_batch_label')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 2 }}>{strip.batch_code || '—'}</Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('scan_manufacture_date_label')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 2 }}>
            {strip.manufacture_date ? new Date(strip.manufacture_date).toDateString() : '—'}
          </Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('scan_expiry_date_label')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 2 }}>
            {strip.expires_at ? new Date(strip.expires_at).toDateString() : '—'}
          </Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('home_days_remaining')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 2 }}>
            {strip.days_remaining !== null ? Math.max(strip.days_remaining, 0) : '—'}
          </Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('scan_calibration_label')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 2 }}>{strip.calibration_profile_name || '—'}</Text>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 12 }}>{t('scan_status_label')}</Text>
          <Text style={{ color: colors.foreground, fontWeight: '700', marginTop: 2 }}>{strip.status}</Text>

          {!isOnline && (
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 12 }}>
              {t('scan_offline_cached_notice')}
            </Text>
          )}
        </Card>

        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 20 }]}
          onPress={async () => {
            if (isOnline && strip && strip.strip_code !== activeStripCode && strip.status !== 'EXPIRED' && strip.status !== 'INVALID') {
              try {
                await api.activateStrip(strip.strip_code);
                await refreshMe();
              } catch {
                // Non-fatal: activation will be retried next successful validate/scan.
              }
            }
            setScanStartedAt(Date.now());
            setStage('capture');
          }}
        >
          <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{t('scan_proceed_to_camera')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 10, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border }]} onPress={resetToStart}>
          <Text style={{ color: colors.foreground, fontWeight: '700' }}>{t('scan_replace')}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (stage === 'capture') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back" />
        <View style={styles.overlayTop}>
          <View style={styles.validatedPill}>
            <CheckCircle2 size={14} color="#fff" />
            <Text style={styles.overlayText}>{t('scan_validated_title')} · {stripCode}</Text>
          </View>
          <Text style={[styles.overlayTextMuted, { marginTop: 8, textAlign: 'center', paddingHorizontal: 24 }]}>
            Align strip card: reactive strip (left), 4 reference patches (right), checkerboard (bottom-right)
          </Text>
        </View>
        <View style={[styles.roiBox, guideToStyle(STRIP_GUIDE)]} pointerEvents="none" />
        {REF_PATCH_GUIDES.map((g, i) => (
          <View key={`ref-${i}`} style={[styles.refPatchBox, guideToStyle(g)]} pointerEvents="none" />
        ))}
        <View style={[styles.checkerboardBox, guideToStyle(CHECKERBOARD_GUIDE)]} pointerEvents="none" />
        <View style={styles.captureBar}>
          <TouchableOpacity style={styles.captureBtn} onPress={handleCapture} disabled={captureBusy}>
            <CameraIcon size={26} color="#000" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (stage === 'processing') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={{ color: colors.foreground, marginTop: 16 }}>Analyzing strip…</Text>
      </View>
    );
  }

  if (stage === 'result' && result) {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {result.analysisSource === 'ml' && result.mlStatus === 'OK' && (
          <View style={[styles.demoBanner, { backgroundColor: 'rgba(42,90,120,0.15)' }]}>
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12 }}>
              {t('scan_ml_synthetic')}
              {result.modelVersion ? ` · ${result.modelVersion}` : ''}
            </Text>
          </View>
        )}

        {result.mlStatus === 'MODEL_UNAVAILABLE' && (
          <View style={[styles.demoBanner, { backgroundColor: colors.statusElevatedBg }]}>
            <Text style={{ color: colors.statusElevated, fontWeight: '700', fontSize: 12 }}>
              {t('scan_ml_unavailable')}
            </Text>
          </View>
        )}

        {result.isDemo && (
          <View style={[styles.demoBanner, { backgroundColor: colors.statusElevatedBg }]}>
            <Text style={{ color: colors.statusElevated, fontWeight: '700', fontSize: 12 }}>
              {t('common_simulated')}
            </Text>
          </View>
        )}

        <Card style={{ alignItems: 'center', paddingVertical: 24 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, fontWeight: '600' }}>{t('scan_risk_level')}</Text>
          <View style={{ marginTop: 10 }}>
            <RiskBadge risk={result.risk} size="lg" />
          </View>
        </Card>

        <View style={styles.statRow}>
          <Card style={styles.statCard}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t('common_concentration')}</Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {result.estimatedPpm !== null ? `${result.estimatedPpm.toFixed(1)}` : '—'}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
              {result.analysisSource === 'ml' && result.mlStatus === 'OK'
                ? t('scan_ppm_synthetic_label')
                : 'ppm (est.)'}
            </Text>
          </Card>
          <Card style={styles.statCard}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t('common_duration')}</Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {Math.round(result.durationSeconds / 60)}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>min</Text>
          </Card>
          <Card style={styles.statCard}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t('scan_cumulative')}</Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {result.dosePpmMin !== null ? result.dosePpmMin.toFixed(1) : '—'}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>ppm·min</Text>
          </Card>
        </View>

        {result.qualityState && (
          <Card style={{ marginTop: 14 }}>
            <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('scan_quality_state')}</Text>
            <Text style={{ color: colors.primary, marginTop: 4, fontWeight: '700' }}>{result.qualityState}</Text>
          </Card>
        )}

        {(result.analysisSource === 'ml' || result.mlStatus === 'OK') && result.stripRgb && (
          <Card style={{ marginTop: 14 }}>
            <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('scan_ml_proof')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 12 }}>
              <View
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 8,
                  backgroundColor: `rgb(${Math.round(result.stripRgb[0])},${Math.round(result.stripRgb[1])},${Math.round(result.stripRgb[2])})`,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.foreground, fontSize: 12 }}>
                  RGB ({result.stripRgb.map((v) => Math.round(v)).join(', ')})
                </Text>
                {result.modelVersion && (
                  <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
                    {result.modelVersion} · {t('scan_tier_b_label')}
                  </Text>
                )}
              </View>
            </View>
            {result.refPatchRgb && (
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
                {result.refPatchRgb.map((rgb, i) => (
                  <View
                    key={`rp-${i}`}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 4,
                      backgroundColor: `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  />
                ))}
              </View>
            )}
            {(result.testMae != null || result.testRmse != null) && (
              <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 8 }}>
                Test MAE {result.testMae?.toFixed(2) ?? '—'} · RMSE {result.testRmse?.toFixed(2) ?? '—'}
                {result.testR2 != null ? ` · R² ${result.testR2.toFixed(3)}` : ''}
              </Text>
            )}
          </Card>
        )}

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('scan_strip_details')}</Text>
          <View style={{ marginTop: 6 }}>
            <Text style={{ color: colors.foreground }}>{t('scan_strip_label')}: {result.stripCode ?? '—'}</Text>
            <Text style={{ color: colors.foreground, marginTop: 2 }}>
              {t('scan_strip_status')}: {result.stripStatus ?? '—'}
              {result.stripDaysRemaining !== null ? ` · ${result.stripDaysRemaining} ${t('home_days_remaining')}` : ''}
            </Text>
            <Text style={{ color: colors.foreground, marginTop: 2 }}>
              {t('scan_calibration_label')}: {result.calibrationProfileName}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
              {t('scan_analysis_disclaimer')}
            </Text>
          </View>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('scan_what_happened')}</Text>
          <Text style={{ color: colors.mutedForeground, marginTop: 6, lineHeight: 20 }}>{result.explanation}</Text>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={[styles.cardHeading, { color: colors.foreground }]}>{t('scan_what_to_do')}</Text>
          <Text style={{ color: colors.foreground, marginTop: 6, lineHeight: 20 }}>{result.recommendedAction}</Text>
        </Card>

        <Text style={[styles.syncNote, { color: colors.mutedForeground }]}>
          {result.syncedImmediately ? t('scan_synced') : t('scan_pending_sync')}
        </Text>

        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 20 }]} onPress={resetToStart}>
          <RefreshCw size={16} color={colors.primaryForeground} />
          <Text style={{ color: colors.primaryForeground, fontWeight: '700', marginLeft: 8 }}>{t('common_scan_again')}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  primaryBtn: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 24, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  overlayTop: { position: 'absolute', top: 56, left: 0, right: 0, alignItems: 'center' },
  overlayBottom: { position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center' },
  overlayText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  overlayTextMuted: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  qrFrame: {
    position: 'absolute', top: '32%', left: '18%', right: '18%', height: '26%',
    borderWidth: 2, borderColor: '#fff', borderRadius: 16,
  },
  refPatchBox: {
    borderWidth: 2, borderColor: '#4A90C4', borderRadius: 4,
  },
  roiBox: {
    borderWidth: 2, borderColor: '#fff', borderRadius: 6,
  },
  checkerboardBox: {
    borderWidth: 2, borderColor: '#FFD54F', borderRadius: 4,
    borderStyle: 'dashed' as const,
  },
  validatedPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(42,120,69,0.85)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  captureBar: { position: 'absolute', bottom: 36, left: 0, right: 0, alignItems: 'center' },
  captureBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  demoBar: { position: 'absolute', bottom: 130, left: 0 },
  demoChip: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginLeft: 10 },
  demoChipText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  demoBanner: { borderRadius: 8, padding: 10, alignItems: 'center', marginBottom: 14 },
  statRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  statCard: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  statLabel: { fontSize: 10, fontWeight: '600', textAlign: 'center' },
  statValue: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  cardHeading: { fontSize: 13, fontWeight: '700' },
  syncNote: { textAlign: 'center', fontSize: 12, marginTop: 16 },
});
