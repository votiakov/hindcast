// A traffic shape from a real access log (Common Log Format, plain or gzipped): one day of real
// arrivals, compressed in time and scaled in rate, so a recording replays its real diurnal curve
// and its real spikes.
//   node fromLog.mjs <log[.gz]> <dd/Mon/yyyy> <minutes> <peakRps | xN> [stepS=20] > shape.json
// Requests are counted per slice of the day (24 h / (minutes·60 / stepS)). With a number, the
// busiest slice becomes that many req/s and every other slice keeps its real proportion to it; with
// xN, every slice is the log's real rate times N — so two days replayed with the same N keep their
// real ratio to each other (a launch day stays 2× an ordinary day).
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

const [file, day, minutes, peak, stepArg] = process.argv.slice(2);
if (!file || !day || !minutes || !peak) throw new Error('usage: fromLog.mjs <log[.gz]> <dd/Mon/yyyy> <minutes> <peakRps | xN> [stepS]');
const stepS = Number(stepArg ?? 20);
const slices = Math.round((Number(minutes) * 60) / stepS);
const counts = new Array(slices).fill(0);
const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
const re = /\[(\d\d\/\w{3}\/\d{4}):(\d\d):(\d\d):(\d\d)/;
let seen = 0;
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  const m = re.exec(line);
  if (!m || m[1] !== day) continue;
  const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  counts[Math.min(slices - 1, Math.floor((sec / 86400) * slices))]++;
  seen++;
}
if (!seen) throw new Error(`no requests on ${day} in ${file}`);
const top = Math.max(...counts);
const sliceS = 86400 / slices;
// rps for a slice holding c requests
const rate = peak.startsWith('x') ? (c) => (c / sliceS) * Number(peak.slice(1)) : (c) => (c / top) * Number(peak);
const out = counts.map((c, i) => ({ t: i * stepS, rps: Math.round(rate(c) * 100) / 100 }));
out.push({ t: slices * stepS, rps: out[out.length - 1].rps });
process.stderr.write(`${day}: ${seen} requests, busiest slice ${top} (${((top / seen) * slices).toFixed(1)}× the day's mean) → peak ${rate(top).toFixed(1)} req/s\n`);
process.stdout.write(JSON.stringify(out) + '\n');
