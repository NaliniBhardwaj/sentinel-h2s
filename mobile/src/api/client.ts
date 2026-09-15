import { API_URL } from '@/config';
import { getStoredToken, setStoredToken } from '@/storage/tokenStorage';
import type { RiskLevel, Role, StripStatus, SyncStatus } from '@/types';

export async function getToken(): Promise<string | null> {
  return getStoredToken();
}

export async function setToken(token: string | null) {
  await setStoredToken(token);
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ScanFromImagePayload {
  client_scan_uuid: string;
  strip_code?: string;
  zone_code?: string;
  captured_at: string;
  duration_seconds: number;
  cumulative_dose_ppm_min_before: number;
  is_demo: boolean;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    await setToken(null);
    unauthorizedListeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      // ignore
    }
    throw new ApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  role: Role | string;
  user_id: string;
  full_name: string;
}

export interface MeResponse {
  id: string;
  email: string;
  full_name: string;
  role: Role | string;
  worker_id: string | null;
  zone_id: string | null;
  active_strip_code: string | null;
}

export interface StripResponse {
  id: string;
  strip_code: string;
  batch_code: string;
  status: StripStatus;
  health_pct: number;
  manufacture_date: string | null;
  activated_at: string | null;
  expires_at: string | null;
  days_remaining: number | null;
  warn_threshold_days: number;
  calibration_profile_id: string | null;
  calibration_profile_name: string | null;
  calibration_is_validated: boolean | null;
}

export interface ScanCreatePayload {
  client_scan_uuid: string;
  strip_code?: string;
  zone_code?: string;
  captured_at: string;
  duration_seconds: number;
  optical_response?: number;
  quality_ok: boolean;
  temperature_c?: number;
  humidity_pct?: number;
  is_demo: boolean;
  cumulative_dose_ppm_min_before: number;
}

export interface MlProofResponse {
  strip_rgb?: number[] | null;
  corrected_strip_rgb?: number[] | null;
  hsv?: { h: number; s: number; v: number } | null;
  lab?: { l: number; a: number; b: number } | null;
  reference_patches_measured?: number[][] | null;
  reference_patch_delta_e?: number | null;
  preprocessing_method?: string | null;
  model_version?: string | null;
  dataset_type?: string | null;
  top_features?: { name: string; importance: number }[] | null;
  test_mae?: number | null;
  test_rmse?: number | null;
  test_r2?: number | null;
}

export interface ScanResponse {
  id: string;
  client_scan_uuid: string;
  worker_id: string;
  strip_id: string | null;
  zone_id: string | null;
  captured_at: string;
  duration_seconds: number;
  optical_response: number | null;
  estimated_ppm: number | null;
  dose_ppm_min: number | null;
  confidence: number | null;
  quality_ok: boolean;
  quality_state?: string | null;
  risk_level: RiskLevel | null;
  risk_explanation: string | null;
  recommended_action: string | null;
  is_demo: boolean;
  calibration_is_validated: boolean | null;
  sync_status: SyncStatus | string;
  ml_status?: string | null;
  model_version?: string | null;
  dataset_type?: string | null;
  analysis_note?: string | null;
  ml_proof?: MlProofResponse | null;
}

export interface ManagerOverview {
  active_workers: number;
  workers_at_risk: number;
  zones_attention: number;
  valid_strips_pct: number;
  last_sync: string | null;
}

export interface ManagerWorker {
  worker_id: string;
  display_id: string;
  name: string;
  zone: string | null;
  estimated_ppm: number | null;
  dose_ppm_min: number | null;
  risk_level: string | null;
  confidence: number | null;
  last_scan_at: string | null;
  strip_status: string | null;
}

export interface ZoneResponse {
  id: string;
  code: string;
  name: string;
  worker_count: number;
  avg_ppm: number;
  risk_level: string;
}

export interface AlertResponse {
  id: string;
  type: string;
  worker_id: string | null;
  zone_id: string | null;
  title: string;
  body: string;
  acknowledged: boolean;
  created_at: string;
}

export interface ExposureSummaryResponse {
  worker_id: string;
  cumulative_dose_ppm_min_today: number;
  scan_count_today: number;
  risk_level: string | null;
  last_scan_at: string | null;
}

export interface ExposureTimelinePoint {
  time: string;
  dose_ppm_min: number;
  zone: string | null;
  risk_level: string | null;
}

export interface ReportResponse {
  id: string;
  title: string;
  report_type: string;
  payload: { bullets: string[]; recommendations: string[] };
  created_at: string;
}

export interface StripExpiringResponse {
  worker_id: string;
  worker_name: string;
  display_id: string;
  zone: string | null;
  strip_code: string;
  days_remaining: number;
  status: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<MeResponse>('/users/me'),
  validateStrip: (strip_code: string, batch_code?: string) =>
    request<StripResponse>('/strips/validate', { method: 'POST', body: JSON.stringify({ strip_code, batch_code }) }),
  getStrip: (strip_code: string) => request<StripResponse>(`/strips/${encodeURIComponent(strip_code)}`),
  activateStrip: (strip_code: string) =>
    request<StripResponse>('/strips/activate', { method: 'POST', body: JSON.stringify({ strip_code }) }),
  createScan: (payload: ScanCreatePayload) =>
    request<ScanResponse>('/scans', { method: 'POST', body: JSON.stringify(payload) }),
  createScanFromImage: async (imageUri: string, fields: ScanFromImagePayload): Promise<ScanResponse> => {
    const token = await getToken();
    const form = new FormData();
    form.append('image', {
      uri: imageUri,
      name: 'badge.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    form.append('client_scan_uuid', fields.client_scan_uuid);
    if (fields.strip_code) form.append('strip_code', fields.strip_code);
    if (fields.zone_code) form.append('zone_code', fields.zone_code);
    form.append('captured_at', fields.captured_at);
    form.append('duration_seconds', String(fields.duration_seconds));
    form.append('cumulative_dose_ppm_min_before', String(fields.cumulative_dose_ppm_min_before));
    form.append('is_demo', String(fields.is_demo));

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_URL}/scans/from-image`, { method: 'POST', headers, body: form });
    if (res.status === 401) {
      await setToken(null);
      unauthorizedListeners.forEach((fn) => fn());
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        const d = body.detail;
        if (typeof d === 'object' && d?.message) detail = d.message;
        else if (typeof d === 'string') detail = d;
        else detail = JSON.stringify(body);
      } catch {
        // ignore
      }
      throw new ApiError(res.status, detail);
    }
    return (await res.json()) as ScanResponse;
  },
  listScans: (limit = 50) => request<ScanResponse[]>(`/scans?limit=${limit}`),
  getScan: (id: string) => request<ScanResponse>(`/scans/${encodeURIComponent(id)}`),
  syncScans: (scans: ScanCreatePayload[]) =>
    request<{ accepted: ScanResponse[]; duplicates: string[]; errors: unknown[] }>('/sync/scans', {
      method: 'POST',
      body: JSON.stringify({ scans }),
    }),
  exposureSummary: () => request<ExposureSummaryResponse>('/exposure/summary'),
  exposureTimeline: (hours = 24) => request<ExposureTimelinePoint[]>(`/exposure/timeline?hours=${hours}`),
  zones: () => request<ZoneResponse[]>('/zones'),
  getZone: (idOrCode: string) => request<ZoneResponse>(`/zones/${encodeURIComponent(idOrCode)}`),
  managerOverview: () => request<ManagerOverview>('/manager/overview'),
  managerWorkers: () => request<ManagerWorker[]>('/manager/workers'),
  managerWorker: (id: string) => request<ManagerWorker>(`/manager/workers/${encodeURIComponent(id)}`),
  managerZones: () => request<ZoneResponse[]>('/manager/zones'),
  managerAlerts: () => request<AlertResponse[]>('/manager/alerts'),
  managerStripsExpiring: () => request<StripExpiringResponse[]>('/manager/strips-expiring'),
  getAlerts: () => request<AlertResponse[]>('/alerts'),
  acknowledgeAlert: (id: string) => request<AlertResponse>(`/alerts/${id}/acknowledge`, { method: 'POST' }),
  createReport: (title: string, report_type = 'daily_briefing') =>
    request<ReportResponse>('/reports', { method: 'POST', body: JSON.stringify({ title, report_type }) }),
  getReport: (id: string) => request<ReportResponse>(`/reports/${encodeURIComponent(id)}`),
};

export { API_URL };
