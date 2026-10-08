// Pins follow the note being read: the note nearest the top of the screen lights its pin, hovering
// a note or a pin lights both, and a pin scrolls to its note.
(() => {
  const notes = [...document.querySelectorAll('ol.pins > li[id]')];
  const pinOf = (id) => document.querySelector(`.pin[data-for="${id}"]`);
  let active = null;
  const light = (li) => {
    if (li === active) return;
    if (active) {
      active.classList.remove('on');
      pinOf(active.id)?.classList.remove('on');
    }
    active = li;
    if (li) {
      li.classList.add('on');
      pinOf(li.id)?.classList.add('on');
    }
  };
  const pick = () => {
    // the last note whose top has passed a line a third of the way down the viewport
    const line = window.innerHeight * 0.33;
    let best = null;
    for (const li of notes) {
      const r = li.getBoundingClientRect();
      if (r.top <= line && r.bottom > 0) best = li;
    }
    light(best);
  };
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => ((queued = false), pick()));
  }, { passive: true });
  for (const li of notes) li.addEventListener('mouseenter', () => light(li));
  for (const pin of document.querySelectorAll('.pin')) {
    pin.addEventListener('mouseenter', () => light(document.getElementById(pin.dataset.for)));
    pin.addEventListener('click', (e) => {
      const li = document.getElementById(pin.dataset.for);
      if (!li) return;
      e.preventDefault();
      li.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      light(li);
      history.replaceState(null, '', `#${li.id}`);
    });
  }
  if (location.hash) light(document.getElementById(location.hash.slice(1)));
  else pick();
})();
