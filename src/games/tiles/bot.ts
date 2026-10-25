import type { TileNote } from './level';

export function sampleGaussian(rng: () => number, sigmaSec = 0.015): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  // Clamp extreme >2.33 sigma outliers so bot presses stay inside the 50ms PERFECT window
  const clampedZ = Math.max(-2.33, Math.min(2.33, z0));
  return clampedZ * sigmaSec;
}

export class TilesBotController {
  private scheduledPressTimeByNoteId = new Map<number, number>();
  private pressedNoteIds = new Set<number>();
  private startIdx = 0;

  reset(): void {
    this.scheduledPressTimeByNoteId.clear();
    this.pressedNoteIds.clear();
    this.startIdx = 0;
  }

  /**
   * Returns an array of lane indices (0..3) that the bot presses on this step.
   * Each active note (t >= safeUntil) is scheduled once at `note.t + Gaussian(0, 15ms)`.
   */
  step(
    notes: TileNote[],
    songTime: number,
    safeUntil: number,
    rng: () => number,
    handledNoteIds: ReadonlySet<number>,
  ): number[] {
    const lanesPressed: number[] = [];

    while (
      this.startIdx < notes.length &&
      (notes[this.startIdx].t < safeUntil ||
        handledNoteIds.has(notes[this.startIdx].id) ||
        this.pressedNoteIds.has(notes[this.startIdx].id))
    ) {
      this.startIdx++;
    }

    for (let i = this.startIdx; i < notes.length; i++) {
      const note = notes[i];
      if (note.t < safeUntil) continue;
      if (note.t - songTime > 0.25) break;
      if (handledNoteIds.has(note.id) || this.pressedNoteIds.has(note.id)) continue;

      let targetPressTime = this.scheduledPressTimeByNoteId.get(note.id);
      if (targetPressTime === undefined) {
        const jitter = sampleGaussian(rng, 0.015);
        targetPressTime = note.t + jitter;
        this.scheduledPressTimeByNoteId.set(note.id, targetPressTime);
      }

      if (songTime >= targetPressTime) {
        this.pressedNoteIds.add(note.id);
        lanesPressed.push(note.lane);
      }
    }

    return lanesPressed;
  }
}
