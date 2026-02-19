import { useState, useEffect } from 'react';

export type Theme = 'light' | 'dark';

// Color utilities for accessibility
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
  // Simple linear interpolation towards white (positive percent) or black (negative percent)
  const target = percent > 0 ? 255 : 0;
  const p = Math.abs(percent);
  
  const newR = r + (target - r) * p;
  const newG = g + (target - g) * p;
  const newB = b + (target - b) * p;
  
  return rgbToHex(newR, newG, newB);
};

export const useTheme = () => {
  const [theme, setTheme] = useState<Theme>(() => 
    (localStorage.getItem('theme') as Theme) || 'light'
  );
  const [accentColor, setAccentColor] = useState<string>(() => 
    localStorage.getItem('accentColor') || '#2B1D3A'
  );

  useEffect(() => {
    // Apply theme attribute to html element
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    // Determine background color based on theme
    // Matching CSS variables: light=#ffffff, dark=#191919
    const bg = theme === 'light' ? '#ffffff' : '#191919';
    
    let adjustedAccent = accentColor;
    let contrast = getContrast(adjustedAccent, bg);
    
    // Enforce AA contrast (4.5:1)
    let iterations = 0;
    while (contrast < 4.5 && iterations < 20) {
      // Lighten for dark mode, darken for light mode
      const direction = theme === 'dark' ? 0.1 : -0.1;
      adjustedAccent = adjustLightness(adjustedAccent, direction);
      contrast = getContrast(adjustedAccent, bg);
      iterations++;
    }

    // Apply adjusted accent color to root
    document.documentElement.style.setProperty('--accent-color', adjustedAccent);
    
    // Derive a hover color (slightly darker/more opaque version of adjusted)
    // For simplicity, we just darken/lighten slightly in the opposite direction of the background
    const hoverColor = adjustLightness(adjustedAccent, theme === 'light' ? -0.1 : 0.1);
    document.documentElement.style.setProperty('--accent-hover', hoverColor);
    
    // Calculate contrast color (black or white) for text on accent background
    const getContrastColor = (hexcolor: string) => {
      // Remove # if present
      const hex = hexcolor.replace('#', '');
      const r = parseInt(hex.substr(0, 2), 16);
      const g = parseInt(hex.substr(2, 2), 16);
      const b = parseInt(hex.substr(4, 2), 16);
      const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
      return (yiq >= 128) ? '#000000' : '#ffffff';
    };
    
    document.documentElement.style.setProperty('--accent-contrast', getContrastColor(adjustedAccent));
    
    localStorage.setItem('accentColor', accentColor);
  }, [accentColor, theme]);

  return { theme, setTheme, accentColor, setAccentColor };
};
