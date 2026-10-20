// Optional overlay page scrollbar, styled after macOS (docs/ui.md); on by default
// except on macOS. The page still scrolls natively (wheel, keys, find, anchors);
// this only draws the bar, between the top bar and the console. The native one
// can't start below the top bar, so in the Linux app it sits under Electron's
// window buttons.
const HIDE_AFTER = 1200; // ms after the last scroll
const INSET = 3; // px the thumb keeps from the track's ends

export const scrollbarPrefs = (store) => ({
  custom: store.get('customScrollbar', !/Mac/.test(navigator.platform)),
  mode: store.get('scrollbar', 'auto'),
});

// custom: draw our bar instead of the native one. mode 'auto' shows it while
// scrolling; 'always' keeps it, and the page leaves room.
export function applyScrollbar({ custom, mode }) {
  const root = document.documentElement;
  root.classList.toggle('own-scrollbar', custom);
  root.classList.toggle('sb-always', custom && mode === 'always');
  dispatchEvent(new Event('net-scrollbar'));
}

export function initScrollbar() {
  const root = document.documentElement;
  const topbar = document.querySelector('.topbar');
  const bar = document.createElement('div');
  bar.className = 'vscroll';
  bar.innerHTML = '<div class="thumb"></div>';
  document.body.append(bar);
  const thumb = bar.firstChild;

  let m = null; // { top, track, run, len, max }; run = track minus the insets
  let hideT = 0;
  let drag = null; // { y, s }
  let hover = false;

  function layout() {
    const top = topbar.getBoundingClientRect().bottom;
    const consoleH = parseFloat(getComputedStyle(document.body).getPropertyValue('--console-h')) || 0;
    const track = innerHeight - consoleH - top;
    const max = root.scrollHeight - root.clientHeight;
    if (!root.classList.contains('own-scrollbar') || max <= 0 || track < 40) {
      m = null;
      bar.hidden = true;
      return;
    }
    const run = track - 2 * INSET;
    const len = Math.max(32, (run * root.clientHeight) / root.scrollHeight);
    m = { top, track, run, len, max };
    bar.hidden = false;
    bar.style.top = `${top}px`;
    bar.style.height = `${track}px`;
    thumb.style.height = `${len}px`;
    thumb.style.transform = `translateY(${INSET + ((run - len) * Math.min(scrollY, max)) / max}px)`;
  }

  const always = () => root.classList.contains('sb-always');
  function show() {
    if (!m) return;
    if (always()) {
      clearTimeout(hideT);
      return bar.classList.add('on');
    }
    bar.classList.add('on');
    clearTimeout(hideT);
    if (!hover && !drag) hideT = setTimeout(() => bar.classList.remove('on'), HIDE_AFTER);
  }

  addEventListener('scroll', () => (layout(), show()), { passive: true });
  addEventListener('resize', layout);
  new ResizeObserver(layout).observe(document.body);
  new ResizeObserver(layout).observe(topbar);

  addEventListener('net-scrollbar', () => {
    layout();
    if (always()) show();
    else bar.classList.remove('on');
  });
  bar.addEventListener('mouseenter', () => ((hover = true), show()));
  bar.addEventListener('mouseleave', () => ((hover = false), show()));

  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no text selection while dragging
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, s: scrollY };
    bar.classList.add('drag');
    show();
  });
  thumb.addEventListener('pointermove', (e) => {
    if (drag && m) scrollTo(0, drag.s + ((e.clientY - drag.y) * m.max) / (m.run - m.len));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    bar.classList.remove('drag');
    show();
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  // A click on the track pages toward it.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target !== bar || !m) return;
    e.preventDefault();
    const r = thumb.getBoundingClientRect();
    const page = m.track - 40;
    if (e.clientY < r.top) scrollBy(0, -page);
    else if (e.clientY > r.bottom) scrollBy(0, page);
  });

  layout();
}
