import { useState } from 'react';
import { PRESET_STAKES } from '../data/mockRounds';
import { BetSlotId, BetSlotState, GamePhase } from '../types/crash';

interface BetPanelProps {
  slot: BetSlotState;
  phase: GamePhase;
  isCashoutPending?: boolean;
  isDisabled?: boolean;
  canClose?: boolean;
  onChangeInput: (slotId: BetSlotId, value: string) => void;
  onPickPreset: (slotId: BetSlotId, amount: number) => void;
  onClearInput: (slotId: BetSlotId) => void;
  onAction: (slotId: BetSlotId) => void;
  onOpenAuto: (slotId: BetSlotId) => void;
  onClosePanel?: (slotId: BetSlotId) => void;
}

export function BetPanel({
  slot,
  phase,
  isCashoutPending = false,
  isDisabled = false,
  canClose = false,
  onChangeInput,
  onPickPreset,
  onClearInput,
  onAction,
  onOpenAuto,
  onClosePanel,
}: BetPanelProps) {
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const [pickedPreset, setPickedPreset] = useState<number | null>(null);

  const triggerPress = (key: string) => {
    setPressedKey(key);
    window.setTimeout(() => {
      setPressedKey((curr) => (curr === key ? null : curr));
    }, 160);
  };

  const flashPreset = (amount: number) => {
    setPickedPreset(amount);
    window.setTimeout(() => {
      setPickedPreset((curr) => (curr === amount ? null : curr));
    }, 150);
  };

  const isWaiting = phase === 'waiting';
  const isFlight = phase === 'flight';
  const isCrashed = phase === 'crashed';

  const hasUnsettledFlightBet =
    !isDisabled &&
    isFlight &&
    slot.activeBet !== null &&
    slot.activeBet.cashedOutAt === null;
  const hasWaitingBet = !isDisabled && isWaiting && slot.activeBet !== null;
  const hasQueuedNext = !isDisabled && slot.queuedBet !== null;

  const isInputsLocked =
    isDisabled ||
    isCashoutPending ||
    hasWaitingBet ||
    hasUnsettledFlightBet ||
    hasQueuedNext;

  const isAcceptedStyle = hasWaitingBet || hasQueuedNext;

  const showCloseBtn =
    canClose &&
    onClosePanel !== undefined &&
    !hasWaitingBet &&
    !hasUnsettledFlightBet &&
    !hasQueuedNext &&
    !isCashoutPending;

  const showNextRoundSublabel =
    !isCashoutPending &&
    !hasUnsettledFlightBet &&
    !hasWaitingBet &&
    !hasQueuedNext &&
    (isFlight || isCrashed);

  let primaryLabel = 'وضع الرهان';
  if (isCashoutPending) {
    primaryLabel = 'جاري السحب';
  } else if (hasUnsettledFlightBet && slot.activeBet) {
    primaryLabel = 'اجمع';
  } else if (hasWaitingBet || hasQueuedNext) {
    primaryLabel = 'تم قبول الرهان';
  } else {
    primaryLabel = 'وضع الرهان';
  }

  return (
    <section
      className={`bet-panel ${hasUnsettledFlightBet ? 'has-bet' : ''} ${
        isAcceptedStyle ? 'is-accepted' : ''
      } ${isInputsLocked && !hasUnsettledFlightBet ? 'is-locked' : ''} ${
        isInputsLocked ? 'is-inputs-locked' : ''
      }`}
      aria-label="لوحة الرهان"
    >
      <div className="bet-controls">
        <label className="amount-input">
          <input
            inputMode="decimal"
            aria-label="قيمة الرهان"
            value={slot.inputValue}
            disabled={isInputsLocked}
            onChange={(e) => onChangeInput(slot.id, e.target.value)}
          />
          <button
            type="button"
            aria-label="مسح القيمة"
            disabled={isInputsLocked}
            onClick={() => onClearInput(slot.id)}
          >
            ×
          </button>
        </label>

        <div className="amount-grid">
          {PRESET_STAKES.map((amount) => (
            <button
              key={amount}
              type="button"
              disabled={isInputsLocked}
              className={pickedPreset === amount ? 'is-picked' : ''}
              onClick={() => {
                flashPreset(amount);
                onPickPreset(slot.id, amount);
              }}
            >
              {amount}
            </button>
          ))}
        </div>
      </div>

      <div className="bet-actions">
        <div className="bet-actions-top">
          <button
            type="button"
            className={`auto-button ${slot.autoConfig.enabled ? 'is-on' : ''} ${
              pressedKey === 'auto' ? 'is-pressed' : ''
            }`}
            disabled={isDisabled}
            onClick={() => {
              triggerPress('auto');
              onOpenAuto(slot.id);
            }}
          >
            {slot.autoConfig.enabled ? (
              <span>إيقاف التشغيل التلقائي</span>
            ) : (
              <span className="auto-btn-lines">
                <span>تمكين التشغيل</span>
                <span>التلقائي</span>
              </span>
            )}
          </button>

          {showCloseBtn && (
            <button
              type="button"
              className="bet-panel-close"
              aria-label="إغلاق لوحة الرهان"
              onClick={() => onClosePanel(slot.id)}
            >
              ×
            </button>
          )}
        </div>

        <button
          type="button"
          className={`place-button ${
            isCashoutPending ? 'is-pending' : ''
          } ${isAcceptedStyle ? 'is-accepted' : ''} ${
            pressedKey === 'place' ? 'is-pressed' : ''
          }`}
          aria-busy={isCashoutPending ? 'true' : 'false'}
          disabled={
            isCashoutPending || isDisabled || hasWaitingBet || hasQueuedNext
          }
          onClick={() => {
            triggerPress('place');
            onAction(slot.id);
          }}
        >
          {isCashoutPending ? (
            <span className="bet-dots" aria-label="جاري السحب">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="place-button-lines">
              <span>{primaryLabel}</span>
              {showNextRoundSublabel && <small>(على الجولة التالية)</small>}
            </span>
          )}
        </button>
      </div>
    </section>
  );
}
