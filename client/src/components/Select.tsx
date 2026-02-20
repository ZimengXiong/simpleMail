import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

interface Option {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

interface SelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  variant?: 'default' | 'minimal';
}

const Select = ({ 
  options, 
  value, 
  onChange, 
  placeholder = 'Select...', 
  label, 
  className = '',
  variant = 'default'
}: SelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find(o => o.value === value);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const triggerClasses = variant === 'minimal' 
    ? "w-full h-8 px-0 bg-transparent text-sm text-text-primary flex items-center justify-between transition-colors focus:outline-none"
    : "w-full h-9 px-3 bg-black/[0.02] dark:bg-white/[0.02] border border-border rounded-md text-sm text-text-primary flex items-center justify-between hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent";

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      {label && <label className="label">{label}</label>}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={triggerClasses}
      >
        <div className="flex items-center gap-3 truncate">
          {selectedOption?.icon}
          <div className="flex items-baseline gap-3 truncate">
            <span className="truncate font-semibold">{selectedOption ? selectedOption.label : placeholder}</span>
            {variant === 'minimal' && selectedOption?.description && (
              <span className="text-xs text-text-secondary opacity-60 truncate font-normal">
                &lt;{selectedOption.description}&gt;
              </span>
            )}
          </div>
        </div>
        <ChevronDown className="w-4 h-4 text-text-secondary opacity-60 shrink-0 transition-transform duration-200" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-bg-card border border-border shadow-lg rounded-md z-[100] overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="p-1 space-y-0.5 max-h-60 overflow-y-auto custom-scrollbar">
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-sm transition-colors ${value === option.value ? 'bg-black/5 dark:bg-white/10 text-text-primary font-bold' : 'hover:bg-black/5 dark:hover:bg-white/10 text-text-secondary font-semibold'}`}
              >
                <div className="shrink-0 w-4 flex justify-center">{option.icon}</div>
                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate">{option.label}</div>
                  {option.description && <div className="text-[10px] opacity-60 truncate font-normal">{option.description}</div>}
                </div>
                {value === option.value && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Select;
