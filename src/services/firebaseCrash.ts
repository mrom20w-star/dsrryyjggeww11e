import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import {
  get,
  getDatabase,
  onValue,
  ref,
  set,
  Unsubscribe,
} from 'firebase/database';
import { GamePhase } from '../types/crash';

const firebaseConfig = {
  apiKey: 'AIzaSyAlX1ASvDrf5BBtaB72AUYqSoW34YvP_y4',
  authDomain: 'mrwan-dd795.firebaseapp.com',
  databaseURL: 'https://mrwan-dd795-default-rtdb.firebaseio.com',
  projectId: 'mrwan-dd795',
  storageBucket: 'mrwan-dd795.firebasestorage.app',
  messagingSenderId: '12538399995',
  appId: '1:12538399995:web:4a7e6b40f611891fecb45e',
  measurementId: 'G-KBTHXXDYBL',
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db = getDatabase(app);

const CLIENT_ID = `c-${Math.random().toString(36).slice(2, 10)}`;

if (typeof window !== 'undefined') {
  isSupported()
    .then((supported) => {
      if (supported) {
        getAnalytics(app);
      }
    })
    .catch(() => {
      // Ignore analytics errors in restricted iframes or ad-blocked browsers
    });
}

export interface FirebasePredictionSignal {
  crashPoint: number;
  roundNumber?: number;
  sourcePath: string;
  token: string;
}

export interface FirebaseRoundState {
  roundNumber: number;
  phase: GamePhase;
  crashPoint: number;
  roundStartedAt: number;
  flightStartedAt: number;
  updatedAt: number;
  clientId?: string;
}

function parsePredictionPayload(
  raw: unknown,
  sourcePath: string
): FirebasePredictionSignal | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number' || typeof raw === 'string') {
    const val = Number(raw);
    if (Number.isFinite(val) && val >= 1 && val <= 10000) {
      const crashPoint = Number(val.toFixed(2));
      return {
        crashPoint,
        sourcePath,
        token: `${sourcePath}:${crashPoint}`,
      };
    }
    return null;
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate =
      obj.crashPoint ?? obj.multiplier ?? obj.value ?? obj.odd ?? obj.point;
    const val = Number(candidate);
    if (!Number.isFinite(val) || val < 1 || val > 10000) {
      return null;
    }

    const crashPoint = Number(val.toFixed(2));
    const roundCandidate = Number(obj.roundNumber ?? obj.round);
    const roundNumber =
      Number.isFinite(roundCandidate) && roundCandidate > 0
        ? Math.round(roundCandidate)
        : undefined;
    const updatedAt = obj.updatedAt ?? obj.timestamp ?? '';

    return {
      crashPoint,
      roundNumber,
      sourcePath,
      token: `${sourcePath}:${crashPoint}:${roundNumber ?? ''}:${String(updatedAt)}`,
    };
  }

  return null;
}

function parseRemoteRoundState(raw: unknown): FirebaseRoundState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const roundNumber = Number(obj.roundNumber);
  const crashPoint = Number(obj.crashPoint);
  const roundStartedAt = Number(obj.roundStartedAt);
  const flightStartedAt = Number(obj.flightStartedAt);
  const updatedAt = Number(obj.updatedAt);
  const phase = obj.phase;

  if (
    !Number.isFinite(roundNumber) ||
    roundNumber < 1 ||
    !Number.isFinite(crashPoint) ||
    crashPoint < 1 ||
    !Number.isFinite(roundStartedAt) ||
    roundStartedAt <= 0 ||
    (phase !== 'waiting' && phase !== 'flight' && phase !== 'crashed')
  ) {
    return null;
  }

  return {
    roundNumber: Math.round(roundNumber),
    phase,
    crashPoint: Number(crashPoint.toFixed(2)),
    roundStartedAt,
    flightStartedAt:
      Number.isFinite(flightStartedAt) && flightStartedAt > 0
        ? flightStartedAt
        : roundStartedAt + 4800,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : roundStartedAt,
    clientId: typeof obj.clientId === 'string' ? obj.clientId : undefined,
  };
}

function isPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const text = `${String(e.code ?? '')} ${String(e.message ?? '')}`;
  return /permission[_-]?denied/i.test(text);
}

export function subscribeToFirebasePredictions(
  onSignal: (signal: FirebasePredictionSignal) => void,
  onPermissionDenied?: () => void
): Unsubscribe {
  const paths = [
    'crash/override',
    'crash/nextPrediction',
    'predictions/next',
    'predictions/current',
  ];

  const unsubs = paths.map((path) =>
    onValue(
      ref(db, path),
      (snapshot) => {
        const parsed = parsePredictionPayload(snapshot.val(), path);
        if (parsed) {
          onSignal(parsed);
        }
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          onPermissionDenied?.();
        }
      }
    )
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}

export function subscribeToFirebaseAvailability(
  onStatusChange: (isOpen: boolean) => void
): Unsubscribe {
  let disposed = false;
  let retryTimerId: number | undefined;
  let activeUnsub: Unsubscribe | null = null;

  const stopRetry = () => {
    if (retryTimerId !== undefined) {
      window.clearInterval(retryTimerId);
      retryTimerId = undefined;
    }
  };

  const attachListener = () => {
    if (disposed) return;
    if (activeUnsub) {
      activeUnsub();
      activeUnsub = null;
    }

    activeUnsub = onValue(
      ref(db, 'crash'),
      (snapshot) => {
        if (disposed) return;
        stopRetry();
        const val = snapshot.val();
        if (
          val === false ||
          (typeof val === 'object' &&
            val !== null &&
            (val.enabled === false ||
              val.active === false ||
              val.predictionsEnabled === false))
        ) {
          onStatusChange(false);
          return;
        }
        onStatusChange(true);
      },
      (err) => {
        if (disposed) return;
        if (isPermissionDeniedError(err)) {
          onStatusChange(false);
          if (activeUnsub) {
            activeUnsub();
            activeUnsub = null;
          }
          if (retryTimerId === undefined) {
            retryTimerId = window.setInterval(() => {
              if (disposed) return;
              get(ref(db, 'crash'))
                .then((snap) => {
                  if (disposed) return;
                  stopRetry();
                  const val = snap.val();
                  const disabled =
                    val === false ||
                    (typeof val === 'object' &&
                      val !== null &&
                      (val.enabled === false ||
                        val.active === false ||
                        val.predictionsEnabled === false));
                  onStatusChange(!disabled);
                  attachListener();
                })
                .catch(() => {
                  // Still denied / closed
                });
            }, 3500);
          }
        }
      }
    );
  };

  attachListener();

  return () => {
    disposed = true;
    stopRetry();
    if (activeUnsub) {
      activeUnsub();
      activeUnsub = null;
    }
  };
}

export async function fetchCurrentRoundStateFromFirebase(): Promise<FirebaseRoundState | null> {
  try {
    const snap = await get(ref(db, 'crash/current'));
    return parseRemoteRoundState(snap.val());
  } catch {
    return null;
  }
}

export function subscribeToCurrentRoundFromFirebase(
  onRound: (state: FirebaseRoundState) => void,
  onPermissionDenied?: () => void
): Unsubscribe {
  return onValue(
    ref(db, 'crash/current'),
    (snapshot) => {
      const parsed = parseRemoteRoundState(snapshot.val());
      if (parsed && parsed.clientId !== CLIENT_ID) {
        onRound(parsed);
      }
    },
    (err) => {
      if (isPermissionDeniedError(err)) {
        onPermissionDenied?.();
      }
    }
  );
}

export function syncRoundPhaseToFirebase(params: {
  roundNumber: number;
  phase: GamePhase;
  crashPoint: number;
  roundStartedAt: number;
  flightStartedAt: number;
}): void {
  const { roundNumber, phase, crashPoint, roundStartedAt, flightStartedAt } =
    params;
  const now = Date.now();

  set(ref(db, 'crash/current'), {
    roundNumber,
    phase,
    crashPoint,
    roundStartedAt,
    flightStartedAt,
    updatedAt: now,
    clientId: CLIENT_ID,
  }).catch(() => {
    // Non-blocking in case client writes are disallowed by RTDB rules
  });

  if (phase === 'waiting') {
    set(ref(db, 'crash/prediction'), {
      roundNumber,
      crashPoint,
      updatedAt: now,
    }).catch(() => {});
  }
}

export function recordCrashHistoryToFirebase(params: {
  roundNumber: number;
  crashPoint: number;
}): void {
  const { roundNumber, crashPoint } = params;
  set(ref(db, `crash/history/${roundNumber}`), {
    roundNumber,
    crashPoint,
    crashedAt: Date.now(),
  }).catch(() => {
    // Non-blocking in case client writes are disallowed by RTDB rules
  });
}
