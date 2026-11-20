export type GamePhase = 'waiting' | 'flight' | 'crashed';

export type StopAction = 'stop' | 'continue';

export interface AutoPlayConfig {
  enabled: boolean;
  baseStake: number;
  autoCashout: number;
  roundsRemaining: number | null;
  onWin: StopAction;
  onLoss: StopAction;
}

export type BetSlotId = 0 | 1 | 2;

export interface BetSlotState {
  id: BetSlotId;
  inputValue: string;
  /** Bet placed for the currently active/upcoming round */
  activeBet: {
    stake: number;
    cashedOutAt: number | null;
    payout: number;
  } | null;
  /** Bet queued during flight/crash for the next round */
  queuedBet: number | null;
  autoConfig: AutoPlayConfig;
}

export interface LiveBetRow {
  id: string;
  username: string;
  stake: number;
  targetCashout: number;
  cashedOutAt: number | null;
  payout: number;
  isMe?: boolean;
  status: 'active' | 'win' | 'loss';
}

export interface HistoryRound {
  id: string;
  roundNumber: number;
  crashPoint: number;
  stake: number;
  cashoutAt: number | null;
  payout: number;
  timestamp: string;
}

export interface SceneResultBanner {
  id: number;
  type: 'win' | 'loss';
  text: string;
}

export interface BetNoticeToast {
  id: number;
  type: 'success' | 'error';
  text: string;
}

export type ActiveSheet =
  | null
  | { type: 'terms' }
  | { type: 'history' }
  | { type: 'auto'; slotId: BetSlotId }
  | { type: 'deposit' }
  | { type: 'notifications' };
