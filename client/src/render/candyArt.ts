/**
 * Candy art — the "milk-cream" (牛奶奶油) visual language, ported tile-for-tile
 * from the `IsoArena` design comp (Choccus UI與地圖重設計/IsoArena.dc.html).
 *
 * Pure presentation: each builder returns a CSS string or an HTML string for a
 * stack of absolutely-positioned <div>s inside a TW×TH cell. The Renderer drops
 * these into pooled DOM nodes and only moves them (transform) per frame.
 *
 * Geometry: every entity is authored inside a single TW×TH cell with the tile
 * top-left at (0,0); cx/cy are the cell centre. Cubes raise a "top face" by
 * `pop` px to fake 2.5D depth; glows/blobs deliberately overflow the cell.
 */

import { ItemKind } from '../../../shared/types';

// Cell pitch (design: chunky 48-wide tiles, 44 tall) + board padding + cube pop.
export const TW = 48;
export const TH = 44;
export const PAD_X = 16;
export const PAD_TOP = 24;
export const PAD_BOT = 14;
const POP_WALL = 13;
const POP_BLOCK = 9;
const CX = TW / 2; // 24
const CY = TH / 2; // 22

/** Per-team body palette (design `players[]`: pink · mint · caramel · blue). */
export const TEAM_PALETTE = [
  { hi: '#FFD9E3', base: '#F2849E', lo: '#D85F7C' }, // 0 strawberry
  { hi: '#CFF0E4', base: '#7FD1B9', lo: '#4FAF94' }, // 1 mint
  { hi: '#FBDEAE', base: '#E8A24A', lo: '#C57E25' }, // 2 caramel
  { hi: '#CFDBFB', base: '#8FA8E8', lo: '#6480D0' }, // 3 blueberry
] as const;

export function teamPalette(team: number): (typeof TEAM_PALETTE)[number] {
  return TEAM_PALETTE[team % TEAM_PALETTE.length] ?? TEAM_PALETTE[0];
}

const MILK = {
  grout: '#C99C63',
  floorA: '#EAC98E',
  floorB: '#E2BC80',
  wall: { hi: '#8C5C36', base: '#5E3A20', lo: '#341F0E' },
  block: { hi: '#FFF7E8', base: '#F2DFBC', lo: '#D6B988' },
  bombHi: '#7a5238',
  bombMid: '#3f2415',
  bombLo: '#1c0d07',
  spark: '#FFE3A1',
  sparkGlow: '#FF9B3D',
  explGlow: 'rgba(110,64,32,.55)',
  explHi: '#C98A50',
  explMid: '#8A5226',
  explLo: '#4E2A12',
  explCore: '#F4D7A0',
  eye: '#3A2A22',
  cheek: 'rgba(244,120,150,.55)',
} as const;

// Whipped-meringue dome trapping a caught cutie (design SHELL).
const SHELL = {
  body: 'linear-gradient(168deg,#FBE9C6,#EDD09A 56%,#D4B179)',
  eye: '#7A5A34',
  shell:
    'radial-gradient(circle at 34% 26%, rgba(255,255,255,.95), rgba(255,250,236,.42) 44%, rgba(250,228,182,.4) 70%, rgba(240,210,150,.5))',
} as const;

/** Per item kind: same candy diamond, tinted so kinds stay distinguishable. */
const ITEM_PAL: Record<number, { a: string; b: string; glow: string }> = {
  [ItemKind.FIRE]: { a: '#FFC8D8', b: '#F2849E', glow: 'rgba(242,132,158,.65)' },
  [ItemKind.SPEED]: { a: '#CFF0E4', b: '#7FD1B9', glow: 'rgba(127,209,185,.65)' },
  [ItemKind.CANNON]: { a: '#FBDEAE', b: '#E8A24A', glow: 'rgba(232,162,74,.6)' },
};

// ---------------------------------------------------------------------------
// Board + floor
// ---------------------------------------------------------------------------

export function boardCss(cols: number, rows: number): string {
  const w = cols * TW + PAD_X * 2;
  const h = rows * TH + PAD_TOP + PAD_BOT;
  return (
    `position:relative;width:${w}px;height:${h}px;` +
    `background:radial-gradient(130% 120% at 50% 28%,#FBEAD0,#EFD3A4);`
  );
}

export function boardSize(cols: number, rows: number): { w: number; h: number } {
  return { w: cols * TW + PAD_X * 2, h: rows * TH + PAD_TOP + PAD_BOT };
}

/** Pixel top-left of a tile cell (for tile-locked entities). */
export function cellLeft(tileX: number): number {
  return PAD_X + tileX * TW;
}
export function cellTop(tileY: number): number {
  return PAD_TOP + tileY * TH;
}

/** Floor under every cell: grout edge + checkerboard top. */
export function floorHtml(checker: number): string {
  const top = checker ? MILK.floorA : MILK.floorB;
  return (
    `<div style="position:absolute;inset:0;background:${MILK.grout};border-radius:6px;"></div>` +
    `<div style="position:absolute;left:1px;top:1px;width:${TW - 2}px;height:${TH - 2}px;` +
    `border-radius:6px;background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(0,0,0,.05)),${top};"></div>`
  );
}

/** Raised 2.5D cube faces for a hard wall or soft brick. */
export function cubeHtml(kind: 'wall' | 'block'): string {
  const c = kind === 'wall' ? MILK.wall : MILK.block;
  const pop = kind === 'wall' ? POP_WALL : POP_BLOCK;
  return (
    `<div style="position:absolute;left:4px;top:${TH - pop - 2}px;width:${TW - 8}px;height:${pop + 6}px;` +
    `border-radius:0 0 13px 13px;background:${c.lo};"></div>` +
    `<div style="position:absolute;left:2px;top:${-pop}px;width:${TW - 4}px;height:${TH - 2}px;` +
    `border-radius:16px 16px 13px 13px;background:linear-gradient(168deg,${c.hi},${c.base} 54%,${c.lo});` +
    `box-shadow:0 3px 6px rgba(72,40,18,.16),inset 0 -5px 7px rgba(60,32,14,.16),inset 0 5px 8px rgba(255,255,255,.4);"></div>` +
    `<div style="position:absolute;left:9px;top:${-pop + 5}px;width:${TW - 24}px;height:13px;` +
    `border-radius:9px;background:radial-gradient(closest-side,rgba(255,255,255,.6),rgba(255,255,255,0));"></div>`
  );
}

// ---------------------------------------------------------------------------
// Entities (authored inside a TW×TH cell)
// ---------------------------------------------------------------------------

// Soft contact shadow. A radial-gradient ellipse (not filter:blur) so it costs
// no per-frame blur pass when the entity above it moves.
const shadowHtml =
  `<div style="position:absolute;left:${CX - 18}px;top:${TH - 15}px;width:36px;height:15px;` +
  `border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.24),transparent);"></div>`;

/** Truffle bomb with a glowing fuse spark (pulse via cc-bomb keyframe). */
export function bombHtml(): string {
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 18}px;top:${CY - 21}px;width:36px;height:36px;border-radius:50%;` +
    `background:radial-gradient(circle at 34% 28%,${MILK.bombHi},${MILK.bombMid} 46%,${MILK.bombLo});` +
    `box-shadow:0 7px 10px rgba(0,0,0,.3),inset 0 -3px 5px rgba(0,0,0,.4);animation:cc-bomb 1s ease-in-out infinite;"></div>` +
    `<div style="position:absolute;left:${CX - 7}px;top:${CY - 17}px;width:12px;height:8px;border-radius:50%;` +
    `background:rgba(255,255,255,.6);filter:blur(1px);"></div>` +
    `<div style="position:absolute;left:${CX + 7}px;top:${CY - 28}px;width:9px;height:9px;border-radius:50%;` +
    `background:${MILK.spark};box-shadow:0 0 12px 4px ${MILK.sparkGlow};animation:cc-spark 1.2s ease-in-out infinite;"></div>`
  );
}

/** Candy-diamond power-up, tinted per item kind. */
export function itemHtml(kind: number): string {
  const p = ITEM_PAL[kind] ?? ITEM_PAL[ItemKind.FIRE]!;
  return (
    `<div style="position:absolute;left:${CX - 24}px;top:${CY - 26}px;width:48px;height:48px;border-radius:50%;` +
    `background:radial-gradient(circle,${p.glow},transparent 64%);"></div>` +
    `<div style="position:absolute;left:${CX - 14}px;top:${CY - 16}px;width:28px;height:28px;border-radius:9px;` +
    `transform:rotate(45deg);background:linear-gradient(135deg,${p.a},${p.b});` +
    `box-shadow:0 5px 8px rgba(0,0,0,.22),inset 0 2px 3px rgba(255,255,255,.5);"></div>` +
    `<div style="position:absolute;left:${CX - 8}px;top:${CY - 10}px;width:8px;height:8px;border-radius:50%;` +
    `background:rgba(255,255,255,.85);"></div>`
  );
}

/** Melt-flow cell. `center` adds the bright ring + core + droplets. */
export function explosionHtml(center: boolean): string {
  // Arm cells (the many ones in a cross/chain) use ONLY radial-gradient fills —
  // no box-shadow blur — so a burst of cells stays cheap to rasterize. The soft
  // halo comes from the large gradient glow div, not a per-cell shadow.
  let h =
    `<div style="position:absolute;left:${CX - 50}px;top:${CY - 46}px;width:100px;height:92px;border-radius:50%;` +
    `background:radial-gradient(circle,${MILK.explGlow},transparent 68%);"></div>` +
    `<div style="position:absolute;left:${CX - 26}px;top:${CY - 24}px;width:52px;height:48px;` +
    `border-radius:52% 48% 50% 50%/56% 52% 48% 44%;` +
    `background:radial-gradient(circle at 42% 36%,${MILK.explHi},${MILK.explMid} 56%,${MILK.explLo});"></div>`;
  if (center) {
    // Only one centre cell per blast → a little extra detail here is affordable.
    h +=
      `<div style="position:absolute;left:${CX - 33}px;top:${CY - 29}px;width:66px;height:58px;border-radius:50%;` +
      `border:5px solid ${MILK.explMid};opacity:.5;"></div>` +
      `<div style="position:absolute;left:${CX - 16}px;top:${CY - 14}px;width:32px;height:28px;border-radius:50%;` +
      `background:radial-gradient(circle,${MILK.explCore},${MILK.explHi} 70%);box-shadow:0 0 12px 3px ${MILK.explCore};"></div>` +
      `<div style="position:absolute;left:${CX - 34}px;top:${CY - 24}px;width:12px;height:12px;border-radius:50%;background:${MILK.explMid};"></div>` +
      `<div style="position:absolute;left:${CX + 22}px;top:${CY - 20}px;width:10px;height:10px;border-radius:50%;background:${MILK.explHi};"></div>` +
      `<div style="position:absolute;left:${CX - 28}px;top:${CY + 16}px;width:9px;height:9px;border-radius:50%;background:${MILK.explLo};"></div>` +
      `<div style="position:absolute;left:${CX + 26}px;top:${CY + 14}px;width:11px;height:11px;border-radius:50%;background:${MILK.explMid};"></div>`;
  }
  return h;
}

/**
 * Player mascot: chef-hat cutie, or a steel robot-chef when `isBot`. The face
 * (eyes/cheeks/mouth, or the robot visor/LED/grille) shifts toward the facing
 * direction (dx/dy ∈ {-1,0,1}) for down/left/right. Facing UP means facing
 * away from the camera, so the face is hidden and the back of the head shows
 * (a plain hatted nape / a brushed-steel vent panel). Reads at a glance.
 */
export function playerHtml(team: number, isBot: boolean, dx = 0, dy = 0): string {
  const col = teamPalette(team);
  const fx = dx * 5; // cutie face horizontal shift
  const fy = dy * 4; // cutie face vertical shift
  const vx = dx * 5; // robot visor horizontal shift
  const vy = dy * 3; // robot visor vertical shift
  const facingUp = dy < 0; // facing away from camera → show the back of the head
  if (isBot) {
    // Front face (visor + LED + grille), shifted toward the facing direction.
    const front =
      `<div style="position:absolute;left:${CX - 14 + vx}px;top:${-1 + vy}px;width:28px;height:13px;border-radius:7px;` +
      `background:linear-gradient(180deg,#222831,#3C4651 70%,#525E6B);` +
      `box-shadow:inset 0 1px 2px rgba(0,0,0,.6),inset 0 -1px 1px rgba(255,255,255,.18),0 1px 1px rgba(255,255,255,.35);"></div>` +
      `<div style="position:absolute;left:${CX - 10 + vx}px;top:${3 + vy}px;width:20px;height:5px;border-radius:3px;` +
      `background:linear-gradient(90deg,${col.base},${col.hi} 50%,${col.base});box-shadow:0 0 9px 1px ${col.base};"></div>` +
      `<div style="position:absolute;left:${CX - 6 + vx}px;top:15px;width:12px;height:5px;border-radius:2px;` +
      `background:repeating-linear-gradient(90deg,#2C333C 0 1.4px,#7E8A96 1.4px 2.8px);"></div>`;
    // Back of the head when facing up: a brushed-steel panel with cooling vents.
    const back =
      `<div style="position:absolute;left:${CX - 11}px;top:0px;width:22px;height:13px;border-radius:6px;` +
      `background:linear-gradient(180deg,#D6DCE3,#9BA5B0);box-shadow:inset 0 1px 1px rgba(255,255,255,.75),inset 0 -2px 3px rgba(0,0,0,.22);"></div>` +
      `<div style="position:absolute;left:${CX - 7}px;top:3px;width:14px;height:2px;border-radius:1px;background:rgba(0,0,0,.24);"></div>` +
      `<div style="position:absolute;left:${CX - 7}px;top:7px;width:14px;height:2px;border-radius:1px;background:rgba(0,0,0,.24);"></div>`;
    return (
      shadowHtml +
      `<div style="position:absolute;left:${CX - 17}px;top:-13px;width:34px;height:40px;` +
      `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:linear-gradient(168deg,#F1F4F8,#AEB8C2 56%,#7C8893);` +
      `box-shadow:0 8px 11px rgba(0,0,0,.3),inset 0 -5px 7px rgba(0,0,0,.2),inset 0 5px 7px rgba(255,255,255,.65);"></div>` +
      `<div style="position:absolute;left:${CX - 14}px;top:-15px;width:28px;height:8px;border-radius:6px;` +
      `background:linear-gradient(180deg,#C9D0D8,#929BA6);box-shadow:0 2px 3px rgba(0,0,0,.2),inset 0 1px 1px rgba(255,255,255,.95);"></div>` +
      `<div style="position:absolute;left:${CX - 16}px;top:-30px;width:32px;height:21px;` +
      `border-radius:52% 52% 30% 30%/72% 72% 36% 36%;background:radial-gradient(circle at 38% 30%,#FFFFFF,#DFE4EA);` +
      `box-shadow:inset 0 3px 5px rgba(255,255,255,.92),inset 0 -3px 4px rgba(0,0,0,.1),0 3px 4px rgba(0,0,0,.16);"></div>` +
      `<div style="position:absolute;left:${CX - 1}px;top:-44px;width:3px;height:15px;border-radius:2px;` +
      `background:linear-gradient(180deg,#C7CED6,#8A95A1);"></div>` +
      `<div style="position:absolute;left:${CX - 6}px;top:-51px;width:12px;height:12px;border-radius:50%;` +
      `background:radial-gradient(circle at 35% 30%,#FFFFFF,${col.base});box-shadow:0 0 11px 3px ${col.base};"></div>` +
      `<div style="position:absolute;left:${CX - 19}px;top:1px;width:8px;height:8px;border-radius:50%;` +
      `background:radial-gradient(circle at 38% 32%,#F1F4F8,#8D98A4);box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.2);"></div>` +
      `<div style="position:absolute;left:${CX + 11}px;top:1px;width:8px;height:8px;border-radius:50%;` +
      `background:radial-gradient(circle at 38% 32%,#F1F4F8,#8D98A4);box-shadow:inset 0 0 0 1.5px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.2);"></div>` +
      (facingUp ? back : front)
    );
  }
  // Front face, shifted toward the facing direction.
  const front =
    `<div style="position:absolute;left:${CX - 8 + fx}px;top:${0 + fy}px;width:5px;height:8px;border-radius:50%;background:${MILK.eye};"></div>` +
    `<div style="position:absolute;left:${CX + 3 + fx}px;top:${0 + fy}px;width:5px;height:8px;border-radius:50%;background:${MILK.eye};"></div>` +
    `<div style="position:absolute;left:${CX - 13 + fx}px;top:${6 + fy}px;width:8px;height:4px;border-radius:50%;background:${MILK.cheek};"></div>` +
    `<div style="position:absolute;left:${CX + 5 + fx}px;top:${6 + fy}px;width:8px;height:4px;border-radius:50%;background:${MILK.cheek};"></div>` +
    `<div style="position:absolute;left:${CX - 3 + fx}px;top:${7 + fy}px;width:7px;height:4px;border-radius:0 0 9px 9px;background:${col.lo};"></div>`;
  // Back of the head when facing up: no face, just a centre seam + nape shadow.
  const back =
    `<div style="position:absolute;left:${CX - 1}px;top:0px;width:2px;height:12px;border-radius:1px;background:rgba(0,0,0,.08);"></div>` +
    `<div style="position:absolute;left:${CX - 9}px;top:8px;width:18px;height:5px;border-radius:50%;background:rgba(0,0,0,.07);filter:blur(1px);"></div>`;
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 17}px;top:-13px;width:34px;height:40px;` +
    `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:linear-gradient(168deg,${col.hi},${col.base} 56%,${col.lo});` +
    `box-shadow:0 8px 11px rgba(0,0,0,.25),inset 0 -5px 7px rgba(0,0,0,.14),inset 0 5px 7px rgba(255,255,255,.45);"></div>` +
    `<div style="position:absolute;left:${CX - 14}px;top:-15px;width:28px;height:8px;border-radius:6px;` +
    `background:linear-gradient(180deg,#FFFFFF,#EFE7D8);box-shadow:0 2px 3px rgba(0,0,0,.14),inset 0 1px 1px rgba(255,255,255,.9);"></div>` +
    `<div style="position:absolute;left:${CX - 16}px;top:-30px;width:32px;height:21px;` +
    `border-radius:52% 52% 30% 30%/72% 72% 36% 36%;background:radial-gradient(circle at 38% 30%,#FFFFFF,#EFE7D8);` +
    `box-shadow:inset 0 3px 5px rgba(255,255,255,.92),inset 0 -3px 4px rgba(0,0,0,.07),0 3px 4px rgba(0,0,0,.12);"></div>` +
    (facingUp ? back : front)
  );
}

/** Sugar-shell dome over a sealed cutie (trapped player). */
export function shellHtml(): string {
  return (
    shadowHtml +
    `<div style="position:absolute;left:${CX - 15}px;top:-6px;width:30px;height:34px;` +
    `border-radius:48% 48% 45% 45%/54% 54% 44% 44%;background:${SHELL.body};box-shadow:inset 0 -4px 6px rgba(0,0,0,.16);"></div>` +
    `<div style="position:absolute;left:${CX - 7}px;top:4px;width:5px;height:5px;border-radius:50%;background:${SHELL.eye};"></div>` +
    `<div style="position:absolute;left:${CX + 2}px;top:4px;width:5px;height:5px;border-radius:50%;background:${SHELL.eye};"></div>` +
    `<div style="position:absolute;left:${CX - 22}px;top:-13px;width:44px;height:48px;` +
    `border-radius:50% 50% 47% 47%/55% 55% 45% 45%;background:${SHELL.shell};border:2px solid rgba(255,255,255,.78);` +
    `box-shadow:inset 0 -8px 13px rgba(214,170,110,.4),inset 0 8px 13px rgba(255,255,255,.8),0 6px 11px rgba(0,0,0,.16);"></div>` +
    `<div style="position:absolute;left:${CX - 11}px;top:-8px;width:12px;height:19px;border-radius:50%;` +
    `background:rgba(255,255,255,.85);transform:rotate(20deg);filter:blur(.5px);"></div>` +
    `<div style="position:absolute;left:${CX + 7}px;top:-10px;width:6px;height:6px;border-radius:1px;` +
    `background:#fff;transform:rotate(45deg);box-shadow:0 0 7px 2px rgba(255,255,255,.9);"></div>`
  );
}

/** Keyframes used by bomb fuse / sudden-death pill — injected once by Renderer. */
export const CANDY_KEYFRAMES = `
@keyframes cc-bomb{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@keyframes cc-spark{0%,100%{opacity:.7;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
@keyframes cc-danger{0%,100%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 0 0 rgba(255,80,60,.5)}50%{box-shadow:0 8px 18px rgba(74,42,24,.4),0 0 22px 6px rgba(255,80,60,.6)}}
`;
