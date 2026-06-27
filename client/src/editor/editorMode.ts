/**
 * Visual MAP EDITOR (?mode=editor). Paint a 15×13 grid of tiles, then play-test
 * the result in solo. Purely a local dev/authoring tool: it only ever feeds the
 * LOCAL solo loopback path (via `registerCustomTemplate` in sim/Map.ts) — the
 * deterministic sim, the shipped map templates, golden and AI are untouched.
 *
 * Tile legend (matches sim/Map.ts template chars):
 *   `#`=HARD  `S`=SOFT  `P`=PUSH(able crate)  `.`=EMPTY  `@`=SPAWN (walkable).
 * A valid template has EXACTLY 4 `@` spawns; "Play test" / "Copy" stay disabled
 * until then.
 *
 * Visuals are ORIGINAL DOM (candy / chocolate palette consistent with FeelPanel
 * and LobbyUI) — no copyrighted assets.
 *
 * Flow:
 *   open ?mode=editor → pick a "Start from" template (default classic) → paint
 *   (click, or click-drag to stroke) with the selected brush → Play test
 *   (serializes the grid to sessionStorage and navigates to solo) / Copy template.
 * The working grid is persisted to sessionStorage on every edit, so returning
 * from a play-test ("← Edit map" link in solo) restores the in-progress map.
 */
import { MAP_COLS, MAP_ROWS } from '../../../shared/constants';
import { type MapKind, templateForKind } from '../sim/Map';
import { deleteSavedMap, getSavedMap, listSavedMaps, saveMap } from './savedMaps';

/** sessionStorage keys (shared with bootstrapSolo's custom-map play-test path). */
const GRID_KEY = 'choccus.editorGrid'; // in-progress editor grid (string[])
const CUSTOM_MAP_KEY = 'choccus.customMap'; // serialized map handed to solo (string[])
/** Sentinel map kind that solo recognizes as "load the editor's custom map". */
const CUSTOM_KIND = '__custom';

/** Brush = a paintable tile, identified by its template char. */
type BrushChar = '#' | 'S' | 'P' | '.' | '@';

interface Brush {
  char: BrushChar;
  label: string;
  /** Cell fill colour for this tile. */
  color: string;
  /** Letter colour for legibility on the fill. */
  ink: string;
}

/** Brush palette, in button order. */
const BRUSHES: readonly Brush[] = [
  { char: '#', label: 'Hard', color: '#3d1c02', ink: '#f5e6d3' },
  { char: 'S', label: 'Soft', color: '#f3e0c0', ink: '#7a4a2b' },
  { char: 'P', label: 'Push', color: '#c87f33', ink: '#fff7ea' },
  { char: '.', label: 'Empty', color: '#fbf3e6', ink: '#caa074' },
  { char: '@', label: 'Spawn', color: '#fbf3e6', ink: '#2e9e57' },
];

/** Lookup a brush by template char (defaults to EMPTY for unknown chars). */
function brushFor(ch: string): Brush {
  return BRUSHES.find((b) => b.char === ch) ?? BRUSHES[3]!;
}

/** A blank canvas (all EMPTY, no spawns). */
function blankGrid(): string[] {
  return Array.from({ length: MAP_ROWS }, () => '.'.repeat(MAP_COLS));
}

/**
 * Coerce arbitrary loaded data into a valid 15×13 char grid (clamp/pad so a
 * stale or malformed sessionStorage value can never crash the editor). Unknown
 * chars become EMPTY.
 */
function normalizeGrid(lines: readonly unknown[]): string[] {
  const out = blankGrid();
  for (let y = 0; y < MAP_ROWS; y++) {
    const raw = typeof lines[y] === 'string' ? (lines[y] as string) : '';
    let row = '';
    for (let x = 0; x < MAP_COLS; x++) {
      const ch = raw[x] ?? '.';
      row += '#SP.@'.includes(ch) ? ch : '.';
    }
    out[y] = row;
  }
  return out;
}

/** Parse a JSON string[] from sessionStorage, or null if absent/invalid. */
function loadGridJson(key: string): string[] | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return normalizeGrid(parsed);
  } catch {
    return null;
  }
}

/** Count `@` spawn tiles across the grid. */
function countSpawns(grid: readonly string[]): number {
  let n = 0;
  for (const row of grid) {
    for (const ch of row) if (ch === '@') n++;
  }
  return n;
}

/** The TS-pasteable block: 13 quoted, comma-terminated rows. */
function toTsBlock(grid: readonly string[]): string {
  return grid.map((row) => `  '${row}',`).join('\n');
}

export function runEditor(params: URLSearchParams): void {
  // ---- Working state ------------------------------------------------------
  // Seed order: a previously persisted in-progress grid wins (so play-test →
  // back restores work); otherwise start from ?from=<kind> (classic by default).
  const fromKind = (params.get('from') ?? 'classic').toLowerCase();
  const starterFor = (kind: string): string[] =>
    kind === '__blank'
      ? blankGrid()
      : normalizeGrid(templateForKind(kind as MapKind) ?? blankGrid());
  let grid: string[] = loadGridJson(GRID_KEY) ?? starterFor(fromKind);
  let brush: BrushChar = '#';
  let painting = false; // pointer is down (drag-to-stroke)

  // ---- Palette (matches FeelPanel / candy chrome) -------------------------
  const PALETTE = {
    card: 'rgba(46, 26, 12, 0.96)',
    text: '#f5e6d3',
    accent: '#ffb74d',
    soft: '#cfb497',
    button: '#6b3f1d',
    bad: '#ff8a80',
    good: '#9ccc65',
  };

  document.body.style.background = '#fbf1e0';

  const page = document.createElement('div');
  page.style.cssText =
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;' +
    'gap:14px;padding:18px 12px 40px;box-sizing:border-box;' +
    "font:14px/1.4 'Nunito',system-ui,sans-serif;color:#5a3a1f;";
  document.body.appendChild(page);

  const title = document.createElement('h1');
  title.textContent = '🍫 Map Editor';
  title.style.cssText = 'margin:0;font-size:22px;color:#7a4a2b;font-weight:800;';
  page.appendChild(title);

  // ---- Toolbar (start-from picker + brush palette) ------------------------
  const toolbar = document.createElement('div');
  toolbar.style.cssText =
    'display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;';
  page.appendChild(toolbar);

  // "Start from" picker.
  const startLabel = document.createElement('span');
  startLabel.textContent = 'Start from:';
  startLabel.style.cssText = 'font-weight:700;color:#7a4a2b;';
  toolbar.appendChild(startLabel);

  const startPicker = document.createElement('select');
  startPicker.style.cssText =
    'padding:6px 10px;background:#fff;color:#7a4a2b;border:none;border-radius:999px;' +
    'box-shadow:0 4px 0 #ead6b8;font:700 13px Nunito,system-ui,sans-serif;cursor:pointer;';
  const STARTERS: ReadonlyArray<readonly [string, string]> = [
    ['classic', 'Classic'],
    ['pirate', 'Pirate'],
    ['village', 'Village'],
    ['__blank', 'Blank (all empty)'],
  ];
  for (const [value, label] of STARTERS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    startPicker.appendChild(opt);
  }
  // Reflect ?from= in the picker when valid; else default to classic.
  startPicker.value = STARTERS.some(([v]) => v === fromKind) ? fromKind : 'classic';
  startPicker.addEventListener('change', () => {
    grid = starterFor(startPicker.value);
    persist();
    redrawGrid();
    refreshStatus();
  });
  toolbar.appendChild(startPicker);

  // Brush palette.
  const brushButtons: HTMLButtonElement[] = [];
  for (const b of BRUSHES) {
    const btn = document.createElement('button');
    btn.dataset.char = b.char;
    btn.textContent = `${b.label} (${b.char})`;
    btn.style.cssText =
      `padding:6px 12px;border:3px solid transparent;border-radius:999px;cursor:pointer;` +
      `background:${b.color};color:${b.ink};font:700 13px Nunito,system-ui,sans-serif;` +
      `box-shadow:0 4px 0 #ead6b8;`;
    btn.addEventListener('click', () => {
      brush = b.char;
      refreshBrushButtons();
    });
    brushButtons.push(btn);
    toolbar.appendChild(btn);
  }
  const refreshBrushButtons = (): void => {
    for (const btn of brushButtons) {
      btn.style.borderColor = btn.dataset.char === brush ? PALETTE.accent : 'transparent';
    }
  };

  // ---- The paintable grid -------------------------------------------------
  const board = document.createElement('div');
  board.style.cssText =
    `display:grid;grid-template-columns:repeat(${MAP_COLS}, 32px);` +
    `grid-template-rows:repeat(${MAP_ROWS}, 32px);gap:2px;padding:8px;` +
    'background:#7a4a2b;border-radius:12px;box-shadow:0 8px 28px rgba(43,26,14,0.35);' +
    'touch-action:none;user-select:none;';
  page.appendChild(board);

  // One cell <div> per tile; reused across redraws (only their look changes).
  const cells: HTMLDivElement[] = [];
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      const cell = document.createElement('div');
      cell.style.cssText =
        'width:32px;height:32px;display:flex;align-items:center;justify-content:center;' +
        'border-radius:5px;font:800 13px Nunito,system-ui,sans-serif;cursor:crosshair;';
      const px = x;
      const py = y;
      cell.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        painting = true;
        paintCell(px, py);
      });
      // pointerenter while the button is held = drag-to-stroke.
      cell.addEventListener('pointerenter', () => {
        if (painting) paintCell(px, py);
      });
      board.appendChild(cell);
      cells.push(cell);
    }
  }
  // Releasing anywhere ends a stroke (pointer may leave the board mid-drag).
  window.addEventListener('pointerup', () => {
    painting = false;
  });

  /** Set tile (x,y) to the active brush, persist, and repaint just that cell. */
  function paintCell(x: number, y: number): void {
    const i = y * MAP_COLS + x;
    const row = grid[y]!;
    if (row[x] === brush) return; // no-op, skip churn
    grid[y] = row.slice(0, x) + brush + row.slice(x + 1);
    drawCell(i);
    persist();
    refreshStatus();
  }

  /** Repaint a single cell from the grid. */
  function drawCell(i: number): void {
    const x = i % MAP_COLS;
    const y = Math.floor(i / MAP_COLS);
    const ch = grid[y]![x]!;
    const b = brushFor(ch);
    const cell = cells[i]!;
    cell.style.background = b.color;
    cell.style.color = b.ink;
    if (ch === '@') {
      // Spawn: a clear green ring marker on the floor tile.
      cell.textContent = '◉';
      cell.style.fontSize = '18px';
    } else if (ch === '.') {
      cell.textContent = '';
    } else {
      cell.textContent = ch;
      cell.style.fontSize = '13px';
    }
  }

  /** Repaint every cell (after a full grid swap). */
  function redrawGrid(): void {
    for (let i = 0; i < cells.length; i++) drawCell(i);
  }

  // ---- Status / validation ------------------------------------------------
  const status = document.createElement('div');
  status.style.cssText =
    'min-height:22px;font-weight:800;text-align:center;';
  page.appendChild(status);

  // ---- Action buttons (play test / copy) ----------------------------------
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;';
  page.appendChild(actions);

  const candyBtn = (text: string, bg: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText =
      `padding:9px 18px;border:none;border-radius:999px;cursor:pointer;background:${bg};` +
      'color:#fff7ea;font:800 14px Nunito,system-ui,sans-serif;box-shadow:0 4px 0 rgba(0,0,0,0.18);';
    actions.appendChild(btn);
    return btn;
  };

  const playBtn = candyBtn('▶ Play test', '#3aa35a');
  playBtn.addEventListener('click', () => {
    if (countSpawns(grid) !== 4) return;
    sessionStorage.setItem(GRID_KEY, JSON.stringify(grid));
    sessionStorage.setItem(CUSTOM_MAP_KEY, JSON.stringify(grid));
    window.location.assign(`?mode=solo&map=${CUSTOM_KIND}`);
  });

  const copyBtn = candyBtn('⧉ Copy template', PALETTE.button);
  copyBtn.addEventListener('click', () => {
    if (countSpawns(grid) !== 4) return;
    const block = toTsBlock(grid);
    void navigator.clipboard?.writeText(block).then(
      () => {
        copyBtn.textContent = '✓ Copied!';
        window.setTimeout(() => {
          copyBtn.textContent = '⧉ Copy template';
        }, 1400);
      },
      () => {
        /* clipboard blocked — the textarea fallback below holds the text */
      },
    );
    taOut.value = block;
    ta.open = true; // reveal the copy-paste fallback block
  });

  // ---- TS-block fallback textarea (also clipboard fallback) ---------------
  const ta = document.createElement('details');
  ta.style.cssText = 'width:min(92vw,420px);';
  const taSummary = document.createElement('summary');
  taSummary.textContent = 'TS template block (copy-paste)';
  taSummary.style.cssText = 'cursor:pointer;font-weight:700;color:#7a4a2b;';
  ta.appendChild(taSummary);
  const taOut = document.createElement('textarea');
  taOut.readOnly = true;
  taOut.rows = MAP_ROWS;
  taOut.style.cssText =
    'width:100%;margin-top:6px;box-sizing:border-box;padding:8px;border-radius:8px;' +
    'border:1px solid #d9bf9a;background:#fffaf2;color:#5a3a1f;' +
    "font:12px/1.35 'SFMono-Regular',ui-monospace,Menlo,monospace;resize:vertical;";
  ta.appendChild(taOut);
  page.appendChild(ta);

  /** Recompute spawn count → status message + enabled/greyed action buttons. */
  function refreshStatus(): void {
    const n = countSpawns(grid);
    const ok = n === 4;
    if (ok) {
      status.textContent = `✓ 4 spawns — ready to play test`;
      status.style.color = '#2e8b50';
    } else {
      status.textContent = `Spawns: ${n} / 4  —  paint exactly 4 @ to enable Play test & Copy`;
      status.style.color = n > 4 ? '#c0392b' : '#a06b2b';
    }
    for (const btn of [playBtn, copyBtn]) {
      btn.disabled = !ok;
      btn.style.opacity = ok ? '1' : '0.45';
      btn.style.cursor = ok ? 'pointer' : 'not-allowed';
    }
    // Keep the live fallback block in sync (handy even before copying).
    taOut.value = toTsBlock(grid);
  }

  /** Persist the in-progress grid so a play-test round-trip restores it. */
  function persist(): void {
    sessionStorage.setItem(GRID_KEY, JSON.stringify(grid));
  }

  // ---- "My maps" (localStorage persistence — solo only) -------------------
  // Saved maps live in this browser's localStorage and appear in the SOLO map
  // picker (never the net lobby — a remote client lacks the template → desync).
  const savedPanel = document.createElement('div');
  savedPanel.style.cssText =
    'display:flex;flex-direction:column;gap:8px;align-items:center;' +
    'padding:12px 16px;border-radius:14px;background:#fff;' +
    'box-shadow:0 4px 0 #ead6b8;width:min(92vw,420px);box-sizing:border-box;';
  page.appendChild(savedPanel);

  const savedTitle = document.createElement('div');
  savedTitle.textContent = '💾 My maps';
  savedTitle.style.cssText = 'font-weight:800;color:#7a4a2b;';
  savedPanel.appendChild(savedTitle);

  // Save row: name input + Save button.
  const saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;gap:8px;width:100%;';
  savedPanel.appendChild(saveRow);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Map name…';
  nameInput.maxLength = 40;
  nameInput.style.cssText =
    'flex:1;min-width:0;padding:8px 12px;border:1px solid #d9bf9a;border-radius:999px;' +
    'background:#fffaf2;color:#5a3a1f;font:600 13px Nunito,system-ui,sans-serif;';
  saveRow.appendChild(nameInput);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Save';
  saveBtn.style.cssText =
    'padding:8px 16px;border:none;border-radius:999px;cursor:pointer;background:#3aa35a;' +
    'color:#fff7ea;font:800 13px Nunito,system-ui,sans-serif;box-shadow:0 4px 0 rgba(0,0,0,0.18);';
  saveRow.appendChild(saveBtn);

  // Load/delete row: a dropdown of saved names + Load + 🗑 Delete.
  const loadRow = document.createElement('div');
  loadRow.style.cssText = 'display:flex;gap:8px;width:100%;';
  savedPanel.appendChild(loadRow);

  const savedPicker = document.createElement('select');
  savedPicker.style.cssText =
    'flex:1;min-width:0;padding:8px 12px;border:1px solid #d9bf9a;border-radius:999px;' +
    'background:#fffaf2;color:#5a3a1f;font:600 13px Nunito,system-ui,sans-serif;cursor:pointer;';
  loadRow.appendChild(savedPicker);

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load';
  loadBtn.style.cssText =
    'padding:8px 16px;border:none;border-radius:999px;cursor:pointer;background:#6b3f1d;' +
    'color:#fff7ea;font:800 13px Nunito,system-ui,sans-serif;box-shadow:0 4px 0 rgba(0,0,0,0.18);';
  loadRow.appendChild(loadBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '🗑';
  deleteBtn.title = 'Delete the selected saved map';
  deleteBtn.style.cssText =
    'padding:8px 14px;border:none;border-radius:999px;cursor:pointer;background:#c0392b;' +
    'color:#fff7ea;font:800 13px Nunito,system-ui,sans-serif;box-shadow:0 4px 0 rgba(0,0,0,0.18);';
  loadRow.appendChild(deleteBtn);

  // Inline feedback line (save confirmation / validation errors).
  const savedMsg = document.createElement('div');
  savedMsg.style.cssText = 'min-height:18px;font-weight:700;font-size:12px;text-align:center;';
  savedPanel.appendChild(savedMsg);

  /** Show a transient message (green=ok, red=error). */
  let savedMsgTimer = 0;
  const flashSavedMsg = (text: string, ok: boolean): void => {
    savedMsg.textContent = text;
    savedMsg.style.color = ok ? '#2e8b50' : '#c0392b';
    window.clearTimeout(savedMsgTimer);
    savedMsgTimer = window.setTimeout(() => {
      savedMsg.textContent = '';
    }, 2600);
  };

  /** Rebuild the saved-maps dropdown from localStorage; disable empty actions. */
  const refreshSavedList = (): void => {
    const prev = savedPicker.value;
    const names = listSavedMaps();
    savedPicker.replaceChildren();
    if (names.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no saved maps yet)';
      savedPicker.appendChild(opt);
    } else {
      for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        savedPicker.appendChild(opt);
      }
      if (names.includes(prev)) savedPicker.value = prev;
    }
    const empty = names.length === 0;
    for (const btn of [loadBtn, deleteBtn]) {
      btn.disabled = empty;
      btn.style.opacity = empty ? '0.45' : '1';
      btn.style.cursor = empty ? 'not-allowed' : 'pointer';
    }
  };

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (name === '') {
      flashSavedMsg('Please enter a name for the map.', false);
      return;
    }
    // Confirm before clobbering an existing name.
    if (getSavedMap(name) !== null && !window.confirm(`Overwrite the saved map "${name}"?`)) {
      return;
    }
    try {
      saveMap(name, grid); // validates (13×15, exactly 4 @) before writing
      refreshSavedList();
      savedPicker.value = name;
      flashSavedMsg(`Saved "${name}" ✓`, true);
    } catch (err) {
      flashSavedMsg(err instanceof Error ? err.message : 'Could not save map.', false);
    }
  });

  loadBtn.addEventListener('click', () => {
    const name = savedPicker.value;
    if (name === '') return;
    const lines = getSavedMap(name);
    if (lines === null) {
      flashSavedMsg(`"${name}" no longer exists.`, false);
      refreshSavedList();
      return;
    }
    if (!window.confirm(`Load "${name}"? This replaces the current map.`)) return;
    grid = normalizeGrid(lines);
    nameInput.value = name;
    persist();
    redrawGrid();
    refreshStatus();
    flashSavedMsg(`Loaded "${name}".`, true);
  });

  deleteBtn.addEventListener('click', () => {
    const name = savedPicker.value;
    if (name === '') return;
    if (!window.confirm(`Delete the saved map "${name}"?`)) return;
    deleteSavedMap(name);
    refreshSavedList();
    flashSavedMsg(`Deleted "${name}".`, true);
  });

  // ---- Help line ----------------------------------------------------------
  const help = document.createElement('div');
  help.style.cssText = 'max-width:520px;text-align:center;color:#8a6a47;font-size:12px;';
  help.textContent =
    'Click a brush, then click or click-drag on the grid to paint. ' +
    'A valid map needs exactly 4 spawns (◉). Play test launches it in solo. ' +
    'Save a named map (💾) to pick it later in the solo map menu.';
  page.appendChild(help);

  // ---- Initial render -----------------------------------------------------
  refreshBrushButtons();
  redrawGrid();
  refreshStatus();
  refreshSavedList();
}
