// Agent Queue Inspector: what is queued for the agents, how long it has
// waited, what each room is running, how its runs have gone, and - when a
// run has gone quiet - the step it is stuck on.
//
// It reads one snapshot of the app (taken by the view, or pasted):
//   at        when the snapshot was taken (the "now" for every age; run()
//             never reads the clock, so the same snapshot gives the same answer)
//   queue     queued notes: id, kind (room), summary, queued_at / created_at
//   runs      {room: {status, percent, title, started_at, finished_at}}
//   activity  {room: [{at, text, level}]} - the room's log, oldest first
//   revisions optional: id, kind, status - for the applied/rejected rate
// Definitions:
//   stuck     a run whose status is running and whose last log line is older
//             than the threshold; the stuck step is that last line
//   waiting   notes queued for a room that is not running, for longer than
//             the threshold: nobody picked them up
//   run time  from a "started: ..." log line to the next "finished: <status>"
//   success   runs finished "done" / all finished runs (from the log), and
//             notes applied / (applied + rejected)

const ROOMS = ['cad', 'pcb', 'web', 'embedded', 'mobile'];
const OK = new Set(['done', 'ok', 'success', 'succeeded', 'applied', 'passed']);
const norm = (s) => String(s ?? '').trim();
const ms = (iso) => { const t = Date.parse(norm(iso)); return Number.isFinite(t) ? t : null; };

/** Seconds -> "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
function dur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clock = (t) => (t == null ? '–' : new Date(t).toISOString().slice(5, 16).replace('T', ' '));

export function run({ snapshot, stuck, room }) {
  const warnings = [];
  let snap;
  try { snap = JSON.parse(norm(snapshot) || 'null'); } catch (e) {
    return { warnings: [`The snapshot is not JSON (${e.message}). In the app press Refresh; elsewhere paste {at, queue, runs, activity}.`] };
  }
  if (!snap || typeof snap !== 'object') return { warnings: ['No snapshot yet. In the app press Refresh; elsewhere paste {at, queue, runs, activity} as JSON.'] };
  const limit = Number.isFinite(stuck) && stuck > 0 ? stuck : 20;
  if (!(stuck > 0)) warnings.push('The stuck threshold must be above 0 minutes; 20 min is used.');

  const queue = Array.isArray(snap.queue) ? snap.queue : [];
  const runs = snap.runs && typeof snap.runs === 'object' ? snap.runs : {};
  const activity = snap.activity && typeof snap.activity === 'object' ? snap.activity : {};
  const revisions = Array.isArray(snap.revisions) ? snap.revisions : [];

  // "Now" is the snapshot's time; without one, the newest time in it.
  let now = ms(snap.at);
  if (now == null) {
    const all = [...queue.flatMap((q) => [ms(q.queued_at), ms(q.created_at)]), ...Object.values(runs).flatMap((r) => [ms(r?.started_at), ms(r?.finished_at)]),
      ...Object.values(activity).flatMap((l) => (Array.isArray(l) ? l.map((x) => ms(x?.at)) : []))].filter((x) => x != null);
    now = all.length ? Math.max(...all) : null;
    warnings.push(now == null ? 'The snapshot has no times at all: ages cannot be worked out.' : 'The snapshot has no "at" time: ages are measured from its newest entry, so they read low.');
  }
  const age = (t) => (now == null || t == null ? null : (now - t) / 1000);
  // A run's time: start to finish, or to now while it runs.
  const runTime = (r) => { const a = ms(r.started_at), b = ms(r.finished_at) ?? now; return a == null || b == null ? null : (b - a) / 1000; };

  const names = [...new Set([...ROOMS, ...Object.keys(runs), ...Object.keys(activity), ...queue.map((q) => norm(q.kind) || 'cad')])];
  const want = room && room !== 'all' ? room : null;
  const rows = [], stuckRows = [], history = [];
  let running = 0, stuckCount = 0, waitingRooms = 0, doneAll = 0, finishedAll = 0;
  const durations = [];

  for (const name of names) {
    if (want && name !== want) continue;
    const q = queue.filter((x) => (norm(x.kind) || 'cad') === name);
    const waits = q.map((x) => age(ms(x.queued_at) ?? ms(x.created_at))).filter((x) => x != null);
    const r = runs[name] && typeof runs[name] === 'object' ? runs[name] : null;
    const log = (Array.isArray(activity[name]) ? activity[name] : []).filter((x) => x && ms(x.at) != null)
      .sort((a, b) => ms(a.at) - ms(b.at));
    const lastLine = log.at(-1) || null;
    const idle = lastLine ? age(ms(lastLine.at)) : null;

    // Runs from the log: "started: X" ... "finished: status".
    let open = null;
    const mine = [];
    for (const l of log) {
      const t = norm(l.text);
      if (/^started\b/i.test(t)) open = { at: ms(l.at), title: t.replace(/^started:?\s*/i, '') };
      else if (/^finished\b/i.test(t)) {
        const status = (t.replace(/^finished:?\s*/i, '').split(/\s/)[0] || 'done').toLowerCase();
        const one = { room: name, start: open ? open.at : null, end: ms(l.at), status, title: open ? open.title : '(start not in the log)' };
        mine.push(one); open = null;
      }
    }
    const finished = mine.length, ok = mine.filter((x) => OK.has(x.status)).length;
    doneAll += ok; finishedAll += finished;
    for (const x of mine) if (x.start != null) durations.push((x.end - x.start) / 1000);
    history.push(...mine);
    const errors = log.filter((l) => l.level === 'error').length;

    const revs = revisions.filter((x) => (norm(x.kind) || 'cad') === name);
    const applied = revs.filter((x) => x.status === 'applied').length, rejected = revs.filter((x) => x.status === 'rejected').length;

    // State of the room.
    const isRunning = r && norm(r.status) === 'running';
    let state = 'idle';
    if (isRunning) {
      running++;
      const since = age(ms(r.started_at));
      const quiet = idle ?? since;
      if (quiet != null && quiet > limit * 60) {
        state = 'stuck'; stuckCount++;
        const step = [...log].reverse().find((l) => l.level === 'work' || l.level === 'info') || lastLine;
        stuckRows.push([name, dur(quiet), step ? short(norm(step.text), 120) : 'no log line since the run started', step ? step.level || '–' : '–', short(norm(r.title) || '–', 60)]);
      } else state = 'running';
    } else if (q.length && waits.length && Math.max(...waits) > limit * 60) { state = 'waiting'; waitingRooms++; }
    else if (q.length) state = 'queued';
    if (r && /fail|error/i.test(norm(r.status))) state = state === 'idle' ? 'last run failed' : state;

    if (!q.length && !r && !log.length && !revs.length) continue;      // a room nobody used
    rows.push([
      name, q.length, waits.length ? dur(Math.max(...waits)) : '–',
      r ? `${norm(r.status) || '?'}${isRunning && Number.isFinite(Number(r.percent)) ? ` ${Math.round(Number(r.percent))} %` : ''}` : '–',
      r ? dur(runTime(r)) : '–',
      idle != null ? `${dur(idle)} ago` : '–',
      finished ? `${ok}/${finished}` : '–',
      errors,
      applied + rejected ? `${Math.round((100 * applied) / (applied + rejected))} %` : '–',
      state,
    ]);
  }
  const qShown = queue.filter((x) => !want || (norm(x.kind) || 'cad') === want)
    .map((x) => ({ x, w: age(ms(x.queued_at) ?? ms(x.created_at)) }))
    .sort((a, b) => (b.w ?? -1) - (a.w ?? -1));
  if (stuckCount) warnings.push(`${stuckCount === 1 ? 'A run has' : `${stuckCount} runs have`} logged nothing for over ${limit} min: ${stuckRows.map((r) => `${r[0]} at "${short(r[2], 60)}"`).join('; ')}. Check that room's agent - it may be waiting on a prompt, a lock or a crashed tool.`);
  if (waitingRooms) warnings.push(`Notes have waited over ${limit} min in ${waitingRooms === 1 ? 'a room' : `${waitingRooms} rooms`} with no run going: the room's agent is not picking up its queue - start it or check its worker.`);

  const tables = [{
    title: 'Rooms',
    columns: ['Room', 'Queued', 'Oldest wait', 'Run', 'Run time', 'Last log', 'Runs ok', 'Error lines', 'Notes applied', 'State'],
    rows,
  }];
  if (stuckRows.length) tables.unshift({ title: 'Stuck runs - the step they stopped at', columns: ['Room', 'Quiet for', 'Last step', 'Level', 'Run'], rows: stuckRows });
  tables.push(qShown.length
    ? { title: 'Queue, longest waiting first', columns: ['Room', 'Waiting', 'Note', 'ID'], rows: qShown.map(({ x, w }) => [norm(x.kind) || 'cad', dur(w), short(norm(x.summary) || norm(x.comment) || '–', 80), norm(x.id ?? x._id) || '–']) }
    : { title: 'Queue', columns: ['State'], rows: [['Nothing is queued.']] });
  const recent = history.filter((h) => h.end != null).sort((a, b) => b.end - a.end).slice(0, 12);
  if (recent.length) tables.push({ title: 'Recent runs (from the logs)', columns: ['Room', 'Finished', 'Took', 'Outcome', 'Run'], rows: recent.map((h) => [h.room, clock(h.end), h.start != null ? dur((h.end - h.start) / 1000) : '–', h.status, short(h.title, 70)]) });

  const byRoom = rows.map((r) => r[0]);
  const charts = byRoom.length ? [{
    title: 'Runs per room (from the logs)', type: 'bars', x: byRoom,
    series: [
      { name: 'finished ok', y: byRoom.map((n) => history.filter((h) => h.room === n && OK.has(h.status)).length) },
      { name: 'finished otherwise', y: byRoom.map((n) => history.filter((h) => h.room === n && !OK.has(h.status)).length) },
      { name: 'queued now', y: rows.map((r) => r[1]) },
    ],
  }] : [];

  const oldest = qShown.length ? qShown[0].w : null;
  return {
    values: [
      { label: 'Queued', value: qShown.length, hint: qShown.length ? `oldest ${dur(oldest)}` : 'nothing waiting' },
      { label: 'Running', value: running, hint: running ? rows.filter((r) => r[9] === 'running' || r[9] === 'stuck').map((r) => r[0]).join(', ') : 'no room busy' },
      { label: 'Stuck', value: stuckCount, tone: stuckCount ? 'bad' : 'ok', hint: `quiet > ${limit} min` },
      { label: 'Runs ok', value: finishedAll ? `${Math.round((100 * doneAll) / finishedAll)} %` : '–', hint: `${doneAll} of ${finishedAll} in the logs`, tone: finishedAll && doneAll < finishedAll ? 'warn' : undefined },
      { label: 'Median run', value: dur(median(durations)), hint: durations.length ? `${durations.length} runs timed` : 'no start/finish pairs' },
      { label: 'Snapshot', value: now == null ? '–' : clock(now), hint: 'UTC' },
    ],
    charts,
    tables,
    warnings,
    notes: [
      `Stuck = a running run whose last log line is older than ${limit} min; the last work line is the step it stopped at.`,
      'Run times and outcomes come from "started:" and "finished:" lines in each room\'s log, so they cover only the lines in the snapshot.',
    ],
  };
}
