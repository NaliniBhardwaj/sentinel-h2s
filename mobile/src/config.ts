import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Single place for env/config so screens never hard-code the API host.
 * - Web browser → localhost (10.0.2.2 does not exist in the browser)
 * - Android emulator → 10.0.2.2
 * - Physical phone (Expo Go) → your PC LAN IP, e.g. http://192.168.1.14:8000
 */
function resolveApiUrl(): string {
  if (Platform.OS === 'web') {
    return process.env.EXPO_PUBLIC_API_URL_WEB || 'http://localhost:8000';
  }
  return (
    process.env.EXPO_PUBLIC_API_URL ||
    (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
    'http://10.0.2.2:8000'
  );
}

export const API_URL: string = resolveApiUrl();

/** When true and online, capture uploads to POST /scans/from-image for LAB ML analysis. */
export const ML_ENABLED: boolean =
  process.env.EXPO_PUBLIC_ML_ENABLED !== 'false';

export const TOKEN_KEY = 'sentinel_jwt';
export const THEME_STORAGE_KEY = 'sentinel-theme';
export const LANG_STORAGE_KEY = 'sentinel-lang';
export const NOTIFICATION_STORAGE_KEY = 'sentinel-notifications';

/** Seed strip used by DEMO scan chips so synced demo scans resolve a calibration profile. */
export const DEMO_STRIP_CODE = 'ST-2026-00421';
export const DEMO_BATCH_CODE = 'BA-2607-A';
