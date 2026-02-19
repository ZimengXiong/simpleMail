import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { X, Loader2, Filter } from 'lucide-react';

interface RuleModalProps {
  onClose: () => void;
}

const RuleModal = ({ onClose }: RuleModalProps) => {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    name: '',
    matchConditions: {
      subject: '',
      from: '',
    },
    actions: {
      markRead: false,
      moveToFolder: '',
    }
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => api.rules.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    }
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 font-sans">
      <div className="bg-bg-card w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border border-border/60">
        <div className="px-6 py-4 border-b border-border/60 flex items-center justify-between bg-black/[0.02] dark:bg-white/[0.02]">
          <h2 className="text-sm font-bold flex items-center gap-2 text-text-primary">
            <Filter className="w-4 h-4 text-accent" />
            New Automation Rule
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors"><X className="w-4 h-4 text-text-secondary" /></button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest opacity-70">Rule Name</label>
            <input 
              type="text" 
              required
              className="input text-sm h-10 px-3 bg-bg-app border-border/60 text-text-primary focus:ring-accent/30"
              placeholder="e.g. Sort Newsletters"
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
            />
          </div>

          <div className="space-y-4 pt-4 border-t border-border/60">
            <h3 className="text-[10px] font-bold text-text-primary uppercase flex items-center gap-1.5 tracking-widest">
              <span className="bg-accent/10 text-accent px-1.5 py-0.5 rounded">IF</span>
              Conditions
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest opacity-70">Subject Contains</label>
                <input 
                  type="text" 
                  className="input text-sm h-10 px-3 bg-bg-app border-border/60 text-text-primary focus:ring-accent/30"
                  placeholder="newsletter"
                  value={formData.matchConditions.subject}
                  onChange={e => setFormData({...formData, matchConditions: {...formData.matchConditions, subject: e.target.value}})}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest opacity-70">From Contains</label>
                <input 
                  type="text" 
                  className="input text-sm h-10 px-3 bg-bg-app border-border/60 text-text-primary focus:ring-accent/30"
                  placeholder="marketing@..."
                  value={formData.matchConditions.from}
                  onChange={e => setFormData({...formData, matchConditions: {...formData.matchConditions, from: e.target.value}})}
                />
              </div>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-border/60">
            <h3 className="text-[10px] font-bold text-text-primary uppercase flex items-center gap-1.5 tracking-widest">
              <span className="bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded">THEN</span>
              Actions
            </h3>
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input 
                  type="checkbox" 
                  className="w-4 h-4 rounded border-border/60 bg-bg-app accent-accent"
                  checked={formData.actions.markRead}
                  onChange={e => setFormData({...formData, actions: {...formData.actions, markRead: e.target.checked}})}
                />
                <span className="text-xs text-text-primary group-hover:text-accent transition-colors font-medium">Mark as Read</span>
              </label>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest opacity-70">Move to Folder</label>
                <input 
                  type="text" 
                  className="input text-sm h-10 px-3 bg-bg-app border-border/60 text-text-primary focus:ring-accent/30"
                  placeholder="Archive"
                  value={formData.actions.moveToFolder}
                  onChange={e => setFormData({...formData, actions: {...formData.actions, moveToFolder: e.target.value}})}
                />
              </div>
            </div>
          </div>

          <div className="pt-4 flex gap-3">
            <button 
              type="submit" 
              disabled={createMutation.isPending}
              className="flex-1 btn btn-primary py-2.5 font-bold text-xs shadow-lg shadow-accent/20 active:scale-[0.98] transition-all"
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Create Rule'}
            </button>
            <button 
              type="button" 
              onClick={onClose}
              className="flex-1 border border-border/60 bg-bg-card text-text-primary py-2.5 rounded-xl text-xs font-bold hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RuleModal;
