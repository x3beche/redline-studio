import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { BoardRules, RuleField, RuleSchema } from '../api';

type Row = Record<string, unknown>;

/** The routing rules as a form, drawn from the server's schema.
 *
 *  Nothing here knows what a net class is: each section of the schema is
 *  either one set of fields (the board's minimums) or a list of rows that
 *  can be added to and taken from (classes, pairs, pours), and each field
 *  says its own type, unit, limits and help. The agent edits the same
 *  JSON against the same schema (`revisions.py board rules`), so a field
 *  added on the server turns up in both.
 *
 *  Every change hands a fresh copy up; the room keeps the draft, saves it
 *  and says what the server thought of it.
 */
@Component({
  selector: 'app-rules-form',
  template: `
@for (sec of sections(); track sec.key) {
  <section class="mb-3">
    <div class="mb-1 flex items-center gap-1.5">
      <span class="tcv-label">{{ sec.s.label }}</span>
      <span class="cursor-help text-[10px]" style="color: var(--ink-dim)" [title]="sec.s.help">ⓘ</span>
      @if (sec.s.list) {
        <button (click)="add(sec.key)" class="tcv-chip ml-auto px-1.5 py-0"
                [title]="'add to ' + sec.s.label.toLowerCase()">+ add</button>
      }
    </div>

    @if (sec.s.list) {
      @for (row of rowsOf(sec.key); track $index; let i = $index) {
        <div class="tcv-rule-card">
          <div class="mb-1 flex items-center gap-1">
            @if (titleField(sec.s); as tf) {
              <input [value]="row[tf.key] ?? ''" [readOnly]="isFixed(sec.s, row)"
                     (change)="set(sec.key, i, tf.key, $any($event.target).value.trim())"
                     [placeholder]="tf.label" class="tcv-field min-w-0 flex-1 px-1.5 py-0.5 text-[11px]"
                     [style.font-weight]="600">
            } @else {
              <span class="min-w-0 flex-1 truncate text-[11px]" style="color: var(--ink)">
                {{ sec.s.label }} {{ i + 1 }}
              </span>
            }
            @if (!isFixed(sec.s, row)) {
              <button (click)="remove(sec.key, i)" class="shrink-0 px-1 text-[13px] leading-none"
                      style="color: var(--danger)" title="remove">×</button>
            }
          </div>
          <div class="tcv-rule-grid">
            @for (f of bodyFields(sec.s); track f.key) {
              @if (!(isFixed(sec.s, row) && (f.type === 'nets' || f.type === 'patterns'))) {
                <ng-container *ngTemplateOutlet="field; context: { $implicit: f, row: row, sec: sec.key, i: i }" />
              }
            }
          </div>
          @if (isFixed(sec.s, row)) {
            <p class="mt-1 text-[10px]" style="color: var(--ink-dim)">every net no other class takes</p>
          } @else if (sec.key === 'classes' && caught(row).length) {
            <p class="mt-1 text-[10px] leading-snug" style="color: var(--ink-dim)"
               title="named here, or caught by a pattern">holds: {{ caught(row).join(', ') }}</p>
          }
          @for (p of problemsOf(sec.key, row, i); track p) {
            <p class="mt-1 text-[10px] leading-snug" style="color: var(--danger)">{{ p }}</p>
          }
        </div>
      } @empty {
        <p class="text-[10px]" style="color: var(--ink-dim)">none - + add makes one</p>
      }
    } @else {
      <div class="tcv-rule-card">
        <div class="tcv-rule-grid">
          @for (f of sec.s.fields; track f.key) {
            <ng-container *ngTemplateOutlet="field; context: { $implicit: f, row: objOf(sec.key), sec: sec.key, i: null }" />
          }
        </div>
        @for (p of problemsOf(sec.key, null, null); track p) {
          <p class="mt-1 text-[10px] leading-snug" style="color: var(--danger)">{{ p }}</p>
        }
      </div>
    }
  </section>
}

<!-- One field, whatever its type. -->
<ng-template #field let-f let-row="row" let-sec="sec" let-i="i">
  <div class="tcv-rule-field" [class.tcv-rule-wide]="wide(f)" [title]="f.help ?? ''">
    <span class="tcv-rule-label">{{ f.label }}@if (f.unit) {<span style="color: var(--ink-dim)"> {{ f.unit }}</span>}</span>
    @switch (f.type) {
      @case ('number') {
        <input type="number" [value]="row[f.key]" [step]="f.step ?? 0.01" [min]="f.min" [max]="f.max"
               (change)="set(sec, i, f.key, $any($event.target).valueAsNumber)"
               class="tcv-field w-full min-w-0 px-1 py-0.5 text-right text-[11px] mono">
      }
      @case ('integer') {
        <input type="number" [value]="row[f.key]" step="1" [min]="f.min" [max]="f.max"
               (change)="set(sec, i, f.key, Math.round($any($event.target).valueAsNumber))"
               class="tcv-field w-full min-w-0 px-1 py-0.5 text-right text-[11px] mono">
      }
      @case ('text') {
        <input [value]="row[f.key] ?? ''" (change)="set(sec, i, f.key, $any($event.target).value.trim())"
               class="tcv-field w-full min-w-0 px-1 py-0.5 text-[11px]">
      }
      @case ('choice') {
        <select (change)="set(sec, i, f.key, $any($event.target).value)"
                class="tcv-field w-full min-w-0 px-1 py-0.5 text-[11px]">
          @for (o of f.options ?? []; track o) {
            <option [value]="o" [selected]="row[f.key] === o">{{ o }}</option>
          }
        </select>
      }
      @case ('net') {
        <select (change)="set(sec, i, f.key, $any($event.target).value)"
                class="tcv-field mono w-full min-w-0 px-1 py-0.5 text-[11px]">
          <option value="" [selected]="!row[f.key]">pick a net</option>
          @for (n of nets(); track n) {
            <option [value]="n" [selected]="row[f.key] === n">{{ n }}</option>
          }
        </select>
      }
      @case ('layers') {
        <span class="flex gap-2 py-0.5 text-[11px]">
          @for (o of f.options ?? []; track o) {
            <span class="flex items-center gap-1">
              <input type="checkbox" [checked]="list(row, f.key).includes(o)"
                     (change)="toggle(sec, i, f.key, o, $any($event.target).checked)"
                     style="accent-color: var(--accent)">{{ o }}
            </span>
          }
        </span>
      }
      @case ('nets') {
        <span class="flex flex-wrap gap-1">
          @for (n of list(row, f.key); track n) {
            <span class="tcv-chip mono px-1.5 py-0">{{ n }}
              <button (click)="drop(sec, i, f.key, n); $event.preventDefault()"
                      style="color: var(--ink-dim)" title="take it out">×</button>
            </span>
          }
          @if (loose().length) {
            <select (change)="push(sec, i, f.key, $any($event.target).value); $any($event.target).value = ''"
                    class="tcv-field mono px-1 py-0 text-[10px]">
              <option value="">+ net</option>
              @for (n of loose(); track n) { <option [value]="n">{{ n }}</option> }
            </select>
          }
        </span>
      }
      @case ('patterns') {
        <span class="flex flex-wrap items-center gap-1">
          @for (n of list(row, f.key); track n) {
            <span class="tcv-chip mono px-1.5 py-0">{{ n }}
              <button (click)="drop(sec, i, f.key, n); $event.preventDefault()"
                      style="color: var(--ink-dim)" title="take it out">×</button>
            </span>
          }
          <input placeholder="usb_*  ⏎" (keydown.enter)="push(sec, i, f.key, $any($event.target).value.trim()); $any($event.target).value = ''"
                 class="tcv-field mono w-[5.5rem] px-1 py-0 text-[10px]">
        </span>
      }
    }
  </div>
</ng-template>`,
  imports: [NgTemplateOutlet],
})
export class RulesForm {
  rules = input.required<BoardRules>();
  schema = input.required<RuleSchema>();
  nets = input<string[]>([]);
  /** Who each class holds once patterns apply, as the server worked it out. */
  members = input<Record<string, string[]>>({});
  problems = input<string[]>([]);
  changed = output<BoardRules>();

  readonly Math = Math;

  sections = computed(() =>
    Object.entries(this.schema()).map(([key, s]) => ({ key, s })));

  /** Nets named in no class - the ones a class can still take. */
  loose = computed(() => {
    const named = new Set(this.rules().classes.flatMap(c => c.nets));
    return this.nets().filter(n => !named.has(n));
  });

  private data(): Record<string, unknown> {
    return this.rules() as unknown as Record<string, unknown>;
  }

  rowsOf(key: string): Row[] { return (this.data()[key] as Row[] | undefined) ?? []; }
  objOf(key: string): Row { return (this.data()[key] as Row | undefined) ?? {}; }
  list(row: Row, key: string): string[] { return (row[key] as string[] | undefined) ?? []; }

  titleField(s: RuleSchema[string]): RuleField | undefined {
    return s.fields.find(f => f.key === 'name');
  }
  bodyFields(s: RuleSchema[string]): RuleField[] {
    return s.fields.filter(f => f.key !== 'name');
  }
  isFixed(s: RuleSchema[string], row: Row): boolean {
    return !!s.fixed?.includes(row['name'] as string);
  }
  wide(f: RuleField): boolean {
    return ['nets', 'patterns', 'layers', 'net', 'choice'].includes(f.type);
  }

  caught(row: Row): string[] {
    return this.members()[row['name'] as string] ?? [];
  }

  /** The server's problems, put by the row they are about. */
  problemsOf(sec: string, row: Row | null, i: number | null): string[] {
    const id = row == null ? null
      : (sec === 'pours' ? (row['net'] as string) : (row['name'] as string)) || `#${(i ?? 0) + 1}`;
    const head = id == null ? sec : `${sec}.${id}`;
    return this.problems()
      .filter(p => p.startsWith(head + '.') || p.startsWith(head + ':'))
      .map(p => p.slice(p.indexOf(':') + 1).trim());
  }

  // ---- changes: each one a fresh copy handed up ----

  private edit(change: (r: Record<string, unknown>) => void) {
    const next = JSON.parse(JSON.stringify(this.rules())) as Record<string, unknown>;
    change(next);
    this.changed.emit(next as unknown as BoardRules);
  }

  private target(r: Record<string, unknown>, sec: string, i: number | null): Row {
    return i == null ? (r[sec] as Row) : (r[sec] as Row[])[i];
  }

  set(sec: string, i: number | null, key: string, value: unknown) {
    if (typeof value === 'number' && Number.isNaN(value)) return;
    this.edit(r => {
      this.target(r, sec, i)[key] = value;
    });
  }

  toggle(sec: string, i: number | null, key: string, option: string, on: boolean) {
    this.edit(r => {
      const row = this.target(r, sec, i);
      const now = new Set((row[key] as string[]) ?? []);
      if (on) now.add(option); else now.delete(option);
      const order = (this.schema()[sec].fields.find(f => f.key === key)?.options ?? []);
      row[key] = order.filter(o => now.has(o));
    });
  }

  push(sec: string, i: number | null, key: string, value: string) {
    if (!value) return;
    this.edit(r => {
      const row = this.target(r, sec, i);
      const now = (row[key] as string[]) ?? [];
      if (!now.includes(value)) row[key] = [...now, value];
    });
  }

  drop(sec: string, i: number | null, key: string, value: string) {
    this.edit(r => {
      const row = this.target(r, sec, i);
      row[key] = ((row[key] as string[]) ?? []).filter(v => v !== value);
    });
  }

  add(sec: string) {
    const fresh = this.schema()[sec].new ?? {};
    this.edit(r => { r[sec] = [...((r[sec] as Row[]) ?? []), JSON.parse(JSON.stringify(fresh))]; });
  }

  remove(sec: string, i: number) {
    this.edit(r => { (r[sec] as Row[]).splice(i, 1); });
  }
}
