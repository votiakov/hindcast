/**
 * The CSS properties a Studio frame needs to look right. Copying only these into the captured
 * copy (instead of all ~400 computed properties per element) makes each frame several times faster.
 */
export const CAPTURE_PROPS = [
  // box and layout
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow-x', 'overflow-y', 'float', 'clear', 'vertical-align', 'visibility', 'opacity', 'transform', 'transform-origin', 'translate', 'scale', 'rotate',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-self', 'align-content', 'order',
  'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows', 'justify-items', 'justify-self', 'place-items',
  // paint
  'color', 'background-color', 'background-image', 'background-size', 'background-position-x', 'background-position-y', 'background-repeat', 'background-clip', 'background-origin',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'outline-width', 'outline-style', 'outline-color', 'outline-offset', 'box-shadow', 'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path', 'mask-image', '-webkit-mask-image',
  // text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric', 'font-feature-settings', 'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-transform', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-shadow', 'text-overflow', 'text-indent', 'white-space', 'word-break', 'overflow-wrap',
  '-webkit-line-clamp', '-webkit-box-orient', '-webkit-text-fill-color', '-webkit-background-clip', 'list-style-type', 'list-style-position', 'content', 'object-fit', 'cursor',
  // svg
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'marker-start', 'marker-end',
  'stop-color', 'stop-opacity', 'shape-rendering', 'paint-order', 'dominant-baseline', 'text-anchor', 'd', 'r', 'cx', 'cy', 'x', 'y', 'rx', 'ry', 'offset-path', 'offset-distance',
];
