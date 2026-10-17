import type { LessonStep } from './types';

/**
 * A level's hint comes in two stages. Once the learner has been failing for a while, a question
 * sends them to the evidence (a trace, a red card); the answer and "show me" wait until they ask
 * for it ("I'm stuck"). There is no timer: an answer that arrives on its own is passed without
 * looking, which is what the question is there to prevent.
 */
export type HintStage = 'none' | 'ask' | 'answer';

/** what the level's state shows of the hint */
export function hintStage(
  step: Pick<LessonStep, 'ask' | 'hint' | 'hintAfter'>,
  ls: { failT: number; missed: boolean; passed: boolean; answered: boolean },
): HintStage {
  if (!step.hint || ls.passed) return 'none';
  const struggling = ls.failT >= (step.hintAfter ?? 8) || ls.missed;
  if (!struggling) return 'none';
  // a level without a question shows its answer as before
  return ls.answered || !step.ask ? 'answer' : 'ask';
}
