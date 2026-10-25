import {
  computeBfsDistances,
  findGridPath,
  getOfficeMap,
  type HidingSpot,
  type ParsedOfficeMap,
} from './map';

export type BotMode = 'hider' | 'open' | 'walkin';

export interface BotInputState {
  moveX: number; // world X velocity intent (-1..1)
  moveZ: number; // world Z velocity intent (-1..1)
  lookYaw: number;
  lookPitch: number;
  interactPressed: boolean;
  flashlightTogglePressed: boolean;
  sprintHeld?: boolean;
}

export interface BotObservation {
  songTime: number;
  phase: 'hide' | 'hunt' | 'oneMoreTry' | 'dying';
  playerX: number;
  playerZ: number;
  playerYaw: number;
  hiddenSpotId: number | null;
  flashlightOn: boolean;
  monsterX: number;
  monsterZ: number;
  enabledSpotIds: number[];
}

export class HorrorBotController {
  readonly mode: BotMode;
  private office: ParsedOfficeMap;
  private targetSpot: HidingSpot | null = null;
  private waypoints: Array<{ x: number; z: number }> = [];
  private waypointIdx = 0;
  private lastInteractTime = -999;
  private lastPathComputeTime = -999;

  constructor(mode: BotMode = 'hider') {
    this.mode = mode;
    this.office = getOfficeMap();
  }

  reset(): void {
    this.targetSpot = null;
    this.waypoints = [];
    this.waypointIdx = 0;
    this.lastInteractTime = -999;
    this.lastPathComputeTime = -999;
  }

  /**
   * Picks the reachable hiding spot farthest by path from the monster's spawn,
   * preferring phone booths ('booth') and supply closets ('closet').
   */
  private chooseHiderSpot(enabledSpotIds: number[], maxWalkDistanceMeters = 24.0): HidingSpot {
    const pSpawn = this.office.playerSpawn;
    const mSpawn = this.office.monsterSpawn;
    const distFromPlayer = computeBfsDistances(this.office, pSpawn.gx, pSpawn.gz);
    const distFromMonster = computeBfsDistances(this.office, mSpawn.gx, mSpawn.gz);

    const candidates = this.office.hidingSpots.filter((s) => enabledSpotIds.includes(s.id));
    let bestSpot = candidates[0] ?? this.office.hidingSpots[0];
    let bestScore = -1e9;

    for (const spot of candidates) {
      const dPlayer = distFromPlayer[spot.accessGz * this.office.cols + spot.accessGx];
      const dMonster = distFromMonster[spot.accessGz * this.office.cols + spot.accessGx];
      if (dPlayer > maxWalkDistanceMeters || dPlayer > 900) continue;

      const kindBonus = spot.kind === 'booth' || spot.kind === 'closet' ? 6.0 : 0.0;
      const score = dMonster + kindBonus;
      if (score > bestScore) {
        bestScore = score;
        bestSpot = spot;
      }
    }
    return bestSpot;
  }

  step(obs: BotObservation): BotInputState {
    const out: BotInputState = {
      moveX: 0,
      moveZ: 0,
      lookYaw: obs.playerYaw,
      lookPitch: 0,
      interactPressed: false,
      flashlightTogglePressed: false,
    };

    if (obs.phase === 'dying' || obs.phase === 'oneMoreTry') {
      return out;
    }

    // 1. OPEN BOT: stands still in the open with flashlight on so monster can find it quickly
    if (this.mode === 'open') {
      if (!obs.flashlightOn) {
        out.flashlightTogglePressed = true;
      }
      // Slowly look toward the monster
      const dx = obs.monsterX - obs.playerX;
      const dz = obs.monsterZ - obs.playerZ;
      out.lookYaw = Math.atan2(dx, -dz);
      return out;
    }

    // 2. WALK-IN BOT: walks directly into the monster during the countdown (twice) to test free restart
    if (this.mode === 'walkin') {
      if (obs.hiddenSpotId !== null && obs.songTime - this.lastInteractTime > 0.5) {
        out.interactPressed = true;
        this.lastInteractTime = obs.songTime;
        return out;
      }
      if (obs.songTime - this.lastPathComputeTime > 0.6 || this.waypoints.length === 0) {
        this.waypoints = findGridPath(
          this.office,
          obs.playerX,
          obs.playerZ,
          obs.monsterX,
          obs.monsterZ,
        );
        this.waypointIdx = 0;
        this.lastPathComputeTime = obs.songTime;
      }
      const wp = this.waypoints[this.waypointIdx] ?? { x: obs.monsterX, z: obs.monsterZ };
      const dx = wp.x - obs.playerX;
      const dz = wp.z - obs.playerZ;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.35 && this.waypointIdx < this.waypoints.length - 1) {
        this.waypointIdx++;
      }
      const tx = (this.waypoints[this.waypointIdx]?.x ?? obs.monsterX) - obs.playerX;
      const tz = (this.waypoints[this.waypointIdx]?.z ?? obs.monsterZ) - obs.playerZ;
      const len = Math.hypot(tx, tz);
      if (len > 0.01) {
        out.moveX = tx / len;
        out.moveZ = tz / len;
        out.lookYaw = Math.atan2(out.moveX, -out.moveZ);
      }
      return out;
    }

    // 3. HIDER BOT: walks to farthest reachable booth/closet before countdown ends, then stays hidden
    if (!this.targetSpot) {
      this.targetSpot = this.chooseHiderSpot(obs.enabledSpotIds, 19.5);
      this.waypoints = findGridPath(
        this.office,
        obs.playerX,
        obs.playerZ,
        this.targetSpot.accessX,
        this.targetSpot.accessZ,
      );
      this.waypointIdx = 0;
    }

    // Keep flashlight on so rendered bot mode clearly shows the flashlight beam and monster
    if (!obs.flashlightOn) {
      out.flashlightTogglePressed = true;
    }

    if (obs.hiddenSpotId !== null) {
      // Already hidden: stay hidden during the hunt and look out toward the monster (clamped +-60 deg by game)
      const spot = this.office.hidingSpots[obs.hiddenSpotId] ?? this.targetSpot;
      const dx = obs.monsterX - obs.playerX;
      const dz = obs.monsterZ - obs.playerZ;
      const angleToMonster = Math.atan2(dx, -dz);
      let diff = angleToMonster - spot.lookYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxOff = (60 * Math.PI) / 180;
      const clampedDiff = Math.max(-maxOff, Math.min(maxOff, diff));
      out.lookYaw = spot.lookYaw + clampedDiff;
      return out;
    }

    // Not hidden yet: walk along path to targetSpot.accessX/Z
    const distToSpot = Math.hypot(
      this.targetSpot.worldX - obs.playerX,
      this.targetSpot.worldZ - obs.playerZ,
    );
    const distToAccess = Math.hypot(
      this.targetSpot.accessX - obs.playerX,
      this.targetSpot.accessZ - obs.playerZ,
    );

    if ((distToSpot <= 1.15 || distToAccess <= 0.45) && obs.songTime - this.lastInteractTime > 0.4) {
      // Face the hiding spot and press E to hide
      const sdx = this.targetSpot.worldX - obs.playerX;
      const sdz = this.targetSpot.worldZ - obs.playerZ;
      out.lookYaw = Math.atan2(sdx, -sdz);
      out.interactPressed = true;
      this.lastInteractTime = obs.songTime;
      return out;
    }

    if (this.waypoints.length === 0 || obs.songTime - this.lastPathComputeTime > 1.5) {
      this.waypoints = findGridPath(
        this.office,
        obs.playerX,
        obs.playerZ,
        this.targetSpot.accessX,
        this.targetSpot.accessZ,
      );
      this.waypointIdx = 0;
      this.lastPathComputeTime = obs.songTime;
    }

    while (
      this.waypointIdx < this.waypoints.length - 1 &&
      Math.hypot(
        this.waypoints[this.waypointIdx].x - obs.playerX,
        this.waypoints[this.waypointIdx].z - obs.playerZ,
      ) < 0.4
    ) {
      this.waypointIdx++;
    }

    const wp = this.waypoints[this.waypointIdx] ?? {
      x: this.targetSpot.accessX,
      z: this.targetSpot.accessZ,
    };
    const dx = wp.x - obs.playerX;
    const dz = wp.z - obs.playerZ;
    const len = Math.hypot(dx, dz);
    if (len > 0.02) {
      out.moveX = dx / len;
      out.moveZ = dz / len;
      // During the first 2.0s while near spawn, aim the camera/flashlight at the counting monster in the kitchen
      const distToMonster = Math.hypot(obs.monsterX - obs.playerX, obs.monsterZ - obs.playerZ);
      if (obs.phase === 'hide' && distToMonster <= 7.5 && this.waypointIdx <= 2) {
        out.lookYaw = Math.atan2(obs.monsterX - obs.playerX, -(obs.monsterZ - obs.playerZ));
      } else {
        out.lookYaw = Math.atan2(out.moveX, -out.moveZ);
      }
    }

    return out;
  }
}
