import { CAPTURE_PROPS } from './captureProps';

/**
 * A fast DOM → SVG snapshot for rendering Studio frames. Writes the markup straight to a string and
 * gives each element only the styles that differ from what the copy would get anyway: its parent's
 * value for inherited properties, the browser's default for the rest. A frame of two boards is a
 * few hundred kilobytes instead of megabytes, and is built several times faster.
 */

const INHERITED = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric', 'font-feature-settings', 'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-transform', 'text-shadow', 'text-indent', 'white-space', 'word-break', 'overflow-wrap', 'visibility', 'list-style-type', 'list-style-position', 'cursor',
  '-webkit-text-fill-color', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'marker-start', 'marker-end', 'shape-rendering', 'paint-order', 'dominant-baseline', 'text-anchor',
]);
const HTML_PROPS = CAPTURE_PROPS.filter((p) => !['d', 'r', 'cx', 'cy', 'x', 'y', 'rx', 'ry'].includes(p) && p !== 'content');
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr', 'meta', 'link', 'source', 'col', 'area']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'video', 'audio']);
const SMIL = new Set(['animate', 'animateMotion', 'animateTransform', 'set']);
const SVG_PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'display', 'visibility', 'filter', 'marker-start', 'marker-end', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'stop-color', 'stop-opacity', 'transform-origin'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** the browser's own defaults per tag, read from an empty document (no page styles) */
const defaults = new Map<string, Record<string, string>>();
let blank: Document | null = null;
function defaultsFor(tag: string): Record<string, string> {
  let d = defaults.get(tag);
  if (d) return d;
  if (!blank) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    blank = frame.contentDocument!;
    blank.open();
    blank.write('<!doctype html><html><body></body></html>');
    blank.close();
  }
  const el = tag === 'svg' ? blank.createElementNS('http://www.w3.org/2000/svg', 'svg') : blank.createElement(tag);
  blank.body.appendChild(el);
  const cs = blank.defaultView!.getComputedStyle(el);
  d = {};
  for (const p of HTML_PROPS) d[p] = cs.getPropertyValue(p);
  el.remove();
  defaults.set(tag, d);
  return d;
}

function styleOf(cs: CSSStyleDeclaration, parent: Record<string, string> | null, tag: string, out: Record<string, string>): string {
  const def = defaultsFor(tag);
  let s = '';
  for (const p of HTML_PROPS) {
    let v = cs.getPropertyValue(p);
    out[p] = v;
    const base = INHERITED.has(p) && parent ? parent[p] : def[p];
    // the empty document's defaults were read on a zero-size element: anything that resolves
    // against the element's own box (a centred transform-origin) has to be written out
    // and a box's own size: the empty document's 0px would make a 0% bar take its parent's width
    if (v === base && !(p === 'transform-origin' && cs.getPropertyValue('transform') !== 'none') && !((p === 'width' || p === 'height') && tag !== 'svg')) continue;
    // as html-to-image does: a hair smaller, so text never wraps differently in the copy
    if (p === 'font-size' && v.endsWith('px')) v = `${Math.floor(parseFloat(v)) - 0.1}px`;
    s += `${p}:${v};`;
  }
  return s;
}

function pseudo(el: Element, which: '::before' | '::after', parent: Record<string, string>): string {
  const cs = getComputedStyle(el, which);
  const content = cs.getPropertyValue('content');
  if (!content || content === 'none' || content === 'normal') return '';
  const m = content.match(/^"(.*)"$/s);
  const text = m ? m[1].replace(/\\"/g, '"') : '';
  const own: Record<string, string> = {};
  return `<span style="${esc(styleOf(cs, parent, 'span', own))}">${esc(text)}</span>`;
}

/** an inline <svg>: copied with its children's paint and the animations' current state baked in */
function svgMarkup(live: SVGSVGElement, rootStyle: string): string {
  const still = live.cloneNode(true) as SVGSVGElement;
  const a = live.querySelectorAll<SVGGraphicsElement>('*');
  const b = still.querySelectorAll<SVGGraphicsElement>('*');
  const drop: Element[] = [];
  a.forEach((el, i) => {
    const copy = b[i];
    if (SMIL.has(el.tagName)) return void drop.push(copy);
    const cs = getComputedStyle(el);
    copy.setAttribute('style', SVG_PAINT.map((k) => `${k}:${cs.getPropertyValue(k)}`).join(';'));
    copy.removeAttribute('class');
    if (![...el.children].some((c) => SMIL.has(c.tagName)) || !el.getCTM) return;
    const parent = (el.parentElement as unknown as SVGGraphicsElement)?.getCTM?.();
    const ctm = el.getCTM();
    if (parent && ctm) {
      const m = parent.inverse().multiply(ctm);
      copy.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
    }
    if (el instanceof SVGCircleElement) copy.setAttribute('r', String(el.r.animVal.value));
  });
  drop.forEach((d) => d.remove());
  still.removeAttribute('class');
  still.setAttribute('style', rootStyle);
  return new XMLSerializer().serializeToString(still);
}

function walk(node: Node, parent: Record<string, string> | null, rootOverride?: string): string {
  if (node.nodeType === Node.TEXT_NODE) return esc(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return '';
  const own: Record<string, string> = {};
  const style = styleOf(cs, parent, tag, own) + (rootOverride ?? '');
  if (tag === 'svg') return svgMarkup(el as SVGSVGElement, style);
  const name = /^[a-z][a-z0-9-]*$/.test(tag) ? tag : 'div';
  let attrs = ` style="${esc(style)}"`;
  if (tag === 'img') attrs += ` src="${esc((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src)}"`;
  if (VOID.has(name)) return `<${name}${attrs}/>`;
  let inner = pseudo(el, '::before', own);
  for (const c of el.childNodes) inner += walk(c, own);
  inner += pseudo(el, '::after', own);
  return `<${name}${attrs}>${inner}</${name}>`;
}

/** the element as an SVG image (data URL) at w × h */
export function snapshotSvg(root: HTMLElement, w: number, h: number, fontCSS = ''): string {
  const body = walk(root, null, 'transform:none;margin:0;left:0;top:0;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden"><style>${fontCSS.replace(/</g, '\\3c ')}</style>${body}</div>` +
    `</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
