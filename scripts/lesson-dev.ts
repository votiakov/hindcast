// Every level of a lesson, as the previous level left it and with its solution: passed or not, and the
// worst moment while the goal was checked. For tuning a lesson's numbers. npx tsx scripts/lesson-dev.ts <lesson-id>
import { loadEngine } from '../src/backtest/native';
import { LESSONS } from '../src/lessons';
import { playLesson } from '../src/lessons/verify';

await loadEngine();
const want = process.argv[2];
for (const lesson of LESSONS.filter((l) => !want || l.id === want)) {
  console.log(`\n${lesson.title}`);
  const fmt = (r: { passed: boolean; at: number | null; worst: { errorRate: number; p99: number; cost: number; lagS?: number; avgCost?: number } }) =>
    `${r.passed ? 'PASS' : 'fail'}${r.at !== null ? ` @${r.at}s` : ''} worst err ${(r.worst.errorRate * 100).toFixed(1)}% p99 ${Math.round(r.worst.p99)}ms cost $${r.worst.cost.toFixed(2)}${r.worst.lagS ? ` lag ${r.worst.lagS.toFixed(0)}s` : ''}${r.worst.avgCost ? ` avg $${r.worst.avgCost.toFixed(2)}` : ''}`;
  for (const r of playLesson(lesson)) console.log(`  ${r.step.padEnd(12)} before: ${fmt(r.before).padEnd(64)} after: ${fmt(r.after)}`);
}
