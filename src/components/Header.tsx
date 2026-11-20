interface HeaderProps {
  balance: number;
  unreadCount: number;
  onOpenDeposit: () => void;
  onOpenNotifications: () => void;
  onBack: () => void;
}

export function Header({
  balance,
  unreadCount,
  onOpenDeposit,
  onOpenNotifications,
  onBack,
}: HeaderProps) {
  void unreadCount;
  const formattedBalance = balance.toFixed(2);

  return (
    <div
      className="sticky top-0 z-40 w-full bg-white border-b border-[#e5e8ef]"
      dir="rtl"
    >
      <header className="flex h-[46px] w-full items-center justify-between px-3 md:h-[52px] md:px-6">
        {/* Right side (RTL start): back arrow */}
        <button
          type="button"
          aria-label="رجوع"
          onClick={onBack}
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#757575] transition-colors hover:bg-black/5 hover:text-[#4a4a4a] active:opacity-60"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="4" y1="12" x2="20" y2="12" />
            <polyline points="13 5 20 12 13 19" />
          </svg>
        </button>

        {/* Center: gray wallet capsule (#9e9e9e outer + #595959 inner) + red-orange + image */}
        <button
          type="button"
          aria-label="إيداع"
          onClick={onOpenDeposit}
          className="inline-flex max-w-[70vw] cursor-pointer items-center gap-[5px] rounded-full bg-[#9e9e9e] px-[4.5px] py-[4px] transition-transform active:scale-[0.98]"
        >
          <span
            dir="ltr"
            className="flex h-[24px] min-w-[76px] items-center justify-center rounded-[11px] bg-[#595959] px-3 text-[12px] font-medium leading-none tracking-[0.01em] text-white tabular-nums whitespace-nowrap"
          >
            {formattedBalance} ج.م
          </span>

          <span
            className="relative flex h-[24px] w-[32px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[#c52c06]"
            aria-hidden="true"
          >
            <img
              src="/assets/aistudio/photo_2026-11-20_02-00-25_ddb29093.jpg"
              alt=""
              draggable={false}
              className="h-full w-full scale-[1.22] object-cover select-none"
            />
          </span>
        </button>

        {/* Left side (RTL end): BONUS + rosette seal */}
        <button
          type="button"
          aria-label="المكافآت والإشعارات"
          onClick={onOpenNotifications}
          className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#757575] transition-colors hover:bg-black/5 active:opacity-60"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 34 34"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M17 2.8l1.9 1.7 2.5-.8 1.2 2.3 2.6.2.3 2.6 2.4 1.1-.6 2.5 1.8 1.9-1.4 2.2 1 2.4-2.1 1.5.1 2.6-2.5.7-.7 2.5-2.6-.2-1.6 2-2.3-1-2.2 1.3-1.8-1.9-2.5.4-1-2.4-2.5-.4-.1-2.6-2.2-1.3.8-2.5-1.5-2 1.7-2-.7-2.5 2.3-1.2.2-2.6 2.6-.3 1.1-2.4 2.5.6L17 2.8z"
              stroke="#757575"
              strokeWidth="1.4"
              strokeLinejoin="round"
              fill="#ffffff"
            />
            <text
              x="17"
              y="18.8"
              textAnchor="middle"
              fill="#757575"
              fontSize="5.2"
              fontWeight="800"
              fontFamily="Roboto, Arial, sans-serif"
              letterSpacing="0.25"
            >
              BONUS
            </text>
            <circle
              cx="25.6"
              cy="25.6"
              r="4.7"
              fill="#757575"
              stroke="#ffffff"
              strokeWidth="1.3"
            />
            <path
              d="M25.6 23.4v4.4M23.4 25.6h4.4"
              stroke="#ffffff"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
    </div>
  );
}
