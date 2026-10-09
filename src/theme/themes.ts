import { KINDS, type Kind } from '../sim/catalog';

export type ThemeId = 'terminal' | 'neon' | 'reference' | 'transit';

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: 'terminal', label: 'Terminal', description: 'Dark panes and hairlines, the same look as the backtest' },
  { id: 'neon', label: 'Neon', description: 'Dark control room, glowing particles' },
  { id: 'reference', label: 'Reference', description: 'Engineering-reference figures with explanations' },
  { id: 'transit', label: 'Transit', description: 'Systems as a subway map: stations, lines and trains' },
];

/** component colours on the transit map (classic metro-line palette) */
const TRANSIT_KIND: Record<Kind, string> = {
  client: '#6E3FA3',
  cdn: '#0098D4',
  lb: '#0A3FA8',
  gateway: '#00857C',
  server: '#00843D',
  worker: '#6C8A00',
  function: '#E8650A',
  cache: '#D9468F',
  db: '#B26B00',
  replica: '#C99700',
  storage: '#6B6A66',
  queue: '#7B2D8E',
  llm: '#C2410C',
  llmapi: '#A21CAF',
};

export function kindColor(theme: ThemeId, kind: Kind): string {
  return theme === 'transit' ? TRANSIT_KIND[kind] : KINDS[kind].color;
}
