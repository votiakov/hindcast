import { LESSONS } from '../src/lessons';
import { playLesson } from '../src/lessons/verify';
for (const l of LESSONS) {
  const rs = playLesson(l);
  for (const [i, r] of rs.entries()) {
    const st = l.steps[i];
    const bad = (st.solution ? r.before.passed : !r.before.passed) || !r.after.passed;
    if (bad) console.log(`${l.id}/${r.step}: before ${r.before.passed} ${JSON.stringify(r.before.worst)} | after ${r.after.passed} ${JSON.stringify(r.after.worst)}`);
  }
}
console.log('done');
