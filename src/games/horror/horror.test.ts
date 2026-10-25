import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SongMap } from '../../shell/api';
import { getOfficeMap, getBfsPathDistanceMeters, hasLineOfSight } from './map';
import { defaultParams, generateLevel } from './level';
import { HorrorSimEngine, simulate } from './sim';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

test('office map is 28x20 with valid spawns, hiding spots, and glass vs wall occlusion', () => {
  const office = getOfficeMap();
  assert.equal(office.cols, 28);
  assert.equal(office.rows, 20);
  assert.ok(office.hidingSpots.length >= 12, 'should have at least 12 hiding spots');
  assert.equal(office.lightBanks.length, 6, 'should have 6 ceiling light banks');

  const spawnDistTiles =
    Math.hypot(
      office.playerSpawn.x - office.monsterSpawn.x,
      office.playerSpawn.z - office.monsterSpawn.z,
    ) / office.tileSize;
  assert.ok(spawnDistTiles >= 2.2 && spawnDistTiles <= 4.5, `spawn distance in tiles: ${spawnDistTiles}`);

  const bfsDist = getBfsPathDistanceMeters(
    office,
    office.playerSpawn.x,
    office.playerSpawn.z,
    office.monsterSpawn.x,
    office.monsterSpawn.z,
  );
  assert.ok(bfsDist > 3.0 && bfsDist < 12.0);
  assert.equal(
    hasLineOfSight(office, office.playerSpawn.x, office.playerSpawn.z, office.monsterSpawn.x, office.monsterSpawn.z),
    true,
  );
});

test('simulate horror across all 3 songs meets all pass targets and prints metrics table', () => {
  const songIds = ['ctd', 'fb', 'ra'];
  const rows: Array<Record<string, string | number>> = [];

  for (const id of songIds) {
    const mapPath = path.join(ROOT_DIR, 'public', 'songs', id, 'demo.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as SongMap;
    const level = generateLevel(map, defaultParams);
    const metrics = simulate({ map, level, params: defaultParams, seed: 42, entry: 0 });

    rows.push({
      song: id,
      reachableSpots: metrics.reachableSpots,
      hiderSurvivalRate: metrics.hiderSurvivalRate,
      openCaughtTimeMean: metrics.openCaughtTimeMean,
      doubleBacksPerHunt: metrics.doubleBacksPerHunt,
      fakeOutsPerHunt: metrics.fakeOutsPerHunt,
      directorHintsPerHunt: metrics.directorHintsPerHunt,
      maxSilentGap: metrics.maxSilentGap,
      freeRestartOk: metrics.freeRestartOk,
      lightsOffOnTime: metrics.lightsOffOnTime,
    });

    assert.ok(metrics.reachableSpots >= 3, `${id}: reachableSpots (${metrics.reachableSpots}) >= 3`);
    assert.ok(
      metrics.hiderSurvivalRate >= 0.4 && metrics.hiderSurvivalRate <= 0.8,
      `${id}: hiderSurvivalRate (${metrics.hiderSurvivalRate}) in 0.4..0.8`,
    );
    assert.ok(
      metrics.openCaughtTimeMean < 20,
      `${id}: openCaughtTimeMean (${metrics.openCaughtTimeMean}) < 20s`,
    );
    assert.ok(
      metrics.doubleBacksPerHunt >= 1,
      `${id}: doubleBacksPerHunt (${metrics.doubleBacksPerHunt}) >= 1`,
    );
    assert.ok(
      metrics.fakeOutsPerHunt >= 1,
      `${id}: fakeOutsPerHunt (${metrics.fakeOutsPerHunt}) >= 1`,
    );
    assert.ok(
      metrics.directorHintsPerHunt >= 1,
      `${id}: directorHintsPerHunt (${metrics.directorHintsPerHunt}) >= 1`,
    );
    assert.ok(
      metrics.maxSilentGap <= 6,
      `${id}: maxSilentGap (${metrics.maxSilentGap}) <= 6s`,
    );
    assert.equal(metrics.freeRestartOk, 1, `${id}: freeRestartOk === 1`);
    assert.equal(metrics.lightsOffOnTime, 1, `${id}: lightsOffOnTime === 1`);
  }

  console.table(rows);
});

test('hiding spots auto-face outward on entry, allow silent 360-degree mouse look, and sprinting applies 1.65x speed + 1.5x noise + 12m alert', () => {
  const office = getOfficeMap();
  for (const spot of office.hidingSpots) {
    const dx = spot.accessX - spot.worldX;
    const dz = spot.accessZ - spot.worldZ;
    const expectedYaw = Math.atan2(dx, -dz);
    assert.ok(
      Math.abs(spot.lookYaw - expectedYaw) < 1e-5,
      `Spot ${spot.id} (${spot.kind}) lookYaw (${spot.lookYaw}) should face outward toward access (${expectedYaw})`,
    );
  }

  const mapPath = path.join(ROOT_DIR, 'public', 'songs', 'ctd', 'demo.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as SongMap;
  const level = generateLevel(map, defaultParams);

  const sim = new HorrorSimEngine({
    map,
    level,
    rng: () => 0.5,
    entryTime: 0,
  });

  // 1. Test walking vs sprinting speed and 1.5x noise radius
  const startX = sim.playerX;
  sim.step(0.1, 0.1, {
    moveX: 1,
    moveZ: 0,
    lookYaw: Math.PI / 2,
    lookPitch: 0,
    interactPressed: false,
    flashlightTogglePressed: false,
    sprintHeld: false,
  });
  const walkDist = sim.playerX - startX;
  const walkNoise = sim.noiseRadius;

  const beforeSprintX = sim.playerX;
  sim.step(0.1, 0.1, {
    moveX: 1,
    moveZ: 0,
    lookYaw: Math.PI / 2,
    lookPitch: 0,
    interactPressed: false,
    flashlightTogglePressed: false,
    sprintHeld: true,
  });
  const sprintDist = sim.playerX - beforeSprintX;
  const sprintNoise = sim.noiseRadius;

  assert.ok(
    Math.abs(sprintDist / walkDist - 1.65) < 0.02,
    `Sprint distance ratio (${sprintDist / walkDist}) should be ~1.65x`,
  );
  assert.ok(
    Math.abs(sprintNoise / walkNoise - 1.5) < 0.02,
    `Sprint noise ratio (${sprintNoise / walkNoise}) should be ~1.5x`,
  );

  // 2. Test entering a supply closet auto-orients outward and allows full 360-degree silent rotation
  const closetSpot = office.hidingSpots.find(
    (s) => s.kind === 'closet' && level.enabledSpotIds.includes(s.id),
  )!;
  sim.playerX = closetSpot.accessX;
  sim.playerZ = closetSpot.accessZ;
  sim.playerYaw = Math.PI * 0.5; // Facing into the wall before pressing E

  sim.step(1 / 60, 1.0, {
    moveX: 0,
    moveZ: 0,
    lookYaw: sim.playerYaw,
    lookPitch: 0,
    interactPressed: true,
    flashlightTogglePressed: false,
  });
  assert.equal(sim.hiddenSpotId, closetSpot.id, 'should be hidden inside supply closet');
  assert.equal(
    sim.playerYaw,
    closetSpot.lookYaw,
    'entering closet should auto-face outward toward corridor',
  );

  // Rotate 180 degrees behind while hidden -> should not clamp and should produce 0 noise
  const oppositeYaw = closetSpot.lookYaw + Math.PI;
  sim.step(1 / 60, 1.02, {
    moveX: 0,
    moveZ: 0,
    lookYaw: oppositeYaw,
    lookPitch: 0.3,
    interactPressed: false,
    flashlightTogglePressed: false,
  });
  assert.equal(sim.playerYaw, oppositeYaw, 'should allow full 180/360 degree rotation while hidden');
  assert.equal(sim.noiseRadius, 0, 'turning while hidden must produce zero noise');

  // 3. Unhide during hunt and sprint within 12m of monster -> monster immediately enters chase
  sim.phase = 'hunt';
  sim.monsterState = 'patrol_to_spot';
  sim.hiddenSpotId = null;
  sim.playerX = 12.0;
  sim.playerZ = 7.5;
  sim.monsterX = 21.0; // 9.0 m away (<= 12.0 m)
  sim.monsterZ = 7.5;

  sim.step(1 / 60, 20.0, {
    moveX: 0,
    moveZ: 1,
    lookYaw: 0,
    lookPitch: 0,
    interactPressed: false,
    flashlightTogglePressed: false,
    sprintHeld: true,
  });
  assert.equal(sim.monsterState, 'chase', 'sprinting within 12m during hunt should immediately alert monster to chase');

  // 4. Hiding under a desk with flashlight OFF has a 50% survival roll when inspected,
  // whereas hiding under a desk with flashlight ON gets caught 100% of the time when inspected.
  const deskSpot = office.hidingSpots.find((s) => s.kind === 'desk')!;
  assert.ok(deskSpot, 'should find a desk hiding spot');
  sim.roundNumber = 2;
  sim.phase = 'hunt';
  sim.hiddenSpotId = deskSpot.id;
  sim.playerX = deskSpot.worldX;
  sim.playerZ = deskSpot.worldZ;
  sim.flashlightOn = false;
  sim['sawPlayerHideInCurrentSpot'] = false;
  sim['directPinpointLead'] = false;
  sim['targetSpot'] = deskSpot;
  sim['checkedCurrentTargetSpotRoll'] = false;
  sim['rng'] = () => 0.75; // >= 0.5 survives dark desk check
  sim.monsterState = 'checking_spot';
  sim['stateDuration'] = 1.5;
  sim['stateTimer'] = 0.4;

  sim.step(0.02, 25.0, {
    moveX: 0,
    moveZ: 0,
    lookYaw: deskSpot.lookYaw,
    lookPitch: 0,
    interactPressed: false,
    flashlightTogglePressed: false,
  });
  assert.notEqual(
    sim.phase,
    'dying',
    'player hidden under a dark desk (flashlight OFF) survives when 50% shadow roll >= 0.5',
  );

  // Now turn flashlight ON under the same desk (even with rng >= 0.5) -> monster spots the light and catches the player
  sim.flashlightOn = true;
  sim['targetSpot'] = deskSpot;
  sim['checkedCurrentTargetSpotRoll'] = false;
  sim.monsterState = 'checking_spot';
  sim['stateDuration'] = 1.5;
  sim['stateTimer'] = 0.4;
  sim.step(0.02, 26.0, {
    moveX: 0,
    moveZ: 0,
    lookYaw: deskSpot.lookYaw,
    lookPitch: 0,
    interactPressed: false,
    flashlightTogglePressed: false,
  });
  assert.equal(
    sim.phase,
    'dying',
    'player hidden under a desk with flashlight ON is caught 100% of the time when that desk is checked',
  );
});


