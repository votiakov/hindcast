import { CheckCircle2, ChevronRight, Lightbulb, RotateCcw, Star, Target } from 'lucide-react';
import { useSim } from '../sim/store';
import { LESSONS } from '../lessons';
import { finalRps, goalStart } from '../lessons/types';

function LessonPicker() {
  const id = useSim((s) => s.lesson.lesson.id);
  const pick = useSim((s) => s.pickLesson);
  return (
    <select className="lesson-picker" value={id} onChange={(e) => pick(e.target.value)} title="Choose a lesson">
      {LESSONS.map((l, i) => (
        <option key={l.id} value={l.id}>
          {i + 1}. {l.title}
        </option>
      ))}
    </select>
  );
}

export function LessonPanel() {
  const ls = useSim((s) => s.lesson);
  const running = useSim((s) => s.running);
  const cost = useSim((s) => s.boards.main.global.cost);
  const showCost = useSim((s) => s.settings.cost);
  const { nextStep, reset: resetLesson } = useSim.getState();
  const { lesson, stepIndex } = ls;

  if (ls.finished) {
    const stars = !showCost ? 3 : cost <= lesson.stars.three ? 3 : cost <= lesson.stars.two ? 2 : 1;
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
            {lesson.outro ?? `You handled ${finalRps(lesson).toLocaleString()} req/s`} Final cost: <b>${cost.toFixed(2)}/h</b>.
          </p>
          <p className="muted">
            3★ at ≤ ${lesson.stars.three.toFixed(2)}/h · 2★ at ≤ ${lesson.stars.two.toFixed(2)}/h
          </p>
          <button className="btn primary" onClick={resetLesson}>
            <RotateCcw size={14} /> Play again
          </button>
        </div>
      </div>
    );
  }

  const step = lesson.steps[stepIndex];
  const holdPct = step.goal ? Math.min(1, ls.holdT / step.goal.holdSeconds) : 0;
  const ramping = ls.stepT < goalStart(step);
  const showHint = step.hint && ls.failT >= (step.hintAfter ?? 8);

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
            <span>{ls.passed ? 'Passed' : !running && ls.stepT === 0 ? 'Press ▶ Play to start' : ramping ? 'Traffic ramping up…' : holdPct > 0 ? 'Holding SLO…' : 'SLO violated — fix the system'}</span>
            <span>
              {Math.min(ls.holdT, step.goal.holdSeconds).toFixed(1)}s / {step.goal.holdSeconds}s
            </span>
          </div>
          <div className="hold-bar">
            <div className={`hold-fill ${ls.passed ? 'passed' : ''}`} style={{ width: `${holdPct * 100}%` }} />
          </div>
        </div>
      )}

      {showHint && !ls.passed && (
        <div className="hint">
          <Lightbulb size={14} />
          <span>{step.hint}</span>
        </div>
      )}

      {ls.passed && (
        <button className="btn primary wide" onClick={nextStep}>
          <CheckCircle2 size={15} /> {stepIndex + 1 === lesson.steps.length ? 'Finish lesson' : 'Next level'} <ChevronRight size={15} />
        </button>
      )}
    </div>
  );
}
