import { Component, Injectable, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { LANG, T, t } from '../i18n';
import { Toast } from '../toast';
import { Selection } from '../selection';
import { EmptyState } from '../empty-state';
import { MeshThumbs } from './mesh-thumb';
import { StoredFile, inlineUrl, meshUrl } from './files-model';
import { MeshView } from './mesh-view';
import { LinkedMeasured, kb, measuredBox, measuredRows, mismatchTip } from './linked';

/** Files on any Parts product (backend/product_files.py): its 3D model -
 *  measured as a saved McMaster part's STEP is -, datasheets, drawings and
 *  pictures. The bytes are in Files; a product refers to them.
 *
 *  - `ProductFilesState`: which products hold files, read once for the
 *    page and shared, so a card or row says "3D" and a picture made the
 *    product's own is shown in place of its page's;
 *  - `<wb-product-files>`: the files of one product in its detail - its
 *    model's picture, the drop zone, what the model measured, the list
 *    with "make it the model / picture" and "detach". A McMaster-Carr or
 *    GrabCAD item keeps its own card (linked.ts); this is everyone else's. */

export interface ProductFile { file: string; name: string; kind: string; role: 'model' | 'datasheet' | 'drawing' | 'image';
  bytes: number; sha256?: string; by?: { id?: string; name?: string }; at?: string; has_thumb?: string | null }
export interface ProductFiles {
  maker: string; maker_name: string; product: string; name: string; files: ProductFile[]; cad: ProductFile | null;
  measured: (LinkedMeasured & { rows?: [string, string][]; kind?: string; unit?: string; solids?: number | null }) | null;
  picture: { file: string; name: string } | null; linked: boolean; lcsc_3d: boolean | null; accept: string;
}
export interface HeldFiles { files: number; roles: Record<string, number>; cad: string | null; cad_name?: string;
  box: number[] | null; pending: boolean; error?: string | null; picture: string | null; orphan?: boolean;
  cad_file?: string | null; thumb?: string | null }

const base = (mid: string, pid: string) => `/api/manufacturers/${encodeURIComponent(mid)}/products/${encodeURIComponent(pid)}/files`;
function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
function why(e: unknown, fallback: string): string {
  const d = (e as HttpErrorResponse)?.error?.detail;
  return typeof d === 'string' ? d : t(fallback);
}
const ROLE: Record<string, string> = { model: '3D model', datasheet: 'Datasheet', drawing: 'Drawing', image: 'Picture' };

@Injectable({ providedIn: 'root' })
export class ProductFilesState {
  private http = inject(HttpClient);
  held = signal<Record<string, HeldFiles>>({});
  /** "maker:product" of the products deleted by hand whose files are still kept (OrphanFiles). */
  orphans = signal<string[]>([]);
  load() {
    this.http.get<{ products: Record<string, HeldFiles>; orphans?: string[] }>('/api/product-files/summary').subscribe({
      next: r => { this.held.set(r.products); this.orphans.set(r.orphans ?? []); }, error: () => {} });
  }
  of(mid: string | undefined, pid: string | undefined): HeldFiles | null { return mid && pid ? this.held()[mid + ':' + pid] ?? null : null; }
  /** "3D" on a card or row: a model attached (a McMaster/GrabCAD item and an LCSC part say theirs already). */
  model(mid: string | undefined, pid: string | undefined): HeldFiles | null { const h = this.of(mid, pid); return h?.cad ? h : null; }
  /** The picture made the product's own, as an address; null for none. */
  picture(mid: string | undefined, pid: string | undefined): string | null {
    const f = this.of(mid, pid)?.picture;
    return f ? `/api/files/${encodeURIComponent(f)}?inline=1` : null;
  }
  /** Its 3D model's picture, drawn once by a page (mesh-thumb.ts): a card with no picture of its own shows it. */
  solid(mid: string | undefined, pid: string | undefined): string | null { return this.of(mid, pid)?.thumb ?? null; }
  /** "3D model (STEP) · 6 × 6 × 27.4 mm" - the badge's tooltip. */
  tip(h: HeldFiles): string {
    const box = h.box?.length === 3 ? ' · ' + measuredBox({ size: h.box, mismatch: [] }) : h.pending ? ' · ' + t('measuring…') : '';
    return t('3D model') + ' (' + (h.cad === 'step' ? 'STEP' : t('mesh')) + ')' + box + (h.files > 1 ? ' · ' + fmt('{n} files', { n: h.files }) : '');
  }
}

/** One product's files, in its detail: the model's picture beside the drop
 *  zone, what the model measured, the files with their roles. */
@Component({
  selector: 'wb-product-files',
  imports: [T, NgTemplateOutlet],
  host: { style: 'display: block' },
  styleUrls: ['../settings.css', './manufacturers.css', './linked.css', './product-files.css'],
  template: `
<section class="pfl" [attr.aria-label]="'Files' | t" [attr.data-compact]="compact() ? 1 : null" [attr.data-on]="compact() && dropping() ? 1 : null"
         (dragover)="over($event)" (dragleave)="leave($event)" (drop)="dropped($event)">
  <div class="pfl-head" [class.pfl-sh]="compact()">
    @if (compact()) { <h3>{{ '3D model and files' | t }}</h3> } @else { <span class="mf-label">{{ 'Files' | t }}</span> }
    @if (v(); as x) {
      <span class="st-sub">@if (x.files.length) { {{ fmt(x.files.length === 1 ? '{n} file' : '{n} files', { n: x.files.length }) }} } @else { {{ 'none yet' | t }} }
        @if (x.lcsc_3d) { · {{ 'its own 3D model comes from LCSC; a file here is an extra' | t }} }</span>
    } @else if (err()) { <span class="st-sub" data-tone="danger">{{ err() }}</span> } @else { <span class="st-sub">…</span> }
  </div>
  @if (v(); as x) {
   <div class="pfl-main">
    @if (!compact()) {
    <div class="pfl-top" [attr.data-solo]="!can() ? 1 : null">
      <div class="ln-pic pfl-pic">
        @if (pic(); as src) { <img class="tcv-fm-solid" [src]="src" alt=""> }
        @else { <svg class="ln-cube" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" /></svg>
                <span class="dim">{{ (x.cad ? 'drawing its picture…' : x.lcsc_3d ? 'its LCSC 3D model is above' : 'no 3D model yet') | t }}</span> }
        @if (x.cad) { <span class="pfl-badge" [title]="x.cad.name">3D · {{ x.cad.kind === 'step' ? 'STEP' : ('mesh' | t) }}</span> }
      </div>
      @if (can()) {
        <label class="ln-drop pfl-drop" [attr.data-on]="dropping() ? 1 : null" [attr.data-busy]="busy() ? 1 : null"
               (dragover)="$event.preventDefault(); dropping.set(true)" (dragleave)="dropping.set(false)"
               (drop)="$event.preventDefault(); dropping.set(false); upload($any($event).dataTransfer?.files)">
          <input type="file" multiple [accept]="x.accept" hidden (change)="upload($any($event.target).files); $any($event.target).value = ''">
          <b>{{ (busy() ? 'Keeping it…' : (x.cad ? 'Drop more files here' : 'Drop its STEP, datasheet or pictures here')) | t }}</b>
          <span>{{ 'STEP, STP, STL, 3MF or OBJ becomes its 3D model and is measured; a PDF its datasheet; a picture its picture. A ZIP is unpacked. Or click to choose.' | t }}</span>
          @if (busy()) { <span class="pfl-prog mono">{{ busy() }}</span> }
        </label>
      }
    </div>
    }
    <!-- what its model measured (backend/linked_measure.py), a figure its words say otherwise marked -->
    @if (x.measured; as ms) {
      <div class="ln-meas pfl-meas">
        <span class="mf-label">{{ (ms.kind === 'mesh' ? 'Measured from the mesh' : 'Measured from the STEP') | t }}</span>
        @if (ms.pending) { <span class="pfl-wait"><span class="ln-spin" aria-hidden="true"></span>{{ 'measuring…' | t }}</span> }
        @else if (ms.error) { <span class="st-sub" data-tone="warn">{{ fmt('could not be measured: {e}', { e: ms.error }) }}</span> }
        @else {
          <table class="mf-dspecs"><tbody>
            @for (r of rows(); track r[0]) {
              <tr [attr.data-bad]="r[2] ? 1 : null"><th>{{ r[0] }}</th><td class="mono">{{ r[1] }}
                @if (r[2]) { <span class="st-tag" data-tone="warn" [title]="mismatchTip(ms)">≠ {{ r[2] }}</span> }</td></tr>
            }
          </tbody></table>
        }
      </div>
    }
    @if (x.files.length) {
      <div class="st-table-wrap"><table class="st-table pfl-files"><tbody>
        @for (f of x.files; track f.file) {
          <tr [attr.data-main]="f.file === x.cad?.file || f.file === x.picture?.file ? 1 : null">
            <td class="give"><a class="mf-link" [href]="'/api/files/' + f.file + '?inline=1'" target="_blank" rel="noopener"
                                [title]="f.name + (f.by?.name ? ' · ' + f.by?.name : '') + (f.at ? ' · ' + when(f.at) : '')">{{ f.name }}</a></td>
            <td><span class="st-tag" [attr.data-tone]="f.file === x.cad?.file || f.file === x.picture?.file ? 'ok' : null">{{ role(f, x) | t }}</span></td>
            <td class="dim mono">{{ f.kind.toUpperCase() }}</td>
            <td class="r mono dim">{{ kb(f.bytes) }}</td>
            <td class="r nowrap">
              <a class="st-more" [href]="'/api/files/' + f.file" download>{{ 'Download' | t }}</a>
              @if (can() && f.role === 'model' && f.file !== x.cad?.file && (f.kind === 'step' || f.kind === 'mesh')) {
                <button class="st-more" (click)="main(f)">{{ 'Make it the model' | t }}</button> }
              @if (can() && f.role === 'image' && f.file !== x.picture?.file && !x.linked) {
                <button class="st-more" (click)="main(f)">{{ 'Use as picture' | t }}</button> }
              @if (can()) { <button class="tcv-cc-ib tcv-cc-danger pfl-x" (click)="detach(f)" [title]="'Detach it: the file stays in Files' | t">
                <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button> }
            </td>
          </tr>
        }
      </tbody></table></div>
      @if (x.cad && !compact()) { <ng-container *ngTemplateOutlet="cadT; context: { $implicit: x }" /> }
    }
    <!-- in the detail: the model's picture is the gallery's (ProductGallery); here one slim row - the CAD command and where to drop more -->
    @if (compact() && (can() || x.cad)) {
      <div class="pfl-foot">
        @if (x.cad) { <ng-container *ngTemplateOutlet="cadT; context: { $implicit: x }" /> }
        @if (can()) {
          <label class="pfl-strip" [attr.data-busy]="busy() ? 1 : null"
                 [title]="'STEP, STP, STL, 3MF or OBJ becomes its 3D model and is measured; a PDF its datasheet; a picture its picture. A ZIP is unpacked. Or click to choose.' | t">
            <input type="file" multiple [accept]="x.accept" hidden (change)="upload($any($event.target).files); $any($event.target).value = ''">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4 M7 9l5-5 5 5 M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
            @if (busy()) { <b>{{ 'Keeping it…' | t }}</b><span class="mono">{{ busy() }}</span> }
            @else { <b>{{ (x.files.length ? 'Drop more files anywhere here' : 'Drop its STEP, datasheet or pictures here') | t }}</b>
                    <span>{{ 'STEP, STL, 3MF, OBJ, PDF, pictures, ZIP - or click' | t }}</span> }
          </label>
        }
      </div>
    }
   </div>
   <ng-template #cadT let-x>
     <button class="st-more pfl-cad" (click)="copyCad(x)" [title]="('The CAD rooms use it as a model of its own:' | t) + ' revisions.py product to-model ' + x.maker + ':' + x.product + ' --folder …'">{{ 'Use in CAD - copy the command' | t }}</button>
   </ng-template>
  }
</section>`,
})
export class ProductFilesPanel implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  private solids = inject(MeshThumbs);
  private state = inject(ProductFilesState);
  readonly maker = input.required<string>();
  readonly product = input.required<string>();
  /** In the product's detail: no picture (the gallery shows the model), the whole section the drop target, a slim row to choose. */
  readonly compact = input(false);
  /** Who keeps a drop instead of the files route: a saved McMaster-Carr or GrabCAD item's own (linked.ts), its name and checks. */
  readonly uploader = input<((files: File[]) => Promise<unknown>) | null>(null);
  /** Its files or what its model measured changed: a holder that shows them too reads itself again. */
  readonly changed = output<void>();
  v = signal<ProductFiles | null>(null);
  err = signal('');
  busy = signal('');
  dropping = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  t = t;
  fmt = fmt;
  kb = kb;
  mismatchTip = mismatchTip;

  constructor() {
    effect(() => {
      const mid = this.maker(), pid = this.product();
      untracked(() => { this.v.set(null); this.err.set(''); this.read(mid, pid); });
    });
  }
  ngOnDestroy() { clearTimeout(this.timer); }

  can() { return this.auth.can('draw'); }
  /** In the detail the whole section takes a drop: files dragged over it, off it (not between its rows), let go on it. */
  over(e: DragEvent) { if (this.compact() && this.can() && this.v()) { e.preventDefault(); this.dropping.set(true); } }
  leave(e: DragEvent) { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) this.dropping.set(false); }
  dropped(e: DragEvent) {
    if (!this.compact() || !this.can()) return;
    e.preventDefault(); this.dropping.set(false); this.upload(e.dataTransfer?.files ?? null);
  }
  /** The measured rows, translated: [what, value, what its words say otherwise or '']. */
  rows = computed((): [string, string, string][] => {
    const ms = this.v()?.measured;
    if (!ms?.size) return [];
    const out = measuredRows(ms);
    const said = ms.mismatch.find(b => b.what === 'Size')?.said ?? '';
    if (ms.unit === 'assumed mm') out[0][1] += ' ' + t('(no unit in the file: taken as mm)');
    if (!ms.screw && said) out[0][2] = said;
    if ((ms.solids ?? 0) > 1) out.push([t('Solids'), fmt('{n} - an assembly: the size is all of them', { n: ms.solids ?? 0 }), '']);
    return out;
  });
  role(f: ProductFile, x: ProductFiles) {
    if (f.file === x.cad?.file) return 'Its 3D model';
    if (f.file === x.picture?.file) return 'Its picture';
    return ROLE[f.role] ?? f.role;
  }
  when(iso: string) { return new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : [], { day: 'numeric', month: 'short', year: 'numeric' }); }

  private read(mid = this.maker(), pid = this.product(), tries = 0) {
    clearTimeout(this.timer);
    this.http.get<ProductFiles>(base(mid, pid)).subscribe({
      next: r => {
        if (mid !== this.maker() || pid !== this.product()) return;
        this.show(r);
        // A model just attached is measured on the server after the answer: asked again until it is (a minute at most).
        if (r.measured?.pending && tries < 40) this.timer = setTimeout(() => this.read(mid, pid, tries + 1), 1500);
        else if (tries) {
          this.state.load();
          this.changed.emit();
          if (r.measured?.mismatch?.length) Toast.show(fmt('{k}: the 3D model does not match its words', { k: r.name }) + ' - ' + mismatchTip(r.measured).replace(/\n/g, '; '), { tone: 'warn' });
        }
      },
      error: e => this.err.set(why(e, 'Could not read its files.')),
    });
  }
  private show(r: ProductFiles) {
    this.v.set(r);
    const c = r.cad;
    if (c && !c.has_thumb) this.solids.want({ id: c.file, name: c.name, bytes: c.bytes, preview: c.kind === 'step' ? 'step' : 'mesh' } as StoredFile, this.can());
  }
  pic(): string | null {
    const c = this.v()?.cad;
    if (!c) return null;
    return this.solids.drawn()[c.file] ?? (c.has_thumb ? `/api/files/${encodeURIComponent(c.file)}/thumb?v=${c.has_thumb}` : null);
  }

  async upload(list: FileList | File[] | null) {
    const fs = [...(list ?? [])];
    if (!fs.length) return;
    const mid = this.maker(), pid = this.product(), own = this.uploader();
    if (own) {
      this.busy.set(fs.length > 1 ? fmt('{n} files', { n: fs.length }) : fs[0].name);
      try { await own(fs); } finally { this.busy.set(''); }
      this.state.load(); this.changed.emit(); this.read(mid, pid, 1);
      return;
    }
    for (const [i, f] of fs.entries()) {
      this.busy.set(fs.length > 1 ? `${i + 1} / ${fs.length} · ${f.name}` : f.name);
      const body = new FormData();
      body.append('upload', f, f.name);
      try {
        const r = await firstValueFrom(this.http.post<ProductFiles & { report: { status: string; name: string; why?: string; replaced?: string }[] }>(base(mid, pid), body));
        this.show(r);
        for (const rep of r.report) {
          if (rep.status === 'attached') Toast.show(fmt('{f} attached', { f: rep.name }) + (rep.replaced ? ' - ' + fmt('it replaces {o} as the 3D model; {o} stays attached', { o: rep.replaced }) : ''), { tone: 'ok' });
          else if (rep.status === 'already') Toast.show(fmt('{f} is attached already', { f: rep.name }), { tone: 'info' });
          else Toast.show(rep.why || fmt('{f} was not attached', { f: rep.name }), { tone: 'warn' });
        }
      } catch (e) { Toast.show(why(e, 'Could not keep the file.'), { tone: 'danger' }); }
    }
    this.busy.set('');
    this.state.load();
    this.changed.emit();
    this.read(mid, pid, 1);
  }
  /** The CAD rooms' command for its model, copied: an agent makes it a model of a project. */
  copyCad(x: ProductFiles) {
    const cmd = `revisions.py product to-model ${x.maker}:${x.product} --folder `;
    try { navigator.clipboard.writeText(cmd).then(() => Toast.show(fmt('{c} copied', { c: cmd })), () => {}); } catch { /* no clipboard */ }
  }
  async main(f: ProductFile) {
    try {
      const r = await firstValueFrom(this.http.patch<ProductFiles>(`${base(this.maker(), this.product())}/${encodeURIComponent(f.file)}`, { main: true }));
      this.show(r);
      this.state.load();
      this.changed.emit();
      if (r.measured?.pending) this.read(this.maker(), this.product(), 1);
    } catch (e) { Toast.show(why(e, 'Could not change it.'), { tone: 'danger' }); }
  }
  async detach(f: ProductFile) {
    const x = this.v();
    if (!x || !await Confirm.ask({ title: fmt('Detach {f} from {p}?', { f: f.name, p: x.name }),
                                   text: t('The file stays in Files; a CAD model made of it keeps its own copy.'), ok: t('Detach'), danger: true })) return;
    try {
      const r = await firstValueFrom(this.http.delete<{ product: ProductFiles | null }>(`${base(this.maker(), this.product())}/${encodeURIComponent(f.file)}`));
      if (r.product) this.show(r.product);
      this.state.load();
      this.changed.emit();
      if (r.product?.measured?.pending) this.read(this.maker(), this.product(), 1);
    } catch (e) { Toast.show(why(e, 'Could not detach it.'), { tone: 'danger' }); }
  }
}

/** The 3D model a gallery shows beside the pictures: its file, kind and the picture drawn of it. */
export interface GalleryModel { file: string; name: string; kind: string; thumb?: string | null }

/** A product's pictures and its 3D model in one gallery, at the head of its
 *  detail (the Parts product, a saved McMaster-Carr or GrabCAD item): the
 *  one picked large, the others in a strip. The model is an item like a
 *  picture - its drawn picture tinted as in Files, marked "3D" - and turns
 *  in the hand on asking (mesh-view.ts). With nothing to show, the stage is
 *  where its first picture or STEP is dropped. */
@Component({
  selector: 'wb-pd-gallery',
  imports: [T, MeshView],
  host: { class: 'pdg', style: 'display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0' },
  styleUrls: ['./product-files.css'],
  template: `
<div class="pdg-stage" [attr.data-solid]="cur()?.solid ? 1 : null" [attr.data-empty]="!cur() ? 1 : null" [attr.data-on]="dropping() ? 1 : null"
     (dragover)="over($event)" (dragleave)="dropping.set(false)" (drop)="drop($event)">
  @if (cur(); as c) {
    @if (c.solid && live() && model(); as m) {
      <app-mesh-view [src]="meshSrc(m)" [name]="m.name" [step]="m.kind === 'step'" />
    } @else if (c.src) {
      <img [class.tcv-fm-solid]="c.solid" [src]="c.src" referrerpolicy="no-referrer" alt="" (error)="broke.emit(c.src)">
    } @else {
      <div class="pdg-none"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CUBE" /></svg><span>{{ 'drawing its picture…' | t }}</span></div>
    }
    @if (c.solid && model(); as m) {
      <span class="pdg-tag" [title]="m.name">3D · {{ m.kind === 'step' ? 'STEP' : ('mesh' | t) }}</span>
      <button class="pdg-turn" (click)="live.set(!live())">{{ (live() ? 'Its picture' : 'Turn it in 3D') | t }}</button>
    }
  } @else if (canDrop()) {
    <label class="pdg-none pdg-drop">
      <input type="file" multiple [accept]="accept()" hidden (change)="files.emit($any($event.target).files); $any($event.target).value = ''">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4 M7 9l5-5 5 5 M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
      <b>{{ 'No picture and no 3D model yet' | t }}</b>
      <span>{{ 'Drop a picture or its STEP here, or click to choose' | t }}</span>
    </label>
  } @else {
    <div class="pdg-none"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CUBE" /></svg><span>{{ 'No picture and no 3D model yet' | t }}</span></div>
  }
</div>
@if (items().length > 1) {
  <div class="pdg-strip" role="listbox" [attr.aria-label]="'Pictures' | t">
    @for (it of items(); track it.key) {
      <button role="option" [attr.aria-selected]="it.key === cur()?.key" [class.on]="it.key === cur()?.key" (click)="pick.set(it.key)"
              [title]="it.solid ? ('3D model' | t) : ''">
        @if (it.src) { <img [class.tcv-fm-solid]="it.solid" [src]="it.src" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke.emit(it.src)"> }
        @else { <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CUBE" /></svg> }
        @if (it.solid) { <i>3D</i> }
      </button>
    }
  </div>
}`,
})
export class ProductGallery {
  private solids = inject(MeshThumbs);
  /** Whose gallery: picking and turning start again for another. */
  readonly key = input('');
  readonly pics = input<string[]>([]);
  readonly model = input<GalleryModel | null>(null);
  /** Files may be dropped on an empty stage: given out as they are, for the files panel to keep. */
  readonly canDrop = input(false);
  readonly accept = input('.step,.stp,.stl,.3mf,.obj,.pdf,.png,.jpg,.jpeg,.webp,.zip');
  readonly files = output<FileList | File[]>();
  readonly broke = output<string>();
  readonly CUBE = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9';
  pick = signal<string | null>(null);
  live = signal(false);
  dropping = signal(false);

  constructor() {
    effect(() => { this.key(); untracked(() => { this.pick.set(null); this.live.set(false); }); });
  }
  /** The pictures, then the model; the model first when it is all there is of it to see. */
  items = computed(() => {
    const m = this.model();
    const out = this.pics().map(src => ({ key: src, src: src as string | null, solid: false }));
    if (m) {
      const it = { key: '3d:' + m.file, src: this.solids.drawn()[m.file] ?? m.thumb ?? null, solid: true };
      if (out.length) out.push(it); else out.unshift(it);
    }
    return out;
  });
  cur = computed(() => { const l = this.items(), k = this.pick(); return l.find(x => x.key === k) ?? (l.length ? l[0] : null); });
  meshSrc(m: GalleryModel) { return m.kind === 'step' ? meshUrl(m.file) : inlineUrl(m.file); }
  over(e: DragEvent) { if (this.canDrop() && !this.cur()) { e.preventDefault(); this.dropping.set(true); } }
  drop(e: DragEvent) {
    if (!this.canDrop() || this.cur()) return;
    e.preventDefault(); this.dropping.set(false);
    const l = e.dataTransfer?.files;
    if (l?.length) this.files.emit(l);
  }
}

/** A full-screen detail the browser's Back closes: while it is open it has
 *  one history entry of its own (the address stays as the page sets it);
 *  closed by hand, that entry is gone again. */
export class BackCloses {
  private on = false;
  private pop = () => { if (!this.on) return; this.on = false; removeEventListener('popstate', this.pop); this.close(); };
  constructor(private close: () => void) {}
  opened() {
    if (this.on) return;
    this.on = true;
    history.pushState(history.state, '', location.href);
    addEventListener('popstate', this.pop);
  }
  closed() {
    if (!this.on) return;
    this.on = false;
    removeEventListener('popstate', this.pop);
    history.back();
  }
}

/** A product deleted by hand whose files are still kept (backend/product_files.py `orphans`). */
export interface Orphan { mid: string; pid: string; name: string; maker_name: string; cad: string | null; picture: string | null;
  updated_at?: string; files: (ProductFile & { in_files: boolean })[] }
interface Pick { maker: { id: string; name: string }; id: string; name: string; sku?: string }

/** "Orphan files" on the Parts page: the files of products deleted by hand,
 *  each product a group of its files - attached to another product (its
 *  STEP its model when it has none), opened in Files, or let go: kept in
 *  Files, or removed from it too where nothing else uses them. */
@Component({
  selector: 'wb-orphan-files',
  imports: [T, EmptyState],
  styleUrls: ['../settings.css', './manufacturers.css', './product-files.css'],
  template: `
@if (list(); as l) {
  @if (l.length) {
    <div class="st-table-wrap pfo-wrap">
      <table class="st-table pfo">
        <thead><tr><th>{{ 'File' | t }}</th><th>{{ 'Role' | t }}</th><th class="r">{{ 'Size' | t }}</th><th>{{ 'Attached' | t }}</th><th class="r"></th></tr></thead>
        @for (o of l; track o.mid + ':' + o.pid) {
          <tbody>
            <tr class="pfo-head">
              <td colspan="5"><div class="pfo-hrow">
                <b>{{ o.name || o.pid }}</b>
                <span class="dim">{{ o.maker_name || o.mid }} · {{ fmt(o.files.length === 1 ? '{n} file' : '{n} files', { n: o.files.length }) }} · {{ 'its product was deleted' | t }}</span>
                @if (can()) { <span class="pfo-acts">
                  <button class="st-more" (click)="openPick(o)" [attr.aria-expanded]="picking() === key(o)">{{ 'Attach to a product…' | t }}</button>
                  <button class="st-more" (click)="letGo(o, false)" [title]="'The files stay in Files' | t">{{ 'Let go' | t }}</button>
                  <button class="st-more pfo-del" (click)="letGo(o, true)">{{ 'Delete the files' | t }}</button>
                </span> }
              </div></td>
            </tr>
            @if (picking() === key(o)) {
              <tr class="pfo-pickrow"><td colspan="5">
                <div class="pfo-pick mf-ctl">
                  <input class="tst-in" [placeholder]="'Find the product: name, code, seller' | t" [value]="q()" (input)="find($any($event.target).value)"
                         (keydown.escape)="picking.set(null)" [attr.aria-label]="'Find the product' | t" autofocus>
                  <div class="pfo-hits" role="listbox">
                    @for (p of hits(); track p.maker.id + ':' + p.id) {
                      <button role="option" (click)="adopt(o, p)" [disabled]="busy()">
                        <b>{{ p.name }}</b><span class="dim">{{ p.maker.name }}@if (p.sku) { · <span class="mono">{{ p.sku }}</span> }</span></button>
                    } @empty { <span class="dim">{{ (q().trim() ? 'No product matches.' : 'Type to find the product to attach them to.') | t }}</span> }
                  </div>
                </div>
              </td></tr>
            }
            @for (f of o.files; track f.file) {
              <tr [attr.data-gone]="f.in_files ? null : 1">
                <td class="give"><span class="pfo-name" [class.pfo-main]="f.file === o.cad || f.file === o.picture" [title]="f.name">{{ f.name }}</span>
                  @if (!f.in_files) { <span class="st-tag" data-tone="warn">{{ 'not in Files any more' | t }}</span> }</td>
                <td><span class="st-tag" [attr.data-tone]="f.file === o.cad ? 'ok' : null">{{ (f.file === o.cad ? 'Its 3D model' : role(f.role)) | t }}</span></td>
                <td class="r mono dim">{{ kb(f.bytes) }}</td>
                <td class="dim">{{ f.by?.name || ('someone' | t) }}@if (f.at) { · {{ when(f.at) }} }</td>
                <td class="r nowrap">@if (f.in_files) {
                  <button class="st-more" (click)="toFiles(f.file)">{{ 'Open in Files' | t }}</button>
                  <a class="st-more" [href]="'/api/files/' + f.file" download>{{ 'Download' | t }}</a> }</td>
              </tr>
            }
          </tbody>
        }
      </table>
    </div>
  } @else {
    <wb-empty icon="table" text="No orphan files: every file kept for a product belongs to one still in Parts." />
  }
} @else if (err()) { <p class="st-err">{{ err() }}</p> } @else { <p class="st-sub">…</p> }`,
})
export class OrphanFiles {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  private sel = inject(Selection);
  private state = inject(ProductFilesState);
  list = signal<Orphan[] | null>(null);
  err = signal('');
  picking = signal<string | null>(null);
  q = signal('');
  hits = signal<Pick[]>([]);
  busy = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  fmt = fmt;
  kb = kb;

  constructor() { this.read(); }
  can() { return this.auth.can('draw'); }
  key(o: Orphan) { return o.mid + ':' + o.pid; }
  role(r: string) { return ROLE[r] ?? r; }
  when(iso: string) { return new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : [], { day: 'numeric', month: 'short', year: 'numeric' }); }
  private read() {
    this.http.get<Orphan[]>('/api/product-files/orphans').subscribe({
      next: r => this.list.set(r), error: e => this.err.set(why(e, 'Could not read the orphan files.')) });
  }
  private done() { this.picking.set(null); this.read(); this.state.load(); }
  openPick(o: Orphan) {
    const k = this.key(o);
    this.picking.set(this.picking() === k ? null : k);
    this.q.set(''); this.hits.set([]);
    // The product of the same name, when the catalog has one again, is the likely place.
    if (this.picking() && o.name) this.find(o.name);
  }
  find(words: string) {
    this.q.set(words);
    clearTimeout(this.timer);
    if (!words.trim()) { this.hits.set([]); return; }
    this.timer = setTimeout(() => this.http.get<{ items: Pick[] }>(`/api/manufacturers/products?q=${encodeURIComponent(words.trim())}&size=8`)
      .subscribe({ next: r => this.hits.set(r.items ?? []), error: () => this.hits.set([]) }), 180);
  }
  async adopt(o: Orphan, p: Pick) {
    this.busy.set(true);
    try {
      const r = await firstValueFrom(this.http.post<{ left: number; report: { status: string }[] }>(
        `/api/manufacturers/orphan-files/${encodeURIComponent(o.mid)}/${encodeURIComponent(o.pid)}/adopt`, { maker: p.maker.id, product: p.id }));
      const n = r.report.filter(x => x.status === 'attached' || x.status === 'already').length;
      Toast.show(fmt('{n} attached to {p}', { n, p: p.name }) + (r.left ? ' - ' + fmt('{n} could not be', { n: r.left }) : ''), { tone: r.left ? 'warn' : 'ok' });
      this.done();
    } catch (e) { Toast.show(why(e, 'Could not attach them.'), { tone: 'danger' }); }
    this.busy.set(false);
  }
  async letGo(o: Orphan, remove: boolean) {
    const name = o.name || o.pid;
    if (!await Confirm.ask(remove
      ? { title: fmt('Delete the files of {p}?', { p: name }), ok: t('Delete'), danger: true,
          text: t('Each file is removed from Files too, unless another product or a CAD model uses it or it is someone else\'s and you may not delete.') }
      : { title: fmt('Let go of the files of {p}?', { p: name }), ok: t('Let go'),
          text: t('They are no longer kept for it; the files themselves stay in Files.') })) return;
    try {
      const r = await firstValueFrom(this.http.delete<{ removed: string[]; kept: [string, string][] }>(
        `/api/manufacturers/orphan-files/${encodeURIComponent(o.mid)}/${encodeURIComponent(o.pid)}${remove ? '?delete_files=true' : ''}`));
      if (remove) Toast.show(fmt('{n} removed from Files', { n: r.removed.length }) + (r.kept.length ? ' - ' + r.kept.map(k => k[0] + ': ' + k[1]).join('; ') : ''),
                             { tone: r.kept.length ? 'warn' : 'ok' });
      else Toast.show(fmt('{p} let go; its files stay in Files', { p: name }), { tone: 'ok' });
      this.done();
    } catch (e) { Toast.show(why(e, 'Could not do it.'), { tone: 'danger' }); }
  }
  /** Files, with the file open in its folder. */
  toFiles(id: string) { this.sel.room.set('files'); this.sel.ask('file', id); }
}
