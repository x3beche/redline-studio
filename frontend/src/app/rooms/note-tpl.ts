import { Component, ElementRef, Injectable, booleanAttribute, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { LANG, T, t } from '../i18n';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { Toast } from '../toast';

/** Starting texts for the notes and requests people write most: picked
 *  from a small menu beside a composer - the Notes editor, the Alt+N quick
 *  note, a room's agent thread - and put into the box with `[holes]` to
 *  fill; the first hole is selected, Tab goes to the next. The room's own
 *  come first.
 *
 *  The built-in ones are written by hand here, in both languages. A
 *  person's own are kept on the server, theirs only
 *  (backend/note_templates.py): saved from the text in the box, deleted
 *  from the menu. Whole-note templates with tags and tables stay where
 *  they were (note-templates.ts, the Notes room's empty page). */
export interface QuickTemplate { id: string; room: string; name: string; nameTr: string; en: string; tr: string }

export const QUICK_TEMPLATES: QuickTemplate[] = [
  {
    id: 'dim', room: 'cad', name: 'Change a dimension', nameTr: 'Ölçü değiştir',
    en: `Change a dimension on [part]
- Feature: [which face, hole or edge]
- Now: [value] mm
- Wanted: [value] mm
- Keep as it is: [what must not move]`,
    tr: `[parça] üzerinde bir ölçü değişecek
- Özellik: [hangi yüzey, delik ya da kenar]
- Şu an: [değer] mm
- Olması gereken: [değer] mm
- Aynı kalacak: [yerinden oynamaması gereken]`,
  },
  {
    id: 'hole', room: 'cad', name: 'Add a hole', nameTr: 'Delik ekle',
    en: `Add a hole to [part]
- Where: [face], [x] mm from [edge], [y] mm from [edge]
- Size: Ø[diameter] mm, [through or depth]
- For: [screw size, or what passes through]`,
    tr: `[parça] üzerine bir delik eklenecek
- Yer: [yüzey], [kenar] kenarından [x] mm, [kenar] kenarından [y] mm
- Ölçü: Ø[çap] mm, [boydan boya ya da derinlik]
- Ne için: [vida ölçüsü ya da içinden geçecek şey]`,
  },
  {
    id: 'move', room: 'cad', name: 'Move a part', nameTr: 'Parçayı taşı',
    en: `Move [part]
- Now: [where it is]
- To: [where it should be], [distance] mm along [X, Y or Z]
- Check: [clearances, or parts it must still fit]`,
    tr: `[parça] taşınacak
- Şu an: [bulunduğu yer]
- Yeni yer: [olması gereken yer], [X, Y ya da Z] yönünde [mesafe] mm
- Kontrol: [korunacak boşluklar ya da oturması gereken parçalar]`,
  },
  {
    id: 'print', room: 'cad', name: 'Change material or print settings', nameTr: 'Malzeme ya da baskı ayarı',
    en: `Change the material or print settings of [part]
- Material: [PLA, PETG, ABS, aluminium…]
- Layer height: [mm], infill: [%], walls: [count]
- Why: [strength, heat, finish]`,
    tr: `[parça] için malzeme ya da baskı ayarı değişecek
- Malzeme: [PLA, PETG, ABS, alüminyum…]
- Katman yüksekliği: [mm], doluluk: [%], duvar: [sayı]
- Neden: [dayanım, ısı, yüzey]`,
  },
  {
    id: 'conn', room: 'pcb', name: 'PCB: move a connector', nameTr: 'PCB: konnektörü taşı',
    en: `PCB: move connector [J1]
- To: [board edge or position], x [mm], y [mm]
- Facing: [out over the edge, or up]
- Keep: [routing, mounting holes, enclosure cut-out]`,
    tr: `PCB: [J1] konnektörü taşınacak
- Yeni yer: [kart kenarı ya da konum], x [mm], y [mm]
- Yön: [kenardan dışarı ya da yukarı]
- Korunacak: [yollar, montaj delikleri, kutu kesiği]`,
  },
  {
    id: 'part', room: 'pcb', name: 'PCB: add a part', nameTr: 'PCB: parça ekle',
    en: `PCB: add a part
- Part: [name or LCSC number]
- Connects to: [nets or pins]
- Place near: [part or area], package [footprint]`,
    tr: `PCB: bir parça eklenecek
- Parça: [ad ya da LCSC numarası]
- Bağlantı: [netler ya da pinler]
- Yakınına: [parça ya da bölge], kılıf [paket]`,
  },
  {
    id: 'pin', room: 'firmware', name: 'Firmware: change a pin or setting', nameTr: 'Firmware: pin ya da ayar değiştir',
    en: `Firmware: change a pin or setting
- What: [pin, peripheral or setting]
- Now: [current value]
- Wanted: [new value]
- Test: [how to tell it works]`,
    tr: `Firmware: bir pin ya da ayar değişecek
- Ne: [pin, çevre birimi ya da ayar]
- Şu an: [mevcut değer]
- Olması gereken: [yeni değer]
- Test: [çalıştığı nasıl anlaşılacak]`,
  },
  {
    id: 'problem', room: '', name: 'Report a problem', nameTr: 'Sorun bildir',
    en: `Problem: [what goes wrong]
- Where: [model, board or file]
- Expected: [what should happen]
- Seen: [what happens instead]`,
    tr: `Sorun: [ne yanlış gidiyor]
- Nerede: [model, kart ya da dosya]
- Beklenen: [ne olmalıydı]
- Olan: [onun yerine ne oluyor]`,
  },
];

/** The rooms a template can be for (backend/note_templates.py ROOMS), with their short names. */
const ROOM_SHORT: Record<string, string> = { cad: '3D', pcb: 'PCB', firmware: 'Firmware', notes: 'Notes' };
/** A hole to fill: `[like this]` on one line. */
const HOLE = /\[[^\]\n]+\]/;

export interface OwnTemplate { id: string; name: string; room: string; text: string }

/** One's own templates, read once and kept for every composer. */
@Injectable({ providedIn: 'root' })
export class NoteTemplates {
  private http = inject(HttpClient);
  mine = signal<OwnTemplate[]>([]);
  private asked = false;

  load(again = false) {
    if (this.asked && !again) return;
    this.asked = true;
    this.http.get<OwnTemplate[]>('/api/note-templates').subscribe({ next: l => this.mine.set(l), error: () => { this.asked = false; } });
  }
  save(name: string, room: string, text: string) {
    return this.http.post<OwnTemplate>('/api/note-templates', { name, room, text });
  }
  remove(id: string) { return this.http.delete(`/api/note-templates/${id}`); }
}

/** A template's text put into a box: the whole box when it is empty, else
 *  as a paragraph of its own where the cursor is. Its first hole is
 *  selected, to be typed over. Returns the box's new text. */
export function putTemplate(el: HTMLTextAreaElement, text: string): string {
  const cur = el.value;
  let value: string, start: number;
  if (!cur.trim()) { value = text; start = 0; }
  else {
    const at = el.selectionStart ?? cur.length, end = el.selectionEnd ?? at;
    const before = cur.slice(0, at), after = cur.slice(end);
    const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const post = !after || after.startsWith('\n') ? '' : '\n\n';
    value = before + pre + text + post + after;
    start = before.length + pre.length;
  }
  el.value = value;
  el.focus();
  const m = HOLE.exec(text);
  if (m) el.setSelectionRange(start + m.index, start + m.index + m[0].length);
  else el.setSelectionRange(start + text.length, start + text.length);
  return value;
}

/** Tab in a box with holes left after the cursor: the next one is selected.
 *  False when there is none (Tab then does what it always does). */
export function nextHole(el: HTMLTextAreaElement): boolean {
  const from = el.selectionEnd ?? 0;
  const m = HOLE.exec(el.value.slice(from));
  if (!m) return false;
  el.setSelectionRange(from + m.index, from + m.index + m[0].length);
  return true;
}

interface Row { key: string; name: string; room: string; text: string; own?: OwnTemplate }

/** The menu: a small button in the composer's bar; open, one line per
 *  template, the room's first, one's own with a delete beside them, and
 *  "Save this text as a template" at the foot. */
@Component({
  selector: 'wb-note-tpl',
  imports: [T],
  host: { class: 'wb-ntpl', '(document:mousedown)': 'outside($event)', '(keydown)': 'key($event)' },
  styles: [`
:host { position: relative; display: inline-flex; flex: none; }
.wb-ntpl-btn { gap: 4px; }
.wb-ntpl-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.wb-ntpl-pop { position: absolute; z-index: 40; left: 0; top: calc(100% + 6px); width: 300px; max-height: 440px;
  overflow-y: auto; padding: 4px; display: flex; flex-direction: column; text-align: left; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 28px var(--shadow-hard); scrollbar-width: thin; }
.wb-ntpl-pop[data-up] { top: auto; bottom: calc(100% + 6px); }
.wb-ntpl-pop[data-right] { left: auto; right: 0; }
.wb-ntpl-group { padding: 6px 10px 2px; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-dim); }
.wb-ntpl-row { position: relative; display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 10px; font-size: 12.5px;
  color: var(--ink); background: none; border: 0; border-radius: 5px; cursor: pointer; text-align: left; }
.wb-ntpl-row:hover, .wb-ntpl-row[data-at] { background: var(--hover); }
.wb-ntpl-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-ntpl-room { flex: none; font-size: 11px; color: var(--ink-dim); }
/* One's own: the delete takes the room's place while the row is pointed at, so nothing moves. */
.wb-ntpl-del { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center;
  justify-content: center; width: 22px; height: 22px; color: var(--ink-dim); background: var(--hover); border: 0; border-radius: 4px;
  cursor: pointer; opacity: 0; }
.wb-ntpl-row:hover .wb-ntpl-del, .wb-ntpl-row[data-at] .wb-ntpl-del, .wb-ntpl-del:focus-visible { opacity: 1; }
.wb-ntpl-row[data-own]:hover .wb-ntpl-room, .wb-ntpl-row[data-own][data-at] .wb-ntpl-room { visibility: hidden; }
.wb-ntpl-del:hover { color: var(--danger); }
.wb-ntpl-del svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.wb-ntpl-pop hr { margin: 4px 2px; border: 0; border-top: 1px solid var(--line); }
.wb-ntpl-save { color: var(--ink-dim); }
.wb-ntpl-save:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 768px) { .wb-ntpl-pop { width: min(300px, calc(100vw - 32px)); } .wb-ntpl-row { min-height: 40px; } }
`],
  template: `
<button type="button" class="tcv-cc-ib wb-ntpl-btn" [class.on]="open()" (click)="toggle()" [attr.aria-expanded]="open()"
        aria-haspopup="menu" [title]="'Start from a template' | t">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z M8.5 8.5h7 M8.5 12h7 M8.5 15.5h4" /></svg>
  @if (label()) { <span>{{ 'Templates' | t }}</span> }
</button>
@if (open()) {
  <div class="wb-ntpl-pop tcv-pop-in" animate.leave="tcv-leave" role="menu" [attr.data-up]="upward() ? 1 : null"
       [attr.data-right]="align() === 'right' ? 1 : null" [style.max-height.px]="room4()"
       [style.--tcv-origin]="(upward() ? 'bottom ' : 'top ') + (align() === 'right' ? 'right' : 'left')">
    @for (g of groups(); track g.label) {
      <div class="wb-ntpl-group">{{ g.label }}</div>
      @for (r of g.rows; track r.key) {
        <div class="wb-ntpl-row" role="menuitem" tabindex="-1" [attr.data-at]="r.key === at() ? 1 : null" [attr.data-own]="r.own ? 1 : null"
             (mouseenter)="at.set(r.key)" (click)="choose(r)" [title]="r.text">
          <span class="wb-ntpl-name">{{ r.name }}</span>
          @if (r.room && r.room !== room()) { <span class="wb-ntpl-room">{{ short(r.room) | t }}</span> }
          @if (r.own) {
            <button type="button" class="wb-ntpl-del" (click)="remove(r.own); $event.stopPropagation()" [title]="'Delete this template' | t"
                    [attr.aria-label]="'Delete this template' | t">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
          }
        </div>
      }
    }
    @if (auth.can('draw')) {
      <hr>
      <button type="button" class="wb-ntpl-row wb-ntpl-save" role="menuitem" [disabled]="!text().trim()" (click)="save()"
              [title]="(text().trim() ? 'Keep what is in the box as one of your templates' : 'Write something first, then save it as a template.') | t">
        <span class="wb-ntpl-name">{{ 'Save this text as a template' | t }}</span></button>
    }
  </div>
}`,
})
export class NoteTplPicker {
  private store = inject(NoteTemplates);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  auth = inject(Auth);

  /** The room the box writes to: its templates come first, and one saved here is for it. */
  room = input('');
  /** What is in the box now, for "Save this text as a template". */
  text = input('');
  /** The menu opens upward (a composer at the foot of the page). */
  up = input(false, { transform: booleanAttribute });
  align = input<'left' | 'right'>('left');
  /** The word "Templates" beside the icon. */
  label = input(false, { transform: booleanAttribute });
  /** The template's text, in the app's language. */
  pick = output<string>();

  open = signal(false);
  /** The row the arrow keys are on. */
  at = signal<string | null>(null);
  /** Where it opens this time: the side asked for when the menu fits there, else the side with more room. */
  upward = signal(false);
  /** The menu's height, so it never leaves the window. */
  room4 = signal(440);

  groups = computed(() => {
    const tr = LANG() === 'tr', here = this.room();
    const rows: Row[] = [
      ...this.store.mine().map(o => ({ key: 'o:' + o.id, name: o.name, room: o.room, text: o.text, own: o })),
      ...QUICK_TEMPLATES.map(q => ({ key: 'q:' + q.id, name: tr ? q.nameTr : q.name, room: q.room, text: tr ? q.tr : q.en })),
    ];
    const out: { label: string; rows: Row[] }[] = [];
    const add = (label: string, l: Row[]) => { if (l.length) out.push({ label, rows: l }); };
    if (ROOM_SHORT[here]) add(t(this.roomLong(here)), rows.filter(r => r.room === here));
    add(t('Any room'), rows.filter(r => !r.room));
    add(t(ROOM_SHORT[here] ? 'Other rooms' : 'For a room'), rows.filter(r => r.room && r.room !== here));
    return out;
  });
  private flat = computed(() => this.groups().flatMap(g => g.rows));

  short(room: string) { return ROOM_SHORT[room] ?? room; }
  private roomLong(room: string) {
    return ({ cad: '3D Drawing', pcb: 'PCB Design', firmware: 'Firmware', notes: 'Notes' } as Record<string, string>)[room] ?? room;
  }

  toggle() {
    if (this.open()) { this.open.set(false); return; }
    this.store.load();
    this.at.set(null);
    const r = this.host.nativeElement.getBoundingClientRect();
    const above = r.top - 12, below = window.innerHeight - r.bottom - 12;
    const up = this.up() ? above >= 300 || above > below : !(below >= 300 || below > above);
    this.upward.set(up);
    this.room4.set(Math.max(160, Math.min(440, (up ? above : below) - 6)));
    this.open.set(true);
  }

  outside(e: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }

  key(e: KeyboardEvent) {
    if (!this.open()) return;
    const rows = this.flat();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.open.set(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const i = rows.findIndex(r => r.key === this.at());
      const n = i < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      this.at.set(rows[n].key);
      this.host.nativeElement.querySelectorAll('.wb-ntpl-row[role="menuitem"]')[n]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const r = rows.find(x => x.key === this.at());
      if (r) { e.preventDefault(); this.choose(r); }
    }
  }

  choose(r: Row) {
    this.open.set(false);
    this.pick.emit(r.text);
  }

  async save() {
    const text = this.text().trim();
    if (!text) return;
    this.open.set(false);
    const name = await Confirm.input({ title: t('Save as a template'), ok: t('Save'), value: text.split('\n')[0].replace(HOLE, '').trim().slice(0, 60),
                                       placeholder: t('Template name') });
    if (!name) return;
    const room = ROOM_SHORT[this.room()] ? this.room() : '';
    this.store.save(name.slice(0, 60), room, text).subscribe({
      next: o => { this.store.mine.update(l => [...l, o]); Toast.show(t('Template saved.'), { tone: 'ok' }); },
      error: (e: HttpErrorResponse) => Toast.show(typeof e.error?.detail === 'string' ? e.error.detail : t('Could not save the template.'), { tone: 'danger' }),
    });
  }

  /** Gone at once; Undo saves it again. */
  remove(o: OwnTemplate) {
    this.store.mine.update(l => l.filter(x => x.id !== o.id));
    this.store.remove(o.id).subscribe({
      next: () => Toast.show(t('Template deleted.'), { action: { label: t('Undo'), run: () => this.store.save(o.name, o.room, o.text)
        .subscribe({ next: back => this.store.mine.update(l => [...l, back]) }) } }),
      error: () => { this.store.load(true); Toast.show(t('Could not delete the template.'), { tone: 'danger' }); },
    });
  }
}
