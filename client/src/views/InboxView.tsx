import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { format, isToday, isThisYear } from 'date-fns';
import { RefreshCw, Search, Star, Loader2, Mail, LayoutPanelLeft } from 'lucide-react';
import { MessageRecord } from '../types/index';
import EmptyState from '../components/EmptyState';

const InboxView = () => {
  const { path } = useParams();
  const navigate = useNavigate();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const { data: connectors, isLoading: loadingConnectors } = useQuery({
    queryKey: ['connectors', 'incoming'],
    queryFn: () => api.connectors.listIncoming(),
  });

  const { data: messages, isLoading: loadingMessages, refetch, isFetching } = useQuery({
    queryKey: ['messages', path || 'INBOX'],
    queryFn: () => api.messages.list({ folder: path || 'INBOX' }),
    enabled: !!connectors?.length,
  });

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isToday(date)) return format(date, 'h:mm a');
    if (isThisYear(date)) return format(date, 'MMM d');
    return format(date, 'MM/dd/yy');
  };

  if (loadingConnectors) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
      </div>
    );
  }

  if (!connectors?.length) {
    return (
      <EmptyState
        icon={LayoutPanelLeft}
        title="Welcome to betterMail"
        description="To get started, you'll need to connect an email account. We support Gmail (via OAuth2) and any generic IMAP server."
        actionText="Add your first account"
        actionPath="/settings/connectors/new?type=incoming"
      />
    );
  }

  return (
    <>
      <div className="w-[450px] border-r border-border flex flex-col bg-white shrink-0 min-w-0">
        <div className="h-12 border-bottom border-border flex items-center px-3 gap-2 shrink-0 border-b">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              type="text"
              placeholder="Search mail..."
              className="w-full bg-sidebar border border-border rounded-md pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-accent/50"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button 
            onClick={() => refetch()}
            className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary disabled:opacity-50"
            disabled={isFetching}
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingMessages ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
            </div>
          ) : messages?.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-12 h-12 rounded-full bg-sidebar flex items-center justify-center mx-auto mb-4 border border-border/50">
                <Mail className="w-6 h-6 text-text-secondary opacity-30" />
              </div>
              <p className="text-xs font-bold text-text-secondary mb-1">Your inbox is empty</p>
              <p className="text-[11px] text-text-secondary opacity-60">Enjoy the productivity!</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {messages?.map((msg) => (
                <div
                  key={msg.id}
                  onClick={() => setSelectedThreadId(msg.threadId)}
                  className={`
                    px-3 py-2 cursor-pointer transition-colors group relative
                    ${selectedThreadId === msg.threadId ? 'bg-accent/5 border-l-2 border-l-accent' : 'hover:bg-sidebar'}
                    ${!msg.isRead ? 'font-bold' : ''}
                  `}
                >
                  <div className="flex justify-between items-baseline mb-0.5">
                    <span className="text-xs truncate max-w-[280px]">
                      {msg.fromHeader?.split('<')[0].trim() || msg.fromHeader}
                    </span>
                    <span className="text-[10px] text-text-secondary whitespace-nowrap">
                      {formatDate(msg.receivedAt)}
                    </span>
                  </div>
                  <div className="text-[13px] leading-tight truncate mb-0.5 pr-4">
                    {msg.subject || '(no subject)'}
                  </div>
                  <div className="text-xs text-text-secondary line-clamp-1 font-normal">
                    {msg.snippet}
                  </div>
                  <div className="absolute right-3 bottom-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Star className={`w-3.5 h-3.5 ${msg.isStarred ? 'fill-yellow-400 text-yellow-400 opacity-100' : 'text-text-secondary'}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {selectedThreadId ? (
          <ThreadDetail threadId={selectedThreadId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-text-secondary opacity-50">
            <Mail className="w-12 h-12 mb-2 stroke-1" />
            <p className="text-sm font-medium">Select a message to read</p>
          </div>
        )}
      </div>
    </>
  );
};

const ThreadDetail = ({ threadId }: { threadId: string }) => {
  const { data: messages, isLoading } = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.messages.getThread(threadId),
  });

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-border flex items-center px-4 gap-4 shrink-0">
        <h2 className="text-sm font-semibold truncate flex-1">
          {messages?.[0]?.subject || '(no subject)'}
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-8 bg-[#fafafa]">
        {messages?.map((msg) => (
          <div key={msg.id} className="bg-white border border-border rounded-lg shadow-sm overflow-hidden max-w-4xl mx-auto">
            <div className="px-4 py-3 border-b border-border bg-sidebar/30 flex justify-between items-center">
              <div>
                <div className="text-sm font-bold">{msg.fromHeader}</div>
                <div className="text-[11px] text-text-secondary">to {msg.toHeader}</div>
              </div>
              <div className="text-[11px] text-text-secondary">
                {msg.receivedAt && format(new Date(msg.receivedAt), 'MMM d, yyyy h:mm a')}
              </div>
            </div>
            <div className="p-6 text-sm leading-relaxed whitespace-pre-wrap font-sans selection:bg-accent/20">
              {msg.bodyHtml ? (
                <div dangerouslySetInnerHTML={{ __html: msg.bodyHtml }} className="mail-content" />
              ) : (
                msg.bodyText
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default InboxView;
