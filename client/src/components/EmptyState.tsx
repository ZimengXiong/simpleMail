import React from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';

interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionText?: string;
  actionPath?: string;
  onAction?: () => void;
}

const EmptyState = ({ icon: Icon, title, description, actionText, actionPath, onAction }: EmptyStateProps) => {
  const buttonClasses = "flex items-center gap-2 px-6 py-2 bg-accent hover:bg-accent-hover text-sm font-bold rounded-md transition-all shadow-sm";

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-12 text-center animate-in fade-in duration-500">
      <div className="w-16 h-16 rounded-full bg-sidebar flex items-center justify-center mb-6 border border-border/50">
        <Icon className="w-8 h-8 text-text-secondary opacity-50" />
      </div>
      <h3 className="text-base font-bold text-text-primary mb-2">{title}</h3>
      <p className="text-sm text-text-secondary max-w-sm leading-relaxed mb-8">
        {description}
      </p>
      {actionText && (
        <>
          {onAction ? (
            <button onClick={onAction} className={buttonClasses} style={{ color: 'var(--accent-contrast)' }}>
              <Plus className="w-4 h-4" />
              {actionText}
            </button>
          ) : actionPath ? (
            <Link to={actionPath} className={buttonClasses} style={{ color: 'var(--accent-contrast)' }}>
              <Plus className="w-4 h-4" />
              {actionText}
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
};

export default EmptyState;
