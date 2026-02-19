import { useState, useEffect } from 'react';

export type LayoutMode = 'columns' | 'list';

export const useLayoutMode = () => {
  const [mode, setMode] = useState<LayoutMode>(() => 
    (localStorage.getItem('layoutMode') as LayoutMode) || 'columns'
  );

  useEffect(() => {
    const handleStorage = () => {
      const currentMode = (localStorage.getItem('layoutMode') as LayoutMode) || 'columns';
      setMode(currentMode);
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return mode;
};
