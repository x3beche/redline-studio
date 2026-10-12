import { t } from '../i18n';

/** The Model tab of the viewer's side panel (Tree / Clip / Motion / Studio /
 *  Model): the open model as a whole - its build, its facts, the project's
 *  releases, its technical drawing.
 *
 *  What is on it is the editor's (editor.html, <app-model-health>,
 *  model-health.ts): an Angular component with the editor's data and its
 *  actions, moved in here as it is (adopt), the way the editor docks its
 *  other parts into the viewer. This keeps the tab itself: its button in
 *  the tab row, showing and hiding, and being the one on show over a
 *  reload. Built like the Motion tab (motions.ts). */

/** Whether the Model tab was the one on show, kept over a reload. */
const KEPT = 'redline.viewer.modelTab';

export class ModelTab {
  private tab: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  /** What the editor put on the tab (model-health.ts). */
  private content: HTMLElement | null = null;
  private open = false;
  /** Called when this tab opens: the Motion tab closes. */
  onOpen: () => void = () => {};
  /** Called after each model load: the editor reads what the model says
   *  about itself (its parts, motions, size). */
  onLoaded: () => void = () => {};

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
    if (this.content) el.appendChild(this.content);
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

  /** The editor's content for the tab, moved in (and again into a new
   *  panel, should the viewer's side panel be made anew). */
  adopt(content: HTMLElement | null | undefined) {
    if (!content) return;
    this.content = content;
    if (this.panel && content.parentElement !== this.panel) this.panel.appendChild(content);
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
    this.onLoaded();
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
  }
}
