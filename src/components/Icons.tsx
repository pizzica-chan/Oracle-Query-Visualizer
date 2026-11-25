/**
 * 画面で使うアイコン。配布物は外部のリソースを読めないので、すべてインライン SVG で持つ。
 * 線の色は currentColor なので、置いた場所の文字色（テーマ）に合わせて変わる
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** ロゴ。ファビコン（public/favicon.svg）と同じ、2 つのテーブルを線でつないだ形 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <rect width="32" height="32" rx="8" className="logo-mark-bg" />
      <path d="M10 17v4.5h6" fill="none" className="logo-mark-line" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="4" y="5" width="12" height="12" rx="2" className="logo-mark-table" />
      <path d="M4 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2H4z" className="logo-mark-head" />
      <path d="M6.5 12h7M6.5 14.5h5" className="logo-mark-text" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="16" y="15" width="12" height="12" rx="2" className="logo-mark-table" />
      <path d="M16 17a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2H16z" className="logo-mark-head" />
      <path d="M18.5 22h7M18.5 24.5h5" className="logo-mark-text" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export const IconAnalyze = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

export const IconCompare = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="7.5" height="16" rx="1.5" />
    <rect x="13.5" y="4" width="7.5" height="16" rx="1.5" />
    <path d="M5.5 9h2.5M5.5 12.5h2.5M16 9h2.5M16 12.5h2.5" />
  </Icon>
);

export const IconStructure = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h7M4 12h16M4 19h11" />
    <path d="M14 5h6" opacity="0.5" />
  </Icon>
);

export const IconNarrative = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z" />
    <path d="M7.5 9h9M7.5 12h6" />
  </Icon>
);

export const IconJoin = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="7" height="6" rx="1.2" />
    <rect x="14.5" y="14.5" width="7" height="6" rx="1.2" />
    <path d="M6 9.5v4a3 3 0 0 0 3 3h5.5" />
  </Icon>
);

export const IconNested = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <rect x="8" y="8" width="10" height="10" rx="1.5" />
    <path d="M11 13h4" />
  </Icon>
);

export const IconLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const IconMonitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8.5 20h7M12 16v4" />
  </Icon>
);

export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.7 2.7L16.5 9.5" />
  </Icon>
);

/** 証明済みの印。盾にチェック */
export const IconShieldCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
    <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
  </Icon>
);

/** 比較で構文の違いが見つからないときの印。ほぼ等しい（≈）。証明済みの盾の印とは分ける */
export const IconApprox = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 2.4" />
    <path d="M7.5 10.3c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0M7.5 14.3c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Icon>
);

export const IconDiff = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Icon>
);

export const IconSpinner = (p: IconProps) => (
  <Icon {...p} className={`icon-spin${p.className ? ` ${p.className}` : ''}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </Icon>
);
