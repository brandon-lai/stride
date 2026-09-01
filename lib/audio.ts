"use client";

/**
 * §2: "Audio cues for coin pickup, near miss, and collision so the player can
 * rely on sound."
 *
 * That requirement exists because of the screen-distance problem: standing 2.5m
 * back and out of breath, the player cannot read the screen for confirmation.
 * Sound is the channel that still works, so these are functional feedback, not
 * decoration -- and they are synthesised so they ship with no audio files and
 * can be pitched per event.
 */
export class Cues {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  muted = false;

  private ensure(): boolean {
    if (this.muted) return false;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.5;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return true;
  }

  private blip(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.25) {
    if (!this.ensure() || !this.ctx || !this.gain) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Bright and short: confirms a pickup without masking anything. */
  coin() { this.blip(1180, 0.09, "triangle", 0.18); }

  /**
   * §2 asks for a near-miss cue specifically. It is the one that teaches: it
   * tells the player their gesture landed *and* that it was close, which is the
   * feedback that makes them commit earlier next time.
   */
  nearMiss() { this.blip(320, 0.14, "sawtooth", 0.12); }

  collision() {
    if (!this.ensure() || !this.ctx || !this.gain) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + 0.42);
  }

  /** Fired when a gesture registers, so the player knows the tracker saw them. */
  gesture() { this.blip(720, 0.05, "square", 0.08); }

  dispose() { void this.ctx?.close(); this.ctx = null; }
}
