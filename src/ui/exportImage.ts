import { getFontEmbedCSS } from 'html-to-image';
import { snapshotSvg } from '../studio/snapshot';

/**
 * The board as an image, as it looks now: the components, their readings and the links, without
 * the minimap and the panels floating over it. PNG at twice the screen's pixels; SVG as it is drawn.
 */
export async function exportBoardImage(root: HTMLElement, name: string, format: 'png' | 'svg'): Promise<void> {
  root.classList.add('exporting');
  try {
    const { width: w, height: h } = root.getBoundingClientRect();
    const url = snapshotSvg(root, Math.round(w), Math.round(h), await getFontEmbedCSS(root));
    if (format === 'svg') return save(`${name}.svg`, new Blob([decodeURIComponent(url.slice(url.indexOf(',') + 1))], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = 2;
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale), height: Math.round(h * scale) });
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) save(`${name}.png`, blob);
  } finally {
    root.classList.remove('exporting');
  }
}

function save(file: string, blob: Blob) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
