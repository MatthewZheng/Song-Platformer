export const TILE_SIZE = 1.5; // meters per grid cell
export const MAP_COLS = 28;
export const MAP_ROWS = 20;

export type TileChar = '#' | 'G' | '.' | 'd' | 'b' | 'c' | 'k' | 's' | 'w' | 'P' | 'M';

export type HidingSpotKind = 'desk' | 'booth' | 'closet';

export interface HidingSpot {
  id: number;
  kind: HidingSpotKind;
  gx: number;
  gz: number;
  worldX: number;
  worldZ: number;
  /** Position in front of the spot where the player stands on unhide / where monster stands to check */
  accessGx: number;
  accessGz: number;
  accessX: number;
  accessZ: number;
  /** Direction angle (radians) the player looks when hidden inside */
  lookYaw: number;
}

export interface LightBank {
  id: number;
  name: string;
  worldX: number;
  worldZ: number;
  Fixtures: Array<{ x: number; z: number }>;
}

/**
 * 28 x 20 handcrafted San Francisco coworking club ("SOLSTICE COMMONS")
 * Legend:
 *  # = solid wall
 *  G = glass wall (meeting rooms - see-through, not hidable)
 *  w = exterior window wall (shows distant SF city lights)
 *  . = walkable floor
 *  d = standing/communal desk (hide under)
 *  b = frosted phone booth (hide inside, enter from open door side)
 *  c = supply closet (hide inside)
 *  k = kitchen island (low cover, not a hiding spot)
 *  s = lounge sofa (low cover, not a hiding spot)
 *  P = player spawn (~3 tiles from M, on open floor)
 *  M = monster spawn (in kitchen facing north wall)
 */
export const OFFICE_MAP_ROWS: string[] = [
  '###wwwwwwwwwwwwwwwwwwwwww###', // 0: North exterior window wall
  '#..M...#...........#.......#', // 1: Kitchen bar (left), Open workspace (mid), Lounge (right)
  '#..kk..#..d..d..d..#..s..s.#', // 2: Kitchen island, North desks, Lounge sofas
  '#....P.....................#', // 3: Main north promenade (P is ~3.2 tiles from M)
  '#..kk.....d..d..d.....s..s.#', // 4: Kitchen lower island, communal desks, sofas
  '#..........................#', // 5: Central open aisle
  '####.###...........###.#####', // 6: Partition wall with wide doorways
  '#b.....#..d.....d..#......c#', // 7: Phone booth #1, Central desks, Supply closet #1
  '#b.........................w', // 8: Phone booth #2, Cross corridor
  '#b.....#...........#.......w', // 9: Phone booth #3, Center atrium
  '#b.....#..d.....d..#......c#', // 10: Phone booth #4, South desks, Supply closet #2
  '####.###...........###.#####', // 11: Lower partition with wide doorways
  '#..........................#', // 12: South thoroughfare
  '#..GGGGGG.........GGGGGG...#', // 13: 2 Glass-walled meeting rooms (north glass)
  'w..G....G....d....G....G...w', // 14: Meeting rooms + center desk
  'w..G.............G.....G...w', // 15: Meeting room doors open to center
  'w..GGGGGG.........GGGGGG...w', // 16: Meeting rooms (south glass)
  '#..........................#', // 17: Reception / south gallery
  '#...s..s.....d......s..s..c#', // 18: Reception lounge & south supply closet
  '###wwwwwwwwwwwwwwwwwwwwww###', // 19: South exterior window wall
];

export interface ParsedOfficeMap {
  cols: number;
  rows: number;
  tileSize: number;
  grid: TileChar[][];
  playerSpawn: { gx: number; gz: number; x: number; z: number; yaw: number };
  monsterSpawn: { gx: number; gz: number; x: number; z: number; yaw: number };
  hidingSpots: HidingSpot[];
  lightBanks: LightBank[];
}

export function gridToWorld(gx: number, gz: number): { x: number; z: number } {
  return {
    x: (gx + 0.5) * TILE_SIZE,
    z: (gz + 0.5) * TILE_SIZE,
  };
}

export function worldToGrid(x: number, z: number): { gx: number; gz: number } {
  return {
    gx: Math.max(0, Math.min(MAP_COLS - 1, Math.floor(x / TILE_SIZE))),
    gz: Math.max(0, Math.min(MAP_ROWS - 1, Math.floor(z / TILE_SIZE))),
  };
}

export function isTileWalkable(ch: TileChar): boolean {
  return ch === '.' || ch === 'P' || ch === 'M';
}

export function isTileOpaqueToSight(ch: TileChar): boolean {
  // Walls (#), window walls (w), closed phone booths (b), and supply closets (c) block sight.
  // Glass walls (G) and low furniture (d, k, s) do NOT block sight.
  return ch === '#' || ch === 'w' || ch === 'b' || ch === 'c';
}

export function isTileWallForSound(ch: TileChar): boolean {
  // Solid walls, glass walls, booths, closets block direct acoustic ray
  return ch === '#' || ch === 'G' || ch === 'w' || ch === 'b' || ch === 'c';
}

let cachedMap: ParsedOfficeMap | null = null;

export function getOfficeMap(): ParsedOfficeMap {
  if (cachedMap) return cachedMap;

  const grid: TileChar[][] = [];
  let playerSpawn = { gx: 5, gz: 3, x: 8.25, z: 5.25, yaw: Math.PI * 0.5 };
  let monsterSpawn = { gx: 3, gz: 1, x: 5.25, z: 2.25, yaw: 0 };

  for (let gz = 0; gz < MAP_ROWS; gz++) {
    const rowStr = OFFICE_MAP_ROWS[gz] ?? '.'.repeat(MAP_COLS);
    const row: TileChar[] = [];
    for (let gx = 0; gx < MAP_COLS; gx++) {
      const ch = (rowStr[gx] ?? '#') as TileChar;
      row.push(ch);
      if (ch === 'P') {
        const w = gridToWorld(gx, gz);
        // Face east/southeast down the open promenade away from the kitchen wall
        playerSpawn = { gx, gz, x: w.x, z: w.z, yaw: -Math.PI * 0.45 };
      } else if (ch === 'M') {
        const w = gridToWorld(gx, gz);
        // Face north toward the kitchen wall while counting
        monsterSpawn = { gx, gz, x: w.x, z: w.z, yaw: 0 };
      }
    }
    grid.push(row);
  }

  const hidingSpots: HidingSpot[] = [];
  const dirs = [
    { dx: 1, dz: 0, yaw: Math.PI * 0.5 },   // door faces East (+X)
    { dx: -1, dz: 0, yaw: -Math.PI * 0.5 }, // door faces West (-X)
    { dx: 0, dz: 1, yaw: Math.PI },         // door faces South (+Z)
    { dx: 0, dz: -1, yaw: 0 },              // door faces North (-Z)
  ];

  for (let gz = 0; gz < MAP_ROWS; gz++) {
    for (let gx = 0; gx < MAP_COLS; gx++) {
      const ch = grid[gz][gx];
      if (ch === 'd' || ch === 'b' || ch === 'c') {
        const kind: HidingSpotKind = ch === 'b' ? 'booth' : ch === 'c' ? 'closet' : 'desk';
        const wPos = gridToWorld(gx, gz);
        // Find adjacent walkable tile for door/access
        let accessGx = gx;
        let accessGz = gz;
        let lookYaw = 0;
        for (const d of dirs) {
          const nx = gx + d.dx;
          const nz = gz + d.dz;
          if (nx >= 0 && nx < MAP_COLS && nz >= 0 && nz < MAP_ROWS && isTileWalkable(grid[nz][nx])) {
            accessGx = nx;
            accessGz = nz;
            lookYaw = d.yaw;
            break;
          }
        }
        const aPos = gridToWorld(accessGx, accessGz);
        hidingSpots.push({
          id: hidingSpots.length,
          kind,
          gx,
          gz,
          worldX: wPos.x,
          worldZ: wPos.z,
          accessGx,
          accessGz,
          accessX: aPos.x,
          accessZ: aPos.z,
          lookYaw,
        });
      }
    }
  }

  // 6 ceiling light banks across the office
  const lightBanks: LightBank[] = [
    {
      id: 0,
      name: 'Kitchen & Espresso Bar',
      worldX: 4.5 * TILE_SIZE,
      worldZ: 3.0 * TILE_SIZE,
      Fixtures: [
        { x: 3.5 * TILE_SIZE, z: 2.0 * TILE_SIZE },
        { x: 5.5 * TILE_SIZE, z: 4.5 * TILE_SIZE },
      ],
    },
    {
      id: 1,
      name: 'North Hot-Desks',
      worldX: 13.5 * TILE_SIZE,
      worldZ: 3.0 * TILE_SIZE,
      Fixtures: [
        { x: 11.0 * TILE_SIZE, z: 2.5 * TILE_SIZE },
        { x: 16.0 * TILE_SIZE, z: 4.5 * TILE_SIZE },
      ],
    },
    {
      id: 2,
      name: 'North Lounge',
      worldX: 22.5 * TILE_SIZE,
      worldZ: 3.0 * TILE_SIZE,
      Fixtures: [
        { x: 21.5 * TILE_SIZE, z: 2.5 * TILE_SIZE },
        { x: 24.5 * TILE_SIZE, z: 4.5 * TILE_SIZE },
      ],
    },
    {
      id: 3,
      name: 'Phone Booth Row & West Wing',
      worldX: 4.5 * TILE_SIZE,
      worldZ: 9.0 * TILE_SIZE,
      Fixtures: [
        { x: 3.5 * TILE_SIZE, z: 8.0 * TILE_SIZE },
        { x: 5.5 * TILE_SIZE, z: 10.0 * TILE_SIZE },
      ],
    },
    {
      id: 4,
      name: 'Central Commons & East Closets',
      worldX: 15.5 * TILE_SIZE,
      worldZ: 9.0 * TILE_SIZE,
      Fixtures: [
        { x: 13.5 * TILE_SIZE, z: 8.5 * TILE_SIZE },
        { x: 22.5 * TILE_SIZE, z: 9.0 * TILE_SIZE },
      ],
    },
    {
      id: 5,
      name: 'Glass Suites & Reception',
      worldX: 14.0 * TILE_SIZE,
      worldZ: 15.5 * TILE_SIZE,
      Fixtures: [
        { x: 7.0 * TILE_SIZE, z: 15.0 * TILE_SIZE },
        { x: 14.0 * TILE_SIZE, z: 17.0 * TILE_SIZE },
        { x: 21.0 * TILE_SIZE, z: 15.0 * TILE_SIZE },
      ],
    },
  ];

  cachedMap = {
    cols: MAP_COLS,
    rows: MAP_ROWS,
    tileSize: TILE_SIZE,
    grid,
    playerSpawn,
    monsterSpawn,
    hidingSpots,
    lightBanks,
  };
  return cachedMap;
}

const bfsCache = new Map<number, Float32Array>();
const _bfsQx = new Int16Array(MAP_COLS * MAP_ROWS);
const _bfsQz = new Int16Array(MAP_COLS * MAP_ROWS);
const _dx4 = [1, -1, 0, 0];
const _dz4 = [0, 0, 1, -1];

/**
 * Computes (or returns cached) BFS shortest path distances (in meters) from (startGx, startGz) to all grid cells.
 */
export function computeBfsDistances(
  map: ParsedOfficeMap,
  startGx: number,
  startGz: number,
): Float32Array {
  const sx = Math.max(0, Math.min(map.cols - 1, startGx));
  const sz = Math.max(0, Math.min(map.rows - 1, startGz));
  const key = sz * map.cols + sx;
  const cached = bfsCache.get(key);
  if (cached) return cached;

  const dists = new Float32Array(map.cols * map.rows);
  dists.fill(999);

  let head = 0;
  let tail = 0;

  dists[key] = 0;
  _bfsQx[tail] = sx;
  _bfsQz[tail] = sz;
  tail++;

  while (head < tail) {
    const cx = _bfsQx[head];
    const cz = _bfsQz[head];
    head++;
    const baseDist = dists[cz * map.cols + cx];

    for (let i = 0; i < 4; i++) {
      const nx = cx + _dx4[i];
      const nz = cz + _dz4[i];
      if (nx < 0 || nx >= map.cols || nz < 0 || nz >= map.rows) continue;
      const idx = nz * map.cols + nx;
      if (dists[idx] <= baseDist + TILE_SIZE) continue;
      // Allow stepping into walkable tiles, or recording distance onto adjacent hiding spot tiles
      const ch = map.grid[nz][nx];
      if (isTileWalkable(ch)) {
        dists[idx] = baseDist + TILE_SIZE;
        _bfsQx[tail] = nx;
        _bfsQz[tail] = nz;
        tail++;
      } else if (ch === 'd' || ch === 'b' || ch === 'c') {
        dists[idx] = baseDist + TILE_SIZE;
      }
    }
  }
  bfsCache.set(key, dists);
  return dists;
}

export function getBfsPathDistanceMeters(
  map: ParsedOfficeMap,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  const g0 = worldToGrid(x0, z0);
  const g1 = worldToGrid(x1, z1);
  const dists = computeBfsDistances(map, g0.gx, g0.gz);
  const d = dists[g1.gz * map.cols + g1.gx];
  if (d < 900) {
    // Blend with direct Euclidean distance when in the same room
    const euclid = Math.hypot(x1 - x0, z1 - z0);
    return Math.max(euclid, d * 0.92);
  }
  return Math.hypot(x1 - x0, z1 - z0);
}

/**
 * Grid raycast for line-of-sight (sight & monster sprite occlusion).
 * Glass walls ('G') and low furniture ('d', 'k', 's') do NOT block sight.
 * Solid walls ('#', 'w'), closed booths ('b'), and closets ('c') block sight.
 */
export function hasLineOfSight(
  map: ParsedOfficeMap,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  if (dist < 0.05) return true;
  const startG = worldToGrid(x0, z0);
  const endG = worldToGrid(x1, z1);
  const steps = Math.max(2, Math.ceil(dist / (TILE_SIZE * 0.2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    const { gx, gz } = worldToGrid(x, z);
    if ((gx === startG.gx && gz === startG.gz) || (gx === endG.gx && gz === endG.gz)) {
      continue;
    }
    const ch = map.grid[gz]?.[gx] ?? '#';
    if (isTileOpaqueToSight(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * Counts how many distinct wall segments lie along the straight line between (x0,z0) and (x1,z1)
 * for the lowpass filter: 0 = line of sight (18000 Hz), 1 = one wall (2500 Hz), >=2 = 700 Hz.
 */
export function countWallsBetween(
  map: ParsedOfficeMap,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  if (dist < 0.05) return 0;
  const steps = Math.max(4, Math.ceil(dist / (TILE_SIZE * 0.25)));
  let walls = 0;
  let inWall = false;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    const { gx, gz } = worldToGrid(x, z);
    const ch = map.grid[gz]?.[gx] ?? '#';
    const blocked = isTileWallForSound(ch);
    if (blocked && !inWall) {
      walls++;
      inWall = true;
    } else if (!blocked) {
      inWall = false;
    }
  }
  return walls;
}

const _astarG = new Float32Array(MAP_COLS * MAP_ROWS);
const _astarF = new Float32Array(MAP_COLS * MAP_ROWS);
const _astarCameFrom = new Int16Array(MAP_COLS * MAP_ROWS);
const _astarClosed = new Uint8Array(MAP_COLS * MAP_ROWS);
const _neighborOffsets = [
  { dx: 1, dz: 0, cost: 1 },
  { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 },
  { dx: 0, dz: -1, cost: 1 },
  // Diagonals only if both cardinal neighbors are walkable (no corner cutting)
  { dx: 1, dz: 1, cost: 1.4142 },
  { dx: -1, dz: 1, cost: 1.4142 },
  { dx: 1, dz: -1, cost: 1.4142 },
  { dx: -1, dz: -1, cost: 1.4142 },
];
const _snapDirs = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * A* pathfinding on the 28x20 grid. Returns world-space waypoints from start to goal.
 */
export function findGridPath(
  map: ParsedOfficeMap,
  startX: number,
  startZ: number,
  goalX: number,
  goalZ: number,
): Array<{ x: number; z: number }> {
  const s = worldToGrid(startX, startZ);
  let g = worldToGrid(goalX, goalZ);

  // If goal tile isn't walkable, snap to nearest walkable neighbor
  if (!isTileWalkable(map.grid[g.gz]?.[g.gx] ?? '#')) {
    for (const [dx, dz] of _snapDirs) {
      const nx = g.gx + dx;
      const nz = g.gz + dz;
      if (nx >= 0 && nx < map.cols && nz >= 0 && nz < map.rows && isTileWalkable(map.grid[nz][nx])) {
        g = { gx: nx, gz: nz };
        break;
      }
    }
  }

  _astarG.fill(1e9);
  _astarF.fill(1e9);
  _astarCameFrom.fill(-1);
  _astarClosed.fill(0);
  const openSet: number[] = [];

  const startIdx = s.gz * map.cols + s.gx;
  const goalIdx = g.gz * map.cols + g.gx;
  _astarG[startIdx] = 0;
  _astarF[startIdx] = Math.hypot(g.gx - s.gx, g.gz - s.gz);
  openSet.push(startIdx);

  while (openSet.length > 0) {
    let bestPos = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (_astarF[openSet[i]] < _astarF[openSet[bestPos]]) {
        bestPos = i;
      }
    }
    const current = openSet[bestPos];
    openSet.splice(bestPos, 1);

    if (current === goalIdx) {
      const out: Array<{ x: number; z: number }> = [];
      let cur = current;
      while (cur !== -1 && cur !== startIdx) {
        const cx = cur % map.cols;
        const cz = (cur / map.cols) | 0;
        out.push(gridToWorld(cx, cz));
        cur = _astarCameFrom[cur];
      }
      out.reverse();
      if (out.length === 0) {
        out.push(gridToWorld(g.gx, g.gz));
      }
      return out;
    }

    _astarClosed[current] = 1;
    const cx = current % map.cols;
    const cz = (current / map.cols) | 0;

    for (const nb of _neighborOffsets) {
      const nx = cx + nb.dx;
      const nz = cz + nb.dz;
      if (nx < 0 || nx >= map.cols || nz < 0 || nz >= map.rows) continue;
      if (!isTileWalkable(map.grid[nz][nx])) continue;
      if (nb.dx !== 0 && nb.dz !== 0) {
        if (!isTileWalkable(map.grid[cz][nx]) || !isTileWalkable(map.grid[nz][cx])) {
          continue;
        }
      }
      const nIdx = nz * map.cols + nx;
      if (_astarClosed[nIdx]) continue;

      const tentativeG = _astarG[current] + nb.cost;
      if (tentativeG < _astarG[nIdx]) {
        _astarCameFrom[nIdx] = current;
        _astarG[nIdx] = tentativeG;
        _astarF[nIdx] = tentativeG + Math.hypot(g.gx - nx, g.gz - nz);
        if (!openSet.includes(nIdx)) {
          openSet.push(nIdx);
        }
      }
    }
  }

  return [gridToWorld(g.gx, g.gz)];
}

/**
 * Slides a circular actor (radius r) against non-walkable tiles in the grid.
 */
export function resolveGridCollision(
  map: ParsedOfficeMap,
  x: number,
  z: number,
  radius = 0.36,
): { x: number; z: number } {
  let nx = Math.max(TILE_SIZE * 1.1, Math.min((map.cols - 1.1) * TILE_SIZE, x));
  let nz = Math.max(TILE_SIZE * 1.1, Math.min((map.rows - 1.1) * TILE_SIZE, z));
  const { gx, gz } = worldToGrid(nx, nz);

  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const tx = gx + ox;
      const tz = gz + oz;
      if (tx < 0 || tx >= map.cols || tz < 0 || tz >= map.rows) continue;
      if (isTileWalkable(map.grid[tz][tx])) continue;

      const minX = tx * TILE_SIZE;
      const maxX = (tx + 1) * TILE_SIZE;
      const minZ = tz * TILE_SIZE;
      const maxZ = (tz + 1) * TILE_SIZE;

      const closestX = Math.max(minX, Math.min(maxX, nx));
      const closestZ = Math.max(minZ, Math.min(maxZ, nz));
      const dx = nx - closestX;
      const dz = nz - closestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < radius * radius) {
        const dist = Math.sqrt(distSq);
        if (dist > 1e-5) {
          const push = radius - dist;
          nx += (dx / dist) * push;
          nz += (dz / dist) * push;
        } else {
          nx += radius * 0.5;
        }
      }
    }
  }
  return { x: nx, z: nz };
}
