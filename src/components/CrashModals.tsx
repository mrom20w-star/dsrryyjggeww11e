import { useEffect, useState } from 'react';
import {
  ActiveSheet,
  AutoPlayConfig,
  BetSlotId,
  HistoryRound,
  StopAction,
} from '../types/crash';

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  time: string;
  unread: boolean;
}

interface CrashModalsProps {
  sheet: ActiveSheet;
  onClose: () => void;
  historyRounds: HistoryRound[];
  currentSlotAuto?: AutoPlayConfig;
  currentSlotInput?: string;
  onSaveAutoPlay: (slotId: BetSlotId, config: AutoPlayConfig) => void;
  onDisableAutoPlay: (slotId: BetSlotId) => void;
  balance: number;
  onDeposit: (amount: number) => void;
  notifications: NotificationItem[];
}

export function CrashModals({
  sheet,
  onClose,
  historyRounds,
  currentSlotAuto,
  currentSlotInput,
  onSaveAutoPlay,
  onDisableAutoPlay,
  balance,
  onDeposit,
  notifications,
}: CrashModalsProps) {
  const [baseStakeStr, setBaseStakeStr] = useState('20');
  const [autoCashoutStr, setAutoCashoutStr] = useState('2.00');
  const [roundsStr, setRoundsStr] = useState('');
  const [onWin, setOnWin] = useState<StopAction>('continue');
  const [onLoss, setOnLoss] = useState<StopAction>('continue');
  const [autoError, setAutoError] = useState('');
  const [depositInput, setDepositInput] = useState('500');

  useEffect(() => {
    if (sheet?.type === 'auto' && currentSlotAuto) {
      setBaseStakeStr(
        currentSlotAuto.enabled
          ? String(currentSlotAuto.baseStake)
          : currentSlotInput || '20'
      );
      setAutoCashoutStr(
        currentSlotAuto.autoCashout ? String(currentSlotAuto.autoCashout) : '2.00'
      );
      setRoundsStr(
        currentSlotAuto.roundsRemaining !== null
          ? String(currentSlotAuto.roundsRemaining)
          : ''
      );
      setOnWin(currentSlotAuto.onWin);
      setOnLoss(currentSlotAuto.onLoss);
      setAutoError('');
    }
  }, [sheet, currentSlotAuto, currentSlotInput]);

  if (!sheet) return null;

  const handleAutoSubmit = () => {
    if (sheet.type !== 'auto') return;

    const stake = Number.parseFloat(baseStakeStr);
    const cashout = Number.parseFloat(autoCashoutStr);
    const roundsParsed =
      roundsStr.trim() === '' ? null : Number.parseInt(roundsStr.trim(), 10);

    if (Number.isNaN(stake) || stake < 1) {
      setAutoError('أدخل قيمة رهان أساسية صالحة (1 EGP على الأقل).');
      return;
    }
    if (Number.isNaN(cashout) || cashout < 1.01) {
      setAutoError('معامل السحب التلقائي يجب أن يكون 1.01x على الأقل.');
      return;
    }
    if (
      roundsParsed !== null &&
      (Number.isNaN(roundsParsed) || roundsParsed < 1)
    ) {
      setAutoError('عدد الجولات يجب أن يكون 1 على الأقل أو اتركه فارغاً.');
      return;
    }

    onSaveAutoPlay(sheet.slotId, {
      enabled: true,
      baseStake: Number(stake.toFixed(2)),
      autoCashout: Number(cashout.toFixed(2)),
      roundsRemaining: roundsParsed,
      onWin,
      onLoss,
    });
    onClose();
  };

  const handleDepositAmount = (amount: number) => {
    if (Number.isNaN(amount) || amount <= 0) return;
    onDeposit(amount);
    onClose();
  };

  return (
    <div
      className="c1x-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {sheet.type === 'terms' && (
        <div className="c1x-sheet">
          <button
            type="button"
            className="c1x-sheet-x"
            aria-label="إغلاق"
            onClick={onClose}
          >
            ×
          </button>
          <div className="c1x-sheet-title">الأحكام و الشروط</div>
          <div className="c1x-sheet-body">
            <h3>قواعد لعبة Crash</h3>
            <p>
              راقب إقلاع الطائرة وارتفاع المضاعف، واسحب أرباحك في الوقت المناسب قبل
              انفجار الطائرة.
            </p>
            <ol className="c1x-rules">
              <li>
                ضع رهانك خلال فترة العد التنازلي قبل الإقلاع، أو جهّز رهانك للجولة
                التالية أثناء الطيران.
              </li>
              <li>
                يبدأ المضاعف من 1.00x ويزداد تصاعدياً مع صعود الطائرة على المسار.
              </li>
              <li>
                اضغط على زر «سحب» في أي لحظة قبل الانفجار لتحصل على قيمة رهانك
                مضروبة في معامل السحب الحالي.
              </li>
              <li>
                في حال انفجار الطائرة قبل السحب، يُعتبر الرهان خاسراً لهذه الجولة.
              </li>
              <li>
                يمكنك تفعيل التشغيل التلقائي والسحب التلقائي عند معامل محدد مسبقاً
                من زر «تمكين التشغيل التلقائي».
              </li>
            </ol>
          </div>
        </div>
      )}

      {sheet.type === 'history' && (
        <div className="c1x-sheet is-history">
          <button
            type="button"
            className="c1x-sheet-x"
            aria-label="إغلاق"
            onClick={onClose}
          >
            ×
          </button>
          <div className="c1x-sheet-title">
            <svg
              className="c1x-clock"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>سجل الرهان</span>
          </div>
          <div className="c1x-sheet-body">
            {historyRounds.length === 0 ? (
              <div className="c1x-empty">لا توجد رهانات مسجلة بعد</div>
            ) : (
              historyRounds.map((round) => {
                const isWin = round.cashoutAt !== null && round.payout > 0;
                return (
                  <div key={round.id} className="c1x-hcard">
                    <div className="c1x-hhead">
                      <span>جولة #{round.roundNumber}</span>
                      <span>انفجار x{round.crashPoint.toFixed(2)}</span>
                    </div>
                    <div
                      className={`c1x-hrows ${
                        round.stake > 0 ? (isWin ? 'is-win' : 'is-loss') : ''
                      }`}
                    >
                      <div>
                        <span>قيمة الرهان</span>
                        <em>{round.stake.toFixed(2)} EGP</em>
                      </div>
                      <div>
                        <span>معامل السحب</span>
                        <em>
                          {round.cashoutAt !== null
                            ? `x${round.cashoutAt.toFixed(2)}`
                            : '—'}
                        </em>
                      </div>
                      <div>
                        <span>الأرباح</span>
                        <em>{round.payout.toFixed(2)} EGP</em>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {sheet.type === 'auto' && (
        <div className="c1x-sheet is-auto">
          <button
            type="button"
            className="c1x-sheet-x"
            aria-label="إغلاق"
            onClick={onClose}
          >
            ×
          </button>
          <div className="c1x-sheet-title">
            التشغيل التلقائي (لوحة {sheet.slotId + 1})
          </div>
          <div className="c1x-sheet-body">
            <label className="c1x-afield">
              <span>الرهان الأساسي (EGP)</span>
              <div className="amount-input">
                <input
                  inputMode="decimal"
                  value={baseStakeStr}
                  onChange={(e) => setBaseStakeStr(e.target.value)}
                />
                <button
                  type="button"
                  aria-label="مسح"
                  onClick={() => setBaseStakeStr('')}
                >
                  ×
                </button>
              </div>
            </label>

            <label className="c1x-afield">
              <span>السحب التلقائي عند (x)</span>
              <div className="amount-input">
                <input
                  inputMode="decimal"
                  value={autoCashoutStr}
                  onChange={(e) => setAutoCashoutStr(e.target.value)}
                />
                <button
                  type="button"
                  aria-label="مسح"
                  onClick={() => setAutoCashoutStr('')}
                >
                  ×
                </button>
              </div>
            </label>

            <label className="c1x-afield">
              <span>عدد الجولات (اختياري)</span>
              <div className="amount-input">
                <input
                  inputMode="numeric"
                  placeholder="غير محدود"
                  value={roundsStr}
                  onChange={(e) => setRoundsStr(e.target.value)}
                />
                <button
                  type="button"
                  aria-label="مسح"
                  onClick={() => setRoundsStr('')}
                >
                  ×
                </button>
              </div>
            </label>

            <div className="c1x-aopts">
              <div>
                <b className="win">عند الربح</b>
                <button
                  type="button"
                  className={`c1x-radio win ${
                    onWin === 'continue' ? 'is-on' : ''
                  }`}
                  onClick={() => setOnWin('continue')}
                >
                  <i />
                  <span>متابعة اللعب</span>
                </button>
                <button
                  type="button"
                  className={`c1x-radio win ${onWin === 'stop' ? 'is-on' : ''}`}
                  onClick={() => setOnWin('stop')}
                >
                  <i />
                  <span>إيقاف تلقائي</span>
                </button>
              </div>

              <div>
                <b className="loss">عند الخسارة</b>
                <button
                  type="button"
                  className={`c1x-radio loss ${
                    onLoss === 'continue' ? 'is-on' : ''
                  }`}
                  onClick={() => setOnLoss('continue')}
                >
                  <i />
                  <span>متابعة اللعب</span>
                </button>
                <button
                  type="button"
                  className={`c1x-radio loss ${
                    onLoss === 'stop' ? 'is-on' : ''
                  }`}
                  onClick={() => setOnLoss('stop')}
                >
                  <i />
                  <span>إيقاف تلقائي</span>
                </button>
              </div>
            </div>

            {autoError && <div className="c1x-aerr">{autoError}</div>}

            <div style={{ display: 'grid', gap: '6px' }}>
              <button
                type="button"
                className="c1x-astart"
                onClick={handleAutoSubmit}
              >
                {currentSlotAuto?.enabled
                  ? 'حفظ إعدادات التشغيل التلقائي'
                  : 'بدء التشغيل التلقائي'}
              </button>
              {currentSlotAuto?.enabled && (
                <button
                  type="button"
                  className="c1x-astart"
                  style={{ background: '#3d4577' }}
                  onClick={() => {
                    onDisableAutoPlay(sheet.slotId);
                    onClose();
                  }}
                >
                  إيقاف التشغيل التلقائي
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {sheet.type === 'deposit' && (
        <div className="c1x-sheet is-auto">
          <button
            type="button"
            className="c1x-sheet-x"
            aria-label="إغلاق"
            onClick={onClose}
          >
            ×
          </button>
          <div className="c1x-sheet-title">إضافة رصيد تجريبي</div>
          <div className="c1x-sheet-body">
            <p style={{ textAlign: 'center', marginTop: 0 }}>
              الرصيد الحالي: <strong>{balance.toFixed(2)} ج.م</strong>
            </p>
            <label className="c1x-afield">
              <span>مبلغ الإيداع (ج.م)</span>
              <div className="amount-input">
                <input
                  inputMode="decimal"
                  value={depositInput}
                  onChange={(e) => setDepositInput(e.target.value)}
                />
                <button
                  type="button"
                  aria-label="مسح"
                  onClick={() => setDepositInput('')}
                >
                  ×
                </button>
              </div>
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '6px',
                marginBottom: '10px',
              }}
            >
              {[100, 500, 1000, 5000].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setDepositInput(String(amt))}
                  style={{
                    background: '#222850',
                    border: '1px solid #3d4577',
                    borderRadius: '4px',
                    padding: '6px 0',
                    color: '#fff',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  +{amt}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="c1x-astart"
              onClick={() => handleDepositAmount(Number.parseFloat(depositInput))}
            >
              تأكيد الإيداع
            </button>
          </div>
        </div>
      )}

      {sheet.type === 'notifications' && (
        <div className="c1x-sheet is-history">
          <button
            type="button"
            className="c1x-sheet-x"
            aria-label="إغلاق"
            onClick={onClose}
          >
            ×
          </button>
          <div className="c1x-sheet-title">
            <span>الإشعارات</span>
          </div>
          <div className="c1x-sheet-body">
            {notifications.map((item) => (
              <div key={item.id} className="c1x-hcard">
                <div className="c1x-hhead">
                  <span>{item.title}</span>
                  <span>{item.time}</span>
                </div>
                <div className="c1x-hrows">
                  <div>
                    <span>{item.body}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
