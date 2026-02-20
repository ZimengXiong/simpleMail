import { useState, useEffect } from 'react';
import { readStorageString, writeStorageString } from './storage';

export type Theme = 'light' | 'dark';

const safeStorageGet = (key: string): string | null => {
  return readStorageString(key);
};

const safeStorageSet = (key: string, value: string): void => {
  writeStorageString(key, value);
};

const hexToRgb = (hex: string) => {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return { r, g, b };
};

const rgbToHex = (r: number, g: number, b: number) => {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(Math.max(0, Math.min(255, x))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
};

const getLuminance = (r: number, g: number, b: number) => {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
};

const getContrast = (hex1: string, hex2: string) => {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const l1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const adjustLightness = (hex: string, percent: number) => {
  const { r, g, b } = hexToRgb(hex);
  const target = percent > 0 ? 255 : 0;
  const p = Math.abs(percent);
  
  const newR = r + (target - r) * p;
  const newG = g + (target - g) * p;
  const newB = b + (target - b) * p;
  
  return rgbToHex(newR, newG, newB);
};

export const useTheme = () => {
  const [theme, setTheme] = useState<Theme>(() => 
    safeStorageGet('theme') === 'dark' ? 'dark' : 'light'
  );
  const [accentColor, setAccentColor] = useState<string>(() => 
    safeStorageGet('accentColor') || '#10b981'
  );

  const setThemeFavicon = (accent: string) => {
    if (typeof document === 'undefined') {
      return;
    }

    const svg = `<svg width="200" height="200" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="metal-gloss" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#333" stop-opacity="1" />
      <stop offset="50%" stop-color="#111" stop-opacity="1" />
      <stop offset="100%" stop-color="#000" stop-opacity="1" />
    </linearGradient>
  </defs>
  <path d="M12 32 L92 32 L82 82 L22 82 Z" fill="#000" opacity="0.5" />
  <path d="M10 30 L90 30 L80 80 L20 80 Z" fill="url(#metal-gloss)" stroke="${accent}" stroke-width="2.5" stroke-linejoin="miter" />
  <path d="M10 30 L50 68 L90 30" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="square" />
  <line x1="25" y1="40" x2="40" y2="55" stroke="#fff" stroke-width="1" opacity="0.6" />
</svg>`;
    const faviconHref = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");

    if (existing) {
      existing.href = faviconHref;
      return;
    }

    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = faviconHref;
    document.head.appendChild(link);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    safeStorageSet('theme', theme);
  }, [theme]);

  useEffect(() => {
    const bg = theme === 'light' ? '#ffffff' : '#191919';
    
    let adjustedAccent = accentColor;
    let contrast = getContrast(adjustedAccent, bg);
    
    const targetContrast = theme === 'dark' ? 7.0 : 4.5;
    
    let iterations = 0;
    while (contrast < targetContrast && iterations < 20) {
      const direction = theme === 'dark' ? 0.15 : -0.1;
      adjustedAccent = adjustLightness(adjustedAccent, direction);
      contrast = getContrast(adjustedAccent, bg);
      iterations++;
    }

    document.documentElement.style.setProperty('--accent-color', adjustedAccent);
    const hoverColor = adjustLightness(adjustedAccent, theme === 'light' ? -0.1 : 0.15);
    document.documentElement.style.setProperty('--accent-hover', hoverColor);
    const getContrastColor = (hexcolor: string) => {
      const hex = hexcolor.replace('#', '');
      const r = parseInt(hex.substr(0, 2), 16);
      const g = parseInt(hex.substr(2, 2), 16);
      const b = parseInt(hex.substr(4, 2), 16);
      const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
      return (yiq >= 128) ? '#000000' : '#ffffff';
    };
    
    document.documentElement.style.setProperty('--accent-contrast', getContrastColor(adjustedAccent));
    setThemeFavicon(adjustedAccent);
    
    safeStorageSet('accentColor', accentColor);
  }, [accentColor, theme]);

  return { theme, setTheme, accentColor, setAccentColor };
};
