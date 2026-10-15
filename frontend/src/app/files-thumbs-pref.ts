import { signal } from '@angular/core';

/** Whether the Files tab shows small pictures of its files - a picture's,
 *  a PDF's first page, an STL's or a STEP's model - at the start of a list
 *  row and on the grid's tiles, or only the kind's icon. Chosen in
 *  Settings > Appearance under Files; kept per browser (`redline.files.thumbs`).
 *  Off, the page asks the server for no picture at all. */

const KEY = 'redline.files.thumbs';

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

export const FILE_THUMBS = signal<boolean>(read());

export function setFileThumbs(on: boolean) {
  FILE_THUMBS.set(on);
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch { /* private window */ }
}
