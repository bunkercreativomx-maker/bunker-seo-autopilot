// Bunker Rank brand mark: orange "B" whose lower counter is a rising staircase.
// Source of truth for the logo; public/brand/*.svg are exports of the same paths.
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="64 64 896 896" aria-hidden="true">
      <defs>
        <linearGradient id="br-o" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF8A1F" />
          <stop offset="1" stopColor="#F2600C" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="220" fill="#1C1F24" />
      <g transform="translate(22,0)">
        <path fill="url(#br-o)" stroke="url(#br-o)" strokeWidth="24" strokeLinejoin="round" d="M 300 240 H 566 C 690 240 706 420 646 474 C 770 520 760 784 598 784 H 300 Z" />
        <path fill="#1C1F24" stroke="#1C1F24" strokeWidth="28" strokeLinejoin="round" d="M 396 330 H 552 C 610 330 610 416 552 416 H 396 Z" />
        <path fill="#1C1F24" stroke="#1C1F24" strokeWidth="28" strokeLinejoin="round" d="M 396 694 V 640 H 464 V 586 H 532 V 532 H 600 V 694 Z" />
      </g>
    </svg>
  );
}

export function BrandName({ dark = true }: { dark?: boolean }) {
  return (
    <span className={`text-sm font-bold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}>
      Bunker <span className="text-sky-500">Rank</span>
    </span>
  );
}
