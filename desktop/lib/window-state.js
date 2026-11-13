'use strict';
// Remembers where the antics window was, how big it was, whether it was maximized and the zoom level,
// in window-state.json next to the app's other data.

const fs = require('fs');

const DEFAULTS = { width: 1280, height: 860, maximized: false, zoom: 0 };
const MIN = { width: 380, height: 560 };

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// workAreas: [{ x, y, width, height }] of the screens now attached. A saved position that is no longer on
// any screen (a monitor was unplugged) is dropped, so the window opens centred instead of off screen.
function sanitize(raw, workAreas = []) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  if (num(raw.width) && num(raw.height)) {
    s.width = Math.round(Math.min(Math.max(raw.width, MIN.width), 10000));
    s.height = Math.round(Math.min(Math.max(raw.height, MIN.height), 10000));
  }
  if (num(raw.x) && num(raw.y)) {
    const r = { x: Math.round(raw.x), y: Math.round(raw.y), width: s.width, height: s.height };
    const visible = workAreas.some((a) => {
      const w = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x);
      const h = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y);
      return w >= 120 && h >= 60;
    });
    if (visible) Object.assign(s, { x: r.x, y: r.y });
  }
  s.maximized = raw.maximized === true;
  if (num(raw.zoom)) s.zoom = Math.min(Math.max(raw.zoom, -3), 5);
  return s;
}

function load(file, workAreas) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null; // first start, or a damaged file: start from the defaults
  }
  return sanitize(raw, workAreas);
}

function save(file, state) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch {
    // Not being able to remember the window is never worth an error box.
  }
}

// Keeps file up to date while win moves and resizes. Returns a function that writes it now.
function track(win, file, state) {
  let timer = null;
  const capture = () => {
    if (win.isDestroyed()) return;
    if (!win.isMinimized() && !win.isFullScreen()) {
      state.maximized = win.isMaximized();
      // The size it goes back to when un-maximized, so a maximized window still remembers it.
      const b = win.getNormalBounds();
      Object.assign(state, { x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      capture();
      save(file, state);
    }, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later);
  const now = () => {
    clearTimeout(timer);
    capture();
    save(file, state);
  };
  win.on('close', now);
  return now;
}

module.exports = { DEFAULTS, MIN, sanitize, load, save, track };
