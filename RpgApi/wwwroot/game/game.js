import { loadTileset, loadTilesetRegistry } from '../editor/tileset.js'
import { loadAssets } from '../editor/assets.js'
import { deserializeMap, getRaw, placeDecoration, removeDecoration as removeMapDecoration, setCell, serializeMap } from '../editor/map.js'
import { loadImage } from '../editor/imaging.js'
import { tileHash, getVariantIndex, buildTileCanvas } from '../editor/tilemath.js'
import * as engine from './engine.js'
import renderMathInElement from 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.mjs'

const _katexOpts = {
    delimiters: [
        { left: '$$', right: '$$', display: true  },
        { left: '$',  right: '$',  display: false },
    ],
    throwOnError: false,
}

/** Render text into el — activates KaTeX for any $...$ or $$...$$ spans.
 *  Strings that start with '<' are treated as trusted HTML and injected via
 *  innerHTML; all other strings are set as plain text via textContent. */
function renderQuestion(el, text) {
    if (text.trimStart().startsWith('<')) {
        el.innerHTML = text
    } else {
        el.textContent = text
    }
    if (text.includes('$')) renderMathInElement(el, _katexOpts)
}

// ─── Constants ────────────────────────────────────────────────────────────────
const TILE         = 32
const ANIM_FPS     = 8    // character animation frames per second
const MOVE_SPEED   = 4    // tiles per second

let SHOW_GRID   = false    // Ctrl+G to toggle
let SHOW_COORDS = false   // Ctrl+H to toggle
let SHOW_PERF   = false   // Ctrl+P to toggle — on-screen render profiler

// ─── Render profiler ──────────────────────────────────────────────────────────
// Rolling EMA of per-pass cost (ms) + frame time / fps. Toggle with Ctrl+P.
// render() stamps _perfFrameStart at entry and calls _perfTickFrame() at exit (when
// SHOW_PERF is on); individual passes are wrapped with _perfStart/_perfEnd(label).
// Aggregates are drawn over the canvas while SHOW_PERF is on.
const _perfTimers = Object.create(null)   // label → start ms (in-progress)
const _perfAvg    = Object.create(null)   // label → EMA ms (smoothed)
const _perfCount  = Object.create(null)   // label → samples since last reset
const _perfMax    = Object.create(null)   // label → worst sample this reset window
const _perfEMA_K  = 0.05                  // smoothing factor (~20-frame half-life)
let   _perfFrameStart = 0
let   _perfFrameAvg   = 0                 // EMA of full render() ms
let   _perfFrameMax   = 0
let   _perfFps        = 0                 // smoothed fps (1 / frameMs)

function _perfStart(label) { _perfTimers[label] = performance.now() }
function _perfEnd(label) {
    const t = performance.now() - _perfTimers[label]
    const prev = _perfAvg[label] ?? t
    _perfAvg[label]   = prev + (t - prev) * _perfEMA_K
    _perfCount[label] = (_perfCount[label] ?? 0) + 1
    if (t > (_perfMax[label] ?? 0)) _perfMax[label] = t
}
function _perfTickFrame() {
    const dt = performance.now() - _perfFrameStart
    _perfFrameAvg = _perfFrameAvg ? _perfFrameAvg + (dt - _perfFrameAvg) * _perfEMA_K : dt
    if (dt > _perfFrameMax) _perfFrameMax = dt
    _perfFps = _perfFps ? _perfFps + ((1000 / dt) - _perfFps) * _perfEMA_K : (1000 / dt)
}
function _perfResetPeaks() {
    for (const k in _perfMax) _perfMax[k] = 0
    _perfFrameMax = 0
}

// ─── Memory benchmark (shown under the perf rows in the Ctrl+P overlay) ────────
// Canvas backing stores dominate this engine's footprint (every cache is an
// offscreen canvas), so estimating them at width×height×4 RGBA bytes is the
// single most useful number we can give without a real heap snapshot. Typed
// arrays read `.byteLength` exactly. `performance.memory` (Chromium only) gives
// a real JS-heap reading on top of the estimates; on other engines that row is
// hidden. All figures are ESTIMATES of the GPU/CPU backing buffers, not GC-visible
// JS object size — a canvas's JS handle is tiny but its pixel buffer is not.
function _memBytesOfCanvas(c) { return c ? c.width * c.height * 4 : 0 }
/** Sum the backing-store bytes of every canvas held in a Map<string, canvas>. */
function _memSumCanvases(map) {
    let bytes = 0, n = 0
    if (map) for (const v of map.values()) { if (!v) continue; n++; bytes += _memBytesOfCanvas(v) }
    return { bytes, count: n }
}
/** `_windSils` is a nested assetId → [bucket][fi] canvas matrix. Walk the nested arrays. */
function _memSumWindSils(map) {
    let bytes = 0, n = 0
    if (!map) return { bytes, count: n }
    for (const m of map.values()) {
        if (!m) continue
        for (let b = 0; b < m.length; b++) {
            const row = m[b]
            if (!row) continue
            for (let f = 0; f < row.length; f++) {
                const c = row[f]
                if (!c) continue
                n++; bytes += _memBytesOfCanvas(c)
            }
        }
    }
    return { bytes, count: n }
}
/** `_rayTracedShadowCache` holds { canvas } records, not bare canvases. */
function _memSumWrappedCanvases(map) {
    let bytes = 0, n = 0
    if (map) for (const v of map.values()) { if (!v || !v.canvas) continue; n++; bytes += _memBytesOfCanvas(v.canvas) }
    return { bytes, count: n }
}
/** Float/Int typed arrays expose .byteLength directly. */
function _memBytesOfArray(a) { return a ? a.byteLength : 0 }
/** Format an integer byte count as a compact human string (KB / MB). */
function _memFmt(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
    if (bytes >= 1024)    return (bytes / 1024).toFixed(0) + ' KB'
    return bytes + ' B'
}

// Hero sprite sheet rows per direction (Hero_<name>.png sheets):
// Row 0 = up, Row 1 = left, Row 2 = down, Row 3 = right
const DIR_UP = 0, DIR_LEFT = 1, DIR_DOWN = 2, DIR_RIGHT = 3
// Translate a logical direction (DIR_*) to the sheet row index.
const DIR_ROW = { [DIR_UP]: 0, [DIR_LEFT]: 1, [DIR_DOWN]: 2, [DIR_RIGHT]: 3 }

const ZOOM = 2   // display scale (world pixels → screen pixels)

// Hero sprites: Hero_<name>.png — N×256 sheet → N_COLS columns × 4 rows = 64×64 per frame.
// Foot anchor inside each 64×64 frame (source px), and the on-screen draw scale.
// The hero art is bigger than a tile; HERO_SCALE shrinks the 64px sprite for
// display — computed as desired_zoom / ZOOM so it's meaningful at a glance.
const HERO_FRAME_W = 64, HERO_FRAME_H = 64
const HERO_FOOT_X  = 32, HERO_FOOT_Y  = 60
// HERO_SCALE = desired_zoom / ZOOM.  With ZOOM=2, 1.3/2 = 0.65 so the hero
// renders at the equivalent of a global 1.3× zoom instead of the current 2×.
const HERO_SCALE   = 1.3 / ZOOM
// Animation frame sequences per sheet row (by column index):
//   idle = [0,0,1]   (loop a small breath)
//   walk = [2..9]    (8-frame step cycle — fits the 10-col Tom sheet;
//                      Mark/George at 11 cols also use [2..9])
const HERO_IDLE_FRAMES = [0, 0, 1]
const HERO_WALK_FRAMES = [2, 3, 4, 5, 6, 7, 8, 9]

// Monster sprites: 128×32 → 4 frames of idle, foot at center-bottom
const MONSTER_FRAME_W = 32, MONSTER_FRAME_H = 32
const MONSTER_FOOT_X  = 16, MONSTER_FOOT_Y  = 32

const MONSTER_TYPES = [
    'Knight','Orc','OrcRogue','OrcShaman','OrcWarrior',
    'Rogue','Skeleton','SkeletonMage','SkeletonRogue','SkeletonWarrior','Wizard',
]

// Shared animation bob curve (matches AnimationDemo)
const FRAME_BOB      = [0, 1, 2, 1]   // y offset in source-px per animation frame
const ENEMY_HAND_CELL = 16
const ENEMY_WEP_CELL  = 16

// Water animation constants (identical to editor)
const WAVE_NFRAMES   = 16
const WATER_BASE_CLR = 'rgb(21,108,153)'
const SHIMMER_RGB    = [[0,152,178],[0,207,223]]
const SHIMMER_CLR    = ['rgb(0,152,178)','rgb(0,207,223)']

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas')
const ctx    = canvas.getContext('2d')
ctx.imageSmoothingEnabled = false

function resizeCanvas() {
    canvas.width  = window.innerWidth
    canvas.height = window.innerHeight
}
resizeCanvas()
window.addEventListener('resize', resizeCanvas)

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = {}
const GAME_KEYS = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyA','KeyS','KeyW','KeyD'])
const _isTyping = () => { const t = document.activeElement?.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' }
document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.code === 'KeyG') { e.preventDefault(); SHOW_GRID   = !SHOW_GRID;   return }
    if (e.ctrlKey && e.code === 'KeyH') { e.preventDefault(); SHOW_COORDS = !SHOW_COORDS; return }
    if (e.ctrlKey && e.code === 'KeyP') { e.preventDefault(); SHOW_PERF   = !SHOW_PERF;   return }
    if (e.ctrlKey && e.code === 'KeyQ') { e.preventDefault(); _toggleQuestionBrowser();   return }
    if (e.ctrlKey && e.code === 'KeyX') { e.preventDefault(); _toggleCheatConsole();       return }
    if (e.code === 'F1') { e.preventDefault(); showLearnDialog(); return }
    if (_isTyping()) return
    // While a blocking modal is open, don't record direction keys — and clear
    // any currently-held ones — so movement can't accumulate during a dialog
    // and an arrow held/pressed then doesn't fire the instant it closes.
    if (_modalBlockingInput()) {
        if (GAME_KEYS.has(e.code)) { keys[e.code] = false; e.preventDefault() }
        return
    }
    keys[e.code] = true;  if (GAME_KEYS.has(e.code)) e.preventDefault()
})
document.addEventListener('keyup', e => { keys[e.code] = false; if (!_isTyping() && GAME_KEYS.has(e.code)) e.preventDefault() })

// ─── Effect sprite definitions ────────────────────────────────────────────────
// The 32×32 effects share one spritesheet, effects-32x32.png, laid out as rows of
// 16 horizontally-arranged frames — one row per effect. `row` is the 0-based row
// index into that sheet; the source-Y of any frame is `row * h`. `fire_big` is a
// 64×64 standalone sheet (not part of effects-32x32.png), so it keeps its own
// `src` and row 0. Loading the shared sheet once fills `img` for every 32×32
// entry instead of firing a request per effect.
const EFFECT_SHEET_SRC = '../assets/effects-32x32.png'
const EFFECT_SHEET = { img: null }
const EFFECT_DEFS = {
    fire:        { frames: 16, fps: 12, w: 32, h: 32, row: 0, sheet: EFFECT_SHEET, img: null },
    fire_2:      { frames: 16, fps: 12, w: 32, h: 32, row: 1, sheet: EFFECT_SHEET, img: null },
    haze_purple: { frames: 16, fps: 12, w: 32, h: 32, row: 2, sheet: EFFECT_SHEET, img: null },
    haze_green:  { frames: 16, fps: 12, w: 32, h: 32, row: 3, sheet: EFFECT_SHEET, img: null },
    fire_big:    { frames: 16, fps: 12, w: 64, h: 64, row: 0, src: '../assets/fire_big.png', img: null },
}

// ─── Point lights ─────────────────────────────────────────────────────────────
// A light = { col:[r,g,b], rPx (world-pixel radius), a (occurrence strength 0..1, default 1) }.
// Sources:
//   • EFFECT_DEFS entry indexed by `type` → a light baked onto each fire effect,
//   • decoration asset with an optional `light` field (authored per-asset in assets JSON),
//     e.g. an oil-lamp decoration emitting a soft glow — `{ col:[255,200,120], r:2.5 }`,
//   • the player via any equipped item that carries a `light` field in items.json.
// `r` is given in TILES and converted to world pixels (×TILE); `col` is a hex string.
const LIGHT_BY_EFFECT = {
    fire:        { r: 3.5, a: 0.7, col: '#ff8b3a' },
    fire_2:      { r: 3.5, a: 0.7, col: '#ff8b3a' },
    fire_big:    { r: 4.5, a: 0.8, col: '#ff8b3a' },
    haze_purple: { r: 2.5, a: 0.45, col: '#a855f7' },
    haze_green:  { r: 2.5, a: 0.45, col: '#4ade80' },
}
// Lights fade IN across this ramp of darkness so there's no on/off pop. Below
// LIGHT_MIN_DARKNESS a light contributes nothing; it ramps up to full strength
// at LIGHT_MAX_DARKNESS. Both the darkness hole AND the warm halo are scaled by
// this factor, so night→day carries the glow out smoothly instead of snapping.
// Pulled from the lighting tint's alpha (flatAlpha).
const LIGHT_MIN_DARKNESS = 0.12
const LIGHT_MAX_DARKNESS = 0.45
// 0..1 ramp factor for how strongly lights show at a given darkness level.
function _lightFadeK(flatAlpha) {
    if (flatAlpha <= LIGHT_MIN_DARKNESS) return 0
    if (flatAlpha >= LIGHT_MAX_DARKNESS) return 1
    return (flatAlpha - LIGHT_MIN_DARKNESS) / (LIGHT_MAX_DARKNESS - LIGHT_MIN_DARKNESS)
}
// Pulse: a slow sine breathing radius + glow alpha so fires flicker like wood fire.
// `now` is performance.now() in MILLISECONDS (passed from renderLighting), so divide to
// seconds. Each emitter holds its OWN `phase` (radians, random at spawn) + a small per-source
// `freq` spread so lights don't all breathe in lockstep — a town of torches pulses
// independently instead of as one screen-wide throb. rad center ≈ 0.6 Hz.
// `phase` is 0..2π; `freq` defaults to 4.6 rad/s (period ≈ 1.37 s), ±20% varies the rate.
function _lightPulse(now, phase, freq) {
    const p = Math.sin((now / 1000) * (freq ?? 4.6) + (phase ?? 0))
    return { rad: 1 + 0.05 * p, alpha: 0.9 + 0.10 * p }   // ±5% radius, 80%-100% alpha
}
// Stable pseudo-random phase in [0, 2π) keyed by an arbitrary tag (avoids Math.random()'s
// frame-to-frame drift on a lazily-assigned field; deterministic per source identity).
function _lightPhaseFor(tag) {
    let h = 2166136261 >>> 0
    for (let i = 0; i < tag.length; i++) { h = Math.imul(h ^ tag.charCodeAt(i), 16777619) >>> 0 }
    return (h % 62832) / 10000   // 0..2π (~6.2832)
}

// ─── Items registry ─────────────────────────────────────────────────────────
let _itemsDef  = {}    // { item_id: [col, row] } — from data.items
let _craftDef  = {}    // { item_id: [col, row] } — from data.crafting
let _itemsImg  = null  // items.png Image
let _craftImg  = null  // crafting.png Image
const ITEM_SIZE = 32
const ITEM_COLS = 10

// ─── Game state ───────────────────────────────────────────────────────────────
let tileset  = null
let assetMap = null
let map      = null
let _currentTilesetId = null
const _tilesetCache = new Map()   // id → { tileset, waterAtlas, waterFrameMap }
let _currentMapId = null
let _currentScenarioId = null   // folder name of the active scenario — map JSON lives in /scenarios/<id>/maps/
const _mapEntities = new Map()    // mapId → { monsters, npcs }
const _mapCache    = new Map()    // mapId → live map object (preserves runtime decoration changes)
const _mapChanges   = new Map()   // mapId → array of { action: 'spawn_decoration'|'remove_decoration'|'change_tile'|'spawn_item'|'remove_item', ...args }

// Hero sprite sheet (single Hero_<name>.png per scenario). Idle + walk frames
// are sliced from the same sheet by column index (HERO_IDLE/WALK_FRAMES).
// `cols` is derived from the loaded sheet width and cached for quick access.
const playerSprites = { sheet: null, heroName: null, cols: 10 }

const player = {
    tileX:    0,        // current tile (always whole)
    tileY:    0,
    fromX:    0,        // animation source tile
    fromY:    0,
    toX:      0,        // animation destination tile
    toY:      0,
    progress: 1.0,      // 0..1; 1.0 = at destination
    px:       0,        // world-pixel feet X (lerped)
    py:       0,        // world-pixel feet Y (lerped)
    dir:      DIR_DOWN,
    moving:   false,
}

// ─── Player stats ─────────────────────────────────────────────────────────────
// Mutable at runtime. Sync with engine state via syncStatsFromEngine().
const playerStats = {
    // Resources
    hp:       100,
    maxHp:    100,
    xp:       0,
    gold:     0,
    level:    1,

    // Movement
    speed:    MOVE_SPEED,   // pixels per frame

    // Combat (set per scenario via variables; default 0 = scenario controls the values)
    base_dmg:  10,           // Base Damage — grows on level-up (chance for +1)
    attack:    0,
    defense:   0,
    armor:     0,
    agility:   0,

    // Equipped weapon item id (null = bare hands) — legacy, mirrored from equipped hand slot
    equippedWeapon: null,

    // Equipped body slots → item_id (null = empty)
    equipped: { head: null, hand_l: null, hand_r: null, neck: null, torso: null, feet: null },

    // Inventory: item_id → quantity
    items: {},
}

/** Copy engine variables/inventory into playerStats. Call after loadScenario. */
function syncStatsFromEngine() {
    const state = engine.getState()
    const v = state.variables
    if (v.hp      !== undefined) playerStats.hp      = v.hp
    if (v.max_hp  !== undefined) playerStats.maxHp   = v.max_hp
    if (v.xp      !== undefined) playerStats.xp      = v.xp
    // gold is now a regular item in inventory, not a variable
    if (v.speed   !== undefined) playerStats.speed    = v.speed
    if (v.base_dmg        !== undefined) playerStats.base_dmg        = v.base_dmg
    if (v.attack          !== undefined) playerStats.attack          = v.attack
    if (v.defense         !== undefined) playerStats.defense         = v.defense
    if (v.armor           !== undefined) playerStats.armor           = v.armor
    if (v.agility         !== undefined) playerStats.agility         = v.agility
    // Migration: old saves may have 'dexterity' — fall back to agility
    if (v.dexterity       !== undefined && v.agility === undefined) playerStats.agility = v.dexterity
    if (v.level           !== undefined) playerStats.level           = v.level
    if (v.equipped_weapon !== undefined) playerStats.equippedWeapon  = v.equipped_weapon
    // Copy equipped slots (engine is source of truth)
    if (state.equipped) playerStats.equipped = { ...state.equipped }
    // Merge engine inventory into items map (gold is now just another item)
    const inv = state.inventory
    for (const [id, qty] of Object.entries(inv)) {
        playerStats.items[id] = qty
    }
    // Apply speed to movement
    player.speed = playerStats.speed
}

// ─── Caches ───────────────────────────────────────────────────────────────────
const tileCache        = new Map()   // terrain tile canvases
const windCache        = new Map()   // wind sprite-sheets
const _windSrcImgCache = new Map()   // asset:state → source RGBA (Uint8ClampedArray) — GPU readback done ONCE per asset, reused by every wind bucket's bake
const _objectFoamCache = new Map()   // foam particle lists for decorations on water

// ─── Water static caches (built once per map, reused every frame) ───────────────────
// waterMask[y][x] = 4-bit mask of water adjacency (constant, terrain doesn't change)
// waterPhase[y][x] = per-tile animation phase offset for natural variation
let _waterMask = null     // Uint8Array[W+2][H+2] - padded for edge-safe access
let _waterPhase = null    // Uint8Array[W+2][H+2] - phase offset (0..15)

// ─── Monster state ────────────────────────────────────────────────────────────
let monsters = []                          // { id, type, tileX, tileY }
const monsterSprites  = {}                 // charName → HTMLImageElement
const _enemyDefs      = {}                 // enemy name → definition (from enemies.json)
const _weaponSprites  = {}                 // 'Weapon-Hands'|'Weapon-Bone'|'Weapon-Wood' → Image
const _wepTrimCache   = {}                 // file:col,row,cols,rows → trim rect
const _bodyTrimCache  = {}                 // 'charName:frame' → trim rect (shared across all defs with same charName)
const _monsterSheetInfo = new Map()        // composite type → { frameW, frameH, charX, charY, footX, footY }

// ─── NPC state ────────────────────────────────────────────────────────────────
// Per-sprite definitions. Only specify what differs from the defaults.
// frameW/frameH: pixel size of one frame.
// frames: total animation frame count.
// ─── Unified sprite/geometry registry ──────────────────────────────────────────
// One place that knows how to draw any sprite, regardless of whether it is spawned
// as a monster or an NPC. Geometry branches resolve via resolveEntityDef().
//
// Keys are sprite base-names (characters/<name>.png). `layout: 'col'` = frames
// stacked vertically (NPC style, frameW × frames×frameH); `layout: 'row'` =
// frames laid out horizontally (monster-row style, frames×frameW × frameH) as
// found in Enemies.png. Specific NPCs / standalone monster sheets that differ from
// the defaults are listed below; any name not listed falls back to SPRITE_DEFAULTS.
const SPRITE_DEFAULTS = { frameW: 32, frameH: 32, frames: 8,
                           footX: 16, footY: 32, fps: 8, layout: 'col' }
const SPRITE_DEFS = {
    // NPC sheets — currently all use defaults (kept explicit for discoverability):
    'Hero-Mage':   {},
    'Hero-Boy':    {},
    'Hero-Farmer': {},        // 256×32 col sheet (8 frames) — matches defaults
    // Hero-Crab, Gorilla, Bat are now defined in enemies.json sprite config
}

/**
 * Resolve the draw-definition for any sprite name, whether it is spawned as a
 * monster or an NPC. Returns one of:
 *   • { composite:true,  def, sprite }        — name is an _enemyDefs entry with sprite config
 *   • { composite:false, frameW, frameH, frames, footX, footY, fps, layout, file }
 *                                            — simple frame-sheet geometry
 * Unregistered names fall back to SPRITE_DEFAULTS, so an arbitrary sprite can be
 * used without pre-registration. Composites win over simple-sheet geometry.
 */
function resolveEntityDef(name) {
    const enemyDef = _enemyDefs[name];
    if (enemyDef) {
        const sprite = enemyDef.sprite;
        if (sprite.mode === 'composite') {
            return { composite: true, def: enemyDef, sprite };
        }
        // simple, sheet, hero modes - return simple geometry with file info
        // Apply defaults: frameW=32, frameH=32, footX=16, footY=32
        // For simple/hero: frames=4, layout='row'; for sheet: frames=4 (from Enemies.png rows)
        const isSimpleOrHero = sprite.mode === 'simple' || sprite.mode === 'hero';
        const defaults = {
            frameW: 32, frameH: 32, footX: 16, footY: 32,
            frames: isSimpleOrHero ? 4 : 8,
            layout: isSimpleOrHero ? 'row' : 'col',
            fps: 8
        };
        return {
            composite: false,
            ...defaults,
            ...(SPRITE_DEFS[sprite.base] ?? {}),
            ...sprite,
            file: sprite.file
        };
    }
    return { composite: false, ...SPRITE_DEFAULTS, ...(SPRITE_DEFS[name] ?? {}) }
}

let npcs = []           // { id, sprite, tileX, tileY, flipX }
const npcSprites = {}   // sprite name → HTMLImageElement

// ─── Blocked map (terrain + decoration traversability) ───────────────────────
let blocked = null   // blocked[y][x] = true means impassable

// ─── Engine integration ───────────────────────────────────────────────────────
let engineBusy       = false   // true while an async action (dialog, map load) runs
let _pendingTileEnter = null   // { x, y } — fired when player finishes landing
// Stash for monster_defeated (type + tile + authorId) scheduled after a won
// battle. The player continues advancing onto the monster's tile; only once
// they LAND there do we fire monster_defeated, so its dialog opens with the
// player already standing on the tile (animation finished, idle on first frame).
let _pendingMonsterDefeat = null   // { type, x, y, authorId }

// True whenever a blocking modal overlay (dialog box, choice box) is on screen.
// Independent of engineBusy so movement is frozen regardless of which call site
// opened the modal. Toast messages (show_message) are deliberately non-modal
// and intentionally do NOT block.
const MODAL_OVERLAYS = ['dialog-box', 'choice-box']
function _modalBlockingInput() {
    for (const id of MODAL_OVERLAYS) {
        const el = document.getElementById(id)
        if (el && !el.classList.contains('hidden')) return true
    }
    return false
}
// Flush buffered direction keys so a key held during a modal doesn't fire the
// instant the modal closes. Called when a modal opens.
function _flushMovementKeys() {
    for (const k of GAME_KEYS) keys[k] = false
}

// ─── Water animation state ────────────────────────────────────────────────────
let waterFrameMap     = null
// currentWaterFrame and lastWaterTick removed — water frame now derived from
// the shared animation tick: floor(now / ANIM_TICK_MS) % WAVE_NFRAMES

// ─── Utilities ────────────────────────────────────────────────────────────────
// Shared tile helpers (loadImage, tileHash, getVariantIndex, buildTileCanvas): ../editor/tilemath.js + imaging.js

// ─── Terrain rendering ────────────────────────────────────────────────────────
// Static terrain cache — viewport-relative so it stays a fixed size for any map.
// Covers (viewport + TERRAIN_MARGIN tiles on each side). Rebuilt only when the
// player scrolls more than TERRAIN_MARGIN/2 tiles from the last bake centre.
const TERRAIN_MARGIN = 12          // extra tiles beyond the viewport on each side
const WATER_MARGIN   = 2           // tiny margin to cover camera drift between water ticks

let _terrainCanvas  = null
let _terrainOriginX = 0            // world-pixel x/y of the canvas top-left
let _terrainOriginY = 0
let _terrainCentreX = 0            // player tile-X when the cache was last built
let _terrainCentreY = 0
let _terrainHalfW   = 0            // half-widths that were used (tile units)
let _terrainHalfH   = 0

function buildTerrainCache() {
    const W = map.width, H = map.height
    const baseId = tileset.terrains.find(t => t.base)?.id ?? 0

    // waterFlat: replace flat-water terrain with a fallback terrain ID in the static
    // tile canvas (the animated water layer draws on top). Matches editor behaviour.
    const flatWaterId = tileset.waterTerrain?.waterFlat ? tileset.waterTerrain.id : -1
    const flatBase    = typeof tileset.waterTerrain?.waterFlat === 'number'
                            ? tileset.waterTerrain.waterFlat
                            : baseId
    const nw = id => (id === flatWaterId ? flatBase : id)

    // Half-extents = half-viewport + margin
    const halfW = Math.ceil(canvas.width  / (TILE * ZOOM * 2)) + TERRAIN_MARGIN
    const halfH = Math.ceil(canvas.height / (TILE * ZOOM * 2)) + TERRAIN_MARGIN

    // Centre on the current camera tile
    const cx = Math.round(player.px / TILE)
    const cy = Math.round(player.py / TILE)
    _terrainCentreX = cx;  _terrainCentreY = cy
    _terrainHalfW   = halfW; _terrainHalfH = halfH

    const rxStart = cx - halfW, ryStart = cy - halfH
    const rxEnd   = cx + halfW, ryEnd   = cy + halfH

    _terrainOriginX = (rxStart - 1) * TILE + TILE / 2
    _terrainOriginY = (ryStart - 1) * TILE + TILE / 2

    const tw = (rxEnd - rxStart + 1) * TILE
    const th = (ryEnd - ryStart + 1) * TILE

    if (!_terrainCanvas || _terrainCanvas.width !== tw || _terrainCanvas.height !== th) {
        _terrainCanvas = document.createElement('canvas')
        _terrainCanvas.width = tw; _terrainCanvas.height = th
    }
    const tc = _terrainCanvas.getContext('2d')
    tc.clearRect(0, 0, tw, th)

    const terr = (x, y) => (x >= 0 && x <= W + 1 && y >= 0 && y <= H + 1)
        ? getRaw(map, x, y) : baseId

    for (let ry = ryStart; ry <= ryEnd; ry++) {
        for (let rx = rxStart; rx <= rxEnd; rx++) {
            const tl = nw(terr(rx, ry)),   tr = nw(terr(rx+1, ry))
            const bl = nw(terr(rx, ry+1)), br = nw(terr(rx+1, ry+1))
            const vi  = getVariantIndex(tileset, rx, ry)
            const key = tl | (tr << 6) | (bl << 12) | (br << 18) | (vi << 24)
            let tile = tileCache.get(key)
            if (!tile) { tile = buildTileCanvas(tileset, tl, tr, bl, br, rx, ry); tileCache.set(key, tile) }
            tc.drawImage(tile, (rx - rxStart) * TILE, (ry - ryStart) * TILE)
        }
    }
}

function renderTerrain() {
    if (!_terrainCanvas) { buildTerrainCache() }
    else {
        // Rebuild if the player has scrolled beyond half the safety margin
        const dx = Math.abs(Math.round(player.px / TILE) - _terrainCentreX)
        const dy = Math.abs(Math.round(player.py / TILE) - _terrainCentreY)
        const neededW = Math.ceil(canvas.width  / (TILE * ZOOM * 2)) + TERRAIN_MARGIN
        const neededH = Math.ceil(canvas.height / (TILE * ZOOM * 2)) + TERRAIN_MARGIN
        if (dx > TERRAIN_MARGIN / 2 || dy > TERRAIN_MARGIN / 2 ||
            _terrainHalfW < neededW || _terrainHalfH < neededH) {
            buildTerrainCache()
        }
    }
    ctx.drawImage(_terrainCanvas, _terrainOriginX, _terrainOriginY)
}

// ─── Water animation (ported from editor) ────────────────────────────────────
function _isWaterColor(r, g, b) {
    return (Math.abs(r - 21) <= 10 && Math.abs(g - 108) <= 10 && Math.abs(b - 153) <= 10) ||
           (r <= 10 && Math.abs(g - 152) <= 10 && Math.abs(b - 178) <= 10) ||
           (r <= 10 && Math.abs(g - 207) <= 10 && Math.abs(b - 223) <= 10)
}

function _makeWaterRNG(seed) {
    let s = (seed >>> 0) || 1
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

function _analyzeWaterTile(wMask) {
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = TILE
    const tc = tmp.getContext('2d')
    tc.drawImage(tileset.waterTerrain.img, wMask * TILE, 0, TILE, TILE, 0, 0, TILE, TILE)
    const d = tc.getImageData(0, 0, TILE, TILE).data

    const wmC = document.createElement('canvas'); wmC.width = wmC.height = TILE
    const coC = document.createElement('canvas'); coC.width = coC.height = TILE
    const wmD = wmC.getContext('2d').createImageData(TILE, TILE)
    const coD = coC.getContext('2d').createImageData(TILE, TILE)
    const waterRows = []
    for (let y = 0; y < TILE; y++) waterRows.push([])

    for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
            const i = (y * TILE + x) * 4
            const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3]
            if (a < 128) continue
            if (_isWaterColor(r, g, b)) {
                wmD.data[i] = wmD.data[i+1] = wmD.data[i+2] = 255; wmD.data[i+3] = a
                waterRows[y].push(x)
            } else {
                coD.data[i] = r; coD.data[i+1] = g; coD.data[i+2] = b; coD.data[i+3] = a
            }
        }
    }
    wmC.getContext('2d').putImageData(wmD, 0, 0)
    coC.getContext('2d').putImageData(coD, 0, 0)

    const edgePixels = []
    for (let y = 0; y < TILE; y++) {
        for (const x of waterRows[y]) {
            const adj = (nx, ny) => ny >= 0 && ny < TILE && nx >= 0 && nx < TILE &&
                                    coD.data[(ny * TILE + nx) * 4 + 3] > 0
            if (adj(x-1,y) || adj(x+1,y) || adj(x,y-1) || adj(x,y+1))
                edgePixels.push({ x, y })
        }
    }
    return { waterRows, waterMask: wmC, cliffOnly: coC, edgePixels }
}

function _makeShimmers(rows, wMask) {
    const rng = _makeWaterRNG(Math.imul(wMask, 2654435769) ^ 0xdeadbeef)
    const totalPx = rows.reduce((s, r) => s + r.length, 0)
    const n = Math.max(1, Math.min(8, Math.round(totalPx / 180)))
    const usable = []
    for (let y = 0; y < rows.length; y++) if (rows[y].length >= 3) usable.push(y)
    if (!usable.length) return []
    const out = []
    for (let i = 0, tries = 0; i < n && tries < n * 12; tries++) {
        const y = usable[Math.floor(rng() * usable.length)]
        const r = rows[y]; const si = Math.floor(rng() * r.length)
        let run = 1
        while (run < r.length - si && r[si + run] === r[si + run - 1] + 1) run++
        if (run < 2) continue
        i++
        out.push({ x: r[si], y, len: Math.min(run, 2 + Math.floor(rng() * 3)),
                   phase: Math.floor(rng() * WAVE_NFRAMES), halfLife: 2 + Math.floor(rng() * 3),
                   colorIdx: rng() < 0.35 ? 1 : 0 })
    }
    return out
}

function _makeStamp(w, h, colorIdx) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2
    const rx = w / 2, ry = Math.max(0.5, h / 2)
    const [sr, sg, sb] = SHIMMER_RGB[colorIdx]
    const stamp = document.createElement('canvas'); stamp.width = w; stamp.height = h
    const sid = stamp.getContext('2d').createImageData(w, h)
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const ddx = (px - cx) / rx, ddy = (py - cy) / ry, d2 = ddx*ddx + ddy*ddy
            if (d2 >= 1) continue
            const i = (py * w + px) * 4
            sid.data[i] = sr; sid.data[i+1] = sg; sid.data[i+2] = sb; sid.data[i+3] = (1 - d2) * 255 | 0
        }
    }
    stamp.getContext('2d').putImageData(sid, 0, 0)
    return stamp
}

function _makeShoreShimmers(edgePixels, count, wMask, ovalWidth, ovalHeight) {
    if (!edgePixels.length || count === 0) return []
    const rng = _makeWaterRNG(Math.imul(wMask + 99, 0x9e3779b9) ^ 0xfeedface)
    const out = []
    for (let i = 0; i < Math.min(count, 32); i++) {
        const p = edgePixels[Math.floor(rng() * edgePixels.length)]
        const phase = Math.floor(rng() * WAVE_NFRAMES)
        const period = 8 + Math.floor(rng() * 7)
        const h = 1 + Math.floor(rng() * ovalHeight)
        const wMin = Math.min(2 * h, ovalWidth)
        const w = wMin + Math.floor(rng() * (ovalWidth - wMin + 1))
        const stamp = _makeStamp(w, h, rng() < 0.65 ? 1 : 0)
        out.push({ drawX: p.x - ((stamp.width - 1) >> 1), drawY: p.y - ((stamp.height - 1) >> 1), stamp, phase, period })
    }
    return out
}

// ─── Object foam: per-decoration bottom-edge foam particles ─────────────────
// For each decoration placed on a water tile, scan the bottom silhouette of
// its sprite and create animated foam ovals there (same style as shore foam).
function _buildObjectFoamParticles(d) {
    const asset = assetMap?.[d.assetId]; if (!asset) return []
    const state = asset.states.find(s => s.id === (d.stateId ?? asset.defaultState)) ?? asset.states[0]
    if (!state) return []
    const [tx, ty, tw, th] = state.region
    const ts = asset.tileset
    const srcX = tx * ts.size[0], srcY = ty * ts.size[1]
    const srcW = tw * ts.size[0], srcH = th * ts.size[1]
    const [pivX, pivY] = asset.pivot
    const sc   = d.scale ?? 1
    const flip = d.flipX ? -1 : 1
    const ox   = Math.round(-pivX * srcW)
    const oy   = Math.round(-pivY * srcH)

    // Sample sprite pixels to find the bottommost opaque pixel in each column
    const tmp = document.createElement('canvas')
    tmp.width = srcW; tmp.height = srcH
    const tc = tmp.getContext('2d')
    tc.drawImage(ts.img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)
    const data = tc.getImageData(0, 0, srcW, srcH).data

    const worldX = d.x * TILE + TILE / 2 + (d.dx || 0)
    const worldY = d.y * TILE + TILE / 2 + (d.dy || 0)

    const bottomEdge = []
    for (let px = 0; px < srcW; px++) {
        for (let py = srcH - 1; py >= 0; py--) {
            if (data[(py * srcW + px) * 4 + 3] > 64) {
                bottomEdge.push({
                    x: Math.round(worldX + flip * (ox + px) * sc),
                    y: Math.round(worldY + (oy + py) * sc)
                })
                break
            }
        }
    }
    if (!bottomEdge.length) return []

    const seed = Math.imul(d.x * 73 + d.y * 37, 0x9e3779b9) ^ (d.assetId * 0xdeadbeef | 0)
    const rng  = _makeWaterRNG(seed)
    const count = Math.max(4, Math.min(24, Math.round(bottomEdge.length / 2)))
    const out = []
    for (let i = 0; i < count; i++) {
        const p = bottomEdge[Math.floor(rng() * bottomEdge.length)]
        const phase  = Math.floor(rng() * WAVE_NFRAMES)
        const period = 8 + Math.floor(rng() * 7)
        const h = 1 + Math.floor(rng() * 4)
        const wMin = Math.min(2 * h, 20)
        const w = wMin + Math.floor(rng() * (20 - wMin + 1))
        const stamp = _makeStamp(w, h, rng() < 0.65 ? 1 : 0)
        out.push({ drawX: p.x - ((stamp.width - 1) >> 1), drawY: p.y - ((stamp.height - 1) >> 1), stamp, phase, period })
    }
    return out
}

function _bakeWaterMask(wMask, foamParticles, foamBlend) {
    const { waterRows, waterMask, cliffOnly } = _analyzeWaterTile(wMask)
    const shimmers = _makeShimmers(waterRows, wMask)
    const frames = []
    for (let f = 0; f < WAVE_NFRAMES; f++) {
        const c = document.createElement('canvas'); c.width = c.height = TILE
        const cctx = c.getContext('2d'); cctx.imageSmoothingEnabled = false
        cctx.fillStyle = WATER_BASE_CLR
        cctx.fillRect(0, 0, TILE, TILE)
        for (const sh of shimmers) {
            const raw = (f - sh.phase + WAVE_NFRAMES) % WAVE_NFRAMES
            const a = Math.max(0, 1 - Math.min(raw, WAVE_NFRAMES - raw) / sh.halfLife)
            if (a < 0.01) continue
            cctx.globalAlpha = a; cctx.fillStyle = SHIMMER_CLR[sh.colorIdx]
            cctx.fillRect(sh.x, sh.y, sh.len, 1)
        }
        for (const sp of foamParticles) {
            const pos = ((f - sp.phase + WAVE_NFRAMES * 16) % sp.period) / sp.period
            const a = Math.max(0, 1 - 2 * Math.abs(pos - 0.5))
            if (a < 0.02) continue
            cctx.globalAlpha = a * foamBlend; cctx.drawImage(sp.stamp, sp.drawX, sp.drawY)
        }
        cctx.globalAlpha = 1
        cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(waterMask, 0, 0)
        cctx.globalCompositeOperation = 'source-over'
        if (!tileset.waterTerrain?.noCliff)              cctx.drawImage(cliffOnly,  0, 0)
        frames.push(c)
    }
    return frames
}

function buildWaterFrames() {
    waterFrameMap = new Map()
    for (let m = 1; m <= 15; m++) {
        const { edgePixels } = _analyzeWaterTile(m)
        const bottomCliff = ((m & 8) && !(m & 2)) || ((m & 4) && !(m & 1))
        const fw = bottomCliff ? 10 : 20
        const fh = bottomCliff ?  2 :  4
        waterFrameMap.set(m, _bakeWaterMask(m, _makeShoreShimmers(edgePixels, 32, m, fw, fh), 0.5))
    }
    // Pack all 240 individual frame canvases into one atlas so _buildWaterCache
    // draws from a single GPU texture instead of 240 separate ones.
    // Layout: columns = frames (0..15), rows = mask-1 (0..14)
    _waterAtlas = document.createElement('canvas')
    _waterAtlas.width  = WAVE_NFRAMES * TILE   // 512 px
    _waterAtlas.height = 15 * TILE             // 480 px
    const ac = _waterAtlas.getContext('2d')
    for (let m = 1; m <= 15; m++) {
        const frames = waterFrameMap.get(m)
        for (let f = 0; f < WAVE_NFRAMES; f++)
            ac.drawImage(frames[f], f * TILE, (m - 1) * TILE)
    }
}

// ─── Shared animation tick ─────────────────────────────────────────────────────────────
// Water (10fps) and effects (was 12fps, now 10fps — imperceptible difference)
// both run off floor(now / ANIM_TICK_MS). They advance on the same rAF frame
// so cache rebuilds stay coordinated and the timing is drift-free.
const ANIM_TICK_MS = 100   // 10fps
function _animTick() { return Math.floor(performance.now() / ANIM_TICK_MS) }
function _waterFrame() { return _animTick() % WAVE_NFRAMES }

// ─── Monster animation tick (independent from water/effects) ────────────────────────────
const MONSTER_ANIM_TICK_MS = 200   // 5fps — change to slow down / speed up monsters only
function _monsterAnimTick() { return Math.floor(performance.now() / MONSTER_ANIM_TICK_MS) }
let _waterAtlas      = null   // 15 masks × 16 frames packed into one canvas
// ─── Water animation viewport cache (rebuilt every frame for smooth camera) ────────
// Uses pre-computed waterMask[y*W+x] and waterPhase[y*W+x] for O(1) tile lookups.
let _waterCanvas      = null
let _waterOriginX     = 0, _waterOriginY = 0
let _waterCentreX     = 0, _waterCentreY = 0
let _waterHalfW       = 0, _waterHalfH   = 0
let _waterCachedFrame = -1

function _buildWaterCache() {
    if (!_waterAtlas || !_waterMask) return  // buildBlockedMap must run first
    const waterId = tileset.waterTerrain.id
    const W = map.width, H = map.height
    const halfW = Math.ceil(canvas.width  / (TILE * ZOOM * 2)) + WATER_MARGIN
    const halfH = Math.ceil(canvas.height / (TILE * ZOOM * 2)) + WATER_MARGIN
    const cx = Math.round(player.px / TILE), cy = Math.round(player.py / TILE)

    // Always rebuild when animation frame advances (10fps) or viewport size changes
    const needRebuild = !_waterCanvas ||
        _waterCachedFrame !== _animTick() ||
        _waterHalfW < halfW || _waterHalfH < halfH

    if (needRebuild) {
        _waterCentreX = cx; _waterCentreY = cy
        _waterHalfW = halfW; _waterHalfH = halfH
        const rxS = cx - halfW, ryS = cy - halfH
        const rxE = cx + halfW, ryE = cy + halfH
        _waterOriginX = (rxS - 1) * TILE + TILE / 2
        _waterOriginY = (ryS - 1) * TILE + TILE / 2
        const tw = (rxE - rxS + 1) * TILE, th = (ryE - ryS + 1) * TILE

        if (!_waterCanvas || _waterCanvas.width !== tw || _waterCanvas.height !== th) {
            _waterCanvas = document.createElement('canvas')
            _waterCanvas.width = tw; _waterCanvas.height = th
        }
        const wc = _waterCanvas.getContext('2d')
        wc.clearRect(0, 0, tw, th)

        // O(1) tile lookup via _waterMask (built in buildBlockedMap, 1-cell padded).
        // Beyond the map edge, clamp to the nearest valid tile and force mask=15 (full
        // water) so edge cliff graphics don't repeat into empty screen space.
        const stride = W + 2
        const wf = _waterFrame()
        for (let ry = ryS; ry <= ryE; ry++) {
            const mry = ry < -1 ? -1 : ry > H ? H : ry
            const rowBase = (mry + 1) * stride + 1
            for (let rx = rxS; rx <= rxE; rx++) {
                const mrx = rx < -1 ? -1 : rx > W ? W : rx
                const idx  = rowBase + mrx
                const edgeMask = _waterMask[idx]
                if (!edgeMask) continue                       // nearest tile is dry — skip
                const outOfBounds = (ry !== mry || rx !== mrx)
                const wMask  = outOfBounds ? 15 : edgeMask   // full water beyond map edge
                // Use per-tile hash for out-of-bounds so each tile gets its own
                // animation phase, matching the natural variation of in-map tiles.
                const wPhase = outOfBounds
                    ? tileHash(rx, ry) % WAVE_NFRAMES
                    : _waterPhase[idx]
                const frame  = (wf + wPhase) % WAVE_NFRAMES
                wc.drawImage(_waterAtlas,
                    frame * TILE, (wMask - 1) * TILE, TILE, TILE,
                    (rx - rxS) * TILE, (ry - ryS) * TILE, TILE, TILE)
            }
        }
        _waterCachedFrame = _animTick()
    }
}

function renderWaterLayer() {
    if (!waterFrameMap || !tileset?.waterTerrain) return
    _buildWaterCache()  // Rebuilds at 10fps with fast cached lookups
    ctx.drawImage(_waterCanvas, _waterOriginX, _waterOriginY)
}

// ─── Object foam layer ────────────────────────────────────────────────────────
// Drawn after the water layer and before decorations so foam appears between
// the water surface and the object sprite.
function renderObjectFoam() {
    if (!tileset?.waterTerrain || !map || !assetMap) return
    const waterId = tileset.waterTerrain.id
    const tick    = _animTick()
    ctx.save()
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const d = map._decorations[y][x]
            if (!d) continue
            // getRaw uses 1-cell-padded _terrain array, so tile (x,y) → _terrain[y+1][x+1]
            if (getRaw(map, d.x + 1, d.y + 1) !== waterId) continue
            const key = `${d.assetId}:${d.stateId ?? ''}:${d.x}:${d.y}:${d.dx ?? 0}:${d.dy ?? 0}:${d.flipX ? 1 : 0}:${d.scale ?? 1}`
            if (!_objectFoamCache.has(key)) {
                _objectFoamCache.set(key, _buildObjectFoamParticles(d))
            }
            for (const sp of _objectFoamCache.get(key)) {
                const pos = ((tick - sp.phase) % sp.period + sp.period) % sp.period / sp.period
                const a   = Math.max(0, 1 - 2 * Math.abs(pos - 0.5))
                if (a < 0.02) continue
                ctx.globalAlpha = a * 0.85
                ctx.drawImage(sp.stamp, sp.drawX, sp.drawY)
            }
        }
    }
    ctx.globalAlpha = 1
    ctx.restore()
}

// ─── Wind animation (same algorithm as editor) ────────────────────────────────
// Weather `wind` (px/s) maps to one of 5 deform buckets (bandwidth 50, calm center).
// Each bucket's deformation sheet is baked once + cached; bucket 2 (calm) is
// bit-identical to the base sheet. 5 buckets is enough for pixel-art resolution.
const WIND_BUCKET_CENTERS = [-100, -50, 0, 50, 100]
const WIND_BASE_BUCKET = 2   // calm: bit-identical to the original symmetric sheet
function windBucket(w) {
    if (w <= -75) return 0
    if (w <= -25) return 1
    if (w <=  25) return 2
    if (w <=  75) return 3
    return 4
}

// Mirror a bucket across the calm center (0↔4, 1↔3). flipX decorations bake with
// the mirrored bucket so the on-screen flip leans them downwind.
function _mirrorBucket(b) { return 4 - b }
function _normWindForBucket(b) { return WIND_BUCKET_CENTERS[b] / 100 }

/** Cache source sprite RGBA per (asset, state). getImageData is a ~16ms GPU→CPU
 *  readback; caching avoids repeating it per wind bucket (the dominant bake cost). */
function getWindSrcData(asset, ts, state, tx, ty, tw, th, W, H) {
    const key = asset.id + ':' + (state.id ?? '')
    const hit = _windSrcImgCache.get(key)
    if (hit) return hit
    const src    = document.createElement('canvas')
    src.width = W; src.height = H
    const srcCtx = src.getContext('2d')
    srcCtx.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], W, H, 0, 0, W, H)
    const S = srcCtx.getImageData(0, 0, W, H).data   // source RGBA (detached copy; safe after src is GC'd)
    _windSrcImgCache.set(key, S)
    return S
}

function generateWindSheet(asset, normWind = 0) {
    const wind  = asset.wind          // [frames, amplitude, rigidity]
    const ts    = asset.tileset
    const state = asset.states.find(s => s.id === asset.defaultState) ?? asset.states[0]
    const [tx, ty, tw, th] = state.region
    const W = tw * ts.size[0], H = th * ts.size[1]

    const frames     = wind[0]
    const amplitude  = wind[1]
    const rigidity   = wind[2]
    const rootRow    = Math.round(asset.pivot[1] * H)
    // normWind∈[-1,1] from the current bucket's center; bias leans the sprite
    // downwind, wind_factor inflates the symmetric oscillation. normWind=0 ⇒ base sheet.
    const bias        = normWind * 6
    const wind_factor = 1 + Math.abs(normWind)

    // Source pixels: a single cached GPU readback reused across every bucket bake.
    const S = getWindSrcData(asset, ts, state, tx, ty, tw, th, W, H)

    const falloff = new Float32Array(H)
    for (let row = 0; row < H; row++)
        falloff[row] = row < rootRow ? Math.pow(1 - row / rootRow, rigidity) : 0

    // Bake the whole sheet into ONE output buffer, uploaded with a single putImageData.
    const sheetW = W * frames
    const out = new Uint8ClampedArray(sheetW * H * 4)

    for (let i = 0; i < frames; i++) {
        const t       = frames > 1 ? i / (frames - 1) : 0
        const swing   = -Math.cos(t * Math.PI) * wind_factor * amplitude + bias
        const frameX4 = i * W * 4

        for (let row = 0; row < H; row++) {
            const sway    = swing * falloff[row]
            const rowBase = row * W * 4
            const outRow  = row * sheetW * 4 + frameX4

            // sway is CONSTANT for this row and col advances by exactly 1, so the
            // fractional offset — and thus all four Catmull-Rom weights — is the SAME
            // for every column. Compute the weights once per row instead of once per
            // pixel per channel (the previous version allocated arrays + closures per
            // pixel on top of that).
            const negSway = -sway
            const x1_0    = Math.floor(negSway)
            const ft      = negSway - x1_0
            const t2 = ft * ft, t3 = t2 * ft
            const c0 = -0.5*t3 + t2 - 0.5*ft
            const c1 =  1.5*t3 - 2.5*t2 + 1
            const c2 = -1.5*t3 + 2*t2 + 0.5*ft
            const c3 =  0.5*t3 - 0.5*t2

            for (let col = 0; col < W; col++) {
                const x1  = x1_0 + col          // integer tap, cheap increment
                const xm1 = x1 - 1, xp1 = x1 + 1, xp2 = x1 + 2

                // Zero-fill at the horizontal edges (transparent OOB), matching the
                // original getPixel() — NOT edge-clamped. Marked by index -1 → treats
                // the tap as contributing 0.
                const i0 = (xm1 >= 0 && xm1 < W) ? rowBase + xm1 * 4 : -1
                const i1 = (x1  >= 0 && x1  < W) ? rowBase + x1  * 4 : -1
                const i2 = (xp1 >= 0 && xp1 < W) ? rowBase + xp1 * 4 : -1
                const i3 = (xp2 >= 0 && xp2 < W) ? rowBase + xp2 * 4 : -1

                const o = outRow + col * 4
                let v

                v = (i0<0?0:S[i0])   *c0 + (i1<0?0:S[i1])   *c1 + (i2<0?0:S[i2])   *c2 + (i3<0?0:S[i3])   *c3
                out[o]   = v < 0 ? 0 : v > 255 ? 255 : v
                v = (i0<0?0:S[i0+1])*c0 + (i1<0?0:S[i1+1])*c1 + (i2<0?0:S[i2+1])*c2 + (i3<0?0:S[i3+1])*c3
                out[o+1] = v < 0 ? 0 : v > 255 ? 255 : v
                v = (i0<0?0:S[i0+2])*c0 + (i1<0?0:S[i1+2])*c1 + (i2<0?0:S[i2+2])*c2 + (i3<0?0:S[i3+2])*c3
                out[o+2] = v < 0 ? 0 : v > 255 ? 255 : v
                v = (i0<0?0:S[i0+3])*c0 + (i1<0?0:S[i1+3])*c1 + (i2<0?0:S[i2+3])*c2 + (i3<0?0:S[i3+3])*c3
                out[o+3] = v < 0 ? 0 : v > 255 ? 255 : v
            }
        }
    }

    const sheet = document.createElement('canvas')
    sheet.width = sheetW; sheet.height = H
    sheet.getContext('2d').putImageData(new ImageData(out, sheetW, H), 0, 0)
    return sheet
}

// Per-frame wind state: resolved once per render() from the live weather, then read
// by every wind-aware decoration / silhouette draw this frame (cheap; one engine call).
// `bucket` is the quantized 0..10 wind bucket; `normWind` is the bucket CENTER mapped
// to [-1,1]. `snap` is true when the weather just changed with no transition (instant)
// AND the bucket differs from last frame — the sheet cache bakes synchronously that
// frame so decorations don't linger at a stale bend after an abrupt set_weather.
let _windFrameBucket = WIND_BASE_BUCKET
let _windFrameNormWind = 0
let _windFrameSnap = false
let _windPrevBucket = WIND_BASE_BUCKET

// Lazy bake budgets: how many wind SHEETS and their per-frame SILHOUETTES may be
// freshly baked per render frame. Reset to these at the top of render() so a wind
// change amortizes its bakes across frames instead of spiking in one. Silhouettes are
// budgeted too (a sheet bake can fan out to N on-screen trees × up to 9 frames each),
// otherwise a single bucket of sheets finishing the same frame would bake N×9 silhouette
// canvases in that one frame.
const WIND_BAKES_PER_FRAME = 2
let _windBakeBudget = WIND_BAKES_PER_FRAME
const WIND_SIL_BAKES_PER_FRAME = 4
let _windSilBakeBudget = WIND_SIL_BAKES_PER_FRAME

/** Resolve the live weather wind for the current map into bucket/normWind for this
 *  frame. Idempotent within a frame (guarded by _windFrameResolved). */
let _windFrameResolved = false
function _resolveWindFrame() {
    if (_windFrameResolved) return
    _windFrameResolved = true
    const live = engine.getWeatherFor(_currentMapId)
    const bucket = windBucket(live.wind || 0)
    _windFrameSnap = !live.transition && bucket !== _windPrevBucket
    _windFrameBucket = bucket
    _windFrameNormWind = WIND_BUCKET_CENTERS[bucket] / 100
    _windPrevBucket = bucket
}
function _resetWindFrame() {
    _windFrameResolved = false
    // Bounded lazy budgets for tweens AND instant snaps. A snap no longer bakes all
    // on-screen trees in one frame (that was the perf spike); instead trees render at
    // the nearest already-baked bucket and flip to the new bucket over the next couple
    // of frames — a sub-100ms settle that reads as the wind gusting in, not a hitch.
    _windBakeBudget = WIND_BAKES_PER_FRAME
    _windSilBakeBudget = WIND_SIL_BAKES_PER_FRAME
}

function _windSheetKey(assetId, bucket) { return assetId + ':' + bucket }

// Per-asset baked-bucket bookkeeping, so nearest-bucket lookups are O(buckets) with
// NO Map iteration / string parsing. The previous _nearestBakedBucket / _nearestBakedSilhouette
// scanned the WHOLE windCache/silhouette store on every silhouette miss — string-slicing
// each key — and that scan was ~2.5ms per call during a wind transition, called per-tree-per-frame.
//   _windBakedSheets: assetId → Int8Array(N), set[b]=1 if bucket b's sheet is baked.
//   _windSils:        assetId → Array(N) of Array(9) of canvas|null.
//                     Replaces the former flat string-keyed Map: the hot path
//                     "give me sil for (bucket, fi)" is matrix[bucket][fi] — pure integer
//                     indexing, no string concat, no Map hashing (was the >1ms/frame
//                     getWindSilhouette cost at steady wind). A non-null slot == baked.
const NUM_WIND_BUCKETS = 5
const _windBakedSheets = new Map()   // assetId → Int8Array(5)
const _windSils        = new Map()   // assetId → Array(5) of Array(9) of canvas|null
function _markSheetBaked(assetId, bucket) {
    let arr = _windBakedSheets.get(assetId)
    if (!arr) { arr = new Int8Array(NUM_WIND_BUCKETS); _windBakedSheets.set(assetId, arr) }
    arr[bucket] = 1
}
/** Get (creating if first use) asset's sil matrix [N][9]. Entry [bucket][fi] is canvas|null. */
function _windSilMatrix(assetId) {
    let m = _windSils.get(assetId)
    if (!m) {
        m = new Array(NUM_WIND_BUCKETS)
        for (let b = 0; b < NUM_WIND_BUCKETS; b++) m[b] = new Array(9).fill(null)
        _windSils.set(assetId, m)
    }
    return m
}

/** Nearest bucket (to `target`) whose sheet is baked for `asset`, via the compact per-asset
 *  baked-sheets bitmap. O(11), no string/Map iteration. Returns -1 if none baked. */
function _nearestBakedBucket(asset, target) {
    const arr = _windBakedSheets.get(asset.id)
    if (!arr) return -1
    let best = -1, bestDist = Infinity
    for (let b = 0; b < NUM_WIND_BUCKETS; b++) {
        if (arr[b] !== 1) continue
        const d = Math.abs(b - target)
        if (d < bestDist) { bestDist = d; best = b }
    }
    return best
}

/** Get the wind sprite-sheet for the current frame's bucket, baking lazily.
 *  - If the bucket's sheet is cached → return it (steady-wind fast path, no bake).
 *  - Else if bake budget remains → bake + cache this bucket, return it.
 *  - Else → return the nearest already-baked bucket's sheet (stale-but-present) so
 *    the deco draws at the previous bend and flips to the new bucket over successive
 *    frames as the budget allows — the staggered "trees bend one by one" effect. */
function getWindSheet(asset, bucket = _windFrameBucket, normWind = _windFrameNormWind) {
    const key = _windSheetKey(asset.id, bucket)
    const hit = windCache.get(key)
    if (hit) return hit
    if (_windBakeBudget > 0) {
        _windBakeBudget--
        const sheet = generateWindSheet(asset, normWind)
        windCache.set(key, sheet)
        _markSheetBaked(asset.id, bucket)
        return sheet
    }
    // Budget exhausted: fall back to the nearest already-baked bucket for this asset so
    // the deco draws at a previous bend until its sheet bakes over successive frames.
    const nearest = _nearestBakedBucket(asset, bucket)
    if (nearest >= 0) return windCache.get(_windSheetKey(asset.id, nearest))
    // Nothing baked for this asset at all (e.g. very first frame, budget already spent
    // elsewhere): bake the calm (base) sheet unconditionally so we never return undefined.
    // The base sheet is also the most reusable (calm), so it's the best one to seed.
    const baseSheet = generateWindSheet(asset, 0)
    windCache.set(_windSheetKey(asset.id, WIND_BASE_BUCKET), baseSheet)
    _markSheetBaked(asset.id, WIND_BASE_BUCKET)
    return baseSheet
}

function getWindFrame(frames, phaseMs = 0, fps = 6) {
    const cycleLen = (frames - 1) * 2
    if (cycleLen <= 0) return 0
    const t = Math.floor((performance.now() + phaseMs) / (1000 / fps)) % cycleLen
    return t < frames ? t : cycleLen - t
}

// ─── Effect rendering ─────────────────────────────────────────────────────────
function renderEffect(ef) {
    const def = EFFECT_DEFS[ef.type]
    if (!def?.img) return
    const fi    = Math.floor((performance.now() + (ef.phase ?? 0)) / ANIM_TICK_MS) % def.frames
    const scale = ef.scale ?? 1
    const w     = def.w * scale
    const h     = def.h * scale
    const wx    = ef.x * TILE + TILE / 2 + (ef.dx ?? 0)
    const wy    = ef.y * TILE + TILE / 2 + (ef.dy ?? 0)
    ctx.drawImage(def.img, fi * def.w, (def.row ?? 0) * def.h, def.w, def.h, wx - w / 2, wy - h, w, h)
}

// ─── Player sprite ────────────────────────────────────────────────────────────
// Returns the current sheet column for the player, stepping through the idle
// sequence (3 cols) when standing and the walk sequence (8 cols) when moving.
function _heroAnimCol(moving) {
    // Walk animates at 2× ANIM_FPS (legs too slow at 1×); idle breathes slower.
    const fps = moving ? ANIM_FPS * 2 : Math.max(2, Math.round(ANIM_FPS / 2))
    const seq = moving ? HERO_WALK_FRAMES : HERO_IDLE_FRAMES
    const tick = Math.floor(performance.now() / (1000 / fps))
    return seq[tick % seq.length]
}

function renderPlayer() {
    const sprite = playerSprites.sheet
    if (!sprite) return
    const col = _heroAnimCol(player.moving)
    const row = DIR_ROW[player.dir] | 0
    const dw = HERO_FRAME_W * HERO_SCALE
    const dh = HERO_FRAME_H * HERO_SCALE
    // Foot is at HERO_FOOT_X (source px) / HERO_FOOT_Y within the frame; scale the
    // offset so the tile-anchored feet stay put regardless of HERO_SCALE.
    const ox = HERO_FOOT_X * HERO_SCALE
    const oy = HERO_FOOT_Y * HERO_SCALE
    ctx.drawImage(sprite,
        col * HERO_FRAME_W, row * HERO_FRAME_H, HERO_FRAME_W, HERO_FRAME_H,
        Math.round(player.px) - ox,
        Math.round(player.py) - oy,
        dw, dh)
}

// Load the hero sprite sheet selected by the scenario's "hero" field
// (default "Tom"). Swapping scenarios re-bakes the shadow sheet so it matches
// the new silhouette. A missing name falls back to the last-loaded hero.
function loadHeroSprite(name) {
    const heroName = (name || playerSprites.heroName || 'Tom').replace(/^Hero_/, '')
    if (heroName === playerSprites.heroName && playerSprites.sheet) return Promise.resolve()
    const file = 'Hero_' + heroName + '.png'
    return loadImage('../characters/' + file).then(img => {
        playerSprites.sheet = img
        playerSprites.heroName = heroName
        playerSprites.cols = img.naturalWidth / HERO_FRAME_W | 0
        _bakePlayerShadowSheet()
        _drawHeroIcon()
        console.log('[Player] Hero sprite loaded:', heroName, `(${playerSprites.cols} columns)`)
    }).catch(e => {
        console.warn('[Player] Hero sprite not found, keeping previous:', file, e.message)
    })
}

// ─── Shadow rendering ────────────────────────────────────────────────────────
const SKEW_SHADOW_SKEW  = 0.7
const SKEW_SHADOW_SCALE = 0.5

const _silhouetteCache      = new Map()
const _rayTracedShadowCache = new Map()

function getSilhouette(asset, stateId) {
    const key = asset.id + ':' + (stateId ?? asset.defaultState)
    if (_silhouetteCache.has(key)) return _silhouetteCache.get(key)
    const ts    = asset.tileset
    const state = asset.states.find(s => s.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
    const [tx, ty, tw, th] = state.region
    const srcW = tw * ts.size[0], srcH = th * ts.size[1]
    const sil  = document.createElement('canvas')
    sil.width  = srcW; sil.height = srcH
    const sc   = sil.getContext('2d')
    sc.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], srcW, srcH, 0, 0, srcW, srcH)
    sc.globalCompositeOperation = 'source-in'
    sc.fillStyle = '#000'
    sc.fillRect(0, 0, srcW, srcH)
    _silhouetteCache.set(key, sil)
    return sil
}

function getWindSilhouette(asset, fi, bucket = _windFrameBucket, normWind = _windFrameNormWind) {
    // Hot path (steady wind, silhouette baked): pure integer indexing into _windSils's
    // nested matrix [bucket][fi]. No string concat, no Map hashing — that was the
    // >1ms/frame getWindSilhouette cost at steady wind (per-shadow string-key builds +
    // Map.get every tick). We only resolve/bake when the requested slot is null.
    const sils = _windSilMatrix(asset.id)
    let sil = sils[bucket] && sils[bucket][fi]
    if (sil) return sil

    // Resolve the sheet bucket that is ACTUALLY baked and nearest to the requested one.
    // We never bake a silhouette from a stale-fallback sheet: only from a bucket whose
    // sheet is actually baked (resolved via _nearestBakedBucket). The sprite draw path
    // already triggers the requested bucket's sheet bake (getWindSheet) driving baking.
    const realBucket = _nearestBakedBucket(asset, bucket)
    if (realBucket >= 0) {
        sil = sils[realBucket] && sils[realBucket][fi]
        if (sil) return sil
        // Budget the silhouette bake so a frame where many sheets become real doesn't
        // fan out to N×9 silhouette canvases in one shot. If budget is out, fall back to
        // the nearest already-baked silhouette (across all baked buckets of this asset).
        if (_windSilBakeBudget > 0) {
            _windSilBakeBudget--
            const sheet = windCache.get(_windSheetKey(asset.id, realBucket))
            sil = _bakeSilhouette(asset, sheet, fi)
            sils[realBucket][fi] = sil
            return sil
        }
        // Budget out: return the nearest already-baked silhouette canvas for this asset.
        const nearestSil = _nearestBakedSilhouette(sils, fi, realBucket)
        if (nearestSil) return nearestSil
        // No baked silhouette yet for any bucket: seed one from the calm bucket's sheet.
        return _seedWindSilhouette(asset, fi)
    }
    // No sheet baked for this asset at all yet: seed the calm silhouette so we never
    // return undefined. The sprite draw path already triggers the first sheet bake.
    return _seedWindSilhouette(asset, fi)
}

/** Build one wind-silhouette canvas: blade `fi` of `sheet` traced to solid black
 *  (source-in fill). No caching here — caller stores the result in _windSils. */
function _bakeSilhouette(asset, sheet, fi) {
    const state = asset.states.find(s => s.id === asset.defaultState) ?? asset.states[0]
    const [,, tw, th] = state.region
    const W = tw * asset.tileset.size[0], H = th * asset.tileset.size[1]
    const sil = document.createElement('canvas')
    sil.width = W; sil.height = H
    const sc = sil.getContext('2d')
    sc.drawImage(sheet, fi * W, 0, W, H, 0, 0, W, H)
    sc.globalCompositeOperation = 'source-in'
    sc.fillStyle = '#000'
    sc.fillRect(0, 0, W, H)
    return sil
}

/** Seed (and cache) the calm-bucket silhouette for `asset` so the silhouette path always
 *  has a canvas to return. Baked directly from the calm sheet (ensured to exist). */
function _seedWindSilhouette(asset, fi) {
    const realBucket = _nearOrBaseBucket(asset, WIND_BASE_BUCKET)
    const sils = _windSilMatrix(asset.id)
    const existing = sils[realBucket] && sils[realBucket][fi]
    if (existing) return existing
    const sheet = getWindSheet(asset, realBucket, _normWindForBucket(realBucket))   // forces the calm/base bake if missing
    const sil = _bakeSilhouette(asset, sheet, fi)
    sils[realBucket][fi] = sil
    return sil
}

/** Nearest bucket to `target` whose sheet is baked, or `fallback` if none baked. */
function _nearOrBaseBucket(asset, fallback) {
    const b = _nearestBakedBucket(asset, fallback)
    return b >= 0 ? b : fallback
}

/** Find the nearest already-baked silhouette canvas for `asset`/`fi` across baked
 *  buckets, closest in bucket value to `fromBucket`, by scanning the nested sil matrix.
 *  O(buckets), no string/Map iteration. Returns undefined if no (bucket, fi) sil baked. */
function _nearestBakedSilhouette(sils, fi, fromBucket) {
    let bestBucket = -1, bestDist = Infinity
    for (let b = 0; b < NUM_WIND_BUCKETS; b++) {
        if (!sils[b] || !sils[b][fi]) continue
        const d = Math.abs(b - fromBucket)
        if (d < bestDist) { bestDist = d; bestBucket = b }
    }
    if (bestBucket < 0) return undefined
    return sils[bestBucket][fi]
}

function getRayTracedShadow(asset) {
    const key = asset.id
    if (_rayTracedShadowCache.has(key)) return _rayTracedShadowCache.get(key)
    const s   = asset.shadow
    const ts  = asset.tileset
    const state = asset.states[0]
    const [tx, ty, tw, th] = state.region
    const sw  = tw * ts.size[0], sh = th * ts.size[1]
    const ang = s.angle * Math.PI / 180
    const cos = Math.cos(ang), sina = Math.sin(ang)
    const len = s.length
    const eR  = cos  > 0 ? Math.ceil( cos  * len) : 0
    const eL  = cos  < 0 ? Math.ceil(-cos  * len) : 0
    const eB  = sina > 0 ? Math.ceil( sina * len) : 0
    const eT  = sina < 0 ? Math.ceil(-sina * len) : 0
    const src = document.createElement('canvas')
    src.width = sw; src.height = sh
    const sc  = src.getContext('2d')
    sc.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], sw, sh, 0, 0, sw, sh)
    const dat = sc.getImageData(0, 0, sw, sh).data
    const solid = (x, y) => x >= 0 && x < sw && y >= 0 && y < sh && dat[(y * sw + x) * 4 + 3] > 10
    const out  = document.createElement('canvas')
    out.width  = sw + eL + eR; out.height = sh + eT + eB
    const oc   = out.getContext('2d')
    oc.fillStyle = '#000'
    for (let py = 0; py < sh; py++) {
        for (let px = 0; px < sw; px++) {
            if (!solid(px, py)) continue
            let edge = false
            outer: for (let ny = -1; ny <= 1; ny++)
                for (let nx = -1; nx <= 1; nx++) {
                    if (nx === 0 && ny === 0) continue
                    if (!solid(px + nx, py + ny)) { edge = true; break outer }
                }
            if (!edge) continue
            for (let step = 0.5; step <= len; step += 0.5)
                oc.fillRect(Math.round(eL + px + cos * step), Math.round(eT + py + sina * step), 1, 1)
        }
    }
    const result = { canvas: out, ox: -eL, oy: -eT }
    _rayTracedShadowCache.set(key, result)
    return result
}

// Per-asset invariant geometry used by the shadow path. Asset/state data never
// changes after load, so resolve it once and cache it — this removes a
// states.find() + several multiplies per deco per frame from the hot path.
const _decoShadowGeom = new Map()
function _getDecoShadowGeom(asset, stateId) {
    const key = asset.id + ':' + (stateId ?? asset.defaultState)
    let g = _decoShadowGeom.get(key)
    if (g) return g
    const ts    = asset.tileset
    const state = asset.states.find(st => st.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
    const [,, tw, th] = state.region
    g = {
        state,
        dstW: tw * ts.size[0],
        dstH: th * ts.size[1],
        pivX: asset.pivot[0],
        pivY: asset.pivot[1],
    }
    _decoShadowGeom.set(key, g)
    return g
}

// tctx = target context (the shared offscreen shadow canvas, already transformed)
function drawDecorationShadow(d, asset, tctx) {
    const s = asset.shadow
    if (!s) return
    const g = _getDecoShadowGeom(asset, d.stateId)
    const { dstW, dstH, pivX, pivY } = g
    const worldX = d.x * TILE + TILE / 2 + (d.dx || 0)
    const worldY = d.y * TILE + TILE / 2 + (d.dy || 0)
    const pYdstH = Math.round(pivY * dstH)

    tctx.save()

    if (s.type === 'oval') {
        tctx.fillStyle = '#000'
        tctx.beginPath()
        tctx.ellipse(worldX, worldY, s.rx, s.ry, 0, 0, Math.PI * 2)
        tctx.fill()

    } else if (s.type === 'sprite' || s.type === 'skew') {
        // Wind silhouette only needed for these types — skip getWindFrame/Math.random
        // entirely for oval/ray decos, and avoid the _windPhase allocation on non-wind assets.
        const windActive = asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0
        // FlipX mirrors the sprite on screen; bake the silhouette at the mirrored bucket
        // so the baked wind lean survives the flip and points downwind on screen.
        const wB = d.flipX ? _mirrorBucket(_windFrameBucket) : _windFrameBucket
        const sil = windActive
            ? getWindSilhouette(asset, getWindFrame(asset.wind[0], d._windPhase ?? (d._windPhase = Math.random() * 100000)), wB, _normWindForBucket(wB))
            : getSilhouette(asset, d.stateId)
        if (s.type === 'sprite') {
            tctx.translate(worldX + s.d, worldY + s.d)
            if (d.flipX) tctx.scale(-1, 1)
            tctx.drawImage(sil, Math.round(-pivX * dstW), Math.round(-pivY * dstH))
        } else {
            const dstX = worldX - Math.round(pivX * dstW)
            const dstY = worldY - pYdstH
            tctx.translate(dstX, dstY)
            tctx.transform(1, 0, -SKEW_SHADOW_SKEW, -SKEW_SHADOW_SCALE,
                pYdstH * SKEW_SHADOW_SKEW,
                pYdstH * (1 + SKEW_SHADOW_SCALE))
            if (d.flipX) {
                tctx.translate(pivX * dstW, 0)
                tctx.scale(-1, 1)
                tctx.translate(-pivX * dstW, 0)
            }
            tctx.drawImage(sil, 0, 0)
        }

    } else if (s.type === 'ray') {
        const shadow = getRayTracedShadow(asset)
        const dstX   = worldX - pivX * dstW
        const dstY   = worldY - pivY * dstH
        if (d.flipX) {
            tctx.translate(worldX, 0)
            tctx.scale(-1, 1)
            tctx.translate(-worldX, 0)
        }
        tctx.drawImage(shadow.canvas, dstX + shadow.ox, dstY + shadow.oy)
    }

    tctx.restore()
}

// ─── Pre-baked player shadow spritesheet ──────────────────────────────────────────
// Layout: 4 rows (one per direction), playerSprites.cols columns per row so the
// shadow for any walk/idle column can be looked up by (dir, col).
// Size: per-cell SHADOW_FRAME_W × SHADOW_FRAME_H, rebuilt on hero swap.
// Each cell is the full transformed shadow (including skew/scale).
const SHADOW_FRAME_W = Math.ceil(HERO_FRAME_W * (1 + SKEW_SHADOW_SKEW))
const SHADOW_FRAME_H = Math.ceil(HERO_FRAME_H * (1 + SKEW_SHADOW_SCALE))
let _playerShadowSheet = document.createElement('canvas')
// Canvas will be sized lazily in _bakePlayerShadowSheet from the current hero's cols.
const _SHADOW_ROWS = 4

function _bakePlayerShadowSheet() {
    const sprite = playerSprites.sheet
    if (!sprite) return
    const cols = playerSprites.cols
    if (!_playerShadowSheet) _playerShadowSheet = document.createElement('canvas')
    _playerShadowSheet.width  = SHADOW_FRAME_W * cols
    _playerShadowSheet.height = SHADOW_FRAME_H * _SHADOW_ROWS
    const ctx = _playerShadowSheet.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, _playerShadowSheet.width, _playerShadowSheet.height)
    const pivY = HERO_FOOT_Y / HERO_FRAME_H
    const offsetX = Math.round(pivY * HERO_FRAME_H * SKEW_SHADOW_SKEW)
    const offsetY = Math.round(pivY * HERO_FRAME_H * (1 + SKEW_SHADOW_SCALE))

    for (let dir = 0; dir < _SHADOW_ROWS; dir++) {
        for (let frame = 0; frame < cols; frame++) {
            // Draw silhouette to temp canvas
            const sil = document.createElement('canvas')
            sil.width = HERO_FRAME_W; sil.height = HERO_FRAME_H
            const sc = sil.getContext('2d')
            sc.drawImage(sprite, frame * HERO_FRAME_W, dir * HERO_FRAME_H, HERO_FRAME_W, HERO_FRAME_H, 0, 0, HERO_FRAME_W, HERO_FRAME_H)
            sc.globalCompositeOperation = 'source-in'
            sc.fillStyle = '#000'
            sc.fillRect(0, 0, HERO_FRAME_W, HERO_FRAME_H)

            // Draw transformed shadow into spritesheet cell
            const dx = frame * SHADOW_FRAME_W
            const dy = dir * SHADOW_FRAME_H

            ctx.save()
            ctx.translate(dx + offsetX, dy + offsetY)
            ctx.transform(1, 0, -SKEW_SHADOW_SKEW, -SKEW_SHADOW_SCALE, 0, 0)
            ctx.drawImage(sil, 0, 0)
            ctx.restore()
        }
    }
}

function renderPlayerShadow(tctx) {
    const sprite = playerSprites.sheet
    if (!sprite) return
    const col = _heroAnimCol(player.moving)
    const row = DIR_ROW[player.dir] | 0
    const sx = col * SHADOW_FRAME_W
    const sy = row * SHADOW_FRAME_H
    // Draw the baked shadow scaled to match HERO_SCALE, anchoring on the feet.
    const dw = SHADOW_FRAME_W * HERO_SCALE
    const dh = SHADOW_FRAME_H * HERO_SCALE
    const dstX = Math.round(player.px) - HERO_FOOT_X * HERO_SCALE
    const dstY = Math.round(player.py) - HERO_FOOT_Y * HERO_SCALE
    tctx.drawImage(_playerShadowSheet, sx, sy, SHADOW_FRAME_W, SHADOW_FRAME_H, Math.round(dstX), Math.round(dstY), dw, dh)
}

// ─── Decoration + shadow cache ────────────────────────────────────────────────
// Rebuilt when the global wind tick or the player's tile row changes.
// Split at the player's tile row: items below player go in _decoUnder,
// items above (in front of player) go in _decoOver.
// During movement we skip the cache and render per-frame instead.
let _decoUnder = null, _decoOver = null
let _decoShadow = null            // baked composite of all shadows (player+monsters+npcs+decos)
let _decoOriginX = 0, _decoOriginY = 0
let _decoCentreX = 0, _decoCentreY = 0
let _decoHalfW   = 0, _decoHalfH   = 0
let _decoCachedTileX = -1, _decoCachedTileY = -1, _decoCachedWindTick = -1, _decoCachedEffectTick = -1

/** Drop the baked decoration layers so the next frame re-renders freshly
 *  planted/removed tiles. Used by the spawn/remove_decoration ECA hooks. */
function _invalidateDecoCache() {
    _decoUnder = null; _decoOver = null; _decoShadow = null
    _decoCachedTileX = -1; _decoCachedTileY = -1
    _decoCachedWindTick = -1; _decoCachedEffectTick = -1
}

/** Resolve a terrain value for the change_tile ECA hook to a numeric terrain id.
 *  Accepts: a number (used as-is), or a string — matched against the current
 *  tileset's terrain ids (numeric strings) or names (case-insensitive, treating
 *  spaces and underscores as equivalent, e.g. "deep_water" == "Deep Water").
 *  Returns the id, or null if it can't be resolved (with a warning). */
function _resolveTerrainId(terrainRaw) {
    if (typeof terrainRaw === 'number') return terrainRaw
    if (terrainRaw == null) { console.warn('[ECA] change_tile: missing terrain'); return null }
    const s = String(terrainRaw).trim()
    if (s === '') { console.warn('[ECA] change_tile: empty terrain'); return null }
    // Numeric strings → ids directly.
    if (/^-?\d+$/.test(s)) return parseInt(s, 10)
    if (!tileset?.terrains) {
        console.warn(`[ECA] change_tile: can't resolve terrain "${s}" — no tileset`)
        return null
    }
    const norm = name => name.toLowerCase().replace(/[\s_]+/g, '')
    const want = norm(s)
    const byName = tileset.terrains.find(t => norm(t.name ?? '') === want)
    if (byName) return byName.id
    console.warn(`[ECA] change_tile: unknown terrain "${s}"`)
    return null
}

// Global wind tick: advances every 1000/6 ms (matches getWindFrame fps)
const WIND_FPS = 6
function _windTick() {
    const cycleLen = (9 - 1) * 2   // 9 wind frames, ping-pong
    return Math.floor(performance.now() / (1000 / WIND_FPS)) % cycleLen
}
// Effect tick: advances at the highest fps used by any effect (fire = 12fps)
// Drives cache invalidation so baked effect frames stay in sync.
// Effect tick unified with water — both use _animTick() (10fps)
function _effectTick() { return _animTick() }

// Decoration sprite cache — stores ONLY sprites (no shadows, no effects).
// Shadows and effects are always drawn fresh so both render paths look identical.
function _buildDecoCache(items, playerSortY) {
    const halfW = Math.ceil(canvas.width  / (TILE * ZOOM * 2)) + TERRAIN_MARGIN
    const halfH = Math.ceil(canvas.height / (TILE * ZOOM * 2)) + TERRAIN_MARGIN
    const cx = player.tileX, cy = player.tileY
    const tw = (halfW * 2 + 1) * TILE, th = (halfH * 2 + 1) * TILE

    // Skip the rebuild when the cache is still valid (player idle on same tile,
    // wind/effect ticks unchanged, still inside the cached half-margin window, and
    // the viewport size is unchanged). This avoids redundantly re-baking
    // _decoUnder/_decoOver/_decoShadow every idle frame — the render path already
    // reuses them when cacheValid is true.
    if (_decoUnder && _decoOver && _decoShadow
        && _decoUnder.width === tw && _decoUnder.height === th
        && _decoCachedTileX === cx && _decoCachedTileY === cy
        && _decoCachedWindTick === _windTick() && _decoCachedEffectTick === _effectTick()
        && Math.abs(cx - _decoCentreX) <= _decoHalfW - 2
        && Math.abs(cy - _decoCentreY) <= _decoHalfH - 2) {
        return
    }

    _decoCentreX = cx; _decoCentreY = cy
    _decoHalfW = halfW; _decoHalfH = halfH
    _decoOriginX = (cx - halfW - 1) * TILE + TILE / 2
    _decoOriginY = (cy - halfH - 1) * TILE + TILE / 2

    if (!_decoUnder || _decoUnder.width !== tw || _decoUnder.height !== th) {
        _decoUnder = document.createElement('canvas'); _decoUnder.width = tw; _decoUnder.height = th
    }
    if (!_decoOver  || _decoOver.width  !== tw || _decoOver.height  !== th) {
        _decoOver  = document.createElement('canvas'); _decoOver.width  = tw; _decoOver.height  = th
    }
    if (!_decoShadow || _decoShadow.width !== tw || _decoShadow.height !== th) {
        _decoShadow = document.createElement('canvas'); _decoShadow.width = tw; _decoShadow.height = th
    }

    const uc = _decoUnder.getContext('2d'), oc = _decoOver.getContext('2d')
    uc.imageSmoothingEnabled = false; oc.imageSmoothingEnabled = false
    // resetTransform before clearRect — canvas contexts preserve transform between calls,
    // so the leftover translate from the previous build would shift the cleared region,
    // leaving old sprite data in the part of the canvas that maps above the map boundary.
    uc.resetTransform(); uc.clearRect(0, 0, tw, th)
    oc.resetTransform(); oc.clearRect(0, 0, tw, th)

    // Translate so world coords map directly to canvas pixels
    const otx = -_decoOriginX, oty = -_decoOriginY
    uc.setTransform(1, 0, 0, 1, otx, oty)
    oc.setTransform(1, 0, 0, 1, otx, oty)

    // Decoration sprites + effects + monsters baked in sorted order (no shadows).
    // Map items are NOT cached — they're small and any sub-pixel camera misalignment
    // when blitting the cached canvases makes them visibly pixelated. Render live instead.
    const _spDrawn = new Set()
    for (const item of items) {
        if (item.kind === 'player') continue
        if (item.kind === 'mapItem') continue  // rendered live, not cached
        if (item.kind === 'deco' && _spDrawn.has(item.d)) continue
        if (item.kind === 'deco') _spDrawn.add(item.d)
        const tctx = item.sortY <= playerSortY ? uc : oc
        tctx.save()
        if      (item.kind === 'effect')  _renderEffectTo(item.ef, tctx)
        else if (item.kind === 'monster') _renderEntityTo(item.m, tctx)
        else if (item.kind === 'npc')     _renderEntityTo(item.npc, tctx)
        else                              _renderDecoTo(item.d, tctx)
        tctx.restore()
    }

    // Baked shadow composite — mirrors the live 'shadow pass' exactly so the
    // cached render path draws the same shadows. Rebuilt on the same cadence
    // (wind/effect tick, player tile) so monster/npc walk-frame shadows stay in
    // sync (they animate via _animTick, same driver as _decoCachedEffectTick).
    const sc = _decoShadow.getContext('2d')
    sc.imageSmoothingEnabled = false
    sc.resetTransform(); sc.clearRect(0, 0, tw, th)
    sc.setTransform(1, 0, 0, 1, otx, oty)
    const _sdDrawn = new Set()
    for (const item of items) {
        if      (item.kind === 'player')  renderPlayerShadow(sc)
        else if (item.kind === 'monster') drawEntityShadow(item.m, sc)
        else if (item.kind === 'npc')     drawEntityShadow(item.npc, sc)
        else if (item.kind === 'deco' && !_sdDrawn.has(item.d)) {
            _sdDrawn.add(item.d)
            const asset = assetMap[item.d.assetId]
            if (asset?.shadow) drawDecorationShadow(item.d, asset, sc)
        }
        // Map items don't cast shadows (they're small ground items)
    }

    _decoCachedTileX = player.tileX; _decoCachedTileY = player.tileY
    _decoCachedWindTick = _windTick(); _decoCachedEffectTick = _effectTick()
}

function _renderDecoTo(d, tctx) {
    const asset = assetMap[d.assetId]; if (!asset) return
    const ts    = asset.tileset
    const state = asset.states.find(s => s.id === (d.stateId ?? asset.defaultState)) ?? asset.states[0]
    const [tx, ty, tw, th] = state.region
    const [pivX, pivY]     = asset.pivot
    const srcX = tx * ts.size[0], srcY = ty * ts.size[1]
    const srcW = tw * ts.size[0], srcH = th * ts.size[1]
    const worldX = d.x * TILE + TILE / 2 + (d.dx || 0)
    const worldY = d.y * TILE + TILE / 2 + (d.dy || 0)
    tctx.save()
    tctx.translate(worldX, worldY)
    if (d.flipX) tctx.scale(-1, 1)
    if (d.scale && d.scale !== 1) tctx.scale(d.scale, d.scale)
    const ox = Math.round(-pivX * srcW), oy = Math.round(-pivY * srcH)
    if (asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0) {
        const wB = d.flipX ? _mirrorBucket(_windFrameBucket) : _windFrameBucket
        const sheet = getWindSheet(asset, wB, _normWindForBucket(wB))
        const fi    = getWindFrame(asset.wind[0], d._windPhase ?? (d._windPhase = Math.random() * 100000))
        tctx.drawImage(sheet, fi * srcW, 0, srcW, srcH, ox, oy, srcW, srcH)
    } else {
        tctx.drawImage(ts.img, srcX, srcY, srcW, srcH, ox, oy, srcW, srcH)
    }
    tctx.restore()
}

function _renderEffectTo(ef, tctx) {
    const def = EFFECT_DEFS[ef.type]; if (!def?.img) return
    const frame  = Math.floor((performance.now() + (ef.phase || 0)) / ANIM_TICK_MS) % def.frames
    const worldX = ef.x * TILE + TILE / 2 + (ef.dx || 0)
    const worldY = ef.y * TILE + TILE / 2 + (ef.dy || 0)
    const w = def.w * (ef.scale || 1), h = def.h * (ef.scale || 1)
    tctx.drawImage(def.img, frame * def.w, (def.row ?? 0) * def.h, def.w, def.h, worldX - w / 2, worldY - h, w, h)
}

function _renderMapItemTo(item, tctx) {
    const { item: mapItem, x, y } = item
    const def = _itemsDef[mapItem.itemId] || _craftDef[mapItem.itemId]
    const icon = def && (def.icon || (Array.isArray(def) ? def : null))
    if (!icon) return
    const img = _itemsDef[mapItem.itemId] ? _itemsImg : _craftImg
    if (!img) return
    const [col, row] = icon
    const worldX = x * TILE + TILE / 2
    const worldY = y * TILE + TILE / 2
    const srcSize = _ITEM_SIZE_HUD
    const destSize = TILE / 2  // 16px (half tile, 2x smaller)
    tctx.save()
    tctx.translate(worldX, worldY)
    // Center the item in the tile
    tctx.drawImage(img,
        col * srcSize, row * srcSize, srcSize, srcSize,
        -destSize / 2, -destSize / 2, destSize, destSize)
    tctx.restore()
}

/**
 * Render map items live (not cached) to avoid sub-pixel blur from cached canvas blitting.
 * Called from both cached and full render paths.
 */
function _renderLiveMapItems(ctx) {
    if (!map._items) return
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const mapItem = map._items[y][x]
            if (!mapItem) continue
            const def = _itemsDef[mapItem.itemId] || _craftDef[mapItem.itemId]
            const icon = def && (def.icon || (Array.isArray(def) ? def : null))
            if (!icon) continue
            const img = _itemsDef[mapItem.itemId] ? _itemsImg : _craftImg
            if (!img) continue
            const [col, row] = icon
            const worldX = x * TILE + TILE / 2
            const worldY = y * TILE + TILE / 2
            const srcSize = _ITEM_SIZE_HUD
            const destSize = TILE / 2  // 16px (half tile, 2x smaller)
            ctx.save()
            ctx.translate(worldX, worldY)
            ctx.drawImage(img,
                col * srcSize, row * srcSize, srcSize, srcSize,
                -destSize / 2, -destSize / 2, destSize, destSize)
            ctx.restore()
        }
    }
}

// Works for both the decoration cache canvas (1× world-coords) and the main ctx (2× world-coords)
// ─── Weapon trim (strips transparent border to find true visual centre) ────────────────
function _computeWeaponTrim(img, sx, sy, sw, sh) {
    const oc = document.createElement('canvas')
    oc.width = sw; oc.height = sh
    const oc2 = oc.getContext('2d')
    oc2.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    const data = oc2.getImageData(0, 0, sw, sh).data
    let minX = sw, maxX = -1, minY = sh, maxY = -1
    for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++)
            if (data[(y * sw + x) * 4 + 3] > 4) {
                if (x < minX) minX = x; if (x > maxX) maxX = x
                if (y < minY) minY = y; if (y > maxY) maxY = y
            }
    if (maxX < 0) return null
    const tw = maxX - minX + 1, th = maxY - minY + 1
    return { sx: sx + minX, sy: sy + minY, sw: tw, sh: th,
             dx: (minX + tw / 2) - sw / 2, dy: (minY + th / 2) - sh / 2 }
}
function _getWeaponTrim(file, col, row, cols, rows) {
    const key = `${file}:${col},${row},${cols},${rows}`
    if (key in _wepTrimCache) return _wepTrimCache[key]
    const img = _weaponSprites[file]; if (!img) return null
    const t = _computeWeaponTrim(img, col * ENEMY_WEP_CELL, row * ENEMY_WEP_CELL,
        cols * ENEMY_WEP_CELL, rows * ENEMY_WEP_CELL)
    _wepTrimCache[key] = t
    return t
}

// ─── Composite enemy renderer ─────────────────────────────────────────────────────
// def: _enemyDefs entry. cx,cy: character centre. scale: world→px. flipX: mirror the whole sprite.
function _drawCompositeEnemy(def, c2d, frame, scale, cx, cy, flipX) {
    const sprite = def.sprite;
    const bob   = FRAME_BOB[frame]
    const lh    = sprite.hands?.left  ?? { x: -10, y: 6, z: 3 }
    const rh    = sprite.hands?.right ?? { x:  10, y: 6, z: 3 }
    const charZ = sprite.z ?? 1
    const handRow = sprite.handRow ?? null
    const weps  = (sprite.weapons ?? []).filter(w => w && w.col != null)

    c2d.save()
    c2d.translate(cx, cy)
    if (flipX) c2d.scale(-1, 1)
    c2d.imageSmoothingEnabled = false

    const layers = []
    const charSprite = monsterSprites[sprite.base]
    if (charSprite) layers.push({ z: charZ, fn: () => {
        const fw = MONSTER_FRAME_W * scale, fh = MONSTER_FRAME_H * scale
        c2d.drawImage(charSprite, frame * MONSTER_FRAME_W, 0, MONSTER_FRAME_W, MONSTER_FRAME_H,
            -fw / 2, -fh / 2, fw, fh)
    }})

    const handImg = _weaponSprites['Weapon-Hands']
    if (handImg && handRow !== null) {
        for (const [col, side] of [[0, lh], [1, rh]]) {
            const s = side
            layers.push({ z: s.z ?? 3, fn: () => {
                const hw = ENEMY_HAND_CELL * scale, hh = ENEMY_HAND_CELL * scale
                c2d.drawImage(handImg,
                    col * ENEMY_HAND_CELL, handRow * ENEMY_HAND_CELL, ENEMY_HAND_CELL, ENEMY_HAND_CELL,
                    s.x * scale - hw / 2, (s.y + bob) * scale - hh / 2, hw, hh)
            }})
        }
    }

    for (const w of weps) {
        const wImg = _weaponSprites[w.file]; if (!wImg) continue
        const t = _getWeaponTrim(w.file, w.col, w.row, w.cols ?? 1, w.rows ?? 1); if (!t) continue
        const rot = (w.rot ?? 0) * Math.PI / 180
        const fH = w.flipH ?? false, fV = w.flipV ?? false
        const wz = w.z ?? 2
        layers.push({ z: wz, fn: () => {
            const ox = (w.x + t.dx) * scale, oy = (w.y + bob + t.dy) * scale
            const dw = t.sw * scale, dh = t.sh * scale
            c2d.save()
            c2d.translate(ox, oy)
            if (rot) c2d.rotate(rot)
            if (fH || fV) c2d.scale(fH ? -1 : 1, fV ? -1 : 1)
            c2d.drawImage(wImg, t.sx, t.sy, t.sw, t.sh, -dw / 2, -dh / 2, dw, dh)
            c2d.restore()
        }})
    }

    layers.sort((a, b) => a.z - b.z)
    layers.forEach(l => l.fn())
    c2d.restore()
}

// Minimal bounding rect for a composite enemy across all frames, in def-space (character
// body centre = (0,0), foot = (0, MONSTER_FRAME_H/2)). Returns canvas-space layout:
//   { frameW, frameH, charX, charY, footX, footY } — anchor positions inside one frame slot.
function _computeCompositeBounds(def) {
    const sprite = def.sprite;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const expand = (x1, y1, x2, y2) => {
        if (x1 < minX) minX = x1; if (x2 > maxX) maxX = x2
        if (y1 < minY) minY = y1; if (y2 > maxY) maxY = y2
    }

    // ── Body: pixel-level trim per unique animation frame (bob doesn't affect body) ──
    // Results cached by charName:frame so enemies sharing the same base sprite pay once.
    const charSprite = monsterSprites[sprite.base]
    const nBodyFrames = charSprite ? Math.floor(charSprite.naturalWidth / MONSTER_FRAME_W) : 0
    // iterate frames 0..2 (frame 3 = frame 1, same sprite cell)
    let bodyTrimmed = false
    for (let f = 0; f < Math.min(nBodyFrames, 3); f++) {
        const key = `${sprite.base}:${f}`
        let t = key in _bodyTrimCache ? _bodyTrimCache[key]
              : (_bodyTrimCache[key] = _computeWeaponTrim(charSprite, f * MONSTER_FRAME_W, 0, MONSTER_FRAME_W, MONSTER_FRAME_H))
        if (t) {
            expand(t.dx - t.sw / 2, t.dy - t.sh / 2, t.dx + t.sw / 2, t.dy + t.sh / 2)
            bodyTrimmed = true
        }
    }
    if (!bodyTrimmed) expand(-MONSTER_FRAME_W / 2, -MONSTER_FRAME_H / 2, MONSTER_FRAME_W / 2, MONSTER_FRAME_H / 2)

    // ── Hands: pixel-level trim via _getWeaponTrim (reuses _wepTrimCache) ────────────
    const lh   = sprite.hands?.left  ?? { x: -10, y: 6 }
    const rh   = sprite.hands?.right ?? { x:  10, y: 6 }
    const bobs = [...new Set(FRAME_BOB)]   // [0, 1, 2]
    if (sprite.handRow != null) {
        // Columns 0=left hand, 1=right hand in Weapon-Hands sheet
        const tLH = _getWeaponTrim('Weapon-Hands', 0, sprite.handRow, 1, 1)
        const tRH = _getWeaponTrim('Weapon-Hands', 1, sprite.handRow, 1, 1)
        for (const bob of bobs) {
            if (tLH) expand(lh.x + tLH.dx - tLH.sw/2, lh.y + bob + tLH.dy - tLH.sh/2,
                            lh.x + tLH.dx + tLH.sw/2, lh.y + bob + tLH.dy + tLH.sh/2)
            else      expand(lh.x - ENEMY_HAND_CELL/2, lh.y + bob - ENEMY_HAND_CELL/2,
                            lh.x + ENEMY_HAND_CELL/2, lh.y + bob + ENEMY_HAND_CELL/2)
            if (tRH) expand(rh.x + tRH.dx - tRH.sw/2, rh.y + bob + tRH.dy - tRH.sh/2,
                            rh.x + tRH.dx + tRH.sw/2, rh.y + bob + tRH.dy + tRH.sh/2)
            else      expand(rh.x - ENEMY_HAND_CELL/2, rh.y + bob - ENEMY_HAND_CELL/2,
                            rh.x + ENEMY_HAND_CELL/2, rh.y + bob + ENEMY_HAND_CELL/2)
        }
    }

    // ── Weapons: use pixel-level trim, expand rotated corners if needed ─────────────
    for (const w of (sprite.weapons ?? []).filter(w => w?.col != null)) {
        const t = _getWeaponTrim(w.file, w.col, w.row, w.cols ?? 1, w.rows ?? 1)
        if (!t) {
            const ww = (w.cols ?? 1) * ENEMY_WEP_CELL / 2, wh = (w.rows ?? 1) * ENEMY_WEP_CELL / 2
            for (const bob of bobs) expand(w.x - ww, w.y + bob - wh, w.x + ww, w.y + bob + wh)
            continue
        }
        const ww  = t.sw / 2, wh = t.sh / 2
        const rot = (w.rot ?? 0) * Math.PI / 180
        for (const bob of bobs) {
            const ox = w.x + t.dx, oy = w.y + bob + t.dy
            if (rot) {
                const cos = Math.cos(rot), sin = Math.sin(rot)
                for (const [cx, cy] of [[-ww, -wh], [ww, -wh], [ww, wh], [-ww, wh]]) {
                    const rx = cos * cx - sin * cy + ox, ry = sin * cx + cos * cy + oy
                    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx
                    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry
                }
            } else {
                expand(ox - ww, oy - wh, ox + ww, oy + wh)
            }
        }
    }

    if (!isFinite(minX)) {
        return { frameW: MONSTER_FRAME_W, frameH: MONSTER_FRAME_H,
                 charX: MONSTER_FOOT_X, charY: MONSTER_FOOT_Y - MONSTER_FRAME_H / 2,
                 footX: MONSTER_FOOT_X, footY: MONSTER_FOOT_Y }
    }

    const pad    = 1   // 1px guard against boundary clipping
    const frameW = Math.ceil(maxX - minX) + 2 * pad
    const frameH = Math.ceil(maxY - minY) + 2 * pad
    const charX  = Math.floor(-minX) + pad   // char centre in canvas-x
    const charY  = Math.floor(-minY) + pad   // char centre in canvas-y
    const footX  = charX
    const footY  = charY + Math.round(MONSTER_FRAME_H / 2)   // foot = 16px below char centre
    return { frameW, frameH, charX, charY, footX, footY }
}

// Bake 4 animation frames into one wide canvas, then mask with `fill` ('#000' shadow, '#fff' ghost).
// Composite enemy canvas size is computed dynamically (typically ≤32×32/frame); simple sprite
// types use the fixed MONSTER_FRAME constants.
function _bakeMonsterSheet(type, fill) {
    const def = _enemyDefs[type]
    let frameW, frameH, charX, charY, footX, footY
    if (def) {
        // Bounds are pre-computed by _bakeAllMonsterSheets; fall back if called standalone.
        const cached = _monsterSheetInfo.get(type)
        if (cached?.charX != null) {
            ;({ frameW, frameH, charX, charY, footX, footY } = cached)
        } else {
            const b = _computeCompositeBounds(def)
            ;({ frameW, frameH, charX, charY, footX, footY } = b)
            _monsterSheetInfo.set(type, b)
        }
    } else {
        frameW = MONSTER_FRAME_W; frameH = MONSTER_FRAME_H
        charX  = MONSTER_FOOT_X;  charY  = MONSTER_FOOT_Y - MONSTER_FRAME_H / 2
        footX  = MONSTER_FOOT_X;  footY  = MONSTER_FOOT_Y
    }

    const sheet = document.createElement('canvas')
    sheet.width = frameW * 4; sheet.height = frameH
    const sc = sheet.getContext('2d')
    sc.imageSmoothingEnabled = false
    for (let f = 0; f < 4; f++) {
        const ox = f * frameW
        if (def) {
            _drawCompositeEnemy(def, sc, f, 1, ox + charX, charY, false)
        } else {
            const sprite = monsterSprites[type]
            if (sprite) sc.drawImage(sprite, f * MONSTER_FRAME_W, 0, MONSTER_FRAME_W, MONSTER_FRAME_H,
                ox, 0, MONSTER_FRAME_W, MONSTER_FRAME_H)
        }
    }
    sc.globalCompositeOperation = 'source-in'
    sc.fillStyle = fill
    sc.fillRect(0, 0, sheet.width, sheet.height)
    return sheet
}

function _bakeAllMonsterSheets() {
    // Only bake composite enemies (those with sprite.mode === 'composite')
    const compositeTypes = Object.keys(_enemyDefs).filter(name => {
        const def = _enemyDefs[name];
        return def.sprite && def.sprite.mode === 'composite';
    });
    // Pre-compute bounds for every composite type once; _bakeMonsterSheet reads from _monsterSheetInfo
    // so it never recomputes bounds or re-reads pixels.
    for (const type of compositeTypes) {
        _monsterSheetInfo.set(type, _computeCompositeBounds(_enemyDefs[type]))
    }
    for (const type of compositeTypes) {
        _monsterSilhouetteCache.set(type, _bakeMonsterSheet(type, '#000'))
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.group('[Monster sheets] baked %d composite types', compositeTypes.length)
    let totalKB = 0
    const rows = []
    for (const type of compositeTypes) {
        const info = _monsterSheetInfo.get(type)
        const fW   = info.frameW
        const fH   = info.frameH
        // Each sheet is frameW*4 × frameH, 4 bytes/px
        const kb   = (fW * 4 * fH * 4) / 1024
        totalKB   += kb
        rows.push({ type, frame: `${fW}×${fH}`, sheet: `${fW*4}×${fH}`, kb: kb.toFixed(1) })
    }
    console.table(rows.map(r => ({
        type: r.type,
        'frame size': r.frame, 'sheet size': r.sheet,
        'KB (×2 caches)': r.kb
    })))
    console.log('Total in-memory: %.1f KB (%.2f MB)', totalKB, totalKB / 1024)
    console.groupEnd()
}

const MONSTER_DYING_MS = 900   // battle death animation duration

const _monsterSilhouetteCache = new Map()   // composite type → baked whole-sheet (pre-warmed in init)
// Collapses the old _renderMonsterTo / _renderNpcTo / drawMonsterShadow /
// drawNpcShadow / getNpcSilhouette / getMonsterSilhouette into a single path
// driven by resolveEntityDef(). Composite enemies still use the pre-baked
// _monsterSilhouetteCache (whole-sheet); simple sheets lazily bake per-frame
// silhouettes into _entitySilhouetteCache.

const _entitySilhouetteCache = new Map()   // "name:frame" → Canvas (simple sheets only)

/** Resolve the sprite image for any name, checking both caches. */
function _getEntityImg(name, resolved = null) {
    // For sheet mode, use the base name (e.g., "Skeleton" for "Skeleton Soldier")
    const key = (resolved && resolved.base) ? resolved.base : name;
    return monsterSprites[key] ?? npcSprites[name] ?? null
}

/** Compute the current animation frame for a resolved simple-sheet entity. */
function _entityFrame(resolved) {
    return Math.floor(performance.now() / (1000 / resolved.fps)) % resolved.frames
}

/** Render any entity (monster or NPC) to a render context. */
function _renderEntityTo(entity, tctx) {
    const name = entity.type ?? entity.sprite
    const resolved = resolveEntityDef(name)
    const worldX = entity.tileX * TILE + TILE / 2
    const worldY = entity.tileY * TILE + TILE / 2
    const flipX = entity.flipX ?? false
    const animPhase = entity.animPhase ?? 0
    if (resolved.composite) {
        const frame = (_monsterAnimTick() + animPhase) % 4
        _drawCompositeEnemy(resolved.def, tctx, frame, 1, worldX, worldY - MONSTER_FRAME_H / 2, flipX)
        return
    }
    const img = _getEntityImg(name, resolved)
    if (!img) return
    const { frameW, frameH, footX, footY } = resolved
    const frame = _entityFrame(resolved)
    tctx.save()
    tctx.translate(worldX, worldY)
    if (flipX) tctx.scale(-1, 1)
    tctx.drawImage(img, frame * frameW, 0, frameW, frameH, -footX, -footY, frameW, frameH)
    tctx.restore()
}

/** Get (or lazily bake) a silhouette frame for a simple-sheet sprite. Uses the shared sprite-image caches. */
function _getSilhouette(name, frame, geom, resolved = null) {
    const key = `${name}:${frame}`
    let sil = _entitySilhouetteCache.get(key)
    if (sil) return sil
    const img = _getEntityImg(name, resolved)
    if (!img) return null
    const { frameW, frameH } = geom
    sil = document.createElement('canvas')
    sil.width  = frameW; sil.height = frameH
    const sc = sil.getContext('2d')
    sc.drawImage(img, frame * frameW, 0, frameW, frameH, 0, 0, frameW, frameH)
    sc.globalCompositeOperation = 'source-in'
    sc.fillStyle = '#000'
    sc.fillRect(0, 0, frameW, frameH)
    _entitySilhouetteCache.set(key, sil)
    return sil
}

/** Draw a shadow under any entity (monster or NPC). */
function drawEntityShadow(entity, tctx) {
    const name = entity.type ?? entity.sprite
    const resolved = resolveEntityDef(name)
    const flipX = entity.flipX ?? false
    const animPhase = entity.animPhase ?? 0
    if (resolved.composite) {
        // Composite: use pre-baked whole-sheet cache from init
        const frame = (_monsterAnimTick() + animPhase) % 4
        const sil = _monsterSilhouetteCache.get(name); if (!sil) return
        const info = _monsterSheetInfo.get(name)
        const fW   = info?.frameW ?? MONSTER_FRAME_W
        const fH   = info?.frameH ?? MONSTER_FRAME_H
        const fX   = info?.footX  ?? MONSTER_FOOT_X
        const fY   = info?.footY  ?? MONSTER_FOOT_Y
        const pivY = fY / fH
        const worldX = entity.tileX * TILE + TILE / 2
        const worldY = entity.tileY * TILE + TILE / 2
        tctx.save()
        tctx.translate(worldX - fX, worldY - fY)
        tctx.transform(1, 0, -SKEW_SHADOW_SKEW, -SKEW_SHADOW_SCALE,
            pivY * fH * SKEW_SHADOW_SKEW,
            pivY * fH * (1 + SKEW_SHADOW_SCALE))
        if (flipX) {
            tctx.translate(fX, 0)
            tctx.scale(-1, 1)
            tctx.translate(-fX, 0)
        }
        tctx.drawImage(sil, frame * fW, 0, fW, fH, 0, 0, fW, fH)
        tctx.restore()
        return
    }
    // Simple sheet: lazy per-frame silhouette
    const { frameW, frameH, footX, footY, frames, fps } = resolved
    const frame  = Math.floor(performance.now() / (1000 / fps)) % frames
    const sil    = _getSilhouette(name, frame, resolved, resolved); if (!sil) return
    const pivY   = footY / frameH
    const worldX = entity.tileX * TILE + TILE / 2
    const worldY = entity.tileY * TILE + TILE / 2
    tctx.save()
    tctx.translate(worldX - footX, worldY - footY)
    tctx.transform(1, 0, -SKEW_SHADOW_SKEW, -SKEW_SHADOW_SCALE,
        pivY * frameH * SKEW_SHADOW_SKEW,
        pivY * frameH * (1 + SKEW_SHADOW_SCALE))
    tctx.drawImage(sil, 0, 0)
    tctx.restore()
}
async function spawnNpc(sprite, tileX, tileY, opts = {}) {
    if (!npcSprites[sprite]) {
        npcSprites[sprite] = await loadImage(`../characters/${sprite}.png`)
    }
    npcs.push({
        id:    opts.id ?? `${sprite}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
        sprite,
        tileX,
        tileY,
        flipX: opts.flipX ?? false,
    })
    console.log(`[NPC] Spawned ${sprite} at (${tileX}, ${tileY})`)
}

// ─── Decorations + effects + player (painter's-algorithm sorted) ──────────────
function renderDecorationsEffectsAndPlayer() {
    // Build sorted list (needed for cache validity check and for full render)
    const items = []
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const d = map._decorations[y][x]
            if (!d) continue
            const sortY = d.y + 0.5 + (d.dy || 0) / TILE
            items.push({ kind: 'deco', d, sortY })
        }
    }
    // Map items (spawned via spawn_item ECA action)
    if (map._items) {
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const item = map._items[y][x]
                if (!item) continue
                items.push({ kind: 'mapItem', item, x, y, sortY: y + 0.5 })
            }
        }
    }
    for (const ef of (map._effects ?? []))
        items.push({ kind: 'effect', ef, sortY: ef.y + (ef.dy ?? 0) / TILE + 0.5 })
    for (const m of monsters)
        items.push({ kind: 'monster', m, sortY: m.tileY + 0.5 })
    for (const npc of npcs)
        items.push({ kind: 'npc', npc, sortY: npc.tileY + 0.5 })
    items.push({ kind: 'player', sortY: player.py / TILE })
    items.sort((a, b) => a.sortY - b.sortY)

    const playerSortY = player.py / TILE

    // ── Cached path (player idle, wind/tile unchanged) ───────────────────────
    const windTick = _windTick()
    const effectTick = _effectTick()
    let cacheValid = !player.moving
        && _decoUnder && _decoOver && _decoShadow
        && _decoCachedTileX === player.tileX
        && _decoCachedTileY === player.tileY
        && _decoCachedWindTick === windTick
        && _decoCachedEffectTick === effectTick
        && Math.abs(player.tileX - _decoCentreX) <= _decoHalfW - 2
        && Math.abs(player.tileY - _decoCentreY) <= _decoHalfH - 2

    // Rebuild the deco cache BEFORE the shadow pass when idle and stale so the
    // shadow always comes from _decoShadow (consistent 1× bake → 2× blit path).
    // Mixing baked and live paths caused flickering: the live path applies the skew
    // at ZOOM×2 resolution while the bake is 1×, producing different sub-pixel results.
    if (!player.moving && !cacheValid) { _buildDecoCache(items, playerSortY); cacheValid = true }

    // ── Shadow pass: all decorations + player into one offscreen → composite once
    const sc = (renderDecorationsEffectsAndPlayer._sc ??= document.createElement('canvas'))
    if (sc.width !== canvas.width || sc.height !== canvas.height) { sc.width = canvas.width; sc.height = canvas.height }
    const sctx = sc.getContext('2d')
    sctx.imageSmoothingEnabled = false
    sctx.resetTransform() // clearRect honors the transform left over from the previous frame
    sctx.clearRect(0, 0, sc.width, sc.height)
    sctx.setTransform(ctx.getTransform())
    if (_decoShadow && !player.moving) {
        // Idle: always blit pre-baked shadow (rebuilt above if stale) — single consistent path
        sctx.drawImage(_decoShadow, _decoOriginX, _decoOriginY)
    } else {
        // Moving (or very first frame): live shadow so player position interpolates smoothly
        const _liveDrawn = new Set()
        for (const item of items) {
            if (item.kind === 'player')  { renderPlayerShadow(sctx); continue }
            if (item.kind === 'monster') { drawEntityShadow(item.m, sctx); continue }
            if (item.kind === 'npc')     { drawEntityShadow(item.npc, sctx); continue }
            if (item.kind !== 'deco' || _liveDrawn.has(item.d)) continue
            _liveDrawn.add(item.d)
            const asset = assetMap[item.d.assetId]
            if (asset?.shadow) drawDecorationShadow(item.d, asset, sctx)
        }
    }
    ctx.save(); ctx.resetTransform(); ctx.globalAlpha = 0.35; ctx.drawImage(sc, 0, 0); ctx.restore()

    if (cacheValid) {
        // ── Cached sprite path ──────────────────────────────────────────────
        // Effects are baked in sorted order — no interleaving issue.
        if (SHOW_PERF) _perfStart('deco:cached')
        ctx.drawImage(_decoUnder, _decoOriginX, _decoOriginY)
        renderPlayer()
        // Render map items live (not cached) to avoid sub-pixel blur
        _renderLiveMapItems(ctx)
        ctx.drawImage(_decoOver, _decoOriginX, _decoOriginY)
        if (SHOW_PERF) _perfEnd('deco:cached')
        return
    }

    // ── Full sprite render path ─────────────────────────────────────────────
    if (SHOW_PERF) _perfStart('deco:full')
    const _liveSprDrawn = new Set()
    for (const item of items) {
        if (item.kind === 'player')  { renderPlayer(); continue }
        if (item.kind === 'effect')  { renderEffect(item.ef); continue }
        if (item.kind === 'monster') { _renderEntityTo(item.m, ctx); continue }
        if (item.kind === 'npc')     { _renderEntityTo(item.npc, ctx); continue }
        if (item.kind === 'mapItem') {
            // Render map item (spawned via spawn_item ECA action)
            const { item: mapItem, x, y } = item
            const def = _itemsDef[mapItem.itemId] || _craftDef[mapItem.itemId]
            const icon = def && (def.icon || (Array.isArray(def) ? def : null))
            if (!icon) continue
            const img = _itemsDef[mapItem.itemId] ? _itemsImg : _craftImg
            if (!img) continue
            const [col, row] = icon
            const worldX = x * TILE + TILE / 2
            const worldY = y * TILE + TILE / 2
            const srcSize = _ITEM_SIZE_HUD
            const destSize = TILE / 2  // 16px (half tile, 2x smaller)
            ctx.save()
            ctx.translate(worldX, worldY)
            // Center the item in the tile
            ctx.drawImage(img,
                col * srcSize, row * srcSize, srcSize, srcSize,
                -destSize / 2, -destSize / 2, destSize, destSize)
            ctx.restore()
            continue
        }
        const { d } = item
        if (_liveSprDrawn.has(d)) continue
        _liveSprDrawn.add(d)
        const asset = assetMap[d.assetId]; if (!asset) continue
        const ts    = asset.tileset
        const state = asset.states.find(s => s.id === (d.stateId ?? asset.defaultState)) ?? asset.states[0]
        const [tx, ty, tw, th] = state.region
        const [pivX, pivY]     = asset.pivot
        const srcX = tx * ts.size[0], srcY = ty * ts.size[1]
        const srcW = tw * ts.size[0], srcH = th * ts.size[1]
        const worldX = d.x * TILE + TILE / 2 + (d.dx || 0)
        const worldY = d.y * TILE + TILE / 2 + (d.dy || 0)
        ctx.save()
        ctx.translate(worldX, worldY)
        if (d.flipX) ctx.scale(-1, 1)
        if (d.scale && d.scale !== 1) ctx.scale(d.scale, d.scale)
        const ox = Math.round(-pivX * srcW), oy = Math.round(-pivY * srcH)
        if (asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0) {
            const wB = d.flipX ? _mirrorBucket(_windFrameBucket) : _windFrameBucket
            const sheet = getWindSheet(asset, wB, _normWindForBucket(wB))
            const fi    = getWindFrame(asset.wind[0], d._windPhase ?? (d._windPhase = Math.random() * 100000))
            ctx.drawImage(sheet, fi * srcW, 0, srcW, srcH, ox, oy, srcW, srcH)
        } else {
            ctx.drawImage(ts.img, srcX, srcY, srcW, srcH, ox, oy, srcW, srcH)
        }
        ctx.restore()
    }
    if (SHOW_PERF) _perfEnd('deco:full')

}

// ─── Terrain tops (stone walls, cliff faces that appear above decorations) ─────
// Each dual-grid vertex (rx,ry) draws at px=(rx-1)*TILE+TILE/2, py=(ry-1)*TILE+TILE/2
// (the cell extends one TILE upward). The result is fully static (topImg + tileHash
// are time- and camera-invariant), so unlike the cache-canvases we don't need to bake
// it: we only need to skip vertices that can't be on screen. Mirrors editor's
// getVisibleRange() culling but in world/camera space.
const TOPS_MARGIN = 2   // extra tile slack around the viewport (covers the -TILE cell)
function renderTerrainTops() {
    const topTerrains = tileset.terrains.filter(t => t.topImg)
    if (!topTerrains.length) return

    const W = map.width, H = map.height

    // Visible world-pixel bounds. Vertex (rx,ry) draws at px=(rx-1)*TILE+TILE/2,
    // over a TILE×TILE cell offset one TILE upward (topImg src spans py-TILE..py).
    // We widen the visible rect by TOPS_MARGIN tiles so clamped integer bounds never
    // clip a cell that straddles the viewport edge.
    const viewW = canvas.width  / ZOOM
    const viewH = canvas.height / ZOOM
    const loX = _camX - TOPS_MARGIN * TILE
    const hiX = _camX + viewW + TOPS_MARGIN * TILE
    const loY = _camY - TOPS_MARGIN * TILE
    const hiY = _camY + viewH + TOPS_MARGIN * TILE

    // Solve px ∈ [loX, hiX]  →  rx ∈ [loX/TILE + 0.5, hiX/TILE + 0.5]
    let rxStart = Math.floor(loX / TILE + 0.5)
    let rxEnd   = Math.ceil (hiX / TILE + 0.5)
    let ryStart = Math.floor(loY / TILE + 0.5)
    let ryEnd   = Math.ceil (hiY / TILE + 0.5)
    if (rxStart < 0)   rxStart = 0
    if (ryStart < 0)   ryStart = 0
    if (rxEnd   > W)   rxEnd   = W
    if (ryEnd   > H)   ryEnd   = H

    for (let ry = ryStart; ry <= ryEnd; ry++) {
        for (let rx = rxStart; rx <= rxEnd; rx++) {
            const tl = getRaw(map, rx,     ry)
            const tr = getRaw(map, rx + 1, ry)
            const bl = getRaw(map, rx,     ry + 1)
            const br = getRaw(map, rx + 1, ry + 1)
            const px = (rx - 1) * TILE + TILE / 2
            const py = (ry - 1) * TILE + TILE / 2

            for (const terrain of topTerrains) {
                const id   = terrain.id
                const mask = ((tl === id ? 1 : 0) << 3) | ((tr === id ? 1 : 0) << 2)
                           | ((bl === id ? 1 : 0) << 1) |  (br === id ? 1 : 0)
                if (!mask || (mask > 3 && mask !== 7 && mask !== 11)) continue
                const variant = tileHash(rx, ry) % (terrain.variants ?? 1)
                ctx.drawImage(terrain.topImg,
                    mask * TILE, variant * TILE, TILE, TILE,
                    px, py - TILE, TILE, TILE)
            }
        }
    }
}

// ─── Debug grid ──────────────────────────────────────────────────────────────
function renderGrid() {
    ctx.save()
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1 / ZOOM
    ctx.beginPath()
    for (let x = 0; x <= map.width; x++) {
        ctx.moveTo(x * TILE, 0)
        ctx.lineTo(x * TILE, map.height * TILE)
    }
    for (let y = 0; y <= map.height; y++) {
        ctx.moveTo(0,                y * TILE)
        ctx.lineTo(map.width * TILE, y * TILE)
    }
    ctx.stroke()

    if (SHOW_COORDS) {
        ctx.font = `${12 / ZOOM}px monospace`
        ctx.textBaseline = 'top'
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                const label = `${x},${y}`
                const tx = x * TILE + 2 / ZOOM
                const ty = y * TILE + 2 / ZOOM
                ctx.fillStyle = 'rgba(0,0,0,0.55)'
                ctx.fillText(label, tx + 1/ZOOM, ty + 1/ZOOM)
                ctx.fillStyle = 'rgba(255,255,255,0.85)'
                ctx.fillText(label, tx, ty)
            }
        }
    }

    ctx.restore()
}

// ─── Monster spawning ─────────────────────────────────────────────────────────

/** Return a set of "tx,ty" strings for all tiles currently occupied by monsters. */
function _monsterOccupied() {
    return new Set(monsters.map(m => `${m.tileX},${m.tileY}`))
}

/**
 * Find a walkable, unoccupied spawn tile given options:
 *   { x, y }           – exact tile (fails if blocked/occupied)
 *   { x, y, radius }   – random walkable tile within circular radius
 *   {}                 – random tile reachable by BFS from the player
 */
function findSpawnPosition({ x, y, radius } = {}) {
    const occupied = _monsterOccupied()
    const playerKey = `${player.tileX},${player.tileY}`

    const canPlace = (tx, ty) =>
        tx >= 0 && ty >= 0 && tx < map.width && ty < map.height &&
        !blocked[ty][tx] && !occupied.has(`${tx},${ty}`) &&
        !(tx === player.tileX && ty === player.tileY)

    // Exact position
    if (x !== undefined && y !== undefined && radius === undefined) {
        return canPlace(x, y) ? { x, y } : null
    }

    // Random within radius
    if (x !== undefined && y !== undefined && radius !== undefined) {
        const candidates = []
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy > radius * radius) continue
                const tx = x + dx, ty = y + dy
                if (canPlace(tx, ty)) candidates.push({ x: tx, y: ty })
            }
        }
        return candidates.length
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : null
    }

    // BFS from player — any reachable walkable tile
    const visited = new Set([playerKey])
    const queue   = [{ x: player.tileX, y: player.tileY }]
    const candidates = []
    while (queue.length) {
        const cur = queue.shift()
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const tx = cur.x + dx, ty = cur.y + dy
            const key = `${tx},${ty}`
            if (visited.has(key)) continue
            visited.add(key)
            if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue
            if (blocked[ty][tx]) continue
            queue.push({ x: tx, y: ty })
            if (canPlace(tx, ty)) candidates.push({ x: tx, y: ty })
        }
    }
    return candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null
}

/** Spawn a monster of the given type or named enemy. opts = { x?, y?, radius?, pool? } */
async function spawnMonster(type, opts = {}) {
    // Resolve the effective sprite sheet: composites use def.charName; simple-sheet
    // types use the type name directly. Either way, lazy-load the PNG on demand
    // (mirrors spawnNpc) so spawn_monster can use a sprite it has never seen before.
    const def = _enemyDefs[type];
    const charName = def?.sprite?.base ?? type;
    if (monsterSprites[charName] == null) {
        const file = def?.sprite?.file ?? `${charName}.png`;
        try { monsterSprites[charName] = await loadImage(`../characters/${file}`) }
        catch (e) { console.warn(`[Monster] Sprite not found: ${file} (will render nothing)`) }
    }
    // Re-bake this type's shadow silhouette now that its char sprite is loaded.
    // _bakeAllMonsterSheets() runs at init before lazy-loadable char sprites
    // (Gorilla and anything not in the eager list) exist, so its baked sheet is
    // blank and its bounds default. Re-compute bounds + re-bake here so
    // drawEntityShadow has real pixels at the correct frame geometry.
    if (def?.sprite?.mode === 'composite' && monsterSprites[charName]) {
        _monsterSheetInfo.set(type, _computeCompositeBounds(def))
        _monsterSilhouetteCache.set(type, _bakeMonsterSheet(type, '#000'))
    }
    const known = MONSTER_TYPES.includes(type) || _enemyDefs[type]
    if (!known)
        console.log(`[Monster] Spawning unregistered type "${type}" (sprite ${charName}.png)`)

    const pos = findSpawnPosition(opts)
    if (!pos) { console.warn(`[Monster] No valid spawn position for ${type}`); return }

    const monster = {
        id:    `${type}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        authorId: opts.id ?? null,
        type,
        tileX: pos.x,
        tileY: pos.y,
        flipX: Math.random() < 0.5,
        animPhase: Math.floor(Math.random() * 4), // random starting frame offset
    }
    // Store question pool spec on monster (from spawn_monster action)
    if (opts.pool != null) monster.questionPool = opts.pool

    monsters.push(monster)
    console.log(`[Monster] Spawned ${type} at (${pos.x}, ${pos.y})${opts.pool ? ` pool=${opts.pool}` : ''}`)
}


// ─── Blocked map builder ─────────────────────────────────────────────────────
function buildBlockedMap() {
    blocked = Array.from({ length: map.height }, (_, y) =>
        Array.from({ length: map.width }, (_, x) => {
            const tid = map._terrain[y + 1][x + 1]
            return !tileset.terrains.find(t => t.id === tid)?.tags?.includes('ground')
        })
    )
    // Apply decoration traversable masks (same logic as editor renderTraversable)
    for (let dy = 0; dy < map.height; dy++) {
        for (let dx = 0; dx < map.width; dx++) {
            const d = map._decorations[dy][dx]
            if (!d) continue
            const asset = assetMap[d.assetId]
            if (!asset) continue
            const state = asset.states.find(s => s.id === (d.stateId ?? asset.defaultState)) ?? asset.states[0]
            if (!state.traversable) continue
            const [pivX, pivY] = asset.pivot
            const [,, tw, th]  = state.region
            const rows = state.traversable.split('|')
            const startCellX = d.x - Math.floor(pivX * tw)
            const startCellY = d.y - Math.floor(pivY * th)
            for (let row = 0; row < rows.length; row++) {
                for (let col = 0; col < rows[row].length; col++) {
                    const cx = startCellX + col
                    const cy = startCellY + row
                    if (cx < 0 || cy < 0 || cy >= map.width || cy >= map.height) continue
                    const mark = rows[row][col]
                    if (mark === 'B') blocked[cy][cx] = true
                    else if (mark === 'A') blocked[cy][cx] = false
                }
            }
        }
    }

    // Pre-compute water masks and phases for fast water rendering
    if (tileset?.waterTerrain) {
        const waterId = tileset.waterTerrain.id
        const W = map.width, H = map.height
        const stride = W + 2  // 1-cell padding on each side
        _waterMask = new Uint8Array(stride * (H + 2))
        _waterPhase = new Uint8Array(stride * (H + 2))
        const baseId = tileset.baseTerrain?.id ?? 0
        const terr = (x, y) => (x >= 0 && x <= W + 1 && y >= 0 && y <= H + 1)
            ? getRaw(map, x, y) : baseId
        for (let y = 0; y < H + 2; y++) {
            const rowBase = y * stride
            for (let x = 0; x < W + 2; x++) {
                const idx = rowBase + x
                // Get 2x2 terrain corners for water mask (accounting for 1-cell padding)
                const tl = terr(x - 1, y - 1)
                const tr = terr(x, y - 1)
                const bl = terr(x - 1, y)
                const br = terr(x, y)
                const wMask = ((tl===waterId?1:0)<<3)|((tr===waterId?1:0)<<2)|((bl===waterId?1:0)<<1)|(br===waterId?1:0)
                _waterMask[idx] = wMask
                _waterPhase[idx] = tileHash(x, y) % WAVE_NFRAMES
            }
        }
    } else {
        _waterMask = null
        _waterPhase = null
    }
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dt) {
    // Pause movement animation while engine is busy (dialog showing, map loading…).
    // engineBusy is held for the full duration of any awaited action chain, so a
    // dialog opened from such a chain (npc_interact, post-loss, monster_defeated)
    // freezes the advance animation until dismissed.
    if (!engineBusy) {
        if (player.progress < 1.0)
            player.progress = Math.min(1.0, player.progress + dt * MOVE_SPEED)
    }

    // Snap to destination when animation completes
    if (player.progress >= 1.0) {
        player.tileX = player.toX
        player.tileY = player.toY
        player.progress = 1.0

        // Once the player has landed, fire tile_enter and (if a battle was just
        // won onto a monster tile) the deferred monster_defeated — in that order.
        // Both run as one engineBusy-held chain so any dialogs they open hold the
        // player idle on the tile they just stepped onto; defer while a modal is
        // already open to avoid stacking.
        if ((_pendingTileEnter || _pendingMonsterDefeat) && !_modalBlockingInput()) {
            const te = _pendingTileEnter;       _pendingTileEnter = null
            const md = _pendingMonsterDefeat;    _pendingMonsterDefeat = null
            engineBusy = true
            ;(async () => {
                try {
                    if (te) await engine.fireEvent('tile_enter', { x: te.x, y: te.y })
                    // Check for and collect any items on the tile after tile_enter fires
                    if (te && map._items && map._items[te.y] && map._items[te.y][te.x]) {
                        const mapItem = map._items[te.y][te.x]
                        const { itemId, qty } = mapItem
                        // Give item to player via engine (handles inventory + auto-equip)
                        const engineState = engine.getState()
                        engineState.inventory[itemId] = (engineState.inventory[itemId] ?? 0) + qty
                        // Auto-equip if applicable
                        if (engine.itemSlotType(itemId)) {
                            let auto = engine.equipItem(itemId, null)
                            if (auto) console.log(`[Item] auto-equipped ${itemId} → ${auto}`)
                        }
                        engine.notifyInventoryChange()
                        // Show message
                        const itemName = itemId.replace(/_/g, ' ')
                        showMessage(`Zebrałeś`, 3000, { id: itemId, qty })
                        // Remove item from map
                        map._items[te.y][te.x] = null
                        _invalidateDecoCache()
                        // Record removal for save/load
                        if (!_mapChanges.has(_currentMapId)) _mapChanges.set(_currentMapId, [])
                        _mapChanges.get(_currentMapId).push({ action: 'remove_item', x: te.x, y: te.y })
                    }
                    if (md) await engine.recordMonsterDefeat(md.type, md.x, md.y, md.authorId)
                } finally {
                    engineBusy = false
                }
            })()
        }
    }

    // Accept new input only when tile-aligned and the engine is free and no
    // blocking modal overlay is on screen.
    if (player.progress >= 1.0 && !engineBusy && !_modalBlockingInput()) {
        let dx = 0, dy = 0
        if      (keys['ArrowLeft']  || keys['KeyA']) { dx = -1; player.dir = DIR_LEFT  }
        else if (keys['ArrowRight'] || keys['KeyD']) { dx =  1; player.dir = DIR_RIGHT }
        else if (keys['ArrowUp']    || keys['KeyW']) { dy = -1; player.dir = DIR_UP    }
        else if (keys['ArrowDown']  || keys['KeyS']) { dy =  1; player.dir = DIR_DOWN  }

        if (dx !== 0 || dy !== 0) {
            const nx = player.tileX + dx
            const ny = player.tileY + dy
            if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) {
                const terrainBlocked = !!blocked[ny][nx]
                engineBusy = true
                engine.fireEvent('tile_approach', {
                    x: nx, y: ny,
                    from_x: player.tileX, from_y: player.tileY,
                }).then(async result => {
                    // Commit move only if terrain is passable and no script blocked it
                    if (!terrainBlocked && !result.blocked) {
                        const targetMonster = monsters.find(m => !m.dying && m.tileX === nx && m.tileY === ny)
                        const targetNpc     = npcs.find(n => n.tileX === nx && n.tileY === ny)
                        if (targetMonster) {
                            // ── Battle ──────────────────────────────────────
                            const { won } = await startBattle(targetMonster)
                            if (won) {
                                // Remove defeated monster immediately (no world animation)
                                monsters.splice(monsters.indexOf(targetMonster), 1)
                                player.fromX    = player.tileX
                                player.fromY    = player.tileY
                                player.toX      = nx
                                player.toY      = ny
                                player.progress = 0
                                _pendingTileEnter = { x: nx, y: ny }
                                // Award XP for the kill (quick, non-blocking sync+await)
                                await _awardMonsterXp(targetMonster.type)
                                // Stash recordMonsterDefeat to fire AFTER the player lands on
                                // the tile the monster occupied. We deliberately do NOT await
                                // it here — the player must keep walking onto the tile first;
                                // the monster_defeated dialog then opens with the player idle.
                                _pendingMonsterDefeat = {
                                    type: targetMonster.type,
                                    x: targetMonster.tileX, y: targetMonster.tileY,
                                    authorId: targetMonster.authorId,
                                }
                            } else {
                                // Player lost — stay put, already set HP to 1
                                await showDialog('Zostałeś pokonany… Ledwo uszedłeś z życiem.')
                            }
                        } else if (targetNpc) {
                            // Fire npc_interact so scripts can run dialog/choices
                            await engine.fireEvent('npc_interact', {
                                npc_id: targetNpc.id,
                                x: targetNpc.tileX,
                                y: targetNpc.tileY,
                            })
                        } else {
                            // ── Normal move ──────────────────────────────────
                            player.fromX    = player.tileX
                            player.fromY    = player.tileY
                            player.toX      = nx
                            player.toY      = ny
                            player.progress = 0
                            _pendingTileEnter = { x: nx, y: ny }
                        }
                    }
                    engineBusy = false
                })
            }
        }
        // Report standing still only if the engine is truly idle (no in-flight
        // tile_approach / tile_enter async) AND no movement key is held. While
        // an async commit is running the player sits on the destination tile
        // for a frame; keeping `moving` true here prevents a false idle blip
        // (one idle frame flickering in mid-stride at each tile center).
        const moveKeyHeld =
            keys['ArrowLeft'] || keys['ArrowRight'] || keys['ArrowUp'] || keys['ArrowDown'] ||
            keys['KeyA'] || keys['KeyD'] || keys['KeyW'] || keys['KeyS']
        player.moving = (engineBusy || moveKeyHeld)
    } else if (player.progress < 1.0) {
        player.moving = true
    } else {
        player.moving = false   // standing still during dialog
    }

    // Interpolate world-pixel feet position
    const t = player.progress
    player.px = (player.fromX + (player.toX - player.fromX) * t) * TILE + TILE / 2
    player.py = (player.fromY + (player.toY - player.fromY) * t) * TILE + TILE / 2
}

// ─── Perf overlay (Ctrl+P) ─────────────────────────────────────────────────────
// On-screen table of per-pass render cost. Drawn in screen space after ctx.restore().
function _drawPerfOverlay() {
    // Each row: [label, avg ms, peak ms since last reset, sample count]
    const rows = [['frame', _perfFrameAvg, _perfFrameMax, null]]
    for (const l of ['terrain', 'water', 'ofoam', 'grid', 'tops', 'lighting', 'weather']) {
        rows.push([l, _perfAvg[l] ?? 0, _perfMax[l] ?? 0, _perfCount[l] ?? 0])
    }
    // cached vs full run mutually exclusively per frame → different sample counts
    rows.push(['deco (total)', _perfAvg['deco'] ?? 0, _perfMax['deco'] ?? 0, _perfCount['deco'] ?? 0])
    rows.push(['  └deco:cached', _perfAvg['deco:cached'] ?? 0, _perfMax['deco:cached'] ?? 0, _perfCount['deco:cached'] ?? 0])
    rows.push(['  └deco:full',   _perfAvg['deco:full']   ?? 0, _perfMax['deco:full']   ?? 0, _perfCount['deco:full']   ?? 0])

    // ── Memory benchmark rows: [label, bytes, count-or-null] ──────────────────
    // Each is the backing-store estimate of the named cache. `windCache` is the
    // decorations-bent-by-wind cost (one sheet per (asset, wind-bucket)); the three
    // shadow/silhouette caches are the shadows cost; `tileCache`/`_terrainCanvas`
    // are the tiles cost. Built fresh every frame — cheap (a few Map walks) and
    // always reflects the live cache state (e.g. after a map swap clears caches).
    const memRows = []
    const _push = (label, bytes, count) => memRows.push([label, Math.max(0, bytes | 0), count])
    let _biggest = 0   // track the loudest consumer to colour it
    const track = (label, bytes, count) => { _biggest = Math.max(_biggest, bytes); _push(label, bytes, count) }

    track('deco:under/over/shadow', _memBytesOfCanvas(_decoUnder) + _memBytesOfCanvas(_decoOver) + _memBytesOfCanvas(_decoShadow), 3)
    track('terrain canvas',         _memBytesOfCanvas(_terrainCanvas), 1)
    track('water atlas+canvas',     _memBytesOfCanvas(_waterAtlas) + _memBytesOfCanvas(_waterCanvas), null)
    const _wind = _memSumCanvases(windCache)
    track('wind sheets (bent decos)', _wind.bytes, _wind.count)
    const _sil = _memSumCanvases(_silhouetteCache)
    track('silhouette cache',       _sil.bytes, _sil.count)
    const _wsil = _memSumWindSils(_windSils)
    track('wind silhouette cache',  _wsil.bytes, _wsil.count)
    const _rShadows = _memSumWrappedCanvases(_rayTracedShadowCache)
    track('ray-traced shadows',     _rShadows.bytes, _rShadows.count)
    const _tiles = _memSumCanvases(tileCache)
    track('terrain tile cache',     _tiles.bytes, _tiles.count)
    const _mSil = _memSumCanvases(_monsterSilhouetteCache)
    track('monster silhouettes',     _mSil.bytes, _mSil.count)
    track('entity silhouettes',     _memSumCanvases(_entitySilhouetteCache).bytes, _entitySilhouetteCache.size)
    track('player shadow sheet',    _memBytesOfCanvas(_playerShadowSheet), 1)
    track('lighting buffer',        _memBytesOfCanvas(_lightBuf), 1)
    track('weather particle pool',  _memBytesOfArray(_wPool), _wPool.length / W_STRIDE)
    track('water masks+phases',     _memBytesOfArray(_waterMask) + _memBytesOfArray(_waterPhase), null)
    track('glow gradients (n)',     0, _glowCache.size)   // tiny gradient objects; count only

    let memTotal = 0
    for (const [, b] of memRows) memTotal += b

    ctx.save()
    ctx.resetTransform()
    ctx.font = '15px ui-monospace, Consolas, monospace'
    ctx.textBaseline = 'top'
    const x = 10, y = 10
    const w = 314, rowH = 20
    // Timing section + a 1-row gap, a 2-row memory header (title + column heads),
    // the memory rows, and (if performance.memory exists) one JS-heap row + its tag.
    const hasHeap = !!(performance.memory)
    // gap + title + header + per-row + (heap row if available). +6→8px bottom padding.
    const memH = 3 * rowH + memRows.length * rowH + (hasHeap ? rowH : 0) + 8
    const h = 30 + rows.length * rowH + memH

    // Panel
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(80,200,255,0.6)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

    // Title
    ctx.fillStyle = '#9bd8ff'
    ctx.fillText(`PERF  fps ${_perfFps.toFixed(1)}   frame ${_perfFrameAvg.toFixed(2)}ms`, x + 9, y + 6)

    // Column header
    ctx.fillStyle = '#6f8aa0'
    ctx.fillText('pass',            x + 9,   y + 26)
    ctx.fillText('avg',             x + 158, y + 26)
    ctx.fillText('peak',            x + 214, y + 26)
    ctx.fillText('n',               x + 272, y + 26)

    let yy = y + 26
    for (let i = 0; i < rows.length; i++) {
        yy += rowH
        const [label, avg, peak, cnt] = rows[i]
        const isFrame = label === 'frame'
        ctx.fillStyle = isFrame ? '#ffd86b' : (avg > 1.5 ? '#ff8a7a' : '#cfe6d8')
        ctx.fillText(label, x + 9, yy)
        if (isFrame && peak > 20) ctx.fillStyle = '#ff5d5d'
        ctx.fillText(avg.toFixed(2) + 'ms', x + 158, yy)
        ctx.fillStyle = peak > 16.7 ? '#ff8a7a' : '#9bb3c4'
        ctx.fillText(peak.toFixed(1) + 'ms', x + 214, yy)
        ctx.fillStyle = '#6f8aa0'
        ctx.fillText(cnt == null ? '-' : String(cnt), x + 272, yy)
    }

    // ── Memory benchmark section ───────────────────────────────────────────────
    yy += rowH              // 1-row gap after timing rows
    // Section title + estimated total (does NOT include JS object overhead or
    // HTMLImageElement decode buffers, which live outside the JS heap and can't
    // be measured here — see the n× images notes).
    ctx.fillStyle = '#9bd8ff'
    ctx.fillText('MEMORY  est. ' + _memFmt(memTotal), x + 9, yy + 4)
    yy += rowH
    ctx.fillStyle = '#6f8aa0'
    ctx.fillText('cache',                      x + 9,   yy)
    ctx.fillText('bytes',                      x + 158, yy)
    ctx.fillText('n',                          x + 272, yy)

    // Memory rows: highlight the single biggest consumer (red) so the eye lands
    // on whatever is gobbling bytes this frame — usually the wind-sheet cache or
    // the baked deco canvases depending on scene + weather.
    for (let i = 0; i < memRows.length; i++) {
        yy += rowH
        const [label, bytes, count] = memRows[i]
        ctx.fillStyle = bytes >= _biggest && _biggest > 0 ? '#ff8a7a' : '#cfe6d8'
        ctx.fillText(label, x + 9, yy)
        ctx.fillStyle = bytes ? (bytes >= _biggest && _biggest > 0 ? '#ffd86b' : '#9bd8ff') : '#6f8aa0'
        ctx.fillText(label.includes('(n)') ? '-' : _memFmt(bytes), x + 158, yy)
        ctx.fillStyle = '#6f8aa0'
        ctx.fillText(count == null ? '-' : String(count), x + 272, yy)
    }

    // Real JS-heap reading (Chromium only). Shown as used/limit so it's clear how
    // much headroom the engine has before a GC pressure spike — complements (not
    // replaces) the cache estimates above, which are about backing buffers.
    if (hasHeap) {
        yy += rowH
        const m = performance.memory
        ctx.fillStyle = '#9bd8ff'
        ctx.fillText(`heap ${_memFmt(m.usedJSHeapSize)} / ${_memFmt(m.jsHeapSizeLimit)}`
            + `  (${_memFmt(m.totalJSHeapSize)})`, x + 9, yy)
    }

    ctx.restore()
}

// ─── Weather render (screen-space overlay: tint, rain, snow) ──────────────────
// Drawn AFTER ctx.restore() in render(), so it's not subject to the world camera:
// rain falls on the *screen*, which is correct + cheaper than world-space particles.
// Weather data lives in the engine (pure state); this module only reads + renders.
// Transitions are advanced by tickWeather(dt) from gameLoop, so a tab-throttled rAF
// cannot jump-cut a tween (uses real dt, not a now()-delta).

// Per-type particle *style* only. night/sunset are NOT weather — they live in the
// independent lighting channel (see renderLighting), so rain/snow compose freely with
// any ambient tint (night+rain, sunset+snow, …). Kept first-class so a future fog
// particle style adds an entry without touching render control flow.
const WEATHER_PARTICLE = {
    none: null,
    rain: null,
    snow: null,
}

// Sunset glow gradient (screen-space, rebuild only on resize). Cached for cost.
let _sunsetGrad = null
function _sunsetGradient() {
    if (_sunsetGrad && _sunsetGrad._w === canvas.width && _sunsetGrad._h === canvas.height) return _sunsetGrad
    const g = ctx.createRadialGradient(
        canvas.width * 0.7, canvas.height * 0.18, canvas.height * 0.05,
        canvas.width * 0.5, canvas.height * 0.5,  Math.max(canvas.width, canvas.height) * 0.7)
    g.addColorStop(0, 'rgba(255,200,120,0.25)')
    g.addColorStop(1, 'rgba(255,120,30,0.05)')
    g._w = canvas.width; g._h = canvas.height
    _sunsetGrad = g
    return g
}

// Cached radial-gradient light "cookie". Keyed by (quantized radius px, hex color) —
// radius rounds to the nearest screen pixel (invisible) so the pulse's sub-pixel radius
// drift can't spawn unbounded gradients over time; one gradient reused per distinct
// (radius, color), i.e. a handful for an entire lit scene.
const _glowCache = new Map()
function _glowGradient(rPx, hex) {
    rPx = Math.round(rPx)
    const key = rPx + '|' + hex
    let g = _glowCache.get(key)
    if (g) return g
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, rPx)
    // Peak alpha at centre falls off quad-like via two stops; the caller modulates
    // overall strength with globalAlpha so this stays a unit shape.
    g.addColorStop(0,   _rgba(hex, 0.8))
    g.addColorStop(0.45, _rgba(hex, 0.3))
    g.addColorStop(1,   _rgba(hex, 0))
    _glowCache.set(key, g)
    return g
}
// hex('#rrggbb') + alpha 0..1 → 'rgba(r,g,b,a)' string. Used to build gradient stops.
function _rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// Shared light "hole" gradient. A unit-radius radial: opaque at centre fading to clear at
// the edge. Drawn under ctx.scale(r,r) so one cached gradient serves every light radius —
// used with 'destination-out' to subtract darkness from `_lightBuf` in a soft falloff.
// Created lazily from the TARGET context (gradients are context-bound in some engines).
const _punchGradCache = new WeakMap()
function _punchGradient(c2d) {
    let g = _punchGradCache.get(c2d?.canvas)
    if (g) return g
    g = c2d.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0,   'rgba(0,0,0,1)')
    g.addColorStop(0.5, 'rgba(0,0,0,0.85)')
    g.addColorStop(1,   'rgba(0,0,0,0)')
    _punchGradCache.set(c2d.canvas, g)
    return g
}

// Fixed particle pool — one Float32Array, no per-frame allocation. Each drop stores
// [x, y, vy, phase, kind] (kind: 0=rain 1=snow, kept per-drop so a rain↔snow switch lets
// in-flight drops keep their style while new spawns take the new kind).
// Linear constant-rate spawner: rate = N·meanVy / canvasH reaches a flat on-screen count N
// smoothly (no P-controller bursts). Stopping sets rate=0 and the drops fall off naturally.
const W_KIND_RAIN = 0
const W_KIND_SNOW = 1
const W_MAX_PARTICLES = 900   // snow needs many more point sprites than rain; pool sized for peak
const W_UNUSED = -9999
const W_STRIDE  = 5
let _wPool     = new Float32Array(W_MAX_PARTICLES * W_STRIDE).fill(W_UNUSED)
let _wActive    = 0   // count of drops on-screen last frame (drives render + finish-detection)
let _wSpawnCarry = 0   // fractional spawn accumulator — keeps arrivals exactly linear, no bursts

function _wRandomVY(kind) {
    if (kind === W_KIND_SNOW) return 50 + Math.random() * 70   // 50–120 px/s — wide spread breaks row coherence
    return 380 + Math.random() * 240
}
// Mean vy per kind — used to convert an on-screen target COUNT into a per-second spawn RATE.
const _wMeanVY = { [W_KIND_RAIN]: 500, [W_KIND_SNOW]: 60 }

/** On-screen target count. Snow's target is ~2× rain's: snowflakes are point dots (no streak to
 *  bridge vertical gaps), and slow falls leave the eye free to see rows, so density must be high. */
function _wTargetOnScreen(kind, intensity) {
    const base = kind === W_KIND_SNOW ? 520 : 260
    return Math.floor(intensity * base)
}

/** Snowflake sway: a slow per-flake sine, amplitude scaled by kind so rain stays straight. */
const _wSnowTick = () => performance.now() / 1000

/** Place a fresh drop into slot `i` near the TOP edge of the visible screen. A small y spread
 *  (0..70px) softens the spawn line so drops don't pop in along a hard y=0. x wraps on update,
 *  so a uniform [0, canvasW) spawn keeps every column of the screen evenly fed regardless of wind. */
function _wSpawnAtTop(i, kind, canvasW) {
    const ix = i * W_STRIDE
    _wPool[ix]     = Math.random() * canvasW
    _wPool[ix + 1] = Math.random() * 70
    _wPool[ix + 2] = _wRandomVY(kind)
    _wPool[ix + 3] = kind === W_KIND_SNOW ? Math.random() * 6.2832 : 0   // sway phase (0..2π), rain unused
    _wPool[ix + 4] = kind                                                    // per-particle kind
}

/** Advance + draw the particle pool. `active` controls spawning: true while the effect is live
 *  (spawn at the linear rate implied by intensity); once false, no new drops spawn and the
 *  surviving ones fall off the bottom in their own time. The pool keeps updating until empty. */
function _wUpdateParticles(dt, kind, intensity, wind, canvasW, canvasH, active) {
    // Horizontal particle tilt from weather wind. Tuned 10× the raw wind px/s so that
    // realistic-feeling wind values (tens of px/s, the same axis that leans trees) move
    // rain sideways noticeably — unscaled, the tilt was imperceptible vs the ~500 px/s
    // rain fall speed. Snow gets the same factor so flakes blow across in a gale.
    const WIND_DRIFT_MULT = kind === W_KIND_RAIN ? 3 : 0.5
    const drift = wind * WIND_DRIFT_MULT               // px/s horizontal tilt (rain: straight diagonal)

    // 1) Spawn at a CONSTANT per-second rate (linear population, no waves). Steady-state count
    //    N over a mean lifetime L = canvasH / meanVy ⟹ rate = N / L = N * meanVy / canvasH.
    //    A fractional accumulator spreads arrivals evenly across frames instead of quantising
    //    into per-frame bursts (which themselves look wavy at low density). When not active,
    //    rate is 0 — the pool just drains to the bottom.
    if (active && intensity > 0) {
        const targetOnScreen = _wTargetOnScreen(kind, intensity)
        const rate = targetOnScreen * _wMeanVY[kind] / Math.max(1, canvasH)   // drops / second
        _wSpawnCarry += rate * dt
        let toSpawn = Math.floor(_wSpawnCarry)
        _wSpawnCarry -= toSpawn
        for (let i = 0; i < W_MAX_PARTICLES && toSpawn > 0; i++) {
            const ix = i * W_STRIDE
            if (_wPool[ix] === W_UNUSED) {
                _wSpawnAtTop(i, kind, canvasW)
                toSpawn--
            }
        }
    } else {
        _wSpawnCarry = 0   // effect finishing: stop introducing drops, let the rest fall out
    }

    const swayT  = _wSnowTick()
    const streakLen = kind === W_KIND_SNOW ? 0 : 10 + intensity * 10   // rain streak length (only rain draws)

    // 2) Advance + cull. Drops that fall off the bottom are RELEASED (never recycled in place);
    //    the constant-rate spawner back-fills from the top, which is why there are no waves.
    let onScreen = 0
    for (let i = 0; i < W_MAX_PARTICLES; i++) {
        const ix = i * W_STRIDE
        if (_wPool[ix] === W_UNUSED) continue
        const y = _wPool[ix + 1]
        if (y > canvasH + 20) {                       // fell off the bottom → release
            _wPool[ix] = _wPool[ix + 1] = _wPool[ix + 2] = _wPool[ix + 3] = _wPool[ix + 4] = W_UNUSED
            continue
        }
        // x drift: rain straight `drift`; snow adds a slow per-flake sway so flakes can't hold
        // a horizontal row (the cause of "empty rows are visible"). Sway uses the drop's own
        // kind so a transitioning rain drop doesn't suddenly start swaying mid-air.
        // x WRAPS around the screen edges: a drop blown off the left re-enters on the right and
        // vice-versa, so wind can't pile drops against the downwind edge and leave a blank
        // (downwind-bottom) triangle — the screen stays uniformly populated for any wind.
        const dy = _wPool[ix + 2]
        const sway = _wPool[ix + 4] === W_KIND_SNOW ? Math.sin(swayT * 1.6 + _wPool[ix + 3]) * 22 : 0
        let nx = _wPool[ix] + (drift + sway) * dt
        nx = ((nx % canvasW) + canvasW) % canvasW
        _wPool[ix] = nx
        _wPool[ix + 1] = y + dy * dt
        if (_wPool[ix + 1] >= 0 && _wPool[ix + 1] <= canvasH) onScreen++
    }

    // 3) Draw every on-screen drop (advance already applied), each in its own kind's style.
    ctx.lineCap = 'round'
    for (let i = 0; i < W_MAX_PARTICLES; i++) {
        const ix = i * W_STRIDE
        if (_wPool[ix] === W_UNUSED) continue
        const y = _wPool[ix + 1]
        if (y < 0 || y > canvasH) continue
        const x = _wPool[ix]
        if (_wPool[ix + 4] === W_KIND_SNOW) {
            // 4×4 soft cross flake — reads as snow at a glance.
            ctx.fillStyle = 'rgba(235,240,255,0.92)'
            const cx = Math.round(x), cy = Math.round(y)
            ctx.fillRect(cx, cy - 2, 1, 5)
            ctx.fillRect(cx - 2, cy, 5, 1)
            ctx.fillRect(cx - 1, cy - 1, 3, 3)
        } else {
            ctx.lineWidth = 1.4
            ctx.strokeStyle = `rgba(200,215,235,${0.35 + 0.4 * intensity})`
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.lineTo(x + drift * 0.02, y + streakLen)
            ctx.stroke()
        }
    }
    _wActive = onScreen
}

/** Paint the lighting tint (flat night fill or cached sunset radial) onto `c2d`
 *  at strength `k` (1=full). Sunset uses a screen-space radial; flat is a rect fill. */
function _drawLightingTint(tint, k, c2d = ctx) {
    if (!tint) return
    const a = Math.max(0, Math.min(1, (tint.a ?? 0) * k))
    if (a <= 0) return
    if ((tint.mode ?? 'flat') === 'sunset') {
        // Radial stops embed their own authored alphas; `k` scales the whole glow (1=full).
        c2d.globalAlpha = k
        c2d.fillStyle = _sunsetGradient()
    } else {
        c2d.globalAlpha = 1
        c2d.fillStyle = `rgba(${tint.col[0]},${tint.col[1]},${tint.col[2]},${a})`
    }
    c2d.fillRect(0, 0, canvas.width, canvas.height)
    c2d.globalAlpha = 1
}

/** Gather visible point lights → { sx, sy, rPx, col, a } in screen-pixel coords.
 *  Sources: LIGHT_BY_EFFECT map effects, decorations with an asset 'light',
 *  and equipped items with a 'light' def. Off-viewport lights are culled. */
function _collectLights(now) {
    const out = []
    const ox = _camX, oy = _camY, Z = ZOOM
    const cw = canvas.width, ch = canvas.height
    const push = (wx, wy, rPxW, col, a) => {
        const sx = (wx - ox) * Z, sy = (wy - oy) * Z, rPx = rPxW * Z
        if (sx + rPx < 0 || sx - rPx > cw || sy + rPx < 0 || sy - rPx > ch) return
        out.push({ sx, sy, rPx, col, a })
    }
    // Effects: fires etc. Centre on the effect's midfoot like the sprite is. Each effect holds
    // its own pulse phase + frequency (lazily assigned, stable afterwards) so two fires side
    // by side flicker independently instead of as one throb.
    for (const ef of (map?._effects ?? [])) {
        const L = LIGHT_BY_EFFECT[ef.type]
        if (!L) continue
        const wx = ef.x * TILE + TILE / 2 + (ef.dx || 0)
        const wy = ef.y * TILE + TILE / 2 + (ef.dy || 0)
        if (ef._lp == null) ef._lp = { p: _lightPhaseFor('ef' + ef.x + ',' + ef.y + ef.type), f: 4.6 * (0.8 + Math.random() * 0.4) }
        const pulse = _lightPulse(now, ef._lp.p, ef._lp.f)
        const rPxW = L.r * TILE * pulse.rad
        push(wx, wy, rPxW, L.col, (L.a ?? 1) * pulse.alpha)
    }
    // Decorations carrying an authored `light` (e.g. oil-lamp tile asset). Same per-instance
    // phase so each lamp breathes on its own beat.
    if (map?._decorations) {
        for (let y = 0; y < map.height; y++) {
            const row = map._decorations[y]
            if (!row) continue
            for (let x = 0; x < map.width; x++) {
                const d = row[x]
                if (!d) continue
                const asset = assetMap?.[d.assetId]
                const L = asset?.light
                if (!L) continue
                const wx = d.x * TILE + TILE / 2 + (d.dx || 0)
                const wy = d.y * TILE + TILE / 2 + (d.dy || 0)
                if (d._lp == null) d._lp = { p: _lightPhaseFor('deco' + d.x + ',' + d.y + (d.assetId || '')), f: 4.6 * (0.8 + Math.random() * 0.4) }
                const pulse = _lightPulse(now, d._lp.p, d._lp.f)
                const rPxW = (L.r ?? 2.5) * TILE * pulse.rad
                push(wx, wy, rPxW, L.col ?? '#ffd27a', (L.a ?? 0.8) * pulse.alpha)
            }
        }
    }
    // Player equipped lights: any equipped item with a "light" definition emits a light.
    // Reads each equipped slot every frame, so picking up a glowing item lights the halo instantly.
    const eq = engine.getState().equipped || {}
    for (const slot of ['hand_l', 'hand_r', 'head', 'neck', 'torso', 'feet']) {
        const itemId = eq[slot]
        if (!itemId) continue
        const def = _itemsDef[itemId]
        if (!def?.light) continue
        const L = def.light
        const phase = _lightPhaseFor('equip' + slot)
        const pulse = _lightPulse(now, phase, 4.6 * (0.9 + (slot.charCodeAt(slot.length - 1) % 10) * 0.04))
        push(player.px, player.py, (L.radius ?? 3) * TILE * pulse.rad, L.color ?? '#ffd27a', (L.alpha ?? 0.7) * pulse.alpha)
    }
    return out
}

/** Ambient night/sunset tint, independent of weather. Flat darkness lives on an offscreen
 *  canvas; point lights punch soft radial holes via 'destination-out', then the holey
 *  darkness is composited over the frame — a torch *reveals* terrain beneath and can never
 *  blow out to white. A 'lighten' halo per light caps overlaps at the brighter of the two.
 *  Cross-fade on a flat↔sunset mode change comes from engine.getLightingFor. */
let _lightBuf = null           // offscreen canvas — the darkness-tint canvas we punch holes into
function renderLighting(now) {
    if (!_currentMapId || !map) return
    const live = engine.getLightingFor(_currentMapId)
    const tint = live.tint
    const transition = live.transition

    // Resolve which tint shapes are on screen this frame and at what strength.
    // flatAlpha = opacity of the flat darkness pass (drives point-light fade); sunsetAlpha
    // = strength of the radial glow pass. flat → _lightBuf + holes; sunset → drawn to frame.
    let flatAlpha = 0            // strength of the flat darkness pass (0 == none)
    let sunsetAlpha = 0          // strength of the sunset glow pass (0 == none)
    if (transition) {
        // Mode-swap cross-fade: the engine reports raw endpoints. `?? 0` on α treats
        // a missing tint as "no darkness" rather than a null-deref (the world map has
        // no authored lighting and hit this on its first set_lighting).
        const { from, to, k } = transition
        const fromFlat = (from?.mode ?? 'flat') === 'flat'
        const toFlat   = (to?.mode   ?? 'flat') === 'flat'
        if (fromFlat) flatAlpha   = Math.max(flatAlpha,   (from?.a ?? 0) * (1 - k))
        else          sunsetAlpha = Math.max(sunsetAlpha, 1 - k)
        if (toFlat)   flatAlpha   = Math.max(flatAlpha,   (to?.a ?? 0) * k)
        else          sunsetAlpha = Math.max(sunsetAlpha, k)
    } else if (tint) {
        // Resting (no tween): one endpoint at full strength.
        if ((tint.mode ?? 'flat') === 'flat') flatAlpha = tint.a ?? 0
        else                                  sunsetAlpha = 1
    }

    const hasFlat   = flatAlpha > 0
    const hasSunset = sunsetAlpha > 0

    // Lights fade in across the [_min, _max] darkness ramp (no on/off pop). Zero fade → skip
    // the whole light pass entirely — mid-day is still a clean no-op.
    const fadeK = _lightFadeK(flatAlpha)
    const lights = (fadeK > 0) ? _collectLights(now) : null

    // Nothing to paint → fully lit frame.
    if (!hasFlat && !hasSunset && !lights?.length) return

    // ── Flat darkness path: paint tint on its own canvas, punch holes, composite ──
    if (hasFlat) {
        if (!_lightBuf) _lightBuf = document.createElement('canvas')
        if (_lightBuf.width !== canvas.width || _lightBuf.height !== canvas.height) {
            _lightBuf.width = canvas.width; _lightBuf.height = canvas.height
        }
        const b2d = _lightBuf.getContext('2d')
        b2d.clearRect(0, 0, _lightBuf.width, _lightBuf.height)

        // 1) Ambient flat darkness. Resting flat → the single lerped tint at strength 1.
        //    Mode-swap tween → draw each flat endpoint at its fading strength (the engine
        //    did NOT lerp across a mode change, so the flat side appears only as endpoints).
        if (transition) {
            const { from, to, k } = transition
            if ((from?.mode ?? 'flat') === 'flat') _drawLightingTint(from, 1 - k, b2d)
            if ((to?.mode   ?? 'flat') === 'flat') _drawLightingTint(to, k, b2d)
        } else {
            _drawLightingTint(tint, 1, b2d)
        }

        // 2) Punch a soft radial hole per point light. 'destination-out' subtracts the
        //    darkness alpha by the gradient strength → centre fully clear (terrain shows
        //    through), feathering to full darkness at the radius. Subtractive only → a
        //    torch can't add light beyond what's beneath it, so overlaps can't blow out.
        //    Hole strength tracks the fade ramp so the holes fade OUT with the receding
        //    night (a night→sunset tween shrinks the punchout as the glow takes over, not
        //    before) — and smooth from the very bottom of the ramp, not a hard cutoff.
        const holeGrad = _punchGradient(b2d)   // shared unit gradient: centre opaque→edge clear
        b2d.globalCompositeOperation = 'destination-out'
        const holeK = fadeK                    // 1 in steady dark; ramps 0..1 across the fade window
        for (const L of lights ?? []) {
            const rPx = Math.max(2, L.rPx)
            b2d.save()
            b2d.translate(L.sx, L.sy)
            b2d.globalAlpha = Math.max(0, Math.min(1, L.a * holeK))
            b2d.scale(rPx, rPx)
            b2d.fillStyle = holeGrad
            b2d.beginPath(); b2d.arc(0, 0, 1, 0, Math.PI * 2); b2d.fill()
            b2d.restore()
        }
        b2d.globalCompositeOperation = 'source-over'
        b2d.globalAlpha = 1

        // 3) Composite holey darkness onto the frame (terrain + already-drawn sprites beneath).
        ctx.save()
        ctx.resetTransform()
        ctx.drawImage(_lightBuf, 0, 0)
        ctx.restore()
    }

    ctx.save()
    ctx.resetTransform()      // screen space — independent of world camera

    // 4) Sunset radial glow (a glow, not darkness) → straight to the frame, cross-faded on a
    //    mode swap. Drawn whether or not point lights exist (sunset needs no darkness punchout).
    if (transition) {
        const { from, to, k } = transition
        if ((from?.mode ?? 'flat') !== 'flat') _drawLightingTint(from, 1 - k)
        if ((to?.mode   ?? 'flat') !== 'flat') _drawLightingTint(to,   k)
    } else if (tint && (tint.mode ?? 'flat') !== 'flat') {
        _drawLightingTint(tint, 1)
    }

    // 5) Warm colored halos over everything, 'lighten' so overlap caps at the brighter-of-two
    //    per channel (never sums to blown-out white). Peak color kept semi-transparent so a
    //    near-max-bright fire sprite underneath ('lighten' = no-op on its own pixels) is safe.
    //    Halo strength tracks the same fade ramp as the hole punch, so the glow and its carved
    //    darkness leave together on a night→day tween — no pop, no light over a bright frame.
    if (lights?.length) {
        ctx.globalCompositeOperation = 'lighten'
        const haloK = fadeK
        for (const L of lights) {
            const rPx = Math.max(2, L.rPx)
            ctx.globalAlpha = Math.max(0, Math.min(1, L.a * 0.55 * haloK))   // halve: warmth, not a searchlight
            ctx.save()
            ctx.translate(L.sx, L.sy)
            ctx.fillStyle = _glowGradient(rPx, L.col)
            ctx.beginPath(); ctx.arc(0, 0, rPx, 0, Math.PI * 2); ctx.fill()
            ctx.restore()
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
    }

    ctx.restore()
}

function renderWeather(dt) {
    if (!_currentMapId) return
    const live = engine.getWeatherFor(_currentMapId)
    // cheap common case: nothing to render AND no drops left to drain to the bottom.
    // While an effect is finishing (type → none / intensity → 0) we still enter so the
    // surviving particles fall out naturally instead of freezing mid-air.
    if (live.type === 'none' && live.intensity <= 0 && _wActive === 0) return

    ctx.save()
    ctx.resetTransform()      // screen space — independent of world camera

    // Particles only (rain / snow). The ambient night/sunset tint + point lights are a
    // separate channel — renderLighting — so one frame can be e.g. night + rain. Spawn
    // while the live weather is active; once it changes away keep advancing so the last
    // drops fall off the bottom — finished naturally, nothing is frozen in place.
    const isRainSnow = live.type === 'rain' || live.type === 'snow'
    if (isRainSnow || _wActive > 0) {
        const kind   = live.type === 'snow' ? W_KIND_SNOW : W_KIND_RAIN
        const active = isRainSnow && live.intensity > 0
        _wUpdateParticles(dt ?? 0.016, kind, live.intensity, live.wind,
                          canvas.width, canvas.height, active)
    }

    ctx.restore()
}

// ─── Render ───────────────────────────────────────────────────────────────────
let _camX = 0, _camY = 0   // last camera world-pixel origin (for viewport culling)
let _perfPeakResetAt = 0   // perf.now() of last peak reset (resets every second)

function render(dt) {
    if (SHOW_PERF) _perfFrameStart = performance.now()
    _resolveWindFrame()        // resolve live weather → this frame's wind bucket/normWind
    _resetWindFrame()           // reset the lazy bake budget (Infinity on a snap)
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = tileset?.backgroundColor ?? '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Camera centred on player.
    // Snap to the nearest screen pixel so world coords always map to integer
    // screen positions and tile seams don't appear (sub-pixel gap fix).
    const camX = Math.floor(player.px * ZOOM - canvas.width  / 2) / ZOOM
    const camY = Math.floor(player.py * ZOOM - canvas.height / 2) / ZOOM
    _camX = camX; _camY = camY

    ctx.save()
    ctx.scale(ZOOM, ZOOM)
    ctx.translate(-camX, -camY)

    _perfStart('terrain');  renderTerrain();                                   _perfEnd('terrain')
    _perfStart('water');    renderWaterLayer();                                _perfEnd('water')
    _perfStart('ofoam');    renderObjectFoam();                                _perfEnd('ofoam')
    if (SHOW_GRID || SHOW_COORDS) { _perfStart('grid'); renderGrid(); _perfEnd('grid') }
    _perfStart('tops');     renderTerrainTops();                               _perfEnd('tops')
    _perfStart('deco');     renderDecorationsEffectsAndPlayer();               _perfEnd('deco')

    ctx.restore()

    // Lighting (night/sunset tint + point-light glow) is drawn BEFORE weather particles
    // so rain/snow sit on top of the dark ambient + halos — water is in front of firelight.
    _perfStart('lighting'); renderLighting(performance.now()); _perfEnd('lighting')
    _perfStart('weather');  renderWeather(dt);                 _perfEnd('weather')

    if (SHOW_PERF) {
        _perfTickFrame()
        // Reset peak markers once per second so "max" stays a fresh worst-case.
        const now = performance.now()
        if (now - _perfPeakResetAt >= 1000) { _perfResetPeaks(); _perfPeakResetAt = now }
        _drawPerfOverlay()
    }

    // Update HUD every frame — cheap DOM writes, not canvas work
    updateHud()
}

// ─── Game loop ────────────────────────────────────────────────────────────────
let prevTime = 0

function gameLoop(now) {
    const dt = Math.min((now - prevTime) / 1000, 0.05)
    prevTime = now
    // Water frame and effect tick are now both derived from floor(now/100) — no counter needed
    update(dt)
    // Advance both overlay-channel tweens: weather (rain/snow density) + lighting (night/sunset tint).
    // Independent channels so a single frame can be e.g. night + rain, sunset + snow, etc.
    if (_currentMapId) {
        engine.tickWeather(_currentMapId, dt)
        engine.tickLighting(_currentMapId, dt)
    }
    render(dt)
    requestAnimationFrame(gameLoop)
}

// ─── Learning System ──────────────────────────────────────────────────────────
// Registry of available learning documents: maps pool/category to HTML content URLs
const _learnRegistry = new Map()  // key: "category:pool" or "category" → { url, loaded: false, html: null }
const _learnCache = new Map()     // key → HTML string (loaded content)

/**
 * Build the learning registry by scanning for learnN.html files alongside poolN.json.
 * Called during loadQuestions so we know what docs are available.
 */
async function _buildLearnRegistry(scenarioBasePath, poolCount, category) {
    const sub = category ? `questions/${category}` : 'questions'
    const keys = []

    // Check for category-level learn file (e.g., questions/math/learn.html)
    const catKey = category ?? 'default'
    keys.push({ key: catKey, url: `${scenarioBasePath}/${sub}/learn.html` })

    // Check for per-pool learn files (e.g., questions/math/learn1.html, learn2.html)
    for (let pool = 1; pool <= poolCount; pool++) {
        const poolKey = `${catKey}:${pool}`
        keys.push({ key: poolKey, url: `${scenarioBasePath}/${sub}/learn${pool}.html` })
    }

    // Probe which files exist (HEAD requests)
    const results = await Promise.all(
        keys.map(async ({ key, url }) => {
            try {
                const res = await fetch(url, { method: 'HEAD' })
                if (res.ok) {
                    _learnRegistry.set(key, { url, loaded: false, html: null })
                    return key
                }
            } catch { /* ignore */ }
            return null
        })
    )

    console.log(`[Learn] Registry built for ${category ?? 'default'}: ${results.filter(Boolean).length} documents`)
}

/**
 * Load a learning document by key (category:pool or category).
 * Returns the HTML string, or null if not found.
 */
async function loadLearnDoc(key) {
    const entry = _learnRegistry.get(key)
    if (!entry) return null

    if (entry.loaded) return entry.html

    try {
        const res = await fetch(entry.url)
        if (!res.ok) return null
        entry.html = await res.text()
        entry.loaded = true
        _learnCache.set(key, entry.html)
        return entry.html
    } catch (e) {
        console.warn(`[Learn] Failed to load ${entry.url}:`, e.message)
        return null
    }
}

/**
 * Get the most specific learning doc key for the current battle context.
 * Priority: monster's pool → global pool → category default
 */
function _getCurrentLearnKey() {
    const state = engine.getState()
    const globalSpec = state.variables.questionPool
    const monsterSpec = _currentBattleMonster?.questionPool
    const cat = _currentCategory ?? 'default'

    // Try monster pool first
    if (monsterSpec) {
        const pools = parsePoolSpec(monsterSpec)
        if (pools) {
            for (const p of pools) {
                const key = `${cat}:${p}`
                if (_learnRegistry.has(key)) return key
            }
        }
    }

    // Try global pool
    if (globalSpec) {
        const pools = parsePoolSpec(globalSpec)
        if (pools) {
            for (const p of pools) {
                const key = `${cat}:${p}`
                if (_learnRegistry.has(key)) return key
            }
        }
    }

    // Fall back to category default
    if (_learnRegistry.has(cat)) return cat

    return null
}

/**
 * Show the learning dialog for a specific key, or auto-detect from context.
 */
async function showLearnDialog(key = null) {
    const targetKey = key ?? _getCurrentLearnKey()
    if (!targetKey) {
        console.log('[Learn] No learning document available for current context')
        return
    }

    const html = await loadLearnDoc(targetKey)
    if (!html) {
        console.warn(`[Learn] Document not found: ${targetKey}`)
        return
    }

    _openLearnModal(html, targetKey)
}

/**
 * Open the learning modal with the given HTML content.
 */
function _openLearnModal(html, key) {
    const modal = document.getElementById('learn-modal')
    const title = document.getElementById('learn-modal-title')
    const content = document.getElementById('learn-modal-content')

    // Extract title from key if possible
    title.textContent = key.includes(':') ? `Pomoc: ${key.replace(':', ' / pool ')}` : `Pomoc: ${key}`

    // Render HTML with KaTeX support
    content.innerHTML = html
    if (html.includes('$')) renderMathInElement(content, _katexOpts)

    // Focus management
    _flushMovementKeys()
    modal.classList.remove('hidden')
    document.getElementById('learn-modal-close').focus()

    // Setup close handlers
    function onClose() {
        modal.classList.add('hidden')
        document.removeEventListener('keydown', onKey, true)
        document.getElementById('learn-modal-backdrop').removeEventListener('click', onBackdropClick)
        document.getElementById('learn-modal-close').removeEventListener('click', onClose)
    }
    function onKey(e) {
        if (e.code === 'Escape') {
            e.preventDefault(); e.stopPropagation()
            onClose()
        }
    }
    function onBackdropClick(e) {
        if (e.target === document.getElementById('learn-modal-backdrop')) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.getElementById('learn-modal-backdrop').addEventListener('click', onBackdropClick)
    document.getElementById('learn-modal-close').addEventListener('click', onClose)
}

// ─── Battle system ────────────────────────────────────────────────────────────
let _questions = []   // all loaded questions: { question, answers, hint, pool? }
// Active question category (folder name under questions/, e.g. "math"), or null
// when the scenario has no categories and loads flat questions/poolN.json.
// NOTE: "category" is orthogonal to per-question `pool` — pool still gates by
// player level; category selects *which folder of pool files* is loaded.
let _currentCategory = null

// Current battle monster (for question pool selection)
let _currentBattleMonster = null

/** Parse a pool specification string into a Set of pool numbers.
 *  Supported formats:
 *    - "2" or 2          → {2}
 *    - "1,3"             → {1, 3}
 *    - "1..3"            → {1, 2, 3}
 *    - null/undefined    → null (no constraint)
 */
function parsePoolSpec(spec) {
    if (spec == null) return null
    const s = String(spec).trim()
    if (s === '') return null
    if (s.includes('..')) {
        const [a, b] = s.split('..').map(x => parseInt(x.trim(), 10))
        if (isNaN(a) || isNaN(b) || a > b) return null
        return new Set([...Array(b - a + 1)].map((_, i) => a + i))
    }
    return new Set(s.split(',').map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n)))
}

async function loadQuestions(scenarioBasePath, poolCount = 1, category = null) {
    _questions = []
    // category selects a subfolder: questions/<category>/poolN.json. When null
    // (legacy scenarios with no questionCategories) load flat questions/poolN.json.
    const sub = category ? `questions/${category}` : 'questions'
    // Load pool1..poolN in parallel. poolCount defaults to 1 — at least one pool
    // must exist. A failed or missing fetch rethrows so it surfaces on the
    // loading screen and flags that something is wrong with the scenario.
    const results = await Promise.all(
        Array.from({ length: poolCount }, (_, i) => i + 1).map(async pool => {
            const res = await fetch(`${scenarioBasePath}/${sub}/pool${pool}.json`)
            if (!res.ok) throw new Error(`${sub}/pool${pool}.json not found (${res.status})`)
            const qs = await res.json()
            return [pool, qs]
        })
    )
    // Preserve pool order so q.pool numbering stays monotonic.
    for (const [pool, qs] of results) {
        for (const q of qs) _questions.push({ ...q, pool })
    }
}

/** Pick a random question based on pool priority:
 *  1. Monster pool (from spawn_monster action) — highest priority
 *  2. Global pool (from set_question_pool action)
 *  3. Default: pool 1 only
 */
function _pickQuestion() {
    const state = engine.getState()
    const globalSpec = state.variables.questionPool
    const monsterSpec = _currentBattleMonster?.questionPool

    // Priority: monster > global > default (pool 1)
    const effectiveSpec = monsterSpec ?? globalSpec ?? '1'
    const allowedPools = parsePoolSpec(effectiveSpec)

    let src = _questions
    if (allowedPools) {
        src = _questions.filter(q => allowedPools.has(q.pool ?? 1))
    }
    if (!src.length) src = _questions  // fallback: all questions if filter yields nothing
    if (!src.length) return { question: '(Brak pytań)', answers: [''], hint: '' }
    return src[Math.floor(Math.random() * src.length)]
}

/** Normalize an answer string for comparison. */
function _normalizeAnswer(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' ') }

// Battle canvas RAF handle
let _battleRafId = null

// Y offset within the 64×96 battle canvas where the sprite top begins.
// Leaves 32 px of headroom for the float-up death animation.
const BATTLE_SPRITE_Y = 32

function _drawBattleSprites(monster) {
    // Player sprite — idle, facing down (row DIR_DOWN).
    const pc   = document.getElementById('battle-player-canvas')
    const pctx = pc.getContext('2d')
    pctx.clearRect(0, 0, 64, 96)
    const pSprite = playerSprites.sheet
    if (pSprite) {
        pctx.imageSmoothingEnabled = false
        const col = _heroAnimCol(false)            // idle cycle
        const row = DIR_ROW[DIR_DOWN] | 0
        pctx.drawImage(pSprite, col * HERO_FRAME_W, row * HERO_FRAME_H,
            HERO_FRAME_W, HERO_FRAME_H, 0, BATTLE_SPRITE_Y, 64, 64)
    }
    // Monster sprite — unified via resolveEntityDef
    const mc   = document.getElementById('battle-enemy-canvas')
    const mctx = mc.getContext('2d')
    mctx.clearRect(0, 0, 64, 96)
    mctx.imageSmoothingEnabled = false
    const resolved = resolveEntityDef(monster.type)
    const animPhase = monster.animPhase ?? 0
    const frame    = (_monsterAnimTick() + animPhase) % 4
    if (resolved.composite) {
        _drawCompositeEnemy(resolved.def, mctx, frame, 2, 32, BATTLE_SPRITE_Y + 32, true)
    } else {
        const sprite = _getEntityImg(monster.type)
        if (sprite) {
            const { frameW, frameH } = resolved
            mctx.save()
            mctx.translate(64, BATTLE_SPRITE_Y)
            mctx.scale(-1, 1)
            mctx.drawImage(sprite, frame * frameW, 0, frameW, frameH, 0, 0, 64, 64)
            mctx.restore()
        }
    }
}

function _updateBattleHpBars(playerHp, playerMaxHp, monsterHp, monsterMaxHp) {
    document.getElementById('battle-player-hp-fill').style.width =
        `${Math.max(0, playerHp / playerMaxHp * 100)}%`
    document.getElementById('battle-player-hp-text').textContent =
        `${Math.max(0, playerHp)} / ${playerMaxHp}`
    document.getElementById('battle-enemy-hp-fill').style.width =
        `${Math.max(0, monsterHp / monsterMaxHp * 100)}%`
    document.getElementById('battle-enemy-hp-text').textContent =
        `${Math.max(0, monsterHp)} / ${monsterMaxHp}`
    // Color HP bar by percentage
    const pct = monsterHp / monsterMaxHp
    document.getElementById('battle-enemy-hp-fill').style.background =
        pct > 0.5 ? '#3fa84a' : pct > 0.25 ? '#c8a020' : '#c84040'
    const ppct = playerHp / playerMaxHp
    document.getElementById('battle-player-hp-fill').style.background =
        ppct > 0.5 ? '#3fa84a' : ppct > 0.25 ? '#c8a020' : '#c84040'
}

// Enemy stats for the current battle, read by _renderBattleStats().
let _battleEnemyDef = null

/** Render minimal three-letter stat labels with values for both fighters. */
function _renderBattleStats() {
    const heroEl  = document.getElementById('battle-hero-stats')
    const enemyEl = document.getElementById('battle-enemy-stats')
    if (!heroEl || !enemyEl) return

    const eq = engine.equippedBonuses?.() ?? { attack:0, defense:0, armor:0, agility:0, base_dmg:0 }
    const pDmg = (playerStats.base_dmg ?? 10) + (eq.base_dmg ?? 0)
    const pAtt = (playerStats.attack  ?? 0)  + (eq.attack  ?? 0)
    const pDef = (playerStats.defense ?? 0)  + (eq.defense ?? 0)
    const pArm = (playerStats.armor   ?? 0)  + (eq.armor   ?? 0)
    const pAgi = (playerStats.agility ?? 0)  + (eq.agility ?? 0)

    heroEl.innerHTML =
        `<span>DMG ${pDmg}</span>` +
        `<span>ATT ${pAtt}</span>` +
        `<span>DEF ${pDef}</span>` +
        `<span>ARM ${pArm}</span>` +
        `<span>AGI ${pAgi}</span>`

    const e = _battleEnemyDef ?? {}
    enemyEl.innerHTML =
        `<span>DMG ${e.base_dmg ?? 6}</span>` +
        `<span>ATT ${e.attack   ?? 6}</span>` +
        `<span>DEF ${e.defense  ?? 2}</span>` +
        `<span>ARM ${e.armor    ?? 0}</span>` +
        `<span>AGI ${e.agility  ?? 2}</span>`
}

// ─── HUD update ──────────────────────────────────────────────────────────────
const _ITEM_SIZE_HUD = 32  // pixel size for inventory/HUD item icons

function updateHud() {
    // Guard: HUD elements may not exist during early init
    const hpFill = document.getElementById('hud-hp-fill')
    if (!hpFill) return
    const hpPct = Math.max(0, playerStats.hp / playerStats.maxHp * 100)
    hpFill.style.width = hpPct + '%'
    document.getElementById('hud-hp-text').textContent =
        `${Math.max(0, playerStats.hp)}/${playerStats.maxHp}`
    // Color HP bar
    hpFill.style.background = hpPct > 50 ? '#3fa84a' : hpPct > 25 ? '#c8a020' : '#c84040'

    // Gold display (above HP bar) - read from engine inventory
    const goldIcon = document.getElementById('hud-gold-icon')
    if (goldIcon) _drawGoldIcon(goldIcon)
    const goldText = document.getElementById('hud-gold-text')
    const engineState = engine.getState()
    const goldAmount = engineState.inventory?.Gold ?? 0
    if (goldText) goldText.textContent = goldAmount
    // Also update playerStats for other code that might reference it
    playerStats.gold = goldAmount

    // XP bar
    const xp = playerStats.xp ?? 0
    const xpNext = engine.xpToNext(playerStats.level ?? 1)
    const xpPct = Math.min(100, Math.max(0, xp / xpNext * 100))
    document.getElementById('hud-xp-fill').style.width = xpPct + '%'
    document.getElementById('hud-xp-text').textContent = `${xp}/${xpNext}`

    // Level
    document.getElementById('hud-level').textContent = `Lv. ${playerStats.level ?? 1}`
}

/**
 * Draw the gold coin icon onto the HUD gold canvas.
 */
function _drawGoldIcon(cv) {
    const def = _itemsDef['Gold']
    const icon = def && (def.icon || (Array.isArray(def) ? def : null))
    if (!icon || !_itemsImg) return
    const [col, row] = icon
    const cx = cv.getContext('2d')
    cx.imageSmoothingEnabled = false
    cx.clearRect(0, 0, cv.width, cv.height)
    cx.drawImage(_itemsImg,
        col * _ITEM_SIZE_HUD, row * _ITEM_SIZE_HUD, _ITEM_SIZE_HUD, _ITEM_SIZE_HUD,
        0, 0, cv.width, cv.height)
}

/**
 * Draw the player's idle sprite onto the hero icon canvas inside #hud-hero-icon.
 */
function _drawHeroIcon() {
    const btn = document.getElementById('hud-hero-icon')
    // Reuse an existing canvas or create one
    let cv = btn.querySelector('canvas')
    if (!cv) {
        cv = document.createElement('canvas')
        cv.width = 48; cv.height = 48
        btn.appendChild(cv)
    }
    const cx = cv.getContext('2d')
    cx.imageSmoothingEnabled = false
    cx.clearRect(0, 0, 48, 48)

    const sprite = playerSprites.sheet
    if (!sprite) return
    // Hero sheet cell is 64×64; scale to fit the 48×48 icon, facing down (row DIR_DOWN).
    const fw = HERO_FRAME_W, fh = HERO_FRAME_H
    const sx = 0
    const sy = (DIR_ROW[DIR_DOWN] | 0) * fh        // idle col 0, down row
    const scale = 48 / fh
    const dw = fw * scale
    const dx = (48 - dw) / 2
    cx.drawImage(sprite, sx, sy, fw, fh,
        Math.floor(dx), 0, Math.floor(dw), 48)
}

/**
 * Draw an item's icon (32×32) onto canvas `cv`. Returns true on success.
 */
function _drawItemIconCv(cv, itemId) {
    const def = _itemsDef[itemId] || _craftDef[itemId]
    const icon = def && (def.icon || (Array.isArray(def) ? def : null))
    if (!icon) return false
    const img = _itemsDef[itemId] ? _itemsImg : _craftImg
    if (!img) return false
    const [col, row] = icon
    cv.width = 32; cv.height = 32
    const cx = cv.getContext('2d')
    cx.imageSmoothingEnabled = false
    cx.drawImage(img,
        col * _ITEM_SIZE_HUD, row * _ITEM_SIZE_HUD, _ITEM_SIZE_HUD, _ITEM_SIZE_HUD,
        0, 0, 32, 32)
    return true
}

/**
 * Populate the equipment panel: body mannequin slots + the loose-items pool
 * (equipped items are shown on the body and therefore hidden from the pool).
 */
function _populateEquipmentPanel() {
    // ── Body slots ─────────────────────────────────────────────────────────
    const equipped = playerStats.equipped ?? {}
    for (const slotEl of document.querySelectorAll('#equip-body-wrap .equip-slot')) {
        const slot = slotEl.dataset.slot
        slotEl.innerHTML = ''
        const itemId = equipped[slot] || null
        if (itemId) {
            const cv = document.createElement('canvas')
            if (_drawItemIconCv(cv, itemId)) {
                slotEl.appendChild(cv)
                slotEl.dataset.item = itemId
                slotEl.title = `${slot.replace('_', ' ')}: ${itemId.replace(/_/g, ' ')}`
            } else {
                slotEl.dataset.item = ''
                slotEl.title = slot.replace('_', ' ')
            }
        } else {
            slotEl.dataset.item = ''
            slotEl.title = slot.replace('_', ' ')
        }
        _attachSlotHandlers(slotEl, slot)
    }

    // ── Loose-items pool (items not currently equipped anywhere) ──────────
    const grid = document.getElementById('equip-inv-grid')
    grid.innerHTML = ''
    const items = playerStats.items ?? {}
    const takenSlots = new Set(Object.values(equipped))
    for (const [id, qty] of Object.entries(items)) {
        if (qty <= 0) continue
        const def = _itemsDef[id] || _craftDef[id]
        if (!def) continue
        const wrapper = document.createElement('div')
        wrapper.className = 'equip-item'
        wrapper.draggable = true
        wrapper.dataset.item = id
        wrapper.title = id.replace(/_/g, ' ')

        const cv = document.createElement('canvas')
        if (!_drawItemIconCv(cv, id)) continue
        wrapper.appendChild(cv)

        if (qty > 1) {
            const badge = document.createElement('span')
            badge.className = 'equip-item-badge'
            badge.textContent = `×${qty}`
            wrapper.appendChild(badge)
        }
        _attachPoolHandlers(wrapper, id)
        grid.appendChild(wrapper)
    }

    // ── Stats column ─────────────────────────────────────────────────────
    _populateEquipStats()
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
/**
 * Build tooltip HTML for an item: human-readable name + stat modifiers.
 */
function _itemTooltipHtml(itemId) {
    const def = _itemsDef[itemId] || _craftDef[itemId]
    if (!def) return ''
    const name = (itemId || '').replace(/_/g, ' ')
    const bonusStr = _tooltipBonuses(def.bonuses)
    let html = `<div class="tt-name">${name}</div>`
    if (bonusStr) html += `<div class="tt-bonus">${bonusStr}</div>`
    return html
}

/**
 * Populate the stat column with base + bonus breakdown. Each row shows the
 * item-icon sprite for that stat (defined in index.html via data-item) plus
 * the numeric value; hovering a row reveals a tooltip naming the stat.
 */
const STAT_LABELS = {
    hp:       'HP — Health',
    base_dmg: 'DMG — Base Damage',
    attack:   'ATT — Attack',
    defense:  'DEF — Defense',
    armor:    'ARM — Armor',
    agility:  'AGI — Agility',
}

function _populateEquipStats() {
    const eqBonuses = engine.equippedBonuses?.() ?? { attack:0, defense:0, armor:0, agility:0, base_dmg:0 }
    const base = {
        hp:        [playerStats.hp ?? 0, playerStats.maxHp ?? 1],
        base_dmg:  playerStats.base_dmg ?? 0,
        attack:    playerStats.attack    ?? 0,
        defense:   playerStats.defense   ?? 0,
        armor:     playerStats.armor     ?? 0,
        agility:   playerStats.agility   ?? 0,
    }
    // Gold is now in engine inventory
    const engineState = engine.getState()
    const goldAmount = engineState.inventory?.Gold ?? 0
    playerStats.gold = goldAmount  // keep in sync

    // ── Gold display ──────────────────────────────────────────────────
    const goldVal = document.querySelector(`#equip-stats .equip-stat[data-stat="gold"] .equip-gold-val`)
    const goldIcon = document.querySelector(`#equip-stats .equip-stat[data-stat="gold"] .equip-stat-icon`)
    if (goldVal) goldVal.textContent = goldAmount
    if (goldIcon) _drawGoldIcon(goldIcon)

    // ── HP bar (fill width + numeric text overlaid on the bar) ──────────
    const [hp, maxHp] = base.hp
    const hpFill = document.getElementById('equip-hp-fill')
    if (hpFill) {
        const pct = Math.max(0, Math.min(100, hp / maxHp * 100))
        hpFill.style.width = pct + '%'
        hpFill.style.background = pct > 50 ? '#3fa84a' : pct > 25 ? '#c8a020' : '#c84040'
    }
    const hpVal = document.querySelector(`#equip-stats .equip-stat[data-stat="hp"] .equip-hp-val`)
    if (hpVal) hpVal.textContent = `${Math.max(0, hp)}/${maxHp}`

    // ── DMG (base damage, grows on level-up) + flat bonuses ─────────────
    for (const stat of ['base_dmg','attack','defense','armor','agility']) {
        const row  = document.querySelector(`#equip-stats .equip-stat[data-stat="${stat}"] .equip-stat-val`)
        if (!row) continue
        const b = base[stat]
        const bonus = eqBonuses[stat] ?? 0
        const total = b + bonus
        if (bonus) {
            row.innerHTML = `${total} <span class="bonus">(${bonus>0?'+':''}${bonus})</span>`
        } else {
            row.textContent = total
        }
    }

    // ── Stat-row icons + hover tooltips ────────────────────────────────
    for (const stat of ['hp','base_dmg','attack','defense','armor','agility']) {
        const rowEl = document.querySelector(`#equip-stats .equip-stat[data-stat="${stat}"]`)
        if (!rowEl) continue
        const iconSpan = rowEl.querySelector('.equip-stat-icon')
        if (iconSpan) {
            const itemId = rowEl.dataset.item
            if (itemId) {
                iconSpan.innerHTML = ''   // redraw (handles sprites loading late)
                const cv = document.createElement('canvas')
                if (_drawItemIconCv(cv, itemId)) {
                    iconSpan.appendChild(cv)
                }
            }
        }
        // Hover hint naming the stat (separate flow from item tooltips).
        rowEl.onmouseenter =
        rowEl.onmousemove = e => _showStatTooltip(e, STAT_LABELS[stat])
        rowEl.onmouseleave = () => _hideTooltip()
    }
}

/** Show a plain-text tooltip (used for the stat-name hints). `text` may be a
 *  single string or an array of strings rendered one per line. */
function _showStatTooltip(e, text) {
    const tt = document.getElementById('equip-tooltip')
    if (!text || (Array.isArray(text) && !text.length)) { tt.classList.add('hidden'); return }
    const lines = Array.isArray(text) ? text : [text]
    tt.innerHTML = lines.map(t => `<div class="tt-name">${t}</div>`).join('')
    tt.classList.remove('hidden')
    let x = e.clientX + 8, y = e.clientY + 8
    if (x + tt.offsetWidth  > window.innerWidth)  x = e.clientX - tt.offsetWidth - 8
    if (y + tt.offsetHeight > window.innerHeight) y = e.clientY - tt.offsetHeight - 8
    tt.style.left = x + 'px'
    tt.style.top  = y + 'px'
}

function _tooltipBonuses(bonuses) {
    const labels = { attack:'ATT', defense:'DEF', armor:'ARM', agility:'AGI' }
    const parts = []
    for (const [k, v] of Object.entries(bonuses || {})) {
        if (v && labels[k]) parts.push(`${v>0?'+':''}${v} ${labels[k]}`)
    }
    return parts.join(', ')
}

function _showTooltip(e, itemId) {
    const tt = document.getElementById('equip-tooltip')
    if (!itemId) { tt.classList.add('hidden'); return }
    const html = _itemTooltipHtml(itemId)
    if (!html) { tt.classList.add('hidden'); return }
    tt.innerHTML = html
    tt.classList.remove('hidden')
    // Position near cursor, clamped to viewport
    let x = e.clientX + 8, y = e.clientY + 8
    const r = tt.getBoundingClientRect()
    if (x + tt.offsetWidth  > window.innerWidth)  x = e.clientX - tt.offsetWidth - 8
    if (y + tt.offsetHeight > window.innerHeight) y = e.clientY - tt.offsetHeight - 8
    tt.style.left = x + 'px'
    tt.style.top  = y + 'px'
}

function _hideTooltip() {
    document.getElementById('equip-tooltip').classList.add('hidden')
}

// ─── Equip interactions (drag & drop + click-to-unequip) ─────────────────────
// Tracked drag payload: { source: 'pool'|'slot', itemId, fromSlot }
let _equipDrag = null

function _attachSlotHandlers(slotEl, slot) {
    // Tooltip
    slotEl.onmouseenter =
    slotEl.onmousemove = e => _showTooltip(e, slotEl.dataset.item || null)
    slotEl.onmouseleave = () => _hideTooltip()
    // Click an occupied slot → unequip that item back to the pool.
    slotEl.onclick = () => {
        if (slotEl.dataset.item) {
            engine.unequipItem(slot)
            _afterEquipChange()
        }
    }
    // Make an occupied slot draggable (to move between slots)
    slotEl.draggable = !!slotEl.dataset.item
    slotEl.ondragstart = e => {
        const id = slotEl.dataset.item
        if (!id) { e.preventDefault(); return }
        _equipDrag = { source: 'slot', itemId: id, fromSlot: slot }
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
    }
    slotEl.ondragend = () => { slotEl.classList.remove('drag-over'); /* reset below */ }
    slotEl.ondragover = e => {
        if (!_equipDrag) return
        // Strict type check: show drop affordance only if the item type fits this slot.
        if (_itemFitsSlot(_equipDrag.itemId, slot)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            slotEl.classList.add('drag-over')
        }
    }
    slotEl.ondragleave = () => slotEl.classList.remove('drag-over')
    slotEl.ondrop = e => {
        e.preventDefault()
        slotEl.classList.remove('drag-over')
        if (!_equipDrag) return
        if (!_itemFitsSlot(_equipDrag.itemId, slot)) return   // type mismatch → reject
        // Move from pool or another slot into this slot.
        if (_equipDrag.source === 'pool') {
            // Ensure the item is in inventory, then equip into this exact slot.
            if ((playerStats.items[_equipDrag.itemId] ?? 0) > 0) {
                // Temporarily force the slot by unequipping its current occupant.
                if (engine.getState().equipped?.[slot]) engine.unequipItem(slot)
                engine.equipItem(_equipDrag.itemId, slot)
            }
        } else if (_equipDrag.source === 'slot' && _equipDrag.fromSlot !== slot) {
            // Swap/move between two body slots. Both items are currently equipped;
            // pull them both back to the pool first, then re-place cleanly so no
            // item ends up duplicated across two slots.
            const fromS = _equipDrag.fromSlot
            const draggedId = _equipDrag.itemId
            const targetId   = engine.getState().equipped?.[slot] || null
            // Free the source slot (dragged item → pool)
            engine.unequipItem(fromS)
            // If the target slot was occupied, free it too (its item → pool)
            if (targetId) engine.unequipItem(slot)
            // Place the dragged item into the target slot, and—if there was a
            // former occupant—drop it into the now-empty source slot.
            engine.equipItem(draggedId, slot)
            if (targetId) engine.equipItem(targetId, fromS)
        }
        _equipDrag = null
        _afterEquipChange()
    }
}

function _attachPoolHandlers(wrapper, id) {
    wrapper.onmouseenter =
    wrapper.onmousemove = e => _showTooltip(e, id)
    wrapper.onmouseleave = () => _hideTooltip()
    wrapper.ondragstart = e => {
        _equipDrag = { source: 'pool', itemId: id, fromSlot: null }
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
    }
    wrapper.ondragend = () => { _equipDrag = null }
    // Dropping an equipped item onto the pool unequips it.
    wrapper.ondragover = e => {
        if (_equipDrag && _equipDrag.source === 'slot') { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
    }
    wrapper.ondrop = e => {
        e.preventDefault()
        if (_equipDrag?.source === 'slot' && _equipDrag.fromSlot) {
            engine.unequipItem(_equipDrag.fromSlot)
            _afterEquipChange()
        }
        _equipDrag = null
    }
}

/** Strict type validation: does `itemId`'s slot type match `slot`? */
function _itemFitsSlot(itemId, slot) {
    const type = (engine.itemSlotType?.(itemId)) ?? null
    if (!type) return false
    // hand items fit either hand slot; everything else only its own slot.
    return type === 'hand' ? slot === 'hand_l' || slot === 'hand_r' : slot === type
}

/** Sync state + refresh the panel after any equip/unequip change. */
function _afterEquipChange() {
    syncStatsFromEngine()
    _populateEquipmentPanel()
}

/** Toggle the equipment panel open/closed. */
function _toggleEquipmentPanel() {
    const panel = document.getElementById('equipment-panel')
    const isOpen = !panel.classList.contains('hidden')
    if (isOpen) {
        panel.classList.add('hidden')
    } else {
        syncStatsFromEngine()
        _populateEquipmentPanel()
        panel.classList.remove('hidden')
        // Wire help button (only once)
        const helpBtn = document.getElementById('equip-help-btn')
        if (helpBtn && !helpBtn._wired) {
            helpBtn._wired = true
            helpBtn.addEventListener('click', () => showLearnDialog())
        }
    }
}

/**
 * Award XP from a defeated monster and sync the HUD. Called after a won battle.
 */
async function _awardMonsterXp(type) {
    const def = _enemyDefs[type] || {}
    const xp = def.xp ?? 15
    // Preserve current HP to engine before sync so it doesn't get overwritten
    engine.getState().variables.hp = playerStats.hp
    await engine.addXp(xp)
    syncStatsFromEngine()
    updateHud()
    // If the equipment panel is open, refresh it so newly-gained stats
    // (level-up bonuses: HP, DMG, ATT, …) show immediately.
    const panel = document.getElementById('equipment-panel')
    if (panel && !panel.classList.contains('hidden')) {
        _populateEquipmentPanel()
    }
}

/**
 * Calculate damage using the BATTLE_REFERENCE formula.
 * @param {number} base_dmg - Attacker's Base Damage
 * @param {number} att - Attacker's ATT stat
 * @param {number} agi - Attacker's AGI stat (armor penetration)
 * @param {number} def - Defender's DEF stat
 * @param {number} arm - Defender's ARM stat
 * @returns {number} Final damage (minimum 1)
 */
function _calcDamage(base_dmg, att, agi, def, arm) {
    // Stat Multiplier: ATT vs DEF
    const delta = att - def
    let statMult
    if (delta >= 0) {
        statMult = 1 + (0.05 * delta)
    } else {
        statMult = Math.max(0.30, 1 - (0.025 * Math.abs(delta)))
    }
    // Armor Reduction: AGI penetrates ARM 1:1 before mitigation
    const netArm = Math.max(0, arm - agi)
    const armorReduction = Math.min(0.75, netArm * 0.05)
    const raw = base_dmg * statMult * (1 - armorReduction)
    return Math.max(1, Math.round(raw * (0.85 + Math.random() * 0.3)))  // +/-15%
}

/**
 * Run a full battle against `monster`. Returns a promise resolving to
 * { won: true } if the monster is defeated, { won: false } if the player loses.
 * Reads attack/defense/hp/xp/armor/agility from _enemyDefs[monster.type] if available.
 */
function startBattle(monster) {
    const def   = _enemyDefs[monster.type] || {}
    const MONSTER_MAX_HP   = def.hp ?? 20
    const MONSTER_ATTACK   = def.attack ?? 6
    const MONSTER_DEFENSE  = def.defense ?? 2
    const MONSTER_AGILITY  = def.agility ?? 2
    const MONSTER_ARMOR    = def.armor ?? 0
    const MONSTER_BASE_DMG = def.base_dmg ?? MONSTER_ATTACK   // fallback: use attack as base
    const MONSTER_XP       = def.xp ?? 15

    // Player effective stats: base + bonuses from ALL equipped slots
    const eqBonuses = engine.equippedBonuses?.() ?? { attack:0, defense:0, armor:0, agility:0, base_dmg:0 }
    let playerBaseDmg = (playerStats.base_dmg ?? 10) + (eqBonuses.base_dmg ?? 0)
    let playerATT  = (playerStats.attack  ?? 0)  + (eqBonuses.attack  ?? 0)
    let playerDEF  = (playerStats.defense ?? 0)  + (eqBonuses.defense ?? 0)
    let playerARM  = (playerStats.armor   ?? 0)  + (eqBonuses.armor   ?? 0)
    let playerAGI  = (playerStats.agility ?? 0)  + (eqBonuses.agility ?? 0)

    return new Promise(resolve => {
        let monsterHp = MONSTER_MAX_HP
        let playerHp  = playerStats.hp
        let currentQ  = null

        // ── Show overlay ────────────────────────────────────────────────────
        const screen = document.getElementById('battle-screen')
        document.getElementById('battle-enemy-name').textContent = monster.type
        screen.classList.remove('hidden')
        _updateBattleHpBars(playerHp, playerStats.maxHp, monsterHp, MONSTER_MAX_HP)
        _battleEnemyDef = { base_dmg: MONSTER_BASE_DMG, attack: MONSTER_ATTACK, defense: MONSTER_DEFENSE, armor: MONSTER_ARMOR, agility: MONSTER_AGILITY }
        _renderBattleStats()

        // Wire battle help button
        const battleHelpBtn = document.getElementById('battle-help-btn')
        if (battleHelpBtn && !battleHelpBtn._wired) {
            battleHelpBtn._wired = true
            battleHelpBtn.addEventListener('click', () => showLearnDialog())
        }

        // Set current battle monster for question pool selection
        _currentBattleMonster = monster

        // ── Sprite animation loop ────────────────────────────────────────────
        function drawLoop() {
            _drawBattleSprites(monster)
            _battleRafId = requestAnimationFrame(drawLoop)
        }
        _battleRafId = requestAnimationFrame(drawLoop)

        // ── Question / answer logic ──────────────────────────────────────────
        const input      = document.getElementById('battle-answer-input')
        const hint       = document.getElementById('battle-hint-text')
        const btn        = document.getElementById('battle-submit-btn')
        const qText      = document.getElementById('battle-question-text')
        const answerRow  = document.getElementById('battle-answer-row')
        const choiceRow  = document.getElementById('battle-choice-row')

        function askQuestion() {
            currentQ = _pickQuestion()
            renderQuestion(qText, currentQ.question)
            hint.textContent = ''
            hint.classList.add('hidden')

            const isChoice = !!currentQ.choices
            answerRow.classList.toggle('hidden', isChoice)
            choiceRow.classList.toggle('hidden', !isChoice)

            if (isChoice) {
                choiceRow.innerHTML = ''
                currentQ.choices.forEach(choice => {
                    const b = document.createElement('button')
                    b.className = 'battle-choice-btn'
                    renderQuestion(b, choice)
                    b.onclick = () => onSubmit(choice)
                    choiceRow.appendChild(b)
                })
            } else {
                input.value = ''
                input.focus()
            }
        }

        function endBattle(won) {
            cancelAnimationFrame(_battleRafId)
            _battleRafId = null
            _currentBattleMonster = null  // Clear for next battle
            screen.classList.add('hidden')
            btn.removeEventListener('click', onSubmit)
            document.removeEventListener('keydown', onKey, true)
            // Sync final HP: if playerStats was already set (loss fix at 1),
            // respect that; otherwise write the battle-local playerHp.
            const finalHp = won ? playerHp : playerStats.hp
            playerStats.hp = Math.max(1, finalHp)
            engine.getState().variables.hp = playerStats.hp
            resolve({ won })
        }

        function playDeathAnimation() {
            return new Promise(res => {
                const mc        = document.getElementById('battle-enemy-canvas')
                const mctx      = mc.getContext('2d')
                const resolved  = resolveEntityDef(monster.type)
                const animPhase = monster.animPhase ?? 0
                const frame     = (_monsterAnimTick() + animPhase) % 4
                const start     = performance.now()

                function draw(now) {
                    const t    = Math.min(1, (now - start) / MONSTER_DYING_MS)
                    const rise = BATTLE_SPRITE_Y * t        // 0 → 32 pixels upward

                    mctx.clearRect(0, 0, 64, 96)
                    mctx.imageSmoothingEnabled = false
                    mctx.globalAlpha = 1 - t                 // fade out

                    if (resolved.composite) {
                        _drawCompositeEnemy(resolved.def, mctx, frame, 2,
                            32, BATTLE_SPRITE_Y + 32 - rise, true)
                    } else {
                        const sprite = _getEntityImg(monster.type)
                        if (sprite) {
                            const { frameW, frameH } = resolved
                            mctx.save()
                            mctx.translate(64, BATTLE_SPRITE_Y - rise)
                            mctx.scale(-1, 1)
                            mctx.drawImage(sprite, frame * frameW, 0, frameW, frameH, 0, 0, 64, 64)
                            mctx.restore()
                        }
                    }

                    mctx.globalAlpha = 1

                    if (t < 1) requestAnimationFrame(draw)
                    else res()
                }
                requestAnimationFrame(draw)
            })
        }

        async function onSubmit(choiceOverride) {
            const given    = _normalizeAnswer(typeof choiceOverride === 'string' ? choiceOverride : input.value)
            const correct  = currentQ.answers.some(a => _normalizeAnswer(a) === given)

            if (correct) {
                // Player hits: use full damage formula (BATTLE_REFERENCE)
                const dmg = _calcDamage(playerBaseDmg, playerATT, playerAGI, MONSTER_DEFENSE, MONSTER_ARMOR)
                monsterHp -= dmg
                _updateBattleHpBars(playerHp, playerStats.maxHp, monsterHp, MONSTER_MAX_HP)
                if (monsterHp <= 0) {
                    btn.disabled = input.disabled = true
                    for (const b of choiceRow.querySelectorAll('.battle-choice-btn')) b.disabled = true
                    cancelAnimationFrame(_battleRafId)
                    _battleRafId = null
                    await playDeathAnimation()
                    btn.disabled = input.disabled = false
                    for (const b of choiceRow.querySelectorAll('.battle-choice-btn')) b.disabled = false
                    endBattle(true)
                    return
                }
                askQuestion()
            } else {
                // Monster hits: use full damage formula (BATTLE_REFERENCE)
                const dmg = _calcDamage(MONSTER_BASE_DMG, MONSTER_ATTACK, MONSTER_AGILITY, playerDEF, playerARM)
                playerHp -= dmg

                _updateBattleHpBars(playerHp, playerStats.maxHp, monsterHp, MONSTER_MAX_HP)
                renderQuestion(hint, currentQ.hint ?? '')
                hint.classList.toggle('hidden', !currentQ.hint)
                if (playerHp <= 0) {
                    playerStats.hp = 1
                    endBattle(false)
                    return
                }
                input.value = ''
                input.focus()
            }
        }

        function onKey(e) {
            if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !currentQ?.choices) { e.preventDefault(); e.stopPropagation(); onSubmit() }
        }

        btn.addEventListener('click', onSubmit)
        document.addEventListener('keydown', onKey, true)

        askQuestion()
    })
}

// ─── Toast message ───────────────────────────────────────────────────────────
let _toastTimer = null
function _renderMessageIcons(items) {
    const container = document.getElementById('toast-icons')
    container.innerHTML = ''
    if (!items) { container.classList.add('hidden'); return }
    container.classList.remove('hidden')
    const list = Array.isArray(items) ? items : [items]
    for (const item of list) {
        // Support both string (id) and object ({ id, qty }) formats
        const id = item.id ?? item
        const qty = item.qty ?? 1
        let img, col, rowIdx
        if (_itemsDef[id]) {
            const def = _itemsDef[id]
            ;[col, rowIdx] = def.icon; img = _itemsImg
        } else if (_craftDef[id]) {
            [col, rowIdx] = _craftDef[id]; img = _craftImg
        } else {
            continue
        }
        const wrapper = document.createElement('div')
        wrapper.style.position = 'relative'
        wrapper.style.display = 'inline-block'
        const cv = document.createElement('canvas')
        cv.width = cv.height = ITEM_SIZE
        cv.title = id.replace(/_/g, ' ')
        const cx = cv.getContext('2d')
        cx.imageSmoothingEnabled = false
        cx.drawImage(img,
            col * ITEM_SIZE, rowIdx * ITEM_SIZE, ITEM_SIZE, ITEM_SIZE,
            0, 0, ITEM_SIZE, ITEM_SIZE)
        wrapper.appendChild(cv)
        if (qty > 1) {
            const badge = document.createElement('span')
            badge.className = 'toast-item-badge'
            badge.textContent = `×${qty}`
            wrapper.appendChild(badge)
        }
        container.appendChild(wrapper)
    }
}

function showMessage(text, duration = 3000, items = null) {
    const el = document.getElementById('toast-message')
    document.getElementById('toast-text').textContent = text
    el.style.opacity = '1'
    el.classList.remove('hidden')
    if (_toastTimer) clearTimeout(_toastTimer)
    _renderMessageIcons(items)
    _toastTimer = setTimeout(() => {
        el.style.opacity = '0'
        setTimeout(() => el.classList.add('hidden'), 400)
        _toastTimer = null
    }, duration)
}

// ─── Choice hook ─────────────────────────────────────────────────────────────
function showChoice(text, choices) {
    return new Promise(resolve => {
        const box  = document.getElementById('choice-box')
        const btns = document.getElementById('choice-buttons')
        document.getElementById('choice-text').textContent = text
        btns.innerHTML = ''

        choices.forEach((c, i) => {
            const btn = document.createElement('button')
            btn.className = 'choice-btn'
            btn.innerHTML = `<span class="choice-key">${i + 1}.</span> ${c.label}`
            btn.addEventListener('click', () => pick(i), { once: true })
            btns.appendChild(btn)
        })

        _flushMovementKeys()              // drop held direction keys so they don't fire on close
        box.classList.remove('hidden')

        function pick(idx) {
            box.classList.add('hidden')
            document.removeEventListener('keydown', onKey, true)
            resolve(idx)
        }

        function onKey(e) {
            const n = parseInt(e.key)
            if (!isNaN(n) && n >= 1 && n <= choices.length) {
                e.preventDefault(); e.stopPropagation(); pick(n - 1)
            }
        }
        document.addEventListener('keydown', onKey, true)
    })
}

/**
 * Custom centered Level-Up overlay. Each choice is rendered as one or two
 * item-icon sprites (with a ×2 badge when a stat is doubled) plus the +value.
 * Returns the chosen index to the engine.
 */
function showLevelUp(choices) {
    return new Promise(resolve => {
        const box   = document.getElementById('levelup-box')
        const btns  = document.getElementById('levelup-buttons')
        btns.innerHTML = ''

        choices.forEach((c, i) => {
            const btn = document.createElement('button')
            btn.className = 'levelup-btn'
            const vals = document.createElement('div')
            vals.className = 'levelup-btn-vals'
            for (const ico of (c.icons || [])) {
                // One stat per column: sprite above, the +number below.
                // A single-word tooltip on the sprite names the stat.
                const stat = document.createElement('div')
                stat.className = 'lv-stat'
                stat.title = ico.name
                const cv = document.createElement('canvas')
                cv.width = 32; cv.height = 32
                if (_drawItemIconCv(cv, ico.icon)) stat.appendChild(cv)
                const v = document.createElement('span')
                v.className = 'lv-num'
                v.textContent = ico.val
                stat.appendChild(v)
                vals.appendChild(stat)
            }
            btn.appendChild(vals)
            const key = document.createElement('div')
            key.className = 'levelup-key'
            key.textContent = `[${i + 1}]`
            btn.appendChild(key)
            btn.addEventListener('click', () => pick(i), { once: true })
            btns.appendChild(btn)
        })

        _flushMovementKeys()
        box.classList.remove('hidden')

        function pick(idx) {
            box.classList.add('hidden')
            document.removeEventListener('keydown', onKey, true)
            resolve(idx)
        }

        function onKey(e) {
            const n = parseInt(e.key)
            if (!isNaN(n) && n >= 1 && n <= choices.length) {
                e.preventDefault(); e.stopPropagation(); pick(n - 1)
            }
        }
        document.addEventListener('keydown', onKey, true)
    })
}

// ─── Dialog hook ─────────────────────────────────────────────────────────────
function _renderItemIcons(items) {
    const row = document.getElementById('dialog-icons')
    row.innerHTML = ''
    // Accept either an array of ids, or an object map { id: qty }.
    let list = []   // entries as [id, qty] (qty null/undefined = no badge)
    if (Array.isArray(items)) {
        list = items.map(id => [id, null])
    } else if (items && typeof items === 'object') {
        list = Object.entries(items).map(([id, qty]) => [id, Number(qty) || null])
    }
    // Find IDs that exist in either registry with their image loaded
    const valid = list.filter(([id]) =>
        (_itemsDef[id] && _itemsImg) || (_craftDef[id] && _craftImg))
    if (!valid.length) { row.classList.add('hidden'); return }
    row.classList.remove('hidden')
    for (const [id, qty] of valid) {
        let img, col, rowIdx
        if (_itemsDef[id]) {
            const def = _itemsDef[id]
            ;[col, rowIdx] = def.icon; img = _itemsImg
        } else {
            [col, rowIdx] = _craftDef[id]; img = _craftImg
        }
        const wrap = document.createElement('div')
        wrap.className = 'dialog-item'
        wrap.title = id.replace(/_/g, ' ')
        const cv = document.createElement('canvas')
        cv.width = ITEM_SIZE
        cv.height = ITEM_SIZE
        const cx = cv.getContext('2d')
        cx.imageSmoothingEnabled = false
        cx.drawImage(img,
            col * ITEM_SIZE, rowIdx * ITEM_SIZE, ITEM_SIZE, ITEM_SIZE,
            0, 0, ITEM_SIZE, ITEM_SIZE)
        wrap.appendChild(cv)
        if (qty && qty > 1) {
            const badge = document.createElement('span')
            badge.className = 'dialog-item-badge'
            badge.textContent = `×${qty}`
            wrap.appendChild(badge)
        }
        row.appendChild(wrap)
    }
}

function showDialog(text, speaker, items) {
    return new Promise(resolve => {
        const box = document.getElementById('dialog-box')
        const speakerEl = document.getElementById('dialog-speaker')
        speakerEl.textContent = speaker ?? ''
        document.getElementById('dialog-text').textContent = text
        _renderItemIcons(items ?? [])
        _flushMovementKeys()              // drop held direction keys so they don't fire on close
        box.classList.remove('hidden')

        function onKey(e) {
            if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault()
                e.stopPropagation()
                box.classList.add('hidden')
                document.removeEventListener('keydown', onKey, true)
                resolve()
            }
        }
        document.addEventListener('keydown', onKey, true)   // capture phase — runs before game handler
    })
}

// ─── Map loader (used by init and change_map action) ─────────────────────────
async function loadAndEnterMap(mapId, startX, startY, mark) {
    document.getElementById('loading').classList.remove('hidden')

    // ── Save current map state before switching ────────────────────────────
    if (_currentMapId !== null) {
        _mapEntities.set(_currentMapId, { monsters: [...monsters], npcs: [...npcs] })
        _mapCache.set(_currentMapId, map)
    }

    // ── Load or restore map ───────────────────────────────────────────────────
    let mapMarks
    if (_mapCache.has(mapId)) {
        // Returning to a visited map — use the live object (preserves runtime changes)
        map      = _mapCache.get(mapId)
        // map._marks is an object { "x,y": name }, convert to array for engine.setMapMarks
        mapMarks = Object.entries(map._marks ?? {}).map(([k, v]) => {
            const [x, y] = k.split(',').map(Number)
            return { x, y, name: v }
        })
        const tilesetId = map._tilesetId ?? 'world'
        if (tilesetId !== _currentTilesetId) {
            const cached = _tilesetCache.get(tilesetId)  // always present — was loaded on first visit
            tileset       = cached.tileset
            _waterAtlas   = cached.waterAtlas
            waterFrameMap = cached.waterFrameMap
            _currentTilesetId = tilesetId
            tileCache.clear()
        }
    } else {
        // First visit — fetch JSON and build map
        const mapRes  = await fetch(`../scenarios/${_currentScenarioId}/maps/${mapId}.json`)
        if (!mapRes.ok) throw new Error(`Map not found: ${mapId}`)
        const mapData = await mapRes.json()
        mapMarks = mapData.marks ?? []
        const tilesetId = mapData.tileset ?? 'world'
        if (tilesetId !== _currentTilesetId) {
            if (_tilesetCache.has(tilesetId)) {
                const cached = _tilesetCache.get(tilesetId)
                tileset       = cached.tileset
                _waterAtlas   = cached.waterAtlas
                waterFrameMap = cached.waterFrameMap
            } else {
                tileset = await loadTileset(`../tilesets/${tilesetId}/tileset.json`)
                if (tileset.waterTerrain) buildWaterFrames()
                else { _waterAtlas = null; waterFrameMap = null }
                _tilesetCache.set(tilesetId, { tileset, waterAtlas: _waterAtlas, waterFrameMap })
            }
            _currentTilesetId = tilesetId
            tileCache.clear()
        }
        map = deserializeMap(mapData, tileset)
        map._marks     = mapMarks   // stash for restoration without re-fetching
        map._tilesetId = tilesetId
        buildBlockedMap()
    }

    // Rebuild blocked map (separate array — not stored in map object)
    buildBlockedMap()

    // Register marks with engine
    engine.setMapMarks(mapMarks)

    // Resolve named mark to coordinates
    if (mark && mapMarks.length) {
        const m = mapMarks.find(m => m.name.toLowerCase() === mark.toLowerCase())
        if (m) { startX = m.x; startY = m.y }
    }

    // ── Invalidate render caches so they rebuild for the new map ─────────────
    _terrainCanvas = null
    _waterCanvas   = null
    // NOTE: _waterMask / _waterPhase are rebuilt by buildBlockedMap() (called above),
    // so they must NOT be nulled here or rendering crashes on first frame.
    _decoUnder     = null;  _decoOver = null;  _decoShadow = null
    _decoCachedTileX = -1;  _decoCachedTileY    = -1
    _decoCachedWindTick = -1; _decoCachedEffectTick = -1

    // ── Restore or reset entities ─────────────────────────────────────────────
    const savedEntities = _mapEntities.get(mapId)
    if (savedEntities) {
        monsters = savedEntities.monsters
        npcs     = savedEntities.npcs
    } else {
        monsters = []
        npcs     = []
    }
    _currentMapId = mapId

    // Place player at requested position or fall back to first non-blocked tile
    let placed = false
    if (startX !== undefined && startY !== undefined && !blocked[startY]?.[startX]) {
        player.tileX = player.fromX = player.toX = startX
        player.tileY = player.fromY = player.toY = startY
        placed = true
    }
    if (!placed) {
        outer: for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                if (!blocked[y][x]) {
                    player.tileX = player.fromX = player.toX = x
                    player.tileY = player.fromY = player.toY = y
                    break outer
                }
            }
        }
    }
    player.px       = player.tileX * TILE + TILE / 2
    player.py       = player.tileY * TILE + TILE / 2
    player.progress = 1.0
    _pendingTileEnter = null

    document.getElementById('loading').classList.add('hidden')
}

// ─── Question browser (Ctrl+Q) ────────────────────────────────────────────────────────────
function _openQuestionBrowser() {
    const PAGE_SIZE = 100
    const overlay   = document.getElementById('q-browser')
    const list      = document.getElementById('q-browser-list')
    const select    = document.getElementById('q-pool-select')
    const filterEl  = document.getElementById('q-filter')
    const countEl   = document.getElementById('q-browser-count')
    const prevBtn   = document.getElementById('q-page-prev')
    const nextBtn   = document.getElementById('q-page-next')
    const pageLabel = document.getElementById('q-page-label')

    let currentPage = 0

    // Populate pool selector from available pools in _questions
    const pools = [...new Set(_questions.map(q => q.pool ?? 1))].sort((a, b) => a - b)
    select.innerHTML = '<option value="all">All pools</option>'
    pools.forEach(p => {
        const opt = document.createElement('option')
        opt.value = p; opt.textContent = `Pool ${p}`
        select.appendChild(opt)
    })

    function getFiltered() {
        const chosen = select.value
        const needle = filterEl.value.trim().toLowerCase()
        let qs = chosen === 'all' ? _questions : _questions.filter(q => String(q.pool ?? 1) === chosen)
        if (needle) qs = qs.filter(q =>
            q.question.toLowerCase().includes(needle) ||
            q.answers.some(a => a.toLowerCase().includes(needle)) ||
            (q.hint && q.hint.toLowerCase().includes(needle))
        )
        return qs
    }

    function renderList() {
        const qs        = getFiltered()
        const totalPages = Math.max(1, Math.ceil(qs.length / PAGE_SIZE))
        if (currentPage >= totalPages) currentPage = totalPages - 1
        const page = qs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

        countEl.textContent = `${qs.length} question${qs.length !== 1 ? 's' : ''}`
        pageLabel.textContent = totalPages > 1 ? `Page ${currentPage + 1} / ${totalPages}` : ''
        prevBtn.disabled = currentPage === 0
        nextBtn.disabled = currentPage >= totalPages - 1

        list.innerHTML = ''
        const globalOffset = currentPage * PAGE_SIZE
        page.forEach((q, i) => {
            const card = document.createElement('div')
            card.className = 'q-card'

            const meta = document.createElement('div')
            meta.className = 'q-card-meta'
            meta.innerHTML = `<span>#${globalOffset + i + 1}</span><span>Pool ${q.pool ?? 1}</span>${q.choices ? '<span>choice</span>' : ''}`
            card.appendChild(meta)

            const qEl = document.createElement('div')
            qEl.className = 'q-card-question'
            renderQuestion(qEl, q.question)
            card.appendChild(qEl)

            const answersEl = document.createElement('div')
            if (q.choices) {
                answersEl.className = 'q-card-choices'
                const correctSet = new Set(q.answers.map(a => _normalizeAnswer(a)))
                for (const choice of q.choices) {
                    const tag = document.createElement('span')
                    tag.className = 'q-card-choice' + (correctSet.has(_normalizeAnswer(choice)) ? ' correct' : '')
                    renderQuestion(tag, choice)
                    answersEl.appendChild(tag)
                }
            } else {
                answersEl.className = 'q-card-answers'
                for (const a of q.answers) {
                    const tag = document.createElement('span')
                    tag.className = 'q-card-answer'
                    tag.textContent = a
                    answersEl.appendChild(tag)
                }
            }
            card.appendChild(answersEl)

            if (q.hint) {
                const hintEl = document.createElement('div')
                hintEl.className = 'q-card-hint'
                renderQuestion(hintEl, q.hint)
                card.appendChild(hintEl)
            }

            // Add help button if learning doc is available for this pool
            const cat = _currentCategory ?? 'default'
            const learnKey = `${cat}:${q.pool ?? 1}`
            if (_learnRegistry.has(learnKey) || _learnRegistry.has(cat)) {
                const helpBtn = document.createElement('button')
                helpBtn.className = 'q-card-help'
                helpBtn.textContent = '?'
                helpBtn.title = 'Pomoc do tego tematu'
                helpBtn.onclick = (e) => {
                    e.stopPropagation()
                    _closeQuestionBrowser()
                    // Small delay to let browser close
                    setTimeout(() => showLearnDialog(learnKey), 50)
                }
                meta.appendChild(helpBtn)
            }

            list.appendChild(card)
        })
        list.scrollTop = 0
    }

    select.onchange = () => { currentPage = 0; renderList() }
    filterEl.oninput = () => { currentPage = 0; renderList() }
    prevBtn.onclick = () => { currentPage--; renderList() }
    nextBtn.onclick = () => { currentPage++; renderList() }

    // Reset state on open
    filterEl.value = ''
    select.value = 'all'
    currentPage = 0
    renderList()
    overlay.classList.remove('hidden')
    filterEl.focus()

    function onKey(e) {
        if (e.code === 'Escape' || (e.ctrlKey && e.code === 'KeyQ')) {
            e.preventDefault(); e.stopPropagation()
            _closeQuestionBrowser()
        }
    }
    document.addEventListener('keydown', onKey, true)
    overlay._onKey = onKey

    document.getElementById('q-browser-close').onclick = _closeQuestionBrowser
    overlay.onclick = e => { if (e.target === overlay) _closeQuestionBrowser() }
}

function _closeQuestionBrowser() {
    const overlay = document.getElementById('q-browser')
    overlay.classList.add('hidden')
    if (overlay._onKey) {
        document.removeEventListener('keydown', overlay._onKey, true)
        overlay._onKey = null
    }
}

function _toggleQuestionBrowser() {
    const overlay = document.getElementById('q-browser')
    if (overlay.classList.contains('hidden')) _openQuestionBrowser()
    else _closeQuestionBrowser()
}

// ─── Cheat console (Ctrl+X) ────────────────────────────────────────────────────
// Quick tester for hard-to-reach game state. Accepts one line per Enter:
//   item <id> [n]      — grant item (auto-equipped if equippable)
//   xp <n>             — award n XP (may trigger level-up dialog)
//   att|def|arm|agi|dmg|hp <n>  — +stat
// Runs through engine exports so the HUD/equipment panel refresh normally.
function _toggleCheatConsole() {
    const box    = document.getElementById('cheat-box')
    const input  = document.getElementById('cheat-input')
    const fb     = document.getElementById('cheat-feedback')
    if (!box || !engine) return

    if (box.classList.contains('hidden')) {
        fb.textContent = ''
        fb.classList.remove('err')
        box.classList.remove('hidden')
        input.value = ''
        input.focus()
        input.onkeydown = async (e) => {
            if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
            e.preventDefault(); e.stopPropagation()
            const line = input.value.trim()
            if (!line) return
            try {
                const msg = await engine.runCheat(line)
                // Sync engine state → playerStats + HUD; refresh panel if open.
                syncStatsFromEngine()
                updateHud()
                const panel = document.getElementById('equipment-panel')
                if (panel && !panel.classList.contains('hidden')) _populateEquipmentPanel()
                fb.classList.remove('err')
                if (msg && msg.startsWith('unknown')) { fb.classList.add('err'); fb.textContent = msg }
                else fb.textContent = msg ? `✓ ${msg}` : ''
                input.value = ''
            } catch (err) {
                console.warn('[Cheat]', err)
                fb.classList.add('err')
                fb.textContent = `✗ ${err.message}`
            }
        }
        // Close on Escape without running.
        input.onkeyup = (e) => { if (e.code === 'Escape') _toggleCheatConsole() }
    } else {
        box.classList.add('hidden')
        input.onkeydown = null
        input.onkeyup = null
        input.blur()
    }
}

/**
 * Show the scenario selection screen and resolve with the chosen folder id.
 * `scenariosIndex` is the object from scenarios.json: { folderId: { name, help } }.
 * Two-step: pick a scenario, then (if it has questionCategories) pick a category.
 * The picker is keyboard-navigable: number keys 1–9 select a scenario or category.
 * Resolves with { scenarioId, category } where category is null for legacy
 * scenarios that have no questionCategories (flat questions/poolN.json).
 */
function showScenarioSelect(scenariosIndex) {
    return new Promise(resolve => {
        const overlay     = document.getElementById('scenario-select')
        const listEl      = document.getElementById('scenario-select-list')
        const catBox      = document.getElementById('category-select')
        const catListEl   = document.getElementById('category-select-list')

        // Preserve insertion order from the JSON file.
        const entries = Object.entries(scenariosIndex)
        listEl.innerHTML = ''
        catBox.classList.add('hidden')
        catListEl.innerHTML = ''

        let scenarioHandler = null   // keydown handler for the scenario step
        let categoryHandler = null   // keydown handler for the category step
        let chosenScenarioId = null

        // Resolve the whole flow once a category (or legacy null) is chosen.
        const finish = (category) => {
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)
            if (categoryHandler) document.removeEventListener('keydown', categoryHandler)
            overlay.classList.add('hidden')
            resolve({ scenarioId: chosenScenarioId, category })
        }

        // Build category buttons from a scenario's questionCategories map.
        // `categories` is { folderKey: { name, pools } } in insertion order.
        const showCategoryStep = (categories) => {
            const catEntries = Object.entries(categories)
            if (!catEntries.length) { finish(null); return }

            catListEl.innerHTML = ''
            // Re-arm 1–9 for the category step now that the scenario step is done.
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)
            categoryHandler = (ev) => {
                if (ev.key < '1' || ev.key > '9') return
                const idx = parseInt(ev.key, 10) - 1
                if (idx >= 0 && idx < catEntries.length) catPick(idx)
            }

            const catPick = (idx) => finish(catEntries[idx][0])

            catEntries.forEach(([key, meta], idx) => {
                const btn = document.createElement('button')
                btn.className = 'category-select-btn'
                btn.type = 'button'
                btn.innerHTML =
                    `<span class="scenario-select-key">${idx + 1}</span>` +
                    `<span class="scenario-select-body">` +
                      `<span class="scenario-select-name">${meta?.name ?? key}</span>` +
                    `</span>`
                btn.addEventListener('click', () => catPick(idx))
                catListEl.appendChild(btn)
            })

            catBox.classList.remove('hidden')
            document.addEventListener('keydown', categoryHandler)
        }

        // After a scenario is chosen, load its scenario.json to read categories.
        const pickScenario = async (idx) => {
            chosenScenarioId = entries[idx][0]
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)

            let categories = null
            try {
                const res = await fetch(`../scenarios/${chosenScenarioId}/scenario.json`)
                if (res.ok) {
                    const s = await res.json()
                    if (s.questionCategories && typeof s.questionCategories === 'object') {
                        categories = s.questionCategories
                    }
                }
            } catch { /* fall through: no categories */ }

            // Legacy scenarios (no questionCategories) load flat poolN.json.
            if (!categories) { finish(null); return }

            showCategoryStep(categories)
        }

        scenarioHandler = (ev) => {
            if (ev.key < '1' || ev.key > '9') return
            const idx = parseInt(ev.key, 10) - 1
            if (idx >= 0 && idx < entries.length) pickScenario(idx)
        }

        entries.forEach(([id, meta], idx) => {
            const btn = document.createElement('button')
            btn.className = 'scenario-select-btn'
            btn.type = 'button'
            btn.innerHTML =
                `<span class="scenario-select-key">${idx + 1}</span>` +
                `<span class="scenario-select-body">` +
                  `<span class="scenario-select-name">${meta?.name ?? id}</span>` +
                  (meta?.help ? `<span class="scenario-select-help">${meta.help}</span>` : '') +
                `</span>`
            btn.addEventListener('click', () => pickScenario(idx))
            listEl.appendChild(btn)
        })

        document.addEventListener('keydown', scenarioHandler)
        overlay.classList.remove('hidden')
    })
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
    const _t0 = performance.now()
    const _ms = t => `${(performance.now() - t).toFixed(0)}ms`
    // ── Hooks registered synchronously — no awaits needed ────────────────────
    engine.setHooks({
        showDialog,
        showChoice,
        showMessage,
        // Inventory changed (give_item, remove_item, equip/unequip) — refresh
        // the equipment panel if it's currently open.
        onInventoryChange: () => {
            const panel = document.getElementById('equipment-panel')
            if (panel && !panel.classList.contains('hidden')) {
                syncStatsFromEngine()
            }
        },
        showLevelUp: async (choices) => {
            const idx = await showLevelUp(choices)
            return idx
        },
        spawnMonster: (type, opts) => spawnMonster(type, opts),
        spawnNpc:     (sprite, x, y, opts) => spawnNpc(sprite, x, y, opts),

        // Place (or replace) a decoration on the current map. Mirrors the editor's
        // placeDecoration so the object matches what deserializeMap/render expect.
        // jitter=0, flipLocked → a stable, centered spawn (no random drift).
        spawnDecoration: (x, y, assetId) => {
            if (!map || x == null || y == null) return
            placeDecoration(map, assetId, x, y, 0, undefined, false, 1.0, 1.0)
            _invalidateDecoCache()
            buildBlockedMap()  // apply the new decoration's traversable mask to the blocked grid
            console.log(`[ECA] spawn_decoration: ${assetId} @ (${x}, ${y})`)
            // Record for save/load replay
            if (!_mapChanges.has(_currentMapId)) _mapChanges.set(_currentMapId, [])
            _mapChanges.get(_currentMapId).push({ action: 'spawn_decoration', x, y, assetId })
        },

        // Spawn an item on the current map at the given tile. Items are stored in
        // map._items[y][x] = { itemId, qty }. They render like decorations and are
        // collected when the player enters the tile.
        spawnItem: (x, y, itemId, qty = 1) => {
            if (!map || x == null || y == null) return
            // Initialize _items layer if not present
            if (!map._items) map._items = []
            if (!map._items[y]) map._items[y] = []
            // If item already exists at this position, increment qty
            if (map._items[y][x]) {
                map._items[y][x].qty += qty
            } else {
                map._items[y][x] = { itemId, qty }
            }
            _invalidateDecoCache()  // Re-render to show the new item
            console.log(`[ECA] spawn_item: ${itemId} x${qty} @ (${x}, ${y})`)
            // Record for save/load replay
            if (!_mapChanges.has(_currentMapId)) _mapChanges.set(_currentMapId, [])
            _mapChanges.get(_currentMapId).push({ action: 'spawn_item', x, y, itemId, qty })
        },

        // Remove a decoration at a tile (no-op if the cell is empty).
        removeDecoration: (x, y) => {
            if (!map || x == null || y == null) return
            removeMapDecoration(map, x, y)
            _invalidateDecoCache()
            buildBlockedMap()  // drop the removed decoration's traversable mask from the blocked grid
            console.log(`[ECA] remove_decoration @ (${x}, ${y})`)
            // Record for save/load replay
            if (!_mapChanges.has(_currentMapId)) _mapChanges.set(_currentMapId, [])
            _mapChanges.get(_currentMapId).push({ action: 'remove_decoration', x, y })
        },

        // Replace one tile's terrain on the current map (water→grass, sand→water, …).
        // `terrain` may be a numeric id or a terrain name string; names resolve against
        // the current tileset. Performed in-engine so terrain-id resolution stays on
        // the game side (the engine doesn't own the tileset). Three caches depend on
        // terrain — tileCache (baked 2×2-corner canvases), _terrainCanvas (composited
        // viewport layer), and the blocked grid + water masks — all rebuilt here.
        changeTile: (x, y, terrainRaw) => {
            if (!map || x == null || y == null) return
            const terrainId = _resolveTerrainId(terrainRaw)
            if (terrainId == null) return
            setCell(map, x, y, terrainId)
            // Forced rebuild — the player hasn't moved, so the scroll-margin rebuild
            // in renderTerrain wouldn't trigger on its own.
            tileCache.clear()
            _terrainCanvas = null
            buildBlockedMap()  // blocked grid + _waterMask/_waterPhase
            console.log(`[ECA] change_tile @ (${x}, ${y}) → ${terrainRaw} (id ${terrainId})`)
            // Record for save/load replay (store raw terrain value for replay)
            if (!_mapChanges.has(_currentMapId)) _mapChanges.set(_currentMapId, [])
            _mapChanges.get(_currentMapId).push({ action: 'change_tile', x, y, terrain: terrainRaw })
        },
        startCombat: async (enemyType) => {
            const virtualMonster = { type: enemyType, tileX: -1, tileY: -1, flipX: Math.random() < 0.5 }
            const { won } = await startBattle(virtualMonster)
            if (!won) {
                await showDialog('Zostałeś pokonany… Ledwo uszedłeś z życiem.')
                return { blocked: true }
            }
            // start_combat kills also count (no tile — virtual monster is off-map).
            engine.recordMonsterDefeat(enemyType)
            // Award XP for script-triggered combat
            await _awardMonsterXp(enemyType)
            return {}
        },
        changeMap: async (mapId, x, y, mark) => {
            await loadAndEnterMap(mapId, x, y, mark)
            await engine.fireEvent('map_enter', { map_id: mapId })
        },
        show_help: async (action) => {
            // action: { key?: string, pool?: number, category?: string, topic?: string }
            // key takes priority (e.g., "math:2"), otherwise build from category + pool
            let key = action.key
            if (!key) {
                const cat = action.category ?? _currentCategory ?? 'default'
                if (action.pool != null) key = `${cat}:${action.pool}`
                else key = cat
            }
            await showLearnDialog(key)
            return {}
        },
    })

    // ── Phase 1: everything independent loads in parallel ────────────────────
    const _tPhase1 = performance.now()
    const [{ assetMap: am }, scenariosIndex] = await Promise.all([
        // Assets (needed by buildBlockedMap inside loadAndEnterMap)
        loadAssets('../assets/'),

        // Scenario list index (purely network). The actual scenario is loaded
        // after the user picks one from the selection screen, below Phase 2.
        engine.loadScenarioList('../scenarios'),

        // Tileset chain: registry → tileset → buildWaterFrames (CPU after network)
        loadTilesetRegistry().then(async registry => {
            const entry = registry.find(t => t.id === 'world') ?? registry[0]
            const _tTs = performance.now()
            const ts    = await loadTileset(`../tilesets/${entry.id}/tileset.json`)
            console.log(`[Load] tileset: ${_ms(_tTs)}`)
            tileset           = ts
            _currentTilesetId = entry.id
            if (ts.waterTerrain) {
                const _tWf = performance.now()
                // Use pre-baked atlas if available (generated by Tools/WaterAtlasBaker.html).
                // Falls back to runtime generation if the file is missing.
                const atlasUrl = `../tilesets/shared/water-atlas.png`
                const prebuilt = await fetch(atlasUrl, { method: 'HEAD' })
                    .then(r => r.ok).catch(() => false)
                if (prebuilt) {
                    const atlasImg = await loadImage(atlasUrl)
                    _waterAtlas = document.createElement('canvas')
                    _waterAtlas.width  = atlasImg.naturalWidth
                    _waterAtlas.height = atlasImg.naturalHeight
                    _waterAtlas.getContext('2d').drawImage(atlasImg, 0, 0)
                    // Reconstruct waterFrameMap metadata (frame positions in atlas — no pixel data needed)
                    waterFrameMap = new Map()
                    for (let m = 1; m <= 15; m++) waterFrameMap.set(m, null)  // sentinel: atlas-backed
                    console.log(`[Load] waterAtlas (pre-baked): ${_ms(_tWf)}`)
                } else {
                    buildWaterFrames()
                    console.log(`[Load] buildWaterFrames (runtime): ${_ms(_tWf)}`)
                }
            }
            _tilesetCache.set(entry.id, { tileset: ts, waterAtlas: _waterAtlas, waterFrameMap })
        }),

        // Items spritesheet + registry
        fetch('../assets/items.json').then(r => r.json()).then(async data => {
            // Normalize items: [col, row] shorthand → { icon, type, bonuses }
            _itemsDef = {}
            for (const [id, raw] of Object.entries(data.items ?? {})) {
                _itemsDef[id] = Array.isArray(raw)
                    ? { icon: raw, type: 'material', bonuses: {} }
                    : { icon: raw.icon, type: raw.type ?? 'material', bonuses: raw.bonuses ?? {}, ...(raw.light ? { light: raw.light } : {}) }
            }
            _craftDef = data.crafting || {}
            _itemsImg = await loadImage('../assets/items.png')
            _craftImg = await loadImage('../assets/crafting.png')
            // Register item defs with the engine so auto-equip / bonus logic knows
            // each item's slot type and bonuses.
            if (engine.setItemDefs) engine.setItemDefs(_itemsDef)
        }).catch(e => console.warn('[Items]', e)),

        // Hero character sprites (default Tom is loaded eagerly; the active
        // scenario may swap to Mark/George via scenario.json's "hero" field —
        // see loadHeroSprite(), called once the scenario is known).
        loadImage('../characters/Hero_Tom.png').then(img => {
            playerSprites.sheet = img
            playerSprites.heroName = 'Tom'
            playerSprites.cols = img.naturalWidth / HERO_FRAME_W | 0
            _bakePlayerShadowSheet()
            _drawHeroIcon()
            console.log('[Player] Hero sprite loaded: Tom')
        }).catch(e => console.warn('[Player] Hero_Tom.png not found:', e.message)),

        // Effect sprites — load the shared 32×32 sheet once and point every
        // entry that uses it at the same Image (one request instead of N);
        // fire_big keeps its own standalone sheet.
        loadImage(EFFECT_SHEET_SRC).then(img => {
            EFFECT_SHEET.img = img
            for (const def of Object.values(EFFECT_DEFS)) {
                if (def.sheet === EFFECT_SHEET) def.img = img
            }
        }).catch(() => { /* optional effect */ }),
        Promise.all(Object.values(EFFECT_DEFS)
            .filter(def => def.src)
            .map(async def => {
                try { def.img = await loadImage(def.src) } catch { /* optional */ }
            })),

        // Enemy definitions first (needed to know which sprites to load)
        fetch('../characters/enemies.json').then(r => r.json()).then(arr => {
            for (const def of arr) _enemyDefs[def.name] = def
            console.log(`[Enemy] Loaded ${arr.length} enemy definitions`)

            // Collect unique sprite bases needed
            const sheetBases = new Set();      // bases from Enemies.png (composite/sheet mode)
            const individualFiles = new Set(); // individual files (simple/hero mode)
            for (const def of arr) {
                const s = def.sprite;
                if (s.mode === 'composite' || s.mode === 'sheet') {
                    sheetBases.add(s.base);
                } else if (s.mode === 'simple' || s.mode === 'hero') {
                    individualFiles.add(s.file);
                }
            }

            // Load Enemies.png and slice for sheet-based sprites
            if (sheetBases.size > 0) {
                loadImage('../characters/Enemies.png').then(sheet => {
                    const sliceH = sheet.height / MONSTER_TYPES.length
                    for (const base of sheetBases) {
                        const row = MONSTER_TYPES.indexOf(base);
                        if (row >= 0) {
                            const c = document.createElement('canvas')
                            c.width = sheet.width; c.height = sliceH
                            c.getContext('2d').drawImage(sheet, 0, row * sliceH, sheet.width, sliceH, 0, 0, sheet.width, sliceH)
                            monsterSprites[base] = c
                        }
                    }
                }).catch(() => {
                    console.warn('[Monster] Enemies.png not found, falling back to individual files')
                    for (const base of sheetBases) {
                        loadImage(`../characters/${base}.png`).then(img => {
                            monsterSprites[base] = img
                        }).catch(() => console.warn(`[Monster] Sprite not found: ${base}.png`));
                    }
                });
            }

            // Load individual sprite files (simple/hero mode)
            for (const file of individualFiles) {
                loadImage(`../characters/${file}`).then(img => {
                    const base = file.replace('.png', '');
                    monsterSprites[base] = img
                }).catch(() => console.warn(`[Monster] Sprite not found: ${file}`));
            }
        }).catch(e => console.warn('[Enemy] Could not load enemies.json:', e.message)),

        // Weapon sprites for composite enemies
        Promise.all(['Weapon-Hands', 'Weapon-Bone', 'Weapon-Wood'].map(async file => {
            try { _weaponSprites[file] = await loadImage(`../characters/${file}.png`) }
            catch { console.warn(`[Enemy] Weapon sprite not found: ${file}.png`) }
        })),
    ])

    console.log(`[Load] Phase 1 (parallel): ${_ms(_tPhase1)}`)

    // ── Bake shadow/ghost spritesheets for all monster types + named enemies ──
    const _tBake = performance.now()
    _bakeAllMonsterSheets()
    console.log(`[Load] bakeAllMonsterSheets: ${_ms(_tBake)}`)

    // ── Phase 2: scenario selection + map load (requires tileset + assetMap ready) ──
    assetMap = am

    // Show the scenario selection screen; loading screen stays hidden during the
    // very first asset phase but we hide it once the picker is interactive. All
    // independent assets are already loaded by this point.
    document.getElementById('loading').classList.add('hidden')

    const result = await showScenarioSelectWithLoad(scenariosIndex)

    // If a game was loaded, the deserializeGameState already set everything up
    if (result.loaded) {
        // Game loop already started in deserializeGameState
        return
    }

    _currentScenarioId = result.scenarioId
    _currentCategory  = result.category
    const scenarioId = result.scenarioId
    const category = result.category

    const _tScn = performance.now()
    const scenario = await engine.loadScenario(scenarioId, '../scenarios')

    // Resolve which category (folder of pool files) to load and how many pools.
    // `category` is null for legacy scenarios → flat questions/poolN.json +
    // questionPools count; otherwise read the chosen category's pools count.
    let poolCount
    if (category && scenario.questionCategories?.[category]) {
        poolCount = scenario.questionCategories[category].pools ?? 1
    } else {
        poolCount = scenario.questionPools ?? 1
    }
    await loadQuestions(`../scenarios/${scenarioId}`, poolCount, category)
    // Build learning registry for this scenario/category
    await _buildLearnRegistry(`../scenarios/${scenarioId}`, poolCount, category)
    syncStatsFromEngine()
    // Scenario may pin a hero via "hero": "Tom"|"Mark"|"George" (default Tom).
    await loadHeroSprite(scenario.hero)
    console.log(`[Load] scenario+questions: ${_ms(_tScn)}`)

    const _tMap = performance.now()
    // start_position accepts two forms:
    //   "start"                 → named map mark (string shorthand; preferred)
    //   { "x": n, "y": m }      → explicit tile coords
    // A named mark takes priority over coords (resolved inside loadAndEnterMap
    // against the map's marks array, case-insensitively).
    const sp = scenario.start_position
    const startX = (sp && typeof sp === 'object') ? sp.x : undefined
    const startY = (sp && typeof sp === 'object') ? sp.y : undefined
    const startMark = (typeof sp === 'string') ? sp : undefined
    await loadAndEnterMap(scenario.start_map, startX, startY, startMark)
    console.log(`[Load] loadAndEnterMap: ${_ms(_tMap)}`)

    console.log(`[Load] total init: ${_ms(_t0)}`)

    // Start rendering before firing events so the map is visible during dialogs
    prevTime = performance.now()
    requestAnimationFrame(gameLoop)

    // ── Wire HUD before events so hero icon is visible during dialogs ──────
    document.getElementById('hud-hero-icon').addEventListener('click', _toggleEquipmentPanel)
    document.getElementById('hud-help-btn')?.addEventListener('click', () => showLearnDialog())
    document.getElementById('hud-save-btn')?.addEventListener('click', saveGame)
    _drawHeroIcon()
    updateHud()

    // Keyboard shortcut for save (Ctrl+S)
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault()
            saveGame()
        }
    })

    // Fire startup events — engineBusy freezes input while they run
    engineBusy = true
    await engine.fireEvent('scenario_start')
    await engine.fireEvent('map_enter', { map_id: scenario.start_map })
    engineBusy = false
}

// ─── Save/Load System ───────────────────────────────────────────────────────────
/**
 * Serialize the complete game state to a JSON object.
 * Captures: engine state, player position, map entities, runtime map changes, etc.
 */
function serializeGameState() {
    const engineState = engine.getState()

    // Collect runtime map state (decorations, terrain changes) for all visited maps
    const mapStates = {}
    for (const [mapId, cachedMap] of _mapCache.entries()) {
        mapStates[mapId] = serializeMap(cachedMap)
        // Add the tilesetId which isn't in serializeMap output
        mapStates[mapId].tilesetId = cachedMap._tilesetId || 'world'
    }

    // Also save current map if not already in _mapCache (happens if never switched maps)
    if (_currentMapId !== null && !_mapCache.has(_currentMapId) && map) {
        mapStates[_currentMapId] = serializeMap(map)
        mapStates[_currentMapId].tilesetId = map._tilesetId || 'world'
    }

    // Collect entities for all visited maps, including current map
    const entityStates = {}
    for (const [mapId, entities] of _mapEntities.entries()) {
        entityStates[mapId] = {
            monsters: entities.monsters.map(m => ({ ...m })),
            npcs: entities.npcs.map(n => ({ ...n })),
        }
    }
    // Also save current map entities (monsters/npcs module variables) if not already in _mapEntities
    if (_currentMapId !== null) {
        const existing = entityStates[_currentMapId]
        entityStates[_currentMapId] = {
            monsters: existing ? [...existing.monsters, ...monsters.map(m => ({ ...m }))] : monsters.map(m => ({ ...m })),
            npcs: existing ? [...existing.npcs, ...npcs.map(n => ({ ...n }))] : npcs.map(n => ({ ...n })),
        }
        // Deduplicate by id (if a monster was already saved in _mapEntities)
        const seenMonsters = new Set()
        entityStates[_currentMapId].monsters = entityStates[_currentMapId].monsters.filter(m => {
            if (seenMonsters.has(m.id)) return false
            seenMonsters.add(m.id)
            return true
        })
        const seenNpcs = new Set()
        entityStates[_currentMapId].npcs = entityStates[_currentMapId].npcs.filter(n => {
            if (seenNpcs.has(n.id)) return false
            seenNpcs.add(n.id)
            return true
        })
    }

    return {
        version: 1,
        timestamp: Date.now(),
        scenarioId: _currentScenarioId,
        category: _currentCategory,
        currentMapId: _currentMapId,

        // Engine state (variables, flags, inventory, equipped, etc.)
        engine: {
            variables: { ...engineState.variables },
            flags: { ...engineState.flags },
            inventory: { ...engineState.inventory },
            equipped: { ...engineState.equipped },
            firedOnce: Array.from(engineState.firedOnce),
            currentMap: engineState.currentMap,
            weather: { ...engineState.weather },
            lighting: { ...engineState.lighting },
        },

        // Player position and animation state
        player: {
            tileX: player.tileX,
            tileY: player.tileY,
            fromX: player.fromX,
            fromY: player.fromY,
            toX: player.toX,
            toY: player.toY,
            progress: player.progress,
            px: player.px,
            py: player.py,
            dir: player.dir,
            moving: player.moving,
        },

        // Player stats (mirrored from engine but kept for convenience)
        playerStats: {
            hp: playerStats.hp,
            maxHp: playerStats.maxHp,
            xp: playerStats.xp,
            gold: playerStats.gold,
            level: playerStats.level,
            speed: playerStats.speed,
            base_dmg: playerStats.base_dmg,
            attack: playerStats.attack,
            defense: playerStats.defense,
            armor: playerStats.armor,
            agility: playerStats.agility,
            equippedWeapon: playerStats.equippedWeapon,
            equipped: { ...playerStats.equipped },
            items: { ...playerStats.items },
        },

        // Runtime map states
        mapStates,
        entityStates,
        // Map changes (delta: spawn_decoration, remove_decoration, change_tile)
        mapChanges: Object.fromEntries(_mapChanges),

        // Hero sprite info
        heroName: playerSprites.heroName,
    }
}

/**
 * Save the current game to a file download.
 */
function saveGame() {
    try {
        const state = serializeGameState()
        const json = JSON.stringify(state, null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)

        // Create filename with scenario name and timestamp
        const date = new Date()
        const dateStr = date.toISOString().slice(0, 19).replace(/[:.]/g, '-')
        const scenarioName = state.scenarioId || 'unknown'
        const filename = `save_${scenarioName}_${dateStr}.json`

        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)

        // Clean up the object URL after a short delay
        setTimeout(() => URL.revokeObjectURL(url), 1000)

        showMessage(`Gra zapisana: ${filename}`, 3000)
        console.log('[Save] Game saved to', filename)
    } catch (e) {
        console.error('[Save] Failed to save game:', e)
        showMessage('Błąd zapisu gry: ' + e.message, 4000, null, true)
    }
}

/**
 * Deserialize and restore game state from a save object.
 */
async function deserializeGameState(saveData) {
    if (!saveData || saveData.version !== 1) {
        throw new Error('Invalid or unsupported save file version')
    }

    const scenarioId = saveData.scenarioId
    const category = saveData.category

    // Load the scenario first
    const scenario = await engine.loadScenario(scenarioId, '../scenarios')

    // Restore engine state
    const engineState = engine.getState()
    engineState.variables = { ...saveData.engine.variables }
    engineState.flags = { ...saveData.engine.flags }
    engineState.inventory = { ...saveData.engine.inventory }
    engineState.equipped = { ...saveData.engine.equipped }
    engineState.firedOnce = new Set(saveData.engine.firedOnce)
    engineState.currentMap = saveData.engine.currentMap
    engineState.weather = { ...saveData.engine.weather }
    engineState.lighting = { ...saveData.engine.lighting }

    // Notify inventory change so UI updates (equipment panel, HUD, etc.)
    engine.notifyInventoryChange()

    // Sync playerStats from engine
    syncStatsFromEngine()

    // Load hero sprite
    await loadHeroSprite(saveData.heroName || scenario.hero)

    // Load questions for the scenario/category
    let poolCount
    if (category && scenario.questionCategories?.[category]) {
        poolCount = scenario.questionCategories[category].pools ?? 1
    } else {
        poolCount = scenario.questionPools ?? 1
    }
    await loadQuestions(`../scenarios/${scenarioId}`, poolCount, category)
    await _buildLearnRegistry(`../scenarios/${scenarioId}`, poolCount, category)

    // Restore all map states
    _mapCache.clear()
    _mapEntities.clear()
    _mapChanges.clear()

    for (const [mapId, mapState] of Object.entries(saveData.mapStates)) {
        // The mapState now comes from serializeMap which has the full structure
        // serializeMap uses `tileset` property, but we also stored `tilesetId` as a custom property
        const tilesetId = mapState.tilesetId || mapState.tileset || 'world'
        const mapData = { ...mapState, tileset: tilesetId }

        // Ensure tileset is loaded
        if (!_tilesetCache.has(tilesetId)) {
            const ts = await loadTileset(`../tilesets/${tilesetId}/tileset.json`)
            if (ts.waterTerrain) buildWaterFrames()
            else { _waterAtlas = null; waterFrameMap = null }
            _tilesetCache.set(tilesetId, { tileset: ts, waterAtlas: _waterAtlas, waterFrameMap })
        }
        const cached = _tilesetCache.get(tilesetId)

        const map = deserializeMap(mapData, cached.tileset)
        map._tilesetId = tilesetId

        _mapCache.set(mapId, map)
    }

    // Replay recorded map changes (delta) for each map
    if (saveData.mapChanges) {
        for (const [mapId, changes] of Object.entries(saveData.mapChanges)) {
            let map = _mapCache.get(mapId)
            if (!map) {
                // Map wasn't in saved mapStates (old save or never cached) — load from JSON
                console.log(`[Load] Map ${mapId} not in saved states, loading from JSON for change replay`)
                try {
                    const mapRes = await fetch(`../scenarios/${scenarioId}/maps/${mapId}.json`)
                    if (!mapRes.ok) throw new Error(`Map not found: ${mapId}`)
                    const mapData = await mapRes.json()
                    const tilesetId = mapData.tileset ?? 'world'
                    if (!_tilesetCache.has(tilesetId)) {
                        const ts = await loadTileset(`../tilesets/${tilesetId}/tileset.json`)
                        if (ts.waterTerrain) buildWaterFrames()
                        else { _waterAtlas = null; waterFrameMap = null }
                        _tilesetCache.set(tilesetId, { tileset: ts, waterAtlas: _waterAtlas, waterFrameMap })
                    }
                    const cached = _tilesetCache.get(tilesetId)
                    map = deserializeMap(mapData, cached.tileset)
                    map._tilesetId = tilesetId
                    _mapCache.set(mapId, map)
                } catch (e) {
                    console.warn(`[Load] Failed to load map ${mapId} for change replay:`, e)
                    continue
                }
            }
            for (const change of changes) {
                try {
                    switch (change.action) {
                        case 'spawn_decoration':
                            placeDecoration(map, change.assetId, change.x, change.y, 0, undefined, false, 1.0, 1.0)
                            break
                        case 'remove_decoration':
                            removeMapDecoration(map, change.x, change.y)
                            break
                        case 'change_tile':
                            const terrainId = _resolveTerrainId(change.terrain)
                            if (terrainId != null) setCell(map, change.x, change.y, terrainId)
                            break
                        case 'spawn_item':
                            if (!map._items) map._items = []
                            if (!map._items[change.y]) map._items[change.y] = []
                            if (map._items[change.y][change.x]) {
                                map._items[change.y][change.x].qty += change.qty
                            } else {
                                map._items[change.y][change.x] = { itemId: change.itemId, qty: change.qty }
                            }
                            break
                        case 'remove_item':
                            if (map._items && map._items[change.y] && map._items[change.y][change.x]) {
                                map._items[change.y][change.x] = null
                            }
                            break
                    }
                } catch (e) {
                    console.warn(`[Load] Failed to replay change on ${mapId}:`, change, e)
                }
            }
            // Invalidate decoration cache for this map so changes render
            if (map === _mapCache.get(mapId)) {
                // Will be handled by loadAndEnterMap when this map is entered
            }
            _mapChanges.set(mapId, [...changes]) // Restore to _mapChanges for future saves
            console.log(`[Load] Replayed ${changes.length} changes on map ${mapId}`)
        }
    }

    // Restore entity states
    for (const [mapId, entityState] of Object.entries(saveData.entityStates)) {
        _mapEntities.set(mapId, {
            monsters: entityState.monsters.map(m => ({ ...m })),
            npcs: entityState.npcs.map(n => ({ ...n })),
        })
    }

    // Pre-load sprites for all restored monsters
    const allRestoredMonsters = []
    for (const [, entityState] of Object.entries(saveData.entityStates)) {
        allRestoredMonsters.push(...entityState.monsters)
    }
    // Also include current map monsters if present
    if (saveData.entityStates[saveData.currentMapId]) {
        allRestoredMonsters.push(...saveData.entityStates[saveData.currentMapId].monsters)
    }
    // Deduplicate by type and load sprites
    const uniqueMonsterTypes = [...new Set(allRestoredMonsters.map(m => m.type))]
    for (const type of uniqueMonsterTypes) {
        const def = _enemyDefs[type];
        const charName = def?.sprite?.base ?? type;
        if (monsterSprites[charName] == null) {
            const file = def?.sprite?.file ?? `${charName}.png`;
            try { monsterSprites[charName] = await loadImage(`../characters/${file}`) }
            catch (e) { console.warn(`[Monster] Sprite not found: ${file} (will render nothing)`) }
        }
        // Re-bake this type's shadow silhouette now that its char sprite is loaded
        if (def?.sprite?.mode === 'composite' && monsterSprites[charName]) {
            _monsterSheetInfo.set(type, _computeCompositeBounds(def))
            _monsterSilhouetteCache.set(type, _bakeMonsterSheet(type, '#000'))
        }
    }

    // Enter the saved map
    _currentScenarioId = scenarioId
    _currentCategory = category

    await loadAndEnterMap(saveData.currentMapId,
        saveData.player.tileX, saveData.player.tileY, null)

    // Restore player position and state
    player.tileX = saveData.player.tileX
    player.tileY = saveData.player.tileY
    player.fromX = saveData.player.fromX
    player.fromY = saveData.player.fromY
    player.toX = saveData.player.toX
    player.toY = saveData.player.toY
    player.progress = saveData.player.progress
    player.px = saveData.player.px
    player.py = saveData.player.py
    player.dir = saveData.player.dir
    player.moving = saveData.player.moving

    // Update HUD and render
    updateHud()
    _drawHeroIcon()

    // Wire HUD click handlers (same as init)
    document.getElementById('hud-hero-icon').addEventListener('click', _toggleEquipmentPanel)
    document.getElementById('hud-help-btn')?.addEventListener('click', () => showLearnDialog())
    document.getElementById('hud-save-btn')?.addEventListener('click', saveGame)

    // NOTE: map_enter is NOT fired on load — state (weather, lighting, entities, decorations, terrain)
    // is already fully restored. Firing map_enter would re-run scripts (once=false), which is undesired.

    // Start the game loop
    prevTime = performance.now()
    requestAnimationFrame(gameLoop)

    console.log('[Load] Game loaded successfully')
}

/**
 * Handle loading a game from a file input.
 */
async function loadGameFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = async (e) => {
            try {
                const saveData = JSON.parse(e.target.result)

                // Hide scenario select overlay
                document.getElementById('scenario-select').classList.add('hidden')

                // Show loading screen
                document.getElementById('loading').classList.remove('hidden')
                document.getElementById('loading').textContent = 'Wczytywanie gry...'

                // Stop current game loop if running
                // (We'll just restart by calling deserializeGameState which sets up everything)

                await deserializeGameState(saveData)

                document.getElementById('loading').classList.add('hidden')
                showMessage('Gra wczytana pomyślnie', 3000)
                resolve()
            } catch (err) {
                console.error('[Load] Failed to load game:', err)
                document.getElementById('loading').classList.add('hidden')
                showMessage('Błąd wczytywania gry: ' + err.message, 4000, null, true)
                reject(err)
            }
        }
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsText(file)
    })
}

/**
 * Show scenario selection with an additional "Load Game" option.
 */
function showScenarioSelectWithLoad(scenariosIndex) {
    return new Promise(resolve => {
        const overlay = document.getElementById('scenario-select')
        const listEl = document.getElementById('scenario-select-list')
        const catBox = document.getElementById('category-select')
        const catListEl = document.getElementById('category-select-list')

        // Add "Load Game" as the first option
        const loadBtn = document.createElement('button')
        loadBtn.className = 'scenario-select-btn'
        loadBtn.type = 'button'
        loadBtn.innerHTML = `
            <span class="scenario-select-key">💾</span>
            <span class="scenario-select-body">
                <span class="scenario-select-name">Wczytaj grę</span>
                <span class="scenario-select-help">Wybierz plik zapisu z dysku</span>
            </span>`
        loadBtn.addEventListener('click', async () => {
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)
            overlay.classList.add('hidden')

            // Create file input
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = '.json'
            input.style.display = 'none'
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0]
                if (file) {
                    await loadGameFromFile(file)
                    resolve({ scenarioId: null, category: null, loaded: true })
                } else {
                    // User cancelled - show scenario select again
                    showScenarioSelectWithLoad(scenariosIndex).then(resolve)
                }
            })
            document.body.appendChild(input)
            input.click()
            document.body.removeChild(input)
        })
        listEl.appendChild(loadBtn)

        // Preserve insertion order from the JSON file.
        const entries = Object.entries(scenariosIndex)

        let scenarioHandler = null
        let categoryHandler = null
        let chosenScenarioId = null

        const finish = (category) => {
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)
            if (categoryHandler) document.removeEventListener('keydown', categoryHandler)
            overlay.classList.add('hidden')
            resolve({ scenarioId: chosenScenarioId, category, loaded: false })
        }

        const showCategoryStep = (categories) => {
            const catEntries = Object.entries(categories)
            if (!catEntries.length) { finish(null); return }

            catListEl.innerHTML = ''
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)
            categoryHandler = (ev) => {
                if (ev.key < '1' || ev.key > '9') return
                const idx = parseInt(ev.key, 10) - 1
                if (idx >= 0 && idx < catEntries.length) catPick(idx)
            }

            const catPick = (idx) => finish(catEntries[idx][0])

            catEntries.forEach(([key, meta], idx) => {
                const btn = document.createElement('button')
                btn.className = 'category-select-btn'
                btn.type = 'button'
                btn.innerHTML =
                    `<span class="scenario-select-key">${idx + 1}</span>` +
                    `<span class="scenario-select-body">` +
                    `  <span class="scenario-select-name">${meta?.name ?? key}</span>` +
                    `</span>`
                btn.addEventListener('click', () => catPick(idx))
                catListEl.appendChild(btn)
            })

            catBox.classList.remove('hidden')
            document.addEventListener('keydown', categoryHandler)
        }

        const pickScenario = async (idx) => {
            chosenScenarioId = entries[idx][0]
            if (scenarioHandler) document.removeEventListener('keydown', scenarioHandler)

            let categories = null
            try {
                const res = await fetch(`../scenarios/${chosenScenarioId}/scenario.json`)
                if (res.ok) {
                    const s = await res.json()
                    if (s.questionCategories && typeof s.questionCategories === 'object') {
                        categories = s.questionCategories
                    }
                }
            } catch { /* fall through: no categories */ }

            if (!categories) { finish(null); return }
            showCategoryStep(categories)
        }

        scenarioHandler = (ev) => {
            if (ev.key < '1' || ev.key > '9') return
            const idx = parseInt(ev.key, 10) - 1
            // Account for the "Load Game" button at index 0
            if (idx === 0) {
                // Trigger the load button click
                loadBtn.click()
                return
            }
            if (idx > 0 && idx <= entries.length) pickScenario(idx - 1)
        }

        // Add regular scenario buttons (starting from index 1 for keyboard)
        entries.forEach(([id, meta], idx) => {
            const btn = document.createElement('button')
            btn.className = 'scenario-select-btn'
            btn.type = 'button'
            btn.innerHTML =
                `<span class="scenario-select-key">${idx + 1}</span>` +
                `<span class="scenario-select-body">` +
                `  <span class="scenario-select-name">${meta?.name ?? id}</span>` +
                `  ${meta?.help ? `<span class="scenario-select-help">${meta.help}</span>` : ''}` +
                `</span>`
            btn.addEventListener('click', () => pickScenario(idx))
            listEl.appendChild(btn)
        })

        document.addEventListener('keydown', scenarioHandler)
        overlay.classList.remove('hidden')
    })
}

init().catch(err => {
    console.error(err)
    document.getElementById('loading').textContent = 'Failed to load: ' + err.message
})
