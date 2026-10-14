import { Component, computed, input, output } from '@angular/core';
import { T } from './i18n';

/** A way out for an outside lookup (backend/netroutes.py). */
export type Route = 'local' | 'proxy' | 'jina';

export const ROUTE_INFO: Record<Route, { label: string; about: string }> = {
  local: { label: 'Local', about: 'from this machine' },
  proxy: { label: 'Proxy', about: 'through the proxy' },
  jina: { label: 'Jina', about: 'Jina Reader, web pages only' },
};

/** An order as one line: "Local > Proxy". */
export function routeLine(order: readonly string[] | null | undefined, tr: (s: string) => string): string {
  return (order ?? []).map(r => tr(ROUTE_INFO[r as Route]?.label ?? r)).join(' > ') || '–';
}

/** The order of routes a lookup tries (Settings > Proxy & Data, and a
 *  maker's own in Parts): one chip per route the lookup can
 *  take, in a row - the ones that are on first, numbered in the order they
 *  are tried, then the ones that are off. A chip moves left or right and
 *  turns on or off; a route that is not set up says why and is passed over.
 *  The routes a lookup cannot take (Jina for the Drawer's JSON lookups) are
 *  not in `routes`, so they are not shown at all. */
@Component({
  selector: 'app-route-order',
  imports: [T],
  template: `
<div class="ro" role="list" [style.grid-template-columns]="'repeat(' + chips().length + ', minmax(0, 1fr))'">
  @for (c of chips(); track c.id) {
    <div class="ro-chip" role="listitem" [attr.data-on]="c.on ? 1 : null" [attr.data-unready]="c.why ? 1 : null"
         [title]="c.why ? c.why : (c.about | t)">
      <span class="ro-n">{{ c.on ? c.n : '–' }}</span>
      <span class="ro-name"><b>{{ c.label | t }}</b>
        <small>{{ c.why ? ((c.on ? 'not set up - passed over' : 'not set up') | t) : (c.about | t) }}</small></span>
      @if (editable()) {
        <span class="ro-acts">
          @if (c.on) {
            <button type="button" class="ro-ib" [disabled]="c.n === 1" (click)="move(c.id, -1)"
                    [attr.aria-label]="'Try earlier' | t" [title]="'Try earlier' | t">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg></button>
            <button type="button" class="ro-ib" [disabled]="c.n === onCount()" (click)="move(c.id, 1)"
                    [attr.aria-label]="'Try later' | t" [title]="'Try later' | t">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button>
          }
          <button type="button" class="ro-sw" [attr.data-on]="c.on ? 1 : null" role="switch" [attr.aria-checked]="c.on"
                  [disabled]="c.on && onCount() === 1" (click)="toggle(c.id)"
                  [title]="(c.on && onCount() === 1 ? 'At least one route stays on' : c.on ? 'Turn off' : 'Turn on') | t">
            {{ (c.on ? 'On' : 'Off') | t }}</button>
        </span>
      } @else {
        <span class="ro-state">{{ (c.on ? 'On' : 'Off') | t }}</span>
      }
    </div>
  }
</div>`,
  styles: [`
:host { display: block; min-width: 0; }
.ro { display: grid; gap: 6px; min-width: 0; }
.ro-chip { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 8px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; opacity: .62; }
.ro-chip[data-on] { opacity: 1; border-color: var(--accent-deep); }
.ro-chip[data-on][data-unready] { border-color: var(--warn); }
.ro-n { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%;
  font-size: 10.5px; font-weight: 600; color: var(--ink-dim); border: 1px solid var(--line); }
.ro-chip[data-on] .ro-n { color: var(--ink-bright); background: var(--accent-deep); border-color: var(--accent-deep); }
.ro-name { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.ro-name b { font-size: 12px; font-weight: 600; color: var(--ink); }
.ro-name small { font-size: 10.5px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ro-chip[data-unready] .ro-name small { color: var(--warn); }
.ro-acts { flex: none; display: inline-flex; align-items: center; gap: 2px; }
.ro-ib { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; color: var(--ink-dim);
  background: none; border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
.ro-ib:hover:not(:disabled) { color: var(--ink); background: var(--hover); border-color: var(--line); }
.ro-ib:disabled { opacity: .3; cursor: default; }
.ro-ib svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.ro-sw { margin-left: 4px; min-width: 34px; padding: 2px 7px; font-size: 10.5px; color: var(--ink-dim);
  background: var(--surface); border: 1px solid var(--line); border-radius: 3px; cursor: pointer; }
.ro-sw[data-on] { color: var(--ink-bright); background: var(--accent-deep); border-color: var(--accent-deep); }
.ro-sw:disabled { cursor: default; }
.ro-state { flex: none; font-size: 10.5px; color: var(--ink-dim); }
@media (max-width: 720px) { .ro { grid-template-columns: minmax(0, 1fr) !important; } }
`],
})
export class RouteOrder {
  /** The routes this lookup can take, as the server lists them. */
  routes = input.required<readonly string[]>();
  /** The routes that are on, first tried first. */
  order = input.required<readonly string[]>();
  /** Why a route cannot be used now (not set up), by route; null when it can. */
  ready = input<Record<string, string | null | undefined>>({});
  editable = input(true);
  changed = output<string[]>();

  onCount = computed(() => this.order().filter(r => this.routes().includes(r)).length);
  chips = computed(() => {
    const on = this.order().filter(r => this.routes().includes(r));
    const off = this.routes().filter(r => !on.includes(r));
    const ready = this.ready();
    return [...on, ...off].map(id => ({
      id, on: on.includes(id), n: on.indexOf(id) + 1, why: ready[id] || null,
      label: ROUTE_INFO[id as Route]?.label ?? id, about: ROUTE_INFO[id as Route]?.about ?? '',
    }));
  });

  private current(): string[] { return this.order().filter(r => this.routes().includes(r)); }
  move(id: string, by: number) {
    const o = this.current();
    const i = o.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    this.changed.emit(o);
  }
  toggle(id: string) {
    const o = this.current();
    if (o.includes(id)) {
      if (o.length === 1) return;
      this.changed.emit(o.filter(r => r !== id));
    } else {
      this.changed.emit([...o, id]);
    }
  }
}
