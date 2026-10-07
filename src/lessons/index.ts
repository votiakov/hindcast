import type { Lesson } from './types';
import { lesson1 } from './lesson1';
import { retryStorm } from './retryStorm';
import { aiServing } from './aiServing';
import { runtimes } from './runtimes';

/** all lessons, in the order the picker shows them */
export const LESSONS: Lesson[] = [lesson1, retryStorm, aiServing, runtimes];
export const lessonById = (id: string) => LESSONS.find((l) => l.id === id) ?? LESSONS[0];
