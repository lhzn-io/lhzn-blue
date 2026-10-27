/** Room held in the status column as the time bar moves: each table's caption and rows, and each block beside them, at
 * the tallest they reach anywhere in the time bar's reach, so dragging the time never moves the page below. The column
 * is drawn off screen at times across that reach whenever what it shows changes (the view, the station, the width, the
 * data); a live draw taller than all of them still raises the hold. */
import { AT, setAt } from "./cursor";

const ROOM = new Map<string, number>();
let held = "";
let survey = 0;
let check = 0;

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

/** Draw the column at each time in a hidden copy of the box and keep the tallest of each part. */
function surveyRoom(box: HTMLElement, render: () => string, times: (number | null)[]): void {
  const probe = box.cloneNode(false) as HTMLElement;
  probe.removeAttribute("id");
  probe.removeAttribute("aria-live");
  probe.setAttribute("aria-hidden", "true");
  probe.inert = true;
  Object.assign(probe.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none", width: getComputedStyle(box).width });
  box.parentElement?.append(probe);
  const at = AT;
  try {
    for (const t of times) {
      setAt(t);
      probe.innerHTML = render();
      grow(probe);
    }
  } finally {
    setAt(at);
    probe.remove();
  }
  apply(box);
}

/** After each draw of the column: hold its parts at their room. `key` names what it shows (a new one starts the room
 * afresh); `changed` says the data changed, so the times are drawn again. */
export function holdRoom(box: HTMLElement, key: string, changed: boolean, render: () => string, times: () => (number | null)[]): void {
  const fresh = key !== held;
  if (fresh) {
    ROOM.clear();
    held = key;
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
  if (fresh || changed) {
    window.clearTimeout(survey);
    survey = window.setTimeout(() => {
      if (held === key && box.isConnected) surveyRoom(box, render, times());
    }, 150);
  }
}
