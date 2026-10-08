import { NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpEventType } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { AGENT_ROOMS } from './notes';
import { Catalog, FolderNode } from '../api';
import { FileView, decodeText } from './file-view';
import {
  FileFolder, FilesApi, Icon, KIND_LABEL, Seen, StoredFile, downloadUrl, iconOf, inlineUrl, size, splitName,
  thumbUrl, zipUrl,
} from './files-model';
import { pdfFirstPage } from './pdf-reader';

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

type Item = { key: string; folder?: FileFolder; file?: StoredFile };
type SortKey = 'name' | 'date' | 'size' | 'kind';
interface MenuItem { label?: string; icon?: string; run?: () => void; danger?: boolean; sep?: boolean; hint?: string }
type Dialog =
  | { type: 'new-folder'; name: string; busy?: boolean; error?: string }
  | { type: 'move'; files: string[]; folders: string[]; to: string; busy?: boolean; error?: string }
  | { type: 'add'; file: StoredFile; folder: string; title: string; folders: string[]; busy?: boolean; error?: string }
  | { type: 'confirm'; title: string; body: string; ok: string; run: () => void };

const ROOM_LABEL: Record<string, string> = { cad: '3D Drawing', pcb: 'PCB Design' };
const DRAG = 'application/x-redline-files';
const PREFS = 'redline.files';

function readPrefs(): { view?: 'grid' | 'list'; sort?: SortKey; dir?: 1 | -1; details?: boolean; open?: string[] } {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; }
}

@Component({
  selector: 'app-room-files',
  imports: [T, Icon, Seen, NgTemplateOutlet, FileView],
  host: { '(document:keydown)': 'globalKey($event)', '(document:click)': 'menu.set(null)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1 tcv-fm">
  <!-- LEFT: the folders, and what to show -->
  <aside class="tcv-notes-side tcv-fm-side" [attr.aria-label]="'Folders' | t">
    <nav class="tcv-fm-tree" role="tree" [attr.aria-label]="'Folders' | t">
      <ng-container *ngTemplateOutlet="node; context: { $implicit: null, depth: 0 }" />
    </nav>
    <ng-template #node let-f let-depth="depth">
      @let id = f ? f.id : '';
      @let kids = childrenOf(id);
      <div class="tcv-fm-tree-row" role="treeitem" tabindex="0"
           [attr.aria-selected]="here() === id && !filtering()" [attr.aria-expanded]="kids.length ? isOpen(id) : null"
           [attr.data-on]="here() === id && !filtering() ? 1 : null" [attr.data-drop]="dropAt() === 'tree:' + id ? 1 : null"
           [style.padding-left.px]="6 + depth * 14"
           (click)="go(id)" (keydown.enter)="go(id)"
           (dragover)="over($event, 'tree:' + id)" (dragleave)="leave($event, 'tree:' + id)" (drop)="dropOn($event, id)"
           (contextmenu)="f ? openMenu($event, 'd:' + f.id) : $event.preventDefault()">
        <button class="tcv-fm-twist" [style.visibility]="kids.length ? 'visible' : 'hidden'" tabindex="-1"
                (click)="toggleOpen(id); $event.stopPropagation()" [attr.aria-label]="(isOpen(id) ? 'Collapse' : 'Expand') | t">
          <i [fmIcon]="isOpen(id) ? 'down' : 'right'"></i></button>
        <i class="tcv-fm-tree-ico" [fmIcon]="'folder'"></i>
        <span class="tcv-fm-tree-name">{{ f ? f.name : ('My files' | t) }}</span>
        @if (!f) { <em class="tcv-fm-count">{{ all().length }}</em> }
      </div>
      @if (isOpen(id)) {
        @for (k of kids; track k.id) {
          <ng-container *ngTemplateOutlet="node; context: { $implicit: k, depth: depth + 1 }" />
        }
      }
    </ng-template>

    <div class="tcv-notes-group">{{ 'Kind' | t }}</div>
    <div class="tcv-notes-filters">
      @for (k of kinds(); track k.kind) {
        <button class="tcv-notes-chip" [attr.data-on]="kind() === k.kind ? 1 : null" [attr.aria-pressed]="kind() === k.kind"
                (click)="kind.set(kind() === k.kind ? '' : k.kind)">
          {{ kindLabel(k.kind) | t }} <em>{{ k.n }}</em></button>
      } @empty { <span class="tcv-fm-quiet">{{ 'Nothing uploaded yet' | t }}</span> }
    </div>
    @if (boardsUsed().length) {
      <div class="tcv-notes-group">{{ 'Boards' | t }}</div>
      <div class="tcv-notes-filters">
        @for (b of boardsUsed(); track b) {
          <button class="tcv-notes-chip" [attr.data-on]="board() === b ? 1 : null" [attr.aria-pressed]="board() === b"
                  (click)="board.set(board() === b ? '' : b)">&#64;{{ b }}</button>
        }
      </div>
    }
    @if (auth.can('draw')) {
      <label class="tcv-fm-linkto">
        <span>{{ 'New uploads go with board' | t }}</span>
        <select class="tcv-fm-select" [value]="linkTo()" (change)="linkTo.set($any($event.target).value)">
          <option value="">{{ '(no board)' | t }}</option>
          @for (b of boards(); track b._id) {
            <option [value]="b._id" [selected]="b._id === linkTo()">{{ b.title || b._id }}</option>
          }
        </select>
      </label>
    }
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
                      (drop)="dropOn($event, c.id)">{{ c.id ? c.name : ('My files' | t) }}</button>
              <i class="tcv-fm-crumb-sep" [fmIcon]="'right'"></i>
            } @else {
              <span class="tcv-fm-crumb tcv-fm-crumb-here" aria-current="location">{{ c.id ? c.name : ('My files' | t) }}</span>
            }
          }
        }
      </nav>
      @if (auth.can('draw')) {
        <button class="tcv-btn tcv-fm-btn" (click)="newFolder()"><i [fmIcon]="'newfolder'"></i><span>{{ 'New folder' | t }}</span></button>
        <label class="tcv-btn tcv-btn-accent tcv-fm-btn" tabindex="0" (keydown.enter)="$any($event.target).querySelector('input')?.click()">
          <input type="file" multiple hidden (change)="pick($event)">
          <i [fmIcon]="'upload'"></i><span>{{ 'Upload' | t }}</span></label>
      }
    </header>

    <div class="tcv-fm-tools">
      @if (selected().size) {
        <button class="tcv-fm-icon-btn" (click)="clearSel()" [title]="'Clear the selection' | t" [attr.aria-label]="'Clear the selection' | t"><i [fmIcon]="'close'"></i></button>
        <span class="tcv-fm-selcount">{{ selected().size }} {{ 'selected' | t }}</span>
        <span class="tcv-fm-tools-sep"></span>
        <a class="tcv-fm-icon-btn" [href]="selZip()" [title]="'Download' | t" [attr.aria-label]="'Download' | t"><i [fmIcon]="'download'"></i></a>
        @if (auth.can('draw')) {
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
        <select class="tcv-fm-select tcv-fm-phone-only" [value]="kind()" (change)="kind.set($any($event.target).value)" [attr.aria-label]="'Kind' | t">
          <option value="">{{ 'All kinds' | t }}</option>
          @for (k of kinds(); track k.kind) { <option [value]="k.kind" [selected]="k.kind === kind()">{{ kindLabel(k.kind) | t }}</option> }
        </select>
      }
      <span class="tcv-fm-grow"></span>
      <select class="tcv-fm-select tcv-fm-sort" [value]="sortKey()" (change)="setSort($any($event.target).value, false)" [attr.aria-label]="'Sort by' | t">
        <option value="name">{{ 'Name' | t }}</option>
        <option value="date">{{ 'Date added' | t }}</option>
        <option value="size">{{ 'Size' | t }}</option>
        <option value="kind">{{ 'Kind' | t }}</option>
      </select>
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

    @if (progress() !== null) {
      <div class="tcv-fm-upload" role="status">
        <span>{{ 'Uploading' | t }} {{ uploading() }}</span>
        <span class="tcv-fm-bar"><i [style.width.%]="progress()"></i></span>
        <b>{{ progress() }}%</b>
      </div>
    }
    @if (error(); as e) {
      <div class="tcv-fm-note tcv-fm-note-err" role="alert"><span>{{ e }}</span>
        <button class="tcv-fm-icon-btn" (click)="error.set(null)" [attr.aria-label]="'Close' | t"><i [fmIcon]="'close'"></i></button></div>
    }

    <div class="tcv-fm-body">
      <div class="tcv-fm-items" tabindex="0" role="grid" [attr.aria-label]="'Files' | t" [attr.aria-multiselectable]="true"
           [attr.data-view]="view()" (keydown)="itemsKey($event)" (click)="backgroundClick($event)"
           (contextmenu)="backgroundMenu($event)">
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
          <div class="tcv-fm-empty">
            @if (filtering()) {
              <i class="tcv-fm-empty-ico" [fmIcon]="'search'"></i>
              <b>{{ 'Nothing matches' | t }}</b>
              <p>{{ 'No file name or note in any folder has this.' | t }}</p>
              <button class="tcv-btn tcv-fm-btn" (click)="clearFilters()">{{ 'Clear the search' | t }}</button>
            } @else if (!here() && !all().length) {
              <i class="tcv-fm-empty-ico" [fmIcon]="'upload'"></i>
              <b>{{ 'No files yet' | t }}</b>
              <p>{{ 'Drop files anywhere here, or use Upload: BOMs, pick and place files, datasheets, photos, videos, STEP - up to 200 MB each.' | t }}</p>
            } @else {
              <i class="tcv-fm-empty-ico" [fmIcon]="'folder'"></i>
              <b>{{ 'This folder is empty' | t }}</b>
              <p>{{ 'Drop files here, or use Upload. Files and folders can be dragged in from elsewhere too.' | t }}</p>
            }
          </div>
        } @else if (view() === 'grid') {
          @if (folderItems().length) {
            <div class="tcv-fm-section">{{ 'Folders' | t }}</div>
            <div class="tcv-fm-grid tcv-fm-grid-dirs">
              @for (it of folderItems(); track it.key) {
                <div class="tcv-fm-tile tcv-fm-dir" role="gridcell" tabindex="-1" [attr.data-key]="it.key"
                     [attr.aria-selected]="isSel(it.key)" [attr.data-on]="isSel(it.key) ? 1 : null"
                     [attr.data-focus]="focusKey() === it.key ? 1 : null" [attr.data-drop]="dropAt() === it.key ? 1 : null"
                     draggable="true" (dragstart)="dragStart($event, it.key)"
                     (dragover)="over($event, it.key)" (dragleave)="leave($event, it.key)" (drop)="dropOn($event, it.folder!.id)"
                     (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                  <i class="tcv-fm-dir-ico" [fmIcon]="'folder'"></i>
                  <ng-container *ngTemplateOutlet="nameOf; context: { $implicit: it }" />
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
                     draggable="true" (dragstart)="dragStart($event, it.key)"
                     (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                  <div class="tcv-fm-thumb" (fmSeen)="seen(f)" [attr.data-kind]="f.kind">
                    @switch (thumbOf(f)) {
                      @case ('img') { <img [src]="f.name.toLowerCase().endsWith('.svg') ? inline(f.id) : thumb(f.id)" alt="" loading="lazy" (error)="noThumb(f.id)"> }
                      @case ('video') { <video [src]="inline(f.id) + '#t=0.5'" preload="metadata" muted playsinline></video>
                                        <span class="tcv-fm-play"><i [fmIcon]="'video'"></i></span> }
                      @case ('pdf') { <img [src]="pics()[f.id]" alt=""> }
                      @case ('snip') { <pre class="tcv-fm-snip">{{ pics()[f.id] }}</pre> }
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
                   draggable="true" (dragstart)="dragStart($event, it.key)"
                   (dragover)="it.folder && over($event, it.key)" (dragleave)="it.folder && leave($event, it.key)"
                   (drop)="it.folder && dropOn($event, it.folder.id)"
                   (click)="clickItem($event, it.key)" (dblclick)="activate(it)" (contextmenu)="openMenu($event, it.key)">
                <span class="tcv-fm-col-name" role="gridcell">
                  @if (it.folder) { <i class="tcv-fm-kind-ico tcv-fm-dir-ico" [fmIcon]="'folder'"></i> }
                  @else { <i class="tcv-fm-kind-ico" [attr.data-ico]="iconOf(it.file!)" [fmIcon]="iconOf(it.file!)"></i> }
                  <ng-container *ngTemplateOutlet="nameOf; context: { $implicit: it }" />
                  @if (filtering() && it.file) { <em class="tcv-fm-where">{{ pathOf(it.file.folder) }}</em> }
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

    @if (dropAt() === 'main' && dragFiles()) {
      <div class="tcv-fm-dropzone"><i [fmIcon]="'upload'"></i>{{ 'Drop to upload to' | t }} {{ hereName() }}</div>
    }
    @if (flash(); as m) { <div class="tcv-fm-toast" role="status">{{ m }}</div> }
  </section>

  <!-- a name, or the box that renames it -->
  <ng-template #nameOf let-it>
    @if (renaming() === it.key) {
      <input class="tcv-fm-rename" [value]="renameTo()" (input)="renameTo.set($any($event.target).value)"
             (keydown.enter)="commitRename(); $event.stopPropagation()" (keydown.escape)="renaming.set(null); $event.stopPropagation()"
             (keydown)="$event.stopPropagation()" (blur)="commitRename()" (click)="$event.stopPropagation()"
             (dblclick)="$event.stopPropagation()" [attr.aria-label]="'New name' | t">
    } @else {
      <span class="tcv-fm-name" [title]="(it.file || it.folder).name">{{ (it.file || it.folder).name }}</span>
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
      <dl class="tcv-fm-d-props">
        <dt>{{ 'Kind' | t }}</dt><dd>{{ kindLabel(f.kind) | t }}</dd>
        <dt>{{ 'Size' | t }}</dt><dd>{{ fmt(f.bytes) }}</dd>
        <dt>{{ 'Location' | t }}</dt><dd>{{ pathOf(f.folder) }}</dd>
        <dt>{{ 'Added' | t }}</dt><dd>{{ long(f.created_at) }}</dd>
        <dt>{{ 'By' | t }}</dt><dd>{{ f.by.name || ('someone' | t) }}</dd>
        @if (f.model) { <dt>{{ 'Model' | t }}</dt><dd><button class="tcv-fm-link" (click)="openModel(f.model)">{{ f.model }}</button></dd> }
        <dt>{{ 'Board' | t }}</dt>
        <dd>
          @if (auth.can('draw')) {
            <select class="tcv-fm-select tcv-fm-d-board" [value]="f.context.board || ''" (change)="setBoard(f, $any($event.target).value)"
                    [attr.aria-label]="'Board' | t">
              <option value="">{{ '(no board)' | t }}</option>
              @for (b of boards(); track b._id) { <option [value]="b._id" [selected]="b._id === f.context.board">{{ b.title || b._id }}</option> }
            </select>
          } @else { {{ f.context.board || '-' }} }
        </dd>
      </dl>
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

  <!-- the right-click menu -->
  @if (menu(); as m) {
    <div class="tcv-fm-menu" role="menu" [style.left.px]="m.x" [style.top.px]="m.y" (click)="$event.stopPropagation()"
         (keydown.escape)="menu.set(null)">
      @for (it of m.items; track $index) {
        @if (it.sep) { <div class="tcv-fm-menu-sep" role="separator"></div> }
        @else {
          <button role="menuitem" class="tcv-fm-menu-item" [attr.data-danger]="it.danger ? 1 : null"
                  (click)="menu.set(null); it.run!()">
            <i [fmIcon]="it.icon || 'file'"></i><span>{{ it.label! | t }}</span>@if (it.hint) { <kbd>{{ it.hint }}</kbd> }
          </button>
        }
      }
    </div>
  }

  <!-- dialogs -->
  @if (dialog(); as d) {
    <div class="tcv-fm-scrim" (click)="dialog.set(null)" (keydown.escape)="dialog.set(null)">
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
              <select class="tcv-fm-select" [value]="$any(d).folder" (change)="patchDialog({ folder: $any($event.target).value })">
                @for (p of $any(d).folders; track p) { <option [value]="p" [selected]="p === $any(d).folder">{{ p }}</option> }
              </select></label>
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

  <!-- the preview -->
  @if (previewFile(); as f) {
    <div class="tcv-fm-preview" role="dialog" aria-modal="true" [attr.aria-label]="f.name">
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
        @if (auth.can('draw')) {
          <button class="tcv-fm-icon-btn" (click)="sendMenu($event, f)" [title]="'Send to agent…' | t" [attr.aria-label]="'Send to agent…' | t"><i [fmIcon]="'send'"></i></button>
        }
        <button class="tcv-fm-icon-btn" [attr.data-on]="details() ? 1 : null" (click)="details.set(!details()); save()"
                [title]="'Details' | t" [attr.aria-label]="'Details' | t"><i [fmIcon]="'info'"></i></button>
        <button class="tcv-fm-icon-btn" (click)="openMenu($event, 'f:' + f.id, true)" [title]="'More actions' | t" [attr.aria-label]="'More actions' | t"><i [fmIcon]="'more'"></i></button>
      </header>
      <div class="tcv-fm-pv-body">
        <div class="tcv-fm-pv-stage">
          <app-file-view [file]="f" [canEdit]="auth.can('edit')" (act)="$event === 'add' ? startAdd(f) : openModel(f.model!)" />
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
  picked = inject(Selection);
  auth = inject(Auth);

  readonly rooms = AGENT_ROOMS;
  readonly skeleton = Array.from({ length: 12 }, (_, i) => i);
  fmt = size;
  iconOf = iconOf;
  inline = inlineUrl;
  thumb = thumbUrl;
  dl = downloadUrl;

  // ---- what there is
  all = signal<StoredFile[]>([]);
  folders = signal<FileFolder[]>([]);
  loading = signal(true);
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
  linkTo = signal<string>(this.picked.board() ?? '');

  // ---- what is picked
  selected = signal<Set<string>>(new Set());
  private anchor: string | null = null;
  focusKey = signal<string | null>(null);
  renaming = signal<string | null>(null);
  renameTo = signal('');
  menu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  dialog = signal<Dialog | null>(null);
  preview = signal<string | null>(null);

  // ---- doing
  progress = signal<number | null>(null);
  uploading = signal('');
  error = signal<string | null>(null);
  flash = signal<string | null>(null);
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
  private byId = computed(() => new Map(this.folders().map(f => [f.id, f])));
  private kids = computed(() => {
    const m = new Map<string, FileFolder[]>();
    for (const f of this.folders()) {
      const p = this.byId().has(f.parent) ? f.parent : '';
      m.set(p, [...(m.get(p) ?? []), f]);
    }
    for (const v of m.values()) v.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return m;
  });
  /** A file whose folder is gone, or from before folders, is at the top. */
  private placeOf = (f: StoredFile) => this.byId().has(f.folder) ? f.folder : '';
  filtering = computed(() => !!(this.q().trim() || this.kind() || this.board()));
  kinds = computed(() => {
    const n = new Map<string, number>();
    for (const f of this.all()) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([kind, c]) => ({ kind, n: c }));
  });
  boardsUsed = computed(() => [...new Set(this.all().map(f => f.context.board).filter((b): b is string => !!b))].sort());

  items = computed<Item[]>(() => {
    let dirs: FileFolder[], files: StoredFile[];
    if (this.filtering()) {
      const q = this.q().trim().toLowerCase(), k = this.kind(), b = this.board();
      files = this.all().filter(f => (!k || f.kind === k) && (!b || f.context.board === b)
        && (!q || f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q)));
      dirs = q && !k && !b ? this.folders().filter(f => f.name.toLowerCase().includes(q)) : [];
    } else {
      const here = this.here();
      dirs = this.kids().get(here) ?? [];
      files = this.all().filter(f => this.placeOf(f) === here);
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
    return [...[...dirs].sort(dirCmp).map(f => ({ key: 'd:' + f.id, folder: f })),
            ...[...files].sort(fileCmp).map(f => ({ key: 'f:' + f.id, file: f }))];
  });
  folderItems = computed(() => this.items().filter(i => i.folder));
  fileItems = computed(() => this.items().filter(i => i.file));
  crumbs = computed(() => {
    const out: { id: string; name: string }[] = [];
    let at = this.byId().get(this.here());
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) { seen.add(at.id); out.unshift({ id: at.id, name: at.name }); at = this.byId().get(at.parent); }
    return [{ id: '', name: '' }, ...out];
  });
  hereName = computed(() => this.byId().get(this.here())?.name ?? t('My files'));
  selKeys = computed(() => [...this.selected()]);
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
    return id ? this.all().find(f => f.id === id) ?? null : null;
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
      untracked(() => this.picked.file.set(f ? { id: f.id, label: f.name } : null));
    });
    // A folder that went away takes you to the top.
    effect(() => {
      if (!this.loading() && this.here() && !this.byId().has(this.here())) untracked(() => this.here.set(''));
    });
  }

  ngOnDestroy() { clearInterval(this.tick); }

  load() {
    let left = 2;
    const done = () => { if (--left === 0) this.loading.set(false); };
    this.api.list().subscribe({ next: rows => { this.all.set(rows); done(); }, error: () => { done(); this.error.set(t('The files did not load.')); } });
    this.api.folders().subscribe({ next: rows => { this.folders.set(rows); done(); }, error: () => done() });
  }

  save() {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ view: this.view(), sort: this.sortKey(), dir: this.sortDir(),
                                                   details: this.details(), open: [...this.opened()].filter(Boolean) }));
    } catch { /* private window */ }
  }

  // ---- small helpers for the template
  fileById(id: string) { return this.all().find(f => f.id === id) ?? null; }
  childrenOf(id: string) { return this.kids().get(id) ?? []; }
  isOpen(id: string) { return this.opened().has(id); }
  toggleOpen(id: string) {
    this.opened.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    this.save();
  }
  isSel(key: string) { return this.selected().has(key); }
  kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
  roomLabel(r: string) { return ROOM_LABEL[r] ?? r; }
  pathOf(folder: string) { return this.byId().get(folder)?.path ?? t('My files'); }
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
    const under = id ? this.subtree(id) : null;
    const files = this.all().filter(f => under ? under.has(f.folder) : true);
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
    return '';
  }
  noThumb(id: string) { this.noPic.update(s => new Set(s).add(id)); }

  /** A tile came into view: work out its picture, if it has one to work out. */
  seen(f: StoredFile) {
    if (f.preview === 'video') { this.visible.update(s => new Set(s).add(f.id)); return; }
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
      case 'Delete':
        if (this.selected().size && this.auth.can('draw')) { e.preventDefault(); this.askDelete(this.selKeys()); }
        return;
      case 'F2':
        if (this.selected().size === 1 && this.auth.can('draw')) { e.preventDefault(); this.startRename(this.selKeys()[0]); }
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
    if (e.key === 'Escape' && this.menu()) { this.menu.set(null); return; }
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
    this.place(e, items);
  }
  backgroundMenu(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-key]')) return;
    e.preventDefault();
    this.clearSel();
    const all: MenuItem = { label: 'Select all', icon: 'grid', hint: 'Ctrl+A',
                            run: () => this.selected.set(new Set(this.items().map(i => i.key))) };
    if (!this.auth.can('draw') || this.filtering()) { if (this.items().length) this.place(e, [all]); return; }
    this.place(e, [
      { label: 'New folder', icon: 'newfolder', run: () => this.newFolder() },
      { label: 'Upload files', icon: 'upload', run: () => (document.querySelector('.tcv-fm-head input[type=file]') as HTMLInputElement)?.click() },
      ...(this.items().length ? [{ sep: true }, all] : []),
    ]);
  }
  sendMenu(e: MouseEvent, f: StoredFile) {
    e.stopPropagation();
    this.place(e, this.rooms.map(r => ({ label: `Send to ${ROOM_LABEL[r] ?? r}`, icon: 'send',
                                         hint: r === this.suggest(f) ? '★' : undefined, run: () => this.send(f, r) })));
  }
  private place(e: MouseEvent, items: MenuItem[]) {
    const w = 236, h = items.reduce((n, i) => n + (i.sep ? 9 : 32), 10);
    let x = e.clientX, y = e.clientY;
    if (e.type === 'click' && e.currentTarget instanceof HTMLElement) {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.right - w; y = r.bottom + 4;
    }
    this.menu.set({ x: Math.max(4, Math.min(x, innerWidth - w - 4)), y: Math.max(4, Math.min(y, innerHeight - h - 4)), items });
  }
  private menuFor(keys: string[]): MenuItem[] {
    const draw = this.auth.can('draw'), edit = this.auth.can('edit');
    const files = keys.filter(k => k.startsWith('f:')).map(k => this.fileById(k.slice(2))).filter((f): f is StoredFile => !!f);
    const dirs = keys.filter(k => k.startsWith('d:')).map(k => this.byId().get(k.slice(2))).filter((f): f is FileFolder => !!f);
    const out: MenuItem[] = [];
    if (keys.length === 1 && files.length === 1) {
      const f = files[0];
      if (this.preview() !== f.id) out.push({ label: 'Open', icon: 'open', hint: 'Enter', run: () => this.open(f) });
      out.push({ label: 'Download', icon: 'download', run: () => this.download(downloadUrl(f.id), f.name) });
      if (draw) {
        out.push({ sep: true }, { label: 'Rename', icon: 'edit', hint: 'F2', run: () => this.startRename('f:' + f.id) },
                 { label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) });
      }
      if (edit && (f.kind === 'step' || f.kind === 'mesh')) out.push({ label: 'Add to project', icon: 'project', run: () => this.startAdd(f) });
      if (draw) {
        out.push({ sep: true });
        for (const r of this.rooms) {
          out.push({ label: `Send to ${ROOM_LABEL[r] ?? r}`, icon: 'send', hint: r === this.suggest(f) ? '★' : undefined,
                     run: () => this.send(f, r) });
        }
        out.push({ label: 'Ask Chat about this file', icon: 'chat',
                   run: () => this.picked.askCc({ action: 'new', mention: { kind: 'file', id: f.id, label: f.name } }) });
      }
      out.push({ sep: true }, { label: 'Details', icon: 'info', run: () => { this.details.set(true); this.save(); } });
      if (draw) out.push({ label: 'Delete', icon: 'trash', hint: 'Del', danger: true, run: () => this.askDelete(keys) });
    } else if (keys.length === 1 && dirs.length === 1) {
      const d = dirs[0];
      out.push({ label: 'Open', icon: 'open', hint: 'Enter', run: () => this.go(d.id) },
               { label: 'Download as ZIP', icon: 'download', run: () => this.download(zipUrl([], [d.id]), d.name + '.zip') });
      if (draw) {
        out.push({ sep: true }, { label: 'Rename', icon: 'edit', hint: 'F2', run: () => this.startRename('d:' + d.id) },
                 { label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) },
                 { sep: true }, { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, run: () => this.askDelete(keys) });
      }
    } else {
      out.push({ label: 'Download as ZIP', icon: 'download',
                 run: () => this.download(zipUrl(files.map(f => f.id), dirs.map(d => d.id)), 'files.zip') });
      if (draw) {
        out.push({ label: 'Move to…', icon: 'move', run: () => this.moveDialog(keys) },
                 { sep: true }, { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, run: () => this.askDelete(keys) });
      }
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
    const body = inside
      ? `${t('Everything in it goes too:')} ${items(inside)}. ${t('This cannot be undone.')}`
      : t('This cannot be undone.');
    this.dialog.set({ type: 'confirm', title: `${t('Delete')} ${what}?`, body, ok: t('Delete'),
                      run: () => this.remove(files, dirs) });
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
    if (!this.auth.can('draw')) return;
    if (raw) {
      const got = JSON.parse(raw) as { files: string[]; folders: string[] };
      const folders = got.folders.filter(id => !this.subtree(id).has(folder));
      if (got.folders.length !== folders.length) this.error.set(t('A folder cannot go into itself.'));
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
    if (this.progress() !== null) { this.error.set(t('An upload is still going - wait for it to finish.')); return; }
    this.error.set(null);
    this.progress.set(0);
    this.uploading.set(files.length === 1 ? files[0].name : `${files.length} ${t('files')}`);
    const ctx = { room: this.linkTo() ? 'pcb' : 'files', ...(this.linkTo() ? { board: this.linkTo() } : {}) };
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
        // A purchased part most likely; else the first folder.
        const pick = out.find(p => /purchased$/.test(p)) ?? out[0] ?? '';
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

  private fail(err: unknown, fallback: string) { this.error.set(detail(err, t(fallback))); }
  private say(m: string) {
    this.flash.set(m);
    setTimeout(() => { if (this.flash() === m) this.flash.set(null); }, 4000);
  }
}

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
