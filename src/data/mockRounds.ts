import { HistoryRound, LiveBetRow } from '../types/crash';

export const PRESET_STAKES = [10, 50, 100, 400, 1000, 5000] as const;

export const INITIAL_SIMULATED_PLAYERS: Array<{
  username: string;
  stake: number;
  target: number;
}> = [
  { username: '83*******', stake: 848.35, target: 1.54 },
  { username: '03*******', stake: 465.44, target: 1.52 },
  { username: '81*******', stake: 373.4, target: 4.15 },
  { username: '17*******', stake: 181.57, target: 1.24 },
  { username: '39*******', stake: 141.4, target: 1.27 },
  { username: '97*******', stake: 688.86, target: 1.45 },
  { username: '76*******', stake: 664.57, target: 1.76 },
  { username: '21*******', stake: 480.74, target: 1.96 },
  { username: '10*******', stake: 545.67, target: 2.95 },
  { username: '65*******', stake: 512.4, target: 1.9 },
  { username: '80*******', stake: 492.18, target: 1.94 },
  { username: '37*******', stake: 421.71, target: 6.4 },
  { username: '93*******', stake: 389.73, target: 3.45 },
  { username: '04*******', stake: 347.1, target: 4.9 },
  { username: '89*******', stake: 319.72, target: 1.77 },
  { username: '77*******', stake: 288.59, target: 7.2 },
  { username: '50*******', stake: 263.48, target: 3.6 },
  { username: '49*******', stake: 237.41, target: 1.48 },
  { username: '96*******', stake: 213.54, target: 1.12 },
  { username: '15*******', stake: 195.22, target: 2.35 },
  { username: '71*******', stake: 174.03, target: 1.96 },
  { username: '88*******', stake: 157.16, target: 2.78 },
  { username: '53*******', stake: 142.21, target: 4.5 },
  { username: '48*******', stake: 120.5, target: 1.1 },
  { username: '85*******', stake: 110.14, target: 3.3 },
  { username: '09*******', stake: 96.92, target: 4.2 },
  { username: '16*******', stake: 81.23, target: 1.45 },
  { username: '57*******', stake: 76.5, target: 1.58 },
  { username: '41*******', stake: 51.72, target: 2.15 },
  { username: '62*******', stake: 47.44, target: 3.1 },
];

export const INITIAL_HISTORY_ROUNDS: HistoryRound[] = [
  {
    id: 'r-101',
    roundNumber: 4812,
    crashPoint: 3.42,
    stake: 100,
    cashoutAt: 2.15,
    payout: 215,
    timestamp: 'منذ دقيقتين',
  },
  {
    id: 'r-100',
    roundNumber: 4811,
    crashPoint: 1.38,
    stake: 50,
    cashoutAt: null,
    payout: 0,
    timestamp: 'منذ 4 دقائق',
  },
  {
    id: 'r-099',
    roundNumber: 4810,
    crashPoint: 6.84,
    stake: 200,
    cashoutAt: 3.1,
    payout: 620,
    timestamp: 'منذ 7 دقائق',
  },
];

// Full-avalanche SplitMix32 PRNG so sequential round numbers produce completely independent results
function createSplitMix32(seed: number): () => number {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 0x100000000;
  };
}

function getCryptoRandomUnit(): number {
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return arr[0] / 0x100000000;
  }
  return Math.random();
}

export const MAX_CRASH_POINT = 35;

export function generateCrashPoint(roundSeed?: number): number {
  let r: number;
  if (roundSeed !== undefined) {
    // Mix roundSeed through 3 rounds of avalanche SplitMix32 for complete independence
    const rng = createSplitMix32(
      Math.imul(roundSeed >>> 0, 0x27d4eb2d) ^ 0x165667b1
    );
    rng();
    r = rng();
  } else {
    r = getCryptoRandomUnit();
  }

  // ~3% instant bust (1.00x), varied realistic Crash curve capped strictly at 35.00x
  if (r < 0.03) {
    return 1.0;
  }
  const u = Math.min(0.9999, Math.max(0, (r - 0.03) / 0.97));
  const minInv = 1 / MAX_CRASH_POINT;
  const raw = 1 / (1 - u * (1 - minInv));
  const clamped = Math.min(Math.max(raw, 1.01), MAX_CRASH_POINT);
  return Number(clamped.toFixed(2));
}

export function generateSimulatedBets(roundSeed: number): {
  rows: LiveBetRow[];
  totalBetsCount: number;
  baseTotalPool: number;
} {
  const rng = createSplitMix32((roundSeed ^ 0x6a5b4c3d) >>> 0);
  const rows: LiveBetRow[] = Array.from({ length: 30 }, (_, idx) => {
    const prefix = String(Math.floor(rng() * 100)).padStart(2, '0');
    const r1 = rng();
    const r2 = rng();
    const stake = Math.round((45 + r1 * r2 * 1100) * 100) / 100;
    const targetCashout =
      rng() < 0.62
        ? Math.round((rng() < 0.7 ? 1.04 + rng() * 0.95 : 2 + rng() * 3.5) * 100) /
          100
        : 9999;

    return {
      id: `bot-${roundSeed}-${idx}`,
      username: `${prefix}*******`,
      stake,
      targetCashout,
      cashedOutAt: null,
      payout: 0,
      status: 'active' as const,
    };
  }).sort((a, b) => b.stake - a.stake);

  const statsRng = createSplitMix32((roundSeed ^ 0x23f3a197) >>> 0);
  const totalBetsCount = 148 + Math.floor(statsRng() * 115);
  const avgBet = 105 + statsRng() * 90;
  const cents = Math.floor(statsRng() * 100) / 100;
  const targetPool = Number((totalBetsCount * avgBet + cents).toFixed(2));

  return {
    rows,
    totalBetsCount,
    baseTotalPool: targetPool,
  };
}
