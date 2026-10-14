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

/** all lessons, in the order the picker shows them */
export const LESSONS: Lesson[] = [lesson1, scale201, pastebin, mint, sizeCache, queues, retryStorm, elastic, zones, aiServing, runtimes];
export const lessonById = (id: string) => LESSONS.find((l) => l.id === id) ?? LESSONS[0];
