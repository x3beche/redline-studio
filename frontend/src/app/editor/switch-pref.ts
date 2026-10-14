/** How one model gives way to the next in the 3D room, picked in Settings >
 *  Appearance and kept in this browser like the theme. A switch blocks the
 *  page while the new geometry is parsed and built; without a transition the
 *  old model sat there, then vanished and the new one popped in. */
export const SWITCHES = ['none', 'fade', 'fade-scale', 'glide', 'fade-glide', 'stagger'] as const;
export type ModelSwitch = (typeof SWITCHES)[number];
export const SWITCH_DEFAULT: ModelSwitch = 'fade-glide';
/** Name and a line on what it does, for the Settings card. */
export const SWITCH_INFO: Record<ModelSwitch, { name: string; about: string }> = {
  'none': { name: 'None', about: 'The new model replaces the old one at once.' },
  'fade': { name: 'Fade', about: 'The old model dims while the new one loads, then it fades in.' },
  'fade-scale': { name: 'Fade and scale', about: 'As Fade, and the new model grows into place.' },
  'glide': { name: 'Camera glide', about: 'The camera moves from the old view to the new one.' },
  'fade-glide': { name: 'Fade and glide', about: 'Fade, with the camera gliding to the new view.' },
  'stagger': { name: 'Parts in turn', about: 'The parts appear one after another; large models fade.' },
};
const KEY = 'redline.modelSwitch';

export function currentSwitch(): ModelSwitch {
  let s: string | null = null;
  try { s = localStorage.getItem(KEY); } catch { /* private window */ }
  return (SWITCHES as readonly string[]).includes(s ?? '') ? s as ModelSwitch : SWITCH_DEFAULT;
}

export function setSwitch(s: ModelSwitch): ModelSwitch {
  try {
    if (s === SWITCH_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, s);
  } catch { /* private window: this page only */ }
  return s;
}

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
