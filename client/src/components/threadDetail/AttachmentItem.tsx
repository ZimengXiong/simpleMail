import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Download, ExternalLink, Paperclip } from 'lucide-react';
import { api } from '../../services/api';
import type { AttachmentRecord } from '../../types/index';

type Props = {
  messageId: string;
  attachment: AttachmentRecord;
  isMobile: boolean;
};

const AttachmentItem = ({ messageId, attachment, isMobile }: Props) => {
  const queryClient = useQueryClient();
  const scanMutation = useMutation({ mutationFn: () => api.messages.triggerScan(messageId, attachment.id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attachments', messageId] }) });
  const downloadMutation = useMutation({ mutationFn: () => api.attachments.download(attachment.id, attachment.filename || 'attachment') });
  const contentType = String(attachment.contentType || '').toLowerCase();
  const canPreviewInline = (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
    || contentType === 'text/plain'
    || contentType === 'text/markdown'
    || contentType === 'text/csv'
    || contentType === 'application/pdf'
    || contentType.startsWith('audio/')
    || contentType.startsWith('video/');

  const handleOpenInNewTab = async () => {
    if (attachment.scanStatus === 'infected') {
      alert('Flagged as infected.');
      return;
    }
    if (!canPreviewInline) {
      alert('Preview is not supported for this file type.');
      return;
    }
    try {
      await api.attachments.preview(attachment.id, attachment.filename || 'attachment');
    } catch (error) {
      alert(`Preview failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleDownload = async () => {
    if (attachment.scanStatus === 'infected') {
      alert('Flagged as infected.');
      return;
    }
    try {
      await downloadMutation.mutateAsync();
    } catch (error) {
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="flex items-center gap-2.5 p-1.5 bg-accent/[0.02] dark:bg-white/[0.02] border border-border/60 rounded-lg group hover:bg-accent/[0.05] hover:border-accent/30 transition-all duration-200 shadow-xs hover:shadow-sm">
      <div className="w-8 h-8 rounded-md bg-bg-card flex items-center justify-center shrink-0 border border-border/40 shadow-xs group-hover:scale-105 transition-transform">
        <Paperclip className="w-3.5 h-3.5 text-text-secondary opacity-70" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold text-text-primary truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-[9px] text-text-secondary opacity-60 font-medium lowercase">
          {(attachment.size / 1024).toFixed(0)}kb
        </div>
      </div>
      <div className={`flex items-center gap-0.5 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        {['error', 'missing'].includes(attachment.scanStatus) && (
          <button onClick={() => scanMutation.mutate()} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-md" title="Retry scan">
            <RefreshCw className="w-3.5 h-3.5 text-text-secondary" />
          </button>
        )}
        {canPreviewInline && (
          <button onClick={handleOpenInNewTab} disabled={attachment.scanStatus === 'infected'} className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-text-secondary disabled:opacity-30" title="Open in new tab">
            <ExternalLink className="w-4 h-4 md:w-3.5 md:h-3.5" />
          </button>
        )}
        <button
          onClick={handleDownload}
          disabled={attachment.scanStatus === 'infected' || downloadMutation.isPending}
          className="p-1.5 hover:bg-accent/10 rounded-md text-accent disabled:opacity-30 transition-colors"
          title="Download"
        >
          {downloadMutation.isPending ? <Loader2 className="w-4 h-4 md:w-3.5 md:h-3.5 animate-spin" /> : <Download className="w-4 h-4 md:w-3.5 md:h-3.5" />}
        </button>
      </div>
    </div>
  );
};

export default AttachmentItem;
