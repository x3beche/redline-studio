import { Component, Injectable, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { LANG, T, t } from '../i18n';
import { Toast } from '../toast';
import { MeshThumbs } from './mesh-thumb';
import { StoredFile } from './files-model';
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
  load() { this.http.get<{ products: Record<string, HeldFiles> }>('/api/product-files/summary').subscribe({ next: r => this.held.set(r.products), error: () => {} }); }
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
  imports: [T],
  host: { style: 'display: block' },
  styleUrls: ['../settings.css', './manufacturers.css', './linked.css', './product-files.css'],
  template: `
<section class="pfl" [attr.aria-label]="'Files' | t">
  <div class="pfl-head">
    <span class="mf-label">{{ 'Files' | t }}</span>
    @if (v(); as x) {
      <span class="st-sub">@if (x.files.length) { {{ fmt(x.files.length === 1 ? '{n} file' : '{n} files', { n: x.files.length }) }} } @else { {{ 'none yet' | t }} }
        @if (x.lcsc_3d) { · {{ 'its own 3D model comes from LCSC; a file here is an extra' | t }} }</span>
    } @else if (err()) { <span class="st-sub" data-tone="danger">{{ err() }}</span> } @else { <span class="st-sub">…</span> }
  </div>
  @if (v(); as x) {
    <div class="pfl-top" [attr.data-solo]="!can() ? 1 : null">
      <div class="ln-pic pfl-pic">
        @if (pic(); as src) { <img class="tcv-fm-solid" [src]="src" alt=""> }
        @else { <svg class="ln-cube" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" /></svg>
                <span class="dim">{{ (x.cad ? 'drawing its picture…' : 'no 3D model yet') | t }}</span> }
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
      @if (x.cad) { <p class="ln-agent dim">{{ 'The CAD rooms use it as a model of its own:' | t }} <code>revisions.py product to-model {{ x.maker }}:{{ x.product }} --folder …</code></p> }
    }
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
    const mid = this.maker(), pid = this.product();
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
    this.read(mid, pid, 1);
  }
  async main(f: ProductFile) {
    try {
      const r = await firstValueFrom(this.http.patch<ProductFiles>(`${base(this.maker(), this.product())}/${encodeURIComponent(f.file)}`, { main: true }));
      this.show(r);
      this.state.load();
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
      if (r.product?.measured?.pending) this.read(this.maker(), this.product(), 1);
    } catch (e) { Toast.show(why(e, 'Could not detach it.'), { tone: 'danger' }); }
  }
}
