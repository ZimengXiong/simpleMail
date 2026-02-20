import { format } from 'date-fns';
import type { MessageRecord } from '../../types/index';

const SendOnlyMessageDetail = ({ message }: { message: MessageRecord }) => {
  const statusLabel = String(message.sendStatus ?? 'queued').toUpperCase();
  const warning = 'Responses will not be shown because this is a SEND ONLY profile and no IMAP inbox is configured.';
  const showNoResponseWarning = message.sendOnlyNoResponses !== false;

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-5 md:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        {showNoResponseWarning && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50/70 text-amber-900 px-3 py-2 text-xs font-medium">
            {warning}
          </div>
        )}

        <div className="rounded-md border border-border bg-bg-card p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text-primary">{message.subject || '(no subject)'}</h2>
            <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded bg-black/5 dark:bg-white/10 text-text-secondary">
              {statusLabel}
            </span>
          </div>
          <div className="text-xs text-text-secondary space-y-1">
            <div><span className="font-semibold">From:</span> {message.fromHeader || 'Unknown'}</div>
            <div><span className="font-semibold">To:</span> {message.toHeader || 'Unknown recipient'}</div>
            <div><span className="font-semibold">Folder:</span> {message.folderPath}</div>
            <div><span className="font-semibold">Time:</span> {message.receivedAt ? format(message.receivedAt, 'PPP p') : 'Unknown'}</div>
          </div>
          {message.sendError && (
            <div className="rounded border border-red-300/60 bg-red-50/60 text-red-700 px-3 py-2 text-xs">
              <span className="font-semibold">Send error:</span> {message.sendError}
            </div>
          )}
          <div className="border-t border-border pt-3">
            <div className="text-sm text-text-primary whitespace-pre-wrap">{message.bodyText || message.snippet || '(no body)'}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SendOnlyMessageDetail;
