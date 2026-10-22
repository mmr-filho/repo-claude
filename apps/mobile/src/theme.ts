import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  danger: string;
  warn: string;
  border: string;
  bubbleOut: string;
  bubbleIn: string;
  overlay: string;
}

const light: Palette = {
  bg: '#F3F5F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEFED',
  text: '#10201A',
  muted: '#5F6F68',
  primary: '#0B6E4F',
  onPrimary: '#FFFFFF',
  danger: '#B42318',
  warn: '#B54708',
  border: '#DDE4E1',
  bubbleOut: '#D3F0E1',
  bubbleIn: '#FFFFFF',
  overlay: 'rgba(8,16,12,0.5)',
};

const dark: Palette = {
  bg: '#0C1210',
  surface: '#141C19',
  surfaceAlt: '#1C2622',
  text: '#E8F0EC',
  muted: '#93A39B',
  primary: '#3DC592',
  onPrimary: '#06241A',
  danger: '#F97066',
  warn: '#F5A524',
  border: '#26322D',
  bubbleOut: '#1B4A38',
  bubbleIn: '#1C2622',
  overlay: 'rgba(0,0,0,0.6)',
};

export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
