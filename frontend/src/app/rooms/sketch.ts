import type { Tool } from '../editor/editor';

/** The marks a person draws on a frozen picture, and how they are painted.
 *
 *  The same seven tools as the 3D room, painted the same way - a line
 *  drawn in one room has to look like a line drawn in the other. The 3D
 *  room keeps its own copy inside the editor; this is the one the other
 *  rooms draw with (rooms/sketchpad.ts).
 */
export type Pt = [number, number];

export type Mark =
  | { kind: 'pen'; color: string; width: number; pts: Pt[] }
  | { kind: Exclude<Tool, 'pen' | 'text'>; color: string; width: number; a: Pt; b: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string };

export const TOOLS: { id: Tool; glyph: string; label: string }[] = [
  { id: 'pen', glyph: '✎', label: 'freehand' },
  { id: 'line', glyph: '╱', label: 'line' },
  { id: 'arrow', glyph: '→', label: 'arrow' },
  { id: 'rect', glyph: '▭', label: 'rectangle' },
  { id: 'ellipse', glyph: '◯', label: 'ellipse' },
  { id: 'triangle', glyph: '△', label: 'triangle' },
  { id: 'text', glyph: 'T', label: 'text' },
];

/* theme:pigment - the same four inks as the 3D room. A mark's colour is
   printed into the picture, so it is pigment rather than chrome. */
export const PENS = ['#cc3333', '#5c8a5c', '#53a0e3', '#e8a735'];
export const FIRST_PEN = '#ff2d3f';          // theme:pigment

export function paint(ctx: CanvasRenderingContext2D, marks: Mark[],
                      scale: number) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const m of marks) {
    ctx.strokeStyle = m.color;
    ctx.fillStyle = m.color;
    if (m.kind === 'text') {
      ctx.font = `600 ${m.size}px 'IBM Plex Sans', sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(m.text, m.at[0], m.at[1]);
      continue;
    }
    ctx.lineWidth = m.width * scale;
    ctx.beginPath();
    if (m.kind === 'pen') {
      m.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    } else {
      const [ax, ay] = m.a, [bx, by] = m.b;
      if (m.kind === 'line') {
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      } else if (m.kind === 'rect') {
        ctx.rect(ax, ay, bx - ax, by - ay);
      } else if (m.kind === 'ellipse') {
        ctx.ellipse((ax + bx) / 2, (ay + by) / 2,
                    Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
      } else if (m.kind === 'triangle') {
        ctx.moveTo((ax + bx) / 2, ay);
        ctx.lineTo(bx, by); ctx.lineTo(ax, by); ctx.closePath();
      } else if (m.kind === 'arrow') {
        const head = Math.max(10, m.width * scale * 3);
        const ang = Math.atan2(by - ay, bx - ax);
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - head * Math.cos(ang - 0.4), by - head * Math.sin(ang - 0.4));
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - head * Math.cos(ang + 0.4), by - head * Math.sin(ang + 0.4));
      }
    }
    ctx.stroke();
  }
}
