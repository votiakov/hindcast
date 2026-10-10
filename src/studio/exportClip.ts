import { getFontEmbedCSS } from 'html-to-image';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { useSim } from '../sim/store';
import { manualClock } from '../sim/clock';
import { snapshotSvg } from './snapshot';
import { OUTRO_SECONDS, episodeById, episodeDuration } from './episodes';

/**
 * Render the loaded episode in the browser, frame by frame: the simulation, camera moves and CSS
 * animations all follow a virtual clock, so the clip is identical however slow the machine is.
 * Produces an MP4 (WebCodecs, where the browser has it), a GIF, and the carousel: a still a
 * moment after every caption beat plus the outro, as PNGs and one PDF.
 */

export interface ClipOptions {
  fps: number;
  mp4: boolean;
  gif: boolean;
  carousel: boolean;
  signal: AbortSignal;
  onProgress: (done: number, label: string) => void;
}

export interface Clip {
  mp4?: Blob;
  gif?: Blob;
  stills: Blob[];
  pdf?: Blob;
}

export const canEncodeMp4 = () => typeof window !== 'undefined' && 'VideoEncoder' in window;

const SIM_STEP = 0.05;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function mp4Encoder(w: number, h: number, fps: number) {
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h }, fastStart: 'in-memory' });
  let failed: unknown;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failed = e) });
  // High profile, level 5.1: up to 4096×2304, enough for every Studio format
  const config: VideoEncoderConfig = { codec: 'avc1.640033', width: w, height: h, bitrate: 8_000_000, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) config.codec = 'avc1.42003e';
  enc.configure(config);
  let n = 0;
  return {
    async add(canvas: HTMLCanvasElement) {
      if (failed) throw failed;
      const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: n % (fps * 2) === 0 });
      frame.close();
      n++;
      if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    },
    async done() {
      await enc.flush();
      enc.close();
      if (failed) throw failed;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
  };
}

function gifEncoder(w: number, h: number, every: number, delayMs: number) {
  const gw = Math.min(540, w);
  const gh = Math.round((h * gw) / w);
  const small = document.createElement('canvas');
  small.width = gw;
  small.height = gh;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  let n = 0;
  return {
    add(canvas: HTMLCanvasElement) {
      if (n++ % every) return;
      ctx.drawImage(canvas, 0, 0, gw, gh);
      const { data } = ctx.getImageData(0, 0, gw, gh);
      const palette = quantize(data, 128);
      gif.writeFrame(applyPalette(data, palette), gw, gh, { palette, delay: delayMs });
    },
    done() {
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    },
  };
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('could not encode the frame'))), type, q));

/** a PDF with one full-bleed JPEG per page: LinkedIn takes it as a document carousel */
export async function carouselPdf(jpegs: Blob[], w: number, h: number): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: (Uint8Array | string)[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (p: Uint8Array | string) => {
    parts.push(p);
    size += typeof p === 'string' ? enc.encode(p).length : p.length;
  };
  const obj = (body: () => void) => {
    offsets.push(size);
    push(`${offsets.length} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  const n = jpegs.length;
  // 1 catalog, 2 pages, then per page: page, content, image
  const pageId = (i: number) => 3 + i * 3;
  obj(() => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(() => push(`<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`));
  for (let i = 0; i < n; i++) {
    const img = new Uint8Array(await jpegs[i].arrayBuffer());
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(() => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageId(i) + 2} 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`));
    obj(() => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    obj(() => {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push('\nendstream');
    });
  }
  const xref = size;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** pin CSS animations and SVG timelines to the frame clock, as the command-line recorder does */
function pinAnimations(root: HTMLElement, t: number, born: WeakMap<object, number>) {
  for (const a of document.getAnimations()) {
    if (!born.has(a)) born.set(a, t);
    a.pause();
    a.currentTime = (t - born.get(a)!) * 1000;
  }
  for (const svg of root.querySelectorAll('svg')) {
    if (!born.has(svg)) born.set(svg, t);
    svg.pauseAnimations();
    svg.setCurrentTime(t - born.get(svg)!);
  }
}

/** keep only the @font-face rules whose unicode-range covers a character the clip shows */
export function subsetFontCSS(css: string, text: string): string {
  const cps = new Set([...text].map((c) => c.codePointAt(0)!));
  const covers = (range: string) =>
    range.split(',').some((r) => {
      const [a, b] = r.trim().replace(/^U\+/i, '').split('-');
      if (a.includes('?')) return [...cps].some((c) => c >= parseInt(a.replace(/\?/g, '0'), 16) && c <= parseInt(a.replace(/\?/g, 'F'), 16));
      const lo = parseInt(a, 16);
      const hi = b ? parseInt(b, 16) : lo;
      return [...cps].some((c) => c >= lo && c <= hi);
    });
  return css
    .split(/(?=@font-face)/)
    .filter((face) => {
      const m = face.match(/unicode-range:\s*([^;}]+)/);
      return !m || covers(m[1]);
    })
    .join('');
}

/** the stage as it is now, at its true pixel size */
export async function captureFrame(stage: HTMLElement, w: number, h: number, fontEmbedCSS?: string, into?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  fontEmbedCSS ??= await getFontEmbedCSS(stage);
  const img = new Image();
  img.src = snapshotSvg(stage, w, h, fontEmbedCSS);
  await img.decode();
  // one canvas for the whole clip: a fresh 1080×1350 canvas per frame exhausts memory before the GC returns them
  const canvas = into ?? document.createElement('canvas');
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  img.src = '';
  return canvas;
}

export async function renderClip(stage: HTMLElement, w: number, h: number, o: ClipOptions): Promise<Clip> {
  const fps = o.fps;
  const dt = 1 / fps;
  const s = useSim.getState();
  const realNow = performance.now.bind(performance);
  let vt = realNow();
  const born = new WeakMap<object, number>();
  const clip: Clip = { stills: [] };
  const jpegs: Blob[] = [];

  s.setRunning(false);
  s.loadEpisode(s.studio.episodeId);
  manualClock.on = true;
  // camera moves (d3 transitions) read performance.now: give them the virtual clock
  performance.now = () => vt;
  try {
    // let the boards mount and fit
    for (let i = 0; i < 6; i++) await nextFrame();
    await new Promise((r) => setTimeout(r, 150));
    const ep = episodeById(s.studio.episodeId);
    const words = [stage.textContent ?? '', ep.series, ep.hook, ep.outro.title, ...ep.outro.lines, ep.outro.cta ?? '', ...ep.beats.map((b) => b.caption ?? ''), '0123456789$%.,·→/ ', ep.a?.title ?? '', ep.b?.title ?? ''].join('');
    const fontEmbedCSS = subsetFontCSS(await getFontEmbedCSS(stage), words);
    const video = o.mp4 && canEncodeMp4() ? await mp4Encoder(w, h, fps) : undefined;
    const gif = o.gif ? gifEncoder(w, h, Math.max(1, Math.round(fps / 10)), Math.round(1000 / Math.min(fps, 10))) : undefined;

    useSim.getState().setRunning(true);
    const total = episodeDuration(episodeById(s.studio.episodeId)) + OUTRO_SECONDS;
    const frame = document.createElement('canvas');
    let due = 0;
    let lastFired = 0;
    let stillAt = -1;
    let outroShot = false;
    const maxFrames = fps * 180;
    for (let f = 0; f < maxFrames; f++) {
      if (o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (!stage.isConnected) throw new Error('the Studio was closed while rendering');
      vt += 1000 * dt;
      // the simulation moves in fixed 50 ms steps: take one whenever a whole step is due
      due += dt;
      while (due >= SIM_STEP - 1e-9) {
        useSim.getState().tick(SIM_STEP / (useSim.getState().speed || 1)); // one step, whatever the playback speed
        due -= SIM_STEP;
      }
      await nextFrame();
      const t = (f + 1) * dt;
      pinAnimations(stage, t, born);
      const canvas = await captureFrame(stage, w, h, fontEmbedCSS, frame);
      if (video) await video.add(canvas);
      gif?.add(canvas);

      const st = useSim.getState().studio;
      if (o.carousel) {
        if (st.fired.length > lastFired) {
          lastFired = st.fired.length;
          stillAt = f + Math.round(fps * 2); // after the caption animated in and the system reacted
        }
        if (st.finished && !outroShot && st.t > 0) {
          outroShot = true;
          stillAt = f + Math.round(fps * 1.5);
        }
        if (f === stillAt) {
          clip.stills.push(await toBlob(canvas, 'image/png'));
          jpegs.push(await toBlob(canvas, 'image/jpeg', 0.92));
        }
      }
      o.onProgress(Math.min(1, st.t / total), `${st.t.toFixed(0)} of ${total} s`);
      if (st.done) break;
    }
    o.onProgress(1, 'encoding');
    if (video) clip.mp4 = await video.done();
    if (gif) clip.gif = gif.done();
    if (jpegs.length) clip.pdf = await carouselPdf(jpegs, w, h);
    return clip;
  } finally {
    performance.now = realNow;
    manualClock.on = false;
    useSim.getState().setRunning(false);
  }
}

