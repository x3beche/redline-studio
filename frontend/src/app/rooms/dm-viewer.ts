import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { navBoxFollows } from '../nav';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';
import { Markdown } from '../markdown';
import { moneyAlt, moneyIn, moneyTip } from '../money';
import { DM_ADD, DM_ICONS, DM_KIND_NAME, DmApi, DmKind, DmSnapshot, DmStore } from '../dm';
import { BarList, Row, TimeChart, TimeData } from './charts';
import { CodeFile, DmCode, langOf } from './dm-code';
import { FileView } from './file-view';
import { StoredFile } from './files-model';
import { NoteDoc } from './note-doc';
import { Board3d } from './board3d';
import { BodyNode, PartBodyView } from './part-body-view';
import { MeshView } from './mesh-view';
import { DOMAINS, DOMAIN_COLOR, Domain, STRENGTHS, STRENGTH_COLOR, Strength } from './taste-api';
import { Skeleton } from '../skeleton';

type Rule = { text: string; domain: Domain; strength: Strength; why?: string };
type Tally = Record<Strength, number>;

/** Readings at irregular times (a price, a quantity) as one value per
 *  bucket - a minute up to a week, whichever keeps it to about 120 - each
 *  the last reading known by then; drawn up to `until` (when it was sent).
 *  What TimeChart draws. Null when there are not two readings to join. */
export function readingSeries(points: { at: string; v: number }[], name: string, until?: string): TimeData | null {
  const pts = points.map(p => ({ t: Date.parse(p.at) / 1000, v: p.v })).filter(p => !isNaN(p.t) && isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const end = Math.max(pts[pts.length - 1].t, until ? Date.parse(until) / 1000 || 0 : 0);
  const span = Math.max(60, end - pts[0].t);
  const step = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400].find(s => span / s <= 120) ?? 30 * 86400;
  const t0 = Math.floor(pts[0].t / step) * step;
  const n = Math.max(2, Math.floor((end - t0) / step) + 1);
  const values: (number | null)[] = [];
  let k = 0, last: number | null = null;
  for (let i = 0; i < n; i++) {
    const stop = t0 + (i + 1) * step;
    while (k < pts.length && pts[k].t < stop) last = pts[k++].v;
    values.push(last);
  }
  return { t0, step, n, series: [{ name, values }] };
}

/** The view last chosen for each kind of thing, for this page's life. */
const LAST_TAB: Record<string, string> = {};

/** What was sent, in a modal in the Chat: a compact, read-only version of
 *  its own tab, from its snapshot (backend/dm.py) - a palette as the Taste
 *  tab lays it out, a model in 3D with its parts and its sources, a product
 *  as the catalog's detail, a stock item with its quantity over time, a note
 *  as Notes reads it, a file's preview, a board's layout and BOM, a
 *  firmware's build and code. "Add to my ..." from its head. */
@Component({
  selector: 'app-dm-viewer',
  imports: [Skeleton, T, Markdown, PartBodyView, BarList, TimeChart, DmCode, FileView, NoteDoc, Board3d, MeshView],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './stock.css', './dm-viewer.css'],
  host: { '(window:keydown.escape)': 'close()' },
  template: `
@if (store.viewing(); as sid) {
  <div class="tcv-dm-scrim" animate.leave="tcv-leave" (mousedown)="down = $event.target === $event.currentTarget ? 1 : 0" (click)="scrimClick()">
    <div class="tcv-dm-dialog tcv-dm-view dmv" role="dialog" aria-modal="true" aria-labelledby="dm-view-title"
         [attr.data-kind]="data()?.kind">
      @if (data(); as d) {
        <header class="dmv-head">
          <span class="tcv-dm-cardico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(d.kind)" /></svg></span>
          <div class="dmv-title">
            <div class="dmv-titlerow">
              <h2 id="dm-view-title" class="tcv-dm-dtitle" [title]="d.label">{{ d.label }}</h2>
              <span class="dmv-kind">{{ kindName(d.kind) | t }}</span>
            </div>
            <span class="dmv-sub">{{ 'sent by' | t }} <b>{{ d.by.name }}</b> · {{ stamp(d.at) }} · {{ 'read-only' | t }}</span>
          </div>
          @if (tabs().length > 1) {
            <div class="st-seg dmv-tabs" role="tablist" [attr.aria-label]="'View' | t" (keydown)="tabKey($event)">
              @for (x of tabs(); track x.id) {
                <button role="tab" [id]="'dmv-tab-' + x.id" [class.on]="tab() === x.id" [attr.aria-selected]="tab() === x.id"
                        [attr.tabindex]="tab() === x.id ? 0 : -1" (click)="setTab(x.id)">{{ x.label | t }}</button>
              }
            </div>
          }
          @if (d.add && addLabel(d.kind) && auth.can('edit') && !ownHere(d)) {
            <button type="button" class="tcv-btn tcv-dm-dok dmv-add" data-act="dm-viewer-add" [disabled]="store.adding().has(d.snap)"
                    (click)="store.addToMine(d.snap)">{{ addLabel(d.kind)! | t }}</button>
          }
          @if (d.kind === 'file' && d.blobs['file']) {
            <a class="tcv-btn dmv-dlbtn" [href]="blob(d, 'file') + '?download=1'">{{ 'Download' | t }}</a>
          }
          <button type="button" class="tcv-cc-ib dmv-x" (click)="close()" [title]="'Close' | t" [attr.aria-label]="'Close' | t">
            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
        </header>
        @let c = d.data;
        <div class="dmv-body" [attr.data-full]="full() ? 1 : null" role="tabpanel" [attr.aria-labelledby]="tabs().length > 1 ? 'dmv-tab-' + tab() : null">
          @switch (d.kind) {

            <!-- ======================= a taste palette ======================= -->
            @case ('taste') {
              @let ts = taste();
              @if (c['description']) { <p class="dmv-desc">{{ c['description'] }}</p> }
              <div class="st-tiles dmv-tiles">
                <div class="st-tile" [attr.data-tone]="ts.all.length ? null : 'dim'"><span>{{ 'Statements' | t }}</span><b>{{ ts.all.length }}</b>
                  <small>{{ fmt('in {n} domains', { n: ts.domains.length }) }}</small></div>
                @for (s of strengths; track s.id) {
                  <div class="st-tile tsh-str" [attr.data-s]="s.id" [attr.data-tone]="ts.str[s.id] ? null : 'dim'"><span>{{ s.label | t }}</span><b>{{ ts.str[s.id] }}</b>
                    <div class="st-meter"><i [style.width.%]="pct(ts.str[s.id], ts.all.length)" [style.background]="sc(s.id)"></i></div></div>
                }
                <div class="st-tile tsh-dtile"><span>{{ 'Domains' | t }}</span>
                  <span class="tsh-dlegend">
                    @for (dm of domains; track dm.id) {
                      <span [class.dim]="!ts.byDomain[dm.id]"><i class="tsh-dot" [style.background]="dc(dm.id)"></i>{{ dm.short | t }} <b>{{ ts.byDomain[dm.id] || 0 }}</b></span>
                    }
                  </span>
                  <span class="tsh-stack tsh-stack-d">
                    @for (dm of domains; track dm.id) { @if (ts.byDomain[dm.id]) { <i [style.flex-grow]="ts.byDomain[dm.id]" [style.background]="dc(dm.id)"></i> } }
                  </span></div>
              </div>
              <div class="dmv-grid2">
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Statements by domain' | t }}</h3>
                    <span class="st-right tsh-legend">
                      @for (s of strengths; track s.id) { <span><i class="tsh-dot" [style.background]="sc(s.id)"></i>{{ s.label | t }}</span> }
                    </span></div>
                  <div class="st-card-body">
                    @for (r of ts.rows; track r.id) {
                      <button class="tsh-drow dmv-drow" [attr.data-on]="tDomain() === r.id ? 1 : null" (click)="tDomain.set(tDomain() === r.id ? '' : r.id)">
                        <span class="tsh-dname"><i class="tsh-dot" [style.background]="dc(r.id)"></i>{{ r.label | t }}</span>
                        <span class="tsh-dtrack"><span class="tsh-dfill" [style.width.%]="r.w">
                          @for (s of strengths; track s.id) { @if (r.s[s.id]) { <i [style.flex-grow]="r.s[s.id]" [style.background]="sc(s.id)" [title]="(s.label | t) + ': ' + r.s[s.id]"></i> } }
                        </span></span>
                        <span class="tsh-dfig"><b>{{ r.total }}</b><span>{{ r.s.must }}</span><span>{{ r.s.prefer }}</span><span>{{ r.s.avoid }}</span></span>
                      </button>
                    }
                  </div>
                </section>
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'By strength' | t }}</h3><span class="st-sub">{{ 'MUST always, PREFER unless said otherwise, AVOID never' | t }}</span></div>
                  <div class="st-card-body">
                    @for (s of strengths; track s.id) {
                      <button class="tsh-drow dmv-drow dmv-srow" [attr.data-on]="tStrength() === s.id ? 1 : null" (click)="tStrength.set(tStrength() === s.id ? '' : s.id)">
                        <span class="tsh-dname tst-str" [attr.data-s]="s.id">{{ s.label | t }}</span>
                        <span class="tsh-dtrack"><span class="tsh-dfill" [style.width.%]="pct(ts.str[s.id], ts.all.length)"><i [style.flex-grow]="1" [style.background]="sc(s.id)"></i></span></span>
                        <span class="dmv-sfig"><b>{{ ts.str[s.id] }}</b> <span>{{ pct(ts.str[s.id], ts.all.length) }}%</span></span>
                      </button>
                    }
                  </div>
                </section>
              </div>
              <div class="dmv-filter">
                <input class="tst-in dmv-search" type="search" [placeholder]="'Search the statements' | t" [value]="tq()" (input)="tq.set($any($event.target).value)">
                <div class="st-seg" role="group" [attr.aria-label]="'Domain' | t">
                  <button [class.on]="!tDomain()" (click)="tDomain.set('')">{{ 'All' | t }}</button>
                  @for (dm of ts.domains; track dm.id) { <button [class.on]="tDomain() === dm.id" (click)="tDomain.set(dm.id)">{{ dm.label | t }}</button> }
                </div>
                <div class="st-seg" role="group" [attr.aria-label]="'Strength' | t">
                  <button [class.on]="!tStrength()" (click)="tStrength.set('')">{{ 'All' | t }}</button>
                  @for (s of strengths; track s.id) { <button [class.on]="tStrength() === s.id" (click)="tStrength.set(s.id)">{{ s.label | t }}</button> }
                </div>
                <span class="st-sub">{{ fmt('{n} of {m} shown', { n: ts.shown, m: ts.all.length }) }}</span>
              </div>
              @if (ts.cols.length) {
                <div class="tst-cols dmv-cols" [style.--n]="ts.cols.length">
                  @for (col of ts.cols; track col.id) {
                    <div class="st-card tst-col">
                      <div class="st-card-head tst-col-head"><i class="tsh-dot" [style.background]="dc(col.id)"></i><h3>{{ col.label | t }}</h3><span class="st-sub">{{ col.items.length }}</span>
                        <span class="st-right tsh-colfig">@for (s of strengths; track s.id) { <span [attr.data-s]="s.id" [title]="s.label | t">{{ count(col.items, s.id) }}</span> }</span></div>
                      <span class="tsh-stack tsh-colbar" aria-hidden="true">
                        @for (s of strengths; track s.id) { @if (count(col.items, s.id)) { <i [style.flex-grow]="count(col.items, s.id)" [style.background]="sc(s.id)"></i> } }
                      </span>
                      @for (it of col.items; track $index) {
                        <div class="tst-item dmv-rule">
                          <span class="tst-str" [attr.data-s]="it.strength">{{ strengthLabel(it.strength) | t }}</span>
                          <div class="tst-item-main"><span class="tst-text">{{ it.text }}</span>@if (it.why) { <span class="tst-why">{{ it.why }}</span> }</div>
                        </div>
                      }
                    </div>
                  }
                </div>
              } @else { <p class="st-hint">{{ 'Nothing matches.' | t }}</p> }
            }

            <!-- ======================= a 3D model ======================= -->
            @case ('model') {
              @let m = model();
              @if (tab() === 'code') {
                <app-dm-code class="dmv-fill" [files]="m.files" height="100%" />
              } @else {
              <div class="dmv-split dmv-fill">
                <div class="dmv-stage tcv-dm-3dview">
                  @if (d.blobs['viewer']) {
                    <app-part-body-view [src]="viewerSrc()" [plain]="true" [focus]="focus()" (tree)="tree.set($event)" />
                    @if (focus(); as f) {
                      <button class="tcv-btn dmv-stage-btn" (click)="focus.set(null)">{{ 'Show all' | t }} · <span class="dim">{{ leafName(f) }}</span></button>
                    }
                  } @else {
                    <p class="dmv-none">{{ 'No 3D view was sent with it - it had not been built, or its view was too big.' | t }}</p>
                  }
                </div>
                <aside class="dmv-side">
                  <div class="st-tiles dmv-tiles2">
                    <div class="st-tile"><span>{{ 'Size' | t }}</span><b class="dmv-tilewrap">{{ m.size || '–' }}</b><small>{{ 'bounding box, mm' | t }}</small></div>
                    <div class="st-tile"><span>{{ 'Parts' | t }}</span><b>{{ m.parts }}</b><small>{{ fmt('{n} groups', { n: m.groups }) }}</small></div>
                    <div class="st-tile"><span>{{ 'Version' | t }}</span><b>{{ c['version'] != null ? 'v' + c['version'] : '–' }}</b>
                      <small>{{ c['built'] ? fmt('built v{v}', { v: c['built'].version }) + (c['built'].secs ? ' · ' + c['built'].secs + ' s' : '') : ('not built' | t) }}</small></div>
                    <div class="st-tile"><span>{{ 'Imports' | t }}</span><b>{{ m.imports }}</b><small>{{ fmt('{n} sources sent', { n: m.files.length }) }}</small></div>
                  </div>
                  <div class="dmv-tree" role="tree">
                    <div class="dmv-treehead"><b>{{ 'Part tree' | t }}</b>
                      @if (tree().length) { <span class="st-sub">{{ 'click to isolate' | t }}</span> }
                      @if (m.groups) { <button class="st-more dmv-treeall" (click)="shutAll(m.nodes)">{{ (partsShut().size ? 'Expand all' : 'Collapse all') | t }}</button> }</div>
                    <!-- the tiles and this head stay put; only the list scrolls -->
                    <div class="dmv-treelist">
                    @for (n of shownNodes(m.nodes); track n.path) {
                      <div class="dmv-noderow" role="treeitem" [attr.aria-expanded]="n.leaf ? null : !partsShut().has(n.path)" [style.--layout-depth]="n.depth">
                        <!-- a group folds like a folder in the code tree; the name still isolates it -->
                        @if (!n.leaf) {
                          <button class="dmv-twist" (click)="foldPart(n.path)" [attr.aria-label]="(partsShut().has(n.path) ? 'Expand' : 'Collapse') | t">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="partsShut().has(n.path) ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'" /></svg></button>
                        } @else if (m.groups) { <span class="dmv-twist" aria-hidden="true"></span> }
                        <button class="dmv-node" [attr.data-leaf]="n.leaf ? 1 : null" [attr.data-on]="focus() === n.path ? 1 : null"
                                [disabled]="!tree().length" (click)="focus.set(focus() === n.path ? null : n.path)" [title]="n.path">
                          <span class="dmv-nodeico" aria-hidden="true"></span>
                          <span class="dmv-nodename">{{ n.name }}</span>
                          @if (n.size) { <span class="dmv-nodesize">{{ n.size }}</span> }
                        </button>
                      </div>
                    } @empty { <p class="st-hint">{{ 'No parts were listed.' | t }}</p> }
                    </div>
                  </div>
                  @if (c['uses']?.length) {
                    <div class="dmv-chips"><span class="st-sub">{{ 'Uses' | t }}</span>
                      @for (u of c['uses']; track u.id) { <span class="dmv-chip" [title]="u.kind + ' ' + u.id">{{ u.id }}</span> }</div>
                  }
                </aside>
              </div>
              }
            }

            <!-- ======================= a catalog product ======================= -->
            @case ('product') {
              @let p = c['product'] || {};
              <div class="dmv-prod">
                <div class="mf-dgal">
                  <div class="mf-dimg">@if (bigImg(); as src) { <img [src]="src" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
                    @else { <svg class="mf-noimg" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="PHOTO" /></svg> }</div>
                  @if (gallery().length > 1) {
                    <div class="mf-thumbs">@for (u of gallery(); track u) {
                      <button [class.on]="u === bigImg()" (click)="shot.set(u)"><img [src]="u" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(u)"></button> }</div>
                  }
                </div>
                <div class="mf-dinfo dmv-pinfo">
                  <span class="mf-dseller"><img class="mf-fav" [src]="fav(c)" alt="" referrerpolicy="no-referrer" (error)="$any($event.target).style.visibility = 'hidden'">
                    <span>{{ sellerName(c) }}</span>
                    @if (c['maker']?.name && c['maker']?.domain !== p.seller?.domain) { <span class="dim">· {{ c['maker'].name }}</span> }</span>
                  <div class="mf-dmeta">
                    @if (p.sku) { <span class="mono">{{ fmt('Code {c}', { c: p.sku }) }}</span> }
                    @if (p.category) { <span class="mf-chip">{{ p.category }}</span> }
                    @if (p.stock) { <span class="mf-stock mf-stock-inline" [attr.data-s]="p.stock">{{ stockName(p) }}</span> }
                  </div>
                  <div class="mf-dprice">
                    @if (p.price) {
                      <b>{{ moneyIn(p.price.amount, p.price.currency) }}</b>
                      @if (moneyAlt(p.price.amount, p.price.currency); as alt) { <small class="dim" [title]="moneyTip(p.price.amount, p.price.currency)">{{ alt }}</small> }
                      @if (p.price.vat === 'excl') { <span class="mf-vat">{{ '+VAT' | t }}</span> } @else if (p.price.vat === 'incl') { <span class="mf-vat">{{ 'VAT included' | t }}</span> }
                      @else { <span class="mf-vat dim">{{ 'VAT not stated' | t }}</span> }
                      @if (p.list_price && p.list_price.amount > p.price.amount) { <s>{{ moneyIn(p.list_price.amount, p.list_price.currency || p.price.currency) }}</s> }
                      @if (p.price.gross) { <small class="dim">{{ fmt('{p} with VAT', { p: moneyIn(p.price.gross, p.price.currency) }) }}</small> }
                    } @else if (c['price_label']) { <b>{{ c['price_label'] }}</b> }
                    @else { <span class="dim">{{ 'No price on its page' | t }}</span> }
                  </div>
                  <!-- what the sender had on hand of it when it was sent (backend/dm.py _on_hand) -->
                  @if (c['stock']; as st) {
                    <div class="inv-qrow dmv-onhand">
                      <div class="inv-qbig" [attr.data-low]="st.low ? 1 : null" [attr.data-out]="st.quantity <= 0 ? 1 : null">
                        <b>{{ qty(st.quantity) }}</b><span>{{ st.unit }}</span>
                        @if (st.low) { <span class="st-tag" data-tone="warn">{{ 'low' | t }}</span> }
                      </div>
                      <span class="st-sub">{{ (st.locations?.length ? fmt('on hand at {w} when it was sent', { w: st.locations.join(', ') }) : t('on hand when it was sent')) }}</span>
                    </div>
                  }
                  <div class="mf-dstock">
                    @if (p.stock_text) { <span class="dim">"{{ p.stock_text }}"</span> }
                    @if (p.price?.at || p.read_at) { <span class="dim">{{ fmt('read {w}', { w: shortDate(p.read_at || p.price?.at) }) }}</span> }
                  </div>
                  @if (priceChart(); as pc) {
                    <section class="st-card">
                      <div class="st-card-head"><h3>{{ 'Price over time' | t }}</h3><span class="st-sub">{{ fmt('{n} readings', { n: p.history.length }) }}</span></div>
                      <div class="st-card-body"><app-time-chart [data]="pc" kind="line" [height]="150" [legend]="false" [sums]="false" [f]="priceFmt()" /></div>
                    </section>
                  }
                  @if (p.description) { <p class="mf-ddesc">{{ p.description }}</p> }
                  @if (specs(p).length) {
                    <table class="mf-dspecs"><tbody>@for (s of specs(p); track s[0]) { <tr><th>{{ s[0] }}</th><td>{{ s[1] }}</td></tr> }</tbody></table>
                  }
                  @if (p.history?.length) {
                    <span class="mf-label">{{ 'Price and stock, as read' | t }}</span>
                    <div class="st-table-wrap"><table class="st-table mf-dhist">
                      <thead><tr><th>{{ 'Date' | t }}</th><th class="r">{{ 'Price' | t }}</th><th>{{ 'Stock' | t }}</th><th class="r">{{ 'Change' | t }}</th></tr></thead>
                      <tbody>@for (h of histRows(p); track $index) {
                        <tr><td>{{ shortDate(h.at) }}</td>
                          <td class="r" [title]="h.amount != null ? moneyTip(h.amount, h.currency) : ''">{{ h.amount != null ? moneyIn(h.amount, h.currency) : '–' }}@if (h.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> }</td>
                          <td>{{ h.stock ? (h.stock === 'in' ? (h.qty != null ? fmt('{n} left', { n: h.qty }) : t('In stock')) : t('Out of stock')) : '–' }}</td>
                          <td class="r mono" [attr.data-up]="h.change > 0 ? 1 : null" [attr.data-down]="h.change < 0 ? 1 : null">{{ h.change ? (h.change > 0 ? '+' : '') + h.change.toFixed(1) + '%' : '' }}</td></tr>
                      }</tbody>
                    </table></div>
                  }
                  @if (p.url) { <div class="mf-dacts"><a class="tcv-btn" [href]="p.url" target="_blank" rel="noopener noreferrer">{{ 'Open its page' | t }}</a></div> }
                </div>
              </div>
            }

            <!-- ======================= a stock line, as sent before stock went with its product ======================= -->
            @case ('inventory') {
              @let low = c['min_stock'] != null && (c['quantity'] ?? 0) <= c['min_stock'];
              <div class="inv-qrow">
                <div class="inv-qbig" [attr.data-low]="low ? 1 : null" [attr.data-out]="(c['quantity'] ?? 0) <= 0 ? 1 : null">
                  <b>{{ qty(c['quantity']) }}</b><span>{{ c['unit'] || 'pcs' }}</span>
                  @if ((c['quantity'] ?? 0) <= 0) { <span class="st-tag" data-tone="danger">{{ 'out of stock' | t }}</span> }
                  @else if (low) { <span class="st-tag" data-tone="warn">{{ fmt('low - minimum {n}', { n: qty(c['min_stock']) }) }}</span> }
                </div>
                <span class="st-sub">{{ 'What the sender had when it was sent. Added to your stock it starts at 0.' | t }}</span>
              </div>
              <div class="st-tiles dmv-tiles">
                <div class="st-tile" [attr.data-tone]="c['location'] ? null : 'dim'"><span>{{ 'Location' | t }}</span><b [title]="c['location'] || ''">{{ c['location'] || '–' }}</b><small>{{ c['category'] || ('no category' | t) }}</small></div>
                <div class="st-tile" [attr.data-tone]="c['price'] != null ? null : 'dim'"><span>{{ 'Unit price' | t }}</span><b>{{ c['price'] != null ? moneyIn(c['price'], c['currency']) : '–' }}</b><small>{{ c['price'] != null ? moneyAlt(c['price'], c['currency']) : '' }}&nbsp;</small></div>
                <div class="st-tile" [attr.data-tone]="c['price'] != null ? null : 'dim'"><span>{{ 'Value' | t }}</span><b [title]="c['price'] != null ? moneyTip(c['price'] * (c['quantity'] || 0), c['currency']) : ''">{{ c['price'] != null ? moneyIn(c['price'] * (c['quantity'] || 0), c['currency']) : '–' }}</b><small>{{ 'quantity × unit price' | t }}</small></div>
                <div class="st-tile" [attr.data-tone]="c['min_stock'] != null ? null : 'dim'"><span>{{ 'Minimum' | t }}</span><b>{{ c['min_stock'] != null ? qty(c['min_stock']) : '–' }}</b><small>{{ (c['min_stock'] != null ? (low ? 'at or below it' : 'above it') : 'none set') | t }}</small></div>
                <div class="st-tile" [attr.data-tone]="c['mpn'] || c['lcsc'] ? null : 'dim'"><span>{{ 'Part' | t }}</span><b class="mono" [title]="c['mpn'] || ''">{{ c['mpn'] || c['lcsc'] || '–' }}</b><small>{{ c['lcsc'] && c['mpn'] ? 'LCSC ' + c['lcsc'] : (c['manufacturer'] || '') }}&nbsp;</small></div>
                <div class="st-tile" [attr.data-tone]="c['log']?.length ? null : 'dim'"><span>{{ 'Changes' | t }}</span><b>{{ c['log']?.length ?? 0 }}</b><small>{{ c['updated_at'] ? shortDate(c['updated_at']) : '' }}&nbsp;</small></div>
              </div>
              <div class="dmv-grid2">
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Quantity over time' | t }}</h3></div>
                  <div class="st-card-body">
                    @if (qtyChart(); as qc) { <app-time-chart [data]="qc" kind="area" [height]="170" [legend]="false" [sums]="false" /> }
                    @else { <p class="st-hint">{{ 'No movements were sent with it.' | t }}</p> }
                  </div>
                </section>
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Details' | t }}</h3></div>
                  <dl class="dmv-dl">
                    @for (kv of invFields(c); track kv[0]) { <dt>{{ kv[0] | t }}</dt><dd>{{ kv[1] }}</dd> }
                    @if (c['catalog']; as cat) { <dt>{{ 'Parts' | t }}</dt><dd>{{ cat.manufacturer_name }}{{ cat.product_name ? ' / ' + cat.product_name : '' }}</dd> }
                    @if (c['tags']?.length) { <dt>{{ 'Tags' | t }}</dt><dd>@for (g of c['tags']; track g) { <span class="dmv-chip">{{ g }}</span> }</dd> }
                  </dl>
                  @if (c['notes']) { <p class="dmv-desc dmv-pad">{{ c['notes'] }}</p> }
                </section>
              </div>
              @if (c['log']?.length) {
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Change log' | t }}</h3><span class="st-sub">{{ fmt('{n} entries, newest first', { n: c['log'].length }) }}</span></div>
                  <div class="st-table-wrap"><table class="st-table inv-log">
                    <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'What' | t }}</th><th class="r">{{ 'Change' | t }}</th><th class="r">{{ 'After' | t }}</th><th>{{ 'Reason' | t }}</th><th>{{ 'By' | t }}</th></tr></thead>
                    <tbody>@for (l of logRows(c); track $index) {
                      <tr><td class="dim nowrap">{{ shortDate(l.at) }}</td><td>{{ l.kind | t }}</td>
                        <td class="r mono" [attr.data-sign]="l.delta == null ? null : l.delta < 0 ? '-' : '+'">{{ l.delta == null ? '' : (l.delta > 0 ? '+' : '') + qty(l.delta) }}</td>
                        <td class="r mono">{{ l.after == null ? '' : qty(l.after) }}</td><td class="give">{{ l.reason || '' }}</td><td class="dim">{{ l.by || ('someone' | t) }}</td></tr>
                    }</tbody>
                  </table></div>
                </section>
              }
            }

            <!-- ======================= a note ======================= -->
            @case ('note') {
              @let ns = noteStats();
              <div class="st-tiles dmv-tiles">
                <div class="st-tile"><span>{{ 'Words' | t }}</span><b>{{ ns.words }}</b><small>{{ fmt('about {n} min to read', { n: ns.minutes }) }}</small></div>
                <div class="st-tile" [attr.data-tone]="ns.todos ? (ns.done === ns.todos ? 'ok' : null) : 'dim'"><span>{{ 'To-dos' | t }}</span><b>{{ ns.todos ? ns.done + ' / ' + ns.todos : '–' }}</b>
                  @if (ns.todos) { <div class="st-meter"><i [style.width.%]="pct(ns.done, ns.todos)"></i></div> } @else { <small>{{ 'none' | t }}</small> }</div>
                <div class="st-tile" [attr.data-tone]="c['tags']?.length ? null : 'dim'"><span>{{ 'Tags' | t }}</span><b>{{ c['tags']?.length || 0 }}</b>
                  <small [title]="tagLine(c)">{{ tagLine(c) || ('none' | t) }}</small></div>
                <div class="st-tile" [attr.data-tone]="c['updated_at'] ? null : 'dim'"><span>{{ 'Last edited' | t }}</span><b>{{ c['updated_at'] ? shortDay(c['updated_at']) : '–' }}</b>
                  <small>{{ c['created_at'] ? fmt('written {w}', { w: shortDay(c['created_at']) }) : '' }}&nbsp;</small></div>
              </div>
              <article class="tcv-note dmv-note">
                <app-note-doc [text]="c['text'] || ''" [editable]="false">
                  <span class="tcv-note-meta">{{ d.by.name }}@if (c['created_at']) { · {{ shortDay(c['created_at']) }} }@if (c['updated_at'] && c['updated_at'] !== c['created_at']) { · {{ 'edited' | t }} {{ shortDay(c['updated_at']) }} }</span>
                  @if (ns.todos) {
                    <span class="tcv-note-progress" [attr.data-done]="ns.done === ns.todos ? 1 : null" [title]="'To-dos done' | t">
                      <i><b [style.width.%]="pct(ns.done, ns.todos)"></b></i>{{ ns.done }}/{{ ns.todos }}</span>
                  }
                  <span class="grow"></span>
                  @for (g of c['tags'] ?? []; track g) { <span class="dmv-chip">#{{ g }}</span> }
                </app-note-doc>
              </article>
            }

            <!-- ======================= a file ======================= -->
            @case ('file') {
              @let pv = c['preview'] || 'none';
              @let ar = c['entries'];
              <div class="st-tiles dmv-tiles dmv-ftiles">
                <div class="st-tile"><span>{{ 'Kind' | t }}</span><b>{{ kindLabel(c['kind'], pv) | t }}</b><small [title]="c['content_type'] || d.blobs['file']?.type || ''">{{ c['content_type'] || d.blobs['file']?.type || '' }}&nbsp;</small></div>
                <div class="st-tile"><span>{{ 'Size' | t }}</span><b>{{ size(c['bytes']) }}</b><small>{{ fmt('{n} bytes', { n: num(c['bytes'] || 0) }) }}</small></div>
                @if (fileTable(); as tb) {
                  <div class="st-tile"><span>{{ 'Rows' | t }}</span><b>{{ num(tb.total) }}</b><small>{{ fmt('{n} columns', { n: tb.cols }) }}{{ tb.sheets > 1 ? ' · ' + fmt('{n} sheets', { n: tb.sheets }) : '' }}</small></div>
                } @else if (ar) {
                  <div class="st-tile"><span>{{ 'Entries' | t }}</span><b>{{ num(ar.total) }}</b><small>{{ fmt('{n} folders', { n: archFolders() }) }}</small></div>
                  <div class="st-tile"><span>{{ 'Unpacked' | t }}</span><b>{{ size(ar.bytes) }}</b><small>{{ ar.bytes && c['bytes'] ? fmt('packed to {p}%', { p: pct(c['bytes'], ar.bytes) }) : '' }}&nbsp;</small></div>
                } @else if (c['text']) {
                  <div class="st-tile"><span>{{ 'Lines' | t }}</span><b>{{ num(lineCount(c['text'])) }}</b><small>{{ fmt('{n} characters', { n: num(c['text'].length) }) }}</small></div>
                }
                @if (c['created_at']) { <div class="st-tile"><span>{{ 'Uploaded' | t }}</span><b>{{ shortDay(c['created_at']) }}</b><small>&nbsp;</small></div> }
                <div class="st-tile" [attr.data-tone]="c['note'] ? null : 'dim'"><span>{{ 'Note' | t }}</span><b class="dmv-tilewrap" [title]="c['note'] || ''">{{ c['note'] || '–' }}</b></div>
              </div>
              @if (!d.blobs['file']) {
                <p class="dmv-none">{{ 'The file itself was not sent with it.' | t }}</p>
              } @else if (fileTable(); as tb) {
                <div class="dmv-tablewrap dmv-fill"><table class="tcv-fv-table">
                  <thead><tr><th class="tcv-fv-rn"></th>@for (h of tb.rows[0]; track $index) { <th>{{ h }}</th> }</tr></thead>
                  <tbody>@for (r of tb.rows.slice(1, 501); track $index) { <tr><td class="tcv-fv-rn">{{ $index + 2 }}</td>@for (x of r; track $index) { <td>{{ x }}</td> }</tr> }</tbody>
                </table></div>
                @if (tb.total > tb.rows.length - 1) { <p class="st-hint">{{ fmt('Showing the first {n} rows - download it for the rest.', { n: tb.rows.length - 1 }) }}</p> }
              } @else if (ar) {
                <div class="dmv-tablewrap dmv-fill"><table class="st-table dmv-arch">
                  <thead><tr><th>{{ 'Name' | t }}</th><th class="r">{{ 'Size' | t }}</th>@if (archPacked()) { <th class="r">{{ 'Packed' | t }}</th> }</tr></thead>
                  <tbody>@for (e of archRows(); track $index) {
                    <tr [attr.data-dir]="e.dir ? 1 : null"><td><span class="dmv-ent" [style.--layout-depth]="e.depth">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="e.dir ? FOLDER : FILE" /></svg>{{ e.leaf }}</span></td>
                      <td class="r mono">{{ e.dir ? '' : size(e.bytes) }}</td>@if (archPacked()) { <td class="r mono dim">{{ e.dir || e.packed == null ? '' : size(e.packed) }}</td> }</tr>
                  }</tbody>
                </table></div>
                @if (ar.truncated) { <p class="st-hint">{{ 'Only the first entries are listed.' | t }}</p> }
              } @else if (pv === 'markdown' && c['text'] && tab() !== 'source') {
                <div class="dmv-mdwrap dmv-fill"><article class="md tcv-dm-md" [innerHTML]="c['text'] | md"></article></div>
              } @else if (c['text']) {
                <app-dm-code class="dmv-fill" [files]="oneFile()" height="100%" />
              } @else if (pv === 'step') {
                @if (d.blobs['mesh']) {
                  <div class="dmv-fstage dmv-fill"><app-mesh-view [src]="blob(d, 'mesh')" [name]="c['name'] || d.label" [step]="true" /></div>
                } @else { <p class="dmv-none">{{ 'Its 3D view was not ready when it was sent. Add it to your files to see it in 3D.' | t }}</p> }
              } @else if (['image', 'pdf', 'mesh', 'video', 'audio'].includes(pv)) {
                <div class="dmv-fstage dmv-fill" [attr.data-pv]="pv"><app-file-view [file]="fileStored()!" [src]="blob(d, 'file')" /></div>
              } @else {
                <div class="dmv-nopv dmv-fill">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="FILE" /></svg>
                  <b>{{ c['name'] || d.label }}</b>
                  <span>{{ 'There is no preview for this kind of file.' | t }} {{ size(c['bytes']) }}</span>
                  <a class="tcv-btn tcv-dm-dok" [href]="blob(d, 'file') + '?download=1'">{{ 'Download' | t }}</a>
                </div>
              }
            }

            <!-- ======================= a board ======================= -->
            @case ('board') {
              @let f = bf();
              @let bs = boardStats();
              <!-- four tabs, each the whole body: 3D, Layout and Schematic with their figures in a column beside, Code -->
              @if (tab() === '3d') {
                <div class="dmv-stage dmv-fill dmv-3dboard">
                  @if (d.blobs['board3d']) { <app-board-3d [src]="blob(d, 'board3d')" /> }
                  @else { <p class="dmv-none">{{ 'No 3D view was sent with it - it had not been built, or its view was too big.' | t }}</p> }
                </div>
              } @else if (tab() === 'schematic') {
              <div class="dmv-split dmv-split-board dmv-fill">
                <div class="dmv-stagecol">
                  @if (sheets().length > 1) {
                    <div class="st-seg dmv-views" role="group" [attr.aria-label]="'Sheets' | t">
                      @for (v of sheets(); track v.id) { <button [class.on]="sheet() === v.id" (click)="sheetView.set(v.id)">{{ v.label | t }}</button> }
                    </div>
                  }
                  <div class="dmv-stage dmv-pcb">
                    @if (sheet(); as v) {
                      @for (x of [v]; track x) { <app-file-view [file]="pictures()[x]" [src]="blob(d, x)" [upscale]="true" /> }
                    } @else { <p class="dmv-none">{{ 'No schematic was sent with it - it had not been drawn yet.' | t }}</p> }
                  </div>
                </div>
                <aside class="dmv-side">
                  <div class="st-tiles dmv-tiles2">
                    <div class="st-tile"><span>{{ 'Parts' | t }}</span><b>{{ f.schematic?.parts ?? '–' }}</b><small>{{ fmt('{n} BOM lines', { n: bs.groups.length }) }}</small></div>
                    <div class="st-tile"><span>{{ 'Sheets' | t }}</span><b>{{ f.schematic?.sheets?.length ?? '–' }}</b><small>{{ f.schematic ? fmt('{n} symbols', { n: f.schematic.symbols ?? 0 }) : '' }}&nbsp;</small></div>
                    <div class="st-tile"><span>{{ 'Wires' | t }}</span><b>{{ f.schematic?.wires ?? '–' }}</b><small>&nbsp;</small></div>
                    <div class="st-tile"><span>{{ 'Nets' | t }}</span><b>{{ f.net_count ?? f.nets?.length ?? '–' }}</b>
                      <small>{{ f.single?.length ? fmt('{n} single-pin nets', { n: f.single.length }) : '' }}&nbsp;</small></div>
                  </div>
                  <!-- the tiles stay put; the netlist and the BOM below scroll -->
                  <div class="dmv-sidescroll">
                    @if (f.schematic?.sheets?.length) {
                      <div class="dmv-chips">@for (s of f.schematic.sheets; track $index) { <span class="dmv-chip">{{ s.name }} <b>{{ s.parts }}</b></span> }</div>
                    }
                    @if (f.counts || f.nets?.length) {
                      <section class="st-card">
                        <div class="st-card-head"><h3>{{ 'Netlist' | t }}</h3><span class="st-sub">{{ fmt('{n} nets', { n: f.net_count ?? f.nets?.length ?? 0 }) }}</span></div>
                        <div class="st-card-body">
                          @if (countPairs(f.counts).length) {
                            <div class="st-tiles tight">@for (kv of countPairs(f.counts); track kv[0]) { <div class="st-tile"><span>{{ kv[0] | t }}</span><b>{{ kv[1] }}</b></div> }</div>
                          }
                          @if (f.nets?.length) { <span class="st-sub">{{ 'Nets by size (pins)' | t }}</span><app-bar-list [rows]="netRows(f.nets)" [mono]="true" /> }
                          @if (f.single?.length) {
                            <span class="st-sub">{{ fmt('{n} single-pin nets', { n: f.single.length }) }}</span>
                            <div class="dmv-chips dmv-muted">@for (s of f.single.slice(0, 40); track $index) { <span class="dmv-chip">{{ s }}</span> }</div>
                          }
                        </div>
                      </section>
                    }
                    @if (bs.groups.length) {
                      <section class="st-card">
                        <div class="st-card-head"><h3>{{ 'Bill of materials' | t }}</h3><span class="st-sub">{{ fmt('{n} lines · {m} parts', { n: bomShown().length, m: bs.parts }) }}</span></div>
                        <div class="st-card-body"><input class="tst-in dmv-search dmv-sidesearch" type="search" [placeholder]="'Search the BOM' | t" [value]="bomQ()" (input)="bomQ.set($any($event.target).value)"></div>
                        <table class="st-table dmv-sidebom">
                          <thead><tr><th class="r">{{ 'Qty' | t }}</th><th>{{ 'Designators' | t }}</th><th>LCSC</th></tr></thead>
                          <tbody>@for (g of bomShown(); track $index) {
                            <tr><td class="r mono">{{ g.n }}</td>
                              <td class="give">{{ g.refs }}<small>{{ g.value !== g.lcsc ? g.value : '' }}{{ g.value !== g.lcsc && g.footprint ? ' · ' : '' }}{{ g.footprint }}</small></td>
                              <td class="mono">@if (g.lcsc) { <a class="st-link" [href]="'https://www.lcsc.com/product-detail/' + g.lcsc + '.html'" target="_blank" rel="noopener noreferrer">{{ g.lcsc }}</a> }</td></tr>
                          } @empty { <tr><td colspan="3" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }</tbody>
                        </table>
                      </section>
                    }
                  </div>
                </aside>
              </div>
              } @else if (tab() === 'code') {
                <app-dm-code class="dmv-fill" [files]="sourceFiles()" height="100%" />
              } @else {
              <div class="dmv-split dmv-split-board dmv-fill">
                <div class="dmv-stagecol">
                  @if (boardViews().length > 1) {
                    <div class="st-seg dmv-views" role="group" [attr.aria-label]="'View' | t">
                      @for (v of boardViews(); track v.id) { <button [class.on]="boardView() === v.id" (click)="pcbView.set(v.id)">{{ v.label | t }}</button> }
                    </div>
                  }
                  <div class="dmv-stage dmv-pcb">
                    @if (boardView(); as v) {
                      <app-file-view [file]="pictures()[v]" [src]="blob(d, v)" [upscale]="true" />
                    } @else { <p class="dmv-none">{{ 'No layout was sent with it - it had not been laid out yet.' | t }}</p> }
                  </div>
                </div>
                <aside class="dmv-side">
                  <div class="st-tiles dmv-tiles2">
                    <div class="st-tile dmv-wide"><span>{{ 'Size' | t }}</span><b>{{ f.layout?.size_mm ? f.layout.size_mm[0] + ' × ' + f.layout.size_mm[1] + ' mm' : '–' }}</b>
                      <small>{{ f.thickness ? fmt('{n} mm thick', { n: f.thickness }) : '' }}{{ f.layout?.holes != null ? (f.thickness ? ' · ' : '') + fmt('{n} mounting holes', { n: f.layout.holes }) : '' }}&nbsp;</small></div>
                    <div class="st-tile"><span>{{ 'Layers' | t }}</span><b>{{ f.rules?.board?.layers ?? '–' }}</b><small>{{ f.route?.zones != null ? fmt('{n} zones', { n: f.route.zones }) : '' }}&nbsp;</small></div>
                    <div class="st-tile"><span>{{ 'Parts placed' | t }}</span><b>{{ f.layout?.placed ?? bs.parts ?? '–' }}</b><small>{{ fmt('{n} BOM lines', { n: bs.groups.length }) }}</small></div>
                    <div class="st-tile" [attr.data-tone]="f.route ? null : 'dim'"><span>{{ 'Tracks' | t }}</span><b>{{ f.route?.tracks != null ? num(f.route.tracks) : '–' }}</b>
                      <small>{{ f.route?.vias != null ? fmt('{n} vias', { n: f.route.vias }) : '' }}&nbsp;</small></div>
                    <div class="st-tile" [attr.data-tone]="f.route?.length_mm ? null : 'dim'"><span>{{ 'Track length' | t }}</span><b>{{ f.route?.length_mm ? num(f.route.length_mm) + ' mm' : '–' }}</b>
                      <small>{{ f.route?.engine || '' }}&nbsp;</small></div>
                    <div class="st-tile" [attr.data-tone]="f.route ? (f.route.unrouted ? 'warn' : 'ok') : 'dim'"><span>{{ 'Unrouted' | t }}</span>
                      <b>{{ f.route ? f.route.unrouted ?? 0 : '–' }}</b><small>{{ (f.route ? (f.route.unrouted ? 'connections left' : 'every connection routed') : 'not routed') | t }}</small></div>
                    <div class="st-tile"><span>{{ 'Version' | t }}</span><b>{{ f.version != null ? 'v' + f.version : '–' }}</b><small>{{ f.saved_at ? fmt('saved {w}', { w: shortDate(f.saved_at) }) : (f.folder || '') }}&nbsp;</small></div>
                  </div>
                  <!-- the tiles stay put; the checks and the rules below scroll -->
                  <div class="dmv-sidescroll">
                    @let drcTone = f.drc ? (f.drc.error_count ? 'danger' : f.drc.warning_count ? 'warn' : 'ok') : null;
                    <section class="dmv-panel" [attr.data-tone]="drcTone">
                      <div class="dmv-panelhead"><b>DRC</b>
                        @if (f.drc) {
                          <span class="st-tag" [attr.data-tone]="f.drc.error_count ? 'danger' : 'ok'">{{ fmt('{n} errors', { n: f.drc.error_count ?? 0 }) }}</span>
                          <span class="st-tag" [attr.data-tone]="f.drc.warning_count ? 'warn' : null">{{ fmt('{n} warnings', { n: f.drc.warning_count ?? 0 }) }}</span>
                          @if (f.drc.unconnected) { <span class="st-tag" data-tone="danger">{{ fmt('{n} unconnected', { n: f.drc.unconnected }) }}</span> }
                        } @else { <span class="st-sub">{{ 'not checked' | t }}</span> }</div>
                      @if (ruleRows(f.drc).length) { <app-bar-list [rows]="ruleRows(f.drc)" /> }
                      @if (f.drc?.examples?.length) {
                        <ul class="dmv-examples">@for (x of f.drc.examples.slice(0, 6); track $index) { <li>{{ x }}</li> }</ul>
                      }
                    </section>
                    <section class="dmv-panel" [attr.data-tone]="f.erc ? (f.erc.error_count ? 'danger' : f.erc.warning_count ? 'warn' : 'ok') : null">
                      <div class="dmv-panelhead"><b>ERC</b>
                        @if (f.erc) {
                          <span class="st-tag" [attr.data-tone]="f.erc.error_count ? 'danger' : 'ok'">{{ fmt('{n} errors', { n: f.erc.error_count ?? 0 }) }}</span>
                          <span class="st-tag" [attr.data-tone]="f.erc.warning_count ? 'warn' : null">{{ fmt('{n} warnings', { n: f.erc.warning_count ?? 0 }) }}</span>
                        } @else { <span class="st-sub">{{ 'not checked' | t }}</span> }</div>
                      @if (ruleRows(f.erc).length) { <app-bar-list [rows]="ruleRows(f.erc)" /> }
                      @if (f.erc?.examples?.length) {
                        <ul class="dmv-examples">@for (x of f.erc.examples.slice(0, 6); track $index) { <li>{{ x }}</li> }</ul>
                      }
                    </section>
                    @if (bs.byPrefix.length) {
                      <section class="st-card"><div class="st-card-head"><h3>{{ 'Parts by kind' | t }}</h3><span class="st-sub">{{ fmt('{n} parts', { n: bs.parts }) }}</span></div>
                        <div class="st-card-body"><app-bar-list [rows]="bs.byPrefix" /></div></section>
                    }
                    @if (f.rules) {
                      <section class="st-card">
                        <div class="st-card-head"><h3>{{ 'Design rules' | t }}</h3><span class="st-sub">{{ fmt('{n} net classes', { n: f.rules.classes?.length ?? 0 }) }}</span></div>
                        <table class="st-table dmv-sidebom">
                          <thead><tr><th>{{ 'Class' | t }}</th><th class="r">{{ 'Track' | t }}</th><th class="r">{{ 'Clearance' | t }}</th><th class="r">{{ 'Via' | t }}</th><th class="r">{{ 'Drill' | t }}</th></tr></thead>
                          <tbody>@for (r of f.rules.classes; track $index) {
                            <tr><td class="give">{{ r.name }}<small>{{ classNets(r) }}</small></td><td class="r mono">{{ r.track }}</td><td class="r mono">{{ r.clearance }}</td><td class="r mono">{{ r.via }}</td><td class="r mono">{{ r.drill }}</td></tr>
                          }</tbody>
                        </table>
                        @if (limitPairs(f.rules.board).length) {
                          <div class="st-card-body"><span class="st-sub">{{ 'Board limits, mm' | t }}</span>
                            <div class="dmv-chips">@for (kv of limitPairs(f.rules.board); track kv[0]) { <span class="dmv-chip">{{ kv[0] | t }} <b>{{ kv[1] }}</b></span> }
                              @for (p of f.rules.pours ?? []; track $index) { <span class="dmv-chip">{{ 'Pour' | t }} <b>{{ p.net }}</b> {{ (p.layers ?? []).join(', ') }}</span> }</div></div>
                        }
                      </section>
                    }
                  </div>
                </aside>
              </div>
              }
            }

            <!-- ======================= a firmware ======================= -->
            @case ('firmware') {
              @let b = c['build'];
              @if (tab() === 'code') {
                <app-dm-code class="dmv-fill" [files]="fwFiles()" height="100%" />
              } @else {
              <div class="st-tiles dmv-tiles">
                <div class="st-tile"><span>{{ 'Chip' | t }}</span><b [title]="c['mcu_title'] || ''">{{ c['mcu_title'] || c['mcu'] || '–' }}</b><small>{{ c['mcu'] || '' }}{{ c['mcu_part'] ? ' · ' + c['mcu_part'] : '' }}&nbsp;</small></div>
                <div class="st-tile"><span>{{ 'Board' | t }}</span><b [title]="c['board'] || ''">{{ c['board_title'] || c['board'] || '–' }}</b><small>{{ c['sheet_name'] || '' }}&nbsp;</small></div>
                <div class="st-tile"><span>{{ 'Platform' | t }}</span><b [title]="c['platform'] || ''">{{ c['framework'] || '–' }}</b><small>{{ c['platform'] || '' }} {{ c['pio_board'] || '' }}&nbsp;</small></div>
                <div class="st-tile" [attr.data-tone]="b ? (b.state === 'ok' && !b.error_count ? 'ok' : 'danger') : 'dim'"><span>{{ 'Last build' | t }}</span>
                  <b>{{ b ? (b.error_count ? fmt('{n} errors', { n: b.error_count }) : (b.state === 'ok' ? ('built' | t) : b.state)) : '–' }}</b>
                  <small>{{ b ? fmt('v{v} · {w}', { v: b.version ?? '?', w: shortDate(b.at) }) : ('not built' | t) }}</small></div>
                @if (b?.flash) {
                  <div class="st-tile"><span>Flash</span><b>{{ b.flash.pct }}%</b><small>{{ fmt('{u} of {t}', { u: size(b.flash.used), t: size(b.flash.total) }) }}</small>
                    <div class="st-meter" [attr.data-tone]="b.flash.pct > 85 ? 'warn' : null"><i [style.width.%]="b.flash.pct"></i></div></div>
                }
                @if (b?.ram) {
                  <div class="st-tile"><span>RAM</span><b>{{ b.ram.pct }}%</b><small>{{ fmt('{u} of {t}', { u: size(b.ram.used), t: size(b.ram.total) }) }}</small>
                    <div class="st-meter" [attr.data-tone]="b.ram.pct > 85 ? 'warn' : null"><i [style.width.%]="b.ram.pct"></i></div></div>
                }
                <div class="st-tile" [attr.data-tone]="c['files']?.length ? null : 'dim'"><span>{{ 'Files' | t }}</span><b>{{ c['files']?.length ?? '–' }}</b><small>{{ c['version'] != null ? 'v' + c['version'] : '' }}&nbsp;</small></div>
              </div>
              <div class="dmv-grid2 dmv-fw">
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Files' | t }}</h3><span class="st-sub">{{ fmt('{n} files', { n: c['files']?.length ?? 0 }) }}</span></div>
                  <div class="st-table-wrap dmv-pinscroll"><table class="st-table">
                    <thead><tr><th>{{ 'Path' | t }}</th><th class="r">{{ 'Size' | t }}</th><th></th></tr></thead>
                    <tbody>@for (x of c['files'] ?? []; track x.path) {
                      <tr><td class="mono">{{ x.path }}</td><td class="r mono">{{ size(x.bytes) }}</td><td class="dim">{{ x.generated ? ('generated' | t) : '' }}</td></tr>
                    } @empty { <tr><td colspan="3" class="dim">{{ 'No source was sent with it.' | t }}</td></tr> }</tbody>
                  </table></div>
                </section>
                @if (pinRows(c).length) {
                  <aside class="st-card dmv-pins">
                    <div class="st-card-head"><h3>{{ 'Pins' | t }}</h3><span class="st-sub">{{ fmt('{n} nets wired', { n: pinRows(c).length }) }}</span></div>
                    <div class="dmv-pinscroll"><table class="st-table">
                      <thead><tr><th>{{ 'Net' | t }}</th><th class="r">GPIO</th></tr></thead>
                      <tbody>@for (r of pinRows(c); track r[0]) { <tr><td class="mono">{{ r[0] }}</td><td class="r mono">{{ r[1] }}</td></tr> }</tbody>
                    </table></div>
                  </aside>
                }
              </div>
              }
            }

            <!-- ======================= a project ======================= -->
            @case ('project') {
              @let ps = projStats();
              <div class="st-tiles dmv-tiles">
                <div class="st-tile"><span>{{ 'Models' | t }}</span><b>{{ ps.models }}</b><small>{{ c['name'] }}/</small></div>
                @for (g of ps.groups.slice(0, 3); track g.name) { <div class="st-tile"><span>{{ g.name }}</span><b>{{ g.value }}</b><small>{{ 'models' | t }}</small></div> }
                <div class="st-tile" [attr.data-tone]="ps.known ? (ps.broken ? 'danger' : ps.stale ? 'warn' : 'ok') : 'dim'"><span>{{ 'Built' | t }}</span>
                  <b>{{ ps.known ? ps.built + ' / ' + ps.models : '–' }}</b><small>{{ ps.known ? fmt('{s} changed since · {e} failed', { s: ps.stale, e: ps.broken }) : '' }}&nbsp;</small></div>
                <div class="st-tile" [attr.data-tone]="ps.boards ? null : 'dim'"><span>{{ 'Boards' | t }}</span><b>{{ ps.boards }}</b><small>&nbsp;</small></div>
              </div>
              <div class="dmv-grid2">
                <section class="st-card">
                  <div class="st-card-head"><h3>{{ 'Models' | t }}</h3><span class="st-sub">{{ ps.models }}</span></div>
                  <div class="st-table-wrap dmv-bom"><table class="st-table">
                    <thead><tr><th>{{ 'Model' | t }}</th><th>{{ 'Path' | t }}</th><th class="r">{{ 'Version' | t }}</th><th>{{ 'State' | t }}</th><th class="r">{{ 'Imports' | t }}</th></tr></thead>
                    <tbody>@for (x of c['models']; track x.id) {
                      <tr><td>{{ x.title }}</td><td class="mono dim">{{ rel(x.id, c['name']) }}</td><td class="r mono">{{ x.version != null ? 'v' + x.version : '–' }}</td>
                        <td>@if (x.version !== undefined) { <span class="st-tag" [attr.data-tone]="x.error ? 'danger' : x.stale ? 'warn' : x.built != null ? 'ok' : null">{{ (x.error ? 'failed' : x.stale ? 'changed since' : x.built != null ? 'built' : 'not built') | t }}</span> }</td>
                        <td class="r mono">{{ x.uses ?? '' }}</td></tr>
                    }</tbody>
                  </table></div>
                </section>
                <div class="dmv-stack">
                  @if (ps.groups.length) {
                    <section class="st-card"><div class="st-card-head"><h3>{{ 'Models by folder' | t }}</h3></div>
                      <div class="st-card-body"><app-bar-list [rows]="ps.groups" /></div></section>
                  }
                  <section class="st-card">
                    <div class="st-card-head"><h3>{{ 'Boards' | t }}</h3><span class="st-sub">{{ ps.boards }}</span></div>
                    @if (c['boards']?.length) {
                      <div class="st-table-wrap"><table class="st-table">
                        <thead><tr><th>{{ 'Board' | t }}</th><th>{{ 'Size' | t }}</th><th class="r">{{ 'Parts' | t }}</th><th class="r">DRC</th><th class="r">{{ 'Version' | t }}</th></tr></thead>
                        <tbody>@for (x of c['boards']; track x.id) {
                          <tr><td>{{ x.title }} <span class="mono dim">{{ x.id }}</span></td><td class="mono">{{ x.size_mm ? x.size_mm[0] + ' × ' + x.size_mm[1] : '–' }}</td>
                            <td class="r mono">{{ x.parts ?? '–' }}</td><td class="r mono" [class.dmv-bad]="x.drc">{{ x.drc ?? '–' }}</td><td class="r mono">{{ x.version != null ? 'v' + x.version : '–' }}</td></tr>
                        }</tbody>
                      </table></div>
                    } @else { <p class="st-hint dmv-pad">{{ 'No boards in it.' | t }}</p> }
                  </section>
                </div>
              </div>
            }
            @default {
              <dl class="dmv-dl">@for (kv of pairs(c); track kv[0]) { <dt>{{ kv[0] }}</dt><dd>{{ kv[1] }}</dd> }</dl>
            }
          }
        </div>
      } @else {
        @if (err()) { <p class="tcv-dm-dtext tcv-dm-err">{{ err() }}</p> } @else { <wb-skel kind="text" [count]="5" style="padding: 4px 0 10px" /> }
        <div class="tcv-dm-drow"><button type="button" class="tcv-btn tcv-dm-dbtn" (click)="close()">{{ 'Close' | t }}</button></div>
      }
    </div>
  </div>
}`,
})
export class DmViewer {
  store = inject(DmStore);
  auth = inject(Auth);
  private api = inject(DmApi);
  data = signal<DmSnapshot | null>(null);
  err = signal<string | null>(null);
  down = 0;
  readonly t = t;
  readonly moneyIn = moneyIn;
  readonly moneyAlt = moneyAlt;
  readonly moneyTip = moneyTip;
  readonly strengths = STRENGTHS;
  readonly domains = DOMAINS;
  readonly PHOTO = 'M4 6h16v13H4z M4 15l4.5-4.5 4 4 2.5-2.5L20 17 M15.5 9.5h.01';

  // the view chosen in the head: per kind, kept for the session
  private chosen = signal<Record<string, string>>({ ...LAST_TAB });
  tabs = computed<{ id: string; label: string }[]>(() => {
    const d = this.data();
    if (!d) return [];
    const c = d.data;
    // things made of code: the picture and the code, each tab the whole body; a board has three pictures
    if (d.kind === 'model') return [{ id: 'view', label: 'View' }, { id: 'code', label: 'Code' }];
    if (d.kind === 'board') return [{ id: '3d', label: '3D' }, { id: 'layout', label: 'Layout' }, { id: 'schematic', label: 'Schematic' }, { id: 'code', label: 'Code' }];
    if (d.kind === 'file' && c['preview'] === 'markdown' && c['text']) return [{ id: 'rendered', label: 'Rendered' }, { id: 'source', label: 'Source' }];
    if (d.kind === 'firmware') return [{ id: 'overview', label: 'Overview' }, { id: 'code', label: 'Code' }];
    return [];
  });
  tab = computed(() => {
    const d = this.data(), tabs = this.tabs();
    if (!d || !tabs.length) return '';
    const want = this.chosen()[d.kind];
    return tabs.some(x => x.id === want) ? want : d.kind === 'board' ? 'layout' : tabs[0].id;
  });
  /** A view that fills the body (code, a 3D, a drawing) - the body itself does not scroll then. */
  full = computed(() => ['code', '3d', 'schematic', 'layout'].includes(this.tab()) || (this.data()?.kind === 'model' && this.tab() === 'view')
    || (this.data()?.kind === 'file' && !!this.data()?.blobs['file']));
  setTab(id: string) {
    const k = this.data()?.kind;
    if (!k) return;
    LAST_TAB[k] = id;
    this.chosen.update(x => ({ ...x, [k]: id }));
  }
  tabKey(e: KeyboardEvent) {
    const tabs = this.tabs(), i = tabs.findIndex(x => x.id === this.tab());
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    this.setTab(next.id);
    setTimeout(() => (document.getElementById('dmv-tab-' + next.id) as HTMLElement | null)?.focus());
  }
  sourceFiles = computed(() => {
    const src = (this.data()?.data['sources'] ?? {}) as Record<string, string>;
    return Object.keys(src).map(p => ({ name: p.split('/').pop() || p, sub: p, text: src[p], lang: langOf(p) }) as CodeFile);
  });

  // the palette's filters
  tq = signal('');
  tDomain = signal<Domain | ''>('');
  tStrength = signal<Strength | ''>('');
  // the model's tree and what is isolated in it
  tree = signal<BodyNode[]>([]);
  focus = signal<string | null>(null);
  /** The groups folded shut in the part tree, by path. */
  partsShut = signal<Set<string>>(new Set());
  // the product's pictures
  shot = signal<string | null>(null);
  broken = signal<Set<string>>(new Set());
  pcbView = signal('');
  bomQ = signal('');

  constructor() {
    // Open, it has a history entry of its own: Back closes it (nav.ts).
    navBoxFollows(this.store.viewing, () => this.close());
    effect(() => {
      const sid = this.store.viewing();
      untracked(() => {
        this.data.set(null); this.err.set(null);
        this.tq.set(''); this.tDomain.set(''); this.tStrength.set('');
        this.tree.set([]); this.focus.set(null); this.partsShut.set(new Set()); this.shot.set(null); this.broken.set(new Set()); this.pcbView.set(''); this.sheetView.set(''); this.bomQ.set('');
        if (sid) this.api.snapshot(sid).subscribe({
          next: d => { if (this.store.viewing() === sid) this.data.set(d); },
          error: e => this.err.set(e?.status === 404 ? t('It was taken back, or the line was deleted.') : (e?.error?.detail || t('could not read it'))),
        });
      });
    });
  }
  close() { this.store.viewing.set(null); }
  scrimClick() { if (this.down) this.close(); }
  /** Sent from my own space: nothing to add (the card opens the original). */
  ownHere(d: DmSnapshot) { return d.by?.id === this.store.state()?.me; }
  blob(d: DmSnapshot, label: string) { return `/api/dm/items/${encodeURIComponent(d.snap)}/blob/${label}`; }
  icon(k: DmKind) { return DM_ICONS[k]; }
  kindName(k: DmKind) { return DM_KIND_NAME[k]; }
  addLabel(k: DmKind) { return DM_ADD[k] ?? null; }
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
  private loc() { return LANG() === 'tr' ? 'tr-TR' : 'en-GB'; }
  stamp(iso: string) {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleString(this.loc(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  shortDate(iso: string | null | undefined) {
    if (!iso) return '–';
    const d = new Date(iso);
    return isNaN(+d) ? String(iso) : d.toLocaleString(this.loc(), { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  shortDay(iso: string) {
    const d = new Date(iso);
    return isNaN(+d) ? iso : d.toLocaleDateString(this.loc(), { day: 'numeric', month: 'short', year: 'numeric' });
  }
  num(n: number) { return new Intl.NumberFormat(this.loc()).format(n); }
  pct(n: number, of: number) { return of ? Math.round(100 * n / of) : 0; }
  size(n: number | undefined) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < 3) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : String(v)) + ' ' + u[i];
  }
  qty(v: unknown) { const f = Number(v ?? 0); return isFinite(f) ? (Number.isInteger(f) ? String(f) : String(+f.toFixed(3))) : String(v); }
  pairs(o: Record<string, unknown> | null | undefined): [string, string][] {
    return Object.entries(o ?? {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
      .map(([k, v]) => [k, String(v)] as [string, string]);
  }

  // ---------------------------------------------------------------- taste
  dc(d: Domain) { return DOMAIN_COLOR[d] ?? DOMAIN_COLOR.general; }
  sc(s: Strength) { return STRENGTH_COLOR[s]; }
  strengthLabel(s: Strength) { return STRENGTHS.find(x => x.id === s)?.label ?? s; }
  count(items: Rule[], s: Strength) { return items.filter(i => i.strength === s).length; }
  taste = computed(() => {
    const raw = (this.data()?.data['items'] ?? []) as Partial<Rule>[];
    const all: Rule[] = raw.map(i => ({
      text: i.text ?? '', why: i.why, strength: (['must', 'prefer', 'avoid'].includes(i.strength as string) ? i.strength : 'prefer') as Strength,
      domain: (DOMAINS.some(x => x.id === i.domain) ? i.domain : 'general') as Domain,
    }));
    const str: Tally = { must: 0, prefer: 0, avoid: 0 };
    const byDomain: Partial<Record<Domain, number>> = {};
    for (const i of all) { str[i.strength]++; byDomain[i.domain] = (byDomain[i.domain] ?? 0) + 1; }
    const domains = DOMAINS.filter(x => byDomain[x.id]);
    const most = Math.max(1, ...domains.map(x => byDomain[x.id] ?? 0));
    const rows = domains.map(x => {
      const its = all.filter(i => i.domain === x.id);
      const s: Tally = { must: this.count(its, 'must'), prefer: this.count(its, 'prefer'), avoid: this.count(its, 'avoid') };
      return { id: x.id, label: x.label, s, total: its.length, w: 100 * its.length / most };
    });
    const w = this.tq().trim().toLocaleLowerCase(), fd = this.tDomain(), fs = this.tStrength();
    const shown = all.filter(i => (!fd || i.domain === fd) && (!fs || i.strength === fs)
      && (!w || (i.text + ' ' + (i.why ?? '')).toLocaleLowerCase().includes(w)));
    const order: Record<Strength, number> = { must: 0, prefer: 1, avoid: 2 };
    const cols = domains.map(x => ({ id: x.id, label: x.label,
      items: shown.filter(i => i.domain === x.id).sort((a, b) => order[a.strength] - order[b.strength]) })).filter(c => c.items.length);
    return { all, str, byDomain, domains, rows, cols, shown: shown.length };
  });

  // ---------------------------------------------------------------- model
  viewerSrc = computed(() => { const d = this.data(); return d ? { kind: 'tcv' as const, url: this.blob(d, 'viewer') } : null; });
  leafName(path: string) { return path.split('/').pop() || path; }
  /** The part tree's rows with what is inside a shut group left out. */
  shownNodes<N extends { path: string }>(nodes: N[]): N[] {
    const shut = this.partsShut();
    if (!shut.size) return nodes;
    return nodes.filter(n => { const p = n.path.split('/'); return !p.some((_, i) => i < p.length - 1 && shut.has(p.slice(0, i + 1).join('/'))); });
  }
  foldPart(path: string) { this.partsShut.update(s => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; }); }
  /** Every group shut, or - when any is shut - all open again. */
  shutAll(nodes: { path: string; leaf: boolean }[]) {
    this.partsShut.set(this.partsShut().size ? new Set() : new Set(nodes.filter(n => !n.leaf).map(n => n.path)));
  }
  model = computed(() => {
    const d = this.data();
    const c = d?.data ?? {};
    const lines: string[] = c['lines'] ?? [];
    // Sizes: kept with the snapshot since it carries them; read back from its lines for one sent before.
    let overall: number[] | null = c['sizes']?.overall ?? null;
    let parts: { part: string; size?: number[] }[] = c['sizes']?.parts ?? [];
    if (!overall) {
      const m = lines.map(l => /overall ([\d.]+) x ([\d.]+) x ([\d.]+) mm/.exec(l)).find(x => x);
      if (m) overall = [+m[1], +m[2], +m[3]];
    }
    if (!parts.length) {
      const l = lines.find(x => /^Parts \(\d+\): /.test(x));
      if (l) parts = l.replace(/^Parts \(\d+\): /, '').split('; ').map(s => {
        const m = /^(.*?) ([\d.]+)x([\d.]+)x([\d.]+) mm$/.exec(s);
        return m ? { part: m[1], size: [+m[2], +m[3], +m[4]] } : { part: s };
      });
    }
    const sizeOf = new Map(parts.map(p => [p.part, p.size]));
    const dims = (s?: number[]) => s ? s.map(v => +v.toFixed(1)).join(' × ') : '';
    const tree = this.tree();
    const nodes = tree.length
      ? tree.map(n => ({ ...n, size: dims(sizeOf.get(n.path)) }))
      : parts.map(p => ({ path: p.part, name: p.part.split('/').pop() || p.part, depth: p.part.split('/').length - 1, leaf: true, size: dims(p.size) }));
    const models = (c['models'] ?? {}) as Record<string, { title: string; source: string }>;
    const ids = Object.keys(models).sort((a, b) => (a === c['id'] ? -1 : b === c['id'] ? 1 : 0));
    const files: CodeFile[] = ids.map(id => ({ name: models[id].title || id, sub: id + '.3d', text: models[id].source || '', lang: 'python' }));
    return {
      size: overall ? dims(overall) + ' mm' : '', nodes,
      parts: tree.length ? tree.filter(n => n.leaf).length : parts.length,
      groups: tree.filter(n => !n.leaf).length,
      imports: (c['uses'] ?? []).length || Math.max(0, ids.length - 1), files,
    };
  });

  // ---------------------------------------------------------------- product
  private pics = computed(() => {
    const p = this.data()?.data['product'] ?? {};
    const b = this.broken();
    return [...new Set([p.image, ...(p.images ?? [])].filter((u: string) => !!u && !b.has(u)))].slice(0, 12) as string[];
  });
  gallery = this.pics;
  bigImg = computed(() => { const s = this.shot(), g = this.gallery(); return s && g.includes(s) ? s : g[0] ?? null; });
  broke(src: string) { if (!this.broken().has(src)) this.broken.update(s => new Set(s).add(src)); }
  fav(c: Record<string, any>) {
    const p = c['product'] ?? {};
    const h = p.seller?.host || p.seller?.domain || c['maker']?.domain;
    return h ? `https://${h.startsWith('www.') || h.split('.').length > 2 ? h : 'www.' + h}/favicon.ico` : '';
  }
  sellerName(c: Record<string, any>) {
    const p = c['product'] ?? {};
    return p.seller?.name || p.seller?.domain || c['maker']?.domain || c['maker']?.name || '';
  }
  stockName(p: { stock?: 'in' | 'out'; stock_qty?: number }) {
    if (p.stock === 'out') return t('Out of stock');
    return p.stock_qty != null ? this.fmt('{n} left', { n: p.stock_qty }) : t('In stock');
  }
  specs(p: { specs?: Record<string, string> }) { return Object.entries(p.specs ?? {}); }
  histRows(p: { history?: { at: string; amount?: number; currency?: string; vat?: string; stock?: string; qty?: number }[] }) {
    const h = p.history ?? [];
    return h.map((x, i) => {
      const prev = h[i - 1];
      const change = prev?.amount && x.amount != null && prev.currency === x.currency ? (x.amount - prev.amount) / prev.amount * 100 : 0;
      return { ...x, change: Math.abs(change) < 0.05 ? 0 : change };
    }).reverse();
  }
  priceChart = computed(() => {
    const p = this.data()?.data['product'];
    const h = (p?.history ?? []) as { at: string; amount?: number; currency?: string }[];
    const cur = p?.price?.currency ?? h.find(x => x.currency)?.currency ?? '';
    const pts = h.filter(x => x.amount != null && (!x.currency || x.currency === cur)).map(x => ({ at: x.at, v: x.amount! }));
    return pts.length >= 2 ? readingSeries(pts, t('Price'), this.data()?.at) : null;
  });
  priceFmt = computed(() => {
    const cur = this.data()?.data['product']?.price?.currency ?? '';
    return (v: number) => moneyIn(v, cur);
  });

  // ---------------------------------------------------------------- stock
  qtyChart = computed(() => {
    const log = (this.data()?.data['log'] ?? []) as { at: string; after?: number }[];
    return readingSeries(log.filter(l => l.after != null).map(l => ({ at: l.at, v: l.after! })), t('Quantity'), this.data()?.at);
  });
  logRows(c: Record<string, any>) { return [...(c['log'] ?? [])].reverse(); }
  invFields(c: Record<string, any>): [string, string][] {
    const f: [string, unknown][] = [['Type', [c['type'], c['subtype']].filter(x => x).join(' · ').replace(/[-_]/g, ' ')], ['Category', c['category']], ['Manufacturer', c['manufacturer']], ['MPN', c['mpn']],
      ['LCSC', c['lcsc']], ['For (board or model)', c['board']], ['Unit', c['unit']]];
    return f.filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
  }

  // ---------------------------------------------------------------- note
  noteStats = computed(() => {
    const text: string = this.data()?.data['text'] ?? '';
    const words = (text.replace(/[#*_`>\[\]()-]/g, ' ').match(/\S+/g) ?? []).length;
    const todos = (text.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length;
    const done = (text.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length;
    return { words, minutes: Math.max(1, Math.round(words / 200)), todos, done };
  });
  tagLine(c: Record<string, any>) { return (c['tags'] ?? []).map((x: string) => '#' + x).join(' '); }

  // ---------------------------------------------------------------- file
  lineCount(s: string) { return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0; }
  /** The file as FileView takes it - one object per snapshot, or it would read it again on every check. */
  fileStored = computed<StoredFile | null>(() => {
    const d = this.data();
    if (!d) return null;
    const c = d.data;
    return { id: '', name: c['name'] || d.label, bytes: c['bytes'] || 0, kind: c['kind'] || 'file', content_type: d.blobs['file']?.type || '',
             context: {}, by: {}, note: c['note'] || '', created_at: d.at, folder: '', preview: c['preview'] || 'none' };
  });
  /** A CSV or TSV that was sent with its text: its rows, cut into cells. */
  fileTable = computed(() => {
    const d = this.data();
    if (d?.kind !== 'file') return null;
    const c = d.data, text: string = c['text'] ?? '';
    const tb = c['table'] as { rows?: unknown[][]; total?: number; sheets?: string[] } | undefined;
    if (tb?.rows?.length) {
      const rows = tb.rows.map(r => r.map(x => x == null ? '' : String(x)));
      return { rows, cols: Math.max(...rows.map(r => r.length)), total: Math.max((tb.total ?? rows.length) - 1, rows.length - 1), sheets: tb.sheets?.length ?? 1 };
    }
    const name = String(c['name'] ?? '').toLowerCase();
    if (!text || !(c['kind'] === 'table' || c['kind'] === 'bom' || c['kind'] === 'pick-place' || /\.(csv|tsv)$/.test(name))) return null;
    const first = text.split('\n', 1)[0];
    const sep = name.endsWith('.tsv') || first.split('\t').length > first.split(',').length ? '\t'
      : first.split(';').length > first.split(',').length ? ';' : ',';
    const rows = parseDelimited(text, sep, 2000);
    if (rows.length < 2) return null;
    return { rows, cols: Math.max(...rows.map(r => r.length)), total: rows.length - 1, sheets: 1 };
  });
  oneFile = computed<CodeFile[]>(() => {
    const d = this.data();
    return d ? [{ name: d.data['name'] || d.label, sub: d.data['name'] || d.label, text: d.data['text'] ?? '' }] : [];
  });
  readonly FILE = 'M6 3h8l4 4v14H6z M14 3v4h4';
  readonly FOLDER = 'M3 6h7l2 2h9v11H3z';
  kindLabel(kind: string | undefined, pv: string) {
    const k: Record<string, string> = { image: 'Image', pdf: 'PDF', video: 'Video', audio: 'Sound', markdown: 'Markdown', table: 'Table',
      archive: 'Archive', mesh: '3D mesh', step: 'STEP', text: 'Text' };
    const n: Record<string, string> = { file: 'File', bom: 'BOM', 'pick-place': 'Pick & place', gerber: 'Gerber', drill: 'Drill' };
    return n[kind ?? ''] ?? k[pv] ?? (kind || 'File');
  }
  /** An archive's entries as a tree: folders before what is in them, each indented by its depth. */
  archRows = computed(() => {
    const es = (this.data()?.data['entries']?.entries ?? []) as { name: string; bytes: number; packed?: number; dir?: boolean }[];
    const all = new Map<string, { name: string; bytes: number; packed?: number; dir: boolean }>();
    for (const e of es) {
      const clean = e.name.replace(/\/+$/, '');
      const parts = clean.split('/');
      for (let i = 1; i < parts.length; i++) { const k = parts.slice(0, i).join('/'); if (!all.has(k)) all.set(k, { name: k, bytes: 0, dir: true }); }
      all.set(clean, { name: clean, bytes: e.bytes, packed: e.packed, dir: !!e.dir });
    }
    return [...all.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ ...e, depth: e.name.split('/').length - 1, leaf: e.name.split('/').pop() + (e.dir ? '/' : '') }));
  });
  archFolders = computed(() => this.archRows().filter(e => e.dir).length);
  archPacked = computed(() => this.archRows().some(e => e.packed != null));

  // ---------------------------------------------------------------- board
  /** The board's figures: kept with the snapshot, or read back from the lines of one sent before. */
  bf = computed<any>(() => {
    const c = this.data()?.data ?? {};
    return c['facts'] ?? boardFactsFromLines(c['lines'] ?? []);
  });
  boardViews = computed(() => {
    const b = this.data()?.blobs ?? {};
    return [{ id: 'layout', label: 'Top' }, { id: 'bottom', label: 'Bottom' }].filter(v => b[v.id]);
  });
  /** The schematic: its overview, then each sheet sent with it. */
  sheets = computed(() => {
    const d = this.data(), b = d?.blobs ?? {};
    const named = ((d?.data['facts']?.schematic?.sheets ?? []) as { key?: string; name?: string }[])
      .filter(x => x.key && b['sheet-' + x.key]).map(x => ({ id: 'sheet-' + x.key, label: x.name || x.key! }));
    return [...(b['schematic'] ? [{ id: 'schematic', label: 'Overview' }] : []), ...named];
  });
  sheetView = signal('');
  sheet = computed(() => { const v = this.sheets(); return v.find(x => x.id === this.sheetView())?.id ?? v[0]?.id ?? null; });
  boardView = computed(() => { const v = this.boardViews(); return v.find(x => x.id === this.pcbView())?.id ?? v[0]?.id ?? null; });
  pictures = computed<Record<string, StoredFile>>(() => {
    const d = this.data();
    const out: Record<string, StoredFile> = {};
    for (const v of [...this.boardViews(), ...this.sheets()]) out[v.id] = { id: '', name: (d?.label ?? '') + ' · ' + v.id, bytes: d?.blobs[v.id]?.bytes ?? 0, kind: 'image',
      content_type: 'image/svg+xml', context: {}, by: {}, note: '', created_at: d?.at ?? '', folder: '', preview: 'image' };
    return out;
  });
  /** A check's findings by rule, errors first: rows for a BarList. */
  ruleRows(x: { errors?: Record<string, number>; warnings?: Record<string, number> } | null | undefined): Row[] {
    if (!x) return [];
    const nice = (k: string) => k.replace(/_/g, ' ');
    return [...Object.entries(x.errors ?? {}).map(([k, v]) => ({ name: nice(k), value: v, sub: t('error') })),
            ...Object.entries(x.warnings ?? {}).map(([k, v]) => ({ name: nice(k), value: v, sub: t('warning') }))]
      .sort((a, b) => b.value - a.value).slice(0, 8);
  }
  countPairs(o: Record<string, unknown> | null | undefined): [string, string][] {
    return Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number').slice(0, 6)
      .map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '), String(v)] as [string, string]);
  }
  classNets(r: { nets?: string[]; patterns?: string[] }) {
    const all = [...(r.nets ?? []), ...(r.patterns ?? [])];
    return all.length ? all.join(', ') : t('the rest');
  }
  limitPairs(b: Record<string, unknown> | null | undefined): [string, string][] {
    const name: Record<string, string> = { min_track: 'Track', min_clearance: 'Clearance', min_via: 'Via', min_drill: 'Drill', min_edge: 'To the edge' };
    return Object.entries(b ?? {}).filter(([k]) => name[k]).map(([k, v]) => [name[k], String(v)] as [string, string]);
  }
  bomShown = computed(() => {
    const w = this.bomQ().trim().toLocaleLowerCase();
    return this.boardStats().groups.filter(g => !w || [g.refs, g.value, g.footprint, g.lcsc].join(' ').toLocaleLowerCase().includes(w));
  });
  boardStats = computed(() => {
    const bom = (this.bf()['bom'] ?? []) as { ref?: string; value?: string; footprint?: string; lcsc?: string }[];
    const prefix = new Map<string, number>();
    const groups = new Map<string, { n: number; value: string; footprint: string; lcsc: string; refs: string[] }>();
    for (const b of bom) {
      const refs = String(b.ref ?? '').split(/[,\s]+/).filter(x => x);
      for (const r of refs.length ? refs : ['?']) {
        const p = /^[A-Za-z]+/.exec(r)?.[0]?.toUpperCase() ?? '?';
        prefix.set(p, (prefix.get(p) ?? 0) + 1);
      }
      const key = [b.value, b.footprint, b.lcsc].join('|');
      const g = groups.get(key) ?? { n: 0, value: b.value ?? '', footprint: b.footprint ?? '', lcsc: b.lcsc ?? '', refs: [] };
      g.n += Math.max(1, refs.length); g.refs.push(...refs); groups.set(key, g);
    }
    const name: Record<string, string> = { R: 'Resistors', C: 'Capacitors', U: 'ICs', L: 'Inductors', D: 'Diodes', LED: 'LEDs',
      Q: 'Transistors', J: 'Connectors', P: 'Connectors', SW: 'Switches', Y: 'Crystals', X: 'Crystals', F: 'Fuses', H: 'Holes', TP: 'Test points' };
    const merged = new Map<string, number>();
    for (const [p, n] of prefix) { const k = name[p] ? t(name[p]) : p; merged.set(k, (merged.get(k) ?? 0) + n); }
    const byPrefix: Row[] = [...merged].map(([k, v]) => ({ name: k, value: v })).sort((a, b) => b.value - a.value).slice(0, 10);
    const list = [...groups.values()].sort((a, b) => b.n - a.n).map(g => ({ ...g, refs: g.refs.join(', ') }));
    return { parts: [...prefix.values()].reduce((a, b) => a + b, 0), kinds: list.length, byPrefix, groups: list };
  });
  netRows(nets: { name: string; pins: number }[]): Row[] { return nets.slice(0, 10).map(n => ({ name: n.name, value: n.pins })); }

  // ---------------------------------------------------------------- project
  rel(id: string, root: string) { return id.startsWith(root + '/') ? id.slice(root.length + 1) : id; }
  projStats = computed(() => {
    const c = this.data()?.data ?? {};
    const models = (c['models'] ?? []) as { id: string; version?: number; built?: number | null; stale?: boolean; error?: boolean }[];
    const root = c['name'] ?? '';
    const by = new Map<string, number>();
    for (const m of models) { const r = this.rel(m.id, root).split('/'); const g = r.length > 1 ? r[0] : t('top'); by.set(g, (by.get(g) ?? 0) + 1); }
    const groups: Row[] = [...by].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    return { models: models.length, boards: (c['boards'] ?? []).length, groups, known: models.some(m => m.version !== undefined),
             built: models.filter(m => m.built != null && !m.stale && !m.error).length, stale: models.filter(m => m.stale).length,
             broken: models.filter(m => m.error).length };
  });

  // ---------------------------------------------------------------- firmware
  fwFiles = computed(() => {
    const c = this.data()?.data ?? {};
    const src = (c['sources'] ?? {}) as Record<string, string>;
    const rank = (p: string) => /main\.(cpp|c|ino)$/.test(p) ? 0 : p.startsWith('src/') ? 1 : p.startsWith('include/') ? 2 : 3;
    return Object.keys(src).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map(p => ({ name: p.split('/').pop() || p, sub: p, text: src[p], lang: langOf(p) }) as CodeFile);
  });
  pinRows(c: Record<string, any>): [string, string][] {
    return Object.entries((c['pins'] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string])
      .sort((a, b) => +a[1] - +b[1]);
  }
}

/** Rows of a CSV/TSV, quotes understood; at most `max` rows. */
export function parseDelimited(text: string, sep: string, max: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && !cell) q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if ((cell || row.length) && rows.length < max) { row.push(cell); rows.push(row); }
  return rows;
}

/** A board's figures read back from the text lines a snapshot sent before
 *  carried (backend/cc_context.py board_parts): never shown as they are. */
export function boardFactsFromLines(lines: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  const json = (s: string | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  let inBom = false;
  const bom: { ref: string; value: string; footprint: string; lcsc: string }[] = [];
  for (const l of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^Version: (\d+|\?); saved (\S+)/.exec(l))) { out['version'] = m[1] === '?' ? null : +m[1]; out['saved_at'] = m[2]; }
    else if ((m = /^Layout: (\d+) parts placed, size (\[[^\]]*\]) mm/.exec(l))) out['layout'] = { placed: +m[1], size_mm: json(m[2]) };
    else if (l.startsWith('Routing: ')) out['route'] = json(l.slice(9));
    else if ((m = /^DRC \([^)]*\): (\d+) errors, (\d+) warnings, (\w+) unconnected/.exec(l))) {
      const e = /Errors (\{.*?\}); warnings (\{.*?\})/.exec(l);
      out['drc'] = { error_count: +m[1], warning_count: +m[2], unconnected: +m[3] || 0, errors: json(e?.[1]) ?? {}, warnings: json(e?.[2]) ?? {},
                     examples: (/\. Examples: (.*)$/.exec(l)?.[1] ?? '').split('; ').filter(x => x).slice(0, 20) };
    }
    else if ((m = /^Schematic: (\d+) parts, (\d+) wires, (\d+) symbols/.exec(l))) out['schematic'] = { parts: +m[1], wires: +m[2], symbols: +m[3], sheets: [] };
    else if (l.startsWith('Schematic sheets: ') && out['schematic']) {
      out['schematic'].sheets = l.slice(18).split('; ').map(x => { const k = /^(.*) \((\d+) parts\)$/.exec(x); return { name: k?.[1] ?? x, parts: k ? +k[2] : null }; });
    }
    else if ((m = /^ERC: (\d+) errors, (\d+) warnings; errors (\{.*?\}); warnings (\{.*\})$/.exec(l))) {
      out['erc'] = { error_count: +m[1], warning_count: +m[2], errors: json(m[3]) ?? {}, warnings: json(m[4]) ?? {} };
    }
    else if (l.startsWith('Design rules: ')) { const r = json(l.slice(14)); if (r) out['rules'] = r; }
    else if ((m = /^Netlist \(built [^)]*\): (\{.*\})$/.exec(l))) out['counts'] = json(m[1]) ?? {};
    else if (l.startsWith('Nets by size: ')) {
      out['nets'] = l.slice(14).split('; ').map(x => { const k = /^(.*) \((\d+) pins\)$/.exec(x); return k ? { name: k[1], pins: +k[2] } : null; }).filter(x => x);
    }
    else if (l.startsWith('Single-pin nets: ')) { const v = l.slice(17); out['single'] = v === 'none' ? [] : v.split(', '); }
    else if (l.startsWith('All nets: ')) out['net_count'] = l.slice(10).split(', ').length;
    else if (/^(BOM|Components) \(/.test(l)) { inBom = true; continue; }
    if (inBom && l.includes(' | ') && !/^(BOM|Components) \(/.test(l)) {
      const [ref, value, footprint, lcsc] = l.split(' | ').map(x => x.trim());
      bom.push({ ref, value, footprint, lcsc: lcsc ?? '' });
    } else if (inBom && !l.includes(' | ')) inBom = false;
  }
  if (bom.length) out['bom'] = bom;
  return out;
}
