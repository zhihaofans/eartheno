/**
 * 程序化音效：WebAudio 现场合成，0 KB 资源、离线可用。
 * 所有声音都很短（< 0.2s），用振荡器 + 噪声 buffer。
 */
import { clamp } from '../core/util';

type Ctx = AudioContext;

export class Sound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  vol = 0.6;
  enabled = true;

  /** 必须在用户手势里调用一次（iOS 要求） */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.vol;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    } catch {
      this.ctx = null;
    }
  }

  setVolume(v: number): void {
    this.vol = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.enabled ? this.vol : 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.vol : 0;
  }

  private ready(): boolean {
    return !!this.ctx && !!this.master && this.enabled;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, filterHz: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ready() || !this.noiseBuf) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterHz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  dig(): void {
    this.noise(0.07, 0.18, 1400);
  }

  breakBlock(): void {
    this.noise(0.14, 0.3, 900);
    this.tone(140, 0.1, 'square', 0.05, 70);
  }

  place(): void {
    this.tone(240, 0.07, 'triangle', 0.12, 180);
    this.noise(0.05, 0.1, 2200, 'highpass');
  }

  jump(): void {
    this.tone(320, 0.1, 'sine', 0.08, 520);
  }

  land(): void {
    this.noise(0.09, 0.16, 420);
  }

  craft(): void {
    this.tone(520, 0.08, 'triangle', 0.1, 660);
    setTimeout(() => this.tone(780, 0.1, 'triangle', 0.1, 900), 70);
  }

  error(): void {
    this.tone(180, 0.12, 'sawtooth', 0.07, 120);
  }

  /** 选格 */
  tick(): void {
    this.tone(900, 0.03, 'square', 0.04);
  }

  toolBreak(): void {
    this.noise(0.2, 0.25, 600);
    this.tone(90, 0.2, 'sawtooth', 0.06, 50);
  }
}

export const sound = new Sound();
