// Lucide-style line icons on a 24 px grid (the app draws its own the same way:
// preferences.ts, 1.75 px strokes). <i data-i="name"></i> becomes the svg.
const ICONS = {
  pen: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12',
  cpu: 'M5 5h14v14H5zM9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3',
  chip: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  server: 'M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  usb: 'M12 2v14M12 22a2 2 0 1 0 0-4a2 2 0 1 0 0 4M12 13l-4-3V7M8 7h.01M12 15l4-3V8M15 5h2v3h-2z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  theme: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 8h6M12 12h9M12 16h6',
  lang: 'M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
  keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  key: 'M15.5 7.5l2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4M21 2l-9.6 9.6M7.5 10a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  chart: 'M3 3v18h18M7 16v-4M12 16V8M17 16v-7',
  tree: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a3 3 0 0 0 3 3h4',
  refresh: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3a1.5 1.5 0 1 0 0 3M21 15l-5-5L5 21',
  bot: 'M12 8V4H8M4 8h16v12H4zM2 14h2M20 14h2M15 13v2M9 13v2',
  sparkle: 'M12 3l1.9 5.8L20 10.7l-5.8 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9zM19 3v4M17 5h4',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
  board: 'M3 4h18v16H3zM7 8h3v3H7zM14 8h3M14 12h3M7 15h10M10 9.5h4',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  question: 'M12 22a10 10 0 1 0 0-20a10 10 0 1 0 0 20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  ruler: 'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0zM14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2',
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6',
  search: 'M11 19a8 8 0 1 0 0-16a8 8 0 1 0 0 16M21 21l-4.3-4.3',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  drawing: 'M3 3h18v18H3zM3 9h18M9 21V9M13 13h5M13 17h3',
  home: 'M3 10.5 12 3l9 7.5V21H3zM9 21v-7h6v7',
};
for (const el of document.querySelectorAll('i[data-i]')) {
  const d = ICONS[el.dataset.i];
  if (!d) { console.error('no icon', el.dataset.i); continue; }
  el.outerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
}
// <div class="dots" data-cols="24" data-rows="8" data-on="..."> - a dot matrix
for (const el of document.querySelectorAll('.dots[data-cols]')) {
  const cols = +el.dataset.cols, rows = +el.dataset.rows, pal = (el.dataset.pal || 'on').split(',');
  const fill = +(el.dataset.fill || 0.5), seed0 = +(el.dataset.seed || 7);
  let seed = seed0; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  el.style.gridTemplateColumns = `repeat(${cols}, ${el.dataset.size || 6}px)`;
  let html = '';
  for (let i = 0; i < cols * rows; i++) {
    const on = rnd() < fill;
    html += `<i class="${on ? pal[Math.floor(rnd() * pal.length)] : ''}"></i>`;
  }
  el.innerHTML = html;
  if (el.dataset.size) el.querySelectorAll('i').forEach(i => { i.style.width = i.style.height = el.dataset.size + 'px'; });
}
