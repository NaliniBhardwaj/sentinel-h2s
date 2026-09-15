import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import type { PpmMin, RiskLevel } from '@/types';

const IS_WEB = Platform.OS === 'web';

export interface LocalScan {
  scan_id: string; // client-generated UUID, used as idempotency key
  worker_id: string;
  strip_id: string | null;
  strip_code: string | null;
  zone_code: string | null;
  timestamp: string; // ISO
  duration_seconds: number;
  optical_response: number | null;
  estimated_ppm: number | null;
  dose_ppm_min: number | null;
  /** Dose already accumulated today before this scan, ppm·min. Used on sync. */
  cumulative_dose_ppm_min_before: number;
  risk: RiskLevel | null;
  confidence: number | null;
  temperature: number | null;
  humidity: number | null;
  calibration_profile: string | null;
  is_demo: boolean;
  quality_ok: boolean;
  risk_explanation: string | null;
  recommended_action: string | null;
  sync_status: 'SYNCED' | 'PENDING' | 'SYNC_FAILED';
}

export interface CachedStrip {
  strip_code: string;
  batch_code: string | null;
  manufacture_date: string | null; // ISO
  expires_at: string | null; // ISO
  calibration_profile_name: string | null;
  last_known_status: string | null;
  cached_at: string; // ISO
}

const webScans = new Map<string, LocalScan>();
const webStripCache = new Map<string, CachedStrip>();

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (IS_WEB) {
    return Promise.reject(new Error('web-memory-db'));
  }
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('sentinel_offline.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS scans (
          scan_id TEXT PRIMARY KEY NOT NULL,
          worker_id TEXT NOT NULL,
          strip_id TEXT,
          strip_code TEXT,
          zone_code TEXT,
          timestamp TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL,
          optical_response REAL,
          estimated_ppm REAL,
          dose_ppm_min REAL,
          cumulative_dose_ppm_min_before REAL NOT NULL DEFAULT 0,
          risk TEXT,
          confidence REAL,
          temperature REAL,
          humidity REAL,
          calibration_profile TEXT,
          is_demo INTEGER NOT NULL DEFAULT 0,
          quality_ok INTEGER NOT NULL DEFAULT 1,
          risk_explanation TEXT,
          recommended_action TEXT,
          sync_status TEXT NOT NULL DEFAULT 'PENDING'
        );
        CREATE TABLE IF NOT EXISTS strip_cache (
          strip_code TEXT PRIMARY KEY NOT NULL,
          batch_code TEXT,
          manufacture_date TEXT,
          expires_at TEXT,
          calibration_profile_name TEXT,
          last_known_status TEXT,
          cached_at TEXT NOT NULL
        );
      `);
      try {
        await db.execAsync(`ALTER TABLE scans ADD COLUMN cumulative_dose_ppm_min_before REAL NOT NULL DEFAULT 0`);
      } catch {
        // column already exists on upgraded installs
      }
      return db;
    });
  }
  return dbPromise;
}

export async function insertScan(scan: LocalScan): Promise<void> {
  if (IS_WEB) {
    webScans.set(scan.scan_id, scan);
    return;
  }
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO scans (
      scan_id, worker_id, strip_id, strip_code, zone_code, timestamp, duration_seconds,
      optical_response, estimated_ppm, dose_ppm_min, cumulative_dose_ppm_min_before,
      risk, confidence, temperature, humidity,
      calibration_profile, is_demo, quality_ok, risk_explanation, recommended_action, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scan.scan_id, scan.worker_id, scan.strip_id, scan.strip_code, scan.zone_code, scan.timestamp,
      scan.duration_seconds, scan.optical_response, scan.estimated_ppm, scan.dose_ppm_min,
      scan.cumulative_dose_ppm_min_before,
      scan.risk, scan.confidence, scan.temperature, scan.humidity, scan.calibration_profile,
      scan.is_demo ? 1 : 0, scan.quality_ok ? 1 : 0, scan.risk_explanation, scan.recommended_action,
      scan.sync_status,
    ]
  );
}

export async function markSynced(scanId: string): Promise<void> {
  if (IS_WEB) {
    const s = webScans.get(scanId);
    if (s) webScans.set(scanId, { ...s, sync_status: 'SYNCED' });
    return;
  }
  const db = await getDb();
  await db.runAsync(`UPDATE scans SET sync_status = 'SYNCED' WHERE scan_id = ?`, [scanId]);
}

export async function markSyncFailed(scanId: string): Promise<void> {
  if (IS_WEB) {
    const s = webScans.get(scanId);
    if (s) webScans.set(scanId, { ...s, sync_status: 'SYNC_FAILED' });
    return;
  }
  const db = await getDb();
  await db.runAsync(`UPDATE scans SET sync_status = 'SYNC_FAILED' WHERE scan_id = ?`, [scanId]);
}

export async function getPendingScans(): Promise<LocalScan[]> {
  if (IS_WEB) {
    return [...webScans.values()].filter((s) => s.sync_status === 'PENDING' || s.sync_status === 'SYNC_FAILED');
  }
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM scans WHERE sync_status IN ('PENDING', 'SYNC_FAILED') ORDER BY timestamp ASC`
  );
  return rows.map(rowToLocalScan);
}

export async function getAllScans(limit = 100): Promise<LocalScan[]> {
  if (IS_WEB) {
    return [...webScans.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM scans ORDER BY timestamp DESC LIMIT ?`, [limit]);
  return rows.map(rowToLocalScan);
}

export async function getCumulativeDoseToday(workerId: string): Promise<PpmMin> {
  if (IS_WEB) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return [...webScans.values()]
      .filter((s) => s.worker_id === workerId && s.timestamp >= todayStart.toISOString())
      .reduce((sum, s) => sum + (s.dose_ppm_min ?? 0), 0);
  }
  const db = await getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(dose_ppm_min) as total FROM scans WHERE worker_id = ? AND timestamp >= ?`,
    [workerId, todayStart.toISOString()]
  );
  return row?.total ?? 0;
}

/**
 * Caches the last server-validated metadata for a strip so its expiry can
 * be re-checked offline (P0 #17). Only strips that have been successfully
 * validated online are ever cached -- an unvalidated/unknown strip_code
 * simply has no cache row, so offline lookups for it correctly fail.
 */
export async function cacheStripValidation(strip: {
  strip_code: string;
  batch_code: string | null;
  manufacture_date: string | null;
  expires_at: string | null;
  calibration_profile_name: string | null;
  status: string;
}): Promise<void> {
  if (IS_WEB) {
    webStripCache.set(strip.strip_code, {
      strip_code: strip.strip_code,
      batch_code: strip.batch_code,
      manufacture_date: strip.manufacture_date,
      expires_at: strip.expires_at,
      calibration_profile_name: strip.calibration_profile_name,
      last_known_status: strip.status,
      cached_at: new Date().toISOString(),
    });
    return;
  }
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO strip_cache (
      strip_code, batch_code, manufacture_date, expires_at, calibration_profile_name, last_known_status, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      strip.strip_code, strip.batch_code, strip.manufacture_date, strip.expires_at,
      strip.calibration_profile_name, strip.status, new Date().toISOString(),
    ]
  );
}

export async function getCachedStrip(stripCode: string): Promise<CachedStrip | null> {
  if (IS_WEB) {
    return webStripCache.get(stripCode) ?? null;
  }
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM strip_cache WHERE strip_code = ?`,
    [stripCode]
  );
  if (!row) return null;
  return {
    strip_code: String(row.strip_code),
    batch_code: (row.batch_code as string | null) ?? null,
    manufacture_date: (row.manufacture_date as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
    calibration_profile_name: (row.calibration_profile_name as string | null) ?? null,
    last_known_status: (row.last_known_status as string | null) ?? null,
    cached_at: String(row.cached_at),
  };
}

function rowToLocalScan(row: Record<string, unknown>): LocalScan {
  return {
    scan_id: String(row.scan_id),
    worker_id: String(row.worker_id),
    strip_id: (row.strip_id as string | null) ?? null,
    strip_code: (row.strip_code as string | null) ?? null,
    zone_code: (row.zone_code as string | null) ?? null,
    timestamp: String(row.timestamp),
    duration_seconds: Number(row.duration_seconds),
    optical_response: (row.optical_response as number | null) ?? null,
    estimated_ppm: (row.estimated_ppm as number | null) ?? null,
    dose_ppm_min: (row.dose_ppm_min as number | null) ?? null,
    cumulative_dose_ppm_min_before: Number(row.cumulative_dose_ppm_min_before ?? 0),
    risk: (row.risk as RiskLevel | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    temperature: (row.temperature as number | null) ?? null,
    humidity: (row.humidity as number | null) ?? null,
    calibration_profile: (row.calibration_profile as string | null) ?? null,
    is_demo: !!row.is_demo,
    quality_ok: !!row.quality_ok,
    risk_explanation: (row.risk_explanation as string | null) ?? null,
    recommended_action: (row.recommended_action as string | null) ?? null,
    sync_status: row.sync_status as LocalScan['sync_status'],
  };
}
