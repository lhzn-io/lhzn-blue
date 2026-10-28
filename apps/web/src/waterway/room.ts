/** Room held in the status column as the time bar moves: each table's caption and rows, and each block beside them, at
 * the tallest they reach anywhere in the time bar's reach, so dragging the time never moves the page below. The column
 * is drawn off screen at times across that reach whenever what it shows changes (the view, the station, the width, the
 * data); a live draw taller than all of them still raises the hold. When it shows something new, the first few times
 * (now, the page's time and the hours either side, which cover the caption's forms) are drawn at once, before the page
 * paints, so a new station's column opens at its held size instead of growing a second later. */
import { AT, setAt } from "./cursor";

const ROOM = new Map<string, number>();
let held = "";
let survey = 0;
let check = 0;
let probe: HTMLElement | null = null;
const QUICK = 8; // the times surveyed at once on a fresh key (roomTimes puts now, the page's time and one of each kind first)

/** The column's parts that can change height: table captions and rows (a row by its station), and the blocks that hold
 * no table (a photo fills what is left, so it is not one). */
function parts(box: HTMLElement): [string, HTMLElement][] {
  const out: [string, HTMLElement][] = [];
  const seen = new Map<string, number>();
  box.querySelectorAll("table").forEach((t) => {
    const n = seen.get(t.className) ?? 0;
    seen.set(t.className, n + 1);
    const i = `${t.className}#${n}`;
    const cap = t.querySelector("caption");
    if (cap) out.push([`t${i}c`, cap]);
    t.querySelectorAll<HTMLElement>("tbody tr").forEach((tr, j) => out.push([`t${i}r${tr.querySelector("th a")?.getAttribute("href") ?? j}`, tr]));
  });
  // A block by what it is (its tag and classes), since which blocks show can change with the time.
  [...box.children].forEach((el) => {
    if (el instanceof HTMLElement && el.tagName !== "FIGURE" && el.tagName !== "TABLE" && !el.querySelector("table")) out.push([`b${el.tagName}.${el.className}`, el]);
  });
  return out;
}

function grow(box: HTMLElement): void {
  for (const [k, el] of parts(box)) ROOM.set(k, Math.max(ROOM.get(k) ?? 0, el.getBoundingClientRect().height));
}

function apply(box: HTMLElement): void {
  for (const [k, el] of parts(box)) {
    const h = ROOM.get(k);
    if (!h) continue;
    // A row's height is its least; a caption and a block take a least height.
    if (el.tagName === "TR") el.style.height = `${h}px`;
    else el.style.minHeight = `${h}px`;
  }
}

/** Run `fn` when the page is idle (within a second in any case), or soon where idle callbacks are missing. */
function whenIdle(fn: (idle?: IdleDeadline) => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 1000 });
  else setTimeout(fn, 0);
}

/** A hidden copy of the box, beside it, to draw the column in at other times. */
function probeOf(box: HTMLElement): HTMLElement {
  const p = box.cloneNode(false) as HTMLElement;
  p.removeAttribute("id");
  p.removeAttribute("aria-live");
  p.setAttribute("aria-hidden", "true");
  p.inert = true;
  Object.assign(p.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none", width: getComputedStyle(box).width });
  box.parentElement?.append(p);
  return p;
}

/** Draw the column at a few times at once and keep the tallest of each part. */
function quickRoom(box: HTMLElement, render: () => string, times: (number | null)[]): void {
  const p = probeOf(box);
  const at = AT;
  try {
    for (const t of times) {
      setAt(t);
      p.innerHTML = render();
      grow(p);
    }
  } finally {
    setAt(at);
    p.remove();
  }
}

/** Draw the column at each time in a hidden copy of the box and keep the tallest of each part, a few milliseconds at a
 * time so the page stays responsive; a newer survey ends this one. */
function surveyRoom(box: HTMLElement, key: string, render: () => string, times: (number | null)[]): void {
  probe?.remove();
  const p = probeOf(box);
  probe = p;
  let i = 0;
  const slice = (idle?: IdleDeadline) => {
    if (probe !== p || held !== key || !box.isConnected) return p.remove();
    const at = AT;
    const end = performance.now() + Math.min(8, idle?.timeRemaining() ?? 8);
    try {
      while (i < times.length && (performance.now() < end || i === 0)) {
        setAt(times[i++]);
        p.innerHTML = render();
        grow(p);
      }
    } finally {
      setAt(at);
    }
    apply(box);
    if (i < times.length) whenIdle(slice);
    else {
      p.remove();
      probe = null;
    }
  };
  slice();
}

/** After each draw of the column: hold its parts at their room. `key` names what it shows (a new one starts the room
 * afresh); `changed` says the data changed, so the times are drawn again. */
export function holdRoom(box: HTMLElement, key: string, changed: boolean, render: () => string, times: () => (number | null)[]): void {
  const fresh = key !== held;
  if (fresh) {
    ROOM.clear();
    held = key;
    probe?.remove(); // the survey of what it showed before ends
    probe = null;
    grow(box);
    quickRoom(box, render, times().slice(0, QUICK));
  }
  apply(box);
  // The draw as it stands raises the hold if it is taller still: measured once a frame, not at every step of a drag.
  if (!check) {
    check = window.requestAnimationFrame(() => {
      check = 0;
      grow(box);
      apply(box);
    });
  }
  // The survey waits for the column to settle (data arrives in several parts at load) and then for idle time.
  if (fresh || changed) {
    window.clearTimeout(survey);
    survey = window.setTimeout(() => whenIdle(() => {
      if (held === key && box.isConnected) surveyRoom(box, key, render, times());
    }), 400);
  }
}
