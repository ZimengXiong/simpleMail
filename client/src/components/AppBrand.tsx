import { type HTMLAttributes } from 'react';

type AppBrandProps = {
  variant?: 'default' | 'compact';
  className?: string;
  accent?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>;

const AppBrand = ({ variant = 'default', className = '', accent }: AppBrandProps) => {
  const isCompact = variant === 'compact';
  const iconSize = isCompact ? 26 : 34;
  const textClass = isCompact ? 'text-base' : 'text-lg';
  const accentColor = accent ?? 'var(--accent-color)';
  const textColorClass = accent ? '' : 'text-accent';

  return (
    <div className={`flex items-center gap-2 ${textColorClass} ${className}`} style={accent ? { color: accentColor } : undefined}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={iconSize}
        height={iconSize}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="metal-gloss" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#333" stopOpacity="1" />
            <stop offset="50%" stopColor="#111" stopOpacity="1" />
            <stop offset="100%" stopColor="#000" stopOpacity="1" />
          </linearGradient>
        </defs>
        <path d="M12 32 L92 32 L82 82 L22 82 Z" fill="#000" opacity="0.5" />
        <path
          d="M10 30 L90 30 L80 80 L20 80 Z"
          fill="url(#metal-gloss)"
          stroke={accentColor}
          strokeWidth={isCompact ? '2' : '2.5'}
          strokeLinejoin="miter"
        />
        <path d="M25 40 L40 55" stroke="#fff" strokeWidth="1" opacity="0.6" />
        <path
          d="M10 30 L50 68 L90 30"
          fill="none"
          stroke={accentColor}
          strokeWidth={isCompact ? '2.5' : '3'}
          strokeLinecap="square"
        />
      </svg>
      <span className={`font-semibold tracking-wide ${textClass}`}>SimpleMail</span>
    </div>
  );
};

export default AppBrand;
