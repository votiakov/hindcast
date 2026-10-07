// k6: replay a traffic shape (open model — arrivals don't wait for responses, like real users)
// over a weighted endpoint mix. Arrivals are Poisson, like independent users: k6's arrival-rate
// executor paces iterations evenly, so it runs THIN× faster and each iteration fires with
// probability 1/THIN (interarrival CV ≈ 0.97 instead of 0 — even pacing hides queueing).
//   SHAPE=/load/shape.json  MIX=/load/mix.json  BASE=http://frontend:8080  TIMEOUT=5s
import http from 'k6/http';

const shape = JSON.parse(open(__ENV.SHAPE)); // [{ t: seconds from start, rps }]
const mix = JSON.parse(open(__ENV.MIX)); // [{ name, method, path, weight, body?, vars? }]
const base = __ENV.BASE;
const total = mix.reduce((s, m) => s + m.weight, 0);
const THIN = Number(__ENV.THIN || 20);

// arrival rate per 10 s keeps sub-1 req/s resolution; linear ramps between keyframes
const stages = [];
for (let i = 1; i < shape.length; i++) stages.push({ target: Math.round(shape[i].rps * 10 * THIN), duration: `${shape[i].t - shape[i - 1].t}s` });

export const options = {
  discardResponseBodies: true,
  scenarios: {
    replay: {
      executor: 'ramping-arrival-rate',
      startRate: Math.round(shape[0].rps * 10 * THIN),
      timeUnit: '10s',
      preAllocatedVUs: 100,
      maxVUs: 3000,
      stages,
    },
  },
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export default function () {
  if (Math.random() * THIN >= 1) return;
  let r = Math.random() * total;
  let m = mix[0];
  for (const x of mix) {
    r -= x.weight;
    if (r <= 0) {
      m = x;
      break;
    }
  }
  let path = m.path;
  for (const [k, vals] of Object.entries(m.vars || {})) path = path.replace(`{${k}}`, String(pick(vals)));
  path = path.replace('{rand}', String(Math.random()));
  const params = { timeout: __ENV.TIMEOUT || '5s', tags: { name: m.name }, headers: m.headers || {} };
  if (m.method === 'POST') http.post(base + path, m.body || '', params);
  else http.get(base + path, params);
}
