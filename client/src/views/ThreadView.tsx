import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { format } from 'date-fns';
import { ChevronLeft, Loader2, Star, MoreVertical, Reply, CornerUpLeft } from 'lucide-react';

const ThreadView = () => {
  const { threadId } = useParams();
  const navigate = useNavigate();

  const { data: messages, isLoading } = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.messages.getThread(threadId!),
    enabled: !!threadId,
  });

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-white overflow-hidden">
      <div className="h-12 border-b border-border flex items-center px-4 gap-4 shrink-0">
        <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h2 className="text-sm font-semibold truncate flex-1">
          {messages?.[0]?.subject || '(no subject)'}
        </h2>
        <div className="flex items-center gap-1">
          <button className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary">
            <Star className="w-4 h-4" />
          </button>
          <button className="p-1.5 hover:bg-black/5 rounded-md text-text-secondary">
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#fbfbfa] p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-text-primary tracking-tight">
              {messages?.[0]?.subject || '(no subject)'}
            </h1>
          </div>

          {messages?.map((msg) => (
            <div key={msg.id} className="bg-white border border-border rounded-lg shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-sidebar/30 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-xs">
                    {msg.fromHeader?.charAt(0) || '?'}
                  </div>
                  <div>
                    <div className="text-sm font-bold">{msg.fromHeader}</div>
                    <div className="text-[11px] text-text-secondary">to {msg.toHeader}</div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-[11px] text-text-secondary">
                    {msg.receivedAt && format(new Date(msg.receivedAt), 'MMM d, yyyy h:mm a')}
                  </div>
                  <button className="p-1 hover:bg-black/5 rounded text-text-secondary">
                    <Reply className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="p-6 text-sm leading-relaxed whitespace-pre-wrap font-sans">
                {msg.bodyHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: msg.bodyHtml }} className="mail-content" />
                ) : (
                  msg.bodyText
                )}
              </div>
            </div>
          ))}

          <div className="pt-8 flex justify-center">
            <button className="flex items-center gap-2 px-6 py-2 border border-border rounded-full text-sm font-bold text-text-secondary hover:bg-sidebar hover:text-text-primary transition-all">
              <CornerUpLeft className="w-4 h-4" />
              Reply to conversation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ThreadView;
