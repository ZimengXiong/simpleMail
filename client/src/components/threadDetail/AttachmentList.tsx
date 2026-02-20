import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { api } from '../../services/api';
import AttachmentItem from './AttachmentItem';

type Props = {
  messageId: string;
  isMobile: boolean;
};

const AttachmentList = ({ messageId, isMobile }: Props) => {
  const { data: attachments, isLoading } = useQuery({ queryKey: ['attachments', messageId], queryFn: () => api.messages.getAttachments(messageId), staleTime: 30_000 });
  if (isLoading || !attachments?.length) return null;
  return (
    <div className="px-4 pb-4 pt-2 border-t border-border/40 bg-bg-card">
      <div className="flex items-center gap-2 mb-2 text-text-secondary opacity-60 ml-1">
        <Paperclip className="w-3 h-3" />
        <span className="text-[10px] font-bold uppercase tracking-wider">{attachments.length} {attachments.length === 1 ? 'Attachment' : 'Attachments'}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {attachments.map((att) => (
          <AttachmentItem key={att.id} messageId={messageId} attachment={att} isMobile={isMobile} />
        ))}
      </div>
    </div>
  );
};

export default AttachmentList;
