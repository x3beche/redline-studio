import { t } from '../i18n';

/** The viewer's side panel (Tree / Clip / Motion / Studio / Model) in the
 *  app's own words and marks. The look is CSS (editor/viewer-panel.css);
 *  this adds what CSS cannot: tooltips, the "×6" of a repeated part as a
 *  count of its own, the name in a box of its own so a long one is cut
 *  with an ellipsis and not the count after it.
 *
 *  three-cad-viewer draws the tree lazily - a row is made when it scrolls
 *  into sight or its parent opens - so one observer on the panel decorates
 *  each row as it appears. It only ever reads and adds: the library's
 *  elements, classes and handlers are left as they are, and a row is
 *  marked once done so a repaint costs a selector. */

/** The tree's tool buttons, by the viewer's class: what each one does. */
const TOGGLES: Record<string, string> = {
  tcv_collapse_singles: 'Fold groups that hold a single part',
  tcv_expand_root: 'Open the top level only',
  tcv_collapse_all: 'Collapse all',
  tcv_expand: 'Expand all',
  tcv_clip_reset: 'Reset the clip planes',
  tcv_material_reset: 'Reset the material',
  tcv_zebra_reset: 'Reset the zebra stripes',
  tcv_mat_editor_toggle: 'Edit the selected part\'s material',
  tcv_studio_reset: 'Reset the studio',
};

/** The Clip tab's switches, by the viewer's class: a short name, what it does. */
const CLIP_CHECKS: [string, string, string][] = [
  ['tcv_clip_intersection', 'Intersection', 'Cut away only where all the planes overlap'],
  ['tcv_clip_plane_helpers', 'Planes', 'Show the clip planes'],
  ['tcv_clip_caps', 'Part colour', 'Fill the cut faces in each part\'s own colour, not the plane\'s'],
];

/** "Screw M2 ×6": the part's name and how many of it the model holds. */
const COUNT = /^(.*\S)\s*[×x](\d+)$/;

export class TreePanel {
  private obs: MutationObserver | null = null;
  private queued = false;

  constructor(private root: HTMLElement) {
    this.ensure();
  }

  /** Watch the panel, once; called again after each load in case the
   *  viewer built its panel anew. */
  ensure() {
    const side = this.root.querySelector<HTMLElement>('.tcv_cad_tree');
    if (!side || side.dataset['tv'] === '1') { this.decorate(); return; }
    side.dataset['tv'] = '1';
    this.obs?.disconnect();
    this.obs = new MutationObserver(() => this.schedule());
    this.obs.observe(side, { childList: true, subtree: true });
    this.relabel();
  }

  /** Rows come in bursts (an Expand all makes dozens): one pass a frame. */
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.decorate(); });
  }

  private decorate() {
    const side = this.root.querySelector<HTMLElement>('.tcv_cad_tree');
    if (!side) return;
    for (const label of side.querySelectorAll<HTMLElement>('.tv-node-label:not([data-tv])')) this.row(label);
  }

  /** One row: the name boxed, its count and colour swatch named. */
  private row(label: HTMLElement) {
    label.dataset['tv'] = '1';
    const text = label.firstChild;
    if (text?.nodeType === Node.TEXT_NODE) {
      const whole = (text.textContent ?? '').trim();
      const m = COUNT.exec(whole);
      const name = document.createElement('span');
      name.className = 'tcv-tv-name';
      name.textContent = m ? m[1] : whole;
      name.title = whole;
      label.replaceChild(name, text);
      if (m) {
        const n = document.createElement('span');
        n.className = 'tcv-tv-count';
        n.dataset['n'] = m[2];
        n.textContent = '×' + m[2];
        name.after(n);
      }
    }
    // The viewer marks a part with its colour in the view (a "⚈" in it).
    const dot = label.querySelector<HTMLElement>('span[style]');
    if (dot) dot.classList.add('tcv-tv-swatch');
    const content = label.parentElement;
    if (!content) return;
    content.querySelector('.tv-icon0')?.classList.add('tcv-tv-eye');
    content.querySelector('.tv-icon1')?.classList.add('tcv-tv-edges');
    this.titles(content);
  }

  private titles(content: HTMLElement) {
    content.querySelector('.tv-icon0')?.setAttribute('title', t('Show or hide'));
    content.querySelector('.tv-icon1')?.setAttribute('title', t('Edges on or off'));
    content.querySelector('.tcv-tv-swatch')?.setAttribute('title', t('Its colour in the view'));
    const n = content.querySelector<HTMLElement>('.tcv-tv-count');
    if (n) n.title = t('{n} of this part in the model').replace('{n}', n.dataset['n'] ?? '');
    const nav = content.querySelector<HTMLElement>('.tv-nav-marker');
    if (nav?.textContent) nav.title = t('Open or close');
  }

  /** The words, in the language on now: the tool buttons' tooltips move
   *  from the viewer's own (a pseudo-element the panel's edge cuts off) to
   *  a title, with a name for screen readers. */
  relabel() {
    for (const [cls, text] of Object.entries(TOGGLES)) {
      const b = this.root.querySelector<HTMLInputElement>(`.tcv_cad_tree .${cls}`);
      if (!b) continue;
      b.parentElement?.removeAttribute('data-tooltip');
      b.title = t(text);
      b.setAttribute('aria-label', t(text));
    }
    for (const c of this.root.querySelectorAll<HTMLElement>('.tcv_cad_tree .tv-node-content')) this.titles(c);
    // The Clip and Studio tabs' checkboxes are the app's checkbox.
    for (const c of this.root.querySelectorAll<HTMLInputElement>('.tcv_cad_tree input.tcv_check[type="checkbox"]')) c.classList.add('tcv-check');
    // The Clip tab's three switches, named short enough to share one line.
    for (const [cls, name, tip] of CLIP_CHECKS) {
      const box = this.root.querySelector<HTMLInputElement>(`.tcv_cad_tree .${cls}`);
      const wrap = box?.parentElement;
      const label = wrap?.querySelector('.tcv_label');
      if (!wrap || !label) continue;
      wrap.removeAttribute('data-tooltip');
      wrap.title = t(tip);
      label.textContent = t(name);
    }
  }
}
