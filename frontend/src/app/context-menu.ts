import { t } from './i18n';
import { ICONS, svg } from './rooms/files-model';

/** The application's one right-click menu.
 *
 *  Any list opens it from its (contextmenu) handler with what can be done
 *  to the thing under the pointer:
 *
 *    ContextMenu.open(e, [
 *      { label: 'Open', icon: 'open', kbd: 'Enter', run: () => this.open(x) },
 *      can && { label: 'Rename', icon: 'edit', kbd: 'F2', run: () => this.rename(x) },
 *      { sep: true },
 *      can && { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.remove(x) },
 *    ]);
 *
 *  Labels are English and translated here (a text with a name in it, made
 *  already, comes through as it is). Icons are the Files icon names
 *  (files-model.ts ICONS) or a 24-unit path's data. Falsy entries are dropped and separators that
 *  would lead, trail or double up are left out, so a list can be written
 *  with its permission checks inline.
 *
 *  The menu sits under <body> at the pointer and stays inside the window;
 *  from a click on a button it hangs under the button. The first item has
 *  the focus: arrows, Home and End move, Enter or Space runs, Escape and Tab
 *  close, and a key shown on an item (Del, F2) runs that item. It closes on
 *  a press anywhere else, a scroll, a resize or the window losing focus.
 *  On a focused element the keyboard's Menu key and Shift+F10 open the same
 *  menu its right-click would. */
export interface MenuAction {
  label: string;
  /** A Files icon name (files-model.ts ICONS) or a 24-unit path's data. */
  icon?: string;
  /** The key shown at the right - and, while the menu is open, the key that runs it. */
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}
export interface MenuSep { sep: true }
export type MenuEntry = MenuAction | MenuSep;

type Where = MouseEvent | KeyboardEvent | { x: number; y: number };

const KEYS: Record<string, string> = { Del: 'Delete', Esc: 'Escape' };
let el: HTMLDivElement | null = null;
let back: HTMLElement | null = null;
let shownAt = 0;
let shownOn: EventTarget | null = null;

/** An ICONS name, or a 24-unit path's data ('M4 6h16 …') - the Chat's drawings. */
function icon(name: string): string {
  if (ICONS[name] || !/^[Mm][\d\s.,-]/.test(name)) return svg(name);
  const d = name.replace(/[^MmLlHhVvCcSsQqTtAaZz\d\s.,-]/g, '');
  return svg('file').replace(/(<svg[^>]*>).*<\/svg>$/, `$1<path d="${d}"/></svg>`);
}

function clean(list: (MenuEntry | null | undefined | false | 0 | '')[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const it of list) {
    if (!it) continue;
    if ('sep' in it) { if (out.length && !('sep' in out[out.length - 1])) out.push(it); continue; }
    out.push(it);
  }
  while (out.length && 'sep' in out[out.length - 1]) out.pop();
  return out;
}

function buttons(): HTMLButtonElement[] {
  return el ? [...el.querySelectorAll<HTMLButtonElement>('button:not([disabled])')] : [];
}

function onKey(e: KeyboardEvent) {
  if (!el) return;
  const list = buttons();
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  const go = (i: number) => list.length && list[(i + list.length) % list.length].focus();
  let handled = true;
  switch (e.key) {
    case 'Escape': ContextMenu.close(true); break;
    case 'Tab': ContextMenu.close(true); break;
    case 'ArrowDown': go(at + 1); break;
    case 'ArrowUp': go(at < 0 ? -1 : at - 1); break;
    case 'Home': go(0); break;
    case 'End': go(-1); break;
    case 'Enter': case ' ': if (at >= 0) list[at].click(); break;
    default: {
      const hit = list.find(b => b.dataset['key'] && (b.dataset['key'] === e.key || b.dataset['key'].toLowerCase() === e.key.toLowerCase()));
      if (hit) hit.click();
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        // a letter: the next item starting with it
        const k = e.key.toLowerCase();
        const n = list.length;
        for (let j = 1; j <= n; j++) {
          const b = list[(at + j) % n];
          if (b.textContent?.trim().toLowerCase().startsWith(k)) { b.focus(); break; }
        }
      } else handled = false;
    }
  }
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
}
function onDown(e: Event) { if (el && !el.contains(e.target as Node)) ContextMenu.close(); }
function onScroll(e: Event) { if (el && !el.contains(e.target as Node)) ContextMenu.close(); }
function onAway() { ContextMenu.close(); }

function listen(on: boolean) {
  const f = (on ? window.addEventListener : window.removeEventListener).bind(window);
  f('keydown', onKey as EventListener, true);
  f('pointerdown', onDown, true);
  f('scroll', onScroll, true);
  f('resize', onAway);
  f('blur', onAway);
}

function injectStyle() {
  if (document.getElementById('wb-cmenu-style')) return;
  const s = document.createElement('style');
  s.id = 'wb-cmenu-style';
  s.textContent = `
.wb-cmenu .tcv-fm-menu-item:focus { outline: none; background: var(--hover); }
.wb-cmenu .tcv-fm-menu-item[disabled] { opacity: .45; cursor: default; background: none; }
.wb-cmenu .tcv-fm-menu-item > .tcv-fm-i { display: inline-flex; width: 16px; height: 16px; color: var(--ink-dim); }
.wb-cmenu .tcv-fm-menu-item[data-danger] > .tcv-fm-i { color: var(--danger); }
.wb-cmenu .tcv-fm-menu-item > .tcv-fm-i svg { width: 16px; height: 16px; }
`;
  document.head.appendChild(s);
}

export class ContextMenu {
  /** Opens the menu for a right-click (or a click on a "more" button, or a key). Nothing opens when no item is left. */
  static open(e: Where, items: (MenuEntry | null | undefined | false | 0 | '')[]): void {
    if ('preventDefault' in e) { e.preventDefault(); e.stopPropagation(); }
    // The browser's own contextmenu right after the one this file sent for Shift+F10 / the Menu key: already open.
    if ('isTrusted' in e && e.isTrusted && el && performance.now() - shownAt < 300 && e.target === shownOn) return;
    const list = clean(items);
    ContextMenu.close();
    if (!list.length) return;
    injectStyle();
    back = document.activeElement as HTMLElement | null;

    const m = document.createElement('div');
    m.className = 'tcv-fm-menu tcv-pop-in wb-cmenu';   // opens and closes as every pop does (styles.css, Motion)
    m.setAttribute('role', 'menu');
    m.style.left = '0px'; m.style.top = '0px'; m.style.visibility = 'hidden';
    m.addEventListener('contextmenu', ev => ev.preventDefault());
    for (const it of list) {
      if ('sep' in it) {
        const s = document.createElement('div');
        s.className = 'tcv-fm-menu-sep'; s.setAttribute('role', 'separator');
        m.appendChild(s);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tcv-fm-menu-item';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      if (it.danger) b.dataset['danger'] = '1';
      if (it.disabled) b.disabled = true;
      if (it.kbd) b.dataset['key'] = KEYS[it.kbd] ?? it.kbd;
      if (it.icon) {
        const i = document.createElement('i');
        i.className = 'tcv-fm-i'; i.setAttribute('aria-hidden', 'true');
        i.innerHTML = icon(it.icon);   // our own markup: ICONS, or a path the caller drew
        b.appendChild(i);
      }
      const span = document.createElement('span');
      span.textContent = t(it.label);
      b.appendChild(span);
      if (it.kbd) { const k = document.createElement('kbd'); k.textContent = it.kbd; b.appendChild(k); }
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        if (it.disabled) return;
        ContextMenu.close(true);
        it.run();
      });
      b.addEventListener('pointermove', () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    el = m;

    // where: at the pointer, under a clicked button, or at the focused element for a key
    const w = m.offsetWidth, h = m.offsetHeight, pad = 4;
    let x: number, y: number, under = false;
    const tgt = ('currentTarget' in e && e.currentTarget instanceof Element ? e.currentTarget
               : 'target' in e && e.target instanceof Element ? e.target : null);
    const ev = 'type' in e ? e : null;
    const fromKey = !!ev && (ev.type === 'keydown' || ((ev as MouseEvent).clientX === 0 && (ev as MouseEvent).clientY === 0));
    if (ev?.type === 'click' && tgt) {
      const r = tgt.getBoundingClientRect();
      x = r.right - w; y = r.bottom + 4; under = true;
    } else if (fromKey && tgt) {
      const r = tgt.getBoundingClientRect();
      x = r.left + Math.min(16, r.width / 2); y = r.top + Math.min(r.height, 28);
    } else if (ev && 'clientX' in ev) { x = ev.clientX; y = ev.clientY; }
    else { x = (e as { x: number }).x; y = (e as { y: number }).y; }
    let ox = 'left', oy = 'top';
    if (!under && x + w > innerWidth - pad) { x = x - w; ox = 'right'; }
    if (y + h > innerHeight - pad) { y = under ? y - h - 8 - ((tgt as Element)?.getBoundingClientRect().height ?? 0) : y - h; oy = 'bottom'; }
    if (under) ox = 'right';
    x = Math.max(pad, Math.min(x, innerWidth - w - pad));
    y = Math.max(pad, Math.min(y, innerHeight - h - pad));
    m.style.left = x + 'px'; m.style.top = y + 'px';
    m.style.setProperty('--tcv-origin', `${oy} ${ox}`);
    m.style.visibility = '';
    shownAt = performance.now();
    shownOn = 'target' in e ? e.target : null;
    listen(true);
    buttons()[0]?.focus({ preventScroll: true });
  }

  /** Takes the menu away; `refocus` puts the focus back where it was before it opened. */
  static close(refocus = false): void {
    if (!el) return;
    const m = el, had = m.contains(document.activeElement);
    el = null;
    // out the way every pop goes: 90 ms as a picture that takes no clicks, then gone
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) m.remove();
    else {
      m.classList.add('tcv-leave');
      if (!m.getAnimations?.().length) m.remove();
      else { m.addEventListener('animationend', () => m.remove(), { once: true }); setTimeout(() => m.remove(), 200); }
    }
    listen(false);
    if ((refocus || had) && back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }

  static isOpen(): boolean { return !!el; }
}

// The keyboard's Menu key and Shift+F10 open the focused element's right-click menu.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', e => {
    if (el || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const f = document.activeElement as HTMLElement | null;
    if (!f || f === document.body || /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) || f.isContentEditable) return;
    e.preventDefault();
    const r = f.getBoundingClientRect();
    f.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.left + Math.min(16, r.width / 2)), clientY: Math.round(r.top + Math.min(r.height, 28)),
    }));
  });
}
