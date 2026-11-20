import { useCallback, useEffect, useRef, useState } from 'react';
import { BetPanel } from './components/BetPanel';
import { CrashModals } from './components/CrashModals';
import { CrashScene } from './components/CrashScene';
import { Header } from './components/Header';
import {
  HISTORY_ICON_URI,
  STATS_BETS_ICON_URI,
  STATS_PROFIT_ICON_URI,
  STATS_TOTAL_ICON_URI,
} from './data/crashAssets';
import {
  generateCrashPoint,
  generateSimulatedBets,
  INITIAL_HISTORY_ROUNDS,
  MAX_CRASH_POINT,
} from './data/mockRounds';
import {
  ActiveSheet,
  AutoPlayConfig,
  BetNoticeToast,
  BetSlotId,
  BetSlotState,
  GamePhase,
  HistoryRound,
  LiveBetRow,
  SceneResultBanner,
} from './types/crash';
import {
  fetchCurrentRoundStateFromFirebase,
  FirebasePredictionSignal,
  FirebaseRoundState,
  recordCrashHistoryToFirebase,
  subscribeToCurrentRoundFromFirebase,
  subscribeToFirebaseAvailability,
  subscribeToFirebasePredictions,
  syncRoundPhaseToFirebase,
} from './services/firebaseCrash';
import {
  flightSecForMultiplier,
  MAXBET_GROWTH_K,
  MAXBET_WAITING_MS,
  MAXBET_WAITING_SEC,
  multiplierAtFlightSec,
} from './services/maxbetLive';

const WAITING_DURATION_MS = MAXBET_WAITING_MS;
const CRASH_PAUSE_MS = 2200;
const FLIGHT_GROWTH_K = MAXBET_GROWTH_K;
const INITIAL_BALANCE = 1000;
const SESSION_STORAGE_KEY = 'maxbet_crash_session_v2';
const LEGACY_STORAGE_KEY = 'maxbet_crash_session_v1';
const GLOBAL_EPOCH_MS = Date.UTC(2026, 10, 15, 0, 0, 0);

function floorMultiplier(val: number): number {
  return Math.floor(val * 100) / 100;
}

function formatEgpAmount(amount: number): string {
  const rounded = Number(amount.toFixed(2));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

const CONSUMED_TOKENS_KEY = 'maxbet_consumed_fb_tokens_v1';

function loadConsumedTokens(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(CONSUMED_TOKENS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x): x is string => typeof x === 'string').slice(-60));
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return new Set();
}

function saveConsumedTokens(tokens: Set<string>) {
  try {
    window.sessionStorage.setItem(
      CONSUMED_TOKENS_KEY,
      JSON.stringify(Array.from(tokens).slice(-60))
    );
  } catch {
    // Ignore storage access errors
  }
}

const HISTORY_ICON_STYLE = {
  maskImage: `url("${HISTORY_ICON_URI}")`,
  WebkitMaskImage: `url("${HISTORY_ICON_URI}")`,
};
const STATS_BETS_ICON_STYLE = {
  maskImage: `url("${STATS_BETS_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_BETS_ICON_URI}")`,
};
const STATS_TOTAL_ICON_STYLE = {
  maskImage: `url("${STATS_TOTAL_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_TOTAL_ICON_URI}")`,
};
const STATS_PROFIT_ICON_STYLE = {
  maskImage: `url("${STATS_PROFIT_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_PROFIT_ICON_URI}")`,
};

type BetSlotsTuple = [BetSlotState, BetSlotState, BetSlotState];
const SLOT_IDS: readonly BetSlotId[] = [0, 1, 2];

function createInitialSlot(id: BetSlotId): BetSlotState {
  return {
    id,
    inputValue: '20',
    activeBet: null,
    queuedBet: null,
    autoConfig: {
      enabled: false,
      baseStake: 20,
      autoCashout: 2,
      roundsRemaining: null,
      onWin: 'continue',
      onLoss: 'continue',
    },
  };
}

function cloneSlotsTuple(slots: BetSlotsTuple): BetSlotsTuple {
  return [
    { ...slots[0], autoConfig: { ...slots[0].autoConfig } },
    { ...slots[1], autoConfig: { ...slots[1].autoConfig } },
    { ...slots[2], autoConfig: { ...slots[2].autoConfig } },
  ];
}

function normalizeSlotsTuple(rawSlots: unknown[]): BetSlotsTuple {
  return [
    (rawSlots[0] as BetSlotState) ?? createInitialSlot(0),
    (rawSlots[1] as BetSlotState) ?? createInitialSlot(1),
    (rawSlots[2] as BetSlotState) ?? createInitialSlot(2),
  ];
}

interface PersistedCrashSession {
  roundNumber: number;
  roundStartedAt: number;
  crashPoint: number;
  balance: number;
  slots: BetSlotsTuple;
  historyRounds: HistoryRound[];
}

interface ResolvedTimelineState {
  roundNumber: number;
  roundStartedAt: number;
  crashPoint: number;
  phase: GamePhase;
  phaseElapsedMs: number;
  countdownSeconds: number;
  crashedMultiplier: number;
  flightCrashedSec: number;
  balance: number;
  slots: BetSlotsTuple;
  historyRounds: HistoryRound[];
  simulatedRows: LiveBetRow[];
  baseStats: { count: number; pool: number };
}

function buildSimulatedForState(
  roundNumber: number,
  phase: GamePhase,
  phaseElapsedMs: number,
  crashPoint: number
) {
  const sim = generateSimulatedBets(roundNumber);
  if (phase === 'waiting') {
    return {
      rows: sim.rows,
      baseStats: { count: sim.totalBetsCount, pool: sim.baseTotalPool },
    };
  }
  const liveMult =
    phase === 'flight'
      ? floorMultiplier(multiplierAtFlightSec(phaseElapsedMs / 1000))
      : crashPoint;
  const rows: LiveBetRow[] = sim.rows.map((row) => {
    const won =
      phase === 'flight'
        ? liveMult >= row.targetCashout
        : row.targetCashout < crashPoint;
    if (won) {
      return {
        ...row,
        cashedOutAt: row.targetCashout,
        payout: Number((row.stake * row.targetCashout).toFixed(2)),
        status: 'win',
      };
    }
    return phase === 'crashed' ? { ...row, status: 'loss', payout: 0 } : row;
  });
  return {
    rows,
    baseStats: { count: sim.totalBetsCount, pool: sim.baseTotalPool },
  };
}

function resolveTimelineToNow(
  seed: PersistedCrashSession,
  nowEpoch: number
): ResolvedTimelineState {
  let roundNumber = seed.roundNumber;
  let roundStartedAt = seed.roundStartedAt;
  let crashPoint = seed.crashPoint;
  let balance = seed.balance;
  let slots: BetSlotsTuple = cloneSlotsTuple(seed.slots);
  let historyRounds = [...seed.historyRounds];

  const settleCompletedRound = (targetCrash: number, rNum: number) => {
    let roundStake = 0;
    let roundPayout = 0;
    let bestCashout: number | null = null;
    for (const idx of SLOT_IDS) {
      const s = slots[idx];
      if (!s.activeBet) continue;
      roundStake += s.activeBet.stake;
      if (s.activeBet.cashedOutAt !== null) {
        roundPayout += s.activeBet.payout;
        bestCashout =
          bestCashout === null
            ? s.activeBet.cashedOutAt
            : Math.max(bestCashout, s.activeBet.cashedOutAt);
      } else if (
        s.autoConfig.enabled &&
        s.autoConfig.autoCashout < targetCrash
      ) {
        const autoPay = Number(
          (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
        );
        balance = Number((balance + autoPay).toFixed(2));
        roundPayout += autoPay;
        bestCashout =
          bestCashout === null
            ? s.autoConfig.autoCashout
            : Math.max(bestCashout, s.autoConfig.autoCashout);
        slots[idx] = {
          ...s,
          activeBet: {
            ...s.activeBet,
            cashedOutAt: s.autoConfig.autoCashout,
            payout: autoPay,
          },
        };
      }
    }
    if (roundStake > 0 && !historyRounds.some((h) => h.roundNumber === rNum)) {
      historyRounds = [
        {
          id: `r-${rNum}-${nowEpoch}`,
          roundNumber: rNum,
          crashPoint: targetCrash,
          stake: Number(roundStake.toFixed(2)),
          cashoutAt: bestCashout,
          payout: Number(roundPayout.toFixed(2)),
          timestamp: 'منذ لحظات',
        },
        ...historyRounds.slice(0, 29),
      ];
    }
  };

  if (nowEpoch - roundStartedAt > 45 * 60 * 1000) {
    settleCompletedRound(crashPoint, roundNumber);
    for (const idx of SLOT_IDS) {
      if (slots[idx].queuedBet !== null) {
        balance = Number((balance + (slots[idx].queuedBet ?? 0)).toFixed(2));
      }
      slots[idx] = {
        ...slots[idx],
        activeBet: null,
        queuedBet: null,
        autoConfig: { ...slots[idx].autoConfig, enabled: false },
      };
    }
    const avgCycle = 12000;
    const gap = nowEpoch - roundStartedAt;
    roundNumber += Math.max(1, Math.floor(gap / avgCycle));
    roundStartedAt = nowEpoch - (gap % avgCycle);
    crashPoint = generateCrashPoint(roundNumber);
  }

  let phase: GamePhase = 'waiting';
  let phaseElapsedMs = 0;

  for (let steps = 0; steps < 300; steps++) {
    const flightStartedAt = roundStartedAt + WAITING_DURATION_MS;
    const flightDurationMs =
      flightSecForMultiplier(Math.max(1.01, crashPoint)) * 1000;
    const crashedAt = flightStartedAt + flightDurationMs;
    const roundEndedAt = crashedAt + CRASH_PAUSE_MS;

    if (nowEpoch < flightStartedAt) {
      phase = 'waiting';
      phaseElapsedMs = Math.max(0, nowEpoch - roundStartedAt);
      break;
    }

    if (nowEpoch < crashedAt) {
      phase = 'flight';
      phaseElapsedMs = Math.max(0, nowEpoch - flightStartedAt);
      const liveMult = floorMultiplier(
        multiplierAtFlightSec(phaseElapsedMs / 1000)
      );
      for (const idx of SLOT_IDS) {
        const s = slots[idx];
        if (
          s.activeBet &&
          s.activeBet.cashedOutAt === null &&
          s.autoConfig.enabled &&
          liveMult >= s.autoConfig.autoCashout
        ) {
          const payout = Number(
            (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
          );
          balance = Number((balance + payout).toFixed(2));
          slots[idx] = {
            ...s,
            activeBet: {
              ...s.activeBet,
              cashedOutAt: s.autoConfig.autoCashout,
              payout,
            },
          };
        }
      }
      break;
    }

    if (nowEpoch < roundEndedAt) {
      phase = 'crashed';
      phaseElapsedMs = Math.max(0, nowEpoch - crashedAt);
      settleCompletedRound(crashPoint, roundNumber);
      break;
    }

    // Round finished while away -> settle and advance to next round
    settleCompletedRound(crashPoint, roundNumber);
    let deducted = 0;
    for (const idx of SLOT_IDS) {
      const s = slots[idx];
      const wonPrev = s.activeBet !== null && s.activeBet.cashedOutAt !== null;
      const lostPrev =
        s.activeBet !== null && s.activeBet.cashedOutAt === null;
      const nextAuto = { ...s.autoConfig };
      if (nextAuto.enabled && s.activeBet !== null) {
        if (wonPrev && nextAuto.onWin === 'stop') nextAuto.enabled = false;
        else if (lostPrev && nextAuto.onLoss === 'stop')
          nextAuto.enabled = false;
        else if (nextAuto.roundsRemaining !== null) {
          const left = nextAuto.roundsRemaining - 1;
          nextAuto.roundsRemaining = left <= 0 ? null : left;
          if (left <= 0) nextAuto.enabled = false;
        }
      }
      let nextActive: BetSlotState['activeBet'] = null;
      if (s.queuedBet !== null) {
        nextActive = { stake: s.queuedBet, cashedOutAt: null, payout: 0 };
      } else if (nextAuto.enabled && balance - deducted >= nextAuto.baseStake) {
        deducted += nextAuto.baseStake;
        nextActive = {
          stake: nextAuto.baseStake,
          cashedOutAt: null,
          payout: 0,
        };
      }
      slots[idx] = {
        ...s,
        activeBet: nextActive,
        queuedBet: null,
        autoConfig: nextAuto,
      };
    }
    if (deducted > 0) {
      balance = Number(Math.max(0, balance - deducted).toFixed(2));
    }

    roundNumber += 1;
    roundStartedAt = roundEndedAt;
    crashPoint = generateCrashPoint(roundNumber);
  }

  const remainingWait = Math.max(0, WAITING_DURATION_MS - phaseElapsedMs);
  const countdownSeconds =
    phase === 'waiting'
      ? Math.max(
          1,
          Math.min(
            MAXBET_WAITING_SEC,
            Math.ceil((remainingWait / WAITING_DURATION_MS) * MAXBET_WAITING_SEC)
          )
        )
      : MAXBET_WAITING_SEC;
  const flightCrashedSec =
    phase === 'crashed' ? flightSecForMultiplier(crashPoint) : 0;
  const crashedMultiplier = phase === 'crashed' ? crashPoint : 1.0;

  const simState = buildSimulatedForState(
    roundNumber,
    phase,
    phaseElapsedMs,
    crashPoint
  );

  return {
    roundNumber,
    roundStartedAt,
    crashPoint,
    phase,
    phaseElapsedMs,
    countdownSeconds,
    crashedMultiplier,
    flightCrashedSec,
    balance,
    slots,
    historyRounds,
    simulatedRows: simState.rows,
    baseStats: simState.baseStats,
  };
}

function loadBootSession(): {
  resolved: ResolvedTimelineState;
  hadSavedSession: boolean;
  savedLiveRound?: {
    roundNumber: number;
    slots: BetSlotsTuple;
  };
} {
  const now = Date.now();
  let carriedBalance = INITIAL_BALANCE;
  let carriedHistory = INITIAL_HISTORY_ROUNDS;

  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedCrashSession>;
      if (typeof parsed.balance === 'number') {
        carriedBalance = parsed.balance;
      }
      if (Array.isArray(parsed.historyRounds)) {
        carriedHistory = parsed.historyRounds;
      }
      if (
        typeof parsed.roundNumber === 'number' &&
        typeof parsed.roundStartedAt === 'number' &&
        typeof parsed.crashPoint === 'number' &&
        parsed.roundStartedAt > 0 &&
        parsed.crashPoint >= 1 &&
        Array.isArray(parsed.slots) &&
        parsed.slots.length >= 2
      ) {
        const normalizedSlots = normalizeSlotsTuple(parsed.slots);
        const hasPendingBet = normalizedSlots.some(
          (s) => s.activeBet !== null || s.queuedBet !== null
        );

        // If crashPoint was Infinity (live server round), clamp safe boot preview until first crash_tick (~100ms)
        const safeCrash = Number.isFinite(parsed.crashPoint)
          ? Math.min(MAX_CRASH_POINT, Math.max(1, parsed.crashPoint))
          : MAX_CRASH_POINT;

        return {
          hadSavedSession: true,
          savedLiveRound: hasPendingBet
            ? {
                roundNumber: parsed.roundNumber,
                slots: normalizedSlots,
              }
            : undefined,
          resolved: resolveTimelineToNow(
            {
              roundNumber: parsed.roundNumber,
              roundStartedAt: parsed.roundStartedAt,
              crashPoint: safeCrash,
              balance: carriedBalance,
              slots: normalizedSlots,
              historyRounds: carriedHistory,
            },
            now
          ),
        };
      }
    } else {
      const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as Partial<PersistedCrashSession>;
        if (typeof legacy.balance === 'number') carriedBalance = legacy.balance;
        if (Array.isArray(legacy.historyRounds)) {
          carriedHistory = legacy.historyRounds;
        }
      }
    }
  } catch {
    // Fallback to global epoch timeline below
  }

  const cycleMs = 20000;
  const sinceEpoch = Math.max(0, now - GLOBAL_EPOCH_MS);
  const estRound = 1320 + Math.floor(sinceEpoch / cycleMs);
  const roundStartedAt = now - (sinceEpoch % cycleMs);
  return {
    hadSavedSession: false,
    resolved: resolveTimelineToNow(
      {
        roundNumber: estRound,
        roundStartedAt,
        crashPoint: generateCrashPoint(estRound),
        balance: carriedBalance,
        slots: [createInitialSlot(0), createInitialSlot(1), createInitialSlot(2)],
        historyRounds: carriedHistory,
      },
      now
    ),
  };
}

export default function App() {
  const bootRef = useRef<{
    resolved: ResolvedTimelineState;
    hadSavedSession: boolean;
    savedLiveRound?: {
      roundNumber: number;
      slots: BetSlotsTuple;
    };
    initialPerfNow: number;
  } | null>(null);
  if (bootRef.current === null) {
    bootRef.current = {
      ...loadBootSession(),
      initialPerfNow: performance.now(),
    };
  }
  const initial = bootRef.current.resolved;
  const initialPhaseStartPerf =
    bootRef.current.initialPerfNow - initial.phaseElapsedMs;

  const [balance, setBalance] = useState<number>(initial.balance);
  const [phase, setPhase] = useState<GamePhase>(initial.phase);
  const [countdownSeconds, setCountdownSeconds] = useState<number>(
    initial.countdownSeconds
  );
  const [waitStartTime, setWaitStartTime] = useState<number>(
    initialPhaseStartPerf
  );
  const [flightStartTime, setFlightStartTime] = useState<number>(
    initialPhaseStartPerf
  );
  const [crashStartTime, setCrashStartTime] = useState<number>(
    initial.phase === 'crashed' && !bootRef.current.hadSavedSession
      ? bootRef.current.initialPerfNow - 99000
      : initialPhaseStartPerf
  );
  const [crashedMultiplier, setCrashedMultiplier] = useState<number>(
    initial.crashedMultiplier
  );
  const [flightCrashedSec, setFlightCrashedSec] = useState<number>(
    initial.flightCrashedSec
  );
  const [roundNumber, setRoundNumber] = useState<number>(initial.roundNumber);

  const [slots, setSlots] = useState<BetSlotsTuple>(initial.slots);

  const [simulatedRows, setSimulatedRows] = useState<LiveBetRow[]>(
    initial.simulatedRows
  );
  const [baseStats, setBaseStats] = useState<{
    count: number;
    pool: number;
  }>(initial.baseStats);

  const [historyRounds, setHistoryRounds] = useState<HistoryRound[]>(
    initial.historyRounds
  );
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const visibleSlotIds: BetSlotId[] =
    initial.slots[2].activeBet !== null || initial.slots[2].queuedBet !== null
      ? [0, 1, 2]
      : [0, 1];
  const [betNotice, setBetNotice] = useState<BetNoticeToast | null>(null);
  const [resultBanner, setResultBanner] = useState<SceneResultBanner | null>(null);
  const [notifications, setNotifications] = useState([
    {
      id: 'n-1',
      title: 'مرحباً بك في Crash — MaxBet',
      body: 'توقّع لحظة الانفجار واسحب أرباحك في الوقت المناسب. يمكنك شحن رصيدك التجريبي من أيقونة المحفظة بالأعلى.',
      time: 'الآن',
      unread: true,
    },
  ]);

  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const roundNumberRef = useRef(roundNumber);
  roundNumberRef.current = roundNumber;

  const historyRoundsRef = useRef(historyRounds);
  historyRoundsRef.current = historyRounds;

  const crashPointRef = useRef<number>(initial.crashPoint);
  const roundStartedAtRef = useRef<number>(initial.roundStartedAt);
  const pendingFirebasePredictionRef = useRef<FirebasePredictionSignal | null>(
    null
  );
  const activeFirebaseOverrideRef = useRef<number | null>(null);
  const consumedFirebaseTokensRef = useRef<Set<string>>(loadConsumedTokens());
  const phaseStartRef = useRef<number>(initialPhaseStartPerf);
  const lastSyncEpochRef = useRef<number>(Date.now());
  const toastCounterRef = useRef<number>(1);
  const lastSettledCrashRoundRef = useRef<number>(-1);
  const [pendingCashouts, setPendingCashouts] = useState<
    [boolean, boolean, boolean]
  >([false, false, false]);
  const [isFirebaseClosed, setIsFirebaseClosed] = useState<boolean>(false);
  const isFirebaseClosedRef = useRef<boolean>(false);
  isFirebaseClosedRef.current = isFirebaseClosed;
  const pendingCashoutDataRef = useRef<
    [
      { mult: number; roundId: number; timerId: number } | null,
      { mult: number; roundId: number; timerId: number } | null,
      { mult: number; roundId: number; timerId: number } | null
    ]
  >([null, null, null]);

  const persistSession = useCallback(() => {
    try {
      const payload: PersistedCrashSession = {
        roundNumber: roundNumberRef.current,
        roundStartedAt: roundStartedAtRef.current,
        crashPoint: Number.isFinite(crashPointRef.current)
          ? Math.min(MAX_CRASH_POINT, Math.max(1, crashPointRef.current))
          : MAX_CRASH_POINT,
        balance: balanceRef.current,
        slots: slotsRef.current,
        historyRounds: historyRoundsRef.current,
      };
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors in restricted embeds
    }
  }, []);

  const applyResolvedState = useCallback(
    (resolved: ResolvedTimelineState) => {
      const nowPerf = performance.now();
      const startPerf = nowPerf - resolved.phaseElapsedMs;

      roundNumberRef.current = resolved.roundNumber;
      roundStartedAtRef.current = resolved.roundStartedAt;
      crashPointRef.current = resolved.crashPoint;
      phaseRef.current = resolved.phase;
      phaseStartRef.current = startPerf;
      balanceRef.current = resolved.balance;
      slotsRef.current = resolved.slots;
      historyRoundsRef.current = resolved.historyRounds;

      setRoundNumber(resolved.roundNumber);
      setPhase(resolved.phase);
      setCountdownSeconds(resolved.countdownSeconds);
      setWaitStartTime(startPerf);
      setFlightStartTime(startPerf);
      setCrashStartTime(startPerf);
      setCrashedMultiplier(resolved.crashedMultiplier);
      setFlightCrashedSec(resolved.flightCrashedSec);
      setBalance(resolved.balance);
      setSlots(resolved.slots);
      setHistoryRounds(resolved.historyRounds);
      setSimulatedRows(resolved.simulatedRows);
      setBaseStats(resolved.baseStats);
    },
    []
  );

  const resolveRoundCrashPoint = useCallback((targetRound: number) => {
    const signal = pendingFirebasePredictionRef.current;
    if (
      signal &&
      !consumedFirebaseTokensRef.current.has(signal.token) &&
      (signal.roundNumber === undefined || signal.roundNumber === targetRound)
    ) {
      consumedFirebaseTokensRef.current.add(signal.token);
      saveConsumedTokens(consumedFirebaseTokensRef.current);
      pendingFirebasePredictionRef.current = null;
      return Number(
        Math.min(MAX_CRASH_POINT, Math.max(1, signal.crashPoint)).toFixed(2)
      );
    }
    return generateCrashPoint();
  }, []);

  useEffect(() => {
    persistSession();
  }, [balance, slots, historyRounds, phase, roundNumber, persistSession]);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => {
    const id = ++toastCounterRef.current;
    setBetNotice({ id, type, text });
    window.setTimeout(() => {
      setBetNotice((curr) => (curr?.id === id ? null : curr));
    }, 2200);
  }, []);

  const showBanner = useCallback((type: 'win' | 'loss', text: string) => {
    const id = ++toastCounterRef.current;
    setResultBanner({ id, type, text });
    window.setTimeout(() => {
      setResultBanner((curr) => (curr?.id === id ? null : curr));
    }, 2400);
  }, []);

  const settleCashout = useCallback(
    (slotId: BetSlotId, atMultiplier: number) => {
      const targetSlot = slotsRef.current[slotId];
      if (!targetSlot.activeBet || targetSlot.activeBet.cashedOutAt !== null) {
        return;
      }
      const cappedMult = Number(
        Math.min(MAX_CRASH_POINT, Math.max(1, atMultiplier)).toFixed(2)
      );
      const payout = Number(
        (targetSlot.activeBet.stake * cappedMult).toFixed(2)
      );

      setSlots((prev) => {
        const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
        const curr = next[slotId];
        if (!curr.activeBet || curr.activeBet.cashedOutAt !== null) return prev;
        next[slotId] = {
          ...curr,
          activeBet: {
            ...curr.activeBet,
            cashedOutAt: cappedMult,
            payout,
          },
        };
        return next;
      });

      setBalance((b) => Number((b + payout).toFixed(2)));
      showBanner('win', `لقد فزت: EGP ${formatEgpAmount(payout)}`);
    },
    [showBanner]
  );

  const triggerCrashState = useCallback(
    (crashTarget: number, targetRoundId: number, suppressBanner = false) => {
      if (lastSettledCrashRoundRef.current === targetRoundId) {
        return;
      }
      lastSettledCrashRoundRef.current = targetRoundId;

      const safeCrash = Number(
        Math.min(MAX_CRASH_POINT, Math.max(1, crashTarget)).toFixed(2)
      );
      const crashSec = flightSecForMultiplier(safeCrash);
      const nowPerf = performance.now();

      crashPointRef.current = safeCrash;
      activeFirebaseOverrideRef.current = null;
      phaseStartRef.current = nowPerf;
      phaseRef.current = 'crashed';
      setCrashStartTime(suppressBanner ? nowPerf - 99000 : nowPerf);
      setFlightCrashedSec(crashSec);
      setCrashedMultiplier(safeCrash);
      setPhase('crashed');

      syncRoundPhaseToFirebase({
        roundNumber: targetRoundId,
        phase: 'crashed',
        crashPoint: safeCrash,
        roundStartedAt: roundStartedAtRef.current,
        flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
      });
      recordCrashHistoryToFirebase({
        roundNumber: targetRoundId,
        crashPoint: safeCrash,
      });

      // Settle simulated players who hadn't cashed out before crashTarget
      setSimulatedRows((prev) =>
        prev.map((row) =>
          row.cashedOutAt !== null
            ? row
            : row.targetCashout < safeCrash
            ? {
                ...row,
                cashedOutAt: row.targetCashout,
                payout: Number((row.stake * row.targetCashout).toFixed(2)),
                status: 'win',
              }
            : { ...row, status: 'loss', payout: 0 }
        )
      );

      // Finalize any cashouts locked just before crash + pending auto-cashouts strictly below crashTarget
      let extraPayout = 0;
      const resolvedSlots: BetSlotsTuple = [
        slotsRef.current[0],
        slotsRef.current[1],
        slotsRef.current[2],
      ];
      let clearedAnyPending = false;
      for (const idx of SLOT_IDS) {
        const pendingLock = pendingCashoutDataRef.current[idx];
        if (pendingLock) {
          window.clearTimeout(pendingLock.timerId);
          pendingCashoutDataRef.current[idx] = null;
          clearedAnyPending = true;
        }
        const s = resolvedSlots[idx];
        if (
          pendingLock &&
          pendingLock.roundId === targetRoundId &&
          s.activeBet &&
          s.activeBet.cashedOutAt === null
        ) {
          const lockedPay = Number(
            (s.activeBet.stake * pendingLock.mult).toFixed(2)
          );
          extraPayout += lockedPay;
          resolvedSlots[idx] = {
            ...s,
            activeBet: {
              ...s.activeBet,
              cashedOutAt: pendingLock.mult,
              payout: lockedPay,
            },
          };
          continue;
        }

        if (
          s.activeBet &&
          s.activeBet.cashedOutAt === null &&
          s.autoConfig.enabled &&
          s.autoConfig.autoCashout < safeCrash
        ) {
          const autoPay = Number(
            (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
          );
          extraPayout += autoPay;
          resolvedSlots[idx] = {
            ...s,
            activeBet: {
              ...s.activeBet,
              cashedOutAt: s.autoConfig.autoCashout,
              payout: autoPay,
            },
          };
        }
      }
      if (clearedAnyPending) {
        setPendingCashouts([false, false, false]);
      }
      if (extraPayout > 0) {
        slotsRef.current = resolvedSlots;
        setSlots(resolvedSlots);
        setBalance((b) => Number((b + extraPayout).toFixed(2)));
        if (!suppressBanner) {
          showBanner('win', `لقد فزت: EGP ${formatEgpAmount(extraPayout)}`);
        }
      }

      // Settle user bets & update history
      let roundStake = 0;
      let roundPayout = 0;
      let bestCashout: number | null = null;
      let hadLoss = false;

      resolvedSlots.forEach((slot) => {
        if (slot.activeBet) {
          roundStake += slot.activeBet.stake;
          if (slot.activeBet.cashedOutAt !== null) {
            roundPayout += slot.activeBet.payout;
            bestCashout =
              bestCashout === null
                ? slot.activeBet.cashedOutAt
                : Math.max(bestCashout, slot.activeBet.cashedOutAt);
          } else {
            hadLoss = true;
          }
        }
      });

      if (roundStake > 0) {
        setHistoryRounds((prev) => {
          if (prev.some((h) => h.roundNumber === targetRoundId)) return prev;
          const newHistory: HistoryRound = {
            id: `r-${targetRoundId}-${Date.now()}`,
            roundNumber: targetRoundId,
            crashPoint: safeCrash,
            stake: Number(roundStake.toFixed(2)),
            cashoutAt: bestCashout,
            payout: Number(roundPayout.toFixed(2)),
            timestamp: 'الآن',
          };
          return [newHistory, ...prev.slice(0, 29)];
        });

        if (!suppressBanner && hadLoss && roundPayout === 0) {
          showBanner('loss', 'سيحالفك الحظ في المرة القادمة');
        }
      }
    },
    [showBanner]
  );

  const promoteSlotsForNextRound = useCallback(
    (nextRoundId: number, currentRoundId: number) => {
      // Settle any previous active bet if user returned mid-transition
      const prevSlots = slotsRef.current;
      const hadUnresolvedPrev =
        lastSettledCrashRoundRef.current !== currentRoundId &&
        prevSlots.some((s) => s.activeBet !== null);

      if (hadUnresolvedPrev && currentRoundId > 0) {
        const cp = Number.isFinite(crashPointRef.current)
          ? Math.min(MAX_CRASH_POINT, Math.max(1, crashPointRef.current))
          : generateCrashPoint(currentRoundId);
        let refundOrPayout = 0;
        let stakeSum = 0;
        let bestCo: number | null = null;
        for (const s of prevSlots) {
          if (!s.activeBet) continue;
          stakeSum += s.activeBet.stake;
          if (s.activeBet.cashedOutAt !== null) {
            refundOrPayout += s.activeBet.payout;
            bestCo =
              bestCo === null
                ? s.activeBet.cashedOutAt
                : Math.max(bestCo, s.activeBet.cashedOutAt);
          } else if (s.autoConfig.enabled && s.autoConfig.autoCashout < cp) {
            const p = Number(
              (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
            );
            refundOrPayout += p;
            bestCo =
              bestCo === null
                ? s.autoConfig.autoCashout
                : Math.max(bestCo, s.autoConfig.autoCashout);
            setBalance((b) => Number((b + p).toFixed(2)));
          }
        }
        if (stakeSum > 0) {
          setHistoryRounds((prev) => {
            if (prev.some((h) => h.roundNumber === currentRoundId)) return prev;
            return [
              {
                id: `r-${currentRoundId}-${Date.now()}`,
                roundNumber: currentRoundId,
                crashPoint: Number(cp.toFixed(2)),
                stake: Number(stakeSum.toFixed(2)),
                cashoutAt: bestCo,
                payout: Number(refundOrPayout.toFixed(2)),
                timestamp: 'منذ لحظات',
              },
              ...prev.slice(0, 29),
            ];
          });
        }
      }

      let deductedTotal = 0;
      const updatedSlots: BetSlotsTuple = [
        prevSlots[0],
        prevSlots[1],
        prevSlots[2],
      ];

      for (const idx of SLOT_IDS) {
        const s = prevSlots[idx];
        const wonPrev =
          s.activeBet !== null && s.activeBet.cashedOutAt !== null;
        const lostPrev =
          s.activeBet !== null && s.activeBet.cashedOutAt === null;

        const nextAuto = { ...s.autoConfig };
        if (nextAuto.enabled && s.activeBet !== null) {
          if (wonPrev && nextAuto.onWin === 'stop') {
            nextAuto.enabled = false;
          } else if (lostPrev && nextAuto.onLoss === 'stop') {
            nextAuto.enabled = false;
          } else if (nextAuto.roundsRemaining !== null) {
            const left = nextAuto.roundsRemaining - 1;
            if (left <= 0) {
              nextAuto.enabled = false;
              nextAuto.roundsRemaining = null;
            } else {
              nextAuto.roundsRemaining = left;
            }
          }
        }

        let nextActiveBet: BetSlotState['activeBet'] = null;
        if (s.queuedBet !== null) {
          nextActiveBet = {
            stake: s.queuedBet,
            cashedOutAt: null,
            payout: 0,
          };
        } else if (nextAuto.enabled) {
          const available = balanceRef.current - deductedTotal;
          if (available >= nextAuto.baseStake) {
            deductedTotal += nextAuto.baseStake;
            nextActiveBet = {
              stake: nextAuto.baseStake,
              cashedOutAt: null,
              payout: 0,
            };
          } else {
            nextAuto.enabled = false;
            showNotice('error', 'الرصيد غير كافٍ لإكمال التشغيل التلقائي');
          }
        }

        updatedSlots[idx] = {
          ...s,
          activeBet: nextActiveBet,
          queuedBet: null,
          autoConfig: nextAuto,
        };
      }

      if (deductedTotal > 0) {
        setBalance((b) => Number(Math.max(0, b - deductedTotal).toFixed(2)));
      }
      slotsRef.current = updatedSlots;
      setSlots(updatedSlots);

      const sim = generateSimulatedBets(nextRoundId);
      setSimulatedRows(sim.rows);
      setBaseStats({ count: sim.totalBetsCount, pool: sim.baseTotalPool });
    },
    [showNotice]
  );

  // Persist session and reconcile timeline when returning from background/tab switch
  useEffect(() => {
    const handleBackground = () => {
      persistSession();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistSession();
      } else if (!isFirebaseClosedRef.current) {
        const now = Date.now();
        if (now - lastSyncEpochRef.current > 1500) {
          const reconciled = resolveTimelineToNow(
            {
              roundNumber: roundNumberRef.current,
              roundStartedAt: roundStartedAtRef.current,
              crashPoint: Number.isFinite(crashPointRef.current)
                ? crashPointRef.current
                : generateCrashPoint(roundNumberRef.current),
              balance: balanceRef.current,
              slots: slotsRef.current,
              historyRounds: historyRoundsRef.current,
            },
            now
          );
          applyResolvedState(reconciled);
          lastSyncEpochRef.current = now;
        }
      }
    };

    window.addEventListener('pagehide', handleBackground);
    window.addEventListener('beforeunload', handleBackground);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', handleBackground);
      window.removeEventListener('beforeunload', handleBackground);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [applyResolvedState, persistSession]);

  // Firebase RTDB connection (round sync + explicit prediction overrides + kill-switch)
  useEffect(() => {
    const handleDatabaseClosed = () => {
      if (isFirebaseClosedRef.current) return;
      isFirebaseClosedRef.current = true;
      setIsFirebaseClosed(true);
      pendingFirebasePredictionRef.current = null;
      activeFirebaseOverrideRef.current = null;

      // Safely cancel pending cashout timers and refund any unsettled bets
      let refund = 0;
      const nextSlots: BetSlotsTuple = [
        slotsRef.current[0],
        slotsRef.current[1],
        slotsRef.current[2],
      ];
      for (const idx of SLOT_IDS) {
        const lock = pendingCashoutDataRef.current[idx];
        if (lock) {
          window.clearTimeout(lock.timerId);
          pendingCashoutDataRef.current[idx] = null;
        }
        const s = nextSlots[idx];
        if (s.activeBet && s.activeBet.cashedOutAt === null) {
          refund += s.activeBet.stake;
        }
        if (s.queuedBet !== null) {
          refund += s.queuedBet;
        }
        if (s.activeBet || s.queuedBet !== null) {
          nextSlots[idx] = { ...s, activeBet: null, queuedBet: null };
        }
      }
      setPendingCashouts([false, false, false]);
      if (refund > 0) {
        setBalance((b) => Number((b + refund).toFixed(2)));
        slotsRef.current = nextSlots;
        setSlots(nextSlots);
      }
    };

    const unsubAvailability = subscribeToFirebaseAvailability((isOpen) => {
      if (!isOpen) {
        handleDatabaseClosed();
      } else if (isFirebaseClosedRef.current) {
        isFirebaseClosedRef.current = false;
        setIsFirebaseClosed(false);
      }
    });

    const maybeAdoptRemoteRound = (
      remote: FirebaseRoundState,
      isInitialFetch: boolean
    ) => {
      if (isFirebaseClosedRef.current) return;

      const now = Date.now();
      if (now - remote.roundStartedAt > 15 * 60 * 1000) {
        return;
      }

      const isNewerRound = remote.roundNumber > roundNumberRef.current;
      const isDifferentSameRound =
        remote.roundNumber === roundNumberRef.current &&
        Math.abs(remote.roundStartedAt - roundStartedAtRef.current) > 1500 &&
        (isInitialFetch || remote.updatedAt > lastSyncEpochRef.current);

      if (
        (!bootRef.current?.hadSavedSession && isInitialFetch) ||
        isNewerRound ||
        isDifferentSameRound
      ) {
        const reconciled = resolveTimelineToNow(
          {
            roundNumber: remote.roundNumber,
            roundStartedAt: remote.roundStartedAt,
            crashPoint: remote.crashPoint,
            balance: balanceRef.current,
            slots: slotsRef.current,
            historyRounds: historyRoundsRef.current,
          },
          now
        );
        applyResolvedState(reconciled);
        lastSyncEpochRef.current = now;
        persistSession();
      }
    };

    fetchCurrentRoundStateFromFirebase().then((remote) => {
      if (remote && Date.now() - remote.roundStartedAt <= 15 * 60 * 1000) {
        maybeAdoptRemoteRound(remote, true);
      } else if (!isFirebaseClosedRef.current) {
        syncRoundPhaseToFirebase({
          roundNumber: roundNumberRef.current,
          phase: phaseRef.current,
          crashPoint: Number.isFinite(crashPointRef.current)
            ? crashPointRef.current
            : 1,
          roundStartedAt: roundStartedAtRef.current,
          flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
        });
      }
    });

    const unsubRound = subscribeToCurrentRoundFromFirebase(
      (remote) => {
        maybeAdoptRemoteRound(remote, false);
      },
      handleDatabaseClosed
    );

    const unsubPredictions = subscribeToFirebasePredictions(
      (signal) => {
        if (isFirebaseClosedRef.current) return;
        if (consumedFirebaseTokensRef.current.has(signal.token)) {
          return;
        }
        if (
          signal.roundNumber !== undefined &&
          signal.roundNumber < roundNumberRef.current
        ) {
          return;
        }
        const cappedSignalPoint = Number(
          Math.min(MAX_CRASH_POINT, Math.max(1, signal.crashPoint)).toFixed(2)
        );
        const safeSignal = { ...signal, crashPoint: cappedSignalPoint };

        if (
          phaseRef.current === 'waiting' &&
          (safeSignal.roundNumber === undefined ||
            safeSignal.roundNumber === roundNumberRef.current)
        ) {
          consumedFirebaseTokensRef.current.add(safeSignal.token);
          saveConsumedTokens(consumedFirebaseTokensRef.current);
          activeFirebaseOverrideRef.current = cappedSignalPoint;
          crashPointRef.current = cappedSignalPoint;
          syncRoundPhaseToFirebase({
            roundNumber: roundNumberRef.current,
            phase: 'waiting',
            crashPoint: cappedSignalPoint,
            roundStartedAt: roundStartedAtRef.current,
            flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
          });
          persistSession();
          return;
        }

        pendingFirebasePredictionRef.current = safeSignal;
      },
      handleDatabaseClosed
    );

    return () => {
      unsubAvailability();
      unsubRound();
      unsubPredictions();
    };
  }, [applyResolvedState, persistSession]);


  // Main game phase loop driven by requestAnimationFrame
  useEffect(() => {
    let rafId = 0;

    const tick = (now: number) => {
      if (isFirebaseClosedRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      lastSyncEpochRef.current = Date.now();
      const elapsed = now - phaseStartRef.current;
      const currentPhase = phaseRef.current;

      if (currentPhase === 'waiting') {
        const remainingMs = Math.max(0, WAITING_DURATION_MS - elapsed);
        const sec = Math.max(
          1,
          Math.min(
            MAXBET_WAITING_SEC,
            Math.ceil((remainingMs / WAITING_DURATION_MS) * MAXBET_WAITING_SEC)
          )
        );
        setCountdownSeconds((prev) => (prev !== sec ? sec : prev));

        if (elapsed >= WAITING_DURATION_MS) {
          const pending = pendingFirebasePredictionRef.current;
          if (
            pending &&
            !consumedFirebaseTokensRef.current.has(pending.token) &&
            (pending.roundNumber === undefined ||
              pending.roundNumber === roundNumberRef.current)
          ) {
            consumedFirebaseTokensRef.current.add(pending.token);
            saveConsumedTokens(consumedFirebaseTokensRef.current);
            const cappedOverride = Number(
              Math.min(MAX_CRASH_POINT, Math.max(1, pending.crashPoint)).toFixed(2)
            );
            activeFirebaseOverrideRef.current = cappedOverride;
            crashPointRef.current = cappedOverride;
            pendingFirebasePredictionRef.current = null;
          } else if (!Number.isFinite(crashPointRef.current)) {
            crashPointRef.current = resolveRoundCrashPoint(
              roundNumberRef.current
            );
          }

          phaseStartRef.current = now;
          phaseRef.current = 'flight';
          setFlightStartTime(now);
          setPhase('flight');
          syncRoundPhaseToFirebase({
            roundNumber: roundNumberRef.current,
            phase: 'flight',
            crashPoint: Number.isFinite(crashPointRef.current)
              ? crashPointRef.current
              : 1,
            roundStartedAt: roundStartedAtRef.current,
            flightStartedAt: Date.now(),
          });
        }
      } else if (currentPhase === 'flight') {
        const sec = Math.max(0, elapsed / 1000);
        const nextMult = floorMultiplier(multiplierAtFlightSec(sec));
        const crashTarget = crashPointRef.current;

        if (
          (Number.isFinite(crashTarget) && nextMult >= crashTarget) ||
          nextMult >= MAX_CRASH_POINT
        ) {
          // Crash occurred (bounded strictly at MAX_CRASH_POINT = 35.00x)
          const targetCp = Number.isFinite(crashTarget)
            ? Math.min(MAX_CRASH_POINT, crashTarget)
            : MAX_CRASH_POINT;
          triggerCrashState(targetCp, roundNumberRef.current, false);
        } else {
          // Settle simulated players hitting targetCashout
          setSimulatedRows((prev) => {
            let changed = false;
            const mapped = prev.map((row) => {
              if (row.cashedOutAt === null && nextMult >= row.targetCashout) {
                changed = true;
                return {
                  ...row,
                  cashedOutAt: row.targetCashout,
                  payout: Number((row.stake * row.targetCashout).toFixed(2)),
                  status: 'win' as const,
                };
              }
              return row;
            });
            return changed ? mapped : prev;
          });

          // Auto-cashout check for user slots
          slotsRef.current.forEach((slot) => {
            if (
              slot.activeBet &&
              slot.activeBet.cashedOutAt === null &&
              slot.autoConfig.enabled &&
              nextMult >= slot.autoConfig.autoCashout
            ) {
              settleCashout(slot.id, slot.autoConfig.autoCashout);
            }
          });
        }
      } else if (currentPhase === 'crashed') {
        // Never leave the scene frozen after explosion finishes (~1.3s):
        // always transition cleanly into the next waiting round after CRASH_PAUSE_MS (2.2s).
        if (elapsed >= CRASH_PAUSE_MS) {
          const prevRound = roundNumberRef.current;
          const nextRound = prevRound + 1;
          roundNumberRef.current = nextRound;
          setRoundNumber(nextRound);

          promoteSlotsForNextRound(nextRound, prevRound);

          const newRoundStartEpoch = Date.now();
          roundStartedAtRef.current = newRoundStartEpoch;
          activeFirebaseOverrideRef.current = null;
          crashPointRef.current = resolveRoundCrashPoint(nextRound);
          syncRoundPhaseToFirebase({
            roundNumber: nextRound,
            phase: 'waiting',
            crashPoint: crashPointRef.current,
            roundStartedAt: newRoundStartEpoch,
            flightStartedAt: newRoundStartEpoch + WAITING_DURATION_MS,
          });

          phaseStartRef.current = now;
          phaseRef.current = 'waiting';
          setWaitStartTime(now);
          setPhase('waiting');
          setCountdownSeconds(MAXBET_WAITING_SEC);
          setCrashedMultiplier(1.0);
          setFlightCrashedSec(0);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    promoteSlotsForNextRound,
    resolveRoundCrashPoint,
    settleCashout,
    triggerCrashState,
  ]);

  const handleChangeInput = (slotId: BetSlotId, value: string) => {
    let sanitized = value.replace(/[^0-9.]/g, '');
    if (/^0[0-9]/.test(sanitized)) {
      sanitized = sanitized.replace(/^0+/, '') || '0';
    }
    setSlots((prev) => {
      const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
      next[slotId] = { ...next[slotId], inputValue: sanitized };
      return next;
    });
  };

  const handlePickPreset = (slotId: BetSlotId, amount: number) => {
    setSlots((prev) => {
      const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
      const currentVal = Number.parseFloat(next[slotId].inputValue);
      const safeCurrent =
        Number.isFinite(currentVal) && currentVal > 0 ? currentVal : 0;
      const sum = Math.round((safeCurrent + amount) * 100) / 100;
      next[slotId] = { ...next[slotId], inputValue: String(sum) };
      return next;
    });
  };

  const handleClearInput = (slotId: BetSlotId) => {
    setSlots((prev) => {
      const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
      next[slotId] = { ...next[slotId], inputValue: '0' };
      return next;
    });
  };

  const handleAction = (slotId: BetSlotId) => {
    if (isFirebaseClosedRef.current) {
      showNotice('error', 'تم إيقاف التوقعات — قاعدة البيانات مغلقة');
      return;
    }
    const slot = slots[slotId];
    const currPhase = phase;

    // 1. Live Cashout during flight (with brief 3-dot loader & locked multiplier snapshot)
    if (
      currPhase === 'flight' &&
      slot.activeBet !== null &&
      slot.activeBet.cashedOutAt === null
    ) {
      if (pendingCashoutDataRef.current[slotId]) {
        return;
      }
      const elapsedSec = Math.max(
        0,
        (performance.now() - phaseStartRef.current) / 1000
      );
      const liveMult = floorMultiplier(multiplierAtFlightSec(elapsedSec));
      if (liveMult < crashPointRef.current && liveMult < MAX_CRASH_POINT) {
        const snapshotMult = Number(
          Math.min(MAX_CRASH_POINT, Math.max(1.0, liveMult)).toFixed(2)
        );
        const snapshotRound = roundNumberRef.current;

        setPendingCashouts((prev) => {
          const next: [boolean, boolean, boolean] = [prev[0], prev[1], prev[2]];
          next[slotId] = true;
          return next;
        });

        const timerId = window.setTimeout(() => {
          const locked = pendingCashoutDataRef.current[slotId];
          pendingCashoutDataRef.current[slotId] = null;
          setPendingCashouts((prev) => {
            const next: [boolean, boolean, boolean] = [prev[0], prev[1], prev[2]];
            next[slotId] = false;
            return next;
          });
          if (locked && roundNumberRef.current === locked.roundId) {
            settleCashout(slotId, locked.mult);
          }
        }, 480);

        pendingCashoutDataRef.current[slotId] = {
          mult: snapshotMult,
          roundId: snapshotRound,
          timerId,
        };
      }
      return;
    }

    // 2. Waiting bet already accepted or next-round bet queued -> locked cleanly
    if ((currPhase === 'waiting' && slot.activeBet !== null) || slot.queuedBet !== null) {
      return;
    }

    // 3. Place new bet (either immediate in waiting, or queued for next round during flight/crashed including after cashout)
    const stake = Number.parseFloat(slot.inputValue);
    if (Number.isNaN(stake) || stake < 1) {
      showNotice('error', 'أدخل قيمة رهان صالحة (1 EGP على الأقل)');
      return;
    }
    if (stake > balance) {
      showNotice('error', 'الرصيد غير كافٍ — يمكنك الإيداع من المحفظة');
      return;
    }

    const roundedStake = Number(stake.toFixed(2));
    setBalance((b) => Number((b - roundedStake).toFixed(2)));

    if (currPhase === 'waiting') {
      setSlots((prev) => {
        const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
        next[slotId] = {
          ...next[slotId],
          activeBet: { stake: roundedStake, cashedOutAt: null, payout: 0 },
        };
        return next;
      });
      showNotice('success', 'تم قبول الرهان!');
    } else {
      setSlots((prev) => {
        const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
        next[slotId] = { ...next[slotId], queuedBet: roundedStake };
        return next;
      });
      showNotice('success', 'تم الرهان في الجولة القادمة');
    }
  };

  const handleSaveAutoPlay = (slotId: BetSlotId, config: AutoPlayConfig) => {
    const slot = slots[slotId];
    const shouldPlaceNow =
      phase === 'waiting' &&
      slot.activeBet === null &&
      balance >= config.baseStake;

    if (shouldPlaceNow) {
      setBalance((b) => Number((b - config.baseStake).toFixed(2)));
    }

    setSlots((prev) => {
      const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
      next[slotId] = {
        ...next[slotId],
        inputValue: String(config.baseStake),
        autoConfig: config,
        activeBet: shouldPlaceNow
          ? { stake: config.baseStake, cashedOutAt: null, payout: 0 }
          : next[slotId].activeBet,
      };
      return next;
    });
    showNotice('success', `تم تفعيل التشغيل التلقائي عند x${config.autoCashout}`);
  };

  const handleDisableAutoPlay = (slotId: BetSlotId) => {
    setSlots((prev) => {
      const next: BetSlotsTuple = [prev[0], prev[1], prev[2]];
      next[slotId] = {
        ...next[slotId],
        autoConfig: { ...next[slotId].autoConfig, enabled: false },
      };
      return next;
    });
    showNotice('success', 'تم إيقاف التشغيل التلقائي');
  };

  const handleDeposit = (amount: number) => {
    setBalance((b) => Number((b + amount).toFixed(2)));
    showNotice('success', `تم إضافة ${amount.toFixed(2)} ج.م إلى الرصيد`);
  };

  // Build user live bet rows so they appear highlighted with .is-me at top of the list
  const userLiveRows: LiveBetRow[] = [];
  slots.forEach((slot) => {
    if (slot.activeBet) {
      const isWin = slot.activeBet.cashedOutAt !== null;
      const isLoss = phase === 'crashed' && !isWin;
      userLiveRows.push({
        id: `me-${slot.id}`,
        username: '1881260001',
        stake: slot.activeBet.stake,
        targetCashout: slot.autoConfig.enabled ? slot.autoConfig.autoCashout : 0,
        cashedOutAt: slot.activeBet.cashedOutAt,
        payout: slot.activeBet.payout,
        isMe: true,
        status: isWin ? 'win' : isLoss ? 'loss' : 'active',
      });
    }
  });

  // Natural countdown ramp during waiting (7s -> 1s) matching reference video progression
  const waitRampSteps = [0.014, 0.022, 0.036, 0.085, 0.145, 0.23, 0.96];
  const waitStepIdx = Math.max(
    0,
    Math.min(waitRampSteps.length - 1, MAXBET_WAITING_SEC - countdownSeconds)
  );
  const waitRampRatio = phase === 'waiting' ? waitRampSteps[waitStepIdx] : 1;

  const visibleSimRows =
    phase === 'waiting'
      ? simulatedRows.slice(
          0,
          Math.min(
            simulatedRows.length,
            Math.max(2, Math.round(simulatedRows.length * Math.min(1, waitRampRatio * 1.45)))
          )
        )
      : simulatedRows;

  const combinedRows = [...userLiveRows, ...visibleSimRows];

  const userStakeSum = userLiveRows.reduce((acc, r) => acc + r.stake, 0);
  const simProfitSum = visibleSimRows.reduce(
    (acc, r) => acc + (r.cashedOutAt !== null ? r.payout : 0),
    0
  );
  const userProfitSum = userLiveRows.reduce((acc, r) => acc + r.payout, 0);

  const displayBetsCount =
    Math.max(visibleSimRows.length, Math.round(baseStats.count * waitRampRatio)) +
    userLiveRows.length;
  const visibleSimStakeSum = visibleSimRows.reduce((acc, r) => acc + r.stake, 0);
  const displayTotalPool = Number(
    (
      (phase === 'waiting' && waitRampRatio < 0.5
        ? visibleSimStakeSum
        : baseStats.pool * waitRampRatio) + userStakeSum
    ).toFixed(2)
  );
  const displayTotalProfit =
    phase === 'waiting'
      ? 0
      : Number((simProfitSum * 0.55 + userProfitSum).toFixed(2));

  const unreadCount = notifications.filter((n) => n.unread).length;
  const activeAutoSlot =
    activeSheet?.type === 'auto' ? slots[activeSheet.slotId] : undefined;

  return (
    <div id="top" className="flex min-h-dvh w-full flex-col">
      <Header
        balance={balance}
        unreadCount={unreadCount}
        onOpenDeposit={() => setActiveSheet({ type: 'deposit' })}
        onOpenNotifications={() => {
          setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
          setActiveSheet({ type: 'notifications' });
        }}
        onBack={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />

      <div className="c1x">
        <main className="recording-shell">
          <div className="game-canvas" dir="rtl">
            <div className="game-content">
              <nav className="game-tabs" aria-label="تبويبات اللعبة">
                <button
                  type="button"
                  className="terms-tab"
                  onClick={() => setActiveSheet({ type: 'terms' })}
                >
                  الأحكام و الشروط
                </button>
                <button
                  type="button"
                  className="history-tab"
                  onClick={() => setActiveSheet({ type: 'history' })}
                >
                  <i
                    className="ico"
                    aria-hidden="true"
                    style={HISTORY_ICON_STYLE}
                  />
                  <span>السجل</span>
                </button>
              </nav>

              <CrashScene
                phase={phase}
                countdownSeconds={countdownSeconds}
                waitStartTime={waitStartTime}
                flightStartTime={flightStartTime}
                crashStartTime={crashStartTime}
                crashedMultiplier={crashedMultiplier}
                flightCrashedSec={flightCrashedSec}
                flightGrowthK={FLIGHT_GROWTH_K}
                resultBanner={resultBanner}
                betNotice={betNotice}
                isFirebaseClosed={isFirebaseClosed}
              />

              <div className="bet-stack">
                {visibleSlotIds.map((slotId) => (
                  <BetPanel
                    key={slotId}
                    slot={slots[slotId]}
                    phase={phase}
                    isCashoutPending={pendingCashouts[slotId]}
                    isDisabled={isFirebaseClosed}
                    canClose={false}
                    onChangeInput={handleChangeInput}
                    onPickPreset={handlePickPreset}
                    onClearInput={handleClearInput}
                    onAction={handleAction}
                    onOpenAuto={(id) => setActiveSheet({ type: 'auto', slotId: id })}
                  />
                ))}
              </div>

              <section className="stats-row">
                <div>
                  <span>عدد الرهانات</span>
                  <b>
                    {displayBetsCount}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_BETS_ICON_STYLE}
                    />
                  </b>
                </div>
                <div>
                  <span>مجموع الرهانات</span>
                  <b>
                    {displayTotalPool.toFixed(2)}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_TOTAL_ICON_STYLE}
                    />
                  </b>
                  <strong>EGP</strong>
                </div>
                <div>
                  <span>مجموع الربح</span>
                  <b>
                    {displayTotalProfit <= 0
                      ? '0'
                      : displayTotalProfit.toFixed(2)}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_PROFIT_ICON_STYLE}
                    />
                  </b>
                  <strong>EGP</strong>
                </div>
              </section>

              <section className="bets-list" aria-label="قائمة الرهانات">
                <div className="list-head">
                  <span>اسم المستخدم</span>
                  <span>الفرص</span>
                  <span>الرهان</span>
                  <span>الأرباح</span>
                </div>

                {combinedRows.map((row) => (
                  <div
                    key={row.id}
                    className={`bet-row ${
                      row.status === 'win'
                        ? 'is-win'
                        : row.status === 'loss'
                        ? 'is-loss'
                        : ''
                    } ${row.isMe ? 'is-me' : ''}`}
                  >
                    <span>{row.username}</span>
                    <span>
                      x
                      {row.cashedOutAt !== null
                        ? row.cashedOutAt.toFixed(2)
                        : '0'}
                    </span>
                    <span>EGP {Number(row.stake.toFixed(2))}</span>
                    <span>
                      EGP {row.cashedOutAt !== null ? Number(row.payout.toFixed(2)) : 0}
                    </span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </main>
      </div>

      <CrashModals
        sheet={activeSheet}
        onClose={() => setActiveSheet(null)}
        historyRounds={historyRounds}
        currentSlotAuto={activeAutoSlot?.autoConfig}
        currentSlotInput={activeAutoSlot?.inputValue}
        onSaveAutoPlay={handleSaveAutoPlay}
        onDisableAutoPlay={handleDisableAutoPlay}
        balance={balance}
        onDeposit={handleDeposit}
        notifications={notifications}
      />
    </div>
  );
}
