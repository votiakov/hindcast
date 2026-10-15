import { KINDS, type Kind } from '../sim/catalog';

/** One look for every view: Terminal — dark panes, hairlines, IBM Plex, amber as the one accent. */
export type ThemeId = 'terminal';

export function kindColor(kind: Kind): string {
  return KINDS[kind].color;
}
