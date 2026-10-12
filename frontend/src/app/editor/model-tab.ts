import { t } from '../i18n';

/** The Model tab of the viewer's side panel (Tree / Clip / Motion / Studio /
 *  Model): what is done with the model as a whole, moved out of the
 *  crowded toolbar - release the project, the technical drawing. A row
 *  each, icon, name and a line saying what it does.
 *
 *  The rows do not repeat the actions. Release and drawing stay the
 *  editor's own buttons (editor.html, with their permissions and disabled
 *  states), kept out of sight; a row presses its button and follows its
 *  state. Built like the Motion tab (motions.ts). */

/** Whether the Model tab was the one on show, kept over a reload. */
const KEPT = 'redline.viewer.modelTab';

interface Row {
  key: 'release' | 'drawing';
  icon: string;
  name: string;
  line: string;
}

const ROWS: Row[] = [
  { key: 'release', icon: 'tcv-ico tcv-ico-release', name: 'Release',
    line: 'Pack the project for manufacturing' },
  { key: 'drawing', icon: 'tcv-ico tcv-ico-drawing', name: 'Technical drawing',
    line: 'Dimensioned views, as PDF' },
];

export class ModelTab {
  private tab: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  /** The editor's own buttons the rows press. */
  private sources: Partial<Record<Row['key'], HTMLInputElement>> = {};
  private watch: MutationObserver | null = null;
  private open = false;
  /** Called when this tab opens: the Motion tab closes. */
  onOpen: () => void = () => {};

  constructor(private root: HTMLElement, private viewer: () => any) {}

  /** The tab and its panel, once: the viewer's side panel outlives every
   *  model load. */
  ensure() {
    const side = this.root.querySelector('.tcv_cad_tree');
    const nav = side?.querySelector('.tcv_tabnav');
    const box = side?.querySelector('.tcv_box_content');
    if (!side || !nav || !box || (this.tab && this.tab.isConnected)) return;

    const wrap = document.createElement('span');
    wrap.className = 'tcv_tooltip tcv-model-tabwrap';
    wrap.style.flex = '1';
    const tab = document.createElement('input');
    tab.type = 'button';
    tab.className = 'tcv_tab_model tcv_tab tcv_tab-right tcv_tab-unselected';
    tab.style.width = '100%';
    tab.setAttribute('aria-controls', 'tcv-model-panel');
    tab.addEventListener('click', () => { this.show(true); this.remember(); });
    wrap.appendChild(tab);
    nav.appendChild(wrap);
    nav.addEventListener('click', e => {
      const el = e.target as HTMLElement;
      if (el.classList?.contains('tcv_tab') && !el.classList.contains('tcv_tab_model') && this.open) {
        this.show(false);
        this.remember();
      }
    }, true);

    const el = document.createElement('div');
    el.className = 'tcv-model';
    el.id = 'tcv-model-panel';
    el.setAttribute('role', 'group');
    for (const r of ROWS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tcv-model-row';
      b.dataset['key'] = r.key;
      b.innerHTML = `<span class="tcv-model-ico ${r.icon}" aria-hidden="true"></span>` +
        '<span class="tcv-model-text"><span class="tcv-model-name"></span><span class="tcv-model-line"></span></span>' +
        '<span class="tcv-model-spin" aria-hidden="true"></span>';
      b.addEventListener('click', () => this.press(r.key));
      el.appendChild(b);
    }
    box.appendChild(el);
    this.tab = wrap;
    this.panel = el;

    // A switch of the viewer's own tab (a note's view, a model load going
    // back to Tree) closes this one, as it does the Motion tab.
    const v = this.viewer();
    const display = v?.display;
    if (display?.switchToTab && !display.__redlineModelTab) {
      display.__redlineModelTab = true;
      const switchToTab = display.switchToTab.bind(display);
      display.switchToTab = (newTab: string, oldTab?: string) => {
        switchToTab(newTab, oldTab);
        this.show(false);
      };
    }
    this.relabel();
  }

  /** The editor's buttons for release and drawing. Their own [disabled]
   *  is followed from here on. */
  adopt(els: { release?: HTMLElement | null; drawing?: HTMLElement | null }) {
    let changed = false;
    for (const k of ['release', 'drawing'] as const) {
      const input = els[k]?.querySelector<HTMLInputElement>('input') ?? null;
      if (input && this.sources[k] !== input) { this.sources[k] = input; changed = true; }
    }
    if (!changed) return;
    this.watch?.disconnect();
    this.watch = new MutationObserver(() => this.paint());
    for (const input of Object.values(this.sources)) {
      this.watch.observe(input!, { attributes: true, attributeFilter: ['disabled', 'data-busy'] });
    }
    this.paint();
  }

  private press(key: Row['key']) {
    const src = this.sources[key];
    if (src && !src.disabled) src.click();
  }

  /** The rows follow their buttons: disabled with them, and busy - a
   *  spinner and "Drawing…" - while their work runs (data-busy). */
  private paint() {
    this.panel?.querySelectorAll<HTMLButtonElement>('.tcv-model-row').forEach(b => {
      const r = ROWS.find(x => x.key === b.dataset['key'])!;
      const src = this.sources[r.key];
      const busy = !!src?.hasAttribute('data-busy');
      b.disabled = !src || src.disabled;
      b.toggleAttribute('aria-busy', busy);
      b.querySelector('.tcv-model-line')!.textContent = busy ? t('Drawing…') : t(r.line);
    });
  }

  /** Show the tab's panel, or go back to the viewer's own tab. As with
   *  Motion, the viewer stays on Tree underneath. */
  show(on: boolean) {
    const side = this.root.querySelector<HTMLElement>('.tcv_cad_tree');
    const tab = this.tab?.querySelector<HTMLInputElement>('input');
    if (on && (!this.panel || !tab)) return;
    if (on === this.open) return;
    const v = this.viewer();
    if (on) {
      this.onOpen();
      if (v?.state?.get?.('activeTab') !== 'tree') {
        try { v.setActiveTab('tree'); } catch { /* not rendered yet */ }
      }
    }
    this.open = on;
    if (side) side.dataset['model'] = on ? '1' : '0';
    tab?.classList.toggle('tcv_tab-selected', on);
    tab?.classList.toggle('tcv_tab-unselected', !on);
    tab?.setAttribute('aria-pressed', String(on));
    const active = v?.state?.get?.('activeTab');
    const own = active ? this.root.querySelector<HTMLElement>(`.tcv_tab_${active}`) : null;
    own?.classList.toggle('tcv_tab-selected', !on);
    own?.classList.toggle('tcv_tab-unselected', on);
  }

  /** After a model load (which puts the viewer back on Tree): open again
   *  if this was the tab on show. */
  restore() {
    this.ensure();
    let kept = false;
    try { kept = localStorage.getItem(KEPT) === '1'; } catch { /* private window */ }
    if (kept) this.show(true);
  }

  private remember() {
    try { localStorage.setItem(KEPT, this.open ? '1' : '0'); } catch { /* private window */ }
  }

  /** The words, in the language on now. */
  relabel() {
    const tab = this.tab?.querySelector<HTMLInputElement>('input');
    if (tab) tab.value = t('Model');
    this.panel?.setAttribute('aria-label', t('Model tools'));
    this.panel?.querySelectorAll<HTMLElement>('.tcv-model-row').forEach(b => {
      const r = ROWS.find(x => x.key === b.dataset['key'])!;
      b.querySelector('.tcv-model-name')!.textContent = t(r.name);
    });
    this.paint();
  }
}
