import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { RefreshCw, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

const SyncStatus = () => {
  const [events, setEvents] = useState<any[]>([]);

  const { data: syncEvents } = useQuery({
    queryKey: ['events'],
    queryFn: () => api.events.list(),
    refetchInterval: 10000, // Poll every 10s for updates
  });

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 bg-sidebar/50 border-t border-border shrink-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
        <Clock className="w-3 h-3" />
        <span>Recent Activity:</span>
      </div>
      <div className="flex-1 flex gap-4 overflow-x-auto no-scrollbar">
        {syncEvents?.slice(0, 3).map((event: any) => (
          <div key={event.id} className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-text-secondary animate-in fade-in slide-in-from-left-2">
            {event.status === 'completed' ? (
              <CheckCircle2 className="w-3 h-3 text-green-500" />
            ) : event.status === 'failed' ? (
              <AlertCircle className="w-3 h-3 text-red-500" />
            ) : (
              <RefreshCw className="w-3 h-3 text-accent animate-spin" />
            )}
            <span className="font-bold">{event.connectorName}</span>
            <span className="opacity-70">{event.mailbox}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SyncStatus;
