import { UserCircle, type LucideIcon } from 'lucide-react';

interface AvatarProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  text?: string;
  fallbackIcon?: LucideIcon;
  visualConfig?: {
    icon?: string;
    emoji?: string;
    color?: string;
  };
}

const getInitials = (text: string) => {
  const parts = text.trim().split(/[\s_-]+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const Avatar = ({ size = 'md', className = '', text, fallbackIcon: FallbackIcon = UserCircle, visualConfig }: AvatarProps) => {
  const sizeClasses = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-7 h-7 text-xs',
    lg: 'w-8 h-8 text-sm',
  };

  const iconSize = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-4.5 h-4.5',
  };

  const containerClasses = `rounded-sm flex items-center justify-center shrink-0 border border-border/50 font-semibold uppercase ${sizeClasses[size]} ${className}`;

  const style = visualConfig?.color ? { backgroundColor: visualConfig.color, color: '#fff', borderColor: 'transparent' } : {};
  const defaultBg = !visualConfig?.color ? 'bg-black/[0.05] dark:bg-white/10 text-text-secondary' : '';

  if (visualConfig?.emoji) {
    return (
      <div className={`${containerClasses} ${defaultBg}`} style={style}>
        {visualConfig.emoji}
      </div>
    );
  }

  if (text) {
    return (
      <div className={`${containerClasses} ${defaultBg}`} style={style} title={text}>
        {getInitials(text)}
      </div>
    );
  }

  return (
    <div className={`${containerClasses} ${defaultBg}`} style={style}>
      <FallbackIcon className={`${iconSize[size]} opacity-60`} />
    </div>
  );
};

export default Avatar;
