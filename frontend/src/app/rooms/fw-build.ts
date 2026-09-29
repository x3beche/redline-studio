import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type * as Monaco from 'monaco-editor';
import { AppEntry, FwSymbol } from '../api';
import { T, t } from '../i18n';
import { loadMonaco, redlineTheme } from './code-view';

/** A node of what fills flash (backend/firmware.py size_tree): owner > archive > file > symbol. */
interface SizeNode {
  name: string; kind: 'root' | 'group' | 'archive' | 'file' | 'symbol' | 'rest';
  size: number; path?: string; file?: string | null; line?: number | null; children?: SizeNode[];
}
type Group = 'yours' | 'framework' | 'runtime';
interface Sizes {
  tool: string; total: number; at: string; groups: Record<Group, number>; tree: SizeNode;
  files: { name: string; path: string; archive: string; size: number }[];
  top: { name: string; size: number; file: string | null; line: number | null }[];
}
interface Change {
  state: 'none' | 'first' | 'same' | 'changed'; total: number | null; groups: Partial<Record<Group, number>>;
  regions: { name: string; used: number; size: number | null; delta: number }[];
  at: string | null; was_at: string | null; commit?: string | null; was_commit?: string | null;
}
interface BuildView {
  built: { at: string | null; ok: boolean | null; arch: string | null } | null;
  sizes: Sizes | null; change: Change;
}
interface Commit {
  hash: string; short: string; subject: string; author: string; when: string; at: string;
  files: number; added: number; removed: number;
}
interface WorkFile { path: string; state: string; added: number; removed: number; binary: boolean }
interface Commits { git: boolean; dir: string; commits: Commit[]; worktree: WorkFile[] }
interface DiffFile { path: string; added: number; removed: number; binary: boolean; before: string; after: string }
interface Diff { title: string; sub: string; files: DiffFile[] }

/** A tile of the treemap, in pixels of the map; inner tiles are a frame's children. */
interface Tile {
  node: SizeNode; group: Group; x: number; y: number; w: number; h: number;
  trail: SizeNode[]; inner: Tile[]; frame: boolean;
}

const GROUPS: Group[] = ['yours', 'framework', 'runtime'];
const HEAD = 17;         // a frame's name strip
const GAP = 2;

/** Squarified treemap (Bruls, Huizing, van Wijk): each row laid along the shorter side, rows kept as square as they
 *  go. Values sorted largest first; returns one rectangle per value, in order. */
export function squarify(values: number[], x: number, y: number, w: number, h: number)
  : { x: number; y: number; w: number; h: number }[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  if (!total || w <= 0 || h <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  const area = values.map(v => (v * w * h) / total);
  const worst = (sum: number, max: number, min: number, side: number) =>
    Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  let i = 0;
  while (i < area.length) {
    const side = Math.min(w, h);
    let sum = area[i], j = i + 1, now = worst(sum, area[i], area[i], side);
    while (j < area.length) {
      const next = worst(sum + area[j], area[i], area[j], side);
      if (next > now) break;
      now = next; sum += area[j]; j++;
    }
    const thick = sum / side;
    let at = 0;
    for (let k = i; k < j; k++) {
      const len = area[k] / thick;
      out.push(w >= h ? { x, y: y + at, w: thick, h: len } : { x: x + at, y, w: len, h: thick });
      at += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}

/** The children worth a tile: the largest ones up to 99.5% of the parent, at most 60; the rest folded into one. */
function shown(node: SizeNode): SizeNode[] {
  const kids = (node.children ?? []).filter(c => c.size > 0);
  const out: SizeNode[] = [];
  let acc = 0;
  for (const c of kids) {
    if (out.length >= 60 || (out.length >= 8 && acc >= node.size * 0.995)) break;
    out.push(c); acc += c.size;
  }
  const rest = kids.slice(out.length);
  if (rest.length) {
    out.push({ name: `${rest.length} ${t('more')}`, kind: 'rest', size: rest.reduce((a, c) => a + c.size, 0) });
  }
  return out;
}

/** The Embedded room's view of what the build made: what fills flash, the project's own files, and what changed.
 *  Lives in the room frame's view area (rooms/coding.ts), like the 3D and PCB rooms' views; the memory regions are
 *  the MCU side panel's, so they are not repeated here.
 *
 *  The treemap's areas are bytes (backend/firmware.py: esp-idf-size on ESP32, nm -l on STM32). Click a block to look
 *  inside it: owner, archive, file, function; a function picked becomes the note's Part. */
@Component({
  selector: 'app-fw-build',
  imports: [T],
  host: { class: 'block h-full w-full', '(keydown)': 'key($event)' },
  template: `
<div class="fwb tcv-scroll">
  @if (!view()) {
    <p class="empty">{{ 'Reading the build…' | t }}</p>
  } @else if (!view()!.sizes) {
    <section>
      <h3 class="tcv-label">{{ 'What fills flash' | t }}</h3>
      <p class="empty">{{ (view()!.built?.ok ? 'Build again to see what fills flash: this build predates the sizes.'
                                             : 'Build once to see what fills flash.') | t }}</p>
    </section>
  } @else {
    <div class="top">
      <!-- WHAT FILLS FLASH: areas are bytes. -->
      <section class="map-col">
        <h3 class="tcv-label head">{{ 'What fills flash' | t }}</h3>
        <div class="legend">
          @for (g of groups(); track g.id) {
            <button class="key" [attr.data-group]="g.id" (click)="zoomTo([root(), g.node])"
                    [title]="groupTip(g.id)">
              <i></i><span class="n">{{ groupName(g.id) }}</span>
              <span class="v">{{ kib(g.size) }} · {{ pct(g.size, sizes()!.total) }}</span>
            </button>
          }
        </div>
        <nav class="crumbs" [attr.aria-label]="'Where in flash' | t">
          @for (n of trail(); track $index; let last = $last) {
            @if (!last) {
              <button (click)="zoomTo(trail().slice(0, $index + 1))">{{ label(n) }}</button><span class="sep">›</span>
            } @else {
              <b>{{ label(n) }}</b><span class="v">{{ kib(n.size) }}</span>
            }
          }
        </nav>
        <div #map class="map" role="group" [attr.aria-label]="'What fills flash' | t">
          @for (tl of tiles(); track tl.node.name + tl.x) {
            <div class="tile" [class.frame]="tl.frame" [attr.data-group]="tl.group" [attr.data-kind]="tl.node.kind"
                 [attr.data-on]="isPicked(tl.node) ? 1 : null"
                 [style.left.px]="tl.x" [style.top.px]="tl.y" [style.width.px]="tl.w" [style.height.px]="tl.h"
                 [attr.tabindex]="tl.node.kind === 'rest' ? null : 0" [attr.role]="tl.node.kind === 'rest' ? null : 'button'"
                 [attr.aria-label]="label(tl.node) + ', ' + kib(tl.node.size)"
                 (click)="open(tl, $event)" (keydown.enter)="open(tl, $event)" (keydown.space)="open(tl, $event)"
                 (mouseenter)="hover.set(tl)" (mouseleave)="hover.set(null)" (focus)="hover.set(tl)" (blur)="hover.set(null)">
              @if (fits(tl, 1)) {
                <span class="tl-name">{{ label(tl.node) }}</span>
                @if (fits(tl, 2)) { <span class="tl-size">{{ kib(tl.node.size) }}</span> }
              }
              @for (ch of tl.inner; track ch.node.name + ch.x) {
                <div class="tile inner" [attr.data-group]="ch.group" [attr.data-kind]="ch.node.kind"
                     [attr.data-on]="isPicked(ch.node) ? 1 : null"
                     [style.left.px]="ch.x" [style.top.px]="ch.y" [style.width.px]="ch.w" [style.height.px]="ch.h"
                     (click)="open(ch, $event)"
                     (mouseenter)="hover.set(ch)" (mouseleave)="hover.set(tl)">
                  @if (fits(ch, 1)) {
                    <span class="tl-name">{{ label(ch.node) }}</span>
                    @if (fits(ch, 2)) { <span class="tl-size">{{ kib(ch.node.size) }}</span> }
                  }
                </div>
              }
            </div>
          }
        </div>
        <p class="detail">
          @if (hover(); as h) {
            <b>{{ label(h.node) }}</b>
            <span class="v">{{ kib(h.node.size) }} · {{ pct(h.node.size, sizes()!.total) }} {{ 'of flash' | t }}</span>
            <span class="path" [title]="kindName(h)">{{ kindName(h) }}</span>
          } @else {
            <span>{{ hint() | t }}</span>
          }
        </p>
      </section>

      <!-- YOUR CODE, file by file. -->
      <section class="files-col">
        <h3 class="tcv-label head">{{ 'Your code · by file' | t }}
          <span class="aside">{{ kib(sizes()!.groups.yours) }}</span></h3>
        @for (f of sizes()!.files; track f.path) {
          <button class="row" (click)="openFile(f.path)" [title]="f.path + ' · ' + num(f.size) + ' B'">
            <span class="n">{{ fileLabel(f) }}</span>
            <span class="v">{{ kib(f.size) }}</span>
            <span class="bar"><i [style.width.%]="100 * f.size / maxFile()"></i></span>
          </button>
        } @empty {
          <p class="empty">{{ 'None of the project’s own files made it into flash.' | t }}</p>
        }
        @if (sizes()!.top.length) {
          <h3 class="tcv-label head sub">{{ 'Largest in your code' | t }}</h3>
          @for (s of sizes()!.top.slice(0, 8); track s.name) {
            <button class="line" (click)="pickTop(s)" [attr.data-on]="pickedName() === bare(s.name) ? 1 : null"
                    [title]="s.name + (s.file ? '\n' + s.file + (s.line ? ':' + s.line : '') : '')">
              <span class="n">{{ s.name }}</span><span class="v">{{ kib(s.size) }}</span>
            </button>
          }
        }
      </section>
    </div>
  }

  <!-- CHANGES: the size against the build before, what is not committed, and the commits. -->
  @if (view()) {
    <section class="changes">
      <h3 class="tcv-label head">{{ 'Changes' | t }}
        <span class="aside">{{ changeAside() }}</span></h3>
      <div class="ch-grid">
        <div class="ch-size">
          <div class="ch-title">{{ 'Size vs the previous build' | t }}</div>
          @switch (view()!.change.state) {
            @case ('none') { <p class="empty">{{ 'Not built yet.' | t }}</p> }
            @case ('first') { <p class="empty">{{ 'First build: the change shows after the next one.' | t }}</p> }
            @default {
              @if (view()!.change.state === 'same') {
                <p class="empty">{{ 'No change: the same bytes as the build before.' | t }}</p>
              } @else {
              @for (g of changeGroups(); track g.id) {
                <div class="delta"><span class="n">{{ groupName(g.id) }}</span>
                  <span class="v">{{ kib(g.now) }}</span>
                  <span class="d" [attr.data-sign]="sign(g.delta)">{{ signed(g.delta) }}</span></div>
              }
              @for (r of view()!.change.regions; track r.name) {
                <div class="delta" [class.first]="$first"><span class="n">{{ r.name }}</span>
                  <span class="v">{{ kib(r.used) }}</span>
                  <span class="d" [attr.data-sign]="sign(r.delta)">{{ signed(r.delta) }}</span></div>
              }
              }
            }
          }
        </div>
        <div class="ch-git">
          @if (commits(); as c) {
            @if (!c.git) {
              <p class="empty">{{ 'The project is not a git repository.' | t }}</p>
            } @else {
              <div class="ch-title">{{ 'Not committed' | t }} <span class="aside">{{ c.dir }}</span></div>
              @for (f of c.worktree; track f.path) {
                <button class="commit" (click)="openWork(f.path)" [attr.data-on]="diffKey() === 'w:' + f.path ? 1 : null"
                        [title]="f.path">
                  <span class="h">{{ stateName(f.state) }}</span>
                  <span class="s">{{ f.path }}</span>
                  <span class="c">@if (!f.binary) {<span class="add">+{{ f.added }}</span> <span class="del">−{{ f.removed }}</span>}</span>
                  <span class="w"></span>
                </button>
              } @empty {
                <p class="empty">{{ 'Nothing: the working tree is as committed.' | t }}</p>
              }
              <div class="ch-title gap">{{ 'Commits' | t }}</div>
              @for (m of c.commits; track m.hash) {
                <button class="commit" (click)="openCommit(m)" [attr.data-on]="diffKey() === 'c:' + m.hash ? 1 : null"
                        [title]="m.subject + '\n' + m.author + ' · ' + m.at.slice(0, 16).replace('T', ' ') + ' · ' + m.files + ' ' + ('files' | t)">
                  <span class="h">{{ m.short }}</span>
                  <span class="s">{{ m.subject }}</span>
                  <span class="c"><span class="add">+{{ m.added }}</span> <span class="del">−{{ m.removed }}</span></span>
                  <span class="w">{{ m.when }}</span>
                </button>
              } @empty {
                <p class="empty">{{ 'No commits touch the firmware yet.' | t }}</p>
              }
            }
          } @else {
            <p class="empty">{{ 'Reading git…' | t }}</p>
          }
        </div>
      </div>

      @if (diff(); as d) {
        <div class="diff">
          <div class="diff-head">
            <b class="diff-title">{{ d.title }}</b><span class="aside">{{ d.sub }}</span>
            <span class="grow"></span>
            <button class="tcv-btn tcv-code-btn" (click)="side.set(!side())">{{ (side() ? 'Inline' : 'Side by side') | t }}</button>
            <button class="tcv-btn tcv-code-btn" (click)="closeDiff()" [title]="'Close' | t">✕</button>
          </div>
          @if (d.files.length > 1) {
            <div class="diff-files">
              @for (f of d.files; track f.path; let i = $index) {
                <button [attr.data-on]="diffPick() === i ? 1 : null" (click)="diffPick.set(i)" [title]="f.path">
                  {{ base(f.path) }} <span class="add">+{{ f.added }}</span> <span class="del">−{{ f.removed }}</span></button>
              }
            </div>
          }
          @if (d.files[diffPick()]?.binary) {
            <p class="empty">{{ 'Binary or too large to show.' | t }}</p>
          } @else if (!d.files.length) {
            <p class="empty">{{ 'No file of the firmware changed here.' | t }}</p>
          }
          <div #diffHost class="diff-host" [hidden]="!d.files.length || d.files[diffPick()]?.binary"></div>
        </div>
      }
    </section>
  }
</div>`,
  styles: [`
.fwb { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 14px 16px 20px; box-sizing: border-box;
  font-size: 11px; line-height: 1.45; color: var(--ink); container-type: inline-size; }
.fwb * { min-width: 0; box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; }
.empty { margin: 0; color: var(--ink-dim); font-size: 11px; }
.v, .aside, .d, .h, .c, .w, .tl-size { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }
.v, .aside { color: var(--ink-dim); }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin: 0 0 8px; }
.head .aside { text-transform: none; letter-spacing: 0; }
.head.sub { margin-top: 16px; }
.add { color: var(--ok); } .del { color: var(--danger); margin-left: 5px; }

.top { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 22px; }
@container (max-width: 760px) { .top { grid-template-columns: minmax(0, 1fr); } }

/* the legend: one key per owner, the swatch its tile colour */
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 8px; }
.key { display: flex; align-items: baseline; gap: 6px; }
.key i { align-self: center; width: 9px; height: 9px; border-radius: 2px; background: var(--tcv-fill); }
.key[data-group="yours"] i { background: var(--accent); }
.key:hover .n { color: var(--ink-bright); }
.crumbs { display: flex; align-items: baseline; gap: 5px; min-height: 18px; margin-bottom: 6px; overflow: hidden;
  white-space: nowrap; }
.crumbs button { color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; }
.crumbs button:hover { color: var(--accent); }
.crumbs b { font-weight: 600; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.crumbs .sep { color: var(--ink-dim); }

/* the map: tiles on the surface, owners told apart by fill alone */
.map { position: relative; height: clamp(240px, 52vh, 460px); border-radius: 5px; overflow: hidden;
  background: var(--surface); }
.tile { position: absolute; display: flex; flex-direction: column; justify-content: flex-start; gap: 0;
  padding: 3px 6px; overflow: hidden; border-radius: 3px; cursor: pointer; outline-offset: -1px;
  background: var(--tcv-fill); box-shadow: inset 0 0 0 1px var(--surface); }
[data-group="yours"] { --tcv-fill: color-mix(in srgb, var(--accent) 24%, var(--surface-2)); }
[data-group="framework"] { --tcv-fill: color-mix(in srgb, var(--ink-dim) 16%, var(--surface-2)); }
[data-group="runtime"] { --tcv-fill: color-mix(in srgb, var(--ink-dim) 7%, var(--surface-2)); }
.tile.frame { background: var(--surface-2); padding-top: 2px; }
.tile.frame[data-group="yours"] { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); }
.tile.inner { padding: 2px 5px; }
.tile[data-kind="rest"] { cursor: default; opacity: .7; }
.tile:hover:not(.frame), .tile.frame:hover > .tl-name { color: var(--ink-bright); }
.tile:hover:not(.frame) { outline: 1px solid var(--ink-dim); }
.tile[data-group="yours"]:hover:not(.frame) { outline-color: var(--accent); }
.tile:focus-visible { outline: 2px solid var(--accent); z-index: 1; }
.tile[data-on] { outline: 2px solid var(--accent); z-index: 1; }
.tl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 14px; }
.tl-size { color: var(--ink-dim); line-height: 13px; white-space: nowrap; }
.frame > .tl-name { font-size: 10.5px; color: var(--ink-dim); }
.frame > .tl-size { display: none; }
.detail { display: flex; align-items: baseline; gap: 10px; height: 17px; margin: 7px 0 0; overflow: hidden;
  white-space: nowrap; color: var(--ink-dim); }
.detail > * { flex: none; }
.detail b { color: var(--ink); font-weight: 600; }
.detail .path { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }

/* your files: name and size on a line, a thin bar under */
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; row-gap: 3px; width: 100%;
  align-items: baseline; padding: 5px 0 6px; border-top: 1px solid var(--line); }
.row:hover .n { color: var(--accent); }
.row .n, .line .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .v { text-align: right; }
.bar { grid-column: 1 / -1; height: 4px; border-radius: 2px; overflow: hidden; background: var(--surface-2); }
.bar i { display: block; height: 100%; min-width: 2px; border-radius: 2px; background: var(--accent); }
.line { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; width: 100%; padding: 1px 0; }
.line .v { flex: none; }
.line:hover .n, .line[data-on] .n { color: var(--accent); }

/* changes */
.changes { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
.ch-grid { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 22px; }
@container (max-width: 760px) { .ch-grid { grid-template-columns: minmax(0, 1fr); } }
.ch-title { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;
  font-size: 10px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: .04em; }
.ch-title .aside { text-transform: none; letter-spacing: 0; }
.ch-title.gap { margin-top: 12px; }
.delta { display: grid; grid-template-columns: minmax(0, 1fr) auto 64px; column-gap: 8px; align-items: baseline;
  padding: 2px 0; }
.delta.first { margin-top: 5px; padding-top: 6px; border-top: 1px solid var(--line); }
.delta .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.delta .d { text-align: right; color: var(--ink-dim); }
.delta .d[data-sign="up"] { color: var(--danger); }
.delta .d[data-sign="down"] { color: var(--ok); }
.commit { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto 84px; column-gap: 10px; align-items: baseline;
  width: 100%; padding: 4px 0; border-top: 1px solid var(--line); }
.commit .h { color: var(--ink-dim); }
.commit .s { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit .c { white-space: nowrap; }
.commit .w { text-align: right; color: var(--ink-dim); font-size: 10px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.commit:hover .s { color: var(--accent); }
.commit[data-on] .s, .commit[data-on] .h { color: var(--accent); }

.diff { margin-top: 14px; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.diff-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px; background: var(--surface-2);
  border-bottom: 1px solid var(--line); }
.diff-title { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-head .aside { white-space: nowrap; }
.diff-head .grow { flex: 1; }
.diff-files { display: flex; flex-wrap: wrap; gap: 2px 14px; padding: 5px 8px; border-bottom: 1px solid var(--line); }
.diff-files button { color: var(--ink-dim); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }
.diff-files button[data-on], .diff-files button:hover { color: var(--ink); }
.diff-files button[data-on] { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--accent); }
.diff .empty { padding: 8px; }
.diff-host { height: 380px; }
`],
})
export class FwBuild implements OnDestroy {
  private http = inject(HttpClient);
  app = input.required<AppEntry>();
  /** A function or table picked: it becomes the note's Part. */
  picked = output<FwSymbol>();

  private mapEl = viewChild<ElementRef<HTMLDivElement>>('map');
  private diffHost = viewChild<ElementRef<HTMLDivElement>>('diffHost');

  view = signal<BuildView | null>(null);
  commits = signal<Commits | null>(null);
  /** Where the map is looking: the nodes from the root down. */
  trail = signal<SizeNode[]>([]);
  hover = signal<Tile | null>(null);
  pickedName = signal<string | null>(null);
  box = signal({ w: 0, h: 0 });
  diff = signal<Diff | null>(null);
  diffKey = signal<string | null>(null);
  diffPick = signal(0);
  side = signal(true);

  sizes = computed(() => this.view()?.sizes ?? null);
  root = computed(() => this.sizes()!.tree);
  target = computed(() => (this.app().target ?? (this.view()?.built?.arch === 'arm' ? 'stm32' : 'esp32')));
  groups = computed(() => (this.sizes()?.tree.children ?? [])
    .filter(n => n.size > 0).map(n => ({ id: n.name as Group, size: n.size, node: n })));
  maxFile = computed(() => Math.max(1, ...(this.sizes()?.files ?? []).map(f => f.size)));
  hint = computed(() => {
    const at = this.trail().at(-1);
    return at?.kind === 'file' ? 'Click a function or table to make it the note’s Part. Esc goes back.'
      : this.trail().length > 1 ? 'Click a block to look inside. Esc goes back.'
      : 'Areas are bytes. Click a block to look inside it.';
  });

  tiles = computed<Tile[]>(() => {
    const { w, h } = this.box();
    const trail = this.trail();
    const at = trail.at(-1);
    if (!at || w < 10 || h < 10) return [];
    const kids = shown(at);
    const rects = squarify(kids.map(k => k.size), 0, 0, w, h);
    return kids.map((node, i) => {
      const r = rects[i];
      const group = this.groupOf([...trail, node]);
      const tile: Tile = { node, group, ...r, trail: [...trail, node], inner: [], frame: false };
      const inner = node.kind === 'rest' ? [] : shown(node);
      // Room for what is inside: a strip for the name, the children under it.
      if (inner.length && r.w > 70 && r.h > 46) {
        tile.frame = true;
        const iw = r.w - 2 * GAP, ih = r.h - HEAD - GAP;
        const inRects = squarify(inner.map(k => k.size), GAP, HEAD, iw, ih);
        tile.inner = inner.map((n, k) => ({
          node: n, group: this.groupOf([...trail, node, n]), ...inRects[k],
          trail: [...trail, node, n], inner: [], frame: false,
        }));
      }
      return tile;
    });
  });

  changeGroups = computed(() => {
    const c = this.view()?.change;
    const g = this.sizes()?.groups;
    if (!c || !g) return [];
    return GROUPS.filter(id => id in c.groups && (g[id] || c.groups[id]))
      .map(id => ({ id, now: g[id] ?? 0, delta: c.groups[id] ?? 0 }));
  });

  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private models: Monaco.editor.ITextModel[] = [];
  private resize = new ResizeObserver(es => {
    const r = es[0].contentRect;
    this.box.set({ w: Math.floor(r.width), h: Math.floor(r.height) });
  });
  private watched: HTMLElement | null = null;

  constructor() {
    // The build and the commits, again whenever the app or its last build changes.
    effect(() => {
      const a = this.app();
      const key = a._id;
      void a.firmware?.at;
      untracked(() => this.load(key));
    });
    // The map's size, for the layout.
    effect(() => {
      const el = this.mapEl()?.nativeElement ?? null;
      if (el === this.watched) return;
      if (this.watched) this.resize.unobserve(this.watched);
      this.watched = el;
      if (el) this.resize.observe(el);
    });
    // The picked file of a diff into Monaco.
    effect(() => {
      const d = this.diff(), i = this.diffPick(), side = this.side(), host = this.diffHost();
      if (!d || !host) return;
      const f = d.files[i];
      if (f && !f.binary) untracked(() => void this.showDiff(host.nativeElement, f, side));
    });
  }

  private load(id: string) {
    this.http.get<BuildView>(`/api/embedded/${id}/build`).subscribe({
      next: v => {
        const same = this.view()?.sizes?.at === v.sizes?.at && this.trail().length;
        this.view.set(v);
        if (v.sizes && !same) this.trail.set([v.sizes.tree]);
      },
      error: () => this.view.set({ built: null, sizes: null,
        change: { state: 'none', total: null, groups: {}, regions: [], at: null, was_at: null } }),
    });
    this.http.get<Commits>(`/api/embedded/${id}/commits`).subscribe({
      next: c => this.commits.set(c),
      error: () => this.commits.set({ git: false, dir: '', commits: [], worktree: [] }),
    });
  }

  // ---- the map ----

  groupOf(trail: SizeNode[]): Group {
    const g = trail.find(n => n.kind === 'group');
    return (g?.name as Group) ?? 'framework';
  }

  zoomTo(trail: SizeNode[]) {
    // A level with one thing in it says nothing: straight through to that thing.
    for (let at = trail.at(-1); at?.children?.length === 1 && at.children[0].children?.length; at = trail.at(-1)) {
      trail = [...trail, at.children[0]];
    }
    this.trail.set(trail);
    this.hover.set(null);
  }

  open(tl: Tile, e: Event) {
    e.stopPropagation();
    e.preventDefault();
    const n = tl.node;
    if (n.kind === 'rest') return;
    if (n.kind === 'symbol') { this.pick(n); return; }
    this.zoomTo(tl.trail);
  }

  /** Esc or Backspace: one level up. */
  key(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).closest('.diff-host')) return;
    if ((e.key === 'Escape' || e.key === 'Backspace') && this.trail().length > 1) {
      e.preventDefault();
      this.zoomTo(this.trail().slice(0, -1));
      queueMicrotask(() => this.mapEl()?.nativeElement.querySelector<HTMLElement>('.tile[tabindex]')?.focus());
    }
  }

  /** A file of the project's, from the list: the map goes to it. */
  openFile(path: string) {
    const root = this.sizes()?.tree;
    if (!root) return;
    for (const g of root.children ?? []) for (const a of g.children ?? []) for (const f of a.children ?? []) {
      if (f.kind === 'file' && f.path === path && g.name === 'yours') { this.zoomTo([root, g, a, f]); return; }
    }
  }

  pick(n: SizeNode) {
    this.pickedName.set(this.bare(n.name));
    this.picked.emit({ name: this.bare(n.name), size: n.size, where: 'flash', file: n.file ?? null, line: n.line ?? null });
  }

  pickTop(s: { name: string; size: number; file: string | null; line: number | null }) {
    this.pick({ name: s.name, kind: 'symbol', size: s.size, file: s.file, line: s.line });
  }

  isPicked(n: SizeNode) { return n.kind === 'symbol' && this.pickedName() === this.bare(n.name); }
  bare(name: string) { return name.endsWith('()') ? name.slice(0, -2) : name; }

  /** Whether a tile has room for its name (1) or its name and size (2). */
  fits(tl: Tile, lines: 1 | 2) {
    if (tl.frame) return tl.w > 40;
    return lines === 1 ? tl.w >= 38 && tl.h >= 17 : tl.w >= 46 && tl.h >= 32;
  }

  label(n: SizeNode): string {
    if (n.kind === 'root') return t('Flash');
    if (n.kind === 'group') return this.groupName(n.name as Group);
    return n.name;
  }

  groupName(g: Group): string {
    if (g === 'yours') return t('Your code');
    if (g === 'runtime') return t('C runtime');
    return this.target() === 'esp32' ? 'ESP-IDF' : t('Vendor code');
  }

  groupTip(g: Group): string {
    if (g === 'yours') return t('The project’s own sources');
    if (g === 'runtime') return t('The compiler’s libraries: libc, libgcc, libstdc++');
    return t(this.target() === 'esp32' ? 'ESP-IDF’s components' : 'A vendor HAL and startup code');
  }

  kindName(tl: Tile): string {
    const n = tl.node;
    const kids = n.children?.length ?? 0;
    const inside = kids ? ` · ${kids} ${t(n.kind === 'file' ? 'symbols' : 'files')}` : '';
    if (n.kind === 'group') return this.groupTip(n.name as Group);
    if (n.kind === 'archive') return (n.path && n.path !== n.name ? n.path : t('library')) + inside;
    if (n.kind === 'file') return (n.path && n.path !== n.name ? n.path : t('file')) + inside;
    if (n.kind === 'symbol') return n.file ? `${n.file}${n.line ? ':' + n.line : ''}` : t('function or table');
    return t('the smaller ones, together');
  }

  fileLabel(f: { name: string; path: string }): string {
    const same = (this.sizes()?.files ?? []).filter(o => o.name === f.name).length > 1;
    if (!same) return f.name;
    const parts = f.path.split('/');
    return parts.slice(-2).join('/');
  }

  // ---- changes ----

  changeAside(): string {
    const c = this.view()?.change;
    if (!c?.was_at) return '';
    return `${t('since')} ${this.clock(c.was_at)}${c.was_commit ? ' · ' + c.was_commit : ''}`;
  }

  stateName(s: string): string { return t(s); }

  openCommit(m: Commit) {
    const id = this.app()._id;
    this.diffKey.set('c:' + m.hash);
    this.http.get<{ short: string; subject: string; author: string; when: string; files: DiffFile[] }>(
      `/api/embedded/${id}/commits/${m.hash}`).subscribe(d => {
      this.diffPick.set(0);
      this.diff.set({ title: d.subject, sub: `${d.short} · ${d.author} · ${d.when}`, files: d.files });
    });
  }

  openWork(path: string) {
    const id = this.app()._id;
    this.diffKey.set('w:' + path);
    this.http.get<{ files: (DiffFile & { state: string })[] }>(`/api/embedded/${id}/worktree`).subscribe(d => {
      const i = Math.max(0, d.files.findIndex(f => f.path === path));
      this.diffPick.set(i);
      this.diff.set({ title: t('Not committed'), sub: `${d.files.length} ${t('files')}`, files: d.files });
    });
  }

  closeDiff() {
    this.diff.set(null);
    this.diffKey.set(null);
    for (const md of this.models) md.dispose();
    this.models = [];
    this.editor?.dispose();
    this.editor = null;
  }

  private async showDiff(host: HTMLElement, f: DiffFile, side: boolean) {
    const m = this.monaco ??= await loadMonaco();
    if (this.editor && this.editor.getContainerDomNode() !== host) { this.editor.dispose(); this.editor = null; }
    this.editor ??= m.editor.createDiffEditor(host, {
      theme: redlineTheme(m), readOnly: true, automaticLayout: true, renderSideBySide: side,
      fontSize: 12, scrollBeyondLastLine: false, originalEditable: false, minimap: { enabled: false },
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
    });
    this.editor.updateOptions({ renderSideBySide: side });
    const lang = this.lang(f.path);
    const before = m.editor.createModel(f.before, lang);
    const after = m.editor.createModel(f.after, lang);
    this.editor.setModel({ original: before, modified: after });
    for (const old of this.models) old.dispose();
    this.models = [before, after];
  }

  private lang(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return ({ c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp', py: 'python', json: 'json',
              md: 'markdown', yml: 'yaml', yaml: 'yaml', js: 'javascript', ts: 'typescript', sh: 'shell',
              ini: 'ini', s: 'mips' } as Record<string, string>)[ext] ?? 'plaintext';
  }

  // ---- figures ----

  num(n: number): string { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  kib(n: number | null | undefined): string {
    if (n == null) return '–';
    return n >= 1024 ? `${(n / 1024).toFixed(n >= 100 * 1024 ? 0 : 1)} KB` : `${n} B`;
  }

  pct(n: number, of: number): string {
    const p = of ? (100 * n) / of : 0;
    return `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`;
  }

  signed(n: number): string {
    if (!n) return t('no change');
    return `${n > 0 ? '+' : '−'}${this.num(Math.abs(n))} B`;
  }

  sign(n: number): string | null { return n > 0 ? 'up' : n < 0 ? 'down' : null; }

  base(p: string): string { return p.split('/').pop() ?? p; }

  clock(iso: string): string {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return today ? hm : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
  }

  ngOnDestroy() {
    this.resize.disconnect();
    for (const md of this.models) md.dispose();
    this.editor?.dispose();
  }
}
