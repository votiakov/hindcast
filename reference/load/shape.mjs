// Traffic shapes for reference runs (deterministic).
//   node shape.mjs history <peakRps> <spikeRps> <minutes> > shape.json   — a compressed "production day":
//        night trough, morning ramp, lunch peak (peakRps), a 3-minute afternoon push to spikeRps, evening decline
//   node shape.mjs steps <fromRps> <toRps> <stepRps> <holdS> > shape.json   — stress test
const [kind, ...a] = process.argv.slice(2);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const out = [];
if (kind === 'history') {
  const peak = Number(a[0]);
  const spikeTo = Number(a[1]);
  const minutes = Number(a[2] ?? 40);
  const span = minutes * 60;
  const step = 20;
  for (let t = 0; t <= span; t += step) {
    const x = t / span; // 0..1 of the "day"
    const shape = (u) => 0.28 + 0.5 * Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.08) / 0.84)))) ** 1.4 + 0.14 * Math.exp(-(((u - 0.45) / 0.06) ** 2));
    const norm = peak / shape(0.45);
    const atSpike = shape(0.72) * norm;
    const spike = Math.max(0, spikeTo - atSpike) * Math.exp(-(((x - 0.72) / (90 / span)) ** 2)); // marketing push, ~3 min
    const noise = 1 + (rnd() - 0.5) * 0.12;
    out.push({ t, rps: Math.round((shape(x) * norm * noise + spike) * 100) / 100 });
  }
} else if (kind === 'steps') {
  const [from, to, inc, hold] = a.map(Number);
  let t = 0;
  out.push({ t: 0, rps: from });
  for (let r = from; r <= to + 1e-9; r += inc) {
    out.push({ t: t + 5, rps: r });
    t += hold;
    out.push({ t, rps: r });
  }
} else throw new Error('usage: shape.mjs history <peak> <minutes> | steps <from> <to> <step> <holdS>');
process.stdout.write(JSON.stringify(out) + '\n');
