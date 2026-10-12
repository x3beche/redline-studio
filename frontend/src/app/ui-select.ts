import { Component, ElementRef, HostListener, computed, input, output, signal, viewChild } from '@angular/core';
import { T } from './i18n';

/** One choice: what it stands for and what it says; `hint` is a count or
 *  short note on its right, `note` a small line under it, and `group` a
 *  heading drawn above the first choice of each run with the same group
 *  (an <optgroup>). */
export interface SelectOption { value: string; label: string; hint?: string | number; note?: string; group?: string }

const PLAIN = new WeakMap<readonly string[], SelectOption[]>();
/** A list of strings as choices that say themselves; the same array gives the same choices. */
export function plainOptions(list: readonly string[]): SelectOption[] {
  let o = PLAIN.get(list);
  if (!o) PLAIN.set(list, o = list.map(v => ({ value: v, label: v })));
  return o;
}

/** The application's own drop-down, in place of the browser's <select>: the
 *  closed box looks like the inputs beside it, and the list is the app's
 *  menu (the Files tab's right-click menu: same surface, line and hover),
 *  with a filter once there are more than a few choices. Arrows move, Enter
 *  picks, Escape closes; typing in the filter narrows the list.
 *
 *    <wb-select [options]="opts" [value]="cat()" (pick)="cat.set($event)" label="Category" />
 *
 *  Inputs: `label` (aria name, translated), `placeholder` (shown when no
 *  choice has the value), `disabled`, `tip` (the box's tooltip; the chosen
 *  label otherwise), `size` 'md' (28px, the default) | 'sm' (24px) | 'xs'
 *  (20px). `(opened)` fires as the list opens (to load choices lazily).
 *  The box is as wide as its longest choice, like the browser's; a width
 *  or flex set on <wb-select> wins. To match the fields beside it, set on
 *  <wb-select> (or any parent): --wb-sel-h (height), --wb-sel-fs (font
 *  size), --wb-sel-font (font family), --wb-sel-bg (background),
 *  --wb-sel-pad (inline padding), --wb-sel-radius.
 */
@Component({
  selector: 'wb-select',
  imports: [T],
  host: { class: 'wb-select', '[attr.data-size]': 'size()', '[attr.data-off]': 'disabled() ? 1 : null' },
  styles: [`
    :host { display: inline-flex; min-width: 0; position: relative; vertical-align: middle; }
    .wb-sel-box { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 100%; box-sizing: border-box;
      min-height: var(--wb-sel-h, 28px); padding: 0 var(--wb-sel-pad, 8px); font: inherit; font-family: var(--wb-sel-font, inherit);
      font-size: var(--wb-sel-fs, 12.5px); color: var(--ink); background: var(--wb-sel-bg, var(--surface-2));
      border: 1px solid var(--line); border-radius: var(--wb-sel-radius, 5px); cursor: pointer; text-align: left; }
    :host([data-size="sm"]) .wb-sel-box { min-height: var(--wb-sel-h, 24px); font-size: var(--wb-sel-fs, 12px); padding: 0 var(--wb-sel-pad, 6px); gap: 4px; }
    :host([data-size="xs"]) .wb-sel-box { min-height: var(--wb-sel-h, 20px); font-size: var(--wb-sel-fs, 11px); padding: 0 var(--wb-sel-pad, 5px); gap: 3px; border-radius: var(--wb-sel-radius, 4px); }
    :host([data-size="xs"]) .wb-sel-box svg { width: 10px; height: 10px; }
    .wb-sel-box:not(:disabled):hover { border-color: var(--ink-dim); }
    .wb-sel-box:focus-visible, .wb-sel-box[aria-expanded="true"] { outline: none; border-color: var(--accent); }
    .wb-sel-box:disabled { cursor: default; opacity: .6; }
    .wb-sel-box[data-set] .wb-sel-text { color: var(--ink); }
    .wb-sel-text { flex: 1; min-width: 0; display: grid; overflow: hidden; color: var(--ink-dim); }
    .wb-sel-text > span { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wb-sel-text > .wb-sel-ghost { visibility: hidden; height: 0; }
    .wb-sel-box svg { flex: none; width: 12px; height: 12px; fill: none; stroke: var(--ink-dim); stroke-width: 2;
      stroke-linecap: round; stroke-linejoin: round; transition: transform .12s; }
    .wb-sel-box[aria-expanded="true"] svg { transform: rotate(180deg); }
    @media (max-width: 768px) { .wb-sel-box, :host([data-size]) .wb-sel-box { min-height: 40px; } }
    .wb-sel-pop { position: fixed; z-index: 700; display: flex; flex-direction: column; padding: 4px; box-sizing: border-box;
      background: var(--surface); border: 1px solid var(--line); border-radius: 7px; box-shadow: 0 8px 24px var(--shadow-soft); }
    .wb-sel-find { margin: 0 0 4px; padding: 6px 8px; font: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface-2);
      border: 1px solid var(--line); border-radius: 5px; outline: none; }
    .wb-sel-find:focus { border-color: var(--accent); }
    .wb-sel-list { overflow-y: auto; min-height: 0; }
    .wb-sel-opt { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 30px; padding: 0 10px; box-sizing: border-box;
      font: inherit; font-size: 12.5px; color: var(--ink); background: none; border: 0; border-radius: 5px; cursor: pointer; text-align: left; }
    .wb-sel-opt[data-hot] { background: var(--hover); }
    .wb-sel-opt[aria-selected="true"] { color: var(--accent); }
    .wb-sel-opt span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wb-sel-opt em { flex: none; font-style: normal; font-size: 11px; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
    .wb-sel-opt i { flex: none; width: 12px; font-style: normal; color: var(--accent); }
    .wb-sel-opt[data-note] { min-height: 38px; padding-top: 4px; padding-bottom: 4px; }
    .wb-sel-opt span small { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--ink-dim); }
    .wb-sel-group { padding: 8px 10px 3px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wb-sel-group:not(:first-child) { margin-top: 3px; border-top: 1px solid var(--line); }
    @media (max-width: 768px) { .wb-sel-opt { min-height: 40px; } }
    .wb-sel-none { padding: 8px 10px; font-size: 12px; color: var(--ink-dim); }
  `],
  template: `
<button #box type="button" class="wb-sel-box" [attr.aria-expanded]="open()" aria-haspopup="listbox" [attr.aria-label]="label() | t"
        [disabled]="disabled()" [attr.data-set]="value() ? 1 : null" [title]="tip() || (current()?.label ?? '')"
        (click)="toggle()" (keydown)="boxKey($event)">
  <span class="wb-sel-text"><span>{{ current()?.label ?? (placeholder() | t) }}</span><span class="wb-sel-ghost" aria-hidden="true">{{ placeholder() | t }}</span>@for (g of ghosts(); track $index) {<span class="wb-sel-ghost" aria-hidden="true">{{ g }}</span>}</span>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
</button>
@if (open()) {
  <div #pop class="wb-sel-pop" animate.leave="tcv-leave" [style.--tcv-origin]="at().up ? 'bottom left' : 'top left'" role="listbox" [attr.aria-label]="label() | t" [style.left.px]="at().x" [style.top.px]="at().y"
       [style.width.px]="at().w" [style.max-height.px]="at().h" (click)="$event.stopPropagation()">
    @if (searchable()) {
      <input #find class="wb-sel-find" type="search" [placeholder]="'Filter' | t" [value]="q()" (input)="q.set($any($event.target).value); hot.set(0)"
             (keydown)="listKey($event)" [attr.aria-label]="'Filter' | t">
    }
    <div class="wb-sel-list" #list>
      @for (o of shown(); track o.value; let i = $index) {
        @if (o.group && o.group !== shown()[i - 1]?.group) { <div class="wb-sel-group" role="presentation">{{ o.group }}</div> }
        <button type="button" class="wb-sel-opt" role="option" [attr.aria-selected]="o.value === value()" [attr.data-hot]="i === hot() ? 1 : null"
                [attr.data-i]="i" [attr.data-note]="o.note ? 1 : null" (mouseenter)="hot.set(i)" (click)="choose(o)">
          <i>{{ o.value === value() ? '✓' : '' }}</i><span>{{ o.label }}@if (o.note) {<small>{{ o.note }}</small>}</span>@if (o.hint != null && o.hint !== '') { <em>{{ o.hint }}</em> }
        </button>
      } @empty { <div class="wb-sel-none">{{ 'Nothing matches' | t }}</div> }
    </div>
  </div>
}`,
})
export class UiSelect {
  options = input<SelectOption[]>([]);
  value = input<string>('');
  /** Its name, for screen readers and the filter. */
  label = input<string>('');
  /** What the box says when nothing in the list is the value. */
  placeholder = input<string>('Choose');
  disabled = input(false);
  /** The box's tooltip; the chosen label when empty. */
  tip = input<string>('');
  size = input<'md' | 'sm' | 'xs'>('md');
  pick = output<string>();
  /** The list has just opened. */
  opened = output<void>();

  open = signal(false);
  q = signal('');
  hot = signal(0);
  at = signal({ x: 0, y: 0, w: 200, h: 300, up: false });
  private box = viewChild.required<ElementRef<HTMLButtonElement>>('box');
  private find = viewChild<ElementRef<HTMLInputElement>>('find');
  private list = viewChild<ElementRef<HTMLDivElement>>('list');
  private pop = viewChild<ElementRef<HTMLDivElement>>('pop');
  private host = new ElementRef<HTMLElement>(null as unknown as HTMLElement);

  current = computed(() => this.options().find(o => o.value === this.value()));
  searchable = computed(() => this.options().length > 8);
  /** Every label, unseen, so the box is as wide as the longest (a long list is left to its CSS width). */
  ghosts = computed(() => {
    const o = this.options();
    return o.length > 60 ? [] : o.map(x => x.label);
  });
  shown = computed(() => {
    const q = this.q().trim().toLocaleLowerCase();
    return q ? this.options().filter(o => (o.label + ' ' + (o.group ?? '') + ' ' + (o.note ?? '')).toLocaleLowerCase().includes(q)) : this.options();
  });

  constructor(el: ElementRef<HTMLElement>) { this.host = el; }

  toggle() { if (this.open()) this.close(); else this.show(); }

  show() {
    if (this.disabled()) return;
    this.opened.emit();
    this.place();
    this.q.set('');
    this.hot.set(Math.max(0, this.options().findIndex(o => o.value === this.value())));
    this.open.set(true);
    setTimeout(() => {
      // Under <body>: a room with container queries or a transform would
      // otherwise hold the fixed list inside itself and clip it.
      const el = this.pop()?.nativeElement;
      if (el && el.parentElement !== document.body) document.body.appendChild(el);
      this.find()?.nativeElement.focus(); this.scrollHot();
    });
    // The box may move while the list is open (the bar reflows as results
    // arrive): the list follows it.
    const follow = () => { if (!this.open()) return; this.place(); this.raf = requestAnimationFrame(follow); };
    this.raf = requestAnimationFrame(follow);
  }

  private raf = 0;
  private place() {
    const r = this.box().nativeElement.getBoundingClientRect();
    const w = Math.max(r.width, 200);
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const h = Math.min(340, Math.max(below, above));
    const y = below >= Math.min(220, h) ? r.bottom + 4 : Math.max(8, r.top - 4 - h);
    const next = { x: Math.max(8, Math.min(r.left, innerWidth - w - 8)), y, w, h, up: y < r.top };
    const a = this.at();
    if (a.x !== next.x || a.y !== next.y || a.w !== next.w || a.h !== next.h) this.at.set(next);
  }

  close(focus = false) {
    this.open.set(false);
    cancelAnimationFrame(this.raf);
    if (focus) this.box().nativeElement.focus();
  }

  choose(o: SelectOption) {
    this.close(true);
    if (o.value !== this.value()) this.pick.emit(o.value);
  }

  boxKey(e: KeyboardEvent) {
    // Keys it uses stop here: a room's own shortcuts on the document (arrows
    // through files or palettes, Escape closing a dialog) are not for it.
    if (!this.open() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); this.show(); return; }
    if (this.open()) this.listKey(e);
  }

  listKey(e: KeyboardEvent) {
    const n = this.shown().length;
    if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); this.hot.set(n ? (this.hot() + 1) % n : 0); this.scrollHot(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.hot.set(n ? (this.hot() - 1 + n) % n : 0); this.scrollHot(); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = this.shown()[this.hot()]; if (o) this.choose(o); }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } this.close(e.key === 'Escape'); }
  }

  private scrollHot() {
    const el = this.list()?.nativeElement.querySelector(`[data-i="${this.hot()}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }

  @HostListener('document:mousedown', ['$event'])
  outside(e: MouseEvent) {
    const t = e.target as Node;
    if (this.open() && !this.host.nativeElement.contains(t) && !this.pop()?.nativeElement.contains(t)) this.close();
  }

  @HostListener('window:resize')
  @HostListener('document:scroll', ['$event'])
  moved(e?: Event) {
    // The list's own scrolling is not the page moving.
    if (this.open() && !(e?.target instanceof Node && this.pop()?.nativeElement.contains(e.target))) this.close();
  }
}
