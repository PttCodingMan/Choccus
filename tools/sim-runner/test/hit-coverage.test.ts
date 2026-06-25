/**
 * BnB-style lenient hitbox: a player is trapped only when ≥ 2/3 of their
 * 1-tile body box overlaps the melt-flow, not the instant their centre crosses
 * a flame tile boundary. Pins the integer coverage math in explosionCovers.
 */
import { describe, expect, it } from 'vitest';

import { MILLITILE } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import {
  type ExplosionState,
  explosionCovers,
} from '../../../client/src/sim/Explosion';
import { idx } from '../../../client/src/sim/Map';
import { clonePlayer } from '../../../client/src/sim/Player';
import {
  type SimState,
  createInitialState,
  tick,
} from '../../../client/src/sim/Sim';

const flame = (tileX: number, tileY: number): ExplosionState[] => [
  { tileX, tileY, ttlTicks: 1 },
];

describe('explosionCovers — 2/3 lenient hitbox', () => {
  it('hits when standing on a burning tile centre (full coverage)', () => {
    expect(explosionCovers(flame(1, 0), 1 * MILLITILE, 0)).toBe(true);
  });

  it('misses when the burning tile is a neighbour and you are centred', () => {
    expect(explosionCovers(flame(2, 0), 1 * MILLITILE, 0)).toBe(false);
  });

  it('hits at 70% inside the flame (just over the 2/3 line)', () => {
    // centre 0.3 tiles from tile 1 → 0.7 of the body is over tile 1
    expect(explosionCovers(flame(1, 0), MILLITILE - 300, 0)).toBe(true);
  });

  it('misses at 60% inside the flame (just under the 2/3 line)', () => {
    // centre 0.4 tiles from tile 1 → 0.6 of the body is over tile 1
    expect(explosionCovers(flame(1, 0), MILLITILE - 400, 0)).toBe(false);
  });

  it('cornering: 0.7×0.7 = 0.49 of the body on a single flame tile → miss', () => {
    expect(explosionCovers(flame(1, 1), MILLITILE - 300, MILLITILE - 300)).toBe(
      false,
    );
  });

  it('cornering: all four straddled tiles burning → full coverage → hit', () => {
    const cells: ExplosionState[] = [
      { tileX: 0, tileY: 0, ttlTicks: 1 },
      { tileX: 1, tileY: 0, ttlTicks: 1 },
      { tileX: 0, tileY: 1, ttlTicks: 1 },
      { tileX: 1, tileY: 1, ttlTicks: 1 },
    ];
    expect(explosionCovers(cells, MILLITILE - 300, MILLITILE - 300)).toBe(true);
  });
});

/**
 * End-to-end "卡縫躲爆" (BnB In-Between) in a real tick(): a bomb at (1,1) with
 * fire 1 puts its only horizontal flame on tile (2,1); (3,1) is the safe tile
 * next to it. A player parked on row 1 at a fractional X straddles the (2,1)|(3,1)
 * edge. It survives unless ≥2/3 of its body is over the flame tile. The 0.6 case
 * (posX 2400) is the proof: the OLD centre-in-tile model rounded 2.4→tile 2 and
 * trapped it; the 2/3 hitbox lets it slip the edge. IDLE input → it stays put,
 * so the detonation samples exactly the staged position.
 */
const fp = makeFeelParams();
const IDLE: InputFrame = NO_INPUT;

/** Park a player on row 1 at millitile X, detonate the staged bomb, return survival. */
function survivesAt(posX: number): boolean {
  const base = createInitialState(0, fp, 2, { pvp: true, teams: [0, 1] });
  const map = new Uint8Array(base.map);
  map[idx(1, 1)] = TileKind.EMPTY; // bomb tile
  map[idx(2, 1)] = TileKind.EMPTY; // flame tile (fire-1 right arm)
  map[idx(3, 1)] = TileKind.EMPTY; // safe tile next to the flame
  const players = base.players.map(clonePlayer);
  players[0]!.posX = posX;
  players[0]!.posY = 1 * MILLITILE; // row 1 centre → pure horizontal straddle
  players[1]!.posX = 13 * MILLITILE; // park the other player far from the blast
  players[1]!.posY = 11 * MILLITILE;
  const bombs = [{ ownerSlot: 0, tileX: 1, tileY: 1, fuseTicks: 1, fire: 1 }];
  const st: SimState = tick({ ...base, map, players, bombs }, [IDLE, IDLE]);
  return !st.players[0]!.trapped && st.players[0]!.alive;
}

describe('卡縫躲爆 — edging a flame in a real tick()', () => {
  it('dies dead-centre on the flame tile (100% coverage)', () => {
    expect(survivesAt(2 * MILLITILE)).toBe(false);
  });
  it('dies at 70% into the flame (≥ 2/3)', () => {
    expect(survivesAt(2 * MILLITILE + 300)).toBe(false);
  });
  it('SURVIVES at 60% into the flame — old centre model would have trapped it', () => {
    expect(survivesAt(2 * MILLITILE + 400)).toBe(true);
  });
  it('survives half-body on the edge (50%)', () => {
    expect(survivesAt(2 * MILLITILE + 500)).toBe(true);
  });
  it('survives mostly in the safe tile (40%)', () => {
    expect(survivesAt(2 * MILLITILE + 600)).toBe(true);
  });
});
