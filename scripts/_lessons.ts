import { LESSONS } from '../src/lessons';
import { playLesson } from '../src/lessons/verify';
for (const l of LESSONS) {
  console.log(`\n${l.id}`);
  for (const r of playLesson(l)) console.log(`  ${r.step.padEnd(12)} before ${r.before.passed ? 'PASS' : 'fail'} ${JSON.stringify(r.before.worst, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))}  after ${r.after.passed ? 'PASS at ' + r.after.at : 'fail'}`);
}
