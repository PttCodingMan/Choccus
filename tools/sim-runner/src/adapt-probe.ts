/**
 * adapt-probe — does the v8 ADAPTIVE COUNTER actually exploit a FIXED opponent?
 *
 * The bench (v5-screen / bt-rank) is all bot-vs-near-optimal-bot and symmetric, so
 * an adaptive lever reads ~neutral there (§14). The thing humans do — read a
 * predictable opponent and switch to its counter — only PAYS against an opponent
 * with persistent, exploitable tendencies. This probe measures exactly that: it
 * pits v8:zoner with the adaptive counter OFF and ON against the SAME fixed
 * opponent under IDENTICAL CRN seeds, in ONE process, and prints the paired
 * win-rate delta. A positive, significant Δ on a fixed opponent = the counter is
 * doing real work that the symmetric bench cannot credit.
 *
 * Opponents are deliberately NON-adapting "strategy A"s:
 *   - script:sealer  — hand-scripted, maximally predictable: rush the foe, drop a
 *                      bomb when in range IFF a validated escape exists, flee, repeat
 *                      (the advancing-seal pattern the detector is built to read).
 *   - script:rusher  — like sealer but bombs at point-blank only (cruder, faster).
 *   - v7:trapper     — the frozen yardstick's real sealer (vChain wall-in).
 *   - v7:hunter      — the frozen yardstick's pure rusher.
 *   - v7:runner      — pure survival control (should be ~flat: nothing to counter).
 * The scripted bots ride a survival reflex (flee when their tile will ignite; never
 * bomb without a reachable refuge) so they pressure the target instead of suiciding
 * — but they NEVER learn, so they are perfectly exploitable.
 *
 * Determinism: the scripted opponents are pure functions of SimState (no RNG / no
 * wall-clock), and the adaptive OFF/ON target differs ONLY in the v8 ctor `adaptive`
 * bit, so the two passes are truly paired per seed. tools/ script: Math.* is fine.
 *
 *   npm run adapt-probe -- [--repeats=80] [--map=classic,pirate]
 *     [--opponents=script:sealer,v7:trapper,v7:hunter]
 */
import { ActionFlags, Direction } from '../../../shared/types';
import { SPARK_TICKS } from '../../../shared/constants';
import { type InputFrame, NO_INPUT } from '../../../client/src/sim/InputBuffer';
import { tileOf } from '../../../client/src/sim/Player';
import { bombAt } from '../../../client/src/sim/Bomb';
import type { IBotController } from '../../../client/src/ai/common/IBotController';
import type { SimState } from '../../../client/src/sim/Sim';
import {
  bfsFirstStep,
  dangerAwarePassable,
  findNearestSafe,
  hypotheticalBomb,
  isSafeTile,
  openPassable,
  predictDanger,
} from '../../../client/src/ai/common/grid';
import { BotController } from '../../../client/src/ai/v8/BotController';
import { botSeed } from '../../../client/src/ai/v8/BotConfig';
import { resolveStrategy } from '../../../client/src/ai/v8/Strategies';

import {
  type Agent,
  type MapKind,
  MAPS,
  makeController,
  runMatchSeeded,
} from './bench-utils';
import { DUEL_N, scenarioSeed } from './matrix-runner';
import { arg } from './bt-common';

/** Movement danger horizon (a tile igniting within this is "not walkable"). */
const STEP_HORIZON = SPARK_TICKS + 4;

const zonerTuning = resolveStrategy('zoner')!.tuning;

// ---------------------------------------------------------------------------
// Scripted, NON-adapting opponents (pure functions of SimState; ride a survival
// reflex so they threaten rather than suicide, but never learn → exploitable).
// ---------------------------------------------------------------------------

/** First-step direction toward the nearest tile satisfying `isGoal`, over
 *  danger-aware open passability; Direction.NONE if none reachable. */
function stepToward(
  state: SimState,
  mx: number,
  my: number,
  isGoal: (x: number, y: number) => boolean,
  danger: ReturnType<typeof predictDanger>,
): number {
  const passable = dangerAwarePassable(openPassable(state), danger, STEP_HORIZON);
  const hit = bfsFirstStep(state, mx, my, isGoal, passable);
  return hit === null ? Direction.NONE : hit.firstDir;
}

/** True iff, after dropping a bomb on (mx,my), a reachable refuge OTHER than the
 *  (now-doomed) current tile still exists — the anti-suicide gate. */
function hasEscapeAfterBomb(
  state: SimState,
  slot: number,
  mx: number,
  my: number,
  fire: number,
): boolean {
  const danger = predictDanger(state, [hypotheticalBomb(mx, my, fire, slot)]);
  const safe = findNearestSafe(state, mx, my, danger);
  return safe !== null && !(safe[0] === mx && safe[1] === my);
}

/** A fixed rush-bomb-flee controller. `bombRange` = Manhattan distance at which it
 *  commits a bomb (3 = sealer / set-up from range, 1 = rusher / point-blank). */
class ScriptedAggressor implements IBotController {
  constructor(private readonly bombRange: number) {}

  sample(state: SimState, slot: number): InputFrame {
    const me = state.players[slot]!;
    if (!me.alive || me.trapped) return NO_INPUT;
    const myTeam = me.team;
    const mx = tileOf(me.posX);
    const my = tileOf(me.posY);
    const danger = predictDanger(state);

    // Survival reflex: if our tile will ignite, flee to the nearest safe tile.
    if (!isSafeTile(state, danger, mx, my)) {
      const d = stepToward(state, mx, my, (x, y) => isSafeTile(state, danger, x, y), danger);
      return d === Direction.NONE ? NO_INPUT : { dir: d, action: ActionFlags.NONE };
    }

    // Locate the nearest living enemy by open-path BFS.
    const foeHit = bfsFirstStep(
      state,
      mx,
      my,
      (x, y) => {
        for (const p of state.players) {
          if (p.alive && !p.trapped && p.team !== myTeam && tileOf(p.posX) === x && tileOf(p.posY) === y) {
            return true;
          }
        }
        return false;
      },
      openPassable(state),
    );

    if (foeHit !== null) {
      const [fx, fy] = foeHit.target;
      const man = Math.abs(mx - fx) + Math.abs(my - fy);
      // Drop a bomb when in range, with a free cannon and a validated escape.
      if (
        man <= this.bombRange &&
        me.activeBombs < me.cannon &&
        bombAt(state.bombs, mx, my) === undefined &&
        hasEscapeAfterBomb(state, slot, mx, my, me.fire)
      ) {
        return { dir: Direction.NONE, action: ActionFlags.BOMB };
      }
      // Otherwise advance on the foe (danger-aware).
      const d = stepToward(state, mx, my, (x, y) => x === fx && y === fy, danger);
      if (d !== Direction.NONE) return { dir: d, action: ActionFlags.NONE };
    }
    return NO_INPUT;
  }
}

function makeScripted(name: string): IBotController {
  if (name === 'sealer') return new ScriptedAggressor(3);
  if (name === 'rusher') return new ScriptedAggressor(1);
  throw new Error(`unknown scripted opponent: ${name}`);
}

// ---------------------------------------------------------------------------
// Opponent specs + the paired probe.
// ---------------------------------------------------------------------------

interface Opp {
  id: string;
  /** null = scripted (use `script`); else a real archetype from AI_VERSIONS. */
  version: number | null;
  archetype: string;
}

function parseOpp(s: string): Opp {
  if (s.startsWith('script:')) return { id: s, version: null, archetype: s.slice('script:'.length) };
  const m = /^v(\d+):(.+)$/.exec(s);
  if (m === null) throw new Error(`bad opponent spec: ${s} (want script:<name> or v<N>:<arch>)`);
  return { id: s, version: Number(m[1]), archetype: m[2]! };
}

/** Sentinel target agent (slot-0 pool entry); the makeCtrl closure recognises it
 *  by reference and builds the adaptive-bit v8:zoner for it. */
const TARGET_AGENT: Agent = { version: 8, archetypeKey: 'zoner', label: 'v8:zoner' };

/** Run R repeats × 2 seatings of v8:zoner (adaptive=bit) vs one opponent under CRN
 *  scenario seeds, returning the per-game target win credit keyed by "repeat|seat"
 *  (1 = win, 0.5 = draw, 0 = loss) so OFF and ON pass can be paired per seed. */
function runPass(opp: Opp, mapKind: MapKind, mapIndex: number, repeats: number, adaptive: boolean): Map<string, number> {
  const oppAgent: Agent = {
    version: opp.version ?? -1,
    archetypeKey: opp.archetype,
    label: opp.id,
  };
  const agents: Agent[] = [TARGET_AGENT, oppAgent];
  const makeCtrl = (a: Agent, seed: number, slot: number): IBotController => {
    if (a === TARGET_AGENT) {
      return new BotController(botSeed(seed, slot), zonerTuning, slot, null, adaptive);
    }
    if (a.version === -1) return makeScripted(a.archetypeKey);
    return makeController(a.version, a.archetypeKey, seed, slot);
  };

  const out = new Map<string, number>();
  for (let r = 0; r < repeats; r++) {
    const seed = scenarioSeed(mapIndex, r);
    for (let seat = 0; seat < 2; seat++) {
      const slotAgent = seat === 0 ? [0, 1] : [1, 0];
      const rec = runMatchSeeded(seed, slotAgent, agents, mapKind, DUEL_N, undefined, makeCtrl);
      const credit = rec.draw ? 0.5 : rec.winnerAgent === 0 ? 1 : 0;
      out.set(`${r}|${seat}`, credit);
    }
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Paired z = mean(diff) / se(diff); 0 if too few / no spread. */
function pairedZ(d: number[]): number {
  const n = d.length;
  if (n < 2) return 0;
  const m = mean(d);
  let v = 0;
  for (const x of d) v += (x - m) * (x - m);
  v /= n - 1;
  const se = Math.sqrt(v / n);
  return se < 1e-9 ? 0 : m / se;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeats = Number(arg(argv, 'repeats', '80'));
  const mapArg = arg(argv, 'map', 'classic,pirate');
  const maps = mapArg.split(',').map((s) => s.trim()).filter((s) => MAPS.includes(s as MapKind)) as MapKind[];
  const oppArg = arg(argv, 'opponents', 'script:sealer,script:rusher,v7:trapper,v7:hunter,v7:runner');
  const opps = oppArg.split(',').map((s) => parseOpp(s.trim()));

  console.log(
    `adapt-probe — v8:zoner adaptive OFF vs ON, paired CRN, ${repeats} reps × 2 seats\n` +
      `  opponents: ${opps.map((o) => o.id).join(', ')}\n` +
      `  maps: ${maps.join(', ')}\n`,
  );

  for (const map of maps) {
    const mapIndex = MAPS.indexOf(map);
    console.log(`== ${map} ==`);
    console.log(`  ${'opponent'.padEnd(16)} ${'off%'.padStart(7)} ${'on%'.padStart(7)} ${'Δ'.padStart(7)}  ${'z'.padStart(6)}`);
    for (const opp of opps) {
      const off = runPass(opp, map, mapIndex, repeats, false);
      const on = runPass(opp, map, mapIndex, repeats, true);
      const offVals: number[] = [];
      const onVals: number[] = [];
      const diffs: number[] = [];
      for (const key of off.keys()) {
        const a = off.get(key)!;
        const b = on.get(key)!;
        offVals.push(a);
        onVals.push(b);
        diffs.push(b - a);
      }
      const offPct = mean(offVals) * 100;
      const onPct = mean(onVals) * 100;
      const delta = onPct - offPct;
      const z = pairedZ(diffs);
      const tag = z > 1.5 ? ' ↑' : z < -1.5 ? ' ↓' : '';
      console.log(
        `  ${opp.id.padEnd(16)} ${offPct.toFixed(1).padStart(7)} ${onPct.toFixed(1).padStart(7)} ` +
          `${(delta >= 0 ? '+' : '') + delta.toFixed(1)}`.padStart(8) +
          `  ${(z >= 0 ? '+' : '') + z.toFixed(1)}`.padStart(7) + tag,
      );
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
