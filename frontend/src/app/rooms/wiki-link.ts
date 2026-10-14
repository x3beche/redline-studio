import { Component, effect, inject, signal, untracked } from '@angular/core';
import { T } from '../i18n';
import { Selection } from '../selection';
import { navHref } from '../nav';

/** "iot-fan · Wiki": the open project's name and a link to its wiki, one
 *  small line in the 3D, PCB and Firmware rooms' side column (editor.html).
 *  Which project: the top folder of the model, board or firmware open
 *  (GET /api/wiki/for, backend/wiki.py project_of). Nothing when the thing
 *  open is in no project. Small on purpose: it is a way there, not a panel.
 *  Kept apart from rooms/wiki.ts so the shell does not load the room. */
@Component({
  selector: 'app-wiki-link',
  imports: [T],
  styles: [`
:host { display: contents; }
.wkl { flex: none; display: inline-flex; align-items: baseline; gap: 4px; max-width: 60%; min-width: 0; font-size: 11px;
  color: var(--ink-dim); text-decoration: none; white-space: nowrap; }
.wkl span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wkl b { flex: none; font-weight: 500; color: var(--ink); }
.wkl:hover b, .wkl:focus-visible b { color: var(--ink-bright); }
`],
  template: `
@if (project(); as p) {
  <a class="wkl" [href]="href(p)" [title]="('Open the project wiki' | t) + ' · ' + p"><span class="mono">{{ p }}</span> · <b>{{ 'Wiki' | t }}</b></a>
}`,
})
export class WikiLink {
  private picked = inject(Selection);
  project = signal<string | null>(null);
  private seq = 0;
  private cache = new Map<string, string | null>();

  constructor() {
    effect(() => {
      const room = this.picked.room();
      const ask = room === 'pcb' ? ['board', this.picked.board()] : room === 'firmware' ? ['firmware', this.picked.firmware()]
        : ['model', this.picked.model()];
      untracked(() => this.find(ask[0] as string, ask[1] as string | null));
    });
  }

  private find(kind: string, id: string | null) {
    const seq = ++this.seq;
    if (!id) { this.project.set(null); return; }
    const key = `${kind}:${id}`;
    if (this.cache.has(key)) { this.project.set(this.cache.get(key)!); return; }
    // A model's id names its project already; the server is asked for boards and firmware (their folder).
    if (kind === 'model' && id.includes('/')) { this.project.set(id.split('/')[0]); return; }
    fetch(`/api/wiki/for?kind=${kind}&id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { project?: string | null } | null) => {
        this.cache.set(key, d?.project ?? null);
        if (seq === this.seq) this.project.set(d?.project ?? null);
      })
      .catch(() => { if (seq === this.seq) this.project.set(null); });
  }

  href(p: string) { return navHref({ ws: 'wiki', project: p }); }
}
