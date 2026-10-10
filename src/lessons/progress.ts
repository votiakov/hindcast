/**
 * Lesson progress, kept in this browser: the best stars per lesson and the furthest level reached.
 * Storage can be unavailable (private windows, blocked site data): everything degrades to "no
 * progress yet".
 */

export interface LessonProgress {
  /** furthest level passed (0-based index), -1 if none */
  reached: number;
  /** best stars when the lesson was finished, 0 if never */
  stars: number;
  /** levels passed with "show me" on the latest run */
  shown?: number;
}

const KEY = 'bottleneck.lessons.v1';

function read(): Record<string, LessonProgress> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, LessonProgress>) : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, LessonProgress>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* not saved: progress just won't survive a reload */
  }
}

export const progressOf = (id: string): LessonProgress => read()[id] ?? { reached: -1, stars: 0 };

export function recordLevel(id: string, index: number) {
  const all = read();
  const p = all[id] ?? { reached: -1, stars: 0 };
  all[id] = { ...p, reached: Math.max(p.reached, index) };
  write(all);
}

export function recordFinish(id: string, stars: number, shown: number) {
  const all = read();
  const p = all[id] ?? { reached: -1, stars: 0 };
  all[id] = { ...p, stars: Math.max(p.stars, stars), shown };
  write(all);
}
