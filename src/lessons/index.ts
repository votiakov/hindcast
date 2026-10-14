import type { Lesson } from './types';
import { lesson1 } from './lesson1';
import { retryStorm } from './retryStorm';
import { aiServing } from './aiServing';
import { runtimes } from './runtimes';
import { elastic } from './elastic';
import { queues } from './queues';
import { zones } from './zones';
import { pastebin } from './pastebin';
import { mint } from './mint';
import { scale201 } from './scale201';
import { sizeCache } from './sizeCache';
import { cap } from './cap';
import { sharding } from './sharding';
import { crawler } from './crawler';

/** the study path: tracks in order, each building on the one before */
export const TRACKS: { id: string; label: string; lessons: Lesson[] }[] = [
  { id: 'foundations', label: 'Foundations: scale a web service', lessons: [lesson1, scale201, pastebin, mint, sizeCache] },
  { id: 'resilience', label: 'Asynchrony and failure', lessons: [queues, retryStorm, elastic, zones] },
  { id: 'data', label: 'Data at scale', lessons: [cap, sharding, crawler] },
  { id: 'ai', label: 'AI and runtimes', lessons: [aiServing, runtimes] },
];

/** all lessons, in study-path order */
export const LESSONS: Lesson[] = TRACKS.flatMap((t) => t.lessons);
export const lessonById = (id: string) => LESSONS.find((l) => l.id === id) ?? LESSONS[0];
