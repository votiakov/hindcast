import { describe, expect, it } from 'vitest';
import { carouselPdf, subsetFontCSS } from '../src/studio/exportClip';

describe('in-browser export', () => {
  it('keeps only the font faces the clip uses', () => {
    const face = (range: string) => `@font-face { font-family: "Plex"; src: url(x); unicode-range: ${range}; }`;
    const css = [face('U+0000-00FF, U+0131'), face('U+0400-045F'), face('U+1F00-1FFF'), '@font-face { font-family: "Any"; src: url(y); }'].join('\n');
    const out = subsetFontCSS(css, 'Works on localhost →');
    expect(out).toContain('U+0000-00FF');
    expect(out).not.toContain('U+0400-045F');
    expect(out).not.toContain('U+1F00-1FFF');
    expect(out).toContain('"Any"'); // no range: always kept
    expect(subsetFontCSS(face('U+2190-21FF'), '→')).toContain('U+2190');
    expect(subsetFontCSS(face('U+04??'), 'ж')).toContain('U+04??');
  });

  it('writes a PDF with one page per slide and a valid cross-reference table', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    const pdf = await carouselPdf([jpeg, jpeg, jpeg], 1080, 1350);
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
    // every xref offset points at the start of its object
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});
