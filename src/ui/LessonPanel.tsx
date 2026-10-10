import { useEffect, useRef } from 'react';
import { CheckCircle2, ChevronRight, Eye, Lightbulb, RotateCcw, Star, Target } from 'lucide-react';
import { useSim } from '../sim/store';
import { LESSONS } from '../lessons';
import { finalRps, goalStart } from '../lessons/types';
import { progressOf, recordFinish, recordLevel } from '../lessons/progress';

function LessonPicker() {
  const id = useSim((s) => s.lesson.lesson.id);
  const pick = useSim((s) => s.pickLesson);
  // re-read on every render: finishing a lesson updates its stars
  return (
    <select className="lesson-picker" value={id} onChange={(e) => pick(e.target.value)} title="Choose a lesson">
      {LESSONS.map((l, i) => {
        const p = progressOf(l.id);
        const mark = p.stars ? ` ${'★'.repeat(p.stars)}${'☆'.repeat(3 - p.stars)}` : p.reached >= 0 ? ` · ${p.reached + 1}/${l.steps.length}` : '';
        return (
          <option key={l.id} value={l.id}>
            {i + 1}. {l.title}
            {mark}
          </option>
        );
      })}
    </select>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

export function LessonPanel() {
  const ls = useSim((s) => s.lesson);
  const running = useSim((s) => s.running);
  const global = useSim((s) => s.boards.main.global);
  const showCost = useSim((s) => s.settings.cost);
  const { nextStep, reset, showSolution, pickLesson } = useSim.getState();
  const { lesson, stepIndex } = ls;
  const shownCount = useRef(0);

  // what the system held when the level was passed, for the debrief
  const held = useRef<{ errorRate: number; p99: number; cost: number } | null>(null);
  useEffect(() => {
    if (ls.passed) {
      held.current = { errorRate: global.errorRate, p99: global.p99, cost: global.cost };
      recordLevel(lesson.id, stepIndex);
      if (ls.shown) shownCount.current += 1;
    } else held.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ls.passed]);
  useEffect(() => {
    shownCount.current = 0;
  }, [lesson.id]);

  const stars = !showCost ? 3 : global.cost <= lesson.stars.three ? 3 : global.cost <= lesson.stars.two ? 2 : 1;
  useEffect(() => {
    if (ls.finished) recordFinish(lesson.id, stars, shownCount.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ls.finished]);

  if (ls.finished) {
    const next = LESSONS[(LESSONS.findIndex((l) => l.id === lesson.id) + 1) % LESSONS.length];
    return (
      <div className="lesson panel">
        <div className="lesson-done">
          <div className="stars">
            {[1, 2, 3].map((i) => (
              <Star key={i} size={34} className={i <= stars ? 'star on' : 'star'} />
            ))}
          </div>
          <h2>Lesson complete</h2>
          <p>
            {lesson.outro ?? `You handled ${finalRps(lesson).toLocaleString()} req/s`} Final cost: <b>${global.cost.toFixed(2)}/h</b>.
          </p>
          <p className="muted">
            3★ at ≤ ${lesson.stars.three.toFixed(2)}/h · 2★ at ≤ ${lesson.stars.two.toFixed(2)}/h
            {shownCount.current > 0 ? ` · ${shownCount.current} level${shownCount.current > 1 ? 's' : ''} solved with "show me"` : ''}
          </p>
        </div>
        <ol className="lesson-recap">
          {lesson.steps.map((s) => (
            <li key={s.id}>
              <b>{s.title}</b>
              <span>{s.takeaway}</span>
            </li>
          ))}
        </ol>
        <div className="lesson-done-actions">
          <button className="btn primary" onClick={() => pickLesson(next.id)}>
            Next: {next.title} <ChevronRight size={14} />
          </button>
          <button className="btn" onClick={() => pickLesson(lesson.id)}>
            <RotateCcw size={14} /> Play again
          </button>
        </div>
      </div>
    );
  }

  const step = lesson.steps[stepIndex];
  const holdPct = step.goal ? Math.min(1, ls.holdT / step.goal.holdSeconds) : 0;
  const ramping = ls.stepT < goalStart(step);
  const struggling = ls.failT >= (step.hintAfter ?? 8) || ls.missed;
  const showHint = step.hint && struggling;
  const status = ls.passed
    ? 'Passed'
    : ls.missed
      ? 'The window closed'
      : !running && ls.stepT === 0
        ? 'Press ▶ Play to start'
        : ramping
          ? 'Traffic ramping up…'
          : holdPct > 0
            ? 'Holding SLO…'
            : 'SLO violated — fix the system';

  return (
    <div className="lesson panel">
      <LessonPicker />
      <div className="lesson-head">
        <div className="lesson-title">{lesson.subtitle}</div>
        <div className="lesson-steps">
          {lesson.steps.map((s, i) => (
            <span key={s.id} className={`step-dot ${i < stepIndex ? 'done' : i === stepIndex ? 'cur' : ''}`} title={s.title} />
          ))}
        </div>
      </div>

      <div className="step-label">
        Level {stepIndex + 1} / {lesson.steps.length}
      </div>
      <h3 className="step-title">{step.title}</h3>
      <p className="step-story">{step.story}</p>

      <div className="objective">
        <Target size={14} />
        <span>{step.objective}</span>
      </div>

      {step.goal && (
        <div className="hold">
          <div className="hold-label">
            <span>{status}</span>
            <span>
              {Math.min(ls.holdT, step.goal.holdSeconds).toFixed(1)}s / {step.goal.holdSeconds}s
            </span>
          </div>
          <div className="hold-bar">
            <div className={`hold-fill ${ls.passed ? 'passed' : ''}`} style={{ width: `${holdPct * 100}%` }} />
          </div>
        </div>
      )}

      {ls.missed && (
        <div className="hint missed">
          <RotateCcw size={14} />
          <span>
            The system had to hold from {step.goal?.startAfter ?? goalStart(step)} s to {step.goal?.deadline} s, through what happened in between. Change the design, then replay the level: your design stays on the board.
          </span>
        </div>
      )}

      {showHint && !ls.passed && (
        <div className="hint">
          <Lightbulb size={14} />
          <span>{step.hint}</span>
        </div>
      )}

      {ls.passed && step.takeaway && (
        <div className="debrief">
          <div className="debrief-title">Why it worked</div>
          <p>{step.takeaway}</p>
          {held.current && (
            <p className="debrief-numbers">
              held: {pct(held.current.errorRate)} errors · p99 {Math.round(held.current.p99)} ms{showCost ? ` · $${held.current.cost.toFixed(2)}/h` : ''}
              {ls.shown ? ' · with "show me"' : ''}
            </p>
          )}
        </div>
      )}

      <div className="lesson-actions">
        {ls.passed ? (
          <button className="btn primary wide" onClick={nextStep}>
            <CheckCircle2 size={15} /> {stepIndex + 1 === lesson.steps.length ? 'Finish lesson' : 'Next level'} <ChevronRight size={15} />
          </button>
        ) : (
          <>
            {(ls.stepT > 0 || ls.missed) && (
              <button className="btn" onClick={reset} title="Replay this level with the design on the board">
                <RotateCcw size={14} /> Replay level
              </button>
            )}
            {struggling && step.solution && !ls.shown && (
              <button className="btn" onClick={showSolution} title={`Put a design that passes on the board: ${step.solution.note}`}>
                <Eye size={14} /> Show me
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
