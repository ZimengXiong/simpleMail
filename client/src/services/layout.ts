import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { readStorageString } from './storage';

export type LayoutMode = 'columns' | 'list';

const readLayoutMode = (): LayoutMode => {
  return readStorageString('layoutMode') === 'columns' ? 'columns' : 'list';
};

export const useLayoutMode = () => {
  const [mode, setMode] = useState<LayoutMode>(() => 
    readLayoutMode()
  );

  useEffect(() => {
    const handleStorage = () => {
      setMode(readLayoutMode());
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return mode;
};

export const useMediaQuery = (query: string) => {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', onStoreChange);
    return () => media.removeEventListener('change', onStoreChange);
  }, [query]);
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};
