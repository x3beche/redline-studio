import { Directive, ElementRef, Injectable, OnDestroy, effect, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/** What the Files tab knows about a file and a folder, the calls it makes,
 *  and the small things every part of it draws (icons, sizes, dates). */

export type Preview = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'table' | 'archive' | 'mesh' | 'step'
  | 'text' | 'none';

export interface Sent { room: string; at: string; by?: string }

export interface StoredFile {
  id: string; name: string; bytes: number; kind: string; content_type: string;
  context: { room?: string; model?: string; board?: string };
  by: { name?: string; id?: string }; note: string; created_at: string;
  folder: string; preview: Preview; sha256?: string;
  sent?: Sent; sent_log?: Sent[];
  /** The model made from it with "Add to project". */
  model?: string;
}

export interface FileFolder {
  id: string; name: string; parent: string; path: string;
  by: { name?: string; id?: string }; created_at: string;
}

export interface TableData { sheets: string[]; sheet: number; rows: string[][]; total: number; truncated: boolean }
export interface ArchiveData {
  entries: { name: string; bytes: number; packed?: number; dir: boolean }[];
  total: number; bytes: number; truncated: boolean;
}

@Injectable({ providedIn: 'root' })
export class FilesApi {
  private http = inject(HttpClient);
  /** Bumped when a file or a folder is added, changed or removed anywhere. */
  changed = signal(0);
  bump() { this.changed.update(v => v + 1); }

  list() { return this.http.get<StoredFile[]>('/api/files'); }
  folders() { return this.http.get<FileFolder[]>('/api/files/folders'); }
  boards() { return this.http.get<{ _id: string; title?: string }[]>('/api/boards'); }
  upload(files: File[], context: object, note: string, folder: string) {
    const form = new FormData();
    for (const f of files) form.append('upload', f, f.name);
    form.append('context', JSON.stringify(context));
    form.append('note', note);
    form.append('folder', folder);
    return this.http.post<StoredFile[]>('/api/files', form, { reportProgress: true, observe: 'events' });
  }
  update(id: string, patch: { note?: string; board?: string; name?: string }) {
    return this.http.patch<StoredFile>(`/api/files/${id}`, patch);
  }
  remove(id: string) { return this.http.delete(`/api/files/${id}`); }
  removeMany(ids: string[]) { return this.http.post<{ deleted: string[] }>('/api/files/bulk-delete', { files: ids }); }
  send(id: string, room: string) { return this.http.post(`/api/files/${id}/send`, { room }); }
  /** A STEP or mesh copied into a project folder as a model of its own. */
  toModel(id: string, folder: string, title: string) {
    return this.http.post<{ model: string; title: string }>(`/api/files/${id}/to-model`, { folder, title });
  }
  makeFolder(name: string, parent: string) { return this.http.post<FileFolder>('/api/files/folders', { name, parent }); }
  renameFolder(id: string, name: string) { return this.http.patch<FileFolder>(`/api/files/folders/${id}`, { name }); }
  removeFolder(id: string, contents: boolean) {
    return this.http.delete<{ files: number; folders: number }>(`/api/files/folders/${id}?contents=${contents}`);
  }
  move(files: string[], folders: string[], to: string) {
    return this.http.post<{ files: number; folders: number }>('/api/files/move', { files, folders, to });
  }
  table(id: string, sheet = 0) { return this.http.get<TableData>(`/api/files/${id}/table?sheet=${sheet}`); }
  entries(id: string) { return this.http.get<ArchiveData>(`/api/files/${id}/entries`); }
  /** The first `bytes` of a file as text - a Range request. */
  head(id: string, bytes: number) {
    return this.http.get(inlineUrl(id), { responseType: 'arraybuffer', headers: { Range: `bytes=0-${bytes - 1}` } });
  }

  /** What a PDF's first page or a text's first lines look like, once
   *  worked out, for as long as the page is open. */
  readonly thumbs = new Map<string, string>();
}

export const inlineUrl = (id: string) => `/api/files/${encodeURIComponent(id)}?inline=1`;
export const downloadUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;
/** A STEP as a GLB, made on the server (202 while it is being made). */
export const meshUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/mesh`;
export const thumbUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/thumb`;
export const zipUrl = (files: string[], folders: string[]) =>
  `/api/files/zip?files=${files.map(encodeURIComponent).join(',')}&folders=${folders.map(encodeURIComponent).join(',')}`;

export const KIND_LABEL: Record<string, string> = {
  bom: 'BOM', 'pick-place': 'Pick & place', gerber: 'Gerber', drill: 'Drill', step: 'STEP', mesh: '3D mesh',
  image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', table: 'Table', archive: 'Archive', text: 'Text',
  other: 'Other',
};

/** The icon a kind of file is drawn with (ICONS below). */
export function iconOf(f: { kind: string; name: string; preview?: string }): string {
  const ext = extOf(f.name);
  if (f.preview === 'markdown') return 'doc';
  if (['bom', 'pick-place', 'table'].includes(f.kind)) return 'table';
  if (f.kind === 'step' || f.kind === 'mesh') return 'cube';
  if (f.kind === 'gerber' || f.kind === 'drill') return 'board';
  if (f.kind === 'text') return CODE_EXT.has(ext) ? 'code' : 'doc';
  return ['image', 'video', 'audio', 'pdf', 'archive'].includes(f.kind) ? f.kind : 'file';
}

const CODE_EXT = new Set(['py', 'c', 'h', 'cpp', 'hpp', 'cc', 'ino', 'ts', 'js', 'json', 'yaml', 'yml', 'ato', 'xml',
  'toml', 'ini', 'cfg', 'sh', 'rs', 'go', 'java', 'css', 'html', 'sql', 'ld', 's', 'lua', 'kicad_pcb',
  'kicad_sch', 'net']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Monaco's language for a file, by its suffix. */
export function languageOf(name: string): string {
  const ext = extOf(name);
  const map: Record<string, string> = {
    py: 'python', c: 'c', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', ino: 'cpp', ts: 'typescript',
    js: 'javascript', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', css: 'css',
    md: 'markdown', markdown: 'markdown', sh: 'shell', ini: 'ini', cfg: 'ini', toml: 'ini', sql: 'sql',
    rs: 'rust', go: 'go', java: 'java', lua: 'lua', ato: 'atopile', svg: 'xml',
  };
  return map[ext] ?? 'plaintext';
}

export function size(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} kB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/** The same name with what makes it unique after it, for a second copy. */
export function splitName(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/** Line icons, 24x24, drawn with currentColor: one stroke, no fill unless
 *  the shape is a solid (a folder). */
export const ICONS: Record<string, string> = {
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" stroke="none"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 15h6M9 18h4"/>',
  code: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M10.5 12 8.5 14.5l2 2.5M13.5 12l2 2.5-2 2.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 18"/>',
  video: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="m10 9.2 5 2.8-5 2.8z"/>',
  audio: '<path d="M9 17V6l10-2v11"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="15" r="2"/>',
  pdf: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M8.5 17.5v-4h1.2a1.2 1.2 0 0 1 0 2.4H8.5M12.5 13.5v4h.8a1.7 1.7 0 0 0 0-4zM16 17.5v-4h1.6M16 15.5h1.3" stroke-width="1.1"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  archive: '<path d="M6 3h12v18H6z"/><path d="M12 3v2m0 2v2m0 2v2"/><rect x="10.5" y="13" width="3" height="4" rx=".6"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  board: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><circle cx="8" cy="10" r="1.3"/><circle cx="16" cy="14" r="1.3"/><path d="M9.3 10H13l1.8 4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".9" fill="currentColor"/><circle cx="4.8" cy="12" r=".9" fill="currentColor"/><circle cx="4.8" cy="17.5" r=".9" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
  upload: '<path d="M12 16V4m-4.5 4.5L12 4l4.5 4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  download: '<path d="M12 4v12m-4.5-4.5L12 16l4.5-4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  newfolder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10.5v5M9.5 13h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  up: '<path d="m6 14.5 6-6 6 6"/>',
  move: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M9 13h6m-2.5-2.5L15 13l-2.5 2.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 10.5v6M13.5 10.5v6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  project: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 9v6M9 12h6"/>',
  more: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5M10.5 8v5"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5"/>',
  rotate: '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5"/>',
  pages: '<rect x="4" y="3.5" width="7" height="9" rx="1"/><rect x="13" y="3.5" width="7" height="9" rx="1"/><rect x="4" y="14.5" width="7" height="6" rx="1"/><rect x="13" y="14.5" width="7" height="6" rx="1"/>',
  chat: '<path d="M4.5 5.5h15v10h-8l-4 3.5v-3.5h-3z"/>',
  open: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
};

/** `<svg>` for an icon name, for [innerHTML] - the markup is ours, from ICONS. */
export function svg(name: string, cls = 'tcv-fm-ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" `
    + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS['file']}</svg>`;
}

/** Fires `seen` once, the first time the element scrolls into view - a
 *  thumbnail is worked out only for what someone can see. */
@Directive({ selector: '[fmSeen]' })
export class Seen implements OnDestroy {
  seen = output<void>({ alias: 'fmSeen' });
  private io?: IntersectionObserver;
  constructor() {
    const el = inject(ElementRef).nativeElement as HTMLElement;
    if (typeof IntersectionObserver === 'undefined') { queueMicrotask(() => this.seen.emit()); return; }
    this.io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { this.io?.disconnect(); this.seen.emit(); }
    }, { rootMargin: '200px' });
    this.io.observe(el);
  }
  ngOnDestroy() { this.io?.disconnect(); }
}

/** An icon from ICONS as an element: `<i [fmIcon]="'folder'"></i>`. */
@Directive({ selector: '[fmIcon]', host: { 'aria-hidden': 'true', class: 'tcv-fm-i' } })
export class Icon {
  fmIcon = input.required<string>();
  private el = inject(ElementRef).nativeElement as HTMLElement;
  constructor() { effect(() => { this.el.innerHTML = this.fmIcon() ? svg(this.fmIcon()) : ''; }); }
}
