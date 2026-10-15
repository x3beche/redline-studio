/** The top bar's order, as plain functions over ids (topbar.ts keeps it,
 *  Settings > Top bar changes it). No imports: the tests run this file in
 *  node (tests/test_topbar.py). */

/** The movable gap: the tabs after it stand at the right, as Notes, Chat,
 *  Files and Basic Tools always have. One more item in the order. */
export const GAP = 'gap';
/** Where the More button stands. One more item in the order; never hidden. */
export const MORE = 'more';
/** The notification bell (notifications.ts) and Settings: items like the
 *  rooms' tabs - moved, hidden - that stand after More by default, at the
 *  far right, as they did before they could be arranged. */
export const BELL = 'notifications';
export const SETTINGS = 'settings';
/** After More, in this order, unless moved. */
const ENDS = [BELL, SETTINGS];
/** Off until switched on: the wiki, which stood under More alone before it
 *  could be a tab - so nothing changes for anyone until they turn it on. */
export const OFF_BY_DEFAULT: readonly string[] = ['wiki'];

/** The default: the rooms you work in, the gap, Notes and the rest, More,
 *  then the bell and Settings - the bar as it was before it could be
 *  arranged. `rooms` are the tab ids in the app's order, the ends left out. */
export function defaultOrder(rooms: readonly string[]): string[] {
  const ids = rooms.filter(id => !ENDS.includes(id));
  const at = ids.indexOf('notes');
  ids.splice(at < 0 ? ids.length : at, 0, GAP);
  ids.push(MORE, ...ENDS);
  return ids;
}

/** A kept order made whole: ids the app no longer has are dropped, and
 *  every id it has that the order lacks goes in after its nearest default
 *  predecessor (or first, when it has none). */
export function resolveOrder(saved: readonly unknown[] | null | undefined, def: readonly string[]): string[] {
  const known = new Set(def);
  const out: string[] = [];
  for (const id of saved ?? []) if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
  def.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(def[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, id);
  });
  return out;
}

/** An order kept by an older version, brought up to date before it is made
 *  whole: kept before More could move, More goes at the end, where it
 *  stood; kept before the bell and Settings were in it, they go at the very
 *  end, where they always stood - wherever More was put. */
export function migrateOrder(saved: readonly unknown[] | null | undefined, def: readonly string[]): string[] {
  if (!saved) return resolveOrder(null, def);
  const list = [...saved];
  if (!list.includes(MORE)) list.push(MORE);
  for (const id of ENDS) if (!list.includes(id)) list.push(id);
  return resolveOrder(list, def);
}

/** The hidden ids kept, brought up to date: with no order kept, the
 *  default (OFF_BY_DEFAULT); with an order kept before an off-by-default
 *  item was in it, that item hidden, as it was then. */
export function migrateHidden(savedOrder: readonly unknown[] | null | undefined,
                              savedHidden: readonly unknown[] | null | undefined): string[] {
  if (!savedOrder) return [...OFF_BY_DEFAULT];
  const out = (savedHidden ?? []).filter((x): x is string => typeof x === 'string');
  for (const id of OFF_BY_DEFAULT) if (!savedOrder.includes(id) && !out.includes(id)) out.push(id);
  return out;
}

/** Which shown items go under More first when the bar is short of room:
 *  those before More, from the one nearest it back, then those after it,
 *  from the last back - so what stands after More (the bell and Settings,
 *  by default) stays in the bar longest. `order` is the whole order, the
 *  gap and More included; `shown` the ids of the items drawn in the bar. */
export function dropOrder(order: readonly string[], shown: readonly string[]): string[] {
  const m = order.indexOf(MORE);
  const pos = (id: string) => order.indexOf(id);
  const before = shown.filter(id => m < 0 || pos(id) < m).reverse();
  const after = shown.filter(id => m >= 0 && pos(id) > m).reverse();
  return [...before, ...after];
}
