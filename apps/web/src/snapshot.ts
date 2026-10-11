/**
 * One PNG of what a visitor collected: each plot, readout row or the map, painted from the page as it stands, with
 * a title per item and a credit footer. A small painter rather than a library: the plots are SVG with HTML labels,
 * so it draws each <svg> as an image, each <canvas> (the map) as is, coloured boxes (dots, bands, colour bars) and
 * every text node in its own computed font and colour. Controls (buttons for collect, info, expand) are left out.
 */

/** Elements not painted (and not descended into): controls, hover overlays, and the time rows (their lines are CSS
 * decorations; the map's title carries the time instead). */
const SKIP = ".fig-actions, .collect-btn, .fig-info, .band-info, .tip, .cursor-vals, .maplibregl-control-container, .timeline, .layers-drawer, .field-info, .map-actions, .sr-only";

export interface SnapItem {
  title: string;
  el: HTMLElement;
}

const WIDTH = 1200; // css px of the output
const PAD = 24;
const DPR = 2;

function isTransparent(c: string): boolean {
  return !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
}

function colourStops(bg: string): string[] {
  return bg.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g) ?? [];
}

async function svgImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.style.color = getComputedStyle(svg).color; // currentColor (wind arrows)
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Paint `root` with its top-left at (x, y), scaled by `k`. */
async function paint(ctx: CanvasRenderingContext2D, root: HTMLElement, x: number, y: number, k: number): Promise<void> {
  const base = root.getBoundingClientRect();
  const at = (r: DOMRect) => ({ x: x + (r.left - base.left) * k, y: y + (r.top - base.top) * k, w: r.width * k, h: r.height * k });
  const visit = async (el: Element): Promise<void> => {
    if (el !== root && el.matches(SKIP)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) {
      for (const c of el.children) await visit(c);
      return;
    }
    const p = at(r);
    if (el instanceof HTMLCanvasElement) {
      try {
        ctx.drawImage(el, p.x, p.y, p.w, p.h);
      } catch {
        /* a tainted or unreadable canvas: left blank */
      }
      return;
    }
    if (el instanceof SVGSVGElement) {
      const img = await svgImage(el, r.width, r.height);
      if (img) {
        ctx.globalAlpha = Number(cs.opacity) || 1;
        ctx.drawImage(img, p.x, p.y, p.w, p.h);
        ctx.globalAlpha = 1;
      }
      return;
    }
    // Boxes: background colour (dots, bars, bands) and simple linear gradients (colour bars).
    const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.height / 2) * k;
    if (!isTransparent(cs.backgroundColor) && el !== root) {
      ctx.globalAlpha = Number(cs.opacity) || 1;
      ctx.fillStyle = cs.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, radius);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (cs.backgroundImage.startsWith("linear-gradient")) {
      const stops = colourStops(cs.backgroundImage);
      if (stops.length > 1) {
        const g = ctx.createLinearGradient(p.x, 0, p.x + p.w, 0);
        stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
        ctx.fillStyle = g;
        ctx.fillRect(p.x, p.y, p.w, p.h);
      }
    }
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none" && !isTransparent(cs.borderTopColor) && r.width > 6 && r.height > 6) {
      ctx.strokeStyle = cs.borderTopColor;
      ctx.lineWidth = parseFloat(cs.borderTopWidth) * k;
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, radius);
      ctx.stroke();
    }
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) paintText(ctx, node as Text, cs, at, k);
      else if (node instanceof Element) await visit(node);
    }
  };
  await visit(root);
}

function paintText(ctx: CanvasRenderingContext2D, node: Text, cs: CSSStyleDeclaration, at: (r: DOMRect) => { x: number; y: number; w: number; h: number }, k: number): void {
  let text = node.data.replace(/\s+/g, " ");
  if (!text.trim()) return;
  if (cs.textTransform === "uppercase") text = text.toUpperCase();
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  if (!rects.length) return;
  const size = parseFloat(cs.fontSize) * k;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = "alphabetic";
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing === "normal" ? "0px" : `${parseFloat(cs.letterSpacing) * k}px`;
  const words = text.trim().split(" ");
  let w = 0;
  for (const r of rects) {
    const p = at(r);
    let line = "";
    while (w < words.length) {
      const next = line ? `${line} ${words[w]}` : words[w];
      if (line && ctx.measureText(next).width > p.w + 2 * k) break;
      line = next;
      w++;
    }
    ctx.fillText(line, p.x, p.y + p.h * 0.78);
    if (w >= words.length) break;
  }
}

/** The PNG: a header line, then each item with its title, then the credit. */
export async function snapshot(items: SnapItem[], header: string, credit: string): Promise<Blob> {
  const inner = WIDTH - 2 * PAD;
  const scaled = items.map((it) => {
    const r = it.el.getBoundingClientRect();
    const k = Math.min(1.6, inner / Math.max(1, r.width));
    return { ...it, k, h: r.height * k };
  });
  const titleH = 26;
  const height = PAD + 30 + scaled.reduce((s, it) => s + titleH + it.h + 18, 0) + 34;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * DPR;
  canvas.height = Math.ceil(height * DPR);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPR, DPR);
  const page = getComputedStyle(document.body);
  ctx.fillStyle = isTransparent(page.backgroundColor) ? "#ffffff" : page.backgroundColor;
  ctx.fillRect(0, 0, WIDTH, height);
  const ink = page.color;
  const sans = getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() || "sans-serif";
  ctx.fillStyle = ink;
  ctx.font = `600 15px ${sans}`;
  ctx.fillText(header, PAD, PAD + 14);
  let y = PAD + 30;
  for (const it of scaled) {
    ctx.fillStyle = ink;
    ctx.font = `600 13px ${sans}`;
    ctx.fillText(it.title, PAD, y + 16);
    y += titleH;
    await paint(ctx, it.el, PAD, y, it.k);
    y += it.h + 18;
  }
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.font = `12px ${sans}`;
  ctx.fillText(credit, PAD, height - 14);
  ctx.globalAlpha = 1;
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"));
}
