import { type HTMLAttributes } from 'react';

type AppBrandProps = {
  variant?: 'default' | 'compact';
  className?: string;
  accent?: string;
  showText?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>;

const AppBrand = ({ variant = 'default', className = '', accent, showText = true }: AppBrandProps) => {
  const isCompact = variant === 'compact';
  const iconSize = isCompact ? 26 : 34;
  const textClass = isCompact ? 'text-base' : 'text-lg';
  const accentColor = accent ?? 'var(--accent-color)';
  const textColorClass = accent ? '' : 'text-accent';
  const shellFillColor = 'var(--brand-shell-fill)';

  return (
    <div className={`flex items-center gap-2 ${textColorClass} ${className}`} style={accent ? { color: accentColor } : undefined}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={iconSize}
        height={iconSize}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <path
          d="M10 30 L90 30 L80 80 L20 80 Z"
          fill={shellFillColor}
          stroke={accentColor}
          strokeWidth={isCompact ? '2' : '2.5'}
          strokeLinejoin="miter"
        />
        <path d="M25 40 L40 55" stroke="#fff" strokeWidth="1" opacity="0.45" />
        <path
          d="M10 30 L50 68 L90 30"
          fill="none"
          stroke={accentColor}
          strokeWidth={isCompact ? '2.5' : '3'}
          strokeLinecap="square"
        />
      </svg>
      {showText ? <span className={`font-semibold tracking-wide ${textClass}`}>SimpleMail</span> : null}
    </div>
  );
};

export default AppBrand;
