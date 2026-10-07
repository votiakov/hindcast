import type { Lesson } from './types';
import { lesson1 } from './lesson1';
import { retryStorm } from './retryStorm';
import { aiServing } from './aiServing';
import { runtimes } from './runtimes';
import { elastic } from './elastic';

/** all lessons, in the order the picker shows them */
export const LESSONS: Lesson[] = [lesson1, retryStorm, elastic, aiServing, runtimes];
export const lessonById = (id: string) => LESSONS.find((l) => l.id === id) ?? LESSONS[0];
