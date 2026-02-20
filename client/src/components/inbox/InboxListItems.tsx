import { memo } from 'react';
import { MailOpen, CheckSquare, Mail as MailIcon, Square, Star, Trash2 } from 'lucide-react';
import type { MessageRecord } from '../../types/index';

export type ListItemProps = {
  msg: MessageRecord;
  selectedThreadId: string | null;
  isSelected: boolean;
  onSelect: (threadId: string) => void;
  onPrefetchThread: (threadId: string) => void;
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onUpdateMessage: (id: string, data: { isRead?: boolean; isStarred?: boolean; delete?: boolean; moveToFolder?: string }) => void;
  participants: string;
  formattedDate: string;
  disableActions?: boolean;
  isMobile?: boolean;
};

export const InboxColumnItem = memo(({
  msg,
  selectedThreadId,
  isSelected,
  onSelect,
  onPrefetchThread,
  onToggleSelect,
  participants,
  formattedDate,
  disableActions,
}: ListItemProps) => {
  const threadId = msg.threadId || msg.id;
  const subjectText = (msg.subject || '(no subject)').trim();
  const snippetText = String(msg.snippet || '').trim();

  return (
    <div
      onClick={() => onSelect(threadId)}
      onMouseEnter={() => onPrefetchThread(threadId)}
      className={`
        px-3 py-2.5 cursor-pointer transition-all group relative border-l-2 flex gap-2
        ${selectedThreadId === threadId ? 'bg-accent/10 border-l-accent' : 'border-l-transparent'}
        ${!msg.isRead ? 'bg-white dark:bg-white/[0.08]' : 'bg-black/[0.03] dark:bg-transparent'}
        ${isSelected ? 'bg-accent/[0.15] dark:bg-accent/[0.25]' : ''}
        hover:z-10 hover:shadow-sm hover:border-y hover:border-border/15
      `}
    >
      {!disableActions && (
        <div className="pt-0.5 shrink-0 z-10" onClick={(e) => onToggleSelect(msg.id, e)}>
          <button className={`p-0.5 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${isSelected ? 'text-accent' : 'text-text-secondary opacity-40 group-hover:opacity-100'}`}>
            {isSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline mb-1">
          <div className="flex items-center gap-1.5 truncate flex-1">
            <div className="flex items-center gap-1 min-w-0">
              <span className={`truncate text-xs ${!msg.isRead ? 'font-bold text-text-primary' : 'font-medium text-text-primary/80'}`}>{participants}</span>
              {msg.threadCount && msg.threadCount > 1 && (
                <span className="text-[11px] text-text-secondary/50 font-bold">({msg.threadCount})</span>
              )}
            </div>
          </div>
          <span className={`text-[10px] whitespace-nowrap font-bold ml-2 ${!msg.isRead ? 'text-accent' : 'text-text-secondary/50'}`}>{formattedDate}</span>
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0 overflow-hidden">
          <span className={`text-[13px] leading-snug truncate shrink-0 max-w-[85%] ${!msg.isRead ? 'font-bold text-text-primary' : 'text-text-primary/80 font-medium'}`}>
            {subjectText}
          </span>
          {snippetText && (
            <span className={`text-xs font-normal truncate flex-1 min-w-0 ${!msg.isRead ? 'text-text-secondary/70' : 'text-text-secondary/50'}`}>
              — {snippetText}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

InboxColumnItem.displayName = 'InboxColumnItem';

export const InboxListItem = memo(({
  msg,
  isSelected,
  onSelect,
  onPrefetchThread,
  onToggleSelect,
  onUpdateMessage,
  participants,
  formattedDate,
  disableActions,
  isMobile,
}: ListItemProps) => {
  const threadId = msg.threadId || msg.id;
  const subjectText = (msg.subject || '(no subject)').trim();
  const snippetText = String(msg.snippet || '').trim();

  return (
    <div
      onClick={() => onSelect(threadId)}
      onMouseEnter={() => onPrefetchThread(threadId)}
      className={`
        flex items-center px-4 h-12 md:h-11 cursor-pointer border-b border-border/40 transition-all group relative
        ${!msg.isRead ? 'bg-white dark:bg-white/[0.08]' : 'bg-black/[0.03] dark:bg-transparent'}
        ${isSelected ? 'bg-accent/[0.15] dark:bg-accent/[0.25]' : ''}
        hover:z-10 hover:shadow-sm hover:border-y hover:border-border/15
      `}
    >
      {!disableActions && (
        <div className="shrink-0 mr-3 z-10" onClick={(e) => onToggleSelect(msg.id, e)}>
          <button className={`p-1.5 md:p-1 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${isSelected ? 'text-accent' : 'text-text-secondary opacity-40 group-hover:opacity-100'}`}>
            {isSelected ? <CheckSquare className="w-5 h-5 md:w-4 md:h-4" /> : <Square className="w-5 h-5 md:w-4 md:h-4" />}
          </button>
        </div>
      )}
      <div className={`flex items-center gap-3 shrink-0 mr-4 ${isMobile ? 'flex-1 min-w-0' : 'w-48'}`}>
        {!disableActions && !isMobile && (
          <button
            className="p-1 rounded transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { isStarred: !msg.isStarred }); }}
            title={msg.isStarred ? 'Unstar' : 'Star'}
          >
            <Star className={`w-3.5 h-3.5 ${msg.isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-text-secondary opacity-40 group-hover:opacity-100'}`} />
          </button>
        )}
        <div className={`flex-1 min-w-0 ${!msg.isRead ? 'font-bold' : 'font-medium'}`}>
          <div className="flex items-center gap-1 min-w-0">
            <span className={`truncate ${!msg.isRead ? 'text-text-primary' : 'text-text-primary/80'}`}>{participants}</span>
            {msg.threadCount && msg.threadCount > 1 && (
              <span className="text-[11px] text-text-secondary/50 font-bold">({msg.threadCount})</span>
            )}
          </div>
          {isMobile && (
            <div className="flex items-center gap-2">
              <span className={`text-xs truncate max-w-[80%] ${!msg.isRead ? 'text-text-primary font-semibold' : 'text-text-secondary'}`}>{subjectText}</span>
            </div>
          )}
        </div>
      </div>
      {!isMobile && (
        <div className="min-w-0 flex-1 flex items-baseline gap-2 pr-4">
          <span className={`text-sm truncate shrink-0 max-w-[45%] ${!msg.isRead ? 'font-bold text-text-primary' : 'text-text-primary/80 font-medium'}`}>{subjectText}</span>
          {snippetText && (
            <span className={`text-sm font-normal truncate min-w-0 flex-1 ${!msg.isRead ? 'text-text-secondary/70' : 'text-text-secondary/50'}`}>— {snippetText}</span>
          )}
        </div>
      )}
      <div className={`text-xs font-bold whitespace-nowrap shrink-0 group-hover:hidden ml-3 min-w-[3.25rem] text-right ${!msg.isRead ? 'text-accent' : 'text-text-secondary/50'}`}>{formattedDate}</div>
      {!disableActions && !isMobile && (
        <div className="hidden group-hover:flex items-center gap-1 shrink-0">
          <button
            className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-md text-text-secondary transition-colors"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { isRead: !msg.isRead }); }}
            title={msg.isRead ? 'Mark as Unread' : 'Mark as Read'}
          >
            {msg.isRead ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
          </button>
          <button
            className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md text-red-500 transition-colors"
            onClick={(e) => { e.stopPropagation(); onUpdateMessage(msg.id, { delete: true }); }}
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
});

InboxListItem.displayName = 'InboxListItem';
