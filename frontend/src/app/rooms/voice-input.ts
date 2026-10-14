import { Component, ElementRef, Injectable, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { T, t } from '../i18n';
import { Toast } from '../toast';

/** Voice to text in a composer: the microphone beside the paperclip.
 *
 *  A click (or Alt+M) records in the browser (MediaRecorder); the elapsed
 *  time and a stop button show where the button was, and Esc throws the
 *  recording away. Stopped, it is sent to POST /api/voice/transcribe
 *  (backend/voice.py, the "Voice to text" job in Settings > LLM settings),
 *  and the words come back INTO the box, where they are read and changed
 *  before anything is sent - nothing goes on by itself. Used by the Chat's
 *  composer, the rooms' agent threads and the Notes' box (a voice note).
 *
 *  The microphone needs a secure page (the live site is https) and the
 *  person's leave; a refusal is said in words. Settings > Language keeps,
 *  for this browser, whether the button shows and what language is
 *  expected (VoicePrefs). */

export type VoiceLang = 'auto' | 'tr' | 'en';
export type VoiceState = 'idle' | 'ask' | 'rec' | 'up';
export interface VoiceResult { text: string; language: string; model: string; seconds: number }

const KEY = 'redline.voice';
/** The server's limit (backend/voice.py MAX_SECONDS): stopped and sent at it. */
export const VOICE_MAX_S = 300;
const MIN_S = 0.5;
export const MIC = 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5.5 11a6.5 6.5 0 0 0 13 0 M12 17.5V21 M9 21h6';

/** This browser's choices: the button on or off, and the language expected. */
@Injectable({ providedIn: 'root' })
export class VoicePrefs {
  on = signal(true);
  lang = signal<VoiceLang>('auto');

  constructor() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (typeof v.on === 'boolean') this.on.set(v.on);
      if (v.lang === 'tr' || v.lang === 'en' || v.lang === 'auto') this.lang.set(v.lang);
    } catch { /* the defaults */ }
  }

  set(p: { on?: boolean; lang?: VoiceLang }) {
    if (p.on != null) this.on.set(p.on);
    if (p.lang) this.lang.set(p.lang);
    try { localStorage.setItem(KEY, JSON.stringify({ on: this.on(), lang: this.lang() })); } catch { /* kept for the session */ }
  }
}

/** The recorders on the page, for the keys: Alt+M starts the one whose
 *  composer has the cursor (else the last one shown), stops the one
 *  recording; Esc throws a recording away. */
const LIVE = new Set<VoiceInput>();
let keysOn = false;
function keys() {
  if (keysOn) return;
  keysOn = true;
  window.addEventListener('keydown', e => {
    const going = [...LIVE].find(v => v.state() === 'rec' || v.state() === 'ask');
    if (e.key === 'Escape' && going) {
      e.preventDefault(); e.stopImmediatePropagation();
      going.cancel();
      return;
    }
    if (!(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyM')) return;
    if (going) { e.preventDefault(); going.stop(); return; }
    const shown = [...LIVE].filter(v => v.shown());
    const here = shown.find(v => v.box()?.contains(document.activeElement)) ?? shown.at(-1);
    if (!here || here.state() !== 'idle') return;
    e.preventDefault();
    void here.start();
  }, true);
}

/** One composer's microphone. `write` puts the words in its box. */
export class VoiceInput {
  state = signal<VoiceState>('idle');
  /** Seconds recorded so far. */
  elapsed = signal(0);
  /** The composer it sits in, for the keys (set by <rl-mic>). */
  box = signal<HTMLElement | null>(null);
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private keep = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  private sub: Subscription | null = null;

  constructor(private http: HttpClient, readonly prefs: VoicePrefs, private purpose: 'chat' | 'note',
              private write: (text: string) => void) {}

  attach(box: HTMLElement | null) { this.box.set(box); LIVE.add(this); keys(); }
  detach() { this.cancel(); this.sub?.unsubscribe(); this.sub = null; LIVE.delete(this); if (this.state() === 'up') this.state.set('idle'); }
  shown() { const b = this.box(); return !!b && b.isConnected && !!b.offsetParent && this.prefs.on(); }

  toggle() { if (this.state() === 'rec') this.stop(); else if (this.state() === 'idle') void this.start(); }

  async start() {
    if (this.state() !== 'idle') return;
    for (const v of LIVE) if (v !== this && (v.state() === 'rec' || v.state() === 'ask')) v.cancel();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return this.fail(t('The microphone works only on a secure (https) page.'));
    }
    if (typeof MediaRecorder === 'undefined') return this.fail(t('This browser cannot record audio.'));
    this.state.set('ask');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      this.state.set('idle');
      const name = (e as DOMException)?.name;
      return this.fail(name === 'NotAllowedError' || name === 'SecurityError'
        ? t('Microphone access was refused. Allow it for this site in the browser (the icon by the address), then try again.')
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? t('No microphone was found.')
        : name === 'NotReadableError' ? t('The microphone is in use by another app.')
        : t('The microphone could not be opened.'));
    }
    if (this.state() !== 'ask') { stream.getTracks().forEach(x => x.stop()); return; }   // cancelled while asked
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
      .find(m => MediaRecorder.isTypeSupported?.(m)) ?? '';
    try {
      this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch {
      stream.getTracks().forEach(x => x.stop());
      this.state.set('idle');
      return this.fail(t('This browser cannot record audio.'));
    }
    this.stream = stream;
    this.chunks = [];
    this.keep = false;
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this.stopped();
    this.rec.start(1000);
    this.t0 = performance.now();
    this.elapsed.set(0);
    this.timer = setInterval(() => {
      const s = (performance.now() - this.t0) / 1000;
      this.elapsed.set(s);
      if (s >= VOICE_MAX_S) this.stop();
    }, 250);
    this.state.set('rec');
  }

  /** Stop, and write it out. */
  stop() {
    if (this.state() !== 'rec' || !this.rec) return;
    this.keep = true;
    this.elapsed.set((performance.now() - this.t0) / 1000);
    this.rec.stop();
  }

  /** Stop, and throw it away. */
  cancel() {
    if (this.state() === 'ask') { this.state.set('idle'); return; }
    if (this.state() !== 'rec' || !this.rec) return;
    this.keep = false;
    this.rec.stop();
  }

  private stopped() {
    const rec = this.rec!;
    this.stream?.getTracks().forEach(x => x.stop());
    this.stream = null;
    this.rec = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.keep) { this.state.set('idle'); return; }
    if (this.elapsed() < MIN_S) { this.state.set('idle'); Toast.show(t('Too short - hold on a moment longer.')); return; }
    const type = rec.mimeType || this.chunks[0]?.type || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    this.send(new Blob(this.chunks, { type }), `voice.${ext}`);
  }

  private send(blob: Blob, name: string) {
    this.state.set('up');
    const fd = new FormData();
    fd.append('audio', blob, name);
    fd.append('lang', this.prefs.lang());
    fd.append('purpose', this.purpose);
    this.sub = this.http.post<VoiceResult>('/api/voice/transcribe', fd).subscribe({
      next: r => {
        this.state.set('idle');
        if (r.text.trim()) this.write(r.text.trim());
        else Toast.show(t('Nothing was heard in that recording.'));
      },
      error: (e: HttpErrorResponse) => {
        this.state.set('idle');
        const why = typeof e.error?.detail === 'string' ? e.error.detail
          : e.status === 413 ? t('the recording is too big') : t('the server did not answer');
        this.fail(`${t('Voice to text failed')}: ${why}`);
      },
    });
  }

  private fail(text: string) { Toast.show(text, { tone: 'danger', ms: 7000 }); }
}

/** Joins the words to what the box already holds. */
export function withWords(cur: string, words: string): string {
  if (!cur.trim()) return words;
  return cur + (/\s$/.test(cur) ? '' : ' ') + words;
}

/** The microphone button, and in its place while recording: a small red
 *  dot, the time, stop and cancel; then "Transcribing…". One row, as wide
 *  as it needs to be. */
@Component({
  selector: 'rl-mic',
  imports: [T],
  template: `
@if (v().prefs.on()) {
  @switch (v().state()) {
    @case ('rec') {
      <span class="tcv-voice-rec" role="status" [attr.aria-label]="('Recording' | t) + ' ' + time()">
        <i class="tcv-voice-dot" aria-hidden="true"></i><span class="tcv-voice-time">{{ time() }}</span>
        <button type="button" class="tcv-cc-ib tcv-voice-act" data-act="mic-stop" (click)="v().stop()"
                [title]="('Stop and write it out' | t) + ' (Alt+M)'" [attr.aria-label]="'Stop and write it out' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><rect class="tcv-voice-fill" x="7" y="7" width="10" height="10" rx="1.5" /></svg></button>
        <button type="button" class="tcv-cc-ib tcv-voice-act" data-act="mic-cancel" (click)="v().cancel()"
                [title]="('Throw the recording away' | t) + ' (Esc)'" [attr.aria-label]="'Throw the recording away' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10 M17 7L7 17" /></svg></button>
      </span>
    }
    @case ('up') {
      <span class="tcv-voice-busy" role="status">{{ 'Transcribing…' | t }}</span>
    }
    @default {
      <button type="button" class="tcv-cc-ib" data-act="mic" [disabled]="v().state() === 'ask'" (click)="v().toggle()"
              [title]="('Speak instead of typing - the words come into the box to check' | t) + ' (Alt+M)'"
              [attr.aria-label]="'Speak instead of typing' | t">
        <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="MIC" /></svg></button>
    }
  }
}`,
  styles: [`
    .tcv-voice-rec { display: inline-flex; align-items: center; gap: 2px; padding-left: 6px; flex: none; }
    .tcv-voice-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .tcv-voice-time { min-width: 34px; margin-left: 5px; font: 12px 'IBM Plex Mono', ui-monospace, monospace;
      color: var(--ink); font-variant-numeric: tabular-nums; }
    .tcv-voice-act { min-width: 28px; padding: 0 5px; }
    .tcv-voice-fill { fill: currentColor; stroke: none; }
    .tcv-voice-busy { flex: none; padding: 0 6px; font-size: 11.5px; color: var(--ink-dim); white-space: nowrap; }
  `],
  host: { style: 'display: contents' },
})
export class MicButton implements OnInit, OnDestroy {
  v = input.required<VoiceInput>();
  private el = inject(ElementRef<HTMLElement>);
  readonly MIC = MIC;
  time = computed(() => {
    const s = Math.floor(this.v().elapsed());
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  ngOnInit() {
    const host = this.el.nativeElement as HTMLElement;
    this.v().attach(host.closest('.tcv-cc-composer, .tcv-note-compose') as HTMLElement | null);
  }
  ngOnDestroy() { this.v().detach(); }
}
