import { PrefsTab } from './preferences';
import { t } from './i18n';

/** Settings' search (settings-room.ts, and Ctrl+K in palette.ts): what each
 *  section holds, by the words its panels show - card titles and the
 *  labels of the settings in them, in English, as the panels write them
 *  (`'…' | t`). A query matches a section's own name and blurb or one of
 *  these, in English or in its Turkish (i18n.ts), with Turkish letters
 *  folded so "gorunum" finds "Görünüm". Picking a hit opens the section
 *  and `reveal` finds the label on screen, scrolls to it and marks it for
 *  a moment by weight and ink. */
export const SETTINGS_INDEX: Record<PrefsTab, string[]> = {
  profile: ['Display name', 'Email', 'Colour', 'Password', 'Change password', 'Current password', 'New password',
            'Sessions', 'Sign out other sessions', 'Role'],
  mobile: ['Workbench for Android', 'Download the APK', 'Server address to enter in the app', 'Install', 'Updating',
           'From 1.2.0 or older', 'Not from the Play Store', 'Upload a new build', 'Version', 'Scan with the phone\'s camera to download'],
  shares: ['Shared', 'Last opened', 'Times opened', 'Until', 'Turn off', 'Show ended links'],
  notifications: ['Notify me when', 'A toast when one comes', 'Telegram', 'An agent asks a question', 'An agent replies',
                  'A note is applied or fails', 'A run starts', 'A scheduled task reports', 'A build fails',
                  'A long build is done', 'A board is routed', 'A firmware build ends', 'A technical drawing is made',
                  'A release is ready', 'Part bodies', 'A part joins the drawer', 'A price drops', 'Budget warnings',
                  'Command Code usage', 'Server health'],
  appearance: ['Now wearing', 'Theme', 'Font', 'Model switch', 'Toolbar icons', 'Pack', 'Size', 'Model tree', 'Rows',
               'Guide lines', 'Counts', 'Colour dots', '3D grid', 'Grid', 'Strength', 'Numbers', 'Axes', 'Dark', 'Light',
               'Custom themes'],
  language: ['Language', 'Voice to text', 'Microphone button', 'I speak'],
  topbar: ['Preview', 'Display', 'Tabs', 'Shown', 'Under More', 'Reset to default'],
  shortcuts: ['Find a shortcut', 'Anywhere', 'In the code', 'In Notes', 'In Taste', 'In Chat'],
  llm: ['API keys', 'API key', 'Add a key', 'Which model does what', 'Usage', 'Spend by job', 'Spend by model',
        'Latest calls', 'OpenRouter account', 'Card summaries', 'Chat titles', 'Chat titles: first naming',
        'Chat titles: renaming', 'English translation', 'Tool pages', 'Tool finder',
        'Reading translation', 'Chat room', 'Part category', 'Taste extraction', 'Manufacturer exploration',
        'Next-question suggestion', 'Chat example questions', 'Read a file\'s text (OCR)', 'Voice to text'],
  proxy: ['Route order', 'Proxy', 'Connection', 'Username', 'Password', 'Port', 'Rotation', 'Where it comes out', 'Exits',
          'Health check', 'Lookups', 'Price per GB', 'Jina AI', 'McMaster-Carr'],
  costs: ['Where a month goes', 'LLM plans against the API', 'Display currency', 'Billed in', 'Exchange rates', 'Budgets',
          'Subscriptions', 'Prices of what is used', 'Other recurring costs'],
  telegram: ['Set up the bot', 'Public address', 'Your Telegram', 'Questions in', 'Your code', 'In the chat',
             'Notify me when', 'Digest', 'Recent traffic', 'Remove the bot'],
  tokens: ['Set up your agent', 'New token', 'Tokens', 'Usage'],
  dashboard: ['Activity', 'By person', 'Sign-ins by person', 'Most active projects', 'Spend by model', 'The trail'],
  admin: ['Add user', 'Users', 'Access', 'Reset password', 'Delete user'],
  rustdesk: ['Connect'],
  backups: ['Archives', 'Restore check', 'Weekly restore check', 'Dump log', 'Disk', 'Secret key'],
};

/** Each section's name as the Settings list shows it (settings-room.ts nav),
 *  for Ctrl+K's lines; `admin` ones only for the owner and the admins. */
export const SECTION_NAMES: { id: PrefsTab; label: string; admin?: boolean }[] = [
  { id: 'profile', label: 'Profile' }, { id: 'shares', label: 'Shared links' }, { id: 'notifications', label: 'Notifications' },
  { id: 'mobile', label: 'Mobile app' },
  { id: 'appearance', label: 'Appearance' }, { id: 'language', label: 'Language' }, { id: 'topbar', label: 'Top bar' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' }, { id: 'llm', label: 'LLM settings' }, { id: 'proxy', label: 'Proxy & Data' },
  { id: 'costs', label: 'Costs & currency' }, { id: 'telegram', label: 'Telegram' }, { id: 'tokens', label: 'Agent tokens' },
  { id: 'dashboard', label: 'Dashboard', admin: true }, { id: 'admin', label: 'Users', admin: true },
  { id: 'rustdesk', label: 'RustDesk', admin: true }, { id: 'backups', label: 'Backups', admin: true },
];

/** Lower case with the Turkish letters folded to their plain ones. */
export function fold(s: string): string {
  return s.toLocaleLowerCase('tr').replace(/[çğıöşüâî]/g, c => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i' } as Record<string, string>)[c]);
}

/** Every word of the query somewhere in the text (either language). */
export function matches(words: string[], ...texts: string[]): boolean {
  const hay = fold(texts.flatMap(x => [x, t(x)]).join(' '));
  return words.every(w => hay.includes(w));
}

export function queryWords(q: string): string[] { return fold(q).split(/\s+/).filter(Boolean); }

/** The labels of a section that match, best first: those starting with the query. */
export function hitsIn(id: PrefsTab, words: string[]): string[] {
  const first = words[0] ?? '';
  return SETTINGS_INDEX[id].filter(l => matches(words, l))
    .sort((a, b) => Number(!fold(t(a)).startsWith(first) && !fold(a).startsWith(first))
                  - Number(!fold(t(b)).startsWith(first) && !fold(b).startsWith(first)));
}

/** Find `label` (as it reads now) inside `stage`, waiting up to ~3 s for a
 *  deferred panel to come; scroll it into view and mark it by weight and
 *  ink for a moment. Inline style, as the label lives in another
 *  component's encapsulated styles. */
export function reveal(stage: HTMLElement, label: string) {
  const want = [fold(t(label)), fold(label)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  const look = () => {
    const el = find(stage, want);
    if (!el) { if (performance.now() - t0 < 3000) requestAnimationFrame(look); return; }
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    const was = { w: el.style.fontWeight, c: el.style.color };
    el.style.fontWeight = '650';
    el.style.color = 'var(--ink-bright)';
    el.setAttribute('data-found', '');
    setTimeout(() => { el.style.fontWeight = was.w; el.style.color = was.c; el.removeAttribute('data-found'); }, 2400);
  };
  requestAnimationFrame(look);
}

/** The smallest visible element whose own text is the label (or starts with it). */
function find(stage: HTMLElement, want: string[]): HTMLElement | null {
  let best: HTMLElement | null = null, bestScore = 0;
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = fold((n.textContent ?? '').trim());
    if (!text) continue;
    const exact = want.includes(text), starts = !exact && want.some(w => w && text.startsWith(w));
    if (!exact && !starts) continue;
    const el = n.parentElement;
    if (!el || !el.getClientRects().length) continue;
    const score = (exact ? 2 : 1) + (/^H\d$/.test(el.tagName) ? 1 : 0);
    if (score > bestScore) { best = el; bestScore = score; if (score >= 3) break; }
  }
  return best;
}
