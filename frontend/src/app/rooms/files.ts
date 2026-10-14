import { NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { Toast, ToastTone } from '../toast';
import { HttpEventType } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { SelectOption, UiSelect, plainOptions } from '../ui-select';
import { AGENT_ROOMS } from './notes';
import { Catalog, FolderNode } from '../api';
import { FileView, decodeText } from './file-view';
import {
  Area, FileFolder, FilesApi, FilesUsage, TrashFile, UsageRow, Icon, KIND_LABEL, Seen, StoredFile, VirtualOpen, downloadUrl, extOf, iconOf,
  inlineUrl, size, splitName, thumbUrl, zipUrl,
} from './files-model';
import { BarList, Donut, MiniStack, Row, StackCol, TimeChart, TimeData, color, fmt as cfmt } from './charts';
import { Skeleton } from '../skeleton';
import { csvText, saveFile } from './dash';
import { pdfFirstPage } from './pdf-reader';
import { MeshThumbs } from './mesh-thumb';
import { ContextMenu, MenuEntry } from '../context-menu';
import { Marquee } from '../marquee';
import { EmptyState } from '../empty-state';

export { FilesApi } from './files-model';
export type { StoredFile } from './files-model';

/** Files: anything the work needs that is not a model or a board.
 *
 *  A BOM for a board that came in as bare Gerbers, a pick-and-place file,
 *  a datasheet, a photo of the bench, a clip of the prototype. They are
 *  kept as they came, in folders, with who brought them and the board they
 *  are for (backend/files.py). The room is a plain file manager: a folder
 *  tree, the folder's contents as a grid or a list, a preview that opens
 *  the file in place (images, video, audio, PDF, text and code, Markdown,
 *  tables, archives, meshes), and "Send to agent", which puts a line in a
 *  room's thread with what the file is and the command that fetches it.
 */

type Item = { key: string; folder?: FileFolder; file?: StoredFile; ro?: boolean };
type SortKey = 'name' | 'date' | 'size' | 'kind';
type MenuItem = MenuEntry;
type Dialog =
  | { type: 'new-folder'; name: string; busy?: boolean; error?: string }
  | { type: 'move'; files: string[]; folders: string[]; to: string; busy?: boolean; error?: string }
  | { type: 'add'; file: StoredFile; folder: string; title: string; folders: string[]; busy?: boolean; error?: string }
  | { type: 'confirm'; title: string; body: string; ok: string; run: () => void };

const ROOM_LABEL: Record<string, string> = { cad: '3D Drawing', pcb: 'PCB Design' };
/** The read-only folders: where what they hold is changed (backend/files_virtual.py WHERE). */
const WHERE_LABEL: Record<string, string> = {
  cad: 'Change it in the 3D Drawing room', pcb: 'Change it in the PCB Design room', firmware: 'Change it in the Firmware room',
  releases: 'Releases are made and deleted in the 3D Drawing room', projects: 'The project tree, as the 3D and PCB rooms keep it',
  chat: 'Kept in My files; the conversation used it', parts: 'Change it on the Parts page',
};
/** The areas, in the order the storage bar draws them; their colours are the charts' first four. */
const AREAS: { id: Area; label: string; root: string }[] = [
  { id: 'projects', label: 'Projects', root: 'v:projects' }, { id: 'chat', label: 'Chat', root: 'v:chat' },
  { id: 'parts', label: 'Parts', root: 'v:parts' }, { id: 'own', label: 'My files', root: '' },
];
/** The main pane's storage overview and the trash, in place of a folder. */
const STORAGE = '~storage';
const TRASH = '~trash';
const DRAG = 'application/x-redline-files';
const PREFS = 'redline.files';

function readPrefs(): { view?: 'grid' | 'list'; sort?: SortKey; dir?: 1 | -1; details?: boolean; open?: string[] } {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; }
}

@Component({
  selector: 'app-room-files',
  imports: [EmptyState, T, Icon, Seen, NgTemplateOutlet, FileView, UiSelect, Marquee, MiniStack, TimeChart, Donut, BarList, Skeleton],
  styleUrl: './files.css',
  host: { '(document:keydown)': 'globalKey($event)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1 tcv-fm">
  <!-- a 3D file's picture is grey shading: this gives it the theme's model colour (styles.css .tcv-fm-solid) -->
  <svg class="tcv-fm-defs" aria-hidden="true" focusable="false">
    <filter id="tcv-fm-tint" color-interpolation-filters="sRGB">
      <feFlood class="tcv-fm-tint" result="ink" />
      <feComposite in="ink" in2="SourceAlpha" operator="in" result="shape" />
      <feBlend in="shape" in2="SourceGraphic" mode="multiply" />
    </filter>
  </svg>
  <!-- LEFT: the folders, and what to show -->
  <aside class="tcv-notes-side tcv-fm-side fm-side" [attr.aria-label]="'Folders' | t">
    <!-- Two sides, as the Chat's list has its tabs: one's own files (always first), and
         what the rest of the app keeps, read-only (backend/files_virtual.py) -->
    <div class="fm-tabrow">
      <div class="tcv-cc-tabs" role="tablist">
        <button role="tab" [class.on]="side() === 'mine'" [attr.aria-selected]="side() === 'mine'" (click)="showSide('mine')">{{ 'My files' | t }}</button>
        <button role="tab" [class.on]="side() === 'app'" [attr.aria-selected]="side() === 'app'" (click)="showSide('app')">{{ 'In the app' | t }}</button>
      </div>
    </div>
    <div class="fm-side-scroll">
    @if (side() === 'mine') {
      <nav class="tcv-fm-tree" role="tree" [attr.aria-label]="'Folders' | t">
        <ng-container *ngTemplateOutlet="node; context: { $implicit: null, depth: 0 }" />
      </nav>
    } @else {
      <nav class="tcv-fm-tree" role="tree" [attr.aria-label]="'Read-only folders' | t">
        @for (r of vroots(); track r.id) {
          <ng-container *ngTemplateOutlet="node; context: { $implicit: r, depth: 0 }" />
        }
      </nav>
    }
    <ng-template #node let-f let-depth="depth">
      @let id = f ? f.id : '';
      @let kids = childrenOf(id);
      <div class="tcv-fm-tree-row" role="treeitem" tabindex="0"
           [attr.aria-selected]="here() === id && !filtering()" [attr.aria-expanded]="kids.length ? isOpen(id) : null"
           [attr.data-on]="here() === id && !filtering() ? 1 : null" [attr.data-drop]="dropAt() === 'tree:' + id ? 1 : null"
           [style.padding-left.px]="6 + depth * 14"
           [title]="f?.ro ? whereText(f) : ''" [attr.data-ro]="f?.ro ? 1 : null"
           (click)="go(id)" (keydown.enter)="go(id)"
           (dragover)="over($event, 'tree:' + id)" (dragleave)="leave($event, 'tree:' + id)" (drop)="dropOn($event, id)"
           (contextmenu)="f ? openMenu($event, 'd:' + f.id) : $event.preventDefault()">
        <button class="tcv-fm-twist" [style.visibility]="kids.length ? 'visible' : 'hidden'" tabindex="-1"
                (click)="toggleOpen(id); $event.stopPropagation()" [attr.aria-label]="(isOpen(id) ? 'Collapse' : 'Expand') | t">
          <i [fmIcon]="isOpen(id) ? 'down' : 'right'"></i></button>
        <i class="tcv-fm-tree-ico" [fmIcon]="'folder'"></i>
        <span class="tcv-fm-tree-name">{{ f ? (f.root || f.build ? (f.name | t) : f.name) : ('My files' | t) }}</span>
        @if (!f) { <em class="tcv-fm-count">{{ mine().length }}</em> }
        @else if (f.root) {
          <em class="tcv-fm-count">{{ stats(f.id).files }}</em>
          <i class="fm-lock" [fmIcon]="'lock'"></i>
        }
      </div>
      @if (isOpen(id)) {
        @for (k of kids; track k.id) {
          <ng-container *ngTemplateOutlet="node; context: { $implicit: k, depth: depth + 1 }" />
        }
      }
    </ng-template>

    @if (boardsUsed().length) {
      <div class="tcv-notes-group">{{ 'Boards' | t }}</div>
      <div class="tcv-notes-filters">
        @for (b of boardsUsed(); track b) {
          <button class="tcv-notes-chip" [attr.data-on]="board() === b ? 1 : null" [attr.aria-pressed]="board() === b"
                  (click)="board.set(board() === b ? '' : b)">&#64;{{ b }}</button>
        }
      </div>
    }
    </div>
    <!-- Pinned at the foot, as the Chat's cards are under its list: two squares in one frame -
         how much there is, and what came and went this week. Both open the overview. -->
    <div class="fm-stats"><div class="fm-card">
      <button class="fm-sq" type="button" (click)="go(STORAGE)" [title]="storageTip()">
        <span class="fm-sq-head"><i [fmIcon]="'disk'"></i><b>{{ 'Storage' | t }}</b>
          <em>{{ usage() ? usage()!.total.files + ' ' + ('files' | t) : '' }}</em></span>
        @if (usage(); as u) {
          <span class="fm-sq-fig"><b>{{ fmt(u.total.bytes) }}</b></span>
          <app-mini-stack class="fm-sq-chart" [data]="areaCols()" [height]="34" [f]="bytesFmt" />
        } @else { <span class="fm-sq-sub">{{ usageErr() ? ('The figures did not load' | t) : ('Counting…' | t) }}</span> }
      </button>
      <button class="fm-sq" type="button" (click)="go(STORAGE)" [title]="activityTip()">
        <span class="fm-sq-head"><i [fmIcon]="'upload'"></i><b>{{ 'Activity' | t }}</b><em>{{ 'this week' | t }}</em></span>
        @if (usage(); as u) {
          <span class="fm-sq-fig"><b>{{ weekSum().added }}</b><span>{{ 'added' | t }}</span>
            <em><b>{{ weekSum().deleted }}</b> {{ 'deleted' | t }}</em></span>
          <app-mini-stack class="fm-sq-chart" [data]="weekCols()" [height]="34" />
        } @else { <span class="fm-sq-sub">{{ 'Counting…' | t }}</span> }
      </button>
    </div>
      <!-- Joined under the cards: the trash, kept usage().trash.days days -->
      <button class="fm-trash-btn" type="button" (click)="go(TRASH)" [title]="('Deleted files are kept' | t) + ' ' + (usage()?.trash?.days ?? 30) + ' ' + ('days' | t)">
        <i [fmIcon]="'trash'"></i><span>{{ 'Deleted files' | t }}</span>
        <em>{{ usage()?.trash?.files ?? 0 }}{{ usage()?.trash?.bytes ? ' · ' + fmt(usage()!.trash.bytes) : '' }}</em>
        <i [fmIcon]="'right'"></i></button>
    </div>
  </aside>

  <!-- RIGHT: where you are, and what is in it -->
  <section class="tcv-notes-main tcv-fm-main"
           (dragover)="over($event, 'main')" (dragleave)="leave($event, 'main')" (drop)="dropOn($event, here())">
    <header class="tcv-fm-head">
      <nav class="tcv-fm-crumbs" [attr.aria-label]="'Location' | t">
        @if (filtering()) {
          <button class="tcv-fm-crumb" (click)="clearFilters()">{{ 'My files' | t }}</button>
          <i class="tcv-fm-crumb-sep" [fmIcon]="'right'"></i>
          <span class="tcv-fm-crumb tcv-fm-crumb-here">{{ 'Search results' | t }}</span>
        } @else {
          @for (c of crumbs(); track c.id; let last = $last) {
            @if (!last) {
              <button class="tcv-fm-crumb" [attr.data-drop]="dropAt() === 'crumb:' + c.id ? 1 : null" (click)="go(c.id)"
                      (dragover)="over($event, 'crumb:' + c.id)" (dragleave)="leave($event, 'crumb:' + c.id)"
                      (drop)="dropOn($event, c.id)">{{ crumbName(c) | t }}</button>
              <i class="tcv-fm-crumb-sep" [fmIcon]="'right'"></i>
            } @else {
              <span class="tcv-fm-crumb tcv-fm-crumb-here" aria-current="location">{{ crumbName(c) | t }}</span>
            }
          }
        }
      </nav>
      @if (hereFolder()?.ro) {
        <!-- A read-only folder: what it is, and the way to where it is changed -->
        <span class="fm-ro-note" [title]="whereText(hereFolder()!)"><i [fmIcon]="'lock'"></i>{{ 'Read-only' | t }}
          <em>{{ whereText(hereFolder()!) | t }}</em></span>
        @if (openable(hereFolder()!.open, hereFolder()!.chat); as label) {
          <button class="tcv-btn tcv-fm-btn" (click)="openThere(hereFolder()!.open, hereFolder()!.chat)">
            <i [fmIcon]="'open'"></i><span>{{ label | t }}</span></button>
        }
      } @else if (auth.can('draw') && here() !== STORAGE && here() !== TRASH) {
        <button class="tcv-btn tcv-fm-btn" (click)="newFolder()"><i [fmIcon]="'newfolder'"></i><span>{{ 'New folder' | t }}</span></button>
        <label class="tcv-btn tcv-btn-accent tcv-fm-btn" tabindex="0" (keydown.enter)="$any($event.target).querySelector('input')?.click()">
          <input type="file" multiple hidden (change)="pick($event)">
          <i [fmIcon]="'upload'"></i><span>{{ 'Upload' | t }}</span></label>
      }
    </header>

    @if (here() !== STORAGE && here() !== TRASH) {
    <div class="tcv-fm-tools">
      @if (selected().size) {
        <button class="tcv-fm-icon-btn" (click)="clearSel()" [title]="'Clear the selection' | t" [attr.aria-label]="'Clear the selection' | t"><i [fmIcon]="'close'"></i></button>
        <span class="tcv-fm-selcount">{{ selected().size }} {{ 'selected' | t }}</span>
        <span class="tcv-fm-tools-sep"></span>
        <a class="tcv-fm-icon-btn" [href]="selZip()" [title]="'Download' | t" [attr.aria-label]="'Download' | t"><i [fmIcon]="'download'"></i></a>
        @if (auth.can('draw') && !selRo()) {
          <button class="tcv-fm-icon-btn" (click)="moveDialog(selKeys())" [title]="'Move to…' | t" [attr.aria-label]="'Move to…' | t"><i [fmIcon]="'move'"></i></button>
          <button class="tcv-fm-icon-btn" (click)="askDelete(selKeys())" [title]="'Delete' | t" [attr.aria-label]="'Delete' | t"><i [fmIcon]="'trash'"></i></button>
        }
        @if (selected().size === 1 && singleFile(); as f) {
          <button class="tcv-fm-icon-btn" (click)="open(f)" [title]="'Open' | t" [attr.aria-label]="'Open' | t"><i [fmIcon]="'open'"></i></button>
        }
        <button class="tcv-fm-icon-btn" (click)="openMenu($event, selKeys()[0], true)" [title]="'More actions' | t" [attr.aria-label]="'More actions' | t"><i [fmIcon]="'more'"></i></button>
      } @else {
        <span class="tcv-fm-search">
          <i [fmIcon]="'search'"></i>
          <input type="search" [placeholder]="'Search files' | t" [value]="q()" [attr.aria-label]="'Search in all files' | t"
                 (input)="q.set($any($event.target).value)" (keydown.escape)="q.set('')">
        </span>
        <span class="tcv-fm-phone-only"><wb-select class="tcv-fm-wsel" label="Kind" [options]="kindOpts()" [value]="kind()" (pick)="kind.set($event)" /></span>
      }
      <span class="tcv-fm-grow"></span>
      <wb-select class="tcv-fm-wsel tcv-fm-sort" label="Sort by" [options]="sortOpts()" [value]="sortKey()" (pick)="setSort($any($event), false)" />
      <button class="tcv-fm-icon-btn tcv-fm-sortdir" (click)="sortDir.set(sortDir() === 1 ? -1 : 1); save()"
              [title]="(sortDir() === 1 ? 'Ascending' : 'Descending') | t" [attr.aria-label]="(sortDir() === 1 ? 'Ascending' : 'Descending') | t">
        <i [fmIcon]="sortDir() === 1 ? 'up' : 'down'"></i></button>
      <div class="tcv-fm-seg" role="group" [attr.aria-label]="'View' | t">
        <button [attr.data-on]="view() === 'grid' ? 1 : null" [attr.aria-pressed]="view() === 'grid'" (click)="setView('grid')"
                [title]="'Grid' | t" [attr.aria-label]="'Grid' | t"><i [fmIcon]="'grid'"></i></button>
        <button [attr.data-on]="view() === 'list' ? 1 : null" [attr.aria-pressed]="view() === 'list'" (click)="setView('list')"
                [title]="'List' | t" [attr.aria-label]="'List' | t"><i [fmIcon]="'list'"></i></button>
      </div>
      <button class="tcv-fm-icon-btn tcv-fm-hide-phone" [attr.data-on]="details() ? 1 : null" [attr.aria-pressed]="details()"
              (click)="details.set(!details()); save()" [title]="'Details' | t" [attr.aria-label]="'Details' | t"><i [fmIcon]="'info'"></i></button>
    </div>
    }

    @if (here() === STORAGE) {
      <ng-container *ngTemplateOutlet="storageView" />
    } @else if (here() === TRASH) {
      <ng-container *ngTemplateOutlet="trashView" />
    } @else {
    <div class="tcv-fm-body">
      <div class="tcv-fm-items" tabindex="0" role="grid" [attr.aria-label]="'Files' | t" [attr.aria-multiselectable]="true"
           [attr.data-view]="view()" (keydown)="itemsKey($event)" (click)="backgroundClick($event)"
           (contextmenu)="backgroundMenu($event)"
           wbMarquee marqueeSkip=".tcv-fm-row-head" [marqueeBase]="selected()" (wbMarquee)="selected.set($event)">
        @if (loading()) {
          @if (view() === 'grid') {
            <div class="tcv-fm-grid" aria-busy="true">
              @for (i of skeleton; track i) {
                <div class="tcv-fm-tile tcv-fm-skel"><div class="tcv-fm-thumb"><i class="sk"></i></div>
                  <div class="tcv-fm-tile-name"><i class="sk" style="width: 70%"></i></div></div>
              }
            </div>
          } @else {
            <div class="tcv-fm-list" aria-busy="true">
              @for (i of skeleton; track i) {
                <div class="tcv-fm-row tcv-fm-skel"><i class="sk" style="width: 40%"></i><i class="sk" style="width: 12%"></i><i class="sk" style="width: 10%"></i></div>
              }
            </div>
          }
        } @else if (!items().length) {
          @if (filtering()) {
            <wb-empty icon="search" heading="Nothing matches" text="No file name or note in any folder has this.">
              <button class="tcv-btn tcv-fm-btn" (click)="clearFilters()">{{ 'Clear the search' | t }}</button></wb-empty>
          } @else if (!here() && !all().length) {
            <wb-empty icon="upload" heading="No files yet"
                      text="Drop files anywhere here, or use Upload: BOMs, pick and place files, datasheets, photos, videos, STEP - up to 200 MB each." />
          } @else {
            <wb-empty icon="newfolder" heading="This folder is empty"
                      text="Drop files here, or use Upload. Files and folders can be dragged in from elsewhere too." />
          }
        } @else if (view() === 'grid') {
          @if (folderItems().length) {
            <div class="tcv-fm-section">{{ 'Folders' | t }}</div>
            <div class="tcv-fm-grid tcv-fm-grid-dirs">
              @for (it of folderItems(); track it.key) {
                <div class="tcv-fm-tile tcv-fm-dir" role="gridcell" tabindex="-1" [attr.data-key]="it.key"
                     [attr.aria-selected]="isSel(it.key)" [attr.data-on]="isSel(it.key) ? 1 : null"
                     [attr.data-focus]="focusKey() === it.key ? 1 : null" [attr.data-drop]="dropAt() === it.key ? 1 : null"
                     [attr.draggable]="it.ro ? null : 'true'" (dragstart)="dragStart($event, it.key)"
                     (dragover)="over($event, it.key)" (dragleave)="leave($event, it.key)" (drop)="dropOn($event, it.folder!.id)"
                     (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                  <i class="tcv-fm-dir-ico" [fmIcon]="'folder'"></i>
                  <ng-container *ngTemplateOutlet="nameOf; context: { $implicit: it }" />
                  @if (it.ro) { <i class="fm-tile-lock" [fmIcon]="'lock'" [title]="whereText(it.folder!) | t"></i> }
                </div>
              }
            </div>
          }
          @if (fileItems().length) {
            @if (folderItems().length) { <div class="tcv-fm-section">{{ 'Files' | t }}</div> }
            <div class="tcv-fm-grid">
              @for (it of fileItems(); track it.key) {
                @let f = it.file!;
                <div class="tcv-fm-tile" role="gridcell" tabindex="-1" [attr.data-key]="it.key"
                     [attr.aria-selected]="isSel(it.key)" [attr.data-on]="isSel(it.key) ? 1 : null"
                     [attr.data-focus]="focusKey() === it.key ? 1 : null"
                     [attr.draggable]="it.ro ? null : 'true'" (dragstart)="dragStart($event, it.key)"
                     (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                  <div class="tcv-fm-thumb" (fmSeen)="seen(f)" [attr.data-kind]="f.kind">
                    @switch (thumbOf(f)) {
                      @case ('img') { <img [src]="f.name.toLowerCase().endsWith('.svg') ? inline(f.id) : thumb(f.id)" alt="" loading="lazy" (error)="noThumb(f.id)"> }
                      @case ('video') { <video [src]="inline(f.id) + '#t=0.5'" preload="metadata" muted playsinline></video>
                                        <span class="tcv-fm-play"><i [fmIcon]="'video'"></i></span> }
                      @case ('pdf') { <img [src]="pics()[f.id]" alt=""> }
                      @case ('snip') { <pre class="tcv-fm-snip">{{ pics()[f.id] }}</pre> }
                      @case ('solid') { <img class="tcv-fm-solid" [src]="solid(f)" alt="" loading="lazy" (error)="noThumb(f.id)">
                                        <span class="tcv-fm-badge">{{ badge(f) }}</span> }
                      @default { <i class="tcv-fm-big" [attr.data-ico]="iconOf(f)" [fmIcon]="iconOf(f)"></i> }
                    }
                  </div>
                  <div class="tcv-fm-tile-name">
                    <i class="tcv-fm-kind-ico" [attr.data-ico]="iconOf(f)" [fmIcon]="iconOf(f)"></i>
                    <ng-container *ngTemplateOutlet="nameOf; context: { $implicit: it }" />
                  </div>
                  <div class="tcv-fm-tile-meta">
                    @if (filtering()) { <span>{{ pathOf(f.folder) }}</span> }
                    @else { <span>{{ fmt(f.bytes) }}</span><span>{{ when(f.created_at) }}</span> }
                  </div>
                  @if (it.ro) { <i class="fm-tile-lock" [fmIcon]="'lock'" [title]="whereText(f) | t"></i> }
                </div>
              }
            </div>
          }
        } @else {
          <div class="tcv-fm-list" role="rowgroup">
            <div class="tcv-fm-row tcv-fm-row-head" role="row">
              <button class="tcv-fm-col-name" (click)="setSort('name', true)">{{ 'Name' | t }}<i [fmIcon]="arrow('name')"></i></button>
              <button class="tcv-fm-col-kind" (click)="setSort('kind', true)">{{ 'Kind' | t }}<i [fmIcon]="arrow('kind')"></i></button>
              <button class="tcv-fm-col-size" (click)="setSort('size', true)">{{ 'Size' | t }}<i [fmIcon]="arrow('size')"></i></button>
              <button class="tcv-fm-col-date" (click)="setSort('date', true)">{{ 'Added' | t }}<i [fmIcon]="arrow('date')"></i></button>
              <span class="tcv-fm-col-by">{{ 'By' | t }}</span>
              <span class="tcv-fm-col-link">{{ 'For' | t }}</span>
            </div>
            @for (it of items(); track it.key) {
              <div class="tcv-fm-row" role="row" tabindex="-1" [attr.data-key]="it.key"
                   [attr.aria-selected]="isSel(it.key)" [attr.data-on]="isSel(it.key) ? 1 : null"
                   [attr.data-focus]="focusKey() === it.key ? 1 : null" [attr.data-drop]="dropAt() === it.key ? 1 : null"
                   [attr.draggable]="it.ro ? null : 'true'" (dragstart)="dragStart($event, it.key)"
                   (dragover)="it.folder && over($event, it.key)" (dragleave)="it.folder && leave($event, it.key)"
                   (drop)="it.folder && dropOn($event, it.folder.id)"
                   (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                <span class="tcv-fm-col-name" role="gridcell">
                  @if (it.folder) { <i class="tcv-fm-kind-ico tcv-fm-dir-ico" [fmIcon]="'folder'"></i> }
                  @else { <i class="tcv-fm-kind-ico" [attr.data-ico]="iconOf(it.file!)" [fmIcon]="iconOf(it.file!)"></i> }
                  <ng-container *ngTemplateOutlet="nameOf; context: { $implicit: it }" />
                  @if (filtering() && it.file) { <em class="tcv-fm-where">{{ pathOf(it.file.folder) }}</em> }
                  @if (it.ro) { <i class="fm-row-lock" [fmIcon]="'lock'" [title]="whereText(it.file || it.folder!) | t"></i> }
                </span>
                <span class="tcv-fm-col-kind" role="gridcell">{{ it.folder ? ('Folder' | t) : (kindLabel(it.file!.kind) | t) }}</span>
                <span class="tcv-fm-col-size" role="gridcell">{{ it.file ? fmt(it.file.bytes) : '' }}</span>
                <span class="tcv-fm-col-date" role="gridcell">{{ when((it.file || it.folder)!.created_at) }}</span>
                <span class="tcv-fm-col-by" role="gridcell">{{ (it.file || it.folder)!.by.name || '' }}</span>
                <span class="tcv-fm-col-link" role="gridcell">{{ it.file ? (it.file.context.board || it.file.context.model || '') : '' }}</span>
              </div>
            }
          </div>
        }
      </div>

      @if (details()) {
        <aside class="tcv-fm-details" [attr.aria-label]="'Details' | t">
          <ng-container *ngTemplateOutlet="detailsOf; context: { $implicit: detailFile(), folder: detailFolder() }" />
        </aside>
      }
    </div>
    }

    @if (dropAt() === 'main' && dragFiles()) {
      <div class="tcv-fm-dropzone"><i [fmIcon]="'upload'"></i>{{ 'Drop to upload to' | t }} {{ hereName() }}</div>
    }
  </section>

  <!-- a name, or the box that renames it -->
  <ng-template #nameOf let-it>
    @if (renaming() === it.key) {
      <input class="tcv-fm-rename" [value]="renameTo()" (input)="renameTo.set($any($event.target).value)"
             (keydown.enter)="commitRename(); $event.stopPropagation()" (keydown.escape)="renaming.set(null); $event.stopPropagation()"
             (keydown)="$event.stopPropagation()" (blur)="commitRename()" (click)="$event.stopPropagation()"
             (dblclick)="$event.stopPropagation()" [attr.aria-label]="'New name' | t">
    } @else {
      <span class="tcv-fm-name" [title]="(it.file || it.folder).name">{{ it.folder?.root || it.folder?.build ? (it.folder.name | t) : (it.file || it.folder).name }}</span>
    }
  </ng-template>

  <!-- what the details pane says -->
  <ng-template #detailsOf let-f let-dir="folder">
    @if (f) {
      <div class="tcv-fm-d-head">
        <i class="tcv-fm-kind-ico" [attr.data-ico]="iconOf(f)" [fmIcon]="iconOf(f)"></i>
        <b>{{ f.name }}</b>
      </div>
      @if (f.preview === 'image') { <img class="tcv-fm-d-pic" [src]="f.name.toLowerCase().endsWith('.svg') ? inline(f.id) : thumb(f.id)" alt=""> }
      @else if (thumbOf(f) === 'solid') { <div class="tcv-fm-d-pic tcv-fm-d-solid"><img class="tcv-fm-solid" [src]="solid(f)" alt=""></div> }
      <dl class="tcv-fm-d-props">
        <dt>{{ 'Kind' | t }}</dt><dd>{{ kindLabel(f.kind) | t }}</dd>
        <dt>{{ 'Size' | t }}</dt><dd>{{ fmt(f.bytes) }}</dd>
        <dt>{{ 'Location' | t }}</dt><dd>{{ pathOf(f.folder) }}</dd>
        <dt>{{ 'Added' | t }}</dt><dd>{{ long(f.created_at) }}</dd>
        <dt>{{ 'By' | t }}</dt><dd>{{ f.by.name || ('someone' | t) }}</dd>
        @if (f.model) { <dt>{{ 'Model' | t }}</dt><dd><button class="tcv-fm-link" (click)="openModel(f.model)">{{ f.model }}</button></dd> }
        @if (f.ro && f.stored != null && f.stored !== f.bytes) { <dt>{{ 'Kept as' | t }}</dt><dd>{{ fmt(f.stored) }} {{ 'in the database' | t }}</dd> }
        @if (!f.ro) {
          <dt>{{ 'Board' | t }}</dt>
          <dd>
            @if (auth.can('draw')) {
              <wb-select class="tcv-fm-wsel tcv-fm-d-board" label="Board" [options]="boardOpts()" [value]="f.context.board || ''" (pick)="setBoard(f, $event)" />
            } @else { {{ f.context.board || '-' }} }
          </dd>
        }
      </dl>
      @if (f.ro) {
        <p class="fm-d-ro"><i [fmIcon]="'lock'"></i><span>{{ 'Read-only here.' | t }} {{ whereText(f) | t }}</span></p>
        @if (openable(f.open); as label) {
          <button class="tcv-btn tcv-fm-btn fm-d-open" (click)="openThere(f.open)"><i [fmIcon]="'open'"></i><span>{{ label | t }}</span></button>
        }
      } @else {
      <label class="tcv-fm-d-label" [for]="'fm-note-' + f.id">{{ 'Note' | t }}</label>
      @if (auth.can('draw')) {
        <textarea class="tcv-fm-d-note" [id]="'fm-note-' + f.id" rows="3" [value]="f.note" [placeholder]="'A line about it - the agent reads it too' | t"
                  (blur)="saveNote(f, $any($event.target).value)" (keydown.control.enter)="$any($event.target).blur()"></textarea>
      } @else { <p class="tcv-fm-d-text">{{ f.note || '-' }}</p> }
      <div class="tcv-fm-d-label">{{ 'Sent to an agent' | t }}</div>
      @if (sentOf(f).length) {
        <ul class="tcv-fm-d-sent">
          @for (s of sentOf(f); track $index) {
            <li><b>{{ roomLabel(s.room) | t }}</b><span>{{ long(s.at) }}{{ s.by ? ' · ' + s.by : '' }}</span></li>
          }
        </ul>
      } @else { <p class="tcv-fm-d-text tcv-fm-quiet">{{ 'Not yet. Send to agent puts a line in a room\\'s thread with the command that fetches it.' | t }}</p> }
      }
    } @else if (dir) {
      <div class="tcv-fm-d-head"><i class="tcv-fm-kind-ico tcv-fm-dir-ico" [fmIcon]="'folder'"></i><b>{{ dir.id ? dir.name : ('My files' | t) }}</b></div>
      <dl class="tcv-fm-d-props">
        <dt>{{ 'Location' | t }}</dt><dd>{{ dir.id ? pathOf(dir.parent) : '-' }}</dd>
        <dt>{{ 'Holds' | t }}</dt><dd>{{ stats(dir.id).files }} {{ 'files' | t }}, {{ stats(dir.id).folders }} {{ 'folders' | t }}</dd>
        <dt>{{ 'Size' | t }}</dt><dd>{{ fmt(stats(dir.id).bytes) }}</dd>
        @if (dir.id) {
          <dt>{{ 'Made' | t }}</dt><dd>{{ long(dir.created_at) }}</dd>
          <dt>{{ 'By' | t }}</dt><dd>{{ dir.by?.name || ('someone' | t) }}</dd>
        }
      </dl>
    } @else {
      <div class="tcv-fm-d-head"><b>{{ selected().size }} {{ 'selected' | t }}</b></div>
      <dl class="tcv-fm-d-props"><dt>{{ 'Size' | t }}</dt><dd>{{ fmt(selBytes()) }}</dd></dl>
    }
  </ng-template>

  <!-- dialogs -->
  @if (dialog(); as d) {
    <div class="tcv-fm-scrim" animate.leave="tcv-leave" (click)="dialog.set(null)" (keydown.escape)="dialog.set(null)">
      <div class="tcv-fm-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        @switch (d.type) {
          @case ('new-folder') {
            <h3>{{ 'New folder' | t }}</h3>
            <p class="tcv-fm-quiet">{{ 'In' | t }} {{ hereName() }}</p>
            <input class="tcv-fm-input" [value]="$any(d).name" (input)="patchDialog({ name: $any($event.target).value })"
                   (keydown.enter)="makeFolder()" [attr.aria-label]="'Folder name' | t" autofocus>
            @if ($any(d).error) { <p class="tcv-fm-err">{{ $any(d).error }}</p> }
            <footer><button class="tcv-btn tcv-fm-btn" (click)="dialog.set(null)">{{ 'Cancel' | t }}</button>
              <button class="tcv-btn tcv-btn-accent tcv-fm-btn" [disabled]="$any(d).busy || !$any(d).name.trim()" (click)="makeFolder()">{{ 'Create' | t }}</button></footer>
          }
          @case ('move') {
            <h3>{{ 'Move to…' | t }}</h3>
            <div class="tcv-fm-pick" role="tree">
              @for (row of moveRows(); track row.id) {
                <button class="tcv-fm-pick-row" role="treeitem" [style.padding-left.px]="8 + row.depth * 16"
                        [disabled]="row.off" [attr.data-on]="$any(d).to === row.id ? 1 : null" [attr.aria-selected]="$any(d).to === row.id"
                        (click)="patchDialog({ to: row.id })" (dblclick)="patchDialog({ to: row.id }); doMove()">
                  <i [fmIcon]="'folder'"></i><span>{{ row.id ? row.name : ('My files' | t) }}</span></button>
              }
            </div>
            @if ($any(d).error) { <p class="tcv-fm-err">{{ $any(d).error }}</p> }
            <footer><button class="tcv-btn tcv-fm-btn" (click)="dialog.set(null)">{{ 'Cancel' | t }}</button>
              <button class="tcv-btn tcv-btn-accent tcv-fm-btn" [disabled]="$any(d).busy" (click)="doMove()">{{ 'Move here' | t }}</button></footer>
          }
          @case ('add') {
            <h3>{{ 'Add to project' | t }}</h3>
            <p class="tcv-fm-quiet">{{ 'Copy it into a project folder as a 3D model - it stays there even if this file is deleted' | t }}</p>
            <label class="tcv-fm-field">{{ 'Folder' | t }}
              <wb-select class="tcv-fm-wsel" label="Folder" [options]="plain($any(d).folders)" [value]="$any(d).folder" (pick)="patchDialog({ folder: $event })" /></label>
            <label class="tcv-fm-field">{{ 'Name' | t }}
              <input class="tcv-fm-input" [value]="$any(d).title" (input)="patchDialog({ title: $any($event.target).value })"></label>
            @if ($any(d).error) { <p class="tcv-fm-err">{{ $any(d).error }}</p> }
            <footer><button class="tcv-btn tcv-fm-btn" (click)="dialog.set(null)">{{ 'Cancel' | t }}</button>
              <button class="tcv-btn tcv-btn-accent tcv-fm-btn" [disabled]="$any(d).busy || !$any(d).folder" (click)="add()">{{ 'Add' | t }}</button></footer>
          }
          @case ('confirm') {
            <h3>{{ $any(d).title }}</h3>
            <p>{{ $any(d).body }}</p>
            <footer><button class="tcv-btn tcv-fm-btn" (click)="dialog.set(null)">{{ 'Cancel' | t }}</button>
              <button class="tcv-btn tcv-fm-btn tcv-fm-danger" (click)="dialog.set(null); $any(d).run()">{{ $any(d).ok }}</button></footer>
          }
        }
      </div>
    </div>
  }

  <!-- How much there is, laid out as Analytics lays out its own (rooms/analyze.ts, admin-overview.ts):
       a range at the top, the areas, what the range added, the files themselves, and by kind. -->
  <ng-template #storageView>
    <div class="fm-sv">
      <header class="tcv-dash-bar">
        <div class="tcv-dash-seg" role="group" [attr.aria-label]="'Range' | t">
          @for (r of svRanges; track r.id) {
            <button type="button" (click)="setRange(r.id)" [attr.data-on]="usage()?.range === r.id ? 1 : null"
                    [attr.aria-pressed]="usage()?.range === r.id">{{ r.label | t }}</button>
          }
        </div>
        @if (usage(); as u) {
          <span class="tcv-dash-meta">{{ fmt(u.total.bytes) }} · {{ u.total.files }} {{ 'files' | t }}
            · {{ 'kept as' | t }} {{ fmt(u.total.stored) }} {{ 'in the database' | t }} · {{ 'since' | t }} {{ dayLabel(u.first, true) }}</span>
        }
        <span class="flex-1"></span>
        <button type="button" class="tcv-btn px-2 py-0.5" (click)="exportCsv()" [disabled]="!usage()" [title]="'the files below, as CSV' | t">CSV</button>
        <button type="button" class="tcv-btn px-2 py-0.5" (click)="loadUsage()" [title]="'read it again' | t">↻</button>
      </header>
      @if (usage(); as u) {
        <div class="tcv-dash-grid fm-sv-grid">
          @for (a of areaRows(); track a.id) {
            <button type="button" class="tcv-stat c3 fm-sv-area" (click)="go(a.root)" [title]="a.hint | t">
              <span><i [style.background]="a.color"></i>{{ a.label | t }}</span>
              <b>{{ fmt(a.bytes) }}</b>
              <em>{{ a.files }} {{ 'files' | t }} · {{ pct(a.bytes, u.total.bytes) }}{{ a.stored !== a.bytes ? ' · ' + ('kept as' | t) + ' ' + fmt(a.stored) : '' }}</em>
              @if (a.shared?.files) { <em>{{ 'also uses' | t }} {{ a.shared!.files }} {{ 'files counted elsewhere' | t }} ({{ fmt(a.shared!.bytes) }})</em> }
            </button>
          }
          <section class="tcv-panel-d c8"><h3>{{ 'Added' | t }} <span class="tcv-dash-dim">{{ 'per' | t }} {{ (u.chart.step > 86400 ? 'week' : 'day') | t }}
              · {{ fmt(u.added.bytes) }}, {{ u.added.files }} {{ 'files' | t }}</span></h3>
            <app-time-chart [data]="chartData()" kind="bar" [f]="fmtBytes" [height]="180" /></section>
          <section class="tcv-panel-d c4"><h3>{{ 'By area' | t }}</h3>
            <app-donut [rows]="areaDonut()" [f]="fmtBytes" /></section>
          <section class="tcv-panel-d c8 fm-sv-files"><h3>{{ 'Files' | t }} <span class="tcv-dash-dim">{{ tableRows().length }} {{ 'of' | t }} {{ u.total.files }}, {{ 'largest first' | t }}</span>
              <span class="flex-1"></span>
              <span class="tcv-dash-seg fm-sv-filter" role="group" [attr.aria-label]="'Area' | t">
                <button type="button" (click)="tableArea.set('')" [attr.data-on]="!tableArea() ? 1 : null">{{ 'All' | t }}</button>
                @for (a of areaRows(); track a.id) {
                  <button type="button" (click)="tableArea.set(a.id)" [attr.data-on]="tableArea() === a.id ? 1 : null">{{ a.label | t }}</button>
                }
              </span></h3>
            <div class="fm-sv-scroll">
              <table class="tcv-dash-table fm-sv-table">
                <thead><tr>
                  @for (c of svCols; track c.id) {
                    <th [class.r]="c.r"><button type="button" (click)="sortBy(c.id)">{{ c.label | t }}{{ tableSort() === c.id ? (tableDir() < 0 ? ' ↓' : ' ↑') : '' }}</button></th>
                  }
                </tr></thead>
                <tbody>
                  @for (r of tableRows(); track r.id) {
                    <tr (click)="openLargest(r)" [title]="pathOf(r.folder) + '/' + r.name">
                      <td><i class="tcv-fm-kind-ico" [fmIcon]="r.kind === 'build' ? 'cube' : iconOf({ kind: r.kind, name: r.name })"></i>{{ r.name }}</td>
                      <td><i class="fm-sv-dot" [style.background]="areaColor(r.area)"></i>{{ areaLabel(r.area) | t }}</td>
                      <td>{{ kindLabel(r.kind) | t }}</td>
                      <td class="r mono">{{ fmt(r.bytes) }}</td>
                      <td class="r mono" [title]="r.at ? long(r.at) : ''">{{ r.at ? shortDay(r.at) : '–' }}</td>
                    </tr>
                  } @empty { <tr><td colspan="5" class="tcv-dash-dim">{{ 'Nothing here.' | t }}</td></tr> }
                </tbody>
              </table>
            </div></section>
          <section class="tcv-panel-d c4"><h3>{{ 'By kind' | t }} <i [title]="'Build outputs are what the rooms\\' builds keep for themselves - the 3D view\\'s mesh, a board\\'s layers' | t">?</i></h3>
            <app-bar-list [rows]="kindBars()" [f]="fmtBytes" /></section>
        </div>
      } @else if (usageErr()) {
        <p class="tcv-dash-note">{{ 'The figures did not load' | t }}</p>
      } @else {
        <div class="tcv-dash-grid fm-sv-grid">
          <wb-skel class="c12" kind="tiles" [count]="4" [min]="200" [h]="72" />
          <section class="tcv-panel-d c8"><wb-skel kind="chart" [h]="180" /></section>
          <section class="tcv-panel-d c4"><wb-skel kind="rows" [count]="5" [h]="20" /></section>
        </div>
      }
    </div>
  </ng-template>

  <!-- The trash: what was deleted from Files, where it was, by whom, and how long it is kept -->
  <ng-template #trashView>
    <div class="fm-sv">
      <header class="tcv-dash-bar">
        <span class="tcv-dash-meta">{{ trashRows().length }} {{ 'files' | t }} · {{ fmt(trashBytes()) }} ·
          {{ 'kept for' | t }} {{ trashDays() }} {{ 'days, then deleted for good' | t }}</span>
        <span class="flex-1"></span>
        @if (auth.can('draw') && trashRows().length) {
          <button type="button" class="tcv-btn px-2 py-0.5" (click)="restore(trashRows())">{{ 'Restore all' | t }}</button>
          <button type="button" class="tcv-btn px-2 py-0.5 tcv-fm-danger" (click)="askPurge(trashRows())">{{ 'Empty trash' | t }}</button>
        }
        <button type="button" class="tcv-btn px-2 py-0.5" (click)="loadTrash()" [title]="'read it again' | t">↻</button>
      </header>
      <div class="tcv-dash-grid fm-tv-grid">
        <section class="tcv-panel-d c12 fm-sv-files">
          <div class="fm-sv-scroll">
            <table class="tcv-dash-table fm-tv-table">
              <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Was in' | t }}</th><th>{{ 'Deleted by' | t }}</th><th class="r">{{ 'Deleted' | t }}</th>
                <th class="r">{{ 'Size' | t }}</th><th class="r">{{ 'Days left' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (f of trashRows(); track f.id) {
                  <tr>
                    <td [title]="f.name"><i class="tcv-fm-kind-ico" [fmIcon]="iconOf(f)"></i>{{ f.name }}</td>
                    <td [title]="f.folder_path || ('My files' | t)">{{ f.folder_path || ('My files' | t) }}</td>
                    <td>{{ f.deleted_by?.name || ('someone' | t) }}</td>
                    <td class="r mono" [title]="long(f.deleted_at)">{{ when(f.deleted_at) }}</td>
                    <td class="r mono">{{ fmt(f.bytes) }}</td>
                    <td class="r mono" [attr.data-soon]="(f.days_left ?? 99) <= 3 ? 1 : null">{{ f.days_left ?? '–' }}</td>
                    <td class="r fm-tv-acts">
                      @if (auth.can('draw')) {
                        <button type="button" class="tcv-btn px-2 py-0.5" (click)="restore([f])">{{ 'Restore' | t }}</button>
                        <button type="button" class="tcv-fm-icon-btn" (click)="askPurge([f])" [title]="'Delete for good' | t"
                                [attr.aria-label]="'Delete for good' | t"><i [fmIcon]="'trash'"></i></button>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="tcv-dash-dim">{{ trashLoaded() ? ('The trash is empty.' | t) : ('Counting…' | t) }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </ng-template>

  <!-- the preview -->
  @if (previewFile(); as f) {
    <div class="tcv-fm-preview" animate.leave="tcv-leave" role="dialog" aria-modal="true" [attr.aria-label]="f.name">
      <header class="tcv-fm-pv-head">
        <button class="tcv-fm-icon-btn" (click)="closePreview()" [title]="'Close (Esc)' | t" [attr.aria-label]="'Close' | t"><i [fmIcon]="'close'"></i></button>
        <i class="tcv-fm-kind-ico" [attr.data-ico]="iconOf(f)" [fmIcon]="iconOf(f)"></i>
        <div class="tcv-fm-pv-title">
          <b [title]="f.name">{{ f.name }}</b>
          <span>{{ fmt(f.bytes) }} · {{ kindLabel(f.kind) | t }} · {{ f.by.name || ('someone' | t) }} · {{ long(f.created_at) }}</span>
        </div>
        @if (previewList().length > 1) {
          <span class="tcv-fm-pv-step">
            <button class="tcv-fm-icon-btn" (click)="step(-1)" [disabled]="previewAt() <= 0" [title]="'Previous (←)' | t" [attr.aria-label]="'Previous' | t"><i [fmIcon]="'left'"></i></button>
            <span>{{ previewAt() + 1 }} / {{ previewList().length }}</span>
            <button class="tcv-fm-icon-btn" (click)="step(1)" [disabled]="previewAt() >= previewList().length - 1" [title]="'Next (→)' | t" [attr.aria-label]="'Next' | t"><i [fmIcon]="'right'"></i></button>
          </span>
        }
        <span class="tcv-fm-grow"></span>
        <a class="tcv-fm-icon-btn" [href]="dl(f.id)" [attr.download]="f.name" [title]="'Download' | t" [attr.aria-label]="'Download' | t"><i [fmIcon]="'download'"></i></a>
        @if (auth.can('draw') && !f.ro) {
          <button class="tcv-fm-icon-btn" (click)="sendMenu($event, f)" [title]="'Send to agent…' | t" [attr.aria-label]="'Send to agent…' | t"><i [fmIcon]="'send'"></i></button>
        }
        <button class="tcv-fm-icon-btn" [attr.data-on]="details() ? 1 : null" (click)="details.set(!details()); save()"
                [title]="'Details' | t" [attr.aria-label]="'Details' | t"><i [fmIcon]="'info'"></i></button>
        <button class="tcv-fm-icon-btn" (click)="openMenu($event, 'f:' + f.id, true)" [title]="'More actions' | t" [attr.aria-label]="'More actions' | t"><i [fmIcon]="'more'"></i></button>
      </header>
      <div class="tcv-fm-pv-body">
        <div class="tcv-fm-pv-stage">
          <app-file-view [file]="f" [canEdit]="auth.can('edit') && !f.ro" (act)="$event === 'add' ? startAdd(f) : openModel(f.model!)" />
          @if (sideNav(f) && previewAt() > 0) {
            <button class="tcv-fm-pv-nav tcv-fm-pv-prev" (click)="step(-1)" [title]="'Previous' | t" [attr.aria-label]="'Previous' | t"><i [fmIcon]="'left'"></i></button>
          }
          @if (sideNav(f) && previewAt() < previewList().length - 1) {
            <button class="tcv-fm-pv-nav tcv-fm-pv-next" (click)="step(1)" [title]="'Next' | t" [attr.aria-label]="'Next' | t"><i [fmIcon]="'right'"></i></button>
          }
        </div>
        @if (details()) {
          <aside class="tcv-fm-details tcv-fm-pv-details" [attr.aria-label]="'Details' | t">
            <ng-container *ngTemplateOutlet="detailsOf; context: { $implicit: f, folder: null }" />
          </aside>
        }
      </div>
    </div>
  }
</div>`,
})
export class RoomFiles implements OnDestroy {
  private api = inject(FilesApi);
  private catalog = inject(Catalog);
  private solids = inject(MeshThumbs);
  picked = inject(Selection);
  auth = inject(Auth);

  readonly rooms = AGENT_ROOMS;
  readonly skeleton = Array.from({ length: 12 }, (_, i) => i);
  fmt = size;
  iconOf = iconOf;
  inline = inlineUrl;
  thumb = thumbUrl;
  dl = downloadUrl;
  readonly STORAGE = STORAGE;
  readonly TRASH = TRASH;
  /** Which side the column shows: one's own files (always first), or what the app keeps. Not remembered. */
  side = signal<'mine' | 'app'>('mine');
  trashRows = signal<TrashFile[]>([]);
  trashLoaded = signal(false);
  trashDays = signal(30);
  trashBytes = computed(() => this.trashRows().reduce((n, f) => n + f.bytes, 0));

  // ---- what there is
  all = signal<StoredFile[]>([]);
  folders = signal<FileFolder[]>([]);
  loading = signal(true);
  /** The read-only folders (backend/files_virtual.py): Projects, Chat, Parts,
   *  what is in them, the Projects' own files, and which uploads the Chat's
   *  and Parts' folders refer to. */
  vfolders = signal<FileFolder[]>([]);
  vfiles = signal<StoredFile[]>([]);
  private vlinks = signal<{ folder: string; file: string }[]>([]);
  private vLoaded = signal(false);
  usage = signal<FilesUsage | null>(null);
  usageErr = signal(false);

  boards = signal<{ _id: string; title?: string }[]>([]);

  // ---- where, how
  private prefs = readPrefs();
  here = signal('');
  view = signal<'grid' | 'list'>(this.prefs.view === 'list' ? 'list' : 'grid');
  sortKey = signal<SortKey>(this.prefs.sort ?? 'name');
  sortDir = signal<1 | -1>(this.prefs.dir ?? 1);
  details = signal(this.prefs.details ?? false);
  private opened = signal<Set<string>>(new Set(['', ...(this.prefs.open ?? [])]));
  q = signal('');
  kind = signal('');
  board = signal('');
  /** Which board a new file goes with: the one last open in the PCB room. */

  // ---- what is picked
  selected = signal<Set<string>>(new Set());
  private anchor: string | null = null;
  focusKey = signal<string | null>(null);
  renaming = signal<string | null>(null);
  renameTo = signal('');
  dialog = signal<Dialog | null>(null);
  preview = signal<string | null>(null);

  // ---- doing
  progress = signal<number | null>(null);
  uploading = signal('');
  error = signal<string | null>(null);
  dropAt = signal<string | null>(null);
  dragFiles = signal(false);
  /** Thumbnails worked out here: a PDF's first page, a text's first lines. */
  pics = signal<Record<string, string>>({});
  private noPic = signal<Set<string>>(new Set());
  /** Videos that have been on screen: only they fetch a frame to show. */
  private visible = signal<Set<string>>(new Set());
  /** Re-read every minute, so "3 min ago" moves on without a check failing. */
  private now = signal(Date.now());
  private tick = setInterval(() => this.now.set(Date.now()), 60_000);

  // ---- derived
  private byId = computed(() => new Map([...this.folders(), ...this.vfolders()].map(f => [f.id, f])));
  /** One's own uploads: the Parts page's are under In the app > Parts, read-only (backend/files_virtual.py parts_owned). */
  mine = computed(() => this.all().filter(f => f.where !== 'parts'));
  private kids = computed(() => {
    const m = new Map<string, FileFolder[]>();
    for (const f of this.folders().filter(x => !x.ro)) {
      const p = this.byId().has(f.parent) ? f.parent : '';
      m.set(p, [...(m.get(p) ?? []), f]);
    }
    for (const v of m.values()) v.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // The read-only roots stand apart from My files; under them, the server's order
    // for the conversations (the latest first), names for the rest.
    for (const f of this.vfolders()) if (!f.root) m.set(f.parent, [...(m.get(f.parent) ?? []), f]);
    for (const [p, v] of m) {
      if (isV(p) && p !== 'v:chat') v.sort((a, b) => Number(!!a.build) - Number(!!b.build) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    return m;
  });
  vroots = computed(() => this.vfolders().filter(f => f.root));
  hereFolder = computed(() => this.byId().get(this.here()) ?? null);
  /** A file whose folder is gone, or from before folders, is at the top. */
  private placeOf = (f: StoredFile) => this.byId().has(f.folder) ? f.folder : '';
  filtering = computed(() => !!(this.q().trim() || this.kind() || this.board()));
  /** Every file's kind, the Projects' too, as the storage overview counts them (build outputs apart). */
  kinds = computed(() => {
    const n = new Map<string, { n: number; bytes: number }>();
    for (const f of [...this.all(), ...this.vfiles()]) {
      const k = n.get(kindOf(f)) ?? { n: 0, bytes: 0 };
      n.set(kindOf(f), { n: k.n + 1, bytes: k.bytes + f.bytes });
    }
    const top = Math.max(1, ...[...n.values()].map(v => v.bytes));
    return [...n.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([kind, v]) => ({ kind, ...v, share: 100 * v.bytes / top }));
  });
  readonly plain = plainOptions;
  kindOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All kinds') },
    ...this.kinds().map(k => ({ value: k.kind, label: t(this.kindLabel(k.kind)), hint: k.n }))]);
  sortOpts = computed<SelectOption[]>(() => [{ value: 'name', label: t('Name') }, { value: 'date', label: t('Date added') },
    { value: 'size', label: t('Size') }, { value: 'kind', label: t('Kind') }]);
  boardOpts = computed<SelectOption[]>(() => [{ value: '', label: t('(no board)') },
    ...this.boards().map(b => ({ value: b._id, label: b.title || b._id }))]);
  boardsUsed = computed(() => [...new Set(this.all().map(f => f.context.board).filter((b): b is string => !!b))].sort());

  items = computed<Item[]>(() => {
    let dirs: FileFolder[], files: StoredFile[];
    const inV = isV(this.here()) && !this.filtering();
    if (this.filtering()) {
      const q = this.q().trim().toLowerCase(), k = this.kind(), b = this.board();
      // The Projects' own files are searched too; a board filter is about uploads.
      files = [...this.all(), ...(b ? [] : this.vfiles())].filter(f => (!k || kindOf(f) === k) && (!b || f.context.board === b)
        && (!q || f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q)));
      dirs = q && !k && !b ? this.folders().filter(f => f.name.toLowerCase().includes(q)) : [];
    } else if (inV) {
      const here = this.here(), real = new Map(this.all().map(f => [f.id, f]));
      dirs = this.kids().get(here) ?? [];
      files = [...this.vfiles().filter(f => f.folder === here),
               ...this.vlinks().filter(l => l.folder === here).map(l => real.get(l.file)).filter((f): f is StoredFile => !!f)];
    } else {
      const here = this.here();
      dirs = this.kids().get(here) ?? [];
      files = this.mine().filter(f => this.placeOf(f) === here);
    }
    const dir = this.sortDir(), key = this.sortKey();
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const fileCmp = (a: StoredFile, b: StoredFile) =>
      (key === 'size' ? a.bytes - b.bytes
        : key === 'date' ? a.created_at.localeCompare(b.created_at)
        : key === 'kind' ? a.kind.localeCompare(b.kind) || byName(a, b)
        : byName(a, b)) * dir;
    const dirCmp = (a: FileFolder, b: FileFolder) =>
      (key === 'date' ? (a.created_at ?? '').localeCompare(b.created_at ?? '') : byName(a, b)) * (key === 'name' || key === 'date' ? dir : 1);
    return [...(inV && this.here() === 'v:chat' ? dirs : [...dirs].sort(dirCmp)).map(f => ({ key: 'd:' + f.id, folder: f, ro: !!f.ro })),
            ...[...files].sort(fileCmp).map(f => ({ key: 'f:' + f.id, file: f, ro: inV || !!f.ro }))];
  });
  folderItems = computed(() => this.items().filter(i => i.folder));
  fileItems = computed(() => this.items().filter(i => i.file));
  crumbs = computed(() => {
    if (this.here() === STORAGE) return [{ id: STORAGE, name: 'Storage' }];
    if (this.here() === TRASH) return [{ id: TRASH, name: 'Deleted files' }];
    const out: { id: string; name: string }[] = [];
    let at = this.byId().get(this.here());
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) { seen.add(at.id); out.unshift({ id: at.id, name: at.name }); at = this.byId().get(at.parent); }
    // A read-only folder's way starts at its root (Projects, Chat, Parts), not at My files.
    return isV(this.here()) ? out : [{ id: '', name: '' }, ...out];
  });
  hereName = computed(() => this.byId().get(this.here())?.name ?? t('My files'));
  selKeys = computed(() => [...this.selected()]);
  /** Something picked is read-only: no moving, renaming or deleting it from here. */
  selRo = computed(() => {
    const ro = new Set(this.items().filter(i => i.ro).map(i => i.key));
    return this.selKeys().some(k => ro.has(k) || isV(k.slice(2)));
  });
  /** The areas on the storage bar, with their figures and colours. */
  areaRows = computed(() => {
    const u = this.usage();
    return AREAS.map((a, i) => ({ ...a, color: color(i), bytes: u?.areas[a.id]?.bytes ?? 0, files: u?.areas[a.id]?.files ?? 0,
                                  stored: u?.areas[a.id]?.stored ?? 0, shared: u?.areas[a.id]?.shared,
                                  hint: a.id === 'own' ? 'What people uploaded, in their own folders' : WHERE_LABEL[a.id === 'projects' ? 'projects' : a.id] }));
  });
  readonly svRanges = [{ id: '7d', label: '7d' }, { id: '30d', label: '30d' }, { id: '90d', label: '90d' }, { id: 'all', label: 'All' }];
  readonly svCols = [{ id: 'name', label: 'Name', r: false }, { id: 'area', label: 'Area', r: false }, { id: 'kind', label: 'Kind', r: false },
                     { id: 'bytes', label: 'Size', r: true }, { id: 'at', label: 'Added', r: true }] as const;
  readonly fmtBytes = cfmt.bytes;
  tableArea = signal<Area | ''>('');
  tableSort = signal<'name' | 'area' | 'kind' | 'bytes' | 'at'>('bytes');
  tableDir = signal<1 | -1>(-1);
  /** What the range added, each area a series in its colour - the Analytics chart. */
  chartData = computed<TimeData>(() => {
    const c = this.usage()?.chart;
    return c ? { ...c, series: c.series.map(s => ({ name: t(this.areaLabel(s.name as Area)), values: s.values })) }
             : { t0: 0, step: 86400, n: 0, series: [] };
  });
  areaDonut = computed<Row[]>(() => this.areaRows().map(a => ({ name: t(a.label), value: a.bytes, sub: `${a.files} ${t('files')}`, color: a.color })));
  kindBars = computed<Row[]>(() => Object.entries(this.usage()?.kinds ?? {}).slice(0, 10)
    .map(([k, v]) => ({ name: t(this.kindLabel(k)), value: v.bytes, sub: `${v.files} ${t('files')}` })));
  tableRows = computed<UsageRow[]>(() => {
    const a = this.tableArea(), k = this.tableSort(), d = this.tableDir();
    const rows = (this.usage()?.files ?? []).filter(r => !a || r.area === a);
    const by = (r: UsageRow) => k === 'bytes' ? r.bytes : k === 'at' ? (r.at ?? '') : k === 'area' ? r.area : k === 'kind' ? r.kind : r.name.toLowerCase();
    return [...rows].sort((x, y) => { const p = by(x), q = by(y); return (p < q ? -1 : p > q ? 1 : 0) * d; });
  });
  readonly bytesFmt = (v: number) => size(v);
  /** A small bar per area, for the Storage card. */
  areaCols = computed<StackCol[]>(() => this.areaRows().map(a => ({ label: t(a.label), parts: [{ name: t(a.label), n: a.bytes, color: a.color }] })));
  /** Each day of the week: uploads, and files deleted - for the Activity card. */
  weekCols = computed<StackCol[]>(() => (this.usage()?.week ?? []).map(d => ({
    label: this.dayLabel(d.day),
    parts: [{ name: t('uploaded'), n: d.added, color: color(0) }, { name: t('deleted'), n: d.deleted, color: color(3) }],
  })));
  weekSum = computed(() => (this.usage()?.week ?? []).reduce((s, d) => ({ added: s.added + d.added, bytes: s.bytes + d.added_bytes,
                                                                        deleted: s.deleted + d.deleted }), { added: 0, bytes: 0, deleted: 0 }));
  storageTip = computed(() => [
    ...this.areaRows().map(a => `${t(a.label)}: ${size(a.bytes)}, ${a.files} ${t('files')}`)].join('\n'));
  activityTip = computed(() => `${t('This week')}: ${this.weekSum().added} ${t('uploaded')} (${size(this.weekSum().bytes)}), `
    + `${this.weekSum().deleted} ${t('deleted')}`);
  singleFile = computed(() => {
    const k = this.selKeys();
    return k.length === 1 && k[0].startsWith('f:') ? this.fileById(k[0].slice(2)) : null;
  });
  selBytes = computed(() => this.selKeys().reduce((n, k) => n + (k.startsWith('f:') ? this.fileById(k.slice(2))?.bytes ?? 0
    : this.stats(k.slice(2)).bytes), 0));
  selZip = computed(() => {
    const k = this.selKeys();
    if (k.length === 1 && k[0].startsWith('f:')) return downloadUrl(k[0].slice(2));
    return zipUrl(k.filter(x => x.startsWith('f:')).map(x => x.slice(2)), k.filter(x => x.startsWith('d:')).map(x => x.slice(2)));
  });
  detailFile = computed(() => this.singleFile());
  detailFolder = computed<FileFolder | { id: string; name: string; parent: string; created_at: string; by: { name?: string } } | null>(() => {
    const k = this.selKeys();
    if (k.length === 1 && k[0].startsWith('d:')) return this.byId().get(k[0].slice(2)) ?? null;
    if (!k.length) return this.byId().get(this.here()) ?? { id: '', name: '', parent: '', created_at: '', by: {} };
    return null;
  });
  /** What the preview steps through: the files beside it here, or the
   *  file alone when it was opened from somewhere else. */
  previewList = computed(() => {
    const list = this.fileItems().map(i => i.file!);
    const f = this.previewFile();
    return f && !list.some(x => x.id === f.id) ? [f] : list;
  });
  previewAt = computed(() => this.previewList().findIndex(f => f.id === this.preview()));
  previewFile = computed(() => {
    const id = this.preview();
    return id ? this.fileById(id) : null;
  });
  moveRows = computed(() => {
    const d = this.dialog();
    const off = new Set<string>();
    if (d?.type === 'move') for (const id of d.folders) for (const x of this.subtree(id)) off.add(x);
    const rows: { id: string; name: string; depth: number; off: boolean }[] = [{ id: '', name: '', depth: 0, off: false }];
    const walk = (p: string, depth: number) => {
      for (const f of this.kids().get(p) ?? []) {
        rows.push({ id: f.id, name: f.name, depth, off: off.has(f.id) });
        walk(f.id, depth + 1);
      }
    };
    walk('', 1);
    return rows;
  });

  constructor() {
    effect(() => {
      this.api.changed();
      untracked(() => this.load());
    });
    this.api.boards().subscribe({ next: b => this.boards.set(b), error: () => {} });

    // One file picked is the one the command palette offers to ask Chat about.
    effect(() => {
      const f = this.previewFile() ?? this.singleFile();
      // A Projects file is not an upload the Chat can be given.
      untracked(() => this.picked.file.set(f && !f.ro ? { id: f.id, label: f.name } : null));
    });
    // A file asked for from elsewhere (the Chat's viewer: "Open in Files"):
    // its folder, with it open - once the list has come.
    effect(() => {
      const w = this.picked.want();
      if (w?.what !== 'file' || !w.arg || this.loading()) return;
      const f = this.all().find(x => x.id === w.arg);
      untracked(() => {
        this.picked.want.set(null);
        const show = (x: StoredFile) => { this.go(this.placeOf(x)); this.open(x); };
        if (f) { show(f); return; }
        // Made since the list came (a PDF the Chat just wrote): the list again.
        this.api.list().subscribe({ next: rows => {
          this.all.set(rows);
          const g = rows.find(x => x.id === w.arg);
          if (g) show(g);
        }, error: () => {} });
      });
    });
    // A folder that went away takes you to the top.
    effect(() => {
      const here = this.here();
      if (here === STORAGE || here === TRASH || (isV(here) && !this.vLoaded())) return;
      if (!this.loading() && here && !this.byId().has(here)) untracked(() => this.here.set(''));
    });
  }

  ngOnDestroy() { clearInterval(this.tick); }

  load() {
    let left = 2;
    const done = () => { if (--left === 0) this.loading.set(false); };
    this.api.list().subscribe({ next: rows => { this.all.set(rows); done(); }, error: () => { done(); this.error.set(t('The files did not load.')); } });
    this.api.folders().subscribe({ next: rows => { this.folders.set(rows); done(); }, error: () => done() });
    this.api.virtual().subscribe({
      next: v => { this.vfolders.set(v.folders); this.vfiles.set(v.files); this.vlinks.set(v.links); this.vLoaded.set(true); },
      error: () => this.vLoaded.set(true),
    });
    this.loadUsage();
  }
  /** The figures, for the range picked (the server picks one at first: the shortest that holds what came lately). */
  loadUsage(range = this.usage()?.range ?? 'auto') {
    this.api.usage(range).subscribe({ next: u => { this.usage.set(u); this.usageErr.set(false); }, error: () => this.usageErr.set(true) });
  }
  setRange(r: string) { this.loadUsage(r); }
  showSide(s: 'mine' | 'app') {
    this.side.set(s);
    if (s === 'app' && !isV(this.here())) this.go('v:projects');
    else if (s === 'mine' && (isV(this.here()) || this.here() === STORAGE || this.here() === TRASH)) this.go('');
  }
  loadTrash() {
    this.api.trash().subscribe({
      next: r => { this.trashRows.set(r.files); this.trashDays.set(r.days); this.trashLoaded.set(true); },
      error: err => { this.trashLoaded.set(true); this.fail(err, 'The trash did not load.'); },
    });
  }
  restore(rows: TrashFile[]) {
    this.api.restore(rows.map(f => f.id)).subscribe({
      next: r => {
        if (r.restored.length) this.say(`${t('Restored')}: ${r.restored.map(f => f.name).join(', ')}`);
        for (const x of r.refused) this.say(`${x.name}: ${x.why}`, 'warn');
        this.loadTrash(); this.api.bump();
      },
      error: err => this.fail(err, 'Could not restore it.'),
    });
  }
  askPurge(rows: TrashFile[]) {
    const what = rows.length === 1 ? `“${rows[0].name}”` : `${rows.length} ${t('files')}`;
    this.dialog.set({ type: 'confirm', title: `${t('Delete for good')} ${what}?`, body: t('This cannot be undone.'), ok: t('Delete for good'),
                      run: () => this.api.purge(rows.map(f => f.id)).subscribe({
                        next: () => { this.loadTrash(); this.loadUsage(); }, error: err => this.fail(err, 'Could not delete it.') }) });
  }
  sortBy(k: 'name' | 'area' | 'kind' | 'bytes' | 'at') {
    if (this.tableSort() === k) this.tableDir.set(this.tableDir() === 1 ? -1 : 1);
    else { this.tableSort.set(k); this.tableDir.set(k === 'bytes' || k === 'at' ? -1 : 1); }
  }
  exportCsv() {
    const rows = this.tableRows().map(r => ({ name: r.name, area: r.area, kind: r.kind, bytes: r.bytes, added: r.at ?? '', where: this.pathOf(r.folder) }));
    saveFile('files-storage.csv', csvText(rows), 'text/csv');
  }

  save() {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ view: this.view(), sort: this.sortKey(), dir: this.sortDir(),
                                                   details: this.details(), open: [...this.opened()].filter(Boolean) }));
    } catch { /* private window */ }
  }

  // ---- small helpers for the template
  fileById(id: string) { return this.all().find(f => f.id === id) ?? this.vfiles().find(f => f.id === id) ?? null; }
  childrenOf(id: string) { return this.kids().get(id) ?? []; }
  isOpen(id: string) { return this.opened().has(id); }
  toggleOpen(id: string) {
    this.opened.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    this.save();
  }
  isSel(key: string) { return this.selected().has(key); }
  kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
  roomLabel(r: string) { return ROOM_LABEL[r] ?? r; }
  pathOf(folder: string) {
    if (!isV(folder)) return this.byId().get(folder)?.path ?? t('My files');
    const names: string[] = [];
    for (let at = this.byId().get(folder), n = 0; at && n < 40; at = this.byId().get(at.parent), n++) names.unshift(at.root ? t(at.name) : at.name);
    return names.join('/');
  }
  crumbName(c: { id: string; name: string }) { return !c.id ? 'My files' : c.name; }
  /** Where a read-only entry is changed, as the lock's tooltip says it. */
  whereText(x: { where?: string } | null | undefined) { return WHERE_LABEL[x?.where ?? ''] ?? 'Read-only'; }
  /** The button that opens a read-only entry where it is changed, if there is one. */
  openable(o?: VirtualOpen, chat?: string): string | null {
    if (chat) return 'Open the conversation';
    if (o?.model) return 'Open in the 3D Drawing room';
    if (o?.board) return 'Open in the PCB Design room';
    if (o?.firmware) return 'Open in the Firmware room';
    return null;
  }
  openThere(o?: VirtualOpen, chat?: string) {
    if (chat) this.picked.askCc({ action: 'open', chat });
    else if (o?.model) this.openModel(o.model);
    else if (o?.board) this.picked.openBoard(o.board);
    else if (o?.firmware) this.picked.openFirmware(o.firmware);
  }
  areaLabel(a: Area | string) { return AREAS.find(x => x.id === a)?.label ?? a; }
  areaColor(a: Area | string) { return color(Math.max(0, AREAS.findIndex(x => x.id === a))); }
  pct(n: number, of: number) { const p = of ? 100 * n / of : 0; return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`; }
  /** A date as short as it can be: the year only when it is not this one. */
  shortDay(iso: string) {
    const d = new Date(iso), y = d.getFullYear() !== new Date().getFullYear();
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y ? { year: '2-digit' } : {}) });
  }
  dayLabel(day?: string, year = false) {
    return day ? new Date(day + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }) : '';
  }
  /** One of the largest files, opened where it is. */
  openLargest(r: { id: string; folder: string }) {
    const f = this.fileById(r.id);
    if (!f) return;
    this.go(isV(r.id) ? f.folder : this.placeOf(f));
    this.open(f);
  }
  sentOf(f: StoredFile) { return [...(f.sent_log ?? (f.sent ? [f.sent] : []))].reverse(); }
  /** Big arrows at the sides only where they cover nothing to read. */
  sideNav(f: StoredFile) { return ['image', 'video', 'audio', 'step', 'none'].includes(f.preview); }
  arrow(k: SortKey) { return this.sortKey() === k ? (this.sortDir() === 1 ? 'up' : 'down') : ''; }
  private subtree(id: string): Set<string> {
    const out = new Set<string>([id]);
    const walk = (p: string) => { for (const k of this.kids().get(p) ?? []) if (!out.has(k.id)) { out.add(k.id); walk(k.id); } };
    walk(id);
    return out;
  }
  stats(id: string) {
    if (isV(id)) {
      const under = this.subtree(id);
      const real = new Map(this.all().map(f => [f.id, f]));
      const refs = new Set(this.vlinks().filter(l => under.has(l.folder)).map(l => l.file));
      const files = [...this.vfiles().filter(f => under.has(f.folder)), ...[...refs].map(i => real.get(i)).filter((f): f is StoredFile => !!f)];
      return { files: files.length, folders: under.size - 1, bytes: files.reduce((n, f) => n + f.bytes, 0) };
    }
    const under = id ? this.subtree(id) : null;
    const files = this.mine().filter(f => under ? under.has(f.folder) : true);
    return { files: files.length, folders: under ? under.size - 1 : this.folders().length,
             bytes: files.reduce((n, f) => n + f.bytes, 0) };
  }

  when(iso: string) {
    if (!iso) return '';
    const s = (this.now() - Date.parse(iso)) / 1000;
    if (s < 60) return t('just now');
    if (s < 3600) return `${Math.floor(s / 60)} ${t('min ago')}`;
    if (s < 86400) return `${Math.floor(s / 3600)} ${t('h ago')}`;
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  long(iso: string) {
    return iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }

  thumbOf(f: StoredFile): string {
    if (f.preview === 'image' && !this.noPic().has(f.id)) return 'img';
    if (f.preview === 'video' && this.visible().has(f.id)) return 'video';
    if (f.preview === 'pdf' && this.pics()[f.id]) return 'pdf';
    if ((f.preview === 'text' || f.preview === 'markdown') && this.pics()[f.id]) return 'snip';
    if ((f.preview === 'step' || f.preview === 'mesh') && !this.noPic().has(f.id)
        && (f.has_thumb || this.solids.drawn()[f.id])) return 'solid';
    return '';
  }
  noThumb(id: string) { this.noPic.update(s => new Set(s).add(id)); }
  /** A 3D file's picture: drawn on this page, or the one kept on the server
   *  (its address changes with the picture, so it is cached for long). */
  solid(f: StoredFile): string { return this.solids.drawn()[f.id] ?? `${thumbUrl(f.id)}?v=${f.has_thumb}`; }
  badge(f: StoredFile): string { return f.preview === 'step' ? 'STEP' : extOf(f.name).toUpperCase(); }

  /** A tile came into view: work out its picture, if it has one to work out. */
  seen(f: StoredFile) {
    if (f.preview === 'video') { this.visible.update(s => new Set(s).add(f.id)); return; }
    if (f.preview === 'step' || f.preview === 'mesh') {
      if (!f.has_thumb) this.solids.want(f, this.auth.can('draw'));
      return;
    }
    const cached = this.api.thumbs.get(f.id);
    if (cached !== undefined) { if (cached) this.pics.update(p => ({ ...p, [f.id]: cached })); return; }
    if (f.preview === 'pdf' && f.bytes < 80 * 2 ** 20) {
      this.api.thumbs.set(f.id, '');
      queue(() => pdfFirstPage(inlineUrl(f.id), 320).then(url => {
        this.api.thumbs.set(f.id, url);
        this.pics.update(p => ({ ...p, [f.id]: url }));
      }).catch(() => {}));
    } else if (f.preview === 'text' || f.preview === 'markdown') {
      this.api.thumbs.set(f.id, '');
      this.api.head(f.id, 1200).subscribe({
        next: buf => {
          const text = decodeText(buf).split('\n').slice(0, 14).map(l => l.slice(0, 80)).join('\n');
          this.api.thumbs.set(f.id, text);
          this.pics.update(p => ({ ...p, [f.id]: text }));
        },
        error: () => {},
      });
    }
  }

  // ---- moving about
  go(id: string) {
    this.clearFilters();
    this.here.set(id);
    this.selected.set(new Set());
    this.focusKey.set(null);
    if (id === TRASH) this.loadTrash();
    if (id === STORAGE || id === TRASH) return;
    this.side.set(isV(id) ? 'app' : 'mine');
    // the way there is open in the tree
    let at = this.byId().get(id);
    const open = new Set(this.opened());
    while (at) { open.add(at.parent || ''); at = this.byId().get(at.parent); }
    this.opened.set(open);
  }
  clearFilters() { this.q.set(''); this.kind.set(''); this.board.set(''); }
  setView(v: 'grid' | 'list') { this.view.set(v); this.save(); }
  setSort(k: SortKey, flip: boolean) {
    if (flip && this.sortKey() === k) this.sortDir.set(this.sortDir() === 1 ? -1 : 1);
    else { this.sortKey.set(k); if (flip) this.sortDir.set(k === 'date' || k === 'size' ? -1 : 1); }
    this.save();
  }

  // ---- picking
  clickItem(e: MouseEvent, key: string) {
    e.stopPropagation();
    if (this.renaming() === key) return;
    const keys = this.items().map(i => i.key);
    if (e.shiftKey && this.anchor && keys.includes(this.anchor)) {
      const [a, b] = [keys.indexOf(this.anchor), keys.indexOf(key)].sort((x, y) => x - y);
      const range = new Set(keys.slice(a, b + 1));
      this.selected.set(e.ctrlKey || e.metaKey ? new Set([...this.selected(), ...range]) : range);
    } else if (e.ctrlKey || e.metaKey) {
      this.selected.update(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
      this.anchor = key;
    } else {
      this.selected.set(new Set([key]));
      this.anchor = key;
    }
    this.focusKey.set(key);
  }
  /** A rectangle drawn from an empty spot selects what it touches (marquee.ts); its
   *  ending click never comes here. */
  backgroundClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-key], button, a, input, select, textarea')) return;
    this.clearSel();
  }
  clearSel() { this.selected.set(new Set()); this.anchor = null; }
  activate(it: Item) {
    if (this.renaming() === it.key) return;
    if (it.folder) this.go(it.folder.id);
    else if (it.file) this.open(it.file);
  }
  open(f: StoredFile) {
    this.preview.set(f.id);
    this.selected.set(new Set(['f:' + f.id]));
    this.focusKey.set('f:' + f.id);
  }
  closePreview() {
    const k = this.preview();
    this.preview.set(null);
    if (k) setTimeout(() => this.focusItem('f:' + k));
  }
  step(d: number) {
    const list = this.previewList(), i = this.previewAt() + d;
    if (i >= 0 && i < list.length) this.open(list[i]);
  }
  private focusItem(key: string) {
    const el = document.querySelector<HTMLElement>(`.tcv-fm-items [data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    (document.querySelector('.tcv-fm-items') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** The keys of the file list: arrows move, Enter opens, Space picks,
   *  Delete deletes, F2 renames, Ctrl+A picks all, Backspace goes up. */
  itemsKey(e: KeyboardEvent) {
    // A dialog over the list (Delete's "are you sure") takes the keys: Enter
    // there confirms it, it does not open the file behind it.
    if (this.dialog()) return;
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const keys = this.items().map(i => i.key);
    const at = this.focusKey() ? keys.indexOf(this.focusKey()!) : -1;
    const cols = this.view() === 'grid' ? this.columns() : 1;
    let next = -1;
    switch (e.key) {
      case 'ArrowRight': next = this.view() === 'grid' ? at + 1 : -1; break;
      case 'ArrowLeft': next = this.view() === 'grid' ? at - 1 : -1; break;
      case 'ArrowDown': next = at < 0 ? 0 : at + cols; break;
      case 'ArrowUp': next = at - cols; break;
      case 'Home': next = 0; break;
      case 'End': next = keys.length - 1; break;
      case 'Enter': {
        const it = this.items()[at];
        if (it) { e.preventDefault(); this.activate(it); }
        return;
      }
      case ' ': {
        if (at >= 0) { e.preventDefault(); this.clickItem(new MouseEvent('click', { ctrlKey: true }), keys[at]); }
        return;
      }
      case 'Delete': case 'F2':
        if (!this.selected().size || !this.auth.can('draw')) return;
        e.preventDefault();
        if (this.selRo()) this.say(t(this.whereText(this.hereFolder()) === 'Read-only' ? 'Read-only here' : this.whereText(this.hereFolder())), 'warn');
        else if (e.key === 'Delete') this.askDelete(this.selKeys());
        else if (this.selected().size === 1) this.startRename(this.selKeys()[0]);
        return;
      case 'Backspace':
        if (this.here() && !this.filtering()) { e.preventDefault(); this.go(this.byId().get(this.here())?.parent ?? ''); }
        return;
      case 'Escape': this.clearSel(); return;
      case 'a': case 'A':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.selected.set(new Set(keys)); }
        return;
      default: return;
    }
    e.preventDefault();
    if (!keys.length) return;
    next = Math.max(0, Math.min(keys.length - 1, next));
    const key = keys[next];
    if (e.shiftKey) {
      this.anchor ??= this.focusKey() ?? key;
      const [a, b] = [keys.indexOf(this.anchor), next].sort((x, y) => x - y);
      this.selected.set(new Set(keys.slice(a, b + 1)));
    } else {
      this.selected.set(new Set([key]));
      this.anchor = key;
    }
    this.focusKey.set(key);
    const el = document.querySelector<HTMLElement>(`.tcv-fm-items [data-key="${CSS.escape(key)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }
  private columns(): number {
    const tiles = [...document.querySelectorAll<HTMLElement>('.tcv-fm-grid:not(.tcv-fm-grid-dirs) .tcv-fm-tile')];
    if (tiles.length < 2) return 1;
    const top = tiles[0].offsetTop;
    const n = tiles.findIndex(t => t.offsetTop !== top);
    return n < 0 ? tiles.length : n;
  }

  /** The preview's keys, wherever the focus is: arrows step, Esc closes. */
  globalKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.dialog()) { this.dialog.set(null); return; }
    const d = this.dialog();
    if (e.key === 'Enter' && d?.type === 'confirm' && !(e.target as HTMLElement).closest('button, input, textarea, select')) {
      e.preventDefault();
      this.dialog.set(null);
      d.run();
      return;
    }
    if (!this.preview() || this.dialog()) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, .monaco-editor')) return;
    if (e.key === 'Escape') { e.preventDefault(); this.closePreview(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); }
  }

  // ---- the menu
  openMenu(e: MouseEvent, key: string, fromButton = false) {
    e.preventDefault();
    e.stopPropagation();
    if (!fromButton && !this.selected().has(key)) { this.selected.set(new Set([key])); this.anchor = key; this.focusKey.set(key); }
    const keys = fromButton && this.preview() ? [key] : this.selKeys().length ? this.selKeys() : [key];
    const items = this.menuFor(keys);
    if (!items.length) return;
    ContextMenu.open(e, items);
  }
  backgroundMenu(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-key]')) return;
    e.preventDefault();
    this.clearSel();
    const all: MenuItem = { label: 'Select all', icon: 'grid', kbd: 'Ctrl+A',
                            run: () => this.selected.set(new Set(this.items().map(i => i.key))) };
    if (!this.auth.can('draw') || this.filtering() || isV(this.here())) { if (this.items().length) ContextMenu.open(e, [all]); return; }
    ContextMenu.open(e, [
      { label: 'New folder', icon: 'newfolder', run: () => this.newFolder() },
      { label: 'Upload files', icon: 'upload', run: () => (document.querySelector('.tcv-fm-head input[type=file]') as HTMLInputElement)?.click() },
      ...(this.items().length ? [{ sep: true } as MenuItem, all] : []),
    ]);
  }
  sendMenu(e: MouseEvent, f: StoredFile) {
    e.stopPropagation();
    ContextMenu.open(e, this.rooms.map(r => ({ label: `Send to ${ROOM_LABEL[r] ?? r}`, icon: 'send',
                                         kbd: r === this.suggest(f) ? '★' : undefined, run: () => this.send(f, r) })));
  }
  private menuFor(keys: string[]): MenuItem[] {
    const draw = this.auth.can('draw'), edit = this.auth.can('edit');
    const files = keys.filter(k => k.startsWith('f:')).map(k => this.fileById(k.slice(2))).filter((f): f is StoredFile => !!f);
    const dirs = keys.filter(k => k.startsWith('d:')).map(k => this.byId().get(k.slice(2))).filter((f): f is FileFolder => !!f);
    const out: MenuItem[] = [];
    if (this.selRo() || dirs.some(d => d.ro) || files.some(f => f.ro)) return this.roMenu(keys, files, dirs);
    if (keys.length === 1 && files.length === 1) {
      const f = files[0];
      if (this.preview() !== f.id) out.push({ label: 'Open', icon: 'open', kbd: 'Enter', run: () => this.open(f) });
      out.push({ label: 'Download', icon: 'download', run: () => this.download(downloadUrl(f.id), f.name) });
      if (draw) {
        out.push({ sep: true }, { label: 'Rename', icon: 'edit', kbd: 'F2', run: () => this.startRename('f:' + f.id) },
                 { label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) });
      }
      if (edit && (f.kind === 'step' || f.kind === 'mesh')) out.push({ label: 'Add to project', icon: 'project', run: () => this.startAdd(f) });
      if (draw) {
        out.push({ sep: true });
        for (const r of this.rooms) {
          out.push({ label: `Send to ${ROOM_LABEL[r] ?? r}`, icon: 'send', kbd: r === this.suggest(f) ? '★' : undefined,
                     run: () => this.send(f, r) });
        }
        out.push({ label: 'Ask Chat about this file', icon: 'chat',
                   run: () => this.picked.askCc({ action: 'new', mention: { kind: 'file', id: f.id, label: f.name } }) });
      }
      out.push({ sep: true }, { label: 'Details', icon: 'info', run: () => { this.details.set(true); this.save(); } });
      if (draw) out.push({ label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.askDelete(keys) });
    } else if (keys.length === 1 && dirs.length === 1) {
      const d = dirs[0];
      out.push({ label: 'Open', icon: 'open', kbd: 'Enter', run: () => this.go(d.id) },
               { label: 'Download as ZIP', icon: 'download', run: () => this.download(zipUrl([], [d.id]), d.name + '.zip') });
      if (draw) {
        out.push({ sep: true }, { label: 'Rename', icon: 'edit', kbd: 'F2', run: () => this.startRename('d:' + d.id) },
                 { label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) },
                 { sep: true }, { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.askDelete(keys) });
      }
    } else {
      out.push({ label: 'Download as ZIP', icon: 'download',
                 run: () => this.download(zipUrl(files.map(f => f.id), dirs.map(d => d.id)), 'files.zip') });
      if (draw) {
        out.push({ label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) },
                 { sep: true }, { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.askDelete(keys) });
      }
    }
    return out;
  }
  /** A read-only entry's menu: open it, take it away, see where it is kept - nothing that changes it. */
  private roMenu(keys: string[], files: StoredFile[], dirs: FileFolder[]): MenuItem[] {
    const out: MenuItem[] = [];
    if (keys.length === 1 && files.length === 1) {
      const f = files[0];
      if (this.preview() !== f.id) out.push({ label: 'Open', icon: 'open', kbd: 'Enter', run: () => this.open(f) });
      out.push({ label: 'Download', icon: 'download', run: () => this.download(downloadUrl(f.id), f.name) });
      const there = this.openable(f.open);
      if (there) out.push({ label: there, icon: 'open', run: () => this.openThere(f.open) });
      if (!f.ro) {
        // An upload the Chat or a product used: it is kept in My files.
        out.push({ label: 'Show in My files', icon: 'folder', run: () => { this.go(this.placeOf(f)); this.selected.set(new Set(['f:' + f.id])); } });
        if (this.auth.can('draw')) out.push({ label: 'Ask Chat about this file', icon: 'chat',
          run: () => this.picked.askCc({ action: 'new', mention: { kind: 'file', id: f.id, label: f.name } }) });
      }
      out.push({ sep: true }, { label: 'Details', icon: 'info', run: () => { this.details.set(true); this.save(); } });
    } else if (keys.length === 1 && dirs.length === 1) {
      const d = dirs[0];
      out.push({ label: 'Open', icon: 'open', kbd: 'Enter', run: () => this.go(d.id) },
               { label: 'Download as ZIP', icon: 'download', run: () => this.download(zipUrl([], [d.id]), (d.root ? t(d.name) : d.name) + '.zip') });
      const there = this.openable(d.open, d.chat);
      if (there) out.push({ label: there, icon: 'open', run: () => this.openThere(d.open, d.chat) });
    } else {
      out.push({ label: 'Download as ZIP', icon: 'download',
                 run: () => this.download(zipUrl(files.map(f => f.id), dirs.map(d => d.id)), 'files.zip') });
    }
    return out;
  }
  private download(url: string, name: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- renaming
  startRename(key: string) {
    const it = key.startsWith('f:') ? this.fileById(key.slice(2)) : this.byId().get(key.slice(2));
    if (!it) return;
    this.renaming.set(key);
    this.renameTo.set(it.name);
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('.tcv-fm-rename');
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, key.startsWith('f:') ? splitName(it.name)[0].length : it.name.length);
    });
  }
  commitRename() {
    const key = this.renaming();
    if (!key) return;
    this.renaming.set(null);
    const name = this.renameTo().trim();
    const isFile = key.startsWith('f:'), id = key.slice(2);
    const old = isFile ? this.fileById(id)?.name : this.byId().get(id)?.name;
    if (!name || name === old) return;
    const req: import('rxjs').Observable<unknown> = isFile ? this.api.update(id, { name }) : this.api.renameFolder(id, name);
    req.subscribe({ next: () => this.api.bump(), error: (err: unknown) => this.fail(err, 'Could not rename it.') });
    setTimeout(() => this.focusItem(key));
  }

  // ---- folders
  newFolder() {
    const names = new Set(this.childrenOf(this.here()).map(f => f.name.toLowerCase()));
    let name = t('New folder'), n = 2;
    while (names.has(name.toLowerCase())) name = `${t('New folder')} (${n++})`;
    this.dialog.set({ type: 'new-folder', name });
    setTimeout(() => document.querySelector<HTMLInputElement>('.tcv-fm-dialog .tcv-fm-input')?.select());
  }
  patchDialog(p: object) { this.dialog.update(d => d ? { ...d, ...p, error: undefined } as Dialog : d); }
  makeFolder() {
    const d = this.dialog();
    if (d?.type !== 'new-folder' || d.busy || !d.name.trim()) return;
    this.patchDialog({ busy: true });
    this.api.makeFolder(d.name.trim(), this.here()).subscribe({
      next: () => { this.dialog.set(null); this.api.bump(); },
      error: err => this.patchDialog({ busy: false, error: detail(err, t('Could not make the folder.')) }),
    });
  }
  moveDialog(keys: string[]) {
    this.dialog.set({ type: 'move', files: keys.filter(k => k.startsWith('f:')).map(k => k.slice(2)),
                      folders: keys.filter(k => k.startsWith('d:')).map(k => k.slice(2)), to: this.here() });
  }
  doMove() {
    const d = this.dialog();
    if (d?.type !== 'move' || d.busy) return;
    this.patchDialog({ busy: true });
    this.api.move(d.files, d.folders, d.to).subscribe({
      next: () => {
        this.dialog.set(null);
        this.clearSel();
        this.say(`${t('Moved to')} ${d.to ? this.byId().get(d.to)?.name : t('My files')}`);
        this.api.bump();
      },
      error: err => this.patchDialog({ busy: false, error: detail(err, t('Could not move it.')) }),
    });
  }

  askDelete(keys: string[]) {
    const files = keys.filter(k => k.startsWith('f:')).map(k => k.slice(2));
    const dirs = keys.filter(k => k.startsWith('d:')).map(k => k.slice(2));
    const inside = dirs.reduce((n, d) => n + this.stats(d).files + this.stats(d).folders, 0);
    const one = keys.length === 1 ? (files.length ? this.fileById(files[0])?.name : this.byId().get(dirs[0])?.name) : null;
    const items = (n: number) => `${n} ${t(n === 1 ? 'item' : 'items')}`;
    const what = one ? `“${one}”` : items(keys.length);
    const kept = `${t('Deleted files are kept')} ${this.usage()?.trash?.days ?? 30} ${t('days')} - ${t('restore them from Deleted.')}`;
    const body = inside ? `${t('Everything in it goes too:')} ${items(inside)}. ${kept}` : kept;
    const ask = (more = '') => this.dialog.set({ type: 'confirm', title: `${t('Delete')} ${what}?`, body: more + body, ok: t('Delete'),
                                                 run: () => this.remove(files, dirs) });
    if (!files.length) { ask(); return; }
    // What used them says they are gone afterwards (backend/files_virtual.py mark_gone): said first.
    this.api.uses(files).subscribe({
      next: u => {
        const chats = new Set<string>(), products = new Set<string>();
        for (const x of Object.values(u)) { x.chats.forEach(c => chats.add(c)); x.products.forEach(p => products.add(p)); }
        const said: string[] = [];
        if (chats.size) said.push(`${chats.size} ${t(chats.size === 1 ? 'conversation' : 'conversations')} (${[...chats].slice(0, 3).join(', ')})`);
        if (products.size) said.push(`${products.size} ${t(products.size === 1 ? 'product' : 'products')} (${[...products].slice(0, 3).join(', ')})`);
        ask(said.length ? `${t('Used in')} ${said.join(` ${t('and')} `)} - ${t('they will say it was deleted.')} ` : '');
      },
      error: () => ask(),
    });
  }
  private remove(files: string[], dirs: string[]) {
    let left = (files.length ? 1 : 0) + dirs.length;
    const done = () => { if (--left <= 0) { this.clearSel(); this.api.bump(); } };
    if (this.preview() && files.includes(this.preview()!)) this.preview.set(null);
    if (files.length) this.api.removeMany(files).subscribe({ next: done, error: err => { this.fail(err, 'Could not delete it.'); done(); } });
    for (const d of dirs) this.api.removeFolder(d, true).subscribe({ next: done, error: err => { this.fail(err, 'Could not delete it.'); done(); } });
  }

  // ---- details
  setBoard(f: StoredFile, board: string) {
    this.api.update(f.id, { board }).subscribe({ next: r => this.replace(r), error: err => this.fail(err, 'Could not save it.') });
  }
  saveNote(f: StoredFile, note: string) {
    if (note === (f.note ?? '')) return;
    this.api.update(f.id, { note }).subscribe({ next: r => { this.replace(r); this.say(t('Note saved')); },
                                                error: err => this.fail(err, 'Could not save it.') });
  }
  private replace(r: StoredFile) { this.all.update(a => a.map(x => x.id === r.id ? r : x)); }

  // ---- dragging
  dragStart(e: DragEvent, key: string) {
    if (!this.selected().has(key)) { this.selected.set(new Set([key])); this.anchor = key; }
    const keys = this.selKeys();
    e.dataTransfer?.setData(DRAG, JSON.stringify({ files: keys.filter(k => k.startsWith('f:')).map(k => k.slice(2)),
                                                    folders: keys.filter(k => k.startsWith('d:')).map(k => k.slice(2)) }));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  over(e: DragEvent, at: string) {
    const types = [...(e.dataTransfer?.types ?? [])];
    const ours = types.includes(DRAG), theirs = types.includes('Files');
    if (!ours && !theirs) return;
    if (!this.auth.can('draw')) return;
    if (ours && at === 'main') return;                    // dropping where it is: nothing to do
    // Nothing goes into a read-only folder, nor comes out of one.
    const into = at === 'main' ? this.here() : at.replace(/^(tree|crumb|d):/, '');
    if (isV(into) || into === STORAGE || (ours && isV(this.here()))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = ours ? 'move' : 'copy';
    this.dragFiles.set(theirs);
    if (this.dropAt() !== at) this.dropAt.set(at);
  }
  leave(e: DragEvent, at: string) {
    const to = e.relatedTarget as Node | null;
    if (to && (e.currentTarget as HTMLElement).contains(to)) return;
    if (this.dropAt() === at) this.dropAt.set(null);
  }
  dropOn(e: DragEvent, folder: string) {
    const raw = e.dataTransfer?.getData(DRAG);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!raw && !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    this.dropAt.set(null);
    if (!this.auth.can('draw') || isV(folder) || folder === STORAGE) return;
    if (raw) {
      const got = JSON.parse(raw) as { files: string[]; folders: string[] };
      const folders = got.folders.filter(id => !this.subtree(id).has(folder));
      if (got.folders.length !== folders.length) this.say(t('A folder cannot go into itself.'), 'warn');
      const moveFiles = got.files.filter(id => this.placeOf(this.fileById(id)!) !== folder);
      const moveDirs = folders.filter(id => (this.byId().get(id)?.parent ?? '') !== folder);
      if (!moveFiles.length && !moveDirs.length) return;
      this.api.move(moveFiles, moveDirs, folder).subscribe({
        next: () => { this.say(`${t('Moved to')} ${folder ? this.byId().get(folder)?.name : t('My files')}`); this.clearSel(); this.api.bump(); },
        error: err => this.fail(err, 'Could not move it.'),
      });
    } else {
      this.upload(files, folder);
    }
  }

  // ---- uploading
  pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) this.upload(files, this.here());
  }
  upload(files: File[], folder: string) {
    if (this.progress() !== null) { this.say(t('An upload is still going - wait for it to finish.'), 'warn'); return; }
    this.error.set(null);
    this.progress.set(0);
    this.uploading.set(files.length === 1 ? files[0].name : `${files.length} ${t('files')}`);
    const ctx = { room: 'files' };
    this.api.upload(files, ctx, '', folder).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.progress.set(Math.round(100 * ev.loaded / ev.total));
        } else if (ev.type === HttpEventType.Response) {
          this.progress.set(null);
          const got = ev.body ?? [];
          this.say(`${t('Kept')}: ${got.map(f => f.name).join(', ')}`);
          this.api.bump();
        }
      },
      error: err => { this.progress.set(null); this.fail(err, 'The upload failed.'); },
    });
  }

  // ---- the agents and the project
  send(f: StoredFile, room: string) {
    this.api.send(f.id, room).subscribe({
      next: () => { this.say(`${t('Sent to')} ${t(this.roomLabel(room))}: ${f.name}`); this.load(); },
      error: err => this.fail(err, 'Could not send it.'),
    });
  }
  /** The room whose agent this file is most likely for. */
  suggest(f: StoredFile): string {
    if (f.context.board || ['bom', 'pick-place', 'gerber', 'drill'].includes(f.kind)) return 'pcb';
    if (f.context.model || ['step', 'mesh'].includes(f.kind)) return 'cad';
    return f.context.room && AGENT_ROOMS.includes(f.context.room) ? f.context.room : '';
  }
  startAdd(f: StoredFile) {
    const title = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    this.dialog.set({ type: 'add', file: f, folder: '', title, folders: [] });
    this.catalog.tree().subscribe({
      next: tree => {
        const out: string[] = [];
        const walk = (n: FolderNode) => { if (n.path) out.push(n.path); n.folders.forEach(walk); };
        walk(tree);
        // A purchased part most likely; else a project's parts; else the first folder.
        const pick = out.find(p => /purchased$/.test(p)) ?? out.find(p => /(^|\/)parts$/.test(p)) ?? out[0] ?? '';
        this.dialog.update(d => d?.type === 'add' ? { ...d, folders: out, folder: d.folder || pick } : d);
      },
      error: () => this.patchDialog({ error: t('The folders did not load.') }),
    });
  }
  add() {
    const d = this.dialog();
    if (d?.type !== 'add' || d.busy) return;
    this.patchDialog({ busy: true });
    this.api.toModel(d.file.id, d.folder, d.title).subscribe({
      next: r => {
        this.dialog.set(null);
        this.preview.set(null);
        this.say(`${t('Added to')} ${d.folder}: ${r.title} - ${t('building it now')}`);
        this.openModel(r.model);
      },
      error: err => this.patchDialog({ busy: false, error: detail(err, t('Could not add it.')) }),
    });
  }
  openModel(id: string) {
    this.picked.room.set('cad');
    this.picked.ask('model', id);
  }

  private fail(err: unknown, fallback: string) { this.say(detail(err, t(fallback)), 'danger'); }
  /** Done, or could not: a word in the app's toast stack (toast.ts). */
  private say(m: string, tone: ToastTone = 'ok') { Toast.show(m, { tone }); }
}

/** A file's kind as the filters and the overview count it: a build output is "build". */
function kindOf(f: StoredFile): string { return f.build ? 'build' : f.kind; }

/** A read-only folders' entry (backend/files_virtual.py), by its id. */
function isV(id: string | null | undefined): boolean { return !!id && id.startsWith('v:'); }

function detail(err: unknown, fallback: string): string {
  const d = (err as { error?: { detail?: unknown } })?.error?.detail;
  return typeof d === 'string' ? d : fallback;
}

/** PDF first pages are drawn two at a time: each is a worker's work. */
let running = 0;
const waiting: (() => Promise<unknown>)[] = [];
function queue(job: () => Promise<unknown>) {
  waiting.push(job);
  const next = () => {
    while (running < 2 && waiting.length) {
      running++;
      waiting.shift()!().finally(() => { running--; next(); });
    }
  };
  next();
}
