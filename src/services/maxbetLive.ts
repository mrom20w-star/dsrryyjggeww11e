export interface MaxBetRemoteRound {
  id: number;
  status: 'betting' | 'running' | 'crashed';
  crash_point: number | null;
  betting_opens_at: string | null;
  betting_closes_at: string | null;
  started_at: string | null;
  crashed_at: string | null;
  created_at?: string | null;
  server_seed_hash?: string | null;
}

export interface MaxBetTickResult {
  round: MaxBetRemoteRound;
  serverNow: number;
  sentAt: number;
  recvAt: number;
}

export interface MaxBetHistoryRound {
  id: number;
  crash_point: number;
  started_at: string | null;
  crashed_at: string | null;
}

const MAXBET_SUPABASE_URL =
  'https://c--c814838a-7eb1-4f61-961e-f18c2da7cc5f-prod.lovable.cloud';
const MAXBET_SUPABASE_ANON_KEY =
  'sb_publishable_MM53G-U5JLO2r3A_Ph-H6A_GXEnfnjs';

export const MAXBET_WAITING_SEC = 7;
export const MAXBET_WAITING_MS = MAXBET_WAITING_SEC * 1000;
export const MAXBET_GROWTH_K = 0.06;
export const MAXBET_POLL_INTERVAL_MS = 400;

export function multiplierAtFlightSec(sec: number): number {
  const t = Math.max(0, sec);
  return 1 + 0.012 * t + 0.013 * t * t;
}

export function flightSecForMultiplier(mult: number): number {
  const delta = Math.max(0, mult - 1);
  return (-0.012 + Math.sqrt(0.000144 + 0.052 * delta)) / 0.026;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 2500
): Promise<Response> {
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timerId);
  }
}

export async function fetchMaxBetCrashTick(): Promise<MaxBetTickResult> {
  const sentAt = Date.now();
  const res = await fetchWithTimeout(
    `${MAXBET_SUPABASE_URL}/rest/v1/rpc/crash_tick`,
    {
      method: 'POST',
      headers: {
        apikey: MAXBET_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
    2500
  );
  const recvAt = Date.now();

  if (!res.ok) {
    throw new Error(`crash_tick HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    round?: MaxBetRemoteRound;
    server_now?: number | string;
  };

  if (!data?.round || typeof data.round.id !== 'number') {
    throw new Error('Invalid crash_tick payload');
  }

  const serverNow = Number(data.server_now);
  return {
    round: data.round,
    serverNow: Number.isFinite(serverNow) ? serverNow : recvAt,
    sentAt,
    recvAt,
  };
}

export async function fetchMaxBetRoundById(
  roundId: number
): Promise<MaxBetHistoryRound | null> {
  try {
    const res = await fetchWithTimeout(
      `${MAXBET_SUPABASE_URL}/rest/v1/crash_rounds?select=id,crash_point,started_at,crashed_at&id=eq.${Math.round(
        roundId
      )}&status=eq.crashed&limit=1`,
      {
        headers: {
          apikey: MAXBET_SUPABASE_ANON_KEY,
        },
      },
      2500
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      id: number;
      crash_point: number | string | null;
      started_at: string | null;
      crashed_at: string | null;
    }>;
    const first = rows?.[0];
    if (!first || first.crash_point === null) return null;
    const cp = Number(first.crash_point);
    if (!Number.isFinite(cp) || cp < 1) return null;
    return {
      id: first.id,
      crash_point: Number(cp.toFixed(2)),
      started_at: first.started_at,
      crashed_at: first.crashed_at,
    };
  } catch {
    return null;
  }
}

export async function fetchRecentMaxBetCrashRounds(
  limit = 20
): Promise<MaxBetHistoryRound[]> {
  try {
    const res = await fetch(
      `${MAXBET_SUPABASE_URL}/rest/v1/crash_rounds?select=id,crash_point,started_at,crashed_at&status=eq.crashed&order=id.desc&limit=${limit}`,
      {
        headers: {
          apikey: MAXBET_SUPABASE_ANON_KEY,
        },
      }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
      id: number;
      crash_point: number | string | null;
      started_at: string | null;
      crashed_at: string | null;
    }>;
    return (rows ?? [])
      .filter((r) => r.crash_point !== null && Number(r.crash_point) >= 1)
      .map((r) => ({
        id: r.id,
        crash_point: Number(Number(r.crash_point).toFixed(2)),
        started_at: r.started_at,
        crashed_at: r.crashed_at,
      }));
  } catch {
    return [];
  }
}
