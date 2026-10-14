import { loadTilesetRegistry, loadTileset } from './tileset.js'
import { createMap, setCell, getCell, getRaw, floodFill, serializeMap, deserializeMap, placeDecoration, removeDecoration, getDecorations, getHeight, setHeight, getRawHeight, getRamp, setRamp, setHFence, removeHFence, setVFence, removeVFence, addScript, removeScript, getScript, updateScript, getScriptsForMap, getAllScripts } from './map.js'
import { loadAssets } from './assets.js'
import { tileHash, getVariantIndex, buildTileCanvas } from './tilemath.js'
import { createTilePickerTool } from './scripts/tilePicker.js'
import { loadAllScripts, saveMapScripts, getScriptFileForMap, saveScriptFile, loadScriptFile, getScriptFilesInfo, createScriptFileForMap } from './scripts/scriptStorage.js'
import { createScriptFileManager } from './scripts/scriptFileManager.js'
import { createScriptEventEditor } from './scripts/scriptEventEditor.js'
import { createScriptActionEditor } from './scripts/scriptActionEditor.js'
import { createScriptNestedActionEditor } from './scripts/scriptNestedActionEditor.js'
import { scriptState, PANEL_MODE } from './scripts/scriptState.js'
import { preloadMonsterImages, getMonsterPreviewSprite, getCharacterSprite, drawMonsterPreview, drawCompositeEnemy } from './scripts/monsterSprites.js'

const canvas = document.getElementById('mapCanvas')
let ctx = canvas.getContext('2d', { alpha: false })
ctx.imageSmoothingEnabled = false
const container = document.getElementById('mapContainer')

// Two-layer static cache:
//   baseCanvas   — terrain tiles only (expensive; rebuilt on map edit / scroll / zoom)
//   overlayCanvas — water + elevation + grid + fences (rebuilt on water tick too)
let baseCanvas    = null, baseCtx    = null, baseDirty    = true
let overlayCanvas = null, overlayCtx = null, overlayDirty = true
let _lastScrollX = -1
let _lastScrollY = -1
let _lastZoom    = -1
function invalidateStaticCache() { baseDirty = true; overlayDirty = true }

// reusable offscreen canvas — kept for potential future use
const offCanvas = document.createElement('canvas')
offCanvas.width  = 32
offCanvas.height = 32
const offCtx = offCanvas.getContext('2d')

const TILE = 32
const SHADOW_SIZE = 64
const COLS = 30
const ROWS = 20

// ── Water animation ──────────────────────────────────────────────────────────
const WAVE_NFRAMES   = 16                          // animation frame count (10 fps)
const WATER_BASE_CLR = 'rgb(21,108,153)'
const SHIMMER_RGB    = [[0,152,178],[0,207,223]]   // dim / bright shimmer colours as [r,g,b]
const SHIMMER_CLR    = ['rgb(0,152,178)','rgb(0,207,223)']
const SKEW_SHADOW_SKEW  = 0.7;  // default horizontal skew factor
const SKEW_SHADOW_SCALE = 0.5;  // default vertical scale factor

// Fence shadow parameters (mirrors ShadowDef.html tuning)
const FENCE_SHADOW_GX    = 15    // ground-point X within 32×32 tile
const FENCE_SHADOW_GY    = 23    // ground-point Y within 32×32 tile
const FENCE_SHADOW_SCALE = 0.8   // vertical scale of the shadow
const FENCE_SHADOW_SKEW  = -0.7  // horizontal shear (c in transform matrix)
const FENCE_SHADOW_OX    = TILE  // tile origin column inside the pre-rendered shadow canvas
const FENCE_SHADOW_OY    = TILE  // tile origin row   inside the pre-rendered shadow canvas
const FENCE_SHADOW_CW    = TILE * 3  // shadow canvas width  (3 × TILE to fit skewed extent)
const FENCE_SHADOW_CH    = TILE * 3  // shadow canvas height
const FENCE_OFFSET_Y     = -8        // vertical draw offset for all fence sprites and shadows

// --- Effects ---
// To add a new effect type, add an entry here and drop the spritesheet in assets/.
// The 32×32 effects share one sheet, effects-32x32.png (rows of 16 frames); `row`
// selects the row, so source-Y is `row * h`. fire_big is a standalone 64×64 sheet.
const EFFECT_SHEET_SRC = '../assets/effects-32x32.png'
const EFFECT_SHEET = { img: null }
const EFFECT_DEFS = {
    fire:        { frames: 16, fps: 12, w: 32, h: 32, row: 0, sheet: EFFECT_SHEET, img: null },
    fire_2:      { frames: 16, fps: 12, w: 32, h: 32, row: 1, sheet: EFFECT_SHEET, img: null },
    haze_purple: { frames: 16, fps: 12, w: 32, h: 32, row: 2, sheet: EFFECT_SHEET, img: null },
    haze_green:  { frames: 16, fps: 12, w: 32, h: 32, row: 3, sheet: EFFECT_SHEET, img: null },
    fire_big:    { frames: 16, fps: 12, w: 64, h: 64, row: 0, src: '../assets/fire_big.png', img: null },
}
const EFFECT_SNAP_DIST = 20   // px — click within this radius to remove an effect
const SELECT_DRAG_THRESHOLD = 5  // px — must move this far from mousedown to start a drag

let tileset = null
let tilesetRegistry = null
let map = null
let sortedItems     = null  // full-map sorted decoration+fence list
let sortedItemsDirty = true  // rebuild on next render after any structural change
let tool = 'paint'
let brushSize = 1
let brushShape = 'circle'  // 'circle' | 'square'
let cursorX = -1
let cursorY = -1
let activeTerrain = 0
let zoom = 1
let preview = true
let isPainting = false
let raiseLockLevel = null  // target height locked on mousedown for raise/lower drag
let showGrid = true
let showCoords = false
let showLevels = false
let showTraversable = false
let showCacheStats = false
let layer = 'terrain'       // 'terrain' | 'decoration' | 'fence'
let selectedAssets = []     // array of asset ids currently selected
let selectedAssetStates = {} // assetId -> stateId currently chosen in palette
let assets = null           // loaded asset definitions
let assetMap = null
let hoveredRampCell = null  // { x, y } — high cell whose south face the ramp tool hovers
let selectedDecoration = null // { x, y } of decoration selected with hand tool
let selectedFence = null      // fence type ID (e.g. 'wood') currently selected
let hoveredFenceCorner = null // { cx, cy } — tile corner the mouse is snapping to
let fenceDragStart = null     // { cx, cy } — corner where the current fence drag began
let cursorWx = 0              // world pixel X of current mouse position
let cursorWy = 0              // world pixel Y of current mouse position
let selectedEffect = null      // index into map._effects, null if none
let isDraggingSelect = false   // true while dragging a decoration or effect
let selectDragItem = null      // { kind:'decoration', origX, origY } | { kind:'effect', index }
let selectPickCandidate = null // item picked on mousedown; drag confirmed after threshold
let selectPickStartWx = 0      // cursor world pos at mousedown
let selectPickStartWy = 0

// --- Script Editor (3-Panel System) ---
let showScriptPanel = false
let scriptFileManagerPanel = null
let scriptEventEditorPanel = null
let scriptActionEditorPanel = null
let scriptNestedActionEditorPanel = null
let tilePickerTool = null

// --- Map Enter Preview ---
let showMapEnterPreview = false
let mapEnterPreviewData = null // { monsters: [], items: [], npcs: [], decorations: [], tileChanges: [] }

// Utility function for HTML escaping
function escapeHtml(text) {
  if (text === null || text === undefined) return ''
  return String(text)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/'/g, "'")
}

// --- Wind animation ---

const windSheetCache = new Map()
let propWindRaf = null
let activeEffectType = 'fire'

function generateWindSpriteSheet(asset, stateId, wind) {
    const ts = asset.tileset
    const state = asset.states.find(s => s.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
    const [tx, ty, tw, th] = state.region
    const W = tw * ts.size[0]
    const H = th * ts.size[1]
    const frames    = wind[0]
    const amplitude = wind[1]
    const rigidity  = wind[2]
    const rootRow   = Math.round(asset.pivot[1] * H)

    const src = document.createElement('canvas')
    src.width = W; src.height = H
    const srcCtx = src.getContext('2d')
    srcCtx.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], W, H, 0, 0, W, H)
    const pixels = srcCtx.getImageData(0, 0, W, H).data

    function getPixel(x, y) {
        if (x < 0 || x >= W || y < 0 || y >= H) return [0, 0, 0, 0]
        const i = (y * W + x) * 4
        return [pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]]
    }
    function cubicCR(p0, p1, p2, p3, t) {
        const t2 = t*t, t3 = t2*t
        return Math.max(0, Math.min(255,
            0.5*(2*p1+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3)
        ))|0
    }
    function sampleCubic(x, y) {
        const x1 = Math.floor(x), ft = x - x1
        const c = [-1,0,1,2].map(dd => getPixel(x1+dd, y))
        return [0,1,2,3].map(ch => cubicCR(c[0][ch],c[1][ch],c[2][ch],c[3][ch],ft))
    }

    const sheet = document.createElement('canvas')
    sheet.width = W * frames
    sheet.height = H
    const sheetCtx = sheet.getContext('2d')

    for (let i = 0; i < frames; i++) {
        const t     = frames > 1 ? i / (frames - 1) : 0
        const swing = -Math.cos(t * Math.PI) * amplitude

        const out = sheetCtx.createImageData(W, H)
        for (let row = 0; row < H; row++) {
            let sway = 0
            if (row < rootRow) {
                const frac    = row / rootRow
                const falloff = Math.pow(1 - frac, rigidity)
                sway = swing * falloff
            }
            for (let col = 0; col < W; col++) {
                const [r, g, b, a] = sampleCubic(col - sway, row)
                const idx = (row * W + col) * 4
                out.data[idx] = r; out.data[idx+1] = g; out.data[idx+2] = b; out.data[idx+3] = a
            }
        }
        sheetCtx.putImageData(out, i * W, 0)
    }
    return sheet
}

function getWindSpriteSheet(asset, stateId, wind) {
    const key = `${asset.id}:${stateId ?? asset.defaultState}:${wind[0]}:${wind[1]}:${wind[2]}`
    if (windSheetCache.has(key)) return windSheetCache.get(key)
    const sheet = generateWindSpriteSheet(asset, stateId, wind)
    windSheetCache.set(key, sheet)
    return sheet
}

// ── Wind shadow caches ──────────────────────────────────────
const windSilhouetteFrameCache = new Map()
const windRayTracedFrameCache  = new Map()

function getWindSilhouetteCanvas(asset, stateId, wind, fi) {
    const key = `${asset.id}:${stateId ?? asset.defaultState}:${wind[0]}:${wind[1]}:${wind[2]}:${fi}`
    if (windSilhouetteFrameCache.has(key)) return windSilhouetteFrameCache.get(key)
    const sheet = getWindSpriteSheet(asset, stateId, wind)
    const ts = asset.tileset
    const state = asset.states.find(s => s.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
    const [,, tw, th] = state.region
    const W = tw * ts.size[0], H = th * ts.size[1]
    const sil = document.createElement('canvas')
    sil.width = W; sil.height = H
    const sc = sil.getContext('2d')
    sc.drawImage(sheet, fi * W, 0, W, H, 0, 0, W, H)
    sc.globalCompositeOperation = 'source-in'
    sc.fillStyle = '#000'
    sc.fillRect(0, 0, W, H)
    windSilhouetteFrameCache.set(key, sil)
    return sil
}

function computeWindRayTracedShadow(asset, stateId, wind, fi) {
    const s = asset.shadow
    const ts = asset.tileset
    const state = asset.states.find(st => st.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
    const [,, tw, th] = state.region
    const sw = tw * ts.size[0], sh = th * ts.size[1]
    const sheet = getWindSpriteSheet(asset, stateId, wind)
    const src = document.createElement('canvas')
    src.width = sw; src.height = sh
    const srcCtx = src.getContext('2d')
    srcCtx.drawImage(sheet, fi * sw, 0, sw, sh, 0, 0, sw, sh)
    const angleRad = s.angle * Math.PI / 180
    const cos = Math.cos(angleRad), sin = Math.sin(angleRad)
    const length = s.length
    const extraR = cos > 0 ? Math.ceil(cos * length) : 0
    const extraL = cos < 0 ? Math.ceil(-cos * length) : 0
    const extraB = sin > 0 ? Math.ceil(sin * length) : 0
    const extraT = sin < 0 ? Math.ceil(-sin * length) : 0
    const data = srcCtx.getImageData(0, 0, sw, sh).data
    const isSolid = (x, y) => x >= 0 && x < sw && y >= 0 && y < sh && data[(y * sw + x) * 4 + 3] > 10
    const out = document.createElement('canvas')
    out.width = sw + extraL + extraR
    out.height = sh + extraT + extraB
    const ctx = out.getContext('2d')
    ctx.fillStyle = 'rgb(0,0,0)'
    for (let py = 0; py < sh; py++) {
        for (let px = 0; px < sw; px++) {
            if (!isSolid(px, py)) continue
            let isEdge = false
            outer: for (let ny = -1; ny <= 1; ny++) {
                for (let nx = -1; nx <= 1; nx++) {
                    if (nx === 0 && ny === 0) continue
                    if (!isSolid(px + nx, py + ny)) { isEdge = true; break outer }
                }
            }
            if (!isEdge) continue
            for (let step = 0.5; step <= length; step += 0.5)
                ctx.fillRect(Math.round(extraL + px + cos * step), Math.round(extraT + py + sin * step), 1, 1)
        }
    }
    return { canvas: out, ox: -extraL, oy: -extraT }
}

function getWindRayTracedFrameCanvas(asset, stateId, wind, fi) {
    const key = `${asset.id}:${stateId ?? asset.defaultState}:${wind[0]}:${wind[1]}:${wind[2]}:${fi}`
    if (windRayTracedFrameCache.has(key)) return windRayTracedFrameCache.get(key)
    const result = computeWindRayTracedShadow(asset, stateId, wind, fi)
    windRayTracedFrameCache.set(key, result)
    return result
}

function getWindFrame(frames, phaseMs = 0, fps = 6) {
    const cycleLen = (frames - 1) * 2
    if (cycleLen <= 0) return 0
    const t = Math.floor((performance.now() + phaseMs) / (1000 / fps)) % cycleLen
    return t < frames ? t : cycleLen - t
}

// --- Boot ---

// Expose editor instance globally for script panels (tile picker, etc.)
function exposeEditor() {
    window.editor = {
        get currentMap() { return map; },
        get currentTileset() { return tileset; },
        get tilesetRegistry() { return tilesetRegistry; },
        get assets() { return assets; },
        get assetMap() { return assetMap; },
        get zoom() { return zoom; },
        get TILE() { return TILE; }
    };
}

async function init() {
    const registry = await loadTilesetRegistry()
    tilesetRegistry = registry
    const select = document.getElementById('tilesetSelect')

    registry.forEach(t => {
        const opt = document.createElement('option')
        opt.value = t.path
        opt.textContent = t.name
        select.appendChild(opt)
    })

    await switchTileset(registry[0].path)
    exposeEditor()
    const assetDefs = await loadAssets('../assets/')
    assets = assetDefs.assets
    assetMap = assetDefs.assetMap
    buildAssetPalette()
    // Load the shared 32×32 effect sheet once, then point every entry that
    // uses it at the same Image (one request instead of N); fire_big keeps
    // its own standalone sheet.
    await new Promise(resolve => {
        const img = new Image()
        img.onload  = () => { EFFECT_SHEET.img = img; resolve() }
        img.onerror = () => { console.warn(`${EFFECT_SHEET_SRC} not found`); resolve() }
        img.src = EFFECT_SHEET_SRC
    })
    for (const def of Object.values(EFFECT_DEFS)) {
        if (def.sheet === EFFECT_SHEET) { def.img = EFFECT_SHEET.img; continue }
        def.img = await new Promise(resolve => {
            const img = new Image()
            img.onload  = () => resolve(img)
            img.onerror = () => { console.warn(`${def.src} not found`); resolve(null) }
            img.src = def.src
        })
    }
    buildEffectPalette()

    // Load enemy sprites for map_enter preview (shared module)
    await preloadMonsterImages()

    select.addEventListener('change', e => switchTileset(e.target.value))
    document.getElementById('previewToggle').addEventListener('change', e => {
        preview = e.target.checked
        invalidateStaticCache()
        scheduleRender()
    })
    document.getElementById('mapWidth').value = COLS
    document.getElementById('mapHeight').value = ROWS
    document.getElementById('btnNew').addEventListener('click', () => {
        const w = parseInt(document.getElementById('mapWidth').value)
        const h = parseInt(document.getElementById('mapHeight').value)
        map = createMap(w, h, tileset)
        currentMapName = null
        localFileHandle = null

        // Reset map_enter preview
        showMapEnterPreview = false
        mapEnterPreviewData = null
        const previewBtn = document.getElementById('btnMapEnterPreview')
        if (previewBtn) {
            previewBtn.classList.remove('active')
            previewBtn.textContent = '👁️'
            previewBtn.title = 'Preview map_enter (initial state)'
        }

        sortedItemsDirty = true
        invalidateStaticCache()
        updateSpacer()
        scheduleRender()
        exposeEditor()
    })
    document.addEventListener('keydown', e => {
        if (e.key === 'g' || e.key === 'G') {
            showGrid = !showGrid
            invalidateStaticCache()
            scheduleRender()
        }
        if (e.ctrlKey && e.code === 'KeyH') {
            e.preventDefault()
            showCoords = !showCoords
            invalidateStaticCache()
            scheduleRender()
        }
        if ((e.key === 's' || e.key === 'S') && e.shiftKey) {
            showCacheStats = !showCacheStats
            scheduleRender()
        } else if (e.key === 's' || e.key === 'S') {
            brushShape = brushShape === 'circle' ? 'square' : 'circle'
            document.getElementById('btnBrushShape').textContent = brushShape === 'circle' ? '⭕' : '⬜'
            scheduleRender()
        }
        if (e.key === 'm' || e.key === 'M') setTool('mark')
        if (e.key === 't' || e.key === 'T') toggleTilePicker()
        if (e.key === 'Delete' && tool === 'select') {
            if (selectedDecoration) {
                removeDecoration(map, selectedDecoration.x, selectedDecoration.y)
                selectedDecoration = null
                invalidateSortedItems()
                updatePropPanel()
                scheduleRender()
            } else if (selectedEffect !== null) {
                map._effects.splice(selectedEffect, 1)
                selectedEffect = null
                invalidateSortedItems()
                scheduleRender()
            }
        }
    })
    document.addEventListener('wheel', e => {
        if (!e.shiftKey) return
        e.preventDefault()
        brushSize = Math.min(5, Math.max(1, brushSize + (e.deltaY < 0 ? 1 : -1)))
        scheduleRender()
    }, { passive: false })
    document.getElementById('btnPaint').addEventListener('click', () => setTool('paint'))
    document.getElementById('btnErase').addEventListener('click', () => setTool('erase'))
    document.getElementById('btnFill').addEventListener('click', () => setTool('fill'))
    document.getElementById('btnRaise').addEventListener('click', () => setTool('raise'))
    document.getElementById('btnLower').addEventListener('click', () => setTool('lower'))
    document.getElementById('btnRamp').addEventListener('click', () => setTool('ramp'))
    document.getElementById('btnMark').addEventListener('click', () => setTool('mark'))
    document.getElementById('btnSelect').addEventListener('click', () => setTool('select'))
    document.getElementById('btnEffect').addEventListener('click', () => { setTool('effect'); buildEffectPalette() })
    document.getElementById('btnTilePicker').addEventListener('click', toggleTilePicker)
    document.getElementById('btnScripts').addEventListener('click', toggleScriptPanel)
    document.getElementById('btnMapEnterPreview').addEventListener('click', toggleMapEnterPreview)
    document.getElementById('btnBrushShape').addEventListener('click', () => {
        brushShape = brushShape === 'circle' ? 'square' : 'circle'
        document.getElementById('btnBrushShape').textContent = brushShape === 'circle' ? '⭕' : '⬜'
        scheduleRender()
    })
    document.getElementById('showLevelsToggle').addEventListener('change', e => {
        showLevels = e.target.checked
        invalidateStaticCache()
        scheduleRender()
    })
    document.getElementById('traversableToggle').addEventListener('change', e => {
        showTraversable = e.target.checked
        scheduleRender()
    })
    document.getElementById('zoomSelect').addEventListener('change', e => {
        zoom = parseFloat(e.target.value)
        updateSpacer()
        scheduleRender()
    })
    document.getElementById('btnSave').addEventListener('click', save)
    document.getElementById('btnSaveLocal').addEventListener('click', saveLocal)
    document.getElementById('btnLoad').addEventListener('click', load)
    container.addEventListener('scroll', render)

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('mouseleave', onMouseLeave)

    // Custom events for script editor tile/mark picking
    window.addEventListener('script-editor-pick-tile', (e) => {
      const { onTilePicked } = e.detail
      if (onTilePicked && tilePickerTool) {
        // Activate tile picker tool with temporary callback
        tilePickerTool.setCallback((info) => {
          onTilePicked(info.x, info.y)
          // Restore original callback after pick
          tilePickerTool.restoreCallback()
        })
        tilePickerTool.activate()
        document.getElementById('btnTilePicker').classList.add('active')
        // Don't call setTool('tilePicker') - it conflicts with direct activation
      }
    })

    window.addEventListener('script-editor-pick-mark', (e) => {
      const { onMarkPicked, map } = e.detail
      if (onMarkPicked && map) {
        // Show mark picker dialog
        showMarkPicker(map, onMarkPicked)
      }
    })
}

async function switchTileset(path) {
    tileset = await loadTileset(path)
    tileset.path = path
    tileset.priorityIndex = new Map(tileset.priority.map((id, i) => [id, i]))
    plainTileCache.clear()
    maskedTileCache.clear()
    rampShadowTileCache.clear()
    fenceShadowMaskCache.clear()
    fenceShadowTileCache.clear()
    if (waterAnimTimer) { clearTimeout(waterAnimTimer); waterAnimTimer = null }
    if (windAnimTimer)   { clearTimeout(windAnimTimer);   windAnimTimer  = null }
    if (effectAnimTimer) { clearTimeout(effectAnimTimer); effectAnimTimer = null }
    _objectFoamCache.clear()
    waterTilesetReady = false
    waterFrameMap = null
    if (tileset.waterTerrain) buildWaterFrames()
    sortedItemsDirty = true
    map = createMap(COLS, ROWS, tileset)

    // Reset map_enter preview
    showMapEnterPreview = false
    mapEnterPreviewData = null
    const previewBtn = document.getElementById('btnMapEnterPreview')
    if (previewBtn) {
        previewBtn.classList.remove('active')
        previewBtn.textContent = '👁️'
        previewBtn.title = 'Preview map_enter (initial state)'
    }

    activeTerrain = typeof tileset.waterTerrain?.waterFlat === 'number'
        ? tileset.waterTerrain.waterFlat
        : tileset.terrains[0].id
    if (layer === 'fence') { layer = 'terrain'; selectedFence = null }
    buildPalette()
    buildFencePalette()
    syncCursor()
    exposeEditor()
    invalidateStaticCache()
    updateSpacer()
    scheduleRender()
}

// --- Palette ---

function buildPalette() {
    const palette = document.getElementById('terrainPalette')
    palette.innerHTML = ''
    palette.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px'

    tileset.terrains.forEach(t => {
        const btn = document.createElement('canvas')
        btn.width = btn.height = TILE
        btn.title = t.name
        btn.style.cssText = `cursor:pointer;border:2px solid ${layer === 'terrain' && t.id === activeTerrain ? '#2a8ad4' : 'transparent'};border-radius:3px;width:100%;image-rendering:pixelated`

        const bctx = btn.getContext('2d')
        bctx.drawImage(t.img, 15 * TILE, 0, TILE, TILE, 0, 0, TILE, TILE)

        btn.addEventListener('click', () => {
            activeTerrain = t.id
            layer = 'terrain'
            setTool('paint')
            buildPalette()
            buildAssetPalette()
            buildFencePalette()
            syncCursor()
        })
        palette.appendChild(btn)
    })
}

function buildAssetPalette() {
    const palette = document.getElementById('assetPalette')
    palette.innerHTML = ''
    palette.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px'

    assets.forEach(a => {
        const ts = a.tileset
        const [tx, ty, tw, th] = a.region  // resolved from default state by assets.js

        const thumb = document.createElement('canvas')
        thumb.width = ts.size[0]
        thumb.height = ts.size[1]
        thumb.title = a.id
        thumb.style.cssText = `cursor:pointer;border:2px solid ${layer === 'decoration' && selectedAssets.includes(a.id) ? '#2a8ad4' : 'transparent'};border-radius:3px;width:100%;image-rendering:pixelated`

        const tctx = thumb.getContext('2d')
        tctx.drawImage(
            ts.img,
            tx * ts.size[0], ty * ts.size[1], tw * ts.size[0], th * ts.size[1],
            0, 0, ts.size[0], ts.size[1]
        )

        thumb.addEventListener('click', e => {
            if (e.ctrlKey) {
                const idx = selectedAssets.indexOf(a.id)
                if (idx === -1) selectedAssets.push(a.id)
                else selectedAssets.splice(idx, 1)
            } else {
                selectedAssets = [a.id]
            }
            layer = 'decoration'
            setTool('paint')
            buildPalette()
            buildAssetPalette()
            buildFencePalette()
            syncCursor()
        })

        palette.appendChild(thumb)
    })
}

// --- Fence palette ---

function buildFencePalette() {
    const palette = document.getElementById('fencePalette')
    if (!palette) return
    palette.innerHTML = ''
    const fences = tileset.fences ?? []
    if (fences.length === 0) return

    palette.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px'
    fences.forEach(f => {
        const btn = document.createElement('canvas')
        btn.width = btn.height = TILE
        btn.title = f.name
        btn.style.cssText = `cursor:pointer;border:2px solid ${layer === 'fence' && selectedFence === f.id ? '#2a8ad4' : 'transparent'};border-radius:3px;width:100%;image-rendering:pixelated`
        // Preview: straight horizontal run (LEFT=8 + RIGHT=4 = 12)
        btn.getContext('2d').drawImage(f.img, 12 * TILE, 0, TILE, TILE, 0, 0, TILE, TILE)
        btn.addEventListener('click', () => {
            selectedFence = f.id
            layer = 'fence'
            setTool('paint')
            buildPalette()
            buildAssetPalette()
            buildFencePalette()
            syncCursor()
        })
        palette.appendChild(btn)
    })
}

function buildEffectPalette() {
    const palette = document.getElementById('effectPalette')
    if (!palette) return
    palette.innerHTML = ''
    palette.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:4px'
    for (const [type, def] of Object.entries(EFFECT_DEFS)) {
        const btn = document.createElement('canvas')
        btn.width = btn.height = 32
        btn.title = type
        btn.style.cssText = `cursor:pointer;border:2px solid ${
            tool === 'effect' && activeEffectType === type ? '#2a8ad4' : 'transparent'
        };border-radius:3px;image-rendering:pixelated`
        if (def.img) btn.getContext('2d').drawImage(def.img, 0, (def.row ?? 0) * def.h, def.w, def.h, 0, 0, 32, 32)
        btn.addEventListener('click', () => {
            activeEffectType = type
            setTool('effect')
            buildEffectPalette()
        })
        palette.appendChild(btn)
    }
}

// --- Fence tool ---

function getFenceCornerFromEvent(e) {
    const rect = canvas.getBoundingClientRect()
    const wx = (e.clientX - rect.left + container.scrollLeft) / zoom
    const wy = (e.clientY - rect.top  + container.scrollTop)  / zoom
    return {
        cx: Math.max(0, Math.min(map.width,  Math.round(wx / TILE))),
        cy: Math.max(0, Math.min(map.height, Math.round(wy / TILE)))
    }
}

// Returns the horizontal and vertical edges that form an L-shape from start to end.
// Horizontal leg runs along start.cy, vertical leg runs along end.cx.
function getFenceDragEdges(start, end) {
    if (!start || !end) return { h: [], v: [] }
    const { cx: x0, cy: y0 } = start
    const { cx: x1, cy: y1 } = end
    const h = [], v = []
    const hx0 = Math.min(x0, x1), hx1 = Math.max(x0, x1)
    for (let cx = hx0; cx < hx1; cx++) h.push({ cx, cy: y0 })
    const vy0 = Math.min(y0, y1), vy1 = Math.max(y0, y1)
    for (let cy = vy0; cy < vy1; cy++) v.push({ cx: x1, cy })
    return { h, v }
}

function applyFenceTool(start, end) {
    if (!map || !start) return
    const { h, v } = getFenceDragEdges(start, end ?? start)
    if (tool === 'erase') {
        for (const { cx, cy } of h) removeHFence(map, cx, cy)
        for (const { cx, cy } of v) removeVFence(map, cx, cy)
    } else if (selectedFence) {
        for (const { cx, cy } of h) setHFence(map, cx, cy, selectedFence)
        for (const { cx, cy } of v) setVFence(map, cx, cy, selectedFence)
    }
    invalidateSortedItems()
    scheduleRender()
}

function drawFenceCursor() {
    if (!hoveredFenceCorner || !map) return
    const { cx, cy } = hoveredFenceCorner
    const color = tool === 'erase' ? 'rgba(255,80,80,0.9)' : 'rgba(255,255,255,0.85)'
    ctx.save()

    if (isPainting && fenceDragStart) {
        // Draw the L-shape preview along the drag path
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        const { h, v } = getFenceDragEdges(fenceDragStart, hoveredFenceCorner)
        ctx.beginPath()
        for (const { cx: ex, cy: ey } of h) {
            ctx.moveTo( ex      * TILE, ey * TILE)
            ctx.lineTo((ex + 1) * TILE, ey * TILE)
        }
        for (const { cx: ex, cy: ey } of v) {
            ctx.moveTo(ex * TILE,  ey      * TILE)
            ctx.lineTo(ex * TILE, (ey + 1) * TILE)
        }
        ctx.stroke()
        // Dot at start corner
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(fenceDragStart.cx * TILE, fenceDragStart.cy * TILE, 3, 0, Math.PI * 2)
        ctx.fill()
        // Dot at current corner
        ctx.beginPath()
        ctx.arc(cx * TILE, cy * TILE, 3, 0, Math.PI * 2)
        ctx.fill()
    } else {
        // Idle: small dot at the snapped corner
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(cx * TILE, cy * TILE, 3, 0, Math.PI * 2)
        ctx.fill()
    }
    ctx.restore()
}

// --- Marks ---

function applyMarkTool({ x, y }) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
    const key = `${x},${y}`
    if (map._marks[key] !== undefined) {
        delete map._marks[key]
    } else {
        const name = prompt(`Name for mark at (${x}, ${y}):`)?.trim()
        if (!name) return
        map._marks[key] = name
    }
    renderMarksList()
    scheduleRender()
}

function renderMarksList() {
    const list = document.getElementById('marksList')
    list.innerHTML = ''
    const entries = Object.entries(map._marks)
    if (entries.length === 0) {
        list.innerHTML = '<div class="marks-empty">No marks yet</div>'
        return
    }
    entries
        .sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(([key, name]) => {
            const [x, y] = key.split(',').map(Number)
            const row = document.createElement('div')
            row.className = 'marks-row'
            row.innerHTML = `
                <span class="marks-name" title="(${x},\u2009${y})">${name}</span>
                <span class="marks-coords">${x},${y}</span>
                <button class="marks-del" title="Remove mark">×</button>`
            row.querySelector('.marks-del').addEventListener('click', () => {
                delete map._marks[key]
                renderMarksList()
                scheduleRender()
            })
            row.querySelector('.marks-name').addEventListener('click', () => {
                // scroll to cell
                const tileSize = TILE * zoom
                container.scrollLeft = Math.max(0, x * tileSize - container.clientWidth / 2)
                container.scrollTop  = Math.max(0, y * tileSize - container.clientHeight / 2)
            })
            list.appendChild(row)
        })
}

function drawMarks() {
    if (!map._marks) return
    const { startX, startY, endX, endY } = getVisibleRange()
    ctx.save()

    for (const [key, name] of Object.entries(map._marks)) {
        const [mx, my] = key.split(',').map(Number)
        if (mx < startX - 1 || mx > endX + 1 || my < startY - 1 || my > endY + 1) continue

        const cx = mx * TILE + TILE / 2
        const cy = my * TILE + TILE / 2

        // Flag proportions (all in tile-space, zoom-independent)
        const poleH   = TILE * 0.72   // total pole height
        const poleBot = cy + TILE * 0.08  // pole bottom (slightly below center)
        const poleTop = poleBot - poleH
        const poleX   = cx - TILE * 0.04  // pole slightly left of center
        const flagW   = TILE * 0.34
        const flagH   = TILE * 0.22
        const lw      = Math.max(0.8, 1.5 / zoom)

        // Pole
        ctx.beginPath()
        ctx.moveTo(poleX, poleBot)
        ctx.lineTo(poleX, poleTop)
        ctx.strokeStyle = 'rgba(220,220,220,0.95)'
        ctx.lineWidth = lw * 1.2
        ctx.stroke()

        // Rectangular flag
        ctx.fillStyle = 'rgba(220, 40, 40, 0.93)'
        ctx.strokeStyle = 'rgba(160, 20, 20, 0.8)'
        ctx.lineWidth = lw * 0.6
        ctx.beginPath()
        ctx.rect(poleX, poleTop, flagW, flagH)
        ctx.fill()
        ctx.stroke()

        // Label
        const fs = Math.max(7, Math.round(9 / zoom))
        ctx.font = `bold ${fs}px sans-serif`
        const tw  = ctx.measureText(name).width
        const pad = Math.max(1.5, 2 / zoom)
        // Position label to the right of the flag, aligned to its top
        const lx = poleX + flagW + pad * 1.5
        const ly = poleTop - pad
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.beginPath()
        ctx.roundRect(lx - pad, ly, tw + pad * 2, fs + pad * 2, 2 / zoom)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(name, lx, ly + pad)
    }

    // Highlight cell under cursor when in mark tool
    if (tool === 'mark' && cursorX >= 0 && cursorY >= 0) {
        const key = `${cursorX},${cursorY}`
        const isMarked = map._marks[key] !== undefined
        ctx.strokeStyle = isMarked ? 'rgba(255,80,80,0.9)' : 'rgba(255,200,0,0.9)'
        ctx.lineWidth = 2 / zoom
        ctx.strokeRect(cursorX * TILE, cursorY * TILE, TILE, TILE)
    }
    ctx.restore()
}


function getRampCellFromEvent(e) {
    const rect = canvas.getBoundingClientRect()
    const tileSize = TILE * zoom
    const mx = (e.clientX - rect.left + container.scrollLeft) / tileSize
    const my = (e.clientY - rect.top  + container.scrollTop)  / tileSize
    const cx = Math.floor(mx)
    const cy = Math.floor(my)
    const fy = my - cy
    const T = 0.25
    // snap to the nearest horizontal border within threshold
    if (fy > 1 - T) return { x: cx, y: cy }      // bottom edge of current cell
    if (fy < T && cy > 0) return { x: cx, y: cy - 1 }  // top edge = bottom edge of row above
    return null
}

function isValidRamp(x, y) {
    if (y < 0 || y >= map.height - 1 || x < 0 || x >= map.width) return false
    return getHeight(map, x - 1, y) > getHeight(map, x - 1, y + 1) &&
           getHeight(map, x,     y) > getHeight(map, x,     y + 1) &&
           getHeight(map, x + 1, y) > getHeight(map, x + 1, y + 1)
}

function applyRampTool() {
    if (!hoveredRampCell) return
    const { x, y } = hoveredRampCell
    if (isValidRamp(x, y)) {
        const cur = getRamp(map, x, y)
        setRamp(map, x, y, !cur)
    } else {
        setRamp(map, x, y, false)
    }
    invalidateStaticCache()
    scheduleRender()
}

function cleanStaleRamps() {
    for (let y = 0; y < map.height - 1; y++)
        for (let x = 0; x < map.width; x++)
            if (getRamp(map, x, y) && !isValidRamp(x, y))
                setRamp(map, x, y, false)
}

function drawRampCursor() {
    if (!hoveredRampCell) return
    const { x, y } = hoveredRampCell
    if (y < 0 || y >= map.height - 1) return
    const existing = getRamp(map, x, y)
    const valid = isValidRamp(x, y)
    ctx.strokeStyle = existing ? 'rgba(255,60,60,0.9)' : valid ? 'rgba(60,255,60,0.9)' : 'rgba(128,128,128,0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(x * TILE,       (y + 1) * TILE)
    ctx.lineTo((x + 1) * TILE, (y + 1) * TILE)
    ctx.stroke()
}



function inBrush(dx, dy) {
    const r = brushSize - 1
    if (brushShape === 'square') return Math.abs(dx) <= r && Math.abs(dy) <= r
    return dx * dx + dy * dy <= r * r
}

function forEachBrushCell(cx, cy, callback) {
    const r = brushSize - 1
    for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
            if (inBrush(dx, dy)) callback(cx + dx, cy + dy)
}

const neighbors8 = (x, y) => [[x-1,y],[x+1,y],[x,y-1],[x,y+1],[x-1,y-1],[x+1,y-1],[x-1,y+1],[x+1,y+1]]

function setTool(t) {
    tool = t;
    ['Paint', 'Erase', 'Fill', 'Raise', 'Lower', 'Ramp', 'Mark', 'Select', 'Effect'].forEach(name => {
        document.getElementById(`btn${name}`).classList.remove('active')
    })
    document.getElementById(`btn${t.charAt(0).toUpperCase() + t.slice(1)}`).classList.add('active')
    if (t !== 'ramp') hoveredRampCell = null
    if (t !== 'select') {
        selectedDecoration = null
        selectedEffect = null
        isDraggingSelect = false
        selectDragItem = null
        selectPickCandidate = null
        updatePropPanel()
    }
    // Deactivate tile picker if active
    if (tilePickerTool?.isActive?.()) {
        tilePickerTool.deactivate()
        document.getElementById('btnTilePicker').classList.remove('active')
    }
}

// --- Tile Picker Tool ---
function toggleTilePicker() {
    if (!tilePickerTool) {
        tilePickerTool = createTilePickerTool({
            canvas,
            container,
            getZoom: () => zoom,
            getMap: () => map,
            onCoordsPicked: (info) => {
                tilePickerTool.lastPicked = info
                console.log('[TilePicker] Picked:', info)
            }
        })
    }

    if (tilePickerTool.isActive()) {
        tilePickerTool.deactivate()
        document.getElementById('btnTilePicker').classList.remove('active')
    } else {
        // Deactivate other tools
        setTool('paint')
        tilePickerTool.activate()
        document.getElementById('btnTilePicker').classList.add('active')
    }
}

// --- Script Panel (3-Panel System) ---
function toggleScriptPanel() {
    const btn = document.getElementById('btnScripts')
    const panelContainer = document.getElementById('scriptPanel')

    if (showScriptPanel) {
        // Hide panel
        showScriptPanel = false
        panelContainer.style.display = 'none'
        panelContainer.innerHTML = ''
        btn.classList.remove('active')
        // Reset panel references
        scriptFileManagerPanel = null
        scriptEventEditorPanel = null
        scriptActionEditorPanel = null
        scriptNestedActionEditorPanel = null
        // Reset script state
        scriptState.goToFileManager()
    } else {
        // Show panel
        showScriptPanel = true
        panelContainer.style.display = 'flex'
        panelContainer.style.cssText = `
            width: 380px;
            min-width: 320px;
            max-width: 500px;
            background: #1e1e1e;
            border-left: 1px solid #333;
            display: flex;
            flex-direction: column;
            height: 100%;
        `
        btn.classList.add('active')

        // Create all panels (they'll be shown/hidden by scriptState)
        scriptFileManagerPanel = createScriptFileManager({ map })
        scriptEventEditorPanel = createScriptEventEditor()
        scriptActionEditorPanel = createScriptActionEditor()
        scriptNestedActionEditorPanel = createScriptNestedActionEditor()

        panelContainer.appendChild(scriptFileManagerPanel)
        panelContainer.appendChild(scriptEventEditorPanel)
        panelContainer.appendChild(scriptActionEditorPanel)
        panelContainer.appendChild(scriptNestedActionEditorPanel)

        // Wire up scriptState callbacks
        scriptState.onPanelChange = (newMode, prevMode) => {
            // Hide all panels
            scriptFileManagerPanel?.hide()
            scriptEventEditorPanel?.hide()
            scriptActionEditorPanel?.hide()
            scriptNestedActionEditorPanel?.hide()

            // Show current panel
            switch (newMode) {
                case PANEL_MODE.FILE_MANAGER:
                    scriptFileManagerPanel?.show()
                    break
                case PANEL_MODE.EVENT_EDITOR:
                    scriptEventEditorPanel?.show()
                    break
                case PANEL_MODE.ACTION_EDITOR:
                    scriptActionEditorPanel?.show()
                    break
                case PANEL_MODE.NESTED_ACTION_EDITOR:
                    scriptNestedActionEditorPanel?.show()
                    break
            }
        }

        scriptState.onLoadFile = async (fileName) => {
            return await loadScriptFile(fileName)
        }

        scriptState.onSaveFile = async (fileName, events) => {
            return await saveScriptFile(fileName, events)
        }

        scriptState.onCreateFile = async (mapId) => {
            return await createScriptFileForMap(mapId)
        }

        scriptState.onSaveEvent = (event, index) => {
            // Event saved, refresh file manager
            scriptFileManagerPanel?.refresh()
        }

        scriptState.onDeleteEvent = (index) => {
            scriptFileManagerPanel?.refresh()
        }

        scriptState.onSaveAction = (action, parentContext) => {
            // Action saved, refresh event editor
            scriptEventEditorPanel?.renderActionsList?.(scriptState.currentEvent)
        }

        scriptState.onDeleteAction = (parentContext, index) => {
            scriptEventEditorPanel?.renderActionsList?.(scriptState.currentEvent)
        }

        // Start at file manager
        scriptFileManagerPanel.show()
    }
}

// --- Map Enter Preview ---
async function toggleMapEnterPreview() {
    const btn = document.getElementById('btnMapEnterPreview')

    if (showMapEnterPreview) {
        // Hide preview
        showMapEnterPreview = false
        mapEnterPreviewData = null
        btn.classList.remove('active')
        btn.title = 'Preview map_enter (initial state)'
        scheduleRender()
    } else {
        // Show preview - simulate map_enter
        if (!map) {
            alert('No map loaded')
            return
        }

        const mapId = map.id || currentMapName
        if (!mapId || mapId === 'untitled') {
            alert('Map must be saved with a name first')
            return
        }

        showMapEnterPreview = true
        btn.classList.add('active')
        btn.title = 'Hide map_enter preview'
        btn.textContent = '👁️'

        // Pre-load monster and item data for preview rendering
        await preloadMonsterImages()
        loadMonsterPreviewData()
        // Pre-load items data
        if (!window._itemsPreviewCache) {
            fetch('../assets/items.json').then(res => res.ok && res.json()).then(data => {
                window._itemsPreviewCache = data
            }).catch(e => {
                console.warn('[Editor] Failed to load items data for preview:', e)
                window._itemsPreviewCache = { items: {}, crafting: {} }
            })
        }

        // Run simulation
        mapEnterPreviewData = await simulateMapEnter(mapId)

        btn.textContent = '👁️'

        scheduleRender()
    }
}

/**
 * Simulate map_enter event actions to preview initial state
 * @param {string} mapId - Map identifier
 * @returns {Promise<Object>} Preview data with monsters, items, npcs, decorations, tileChanges
 */
async function simulateMapEnter(mapId) {
    // Load scripts for this map
    const { loadMapScripts } = await import('./scripts/scriptStorage.js')
    const scripts = await loadMapScripts(mapId)

    // Find map_enter event
    const mapEnterEvent = scripts.find(s => s.on === 'map_enter')
    if (!mapEnterEvent || !mapEnterEvent.actions) {
        return { monsters: [], items: [], npcs: [], decorations: [], tileChanges: [] }
    }

    // Import action schemas for field definitions
    const { ACTION_SCHEMAS } = await import('./scripts/actionSchemas.js')

    const previewData = {
        monsters: [],
        items: [],
        npcs: [],
        decorations: [],
        tileChanges: []
    }

    // Simulate each action (skip conditionals and pick_random)
    for (const action of mapEnterEvent.actions) {
        await simulateAction(action, previewData, ACTION_SCHEMAS)
    }

    return previewData
}

/**
 * Recursively simulate an action and its nested actions
 * @param {Object} action - Action to simulate
 * @param {Object} previewData - Preview data object to populate
 * @param {Object} ACTION_SCHEMAS - Action schemas for field defaults
 */
async function simulateAction(action, previewData, ACTION_SCHEMAS) {
    if (!action || !action.type) return

    const schema = ACTION_SCHEMAS[action.type]
    if (!schema) return

    // Skip conditionals and pick_random
    if (action.type === 'if' || action.type === 'pick_random') {
        return
    }

    // Get field values with defaults from schema
    const values = {}
    if (schema.fields) {
        for (const field of schema.fields) {
            values[field.name] = action[field.name] ?? field.default
        }
    }
    // Also copy any additional properties from action not in schema (for backward compatibility with old formats)
    for (const key of Object.keys(action)) {
        if (!(key in values)) {
            values[key] = action[key]
        }
    }

    switch (action.type) {
        case 'spawn_monster': {
            // Support both new positionPicker format {x, y, mark} and old format {x, y}
            const position = resolvePosition(values.position, map) ||
                           (values.x !== undefined && values.y !== undefined ? { x: values.x, y: values.y } : null)
            if (position) {
                previewData.monsters.push({
                    x: position.x,
                    y: position.y,
                    monster: values.monster,
                    id: values.id,
                    radius: values.radius ?? 0
                })
            }
            break
        }

        case 'spawn_item': {
            // Support both new positionPicker format {x, y, mark} and old format {x, y}
            const position = resolvePosition(values.position, map) ||
                           (values.x !== undefined && values.y !== undefined ? { x: values.x, y: values.y } : null)
            if (position) {
                previewData.items.push({
                    x: position.x,
                    y: position.y,
                    item_id: values.item_id,
                    qty: values.qty ?? 1
                })
            }
            break
        }

        case 'spawn_npc': {
            if (values.npc && values.x !== undefined && values.y !== undefined) {
                previewData.npcs.push({
                    x: values.x,
                    y: values.y,
                    npc: values.npc,
                    id: values.id,
                    flip_x: values.flip_x ?? false
                })
            }
            break
        }

        case 'spawn_decoration': {
            if (values.asset_id && values.x !== undefined && values.y !== undefined) {
                previewData.decorations.push({
                    x: values.x,
                    y: values.y,
                    asset_id: values.asset_id
                })
            }
            break
        }

        case 'change_tile': {
            const position = resolvePosition(values.tile, map) ||
                           (values.mark ? findMarkPosition(values.mark) : null) ||
                           (values.x !== undefined && values.y !== undefined ? { x: values.x, y: values.y } : null)
            if (position && values.terrain !== undefined) {
                previewData.tileChanges.push({
                    x: position.x,
                    y: position.y,
                    terrain: values.terrain
                })
            }
            break
        }

        case 'remove_decoration': {
            if (values.x !== undefined && values.y !== undefined) {
                previewData.tileChanges.push({
                    x: values.x,
                    y: values.y,
                    terrain: null, // null means remove decoration
                    removeDecoration: true
                })
            }
            break
        }
    }

    // Handle nested actions (then, else, branches, choices, actions)
    const nestedKeys = ['then', 'else', 'branches', 'choices', 'actions']
    for (const key of nestedKeys) {
        if (action[key] && Array.isArray(action[key])) {
            for (const nestedAction of action[key]) {
                await simulateAction(nestedAction, previewData, ACTION_SCHEMAS)
            }
        } else if (action[key] && action[key].type) {
            // Single nested action object
            await simulateAction(action[key], previewData, ACTION_SCHEMAS)
        }
    }
}

/**
 * Resolve position from various formats
 * @param {Object|Array} pos - Position object {x, y, mark} or tilePicker format {x, y}
 * @param {Object} map - Map object
 * @returns {Object|null} Resolved {x, y} or null
 */
function resolvePosition(pos, map) {
    if (!pos) return null

    // positionPicker format: {x, y, mark}
    if (pos.x !== undefined && pos.y !== undefined) {
        return { x: pos.x, y: pos.y }
    }

    // tilePicker format or direct x,y
    if (pos.x !== undefined && pos.y !== undefined) {
        return { x: pos.x, y: pos.y }
    }

    // mark format - would need mark lookup
    if (pos.mark && map._marks) {
        const markKey = Object.keys(map._marks).find(k => map._marks[k] === pos.mark)
        if (markKey) {
            const [x, y] = markKey.split(',').map(Number)
            return { x, y }
        }
    }

    return null
}

/**
 * Find position by mark name
 * @param {string} markName - Mark name
 * @returns {Object|null} Position {x, y} or null
 */
function findMarkPosition(markName) {
    if (!map || !map._marks) return null
    const markKey = Object.keys(map._marks).find(k => map._marks[k] === markName)
    if (markKey) {
        const [x, y] = markKey.split(',').map(Number)
        return { x, y }
    }
    return null
}

// Show mark picker dialog for script editor
function showMarkPicker(map, onMarkPicked) {
  const marks = Object.entries(map._marks ?? {})
  if (marks.length === 0) {
    alert('No named marks on this map. Add marks first using the Mark tool (M).')
    return
  }

  const modal = document.createElement('div')
  modal.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `
  modal.innerHTML = `
    <div style="
      background: #252526;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 16px;
      width: 350px;
      max-height: 80vh;
      overflow-y: auto;
      color: #e0e0e0;
    ">
      <h4 style="margin: 0 0 12px 0;">Select a Mark</h4>
      <div style="display: grid; gap: 4px; max-height: 300px; overflow-y: auto;">
        ${marks.map(([key, name]) => {
          const [x, y] = key.split(',').map(Number)
          return `<button data-x="${x}" data-y="${y}" data-name="${escapeHtml(name)}" style="
            padding: 10px;
            background: #2d2d2d;
            border: 1px solid #3a3a3a;
            border-radius: 3px;
            color: #e0e0e0;
            text-align: left;
            cursor: pointer;
            font-size: 12px;
          ">
            <strong>${escapeHtml(name)}</strong><br>
            <span style="font-size: 11px; color: #888;">Position: (${x}, ${y})</span>
          </button>`
        }).join('')}
      </div>
      <button id="mark-picker-cancel" style="
        margin-top: 16px;
        width: 100%;
        padding: 8px;
        background: #3a3a3a;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        cursor: pointer;
      ">Cancel</button>
    </div>
  `

  const cancelBtn = modal.querySelector('#mark-picker-cancel')
  const markButtons = modal.querySelectorAll('[data-x]')

  markButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const x = parseInt(btn.dataset.x, 10)
      const y = parseInt(btn.dataset.y, 10)
      const name = btn.dataset.name
      document.body.removeChild(modal)
      onMarkPicked(name, x, y)
    })
  })

  cancelBtn.addEventListener('click', () => document.body.removeChild(modal))
  modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal) })

  document.body.appendChild(modal)
}

function syncCursor() {
    canvas.style.cursor = ''
}

function getCellFromEvent(e) {
    const rect = canvas.getBoundingClientRect()
    const tileSize = TILE * zoom
    return {
        x: Math.floor((e.clientX - rect.left + container.scrollLeft) / tileSize),
        y: Math.floor((e.clientY - rect.top + container.scrollTop) / tileSize)
    }
}

function onMouseUp() {
    // Skip normal tool handling if tile picker is active
    if (tilePickerTool?.isActive?.()) return

    selectPickCandidate = null  // always clear pick candidate on release
    // Finish drag-to-move
    if (isDraggingSelect && selectDragItem) {
        if (selectDragItem.kind === 'decoration') {
            const { origX, origY } = selectDragItem
            const newX = cursorX, newY = cursorY
            const dec = map?._decorations[origY]?.[origX]
            if (dec && (newX !== origX || newY !== origY) &&
                newX >= 0 && newY >= 0 && newX < map.width && newY < map.height) {
                map._decorations[origY][origX] = null
                map._decorations[newY][newX] = dec
                dec.x = newX
                dec.y = newY
                selectedDecoration = { x: newX, y: newY }
                invalidateSortedItems()
            }
        } else if (selectDragItem.kind === 'effect') {
            const ef = map._effects[selectDragItem.index]
            if (ef && cursorX >= 0) {
                ef.x = cursorX
                ef.y = cursorY
                ef.dx = Math.round(cursorWx - (cursorX * TILE + TILE / 2))
                ef.dy = Math.round(cursorWy - (cursorY * TILE + TILE / 2))
                invalidateSortedItems()
            }
        }
        isDraggingSelect = false
        selectDragItem = null
        updatePropPanel()
        scheduleRender()
        return
    }
    if (layer === 'fence' && isPainting && fenceDragStart && hoveredFenceCorner) {
        applyFenceTool(fenceDragStart, hoveredFenceCorner)
    }
    isPainting = false
    raiseLockLevel = null
    fenceDragStart = null
}

function onMouseDown(e) {
    // Skip normal tool handling if tile picker is active
    if (tilePickerTool?.isActive?.()) return

    if (layer === 'fence') {
        isPainting = true
        fenceDragStart = hoveredFenceCorner ? { ...hoveredFenceCorner } : null
        scheduleRender()
        return
    }
    if (tool === 'select') {
        const { x, y } = getCellFromEvent(e)
        // Try to find an effect near click
        const efIdx = (map?._effects ?? []).findIndex(ef => {
            const { wx: ewx, wy: ewy } = effectWorld(ef)
            return Math.hypot(ewx - cursorWx, ewy - cursorWy) <= EFFECT_SNAP_DIST
        })
        if (efIdx >= 0) {
            selectedEffect = efIdx
            selectedDecoration = null
            selectPickCandidate = { kind: 'effect', index: efIdx }
            selectPickStartWx = cursorWx
            selectPickStartWy = cursorWy
            updatePropPanel()
            scheduleRender()
            return
        }
        // Try to find a decoration
        if (map?._decorations[y]?.[x]) {
            selectedDecoration = { x, y }
            selectedEffect = null
            selectPickCandidate = { kind: 'decoration', origX: x, origY: y }
            selectPickStartWx = cursorWx
            selectPickStartWy = cursorWy
            updatePropPanel()
            scheduleRender()
            return
        }
        // Click on empty — deselect
        selectedDecoration = null
        selectedEffect = null
        selectPickCandidate = null
        updatePropPanel()
        scheduleRender()
        return
    }
    if (tool === 'ramp') { applyRampTool(); return }
    if (tool === 'mark') { applyMarkTool(getCellFromEvent(e)); return }
    if (tool === 'effect') { applyEffectTool(e); return }
    isPainting = true
    applyTool(getCellFromEvent(e))
}

function onMouseMove(e) {
    // Skip normal tool handling if tile picker is active
    if (tilePickerTool?.isActive?.()) return

    const rect = canvas.getBoundingClientRect()
    cursorWx = (e.clientX - rect.left + container.scrollLeft) / zoom
    cursorWy = (e.clientY - rect.top  + container.scrollTop)  / zoom
    const { x, y } = getCellFromEvent(e)
    cursorX = x
    cursorY = y
    if (layer === 'fence') {
        hoveredFenceCorner = getFenceCornerFromEvent(e)
        scheduleRender()
        return
    }
    if (tool === 'ramp') {
        hoveredRampCell = getRampCellFromEvent(e)
        scheduleRender()
        return
    }
    if (tool === 'mark') { scheduleRender(); return }
    if (tool === 'select') {
        // Promote pick candidate to drag once mouse moves past threshold
        if (!isDraggingSelect && selectPickCandidate &&
            Math.hypot(cursorWx - selectPickStartWx, cursorWy - selectPickStartWy) >= SELECT_DRAG_THRESHOLD) {
            isDraggingSelect = true
            selectDragItem = selectPickCandidate
        }
        scheduleRender()
        return
    }
    if (isPainting) applyTool({ x, y })
    else scheduleRender()
}

function onMouseLeave() {
    cursorX = -1
    cursorY = -1
    hoveredRampCell = null
    hoveredFenceCorner = null
    fenceDragStart = null
    isDraggingSelect = false
    selectDragItem = null
    selectPickCandidate = null
    scheduleRender()
}

function applyEffectTool(e) {
    if (!map) return
    const rect = canvas.getBoundingClientRect()
    const wx = (e.clientX - rect.left + container.scrollLeft) / zoom
    const wy = (e.clientY - rect.top  + container.scrollTop)  / zoom
    // Remove if clicking near an existing effect
    const effects = map._effects
    for (let i = 0; i < effects.length; i++) {
        const { wx: ewx, wy: ewy } = effectWorld(effects[i])
        if (Math.hypot(ewx - wx, ewy - wy) <= EFFECT_SNAP_DIST) {
            effects.splice(i, 1)
            invalidateSortedItems()
            scheduleRender()
            return
        }
    }
    // Place new effect of active type
    const x = Math.floor(wx / TILE)
    const y = Math.floor(wy / TILE)
    const dx = Math.round(wx - (x * TILE + TILE / 2))
    const dy = Math.round(wy - (y * TILE + TILE / 2))
    effects.push({ type: activeEffectType, x, y, dx, dy, scale: 1, phase: Math.random() * 100000 })
    invalidateSortedItems()
    scheduleRender()
}

function isFrontCliff(map, x, y) {
    if (y === 0) return false
    return getHeight(map, x, y - 1) > getHeight(map, x, y) && !getRamp(map, x, y - 1)
}

function canPlaceAsset(asset, x, y) {
    if (isFrontCliff(map, x, y)) return false
    if (asset.surface.length === 0) return true   // no restriction
    const terrainId = getCell(map, x, y)
    const terrain = tileset.terrains[terrainId]
    const tags = terrain.tags ?? []
    return asset.surface.some(s => tags.includes(s))
}

function removeInvalidDecorations(affectedCells) {
    for (const [x, y] of affectedCells) {
        const d = map._decorations[y]?.[x]
        if (!d) continue
        const asset = assetMap[d.assetId]
        if (!asset) continue
        if (asset.surface.length === 0) continue
        const terrainId = getCell(map, x, y)
        const terrain = tileset.terrains[terrainId]
        const tags = terrain.tags ?? []
        if (!asset.surface.some(s => tags.includes(s)))
            removeDecoration(map, x, y)
    }
}

function applyTool({ x, y }) {
    if (tool === 'raise' || tool === 'lower') {
        const isRaise = tool === 'raise'
        const positions = []
        forEachBrushCell(x, y, (bx, by) => {
            if (bx >= 0 && by >= 0 && bx < map.width && by < map.height)
                positions.push([bx, by])
        })
        if (raiseLockLevel === null) {
            const ref = isRaise
                ? Math.min(...positions.map(([px, py]) => getHeight(map, px, py)))
                : Math.max(...positions.map(([px, py]) => getHeight(map, px, py)))
            if (isRaise && ref >= 4) return
            if (!isRaise && ref <= 0) return
            raiseLockLevel = isRaise ? ref + 1 : ref - 1
        }
        const targetLevel = raiseLockLevel
        const visited = new Set()
        const queue = []
        for (const [px, py] of positions) {
            const h = getHeight(map, px, py)
            if (isRaise ? h < targetLevel : h > targetLevel) {
                setHeight(map, px, py, targetLevel)
                visited.add(px + py * map.width)
                queue.push([px, py])
            }
        }
        while (queue.length > 0) {
            const [qx, qy] = queue.shift()
            const h = getHeight(map, qx, qy)
            for (const [nx, ny] of neighbors8(qx, qy)) {
                if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue
                const key = nx + ny * map.width
                if (visited.has(key)) continue
                const nh = getHeight(map, nx, ny)
                if (isRaise ? h - nh > 1 : nh - h > 1) {
                    visited.add(key)
                    setHeight(map, nx, ny, isRaise ? h - 1 : h + 1)
                    queue.push([nx, ny])
                }
            }
        }
        cleanStaleRamps()
        invalidateStaticCache()
        scheduleRender()
        return
    }

    if (layer === 'terrain') {
        const affected = []

        if (tool === 'paint' || tool === 'erase') {
            const terrainId = tool === 'paint' ? activeTerrain : tileset.baseTerrain.id
            forEachBrushCell(x, y, (bx, by) => {
                setCell(map, bx, by, terrainId)
                affected.push([bx, by])
            })
        } else if (tool === 'fill') {
            const oldId = getCell(map, x, y)
            floodFill(map, x, y, activeTerrain)
            // collect all filled cells
            for (let fy = 0; fy < map.height; fy++)
                for (let fx = 0; fx < map.width; fx++)
                    if (getCell(map, fx, fy) === activeTerrain && oldId !== activeTerrain)
                        affected.push([fx, fy])
        }

        removeInvalidDecorations(affected)
    } else if (layer === 'decoration') {
        if (tool === 'paint') paintDecorations(x, y)
        else if (tool === 'erase') {
            forEachBrushCell(x, y, (bx, by) => removeDecoration(map, bx, by))
        }
    }
    invalidateSortedItems()
    scheduleRender()
}

function getVisibleRange() {
    const tileSize = TILE * zoom
    const scrollX = container.scrollLeft
    const scrollY = container.scrollTop
    const viewW = container.clientWidth
    const viewH = container.clientHeight

    const startX = Math.max(0, Math.floor(scrollX / tileSize))
    const startY = Math.max(0, Math.floor(scrollY / tileSize))
    const endX = Math.min(map.width, Math.ceil((scrollX + viewW) / tileSize))
    const endY = Math.min(map.height, Math.ceil((scrollY + viewH) / tileSize))

    return { startX, startY, endX, endY, tileSize }
}

function updateSpacer() {
    const spacer = document.getElementById('mapSpacer')
    const tileSize = TILE * zoom
    spacer.style.width = map.width * tileSize + 'px'
    spacer.style.height = map.height * tileSize + 'px'
    spacer.style.position = 'absolute'
    spacer.style.top = '0'
    spacer.style.left = '0'
    spacer.style.zIndex = '0'
}

function paintDecorations(cx, cy) {
    if (selectedAssets.length === 0) return
    forEachBrushCell(cx, cy, (x, y) => {
        const id = selectedAssets[Math.floor(Math.random() * selectedAssets.length)]
        const asset = assetMap[id]
        if (!asset || !canPlaceAsset(asset, x, y)) return
        placeDecoration(map, id, x, y, asset.jitter, undefined, asset.flip, asset.scaleMin, asset.scaleMax)
    })
}

function drawBrushCursor() {
    if (cursorX < 0 || cursorY < 0) return
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.5
    forEachBrushCell(cursorX, cursorY, (x, y) => ctx.strokeRect(x * TILE, y * TILE, TILE, TILE))
}

function drawEffectCursor() {
    if (cursorX < 0) return
    const def = EFFECT_DEFS[activeEffectType]
    if (!def?.img) return
    const fi = Math.floor(performance.now() / (1000 / def.fps)) % def.frames
    // Highlight nearest existing effect (any type) — click will remove it
    const nearby = map?._effects?.find(ef => {
        const { wx, wy } = effectWorld(ef)
        return Math.hypot(wx - cursorWx, wy - cursorWy) <= EFFECT_SNAP_DIST
    })
    if (nearby) {
        const nd = EFFECT_DEFS[nearby.type]
        if (nd?.img) {
            const nfi = Math.floor(performance.now() / (1000 / nd.fps)) % nd.frames
            const { wx: nwx, wy: nwy } = effectWorld(nearby)
            ctx.save()
            ctx.drawImage(nd.img, nfi * nd.w, (nd.row ?? 0) * nd.h, nd.w, nd.h,
                nwx - nd.w / 2, nwy - nd.h, nd.w, nd.h)
            ctx.strokeStyle = 'rgba(255,80,80,0.9)'
            ctx.lineWidth = 2
            ctx.strokeRect(nwx - nd.w / 2, nwy - nd.h, nd.w, nd.h)
            ctx.restore()
        }
    } else {
        ctx.globalAlpha = 0.6
        ctx.drawImage(def.img, fi * def.w, (def.row ?? 0) * def.h, def.w, def.h,
            cursorWx - def.w / 2, cursorWy - def.h, def.w, def.h)
        ctx.globalAlpha = 1
    }
}

function drawGrid() {
    const { startX, startY, endX, endY } = getVisibleRange()
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let x = startX; x <= endX; x++) {
        ctx.moveTo(x * TILE, startY * TILE)
        ctx.lineTo(x * TILE, endY * TILE)
    }
    for (let y = startY; y <= endY; y++) {
        ctx.moveTo(startX * TILE, y * TILE)
        ctx.lineTo(endX * TILE, y * TILE)
    }
    ctx.stroke()

    if (showCoords) {
        ctx.font = `${12 / zoom}px monospace`
        ctx.textBaseline = 'top'
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const label = `${x},${y}`
                const tx = x * TILE + 2 / zoom
                const ty = y * TILE + 2 / zoom
                ctx.fillStyle = 'rgba(0,0,0,0.55)'
                ctx.fillText(label, tx + 1 / zoom, ty + 1 / zoom)
                ctx.fillStyle = 'rgba(255,255,255,0.85)'
                ctx.fillText(label, tx, ty)
            }
        }
    }
}

const silhouetteCache = new Map()
const fenceShadowMaskCache = new Map()  // fenceId:tileIdx  → T×T black silhouette canvas
const fenceShadowTileCache = new Map()  // fenceId:bits     → 3T×3T pre-rendered shadow canvas

function getDecorationState(d, asset) {
    const stateId = d.stateId ?? asset.defaultState
    return asset.states.find(s => s.id === stateId) ?? asset.states[0]
}

function getSilhouetteCanvas(asset, stateId) {
  const key = asset.id + ':' + (stateId ?? asset.defaultState)
  if (silhouetteCache.has(key)) return silhouetteCache.get(key)

  const ts = asset.tileset
  const state = asset.states.find(s => s.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
  const [tx, ty, tw, th] = state.region
  const srcW = tw * ts.size[0]
  const srcH = th * ts.size[1]

  const sil  = document.createElement('canvas')
  sil.width  = srcW
  sil.height = srcH
  const sctx = sil.getContext('2d')
  sctx.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], srcW, srcH, 0, 0, srcW, srcH)
  sctx.globalCompositeOperation = 'source-in'
  sctx.fillStyle = '#000'
  sctx.fillRect(0, 0, srcW, srcH)

  silhouetteCache.set(key, sil)
  return sil
}

// ── Fence shadow helpers ─────────────────────────────────────────────────────

function getFenceSilhouette(fenceDef, fenceId, tileIdx) {
    const key = fenceId + ':' + tileIdx
    if (fenceShadowMaskCache.has(key)) return fenceShadowMaskCache.get(key)
    const m = document.createElement('canvas'); m.width = m.height = TILE
    const mc = m.getContext('2d')
    mc.drawImage(fenceDef.img, tileIdx * TILE, 0, TILE, TILE, 0, 0, TILE, TILE)
    mc.globalCompositeOperation = 'source-in'
    mc.fillStyle = '#000'
    mc.fillRect(0, 0, TILE, TILE)
    fenceShadowMaskCache.set(key, m)
    return m
}

function getFenceShadowCanvas(fenceDef, fenceId, bits) {
    const key = fenceId + ':' + bits
    if (fenceShadowTileCache.has(key)) return fenceShadowTileCache.get(key)

    const sc = document.createElement('canvas')
    sc.width  = FENCE_SHADOW_CW
    sc.height = FENCE_SHADOW_CH
    const sctx = sc.getContext('2d')

    const gx = FENCE_SHADOW_GX, gy = FENCE_SHADOW_GY
    const ox = FENCE_SHADOW_OX, oy = FENCE_SHADOW_OY

    // Reference masks: tile12 for LEFT+RIGHT, tile4 for RIGHT-only, tile8 for LEFT-only
    const maskLR  = getFenceSilhouette(fenceDef, fenceId,
        (bits & 0b1100) === 0b1100 ? 12 : (bits & 0b0100) ? 4 : 8)
    const maskTop = getFenceSilhouette(fenceDef, fenceId, 8)
    const maskBot = getFenceSilhouette(fenceDef, fenceId, 4)

    // Pass 1: LEFT / RIGHT shadow (flip + skew around ground point)
    if (bits & 0b1100) {
        sctx.save()
        sctx.translate(ox + gx, oy + gy)
        sctx.scale(1, -FENCE_SHADOW_SCALE)
        sctx.transform(1, 0, FENCE_SHADOW_SKEW, 1, 0, 0)
        sctx.drawImage(maskLR, -gx, -gy)
        sctx.restore()
    }

    // Pass 2: TOP shadow — y=x canvas reflection around pivot, then flip+skew
    if (bits & 0b0010) {
        const px = ox + gx, py = oy + gy
        sctx.save()
        sctx.transform(0, 1, 1, 0, px - py, py - px)
        sctx.translate(px, py)
        sctx.scale(1, -FENCE_SHADOW_SCALE)
        sctx.transform(1, 0, FENCE_SHADOW_SKEW, 1, 0, 0)
        sctx.drawImage(maskTop, -gx, -gy)
        sctx.restore()
    }

    // Pass 3: BOTTOM shadow — same y=x canvas reflection
    if (bits & 0b0001) {
        const px = ox + gx, py = oy + gy
        sctx.save()
        sctx.transform(0, 1, 1, 0, px - py, py - px)
        sctx.translate(px, py)
        sctx.scale(1, -FENCE_SHADOW_SCALE)
        sctx.transform(1, 0, FENCE_SHADOW_SKEW, 1, 0, 0)
        sctx.drawImage(maskBot, -gx, -gy)
        sctx.restore()
    }

    fenceShadowTileCache.set(key, sc)
    return sc
}

function drawShadow(targetCtx, d, asset, fi = 0) {
  const s = asset.shadow
  if (s.type === 'oval')        drawOvalShadow(targetCtx, d, asset)
  else if (s.type === 'sprite') drawSpriteShadow(targetCtx, d, asset, fi)
  else if (s.type === 'skew')   drawSkewShadow(targetCtx, d, asset, fi)
  else if (s.type === 'ray')    drawRayTracedShadow(targetCtx, d, asset, fi)
}

function drawOvalShadow(targetCtx, d, asset) {
  const cx = d.x * TILE + TILE / 2 + d.dx
  const cy = d.y * TILE + TILE / 2 + d.dy
  targetCtx.fillStyle = '#000'
  targetCtx.beginPath()
  targetCtx.ellipse(cx, cy, asset.shadow.rx, asset.shadow.ry, 0, 0, Math.PI * 2)
  targetCtx.fill()
}

function drawSpriteShadow(targetCtx, d, asset, fi = 0) {
  const sil = (asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0)
    ? getWindSilhouetteCanvas(asset, d.stateId, asset.wind, fi)
    : getSilhouetteCanvas(asset, d.stateId)
  const [px, py] = asset.pivot
  const ts = asset.tileset
  const state = getDecorationState(d, asset)
  const [,, tw, th] = state.region
  const dstW = tw * ts.size[0]
  const dstH = th * ts.size[1]
  const worldX = d.x * TILE + TILE / 2 + d.dx
  const worldY = d.y * TILE + TILE / 2 + d.dy
  targetCtx.save()
  targetCtx.translate(worldX + asset.shadow.d, worldY + asset.shadow.d)
  if (d.flipX) targetCtx.scale(-1, 1)
  targetCtx.drawImage(sil, -px * dstW, -py * dstH)
  targetCtx.restore()
}

function drawSkewShadow(targetCtx, d, asset, fi = 0) {
  const windActive = asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0
  const sil = windActive
    ? getWindSilhouetteCanvas(asset, d.stateId, asset.wind, fi)
    : getSilhouetteCanvas(asset, d.stateId)
  const [px, py] = asset.pivot
  const ts = asset.tileset
  const state = getDecorationState(d, asset)
  const [,, tw, th] = state.region
  const dstW = tw * ts.size[0]
  const dstH = th * ts.size[1]
  const worldX = d.x * TILE + TILE / 2 + d.dx
  const worldY = d.y * TILE + TILE / 2 + d.dy
  const dstX = worldX - px * dstW
  const dstY = worldY - py * dstH
  targetCtx.save()
  targetCtx.translate(dstX, dstY)
  targetCtx.transform(1, 0, -SKEW_SHADOW_SKEW, -SKEW_SHADOW_SCALE,
    py * dstH * SKEW_SHADOW_SKEW,
    py * dstH * (1 + SKEW_SHADOW_SCALE))
  if (d.flipX) {
    // Flip silhouette around the pivot X before skewing — works correctly even with biased wind
    targetCtx.translate(px * dstW, 0)
    targetCtx.scale(-1, 1)
    targetCtx.translate(-px * dstW, 0)
  }
  targetCtx.drawImage(sil, 0, 0)
  targetCtx.restore()
}

// ── RAY TRACED SHADOW ────────────────────────────
const rayTracedShadowCache = new Map()

function computeRayTracedShadow(asset, stateId) {
  const s = asset.shadow
  const ts = asset.tileset
  const state = asset.states.find(st => st.id === (stateId ?? asset.defaultState)) ?? asset.states[0]
  const [tx, ty, tw, th] = state.region
  const sw = tw * ts.size[0]
  const sh = th * ts.size[1]
  const angleRad = s.angle * Math.PI / 180
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad)
  const length = s.length

  const extraR = cos > 0 ? Math.ceil(cos * length) : 0
  const extraL = cos < 0 ? Math.ceil(-cos * length) : 0
  const extraB = sin > 0 ? Math.ceil(sin * length) : 0
  const extraT = sin < 0 ? Math.ceil(-sin * length) : 0

  const src = document.createElement('canvas')
  src.width = sw; src.height = sh
  const srcCtx = src.getContext('2d')
  srcCtx.drawImage(ts.img, tx * ts.size[0], ty * ts.size[1], sw, sh, 0, 0, sw, sh)
  const data = srcCtx.getImageData(0, 0, sw, sh).data

  const isSolid = (x, y) => x >= 0 && x < sw && y >= 0 && y < sh && data[(y * sw + x) * 4 + 3] > 10

  const out = document.createElement('canvas')
  out.width  = sw + extraL + extraR
  out.height = sh + extraT + extraB
  const ctx = out.getContext('2d')
  ctx.fillStyle = 'rgb(0,0,0)'

  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      if (!isSolid(px, py)) continue
      let isEdge = false
      outer: for (let ny = -1; ny <= 1; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          if (nx === 0 && ny === 0) continue
          if (!isSolid(px + nx, py + ny)) { isEdge = true; break outer }
        }
      }
      if (!isEdge) continue
      for (let step = 0.5; step <= length; step += 0.5) {
        ctx.fillRect(Math.round(extraL + px + cos * step), Math.round(extraT + py + sin * step), 1, 1)
      }
    }
  }

  return { canvas: out, ox: -extraL, oy: -extraT }
}

function getRayTracedShadowCanvas(asset, stateId) {
  const key = asset.id + ':' + (stateId ?? asset.defaultState)
  if (rayTracedShadowCache.has(key)) return rayTracedShadowCache.get(key)
  const result = computeRayTracedShadow(asset, stateId)
  rayTracedShadowCache.set(key, result)
  return result
}

function drawRayTracedShadow(targetCtx, d, asset, fi = 0) {
  const [px, py] = asset.pivot
  const ts = asset.tileset
  const state = getDecorationState(d, asset)
  const [,, tw, th] = state.region
  const dstW = tw * ts.size[0]
  const dstH = th * ts.size[1]
  const worldX = d.x * TILE + TILE / 2 + d.dx
  const worldY = d.y * TILE + TILE / 2 + d.dy
  const windActive = asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0
  const dstX = worldX - px * dstW
  const dstY = worldY - py * dstH
  const shadow = windActive
    ? getWindRayTracedFrameCanvas(asset, d.stateId, asset.wind, fi)
    : getRayTracedShadowCanvas(asset, d.stateId)
  if (d.flipX) {
    // Mirror the shadow around the tree's world X — correct for any wind shape, including biased
    targetCtx.save()
    targetCtx.translate(worldX, 0)
    targetCtx.scale(-1, 1)
    targetCtx.translate(-worldX, 0)
    targetCtx.drawImage(shadow.canvas, dstX + shadow.ox, dstY + shadow.oy)
    targetCtx.restore()
  } else {
    targetCtx.drawImage(shadow.canvas, dstX + shadow.ox, dstY + shadow.oy)
  }
}

// --- Render ---

function invalidateSortedItems() { sortedItemsDirty = true; invalidateStaticCache() }

function rebuildSortedItems() {
    sortedItems = []
    if (!map) { sortedItemsDirty = false; return }

    const { startX, startY, endX, endY } = getVisibleRange()
    const MARGIN = 1
    const x0 = startX - MARGIN,           y0 = startY - MARGIN
    const x1 = endX   + MARGIN,           y1 = endY   + MARGIN
    const dx0 = Math.max(0, x0),          dy0 = Math.max(0, y0)
    const dx1 = Math.min(map.width - 1, x1), dy1 = Math.min(map.height - 1, y1)

    for (let y = dy0; y <= dy1; y++) {
        for (let x = dx0; x <= dx1; x++) {
            const d = map._decorations[y][x]
            if (d) sortedItems.push({ fence: false, d, sortY: d.y * 2 + 1 + (d.dy || 0) / TILE })
        }
    }
    if (tileset.fenceMap) {
        const cx0 = Math.max(0, x0),          cy0 = Math.max(0, y0)
        const cx1 = Math.min(map.width,  x1), cy1 = Math.min(map.height, y1)
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const hasEdge =
                    (cx > 0          && map._hFences[cy]?.[cx - 1]) ||
                    (cx < map.width  && map._hFences[cy]?.[cx])     ||
                    (cy > 0          && map._vFences[cy - 1]?.[cx]) ||
                    (cy < map.height && map._vFences[cy]?.[cx])
                if (hasEdge)
                    sortedItems.push({ fence: true, cx, cy, sortY: cy * 2 })
            }
        }
    }
    for (const ef of (map._effects ?? []))
        if (ef.x >= x0 && ef.x <= x1 && ef.y >= y0 && ef.y <= y1)
            sortedItems.push({ effect: true, ef, sortY: ef.y * 2 + 1 })

    sortedItems.sort((a, b) => a.sortY - b.sortY)
    sortedItemsDirty = false
}

function effectWorld(ef) {
    return {
        wx: ef.x * TILE + TILE / 2 + (ef.dx ?? 0),
        wy: ef.y * TILE + TILE / 2 + (ef.dy ?? 0)
    }
}

function renderEffect(ef) {
    const def = EFFECT_DEFS[ef.type]
    if (!def?.img) return
    const fi = Math.floor((performance.now() + (ef.phase ?? 0)) / (1000 / def.fps)) % def.frames
    const scale = ef.scale ?? 1
    const w = def.w * scale, h = def.h * scale
    const { wx, wy } = effectWorld(ef)
    ctx.drawImage(def.img, fi * def.w, (def.row ?? 0) * def.h, def.w, def.h, wx - w / 2, wy - h, w, h)
}

function renderDecorationsAndTops() {
    if (!map) return
    const { startX, startY, endX, endY } = getVisibleRange()

    // Draw terrain tops first (walls behind decorations)
    const topTerrains = tileset.terrains.filter(t => t.topImg)
    if (topTerrains.length > 0) {
        const rxStart = Math.max(0, startX)
        const ryStart = Math.max(0, startY)
        const rxEnd = Math.min(map.width + 1, endX + 1)
        const ryEnd = Math.min(map.height + 1, endY + 1)

        for (let ry = ryStart; ry < ryEnd; ry++) {
            for (let rx = rxStart; rx < rxEnd; rx++) {
                const tl = getRaw(map, rx,     ry)
                const tr = getRaw(map, rx + 1, ry)
                const bl = getRaw(map, rx,     ry + 1)
                const br = getRaw(map, rx + 1, ry + 1)
                const px = (rx - 1) * TILE + TILE / 2
                const py = (ry - 1) * TILE + TILE / 2

                for (const terrain of topTerrains) {
                    const id = terrain.id
                    const mask = ((tl === id ? 1 : 0) << 3) | ((tr === id ? 1 : 0) << 2)
                               | ((bl === id ? 1 : 0) << 1) |  (br === id ? 1 : 0)
                    if (mask === 0 || mask > 3 && mask !== 7 && mask !== 11) continue
                    const variant = tileHash(rx, ry) % terrain.variants
                    ctx.drawImage(terrain.topImg, mask * TILE, variant * TILE, TILE, TILE, px, py - TILE, TILE, TILE)
                }
            }
        }
    }

    // Rebuild sorted item list only when map structure has changed
    if (sortedItemsDirty) rebuildSortedItems()

    // Draw decorations and fence corners in painter's-algorithm order,
    // filtering to the visible viewport
    for (const item of sortedItems) {
        if (item.effect) {
            // Skip if currently being dragged — drawDraggedItem renders it at cursor instead
            if (isDraggingSelect && selectDragItem?.kind === 'effect' &&
                map._effects[selectDragItem.index] === item.ef) continue
            renderEffect(item.ef)
            continue
        }
        if (item.fence) {
            const { cx, cy } = item
            if (cx < startX || cx > endX + 1 || cy < startY || cy > endY + 1) continue
            // Collect all fence types and their bitmasks for this corner
            const types = new Set()
            if (cx > 0          && map._hFences[cy]?.[cx - 1]) types.add(map._hFences[cy][cx - 1])
            if (cx < map.width  && map._hFences[cy]?.[cx])     types.add(map._hFences[cy][cx])
            if (cy > 0          && map._vFences[cy - 1]?.[cx]) types.add(map._vFences[cy - 1][cx])
            if (cy < map.height && map._vFences[cy]?.[cx])     types.add(map._vFences[cy][cx])

            // Resolve bits per type, then draw in two passes so horizontal (L/R) always lands on top
            const entries = []
            for (const fenceId of types) {
                const fenceDef = tileset.fenceMap[fenceId]
                if (!fenceDef) continue
                let bits = 0
                if (cx > 0          && map._hFences[cy]?.[cx - 1] === fenceId) bits |= 8  // LEFT
                if (cx < map.width  && map._hFences[cy]?.[cx]     === fenceId) bits |= 4  // RIGHT
                if (cy > 0          && map._vFences[cy - 1]?.[cx] === fenceId) bits |= 2  // TOP
                if (cy < map.height && map._vFences[cy]?.[cx]     === fenceId) bits |= 1  // BOTTOM
                entries.push({ fenceDef, bits })
            }
            // Pass 1: vertical-only (no H bits) — drawn beneath
            for (const { fenceDef, bits } of entries)
                if (!(bits & 0b1100))
                    ctx.drawImage(fenceDef.img, bits * TILE, 0, TILE, TILE,
                        cx * TILE - TILE / 2, cy * TILE - TILE / 2 + FENCE_OFFSET_Y, TILE, TILE)
            // Pass 2: has horizontal bits — drawn on top
            for (const { fenceDef, bits } of entries)
                if (bits & 0b1100)
                    ctx.drawImage(fenceDef.img, bits * TILE, 0, TILE, TILE,
                        cx * TILE - TILE / 2, cy * TILE - TILE / 2 + FENCE_OFFSET_Y, TILE, TILE)
            continue
        }

        const { d } = item
            if (d.x < startX || d.x >= endX || d.y < startY || d.y >= endY) continue
            const asset = assetMap[d.assetId]
        if (!asset) continue

        const ts = asset.tileset
        const state = getDecorationState(d, asset)
        const [tx, ty, tw, th] = state.region
        const [px, py] = asset.pivot

        const srcX = tx * ts.size[0]
        const srcY = ty * ts.size[1]
        const srcW = tw * ts.size[0]
        const srcH = th * ts.size[1]

        const dstW = srcW
        const dstH = srcH

        const worldX = d.x * TILE + TILE / 2 + d.dx
        const worldY = d.y * TILE + TILE / 2 + d.dy

        ctx.save()
        ctx.translate(worldX, worldY)
        if (d.flipX) ctx.scale(-1, 1)
        if (d.scale && d.scale !== 1) ctx.scale(d.scale, d.scale)
        if (asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0) {
            const sheet = getWindSpriteSheet(asset, d.stateId, asset.wind)
            const fi = getWindFrame(asset.wind[0], d._windPhase ?? (d._windPhase = Math.random() * 100000))
            ctx.drawImage(sheet, fi * srcW, 0, srcW, srcH, -px * dstW, -py * dstH, dstW, dstH)
        } else {
            ctx.drawImage(ts.img, srcX, srcY, srcW, srcH, -px * dstW, -py * dstH, dstW, dstH)
        }
        ctx.restore()
    }
}

async function renderMapEnterPreview() {
    if (!mapEnterPreviewData || !map) return

    const { startX, startY, endX, endY } = getVisibleRange()

    // Render preview tile changes (terrain changes)
    if (mapEnterPreviewData.tileChanges.length > 0) {
        for (const change of mapEnterPreviewData.tileChanges) {
            if (change.x < startX || change.x >= endX || change.y < startY || change.y >= endY) continue

            const terrainId = (typeof change.terrain === 'string')
                ? ((tileset.terrains.find(t => t.name === change.terrain)?.id ?? parseInt(change.terrain)) || 0)
                : (change.terrain ?? 0)

            if (change.removeDecoration) {
                // Show a subtle marker for removed decoration
                ctx.save()
                ctx.globalAlpha = 0.5
                ctx.fillStyle = '#ff4444'
                ctx.fillRect(change.x * TILE + 4, change.y * TILE + 4, TILE - 8, TILE - 8)
                ctx.restore()
            } else if (terrainId !== undefined) {
                // Draw the changed terrain
                const terrain = tileset.terrains.find(t => t.id === terrainId)
                if (terrain) {
                    ctx.drawImage(terrain.img, 15 * TILE, 0, TILE, TILE, change.x * TILE, change.y * TILE, TILE, TILE)
                }
            }
        }
    }

    // Render preview decorations
    if (mapEnterPreviewData.decorations.length > 0) {
        for (const deco of mapEnterPreviewData.decorations) {
            if (deco.x < startX || deco.x >= endX || deco.y < startY || deco.y >= endY) continue

            const asset = assetMap[deco.asset_id]
            if (!asset) continue

            const ts = asset.tileset
            const state = asset.states[0] // Use default state
            const [tx, ty, tw, th] = state.region
            const [px, py] = asset.pivot

            const srcX = tx * ts.size[0]
            const srcY = ty * ts.size[1]
            const srcW = tw * ts.size[0]
            const srcH = th * ts.size[1]
            const dstW = srcW
            const dstH = srcH

            const worldX = deco.x * TILE + TILE / 2
            const worldY = deco.y * TILE + TILE / 2

            ctx.save()
            ctx.globalAlpha = 0.7 // Semi-transparent to indicate preview
            ctx.translate(worldX, worldY)
            ctx.drawImage(ts.img, srcX, srcY, srcW, srcH, -px * dstW, -py * dstH, dstW, dstH)
            ctx.restore()
        }
    }

    // Render preview items
    if (mapEnterPreviewData.items.length > 0) {
        for (const item of mapEnterPreviewData.items) {
            if (item.x < startX || item.x >= endX || item.y < startY || item.y >= endY) continue

            // Get item icon from items.json
            // For now, draw a simple placeholder
            const worldX = item.x * TILE + TILE / 2
            const worldY = item.y * TILE + TILE / 2

            ctx.save()
            ctx.globalAlpha = 0.8
            ctx.fillStyle = '#ffd700'
            ctx.beginPath()
            ctx.arc(worldX, worldY, 8, 0, Math.PI * 2)
            ctx.fill()
            ctx.strokeStyle = '#b8860b'
            ctx.lineWidth = 1
            ctx.stroke()
            // Draw quantity if > 1
            if (item.qty > 1) {
                ctx.fillStyle = '#000'
                ctx.font = 'bold 10px sans-serif'
                ctx.textAlign = 'center'
                ctx.textBaseline = 'middle'
                ctx.fillText(item.qty.toString(), worldX, worldY + 1)
            }
            ctx.restore()
        }
    }

    // Render preview NPCs
    if (mapEnterPreviewData.npcs.length > 0) {
        for (const npc of mapEnterPreviewData.npcs) {
            if (npc.x < startX || npc.x >= endX || npc.y < startY || npc.y >= endY) continue

            // Draw NPC as a simple colored rectangle for now
            // In a full implementation, this would use the NPC sprite
            const worldX = npc.x * TILE + TILE / 2
            const worldY = npc.y * TILE + TILE / 2

            ctx.save()
            ctx.globalAlpha = 0.7
            ctx.fillStyle = '#44ff44'
            ctx.fillRect(worldX - 12, worldY - 24, 24, 24)
            ctx.strokeStyle = '#228822'
            ctx.lineWidth = 1
            ctx.strokeRect(worldX - 12, worldY - 24, 24, 24)
            ctx.restore()
        }
    }

    // Render preview monsters
    renderPreviewMonsters(ctx, startX, startY, endX, endY)

    // Render preview items with actual sprites
    await renderPreviewItems(ctx, startX, startY, endX, endY)
}

// Monster data cache for preview rendering
let monsterPreviewDataCache = null

async function loadMonsterPreviewData() {
    if (monsterPreviewDataCache) return monsterPreviewDataCache
    try {
        const res = await fetch('../characters/enemies.json')
        if (!res.ok) throw new Error('Failed to load enemies.json')
        monsterPreviewDataCache = await res.json()
        return monsterPreviewDataCache
    } catch (e) {
        console.warn('[Editor] Failed to load monster data for preview:', e)
        return []
    }
}

function findMonsterDefByName(name) {
    if (!monsterPreviewDataCache) return null
    return monsterPreviewDataCache.find(m => m.name === name) || null
}

function renderPreviewMonsters(ctx, startX, startY, endX, endY) {
    if (!mapEnterPreviewData || !mapEnterPreviewData.monsters.length) return

    for (const monster of mapEnterPreviewData.monsters) {
        if (monster.x < startX || monster.x >= endX || monster.y < startY || monster.y >= endY) continue

        const worldX = monster.x * TILE + TILE / 2
        const worldY = monster.y * TILE + TILE / 2

        // Draw full composite monster (body + hands + weapons) using shared module
        const monsterDef = findMonsterDefByName(monster.monster)
        if (monsterDef) {
            // Check if character sprite is available
            const charSprite = getCharacterSprite(monsterDef.charName)
            if (charSprite) {
                // drawCompositeEnemy draws centered at (16*scale, 16*scale) from current transform origin
                // For scale=1, it draws centered at (16, 16). We want it centered at (worldX, worldY).
                // So translate to (worldX - 16, worldY - 16) before calling.
                ctx.save()
                ctx.globalAlpha = 0.7
                ctx.translate(worldX - 16, worldY - 16)
                drawCompositeEnemy(ctx, monsterDef, 1)
                ctx.restore()
            } else {
                // Fallback to simple preview if sprite not loaded
                drawMonsterPreview(ctx, monster.monster, worldX, worldY, 1, 0.7)
            }
        } else {
            // Fallback to simple preview if monster not found
            drawMonsterPreview(ctx, monster.monster, worldX, worldY, 1, 0.7)
        }

        // Draw radius indicator if specified
        if (monster.radius > 0) {
            ctx.save()
            ctx.strokeStyle = 'rgba(255, 68, 68, 0.3)'
            ctx.lineWidth = 1
            ctx.setLineDash([4, 4])
            ctx.beginPath()
            ctx.arc(worldX, worldY, monster.radius * TILE, 0, Math.PI * 2)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.restore()
        }
    }
}

async function renderPreviewItems(ctx, startX, startY, endX, endY) {
    if (!mapEnterPreviewData || !mapEnterPreviewData.items.length) return

    // Load items data if not already cached
    if (!window._itemsPreviewCache) {
        try {
            const res = await fetch('../assets/items.json')
            if (res.ok) {
                window._itemsPreviewCache = await res.json()
            }
        } catch (e) {
            console.warn('[Editor] Failed to load items data for preview:', e)
            window._itemsPreviewCache = { items: {}, crafting: {} }
        }
    }
    const itemsData = window._itemsPreviewCache || { items: {}, crafting: {} }

    // Build lookup for item icons - items.json has { "itemName": [x,y] } or { "itemName": { icon: [x,y], ... } }
    const itemIconMap = {}
    if (itemsData.items) {
        for (const [name, def] of Object.entries(itemsData.items)) {
            if (Array.isArray(def)) {
                itemIconMap[name] = { icon: def }
            } else if (def && def.icon) {
                itemIconMap[name] = def
            }
        }
    }
    if (itemsData.crafting) {
        for (const [name, def] of Object.entries(itemsData.crafting)) {
            if (Array.isArray(def)) {
                itemIconMap[name] = { icon: def }
            } else if (def && def.icon) {
                itemIconMap[name] = def
            }
        }
    }

    for (const item of mapEnterPreviewData.items) {
        if (item.x < startX || item.x >= endX || item.y < startY || item.y >= endY) continue

        const worldX = item.x * TILE + TILE / 2
        const worldY = item.y * TILE + TILE / 2

        const itemDef = itemIconMap[item.item]
        if (itemDef && itemDef.icon) {
            // Draw actual item sprite from tileset
            const ts = tileset?.tilesets?.find(t => t.name === 'items') || tileset?.tilesets?.[0]
            if (ts?.img) {
                const [ix, iy] = itemDef.icon
                const srcX = ix * TILE
                const srcY = iy * TILE

                ctx.save()
                ctx.globalAlpha = 0.8
                ctx.drawImage(ts.img, srcX, srcY, TILE, TILE, worldX - TILE/2, worldY - TILE/2, TILE, TILE)
                ctx.restore()
            }
        } else {
            // Fallback: draw a simple placeholder
            ctx.save()
            ctx.globalAlpha = 0.8
            ctx.fillStyle = '#ffd700'
            ctx.beginPath()
            ctx.arc(worldX, worldY, 8, 0, Math.PI * 2)
            ctx.fill()
            ctx.strokeStyle = '#b8860b'
            ctx.lineWidth = 1
            ctx.stroke()
            ctx.restore()
        }

        // Draw quantity if > 1
        if (item.qty > 1) {
            ctx.save()
            ctx.fillStyle = '#000'
            ctx.font = 'bold 10px sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(item.qty.toString(), worldX, worldY + 1)
            ctx.restore()
        }
    }
}

function drawMapUnderlay() {
    if (!map) return

    // Subtle underlay helps define map area when tile art is very dark.
    const step = TILE
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            if (((x + y) & 1) === 0) continue
            ctx.fillStyle = 'rgba(255,255,255,0.02)'
            ctx.fillRect(x * step, y * step, step, step)
        }
    }
}

function renderFenceShadows() {
    if (!map || !tileset?.fenceMap) return
    const { startX, startY, endX, endY } = getVisibleRange()

    // Accumulate all fence shadows into an offscreen canvas, then composite once
    const sc = renderFenceShadows._sc ?? (renderFenceShadows._sc = document.createElement('canvas'))
    if (sc.width  !== canvas.width)  sc.width  = canvas.width
    if (sc.height !== canvas.height) sc.height = canvas.height
    const sctx = sc.getContext('2d')
    sctx.clearRect(0, 0, sc.width, sc.height)
    sctx.setTransform(ctx.getTransform())

    let drew = false
    const csX = Math.max(0, startX), csY = Math.max(0, startY)
    const ceX = Math.min(map.width,  endX + 1)
    const ceY = Math.min(map.height, endY + 1)

    for (let cy = csY; cy <= ceY; cy++) {
        for (let cx = csX; cx <= ceX; cx++) {
            const types = new Set()
            if (cx > 0          && map._hFences[cy]?.[cx - 1]) types.add(map._hFences[cy][cx - 1])
            if (cx < map.width  && map._hFences[cy]?.[cx])     types.add(map._hFences[cy][cx])
            if (cy > 0          && map._vFences[cy - 1]?.[cx]) types.add(map._vFences[cy - 1][cx])
            if (cy < map.height && map._vFences[cy]?.[cx])     types.add(map._vFences[cy][cx])

            for (const fenceId of types) {
                const fenceDef = tileset.fenceMap[fenceId]
                if (!fenceDef) continue
                let bits = 0
                if (cx > 0          && map._hFences[cy]?.[cx - 1] === fenceId) bits |= 8  // LEFT
                if (cx < map.width  && map._hFences[cy]?.[cx]     === fenceId) bits |= 4  // RIGHT
                if (cy > 0          && map._vFences[cy - 1]?.[cx] === fenceId) bits |= 2  // TOP
                if (cy < map.height && map._vFences[cy]?.[cx]     === fenceId) bits |= 1  // BOTTOM
                if (!bits) continue

                const shadow = getFenceShadowCanvas(fenceDef, fenceId, bits)
                // tile top-left in world = (cx*TILE - TILE/2, cy*TILE - TILE/2)
                // shadow canvas has tile at (FENCE_SHADOW_OX, FENCE_SHADOW_OY), so offset back
                sctx.drawImage(shadow,
                    cx * TILE - TILE / 2 - FENCE_SHADOW_OX,
                    cy * TILE - TILE / 2 - FENCE_SHADOW_OY + FENCE_OFFSET_Y)
                drew = true
            }
        }
    }

    if (drew) {
        ctx.save()
        ctx.resetTransform()
        ctx.globalAlpha = 0.35
        ctx.drawImage(sc, 0, 0)
        ctx.restore()
    }
}

function drawMapBorder() {
    if (!map) return
    const mapW = map.width * TILE
    const mapH = map.height * TILE

    // Two-pass border stays visible on both dark and bright tiles.
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'
    ctx.lineWidth = 4 / zoom
    ctx.strokeRect(0, 0, mapW, mapH)

    ctx.strokeStyle = 'rgba(255,220,120,0.95)'
    ctx.lineWidth = 2 / zoom
    ctx.strokeRect(0, 0, mapW, mapH)
}

let _renderScheduled = false
function scheduleRender() {
    if (!_renderScheduled) {
        _renderScheduled = true
        requestAnimationFrame(() => { _renderScheduled = false; render() })
    }
}

function render() {
    const w = container.clientWidth
    const h = container.clientHeight

    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    ctx.imageSmoothingEnabled = false

    const scrollX = container.scrollLeft
    const scrollY = container.scrollTop

    // Detect viewport changes → both layers need rebuild
    if (scrollX !== _lastScrollX || scrollY !== _lastScrollY || zoom !== _lastZoom ||
        !baseCanvas || baseCanvas.width !== canvas.width || baseCanvas.height !== canvas.height) {
        baseDirty    = true
        overlayDirty = true
        sortedItemsDirty = true
        _lastScrollX = scrollX
        _lastScrollY = scrollY
        _lastZoom    = zoom
    }

    // Layer 1: base terrain (drawMapUnderlay + renderDualGridLow / renderRaw)
    if (baseDirty && map) {
        if (!baseCanvas || baseCanvas.width !== canvas.width || baseCanvas.height !== canvas.height) {
            baseCanvas = document.createElement('canvas')
            baseCanvas.width  = canvas.width
            baseCanvas.height = canvas.height
            baseCtx = baseCanvas.getContext('2d', { alpha: false })
        }
        baseCtx.imageSmoothingEnabled = false
        baseCtx.clearRect(0, 0, canvas.width, canvas.height)
        baseCtx.save()
        baseCtx.translate(-scrollX, -scrollY)
        baseCtx.scale(zoom, zoom)
        const _mc1 = ctx
        ctx = baseCtx
        drawMapUnderlay()
        if (preview) renderDualGridLow()
        else         renderRaw()
        ctx = _mc1
        baseCtx.restore()
        baseDirty = false
    }

    // Layer 2: overlay (water, elevation, grid, fence shadows, border)
    if (overlayDirty && map) {
        if (!overlayCanvas || overlayCanvas.width !== canvas.width || overlayCanvas.height !== canvas.height) {
            overlayCanvas = document.createElement('canvas')
            overlayCanvas.width  = canvas.width
            overlayCanvas.height = canvas.height
            overlayCtx = overlayCanvas.getContext('2d')  // alpha:true — composited on top
        }
        overlayCtx.imageSmoothingEnabled = false
        overlayCtx.clearRect(0, 0, canvas.width, canvas.height)
        overlayCtx.save()
        overlayCtx.translate(-scrollX, -scrollY)
        overlayCtx.scale(zoom, zoom)
        const _mc2 = ctx
        ctx = overlayCtx
        if (preview) {
            renderWaterLayer()
            renderElevation()
        }
        if (showLevels) renderLevels()
        if (!preview || showGrid) drawGrid()
        renderFenceShadows()
        drawMapBorder()
        ctx = _mc2
        overlayCtx.restore()
        overlayDirty = false
    }

    // Composite: base + overlay (1 drawImage each) + dynamic layer
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (baseCanvas)    ctx.drawImage(baseCanvas,    0, 0)
    if (overlayCanvas) ctx.drawImage(overlayCanvas, 0, 0)

    ctx.save()
    ctx.translate(-scrollX, -scrollY)
    ctx.scale(zoom, zoom)

    if (preview) renderObjectFoam()
    renderDecorationsAndTops()
    if (showMapEnterPreview) renderMapEnterPreview()
    if (showTraversable) renderTraversable()

    if (tool === 'ramp') drawRampCursor()
    else if (layer === 'fence') drawFenceCursor()
    else if (tool === 'effect') drawEffectCursor()
    else if (tool !== 'mark') drawBrushCursor()
    drawMarks()
    drawSelectedDecoration()
    drawDraggedItem()

    ctx.restore()

    // Schedule wind animation tick at 6 fps (viewport-bounded scan)
    if (map) {
        const { startX, startY, endX, endY } = getVisibleRange()
        const MARGIN = 1
        const wy0 = Math.max(0, startY - MARGIN), wy1 = Math.min(map.height - 1, endY + MARGIN)
        const wx0 = Math.max(0, startX - MARGIN), wx1 = Math.min(map.width  - 1, endX + MARGIN)
        let hasWind = false
        outer: for (let wy = wy0; wy <= wy1; wy++)
            for (let wx = wx0; wx <= wx1; wx++) {
                const decoW = map._decorations[wy][wx]
                if (decoW && assetMap[decoW.assetId]?.wind) { hasWind = true; break outer }
            }
        if (hasWind) _scheduleWindTick()
    }
    // Schedule continuous re-render for effect animations and animated cursor
    if (map) {
        const needsAnim = (map._effects?.length > 0) || (tool === 'effect' && cursorX >= 0)
        if (needsAnim) _scheduleEffectTick()
    }
    // Schedule water wave tick at 10 fps
    if (map && waterTilesetReady) _scheduleWaterTick()

    if (showCacheStats) drawCacheStatsOverlay()
}

function drawCacheStatsOverlay() {
    const BYTES_PER_PX = 4
    const tileBytes = TILE * TILE * BYTES_PER_PX
    const plainCount  = plainTileCache.size
    const maskedCount = maskedTileCache.size
    const rampCount   = rampShadowTileCache.size
    const fenceCount  = fenceShadowTileCache.size
    const waterMasks  = waterFrameMap ? waterFrameMap.size : 0
    const waterFrames = waterMasks * WAVE_NFRAMES

    const terrainBytes = (plainCount + maskedCount + rampCount) * tileBytes
    const fenceBytes   = fenceCount * (3 * TILE) * (3 * TILE) * BYTES_PER_PX
    const waterBytes   = waterFrames * tileBytes
    const totalKB      = (terrainBytes + fenceBytes + waterBytes) / 1024

    const lines = [
        'Cache Stats  (Shift+S)',
        '─────────────────────────',
        `Plain terrain:  ${plainCount}`,
        `Masked terrain: ${maskedCount}`,
        `Ramp shadow:    ${rampCount}`,
        `Fence shadow:   ${fenceCount}`,
        `Water frames:   ${waterFrames}  (${waterMasks} masks × ${WAVE_NFRAMES})`,
        '─────────────────────────',
        `Memory: ~${totalKB >= 1024 ? (totalKB / 1024).toFixed(2) + ' MB' : totalKB.toFixed(1) + ' KB'}`,
    ]

    const fontSize = 12
    const lineH    = fontSize + 4
    const padX     = 10
    const padY     = 8
    const panelW   = 220
    const panelH   = lines.length * lineH + padY * 2
    const x        = canvas.width  - panelW - 8
    const y        = 8

    ctx.save()
    ctx.font = `${fontSize}px monospace`
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.beginPath()
    ctx.roundRect(x, y, panelW, panelH, 6)
    ctx.fill()
    for (let i = 0; i < lines.length; i++) {
        const isHeader = i === 0
        const isSep    = lines[i].startsWith('─')
        const isMem    = i === lines.length - 1
        ctx.fillStyle = isHeader ? '#a8d8ff' : isSep ? '#555' : isMem ? '#ffd080' : '#e8e8e8'
        ctx.fillText(lines[i], x + padX, y + padY + i * lineH + fontSize)
    }
    ctx.restore()
}

function selectDecoration({ x, y }) {
    if (!map) return
    const d = map._decorations[y]?.[x]
    selectedDecoration = d ? { x, y } : null
    updatePropPanel()
    scheduleRender()
}

function cycleSelectedDecoState(dir) {
    if (!selectedDecoration || !map) return
    const { x, y } = selectedDecoration
    const d = map._decorations[y]?.[x]
    if (!d) return
    const asset = assetMap[d.assetId]
    if (!asset) return
    const curId = d.stateId ?? asset.defaultState
    const idx = asset.states.findIndex(s => s.id === curId)
    d.stateId = asset.states[(idx + dir + asset.states.length) % asset.states.length].id
    updatePropPanel()
    scheduleRender()
}

function updatePropPanel() {
    if (propWindRaf) { cancelAnimationFrame(propWindRaf); propWindRaf = null }
    const panel = document.getElementById('propPanel')

    // Effect properties
    if (selectedEffect !== null && map) {
        const ef = map._effects[selectedEffect]
        if (!ef) { selectedEffect = null; panel.classList.remove('visible'); return }
        panel.classList.add('visible')
        panel.innerHTML = `
            <div class="prop-header">Effect</div>
            <div class="prop-asset-id">${ef.type}</div>
            <hr class="prop-sep">
            <div class="prop-label">Cell: ${ef.x},&thinsp;${ef.y}</div>
            <div class="prop-label">Offset dx / dy</div>
            <div style="display:flex;gap:6px;margin-top:3px">
                <input id="propEffDx" type="number" value="${ef.dx ?? 0}" style="width:52px" title="Horizontal offset px">
                <input id="propEffDy" type="number" value="${ef.dy ?? 0}" style="width:52px" title="Vertical offset px">
            </div>
            <div class="prop-label" style="margin-top:6px">Scale</div>
            <input id="propEffScale" type="number" value="${ef.scale ?? 1}" step="0.1" min="0.1" max="4" style="width:64px">
        `
        panel.querySelector('#propEffDx').addEventListener('input', ev => {
            ef.dx = parseInt(ev.target.value) || 0; invalidateSortedItems(); scheduleRender()
        })
        panel.querySelector('#propEffDy').addEventListener('input', ev => {
            ef.dy = parseInt(ev.target.value) || 0; invalidateSortedItems(); scheduleRender()
        })
        panel.querySelector('#propEffScale').addEventListener('input', ev => {
            ef.scale = Math.max(0.1, parseFloat(ev.target.value) || 1); scheduleRender()
        })
        return
    }

    if (!selectedDecoration || !map) { panel.classList.remove('visible'); return }
    const { x, y } = selectedDecoration
    const d = map._decorations[y]?.[x]
    if (!d) { panel.classList.remove('visible'); return }
    const asset = assetMap[d.assetId]
    if (!asset) { panel.classList.remove('visible'); return }
    panel.classList.add('visible')
    const stateId = d.stateId ?? asset.defaultState
    panel.innerHTML = `
        <div class="prop-header">Decoration</div>
        <div class="prop-asset-id">${asset.id}</div>
        <hr class="prop-sep">
        <div class="prop-label">State</div>
        ${asset.states.length > 1 ? `
        <div class="prop-state-nav">
            <button id="propStatePrev">\u25c4</button>
            <span class="prop-state-name">${stateId}</span>
            <button id="propStateNext">\u25ba</button>
        </div>` : `<div class="prop-state-name" style="text-align:left;padding:2px 0">${stateId}</div>`}
        <hr class="prop-sep">
        <div class="prop-pos">Cell: ${x},&thinsp;${y}</div>
        <div class="prop-pos">Flip: ${d.flipX ? 'Yes' : 'No'} &nbsp; Scale: ${d.scale !== undefined ? Math.round(d.scale * 100) + '%' : '100%'}</div>
    `
    if (asset.states.length > 1) {
        panel.querySelector('#propStatePrev').addEventListener('click', () => cycleSelectedDecoState(-1))
        panel.querySelector('#propStateNext').addEventListener('click', () => cycleSelectedDecoState(1))
    }
}

function drawDraggedItem() {
    if (!isDraggingSelect || !selectDragItem || cursorX < 0) return
    ctx.save()
    ctx.globalAlpha = 0.7
    if (selectDragItem.kind === 'decoration') {
        const { origX, origY } = selectDragItem
        const d = map._decorations[origY]?.[origX]
        if (!d) { ctx.restore(); return }
        const asset = assetMap[d.assetId]
        if (!asset) { ctx.restore(); return }
        const ts = asset.tileset
        const state = getDecorationState(d, asset)
        const [tx, ty, tw, th] = state.region
        const [px, py] = asset.pivot
        const srcX = tx * ts.size[0], srcY = ty * ts.size[1]
        const srcW = tw * ts.size[0], srcH = th * ts.size[1]
        ctx.translate(cursorX * TILE + TILE / 2, cursorY * TILE + TILE / 2)
        if (d.flipX) ctx.scale(-1, 1)
        if (d.scale && d.scale !== 1) ctx.scale(d.scale, d.scale)
        ctx.drawImage(ts.img, srcX, srcY, srcW, srcH, -px * srcW, -py * srcH, srcW, srcH)
    } else if (selectDragItem.kind === 'effect') {
        const ef = map._effects[selectDragItem.index]
        if (!ef) { ctx.restore(); return }
        const def = EFFECT_DEFS[ef.type]
        if (!def?.img) { ctx.restore(); return }
        const fi = Math.floor((performance.now() + (ef.phase ?? 0)) / (1000 / def.fps)) % def.frames
        const scale = ef.scale ?? 1
        const w = def.w * scale, h = def.h * scale
        ctx.drawImage(def.img, fi * def.w, (def.row ?? 0) * def.h, def.w, def.h,
            cursorWx - w / 2, cursorWy - h, w, h)
    }
    ctx.restore()
}

function drawSelectedDecoration() {
    if (!map || tool !== 'select') return
    ctx.save()
    ctx.strokeStyle = '#2a8ad4'
    ctx.lineWidth = 2
    if (selectedDecoration) {
        const { x, y } = selectedDecoration
        if (map._decorations[y]?.[x])
            ctx.strokeRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2)
    }
    if (selectedEffect !== null) {
        const ef = map._effects[selectedEffect]
        if (ef) {
            const def = EFFECT_DEFS[ef.type]
            const w = def ? def.w * (ef.scale ?? 1) : TILE
            const h = def ? def.h * (ef.scale ?? 1) : TILE
            const { wx, wy } = effectWorld(ef)
            ctx.strokeRect(wx - w / 2, wy - h, w, h)
        }
    }
    ctx.restore()
}

function renderTraversable() {
    const { startX, startY, endX, endY } = getVisibleRange()

    // build a small offscreen diagonal-stripe pattern once
    if (!renderTraversable._pattern) {
        const sz = 8
        const pc = document.createElement('canvas')
        pc.width = sz; pc.height = sz
        const pctx = pc.getContext('2d')
        pctx.strokeStyle = 'rgba(220,40,40,0.85)'
        pctx.lineWidth = 1.5
        pctx.beginPath()
        // bottom-left to top-right
        pctx.moveTo(0, sz); pctx.lineTo(sz, 0)
        pctx.moveTo(-sz, sz); pctx.lineTo(sz, -sz)
        pctx.moveTo(sz, sz * 2); pctx.lineTo(sz * 2, sz)
        // top-left to bottom-right
        pctx.moveTo(0, 0); pctx.lineTo(sz, sz)
        pctx.moveTo(-sz, 0); pctx.lineTo(0, sz)
        pctx.moveTo(sz, 0); pctx.lineTo(sz * 2, sz)
        pctx.stroke()
        renderTraversable._pattern = ctx.createPattern(pc, 'repeat')
    }

    // --- build blocked map from terrain ---
    // blocked[y][x] = true means cell is not passable
    const blocked = []
    for (let y = 0; y < map.height; y++) {
        blocked.push([])
        for (let x = 0; x < map.width; x++) {
            const terrainId = getCell(map, x, y)
            const terrain = tileset.terrains[terrainId]
            const tags = terrain.tags ?? []
            blocked[y].push(!tags.includes('ground') || isFrontCliff(map, x, y))
        }
    }

    // --- overlay decoration traversable masks ---
    // 'A' = passable, 'B' = blocked
    for (let dy = 0; dy < map.height; dy++) {
        for (let dx = 0; dx < map.width; dx++) {
            const d = map._decorations[dy][dx]
            if (!d) continue
            const asset = assetMap[d.assetId]
            if (!asset) continue
            const state = getDecorationState(d, asset)
            if (!state.traversable) continue

            const [px, py] = asset.pivot
            const [,, tw, th] = state.region
            const rows = state.traversable.split('|')
            const startCellX = d.x - Math.floor(px * tw)
            const startCellY = d.y - Math.floor(py * th)

            for (let row = 0; row < rows.length; row++) {
                for (let col = 0; col < rows[row].length; col++) {
                    const cx = startCellX + col
                    const cy = startCellY + row
                    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue
                    const mark = rows[row][col]
                    if (mark === 'B') blocked[cy][cx] = true
                    else if (mark === 'A') blocked[cy][cx] = false
                    // '-' (inherit) and unknown symbols do not override existing value.
                }
            }
        }
    }

    // --- draw red dashes on blocked cells in visible range ---
    ctx.save()
    ctx.globalAlpha = 0.45
    ctx.fillStyle = renderTraversable._pattern
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            if (blocked[y][x]) {
                ctx.fillRect(x * TILE, y * TILE, TILE, TILE)
            }
        }
    }
    ctx.restore()

    // --- draw red borders where height differs and no ramp ---
    ctx.save()
    ctx.strokeStyle = 'rgba(220,40,40,0.9)'
    ctx.lineWidth = 2
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const h = getHeight(map, x, y)
            // bottom edge: drop from y to y+1, blocked unless ramp present
            if (y + 1 < map.height) {
                const hb = getHeight(map, x, y + 1)
                if (hb !== h && !(h > hb && getRamp(map, x, y))) {
                    ctx.beginPath()
                    ctx.moveTo(x * TILE,          (y + 1) * TILE)
                    ctx.lineTo((x + 1) * TILE,    (y + 1) * TILE)
                    ctx.stroke()
                }
            }
            // right edge: height diff, no ramps on east/west faces
            if (x + 1 < map.width) {
                const hr = getHeight(map, x + 1, y)
                if (hr !== h) {
                    ctx.beginPath()
                    ctx.moveTo((x + 1) * TILE, y * TILE)
                    ctx.lineTo((x + 1) * TILE, (y + 1) * TILE)
                    ctx.stroke()
                }
            }
        }
    }
    ctx.restore()

    // --- draw fence barrier lines ---
    ctx.save()
    ctx.strokeStyle = 'rgba(220,40,40,0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    const fcX0 = Math.max(0, startX), fcY0 = Math.max(0, startY)
    const fcX1 = Math.min(map.width, endX + 1), fcY1 = Math.min(map.height, endY + 1)
    // Horizontal edges
    for (let cy = fcY0; cy <= fcY1; cy++)
        for (let cx = fcX0; cx < Math.min(map.width, fcX1); cx++)
            if (map._hFences[cy]?.[cx]) {
                ctx.moveTo( cx      * TILE, cy * TILE)
                ctx.lineTo((cx + 1) * TILE, cy * TILE)
            }
    // Vertical edges
    for (let cy = fcY0; cy < Math.min(map.height, fcY1); cy++)
        for (let cx = fcX0; cx <= fcX1; cx++)
            if (map._vFences[cy]?.[cx]) {
                ctx.moveTo(cx * TILE,  cy      * TILE)
                ctx.lineTo(cx * TILE, (cy + 1) * TILE)
            }
    ctx.stroke()
    ctx.restore()
}

function renderLevels() {
    const { startX, startY, endX, endY } = getVisibleRange()
    ctx.save()
    ctx.globalAlpha = 0.3
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const h = getHeight(map, x, y)
            const t = h / 4
            const r = Math.round(t * 255)
            const g = Math.round((1 - t) * 255)
            ctx.fillStyle = `rgb(${r},${g},0)`
            ctx.fillRect(x * TILE, y * TILE, TILE, TILE)
        }
    }
    ctx.restore()
}

function renderElevation() {
    const elevImg       = tileset.elevationImg
    const botImg        = tileset.elevationBottomImg
    const shadowImg     = tileset.elevationShadowImg
    const botShadowImg  = tileset.elevationBottomShadowImg
    const rampImg       = tileset.rampImg
    const rampShadowImg = tileset.rampShadowImg
    const maskCanvas    = tileset.elevationMaskCanvas
    const { startX, startY, endX, endY } = getVisibleRange()
    const rxStart = Math.max(0, startX)
    const ryStart = Math.max(0, startY)
    const rxEnd   = Math.min(map.width  + 1, endX + 1)
    const ryEnd   = Math.min(map.height + 1, endY + 1)

    // Shared shadow offscreen canvas
    const sc = renderElevation._sc ?? (renderElevation._sc = document.createElement('canvas'))
    if (sc.width  !== canvas.width)  sc.width  = canvas.width
    if (sc.height !== canvas.height) sc.height = canvas.height
    const sctx = sc.getContext('2d')

    const compositeShadows = () => {
        ctx.save()
        ctx.resetTransform()
        ctx.globalAlpha = 0.35
        ctx.drawImage(sc, 0, 0)
        ctx.restore()
    }

    // Scan visible area to find max elevation present — avoids iterating unused levels
    let maxLevel = 0
    for (let ry = ryStart; ry < ryEnd; ry++)
        for (let rx = rxStart; rx < rxEnd; rx++) {
            const h = getRawHeight(map, rx, ry)
            if (h > maxLevel) maxLevel = h
        }

    // --- Level-by-level: collect ALL shadows once → composite → draw tiles → draw elevated terrain ---
    for (let level = 0; level <= maxLevel; level++) {

        //Step 1 — collect all shadows for this level into one canvas, composite ONCE
        {
            sctx.clearRect(0, 0, sc.width, sc.height)
            sctx.setTransform(ctx.getTransform())
            let drew = false

            if (shadowImg || botShadowImg || rampShadowImg) {
            // Ramp shadows at this level
            if (rampShadowImg) {
                for (let y = startY; y < endY; y++) {
                    if (y + 1 >= map.height) continue
                    for (let x = startX; x < endX; x++) {
                        if (!getRamp(map, x, y)) continue
                        const isLeft  = !getRamp(map, x - 1, y)
                        const isRight = !getRamp(map, x + 1, y)
                        if (!isLeft && !isRight) continue
                        const rampLevel = getHeight(map, x, y + 1)
                        if (rampLevel !== level) continue
                        const px = x * TILE - TILE / 2
                        const py = y * TILE + TILE / 2
                        if (isLeft) {
                            sctx.drawImage(rampShadowImg, 0,               0, SHADOW_SIZE, SHADOW_SIZE, px,        py,        SHADOW_SIZE, SHADOW_SIZE)
                            sctx.drawImage(rampShadowImg, 2 * SHADOW_SIZE, 0, SHADOW_SIZE, SHADOW_SIZE, px,        py + TILE, SHADOW_SIZE, SHADOW_SIZE)
                        }
                        if (isRight) {
                            sctx.drawImage(rampShadowImg, SHADOW_SIZE,     0, SHADOW_SIZE, SHADOW_SIZE, px + TILE, py,        SHADOW_SIZE, SHADOW_SIZE)
                            sctx.drawImage(rampShadowImg, 3 * SHADOW_SIZE, 0, SHADOW_SIZE, SHADOW_SIZE, px + TILE, py + TILE, SHADOW_SIZE, SHADOW_SIZE)
                        }
                        drew = true
                    }
                }
            }
            for (let ry = ryStart; ry < ryEnd; ry++) {
                for (let rx = rxStart; rx < rxEnd; rx++) {
                    if (getRamp(map, rx - 1, ry - 1) || getRamp(map, rx, ry - 1)) continue
                    const htl = getRawHeight(map, rx,     ry)
                    const htr = getRawHeight(map, rx + 1, ry)
                    const hbl = getRawHeight(map, rx,     ry + 1)
                    const hbr = getRawHeight(map, rx + 1, ry + 1)
                    if (Math.min(htl, htr, hbl, hbr) !== level) continue
                    if (Math.max(htl, htr, hbl, hbr) <= level) continue
                    const mask = ((htl > level ? 1:0) << 3) | ((htr > level ? 1:0) << 2) |
                                 ((hbl > level ? 1:0) << 1) |  (hbr > level ? 1:0)
                    if (mask === 0 || mask === 15) continue
                    const px = (rx - 1) * TILE + TILE / 2
                    const py = (ry - 1) * TILE + TILE / 2
                    const castShadow = (mask & 9) !== 1 && mask !== 11
                    if (shadowImg && castShadow)
                        sctx.drawImage(shadowImg, mask * SHADOW_SIZE, 0, SHADOW_SIZE, SHADOW_SIZE, px, py, SHADOW_SIZE, SHADOW_SIZE)
                    if ((mask & 3) !== 3) {
                        if (shadowImg && castShadow)
                            sctx.drawImage(shadowImg, mask * SHADOW_SIZE, SHADOW_SIZE, SHADOW_SIZE, SHADOW_SIZE, px, py + TILE, SHADOW_SIZE, SHADOW_SIZE)
                        if (botShadowImg)
                            sctx.drawImage(botShadowImg, mask * SHADOW_SIZE, 0, SHADOW_SIZE, SHADOW_SIZE, px, py + TILE, SHADOW_SIZE, SHADOW_SIZE)
                    }
                    drew = true
                }
            }
            } // end if (shadowImg || botShadowImg || rampShadowImg)

            // Decoration shadows at this level
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    if (getHeight(map, x, y) !== level) continue
                    const d = map._decorations[y][x]
                    if (!d) continue
                    const asset = assetMap[d.assetId]
                    if (!asset?.shadow) continue
                    const windFi = (asset.wind && asset.wind[0] >= 2 && asset.wind[1] > 0)
                        ? getWindFrame(asset.wind[0], d._windPhase ?? (d._windPhase = Math.random() * 100000))
                        : 0
                    const worldX = d.x * TILE + TILE / 2 + d.dx
                    const worldY = d.y * TILE + TILE / 2 + d.dy
                    sctx.save()
                    sctx.translate(worldX, worldY)
                    if (d.scale && d.scale !== 1) sctx.scale(d.scale, d.scale)
                    sctx.translate(-worldX, -worldY)
                    drawShadow(sctx, d, asset, windFi)
                    sctx.restore()
                    drew = true
                }
            }
            if (drew) compositeShadows()
        } // end shadow block

        // Step 2 — cliff faces
        if (elevImg) {
            for (let ry = ryStart; ry < ryEnd; ry++) {
                for (let rx = rxStart; rx < rxEnd; rx++) {
                    if (getRamp(map, rx - 1, ry - 1) || getRamp(map, rx, ry - 1)) continue
                    const htl = getRawHeight(map, rx,     ry)
                    const htr = getRawHeight(map, rx + 1, ry)
                    const hbl = getRawHeight(map, rx,     ry + 1)
                    const hbr = getRawHeight(map, rx + 1, ry + 1)
                    if (Math.min(htl, htr, hbl, hbr) !== level) continue
                    if (Math.max(htl, htr, hbl, hbr) <= level) continue
                    const mask = ((htl > level ? 1:0) << 3) | ((htr > level ? 1:0) << 2) |
                                 ((hbl > level ? 1:0) << 1) |  (hbr > level ? 1:0)
                    if (mask === 0 || mask === 15) continue
                    const px = (rx - 1) * TILE + TILE / 2
                    const py = (ry - 1) * TILE + TILE / 2
                    ctx.drawImage(elevImg, mask * TILE, 0, TILE, TILE, px, py, TILE, TILE)
                }
            }
        }

        // Step 3 — bot tiles
        if (botImg) {
            for (let ry = ryStart; ry < ryEnd; ry++) {
                for (let rx = rxStart; rx < rxEnd; rx++) {
                    if (getRamp(map, rx - 1, ry - 1) || getRamp(map, rx, ry - 1)) continue
                    const htl = getRawHeight(map, rx,     ry)
                    const htr = getRawHeight(map, rx + 1, ry)
                    const hbl = getRawHeight(map, rx,     ry + 1)
                    const hbr = getRawHeight(map, rx + 1, ry + 1)
                    if (Math.min(htl, htr, hbl, hbr) !== level) continue
                    if (Math.max(htl, htr, hbl, hbr) <= level) continue
                    const mask = ((htl > level ? 1:0) << 3) | ((htr > level ? 1:0) << 2) |
                                 ((hbl > level ? 1:0) << 1) |  (hbr > level ? 1:0)
                    if (mask === 0 || mask === 15 || (mask & 3) === 3) continue
                    const px = (rx - 1) * TILE + TILE / 2
                    const py = (ry - 1) * TILE + TILE / 2
                    ctx.drawImage(botImg, mask * TILE, 0, TILE, TILE, px, py + TILE, TILE, TILE)
                }
            }
        }

        //Step 4 — elevated terrain (covers row-0 shadow bleed onto high ground)
        if (maskCanvas) {
            for (let ry = ryStart; ry < ryEnd; ry++) {
                for (let rx = rxStart; rx < rxEnd; rx++) {
                    const tl = getRaw(map, rx,     ry)
                    const tr = getRaw(map, rx + 1, ry)
                    const bl = getRaw(map, rx,     ry + 1)
                    const br = getRaw(map, rx + 1, ry + 1)
                    const htl = getRawHeight(map, rx,     ry)
                    const htr = getRawHeight(map, rx + 1, ry)
                    const hbl = getRawHeight(map, rx,     ry + 1)
                    const hbr = getRawHeight(map, rx + 1, ry + 1)
                    const minH = Math.min(htl, htr, hbl, hbr)
                    const maxH = Math.max(htl, htr, hbl, hbr)
                    const px = (rx - 1) * TILE + TILE / 2
                    const py = (ry - 1) * TILE + TILE / 2

                    if (minH === maxH) {
                        // Redraw ALL flat elevated cells, not just level+1, so shadow bleed
                        // from this level is covered even on terrain two+ levels up.
                        if (minH > level) drawDualGridCellTo(ctx, px, py, tl, tr, bl, br, rx, ry)
                        continue
                    }

                    if (maxH <= level) continue
                    const mask = ((htl > level ? 1:0) << 3) | ((htr > level ? 1:0) << 2) |
                                 ((hbl > level ? 1:0) << 1) |  (hbr > level ? 1:0)
                    if (mask === 0) continue  // nothing above this level at this node

                    // If a ramp covers this node, skip cliff masking — draw full terrain
                    // with the ramp shadow baked in (cached) so the shadow isn't wiped.
                    if (getRamp(map, rx - 1, ry - 1) || getRamp(map, rx, ry - 1)) {
                        const shadowPiece = (getRamp(map, rx, ry - 1) && !getRamp(map, rx - 1, ry - 1) ? 1 : 0)
                                          | (getRamp(map, rx - 1, ry - 1) && !getRamp(map, rx, ry - 1) ? 2 : 0)
                        if (shadowPiece && rampShadowImg) {
                            const vi = getVariantIndex(tileset, rx, ry)
                            const rkey = (tl | (tr << 6) | (bl << 12) | (br << 18) | (vi << 24) | (shadowPiece << 28)) >>> 0
                            let rc = rampShadowTileCache.get(rkey)
                            if (!rc) { rc = buildRampShadowTileCanvas(tl, tr, bl, br, shadowPiece, rx, ry); rampShadowTileCache.set(rkey, rc) }
                            ctx.drawImage(rc, px, py)
                        } else {
                            drawDualGridCellTo(ctx, px, py, tl, tr, bl, br, rx, ry)
                        }
                        continue
                    }

                    // Redraw full cell with low terrain for cliff nodes entirely above this level
                    // so shadow bleed into their low-corner area is covered before the high mask.
                    // Do NOT do this when minH === level — the cliff face was already drawn in step 2.
                    if (minH > level) {
                        let anyLowPri = Infinity, anyLowT = tl
                        if (htl === minH) { const p = tileset.priorityIndex.get(tl); if (p < anyLowPri) { anyLowPri = p; anyLowT = tl } }
                        if (htr === minH) { const p = tileset.priorityIndex.get(tr); if (p < anyLowPri) { anyLowPri = p; anyLowT = tr } }
                        if (hbl === minH) { const p = tileset.priorityIndex.get(bl); if (p < anyLowPri) { anyLowPri = p; anyLowT = bl } }
                        if (hbr === minH) { const p = tileset.priorityIndex.get(br); if (p < anyLowPri) { anyLowPri = p; anyLowT = br } }
                        const ltl = htl === minH ? tl : anyLowT
                        const ltr = htr === minH ? tr : anyLowT
                        const lbl = hbl === minH ? bl : anyLowT
                        const lbr = hbr === minH ? br : anyLowT
                        drawDualGridCellTo(ctx, px, py, ltl, ltr, lbl, lbr, rx, ry)
                    }

                    let anyHighPri = Infinity, anyHighT = tl
                    if (htl > level) { const p = tileset.priorityIndex.get(tl); if (p < anyHighPri) { anyHighPri = p; anyHighT = tl } }
                    if (htr > level) { const p = tileset.priorityIndex.get(tr); if (p < anyHighPri) { anyHighPri = p; anyHighT = tr } }
                    if (hbl > level) { const p = tileset.priorityIndex.get(bl); if (p < anyHighPri) { anyHighPri = p; anyHighT = bl } }
                    if (hbr > level) { const p = tileset.priorityIndex.get(br); if (p < anyHighPri) { anyHighPri = p; anyHighT = br } }
                    const p2tl = htl > level ? tl : anyHighT
                    const p2tr = htr > level ? tr : anyHighT
                    const p2bl = hbl > level ? bl : anyHighT
                    const p2br = hbr > level ? br : anyHighT

                    const vi = getVariantIndex(tileset, rx, ry)
                    const mkey = (tl | (tr << 6) | (bl << 12) | (br << 18) | (vi << 24) | (mask << 28)) >>> 0
                    let mcached = maskedTileCache.get(mkey)
                    if (!mcached) { mcached = buildMaskedTileCanvas(p2tl, p2tr, p2bl, p2br, mask, rx, ry, maskCanvas); maskedTileCache.set(mkey, mcached) }
                    ctx.drawImage(mcached, px, py)
                }
            }
        }
    }

    // --- Ramp tiles ---
    if (rampImg) {
        for (let y = startY; y < endY; y++) {
            if (y + 1 >= map.height) continue
            for (let x = startX; x < endX; x++) {
                if (!getRamp(map, x, y)) continue
                const isLeft  = !getRamp(map, x - 1, y)
                const isRight = !getRamp(map, x + 1, y)
                if (!isLeft && !isRight) continue
                const px = x * TILE - TILE / 2
                const py = y * TILE + TILE / 2
                if (isLeft) {
                    ctx.drawImage(rampImg, 0,       0, TILE, TILE, px, py,        TILE, TILE)
                    ctx.drawImage(rampImg, 2 * TILE, 0, TILE, TILE, px, py + TILE, TILE, TILE)
                }
                if (isRight) {
                    ctx.drawImage(rampImg, TILE,     0, TILE, TILE, px + TILE, py,        TILE, TILE)
                    ctx.drawImage(rampImg, 3 * TILE, 0, TILE, TILE, px + TILE, py + TILE, TILE, TILE)
                }
            }
        }
    }

}

// Draws front-cliff shadow (row 1), bottom shadows and bottom tiles AFTER renderDualGridHigh,
// so that elevated flat-cell redraws from that pass don't cover them.
function renderRaw() {
    const { startX, startY, endX, endY } = getVisibleRange()

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const terrainId = getCell(map, x, y)
            const t = tileset.terrains[terrainId]
            ctx.drawImage(t.img, 15 * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
            ctx.strokeStyle = 'rgba(0,0,0,0.2)'
            ctx.strokeRect(x * TILE, y * TILE, TILE, TILE)
        }
    }
}

// --- Tile cache ---
// Tile caches — integer keys, zero allocation per lookup.
// Plain key  (30 bits): tl[0-5] | tr[6-11] | bl[12-17] | br[18-23] | vi[24-27]
// Masked key (32 bits): same | elevMask[28-31]
// Assumes terrain IDs < 64, variant index < 16, elevation mask < 16.
// ── Water animation: per-wMask pre-baked frames ──────────────────────────────
// 15 wMask values × WAVE_NFRAMES frames = 240 canvases baked once on tileset load.
// Each frame: flat WATER_BASE_CLR + shimmer dashes + foam ovals, clipped to the
// water-colour pixels in water.png, with cliff/shore art drawn on top unchanged.
let waterFrameMap = null       // Map<wMask 1–15, canvas[WAVE_NFRAMES]>
let waterTilesetReady = false  // set true after buildWaterFrames() completes

function _isWaterColor(r, g, b) {
    return (Math.abs(r - 21) <= 10 && Math.abs(g - 108) <= 10 && Math.abs(b - 153) <= 10) ||
           (r <= 10 && Math.abs(g - 152) <= 10 && Math.abs(b - 178) <= 10) ||
           (r <= 10 && Math.abs(g - 207) <= 10 && Math.abs(b - 223) <= 10)
}

function _makeWaterRNG(seed) {
    let s = (seed >>> 0) || 1
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0x100000000 }
}

// Read one wMask column from water.png; split pixels into water/cliff layers + edge list.
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

// Deterministic horizontal shimmer dashes placed within the water area.
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

// Pre-bake one oval foam stamp (quadratic alpha falloff).
function _makeStamp(w, h, colorIdx) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2
    const rx = w / 2, ry = Math.max(0.5, h / 2)
    const [sr, sg, sb] = SHIMMER_RGB[colorIdx]
    const stamp = document.createElement('canvas'); stamp.width = w; stamp.height = h
    const sid = stamp.getContext('2d').createImageData(w, h)
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const dx = (px - cx) / rx, dy = (py - cy) / ry, d2 = dx*dx + dy*dy
            if (d2 >= 1) continue
            const i = (py * w + px) * 4
            sid.data[i] = sr; sid.data[i+1] = sg; sid.data[i+2] = sb; sid.data[i+3] = (1 - d2) * 255 | 0
        }
    }
    stamp.getContext('2d').putImageData(sid, 0, 0)
    return stamp
}

// Shore foam ovals placed on cliff-edge water pixels.
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

// ── Object foam: bottom-edge foam particles for decorations on water ──────────
const _objectFoamCache = new Map()  // key → foam particles[]

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

function renderObjectFoam() {
    if (!tileset?.waterTerrain || !map || !assetMap) return
    const waterId = tileset.waterTerrain.id
    const tick    = Math.floor(performance.now() / 100)
    ctx.save()
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const d = map._decorations[y][x]
            if (!d) continue
            if (getCell(map, d.x, d.y) !== waterId) continue
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

// Bake WAVE_NFRAMES canvases for one wMask.
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

// Flat water: water.png alpha defines the shape (destination-in mask) and its
// opaque→transparent edge pixels drive foam placement, same as world water.
// Falls back to a solid full-tile water when water.png is blank/missing.
function _buildFlatWaterFrames() {
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = TILE
    const tc = tmp.getContext('2d')
    tc.drawImage(tileset.waterTerrain.img, 0, 0, TILE, TILE, 0, 0, TILE, TILE)
    const d = tc.getImageData(0, 0, TILE, TILE).data

    const isOpaque = (x, y) =>
        x >= 0 && x < TILE && y >= 0 && y < TILE && d[(y * TILE + x) * 4 + 3] >= 128

    const waterRows = []
    for (let y = 0; y < TILE; y++) waterRows.push([])
    for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++)
            if (isOpaque(x, y)) waterRows[y].push(x)

    const hasSpritePixels = waterRows.some(r => r.length > 0)

    // Fallback: sprite blank/missing — full tile, no shape clip, no edge foam
    if (!hasSpritePixels) {
        for (let y = 0; y < TILE; y++) { waterRows[y] = []; for (let x = 0; x < TILE; x++) waterRows[y].push(x) }
        const shimmers = _makeShimmers(waterRows, 15)
        const frames = []
        for (let f = 0; f < WAVE_NFRAMES; f++) {
            const c = document.createElement('canvas'); c.width = c.height = TILE
            const cctx = c.getContext('2d'); cctx.imageSmoothingEnabled = false
            cctx.fillStyle = WATER_BASE_CLR; cctx.fillRect(0, 0, TILE, TILE)
            for (const sh of shimmers) {
                const raw = (f - sh.phase + WAVE_NFRAMES) % WAVE_NFRAMES
                const a = Math.max(0, 1 - Math.min(raw, WAVE_NFRAMES - raw) / sh.halfLife)
                if (a < 0.01) continue
                cctx.globalAlpha = a; cctx.fillStyle = SHIMMER_CLR[sh.colorIdx]
                cctx.fillRect(sh.x, sh.y, sh.len, 1)
            }
            cctx.globalAlpha = 1; frames.push(c)
        }
        return frames
    }

    // Edge pixels: opaque pixels adjacent to at least one transparent/OOB neighbour
    const edgePixels = []
    for (let y = 0; y < TILE; y++)
        for (const x of waterRows[y])
            if (!isOpaque(x-1,y) || !isOpaque(x+1,y) || !isOpaque(x,y-1) || !isOpaque(x,y+1))
                edgePixels.push({ x, y })

    // White shape mask for destination-in clip
    const waterMask = document.createElement('canvas'); waterMask.width = waterMask.height = TILE
    const wmCtx = waterMask.getContext('2d')
    const wmId  = wmCtx.createImageData(TILE, TILE)
    for (let y = 0; y < TILE; y++)
        for (const x of waterRows[y]) {
            const i = (y * TILE + x) * 4
            wmId.data[i] = wmId.data[i+1] = wmId.data[i+2] = wmId.data[i+3] = 255
        }
    wmCtx.putImageData(wmId, 0, 0)

    const shimmers      = _makeShimmers(waterRows, 15)
    const foamParticles = _makeShoreShimmers(edgePixels, 32, 15, 20, 4)

    const frames = []
    for (let f = 0; f < WAVE_NFRAMES; f++) {
        const c = document.createElement('canvas'); c.width = c.height = TILE
        const cctx = c.getContext('2d'); cctx.imageSmoothingEnabled = false
        cctx.fillStyle = WATER_BASE_CLR; cctx.fillRect(0, 0, TILE, TILE)
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
            cctx.globalAlpha = a * 0.5; cctx.drawImage(sp.stamp, sp.drawX, sp.drawY)
        }
        cctx.globalAlpha = 1
        cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(waterMask, 0, 0)
        cctx.globalCompositeOperation = 'source-over'
        frames.push(c)
    }
    return frames
}
// Build all 15 wMask entries — called once after the tileset loads.
function buildWaterFrames() {
    waterFrameMap = new Map()
    for (let m = 1; m <= 15; m++) {
        const { edgePixels } = _analyzeWaterTile(m)
        const bottomCliff = ((m & 8) && !(m & 2)) || ((m & 4) && !(m & 1))
        const fw = bottomCliff ? 10 : 20   // half width on bottom-cliff tiles
        const fh = bottomCliff ?  2 :  4   // half height on bottom-cliff tiles
        waterFrameMap.set(m, _bakeWaterMask(m, _makeShoreShimmers(edgePixels, 32, m, fw, fh), 0.5))
    }
    waterTilesetReady = true
}

// ── Water animation timer ─────────────────────────────────────────────────────
let currentWaterFrame = 0
let waterAnimTimer = null
function _scheduleWaterTick() {
    if (waterAnimTimer) return
    waterAnimTimer = setTimeout(() => {
        waterAnimTimer = null
        currentWaterFrame = (currentWaterFrame + 1) % WAVE_NFRAMES
        overlayDirty = true   // only overlay needs rebuild — base terrain stays cached
        scheduleRender()
    }, 100)  // 10 fps
}

// ── Wind animation timer ──────────────────────────────────────────────────────
let windAnimTimer = null
function _scheduleWindTick() {
    if (windAnimTimer) return
    windAnimTimer = setTimeout(() => {
        windAnimTimer = null
        scheduleRender()
    }, Math.floor(1000 / 6))  // 6 fps
}

// ── Effect animation timer ───────────────────────────────────────────────────
let effectAnimTimer = null
function _scheduleEffectTick() {
    if (effectAnimTimer) return
    effectAnimTimer = setTimeout(() => {
        effectAnimTimer = null
        scheduleRender()
    }, 100)  // 10 fps
}

// ── Water layer overlay ──────────────────────────────────────────────────────
// Iterates dual-grid nodes (same pass as renderDualGridLow).  For each node
// with wMask > 0 it draws the pre-baked animated frame on top of the terrain tile.
// Per-node phase offset from tileHash staggers neighbouring tiles so they don't
// all pulse in sync.
function renderWaterLayer() {
    if (!waterFrameMap || !tileset?.waterTerrain || !map) return
    const waterId = tileset.waterTerrain.id
    const { startX, startY, endX, endY } = getVisibleRange()
    const rxStart = Math.max(0, startX)
    const ryStart = Math.max(0, startY)
    const rxEnd = Math.min(map.width + 1, endX + 1)
    const ryEnd = Math.min(map.height + 1, endY + 1)

    for (let ry = ryStart; ry < ryEnd; ry++) {
        for (let rx = rxStart; rx < rxEnd; rx++) {
            const tl = getRaw(map, rx,     ry)
            const tr = getRaw(map, rx + 1, ry)
            const bl = getRaw(map, rx,     ry + 1)
            const br = getRaw(map, rx + 1, ry + 1)
            const wMask = ((tl === waterId ? 1 : 0) << 3) | ((tr === waterId ? 1 : 0) << 2) |
                          ((bl === waterId ? 1 : 0) << 1) |  (br === waterId ? 1 : 0)
            if (wMask === 0) continue
            const wf = waterFrameMap.get(wMask)
            if (!wf) continue
            const wPhase = tileHash(rx, ry) % WAVE_NFRAMES
            ctx.drawImage(wf[(currentWaterFrame + wPhase) % WAVE_NFRAMES],
                (rx - 1) * TILE + TILE / 2, (ry - 1) * TILE + TILE / 2)
        }
    }
}

const plainTileCache       = new Map()
const maskedTileCache      = new Map()
const rampShadowTileCache  = new Map()
window.tileCacheStats = () => {
    const pc = plainTileCache.size, mc = maskedTileCache.size
    const bytes = (pc + mc) * TILE * TILE * 4
    console.log(`tileCache: ${pc} plain + ${mc} masked = ${pc + mc} entries, ~${(bytes / 1024).toFixed(1)} KB`)
}

// buildTileCanvas / tileHash / getVariantIndex live in ./tilemath.js (shared
// with the game so the dual-grid algorithm can't drift between editor & game).

// shadowPiece bits: 1 = col-0 (ramp directly above, left edge), 2 = col-1 (ramp above-left, right edge)
// Each piece draws the 32×32 (TILE×TILE) crop of the 64×64 ramp shadow sprite that falls on this node.
function buildRampShadowTileCanvas(tl, tr, bl, br, shadowPiece, rx, ry) {
    const c = buildTileCanvas(tileset, tl, tr, bl, br, rx, ry)
    const rsi = tileset.rampShadowImg
    if (!rsi) return c
    const cctx = c.getContext('2d')
    cctx.globalAlpha = 0.35
    if (shadowPiece & 1)  // col 0: shadow cast by left-edge ramp above
        cctx.drawImage(rsi, 0,           0, TILE, TILE, 0, 0, TILE, TILE)
    if (shadowPiece & 2)  // col 1: shadow cast by right-edge ramp above-left
        cctx.drawImage(rsi, SHADOW_SIZE, 0, TILE, TILE, 0, 0, TILE, TILE)
    return c
}

function buildMaskedTileCanvas(tl, tr, bl, br, elevMask, rx, ry, maskCanvas) {
    const c = buildTileCanvas(tileset, tl, tr, bl, br, rx, ry)
    const cctx = c.getContext('2d')
    cctx.globalCompositeOperation = 'destination-in'
    cctx.drawImage(maskCanvas, elevMask * TILE, 0, TILE, TILE, 0, 0, TILE, TILE)
    return c
}

function fillBase() {
  const { startX, startY, endX, endY } = getVisibleRange()
  const terrain = tileset.priorityList[0]
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      ctx.drawImage(terrain.img, 15 * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)
    }
  }
}

function drawDualGridCellTo(targetCtx, dpx, dpy, tl, tr, bl, br, rx, ry) {
    const vi = getVariantIndex(tileset, rx, ry)
    const key = tl | (tr << 6) | (bl << 12) | (br << 18) | (vi << 24)
    let cached = plainTileCache.get(key)
    if (!cached) { cached = buildTileCanvas(tileset, tl, tr, bl, br, rx, ry); plainTileCache.set(key, cached) }
    targetCtx.drawImage(cached, dpx, dpy)
}



function renderDualGridLow() {
    const { startX, startY, endX, endY } = getVisibleRange()
    const rxStart = Math.max(0, startX)
    const ryStart = Math.max(0, startY)
    const rxEnd = Math.min(map.width + 1, endX + 1)
    const ryEnd = Math.min(map.height + 1, endY + 1)
    const maskCanvas = tileset.elevationMaskCanvas
    const flatWaterId  = tileset.waterTerrain?.waterFlat ? tileset.waterTerrain.id : -1
    const baseId       = typeof tileset.waterTerrain?.waterFlat === 'number'
                             ? tileset.waterTerrain.waterFlat
                             : tileset.baseTerrain?.id ?? 0
    const nw = id => (id === flatWaterId ? baseId : id)

    for (let ry = ryStart; ry < ryEnd; ry++) {
        for (let rx = rxStart; rx < rxEnd; rx++) {
            const tl = getRaw(map, rx, ry)
            const tr = getRaw(map, rx + 1, ry)
            const bl = getRaw(map, rx, ry + 1)
            const br = getRaw(map, rx + 1, ry + 1)
            const px = (rx - 1) * TILE + TILE / 2
            const py = (ry - 1) * TILE + TILE / 2

            if (!maskCanvas) {
                drawDualGridCellTo(ctx, px, py, nw(tl), nw(tr), nw(bl), nw(br), rx, ry)
                continue
            }

            const htl = getRawHeight(map, rx,     ry)
            const htr = getRawHeight(map, rx + 1, ry)
            const hbl = getRawHeight(map, rx,     ry + 1)
            const hbr = getRawHeight(map, rx + 1, ry + 1)
            const minH = Math.min(htl, htr, hbl, hbr)
            const maxH = Math.max(htl, htr, hbl, hbr)

            if (minH === maxH) {
                drawDualGridCellTo(ctx, px, py, nw(tl), nw(tr), nw(bl), nw(br), rx, ry)
                continue
            }

            // Low-ground terrain fills the whole cell
            let anyLowPri = Infinity, anyLowT = tl
            if (htl === minH) { const p = tileset.priorityIndex.get(tl); if (p < anyLowPri) { anyLowPri = p; anyLowT = tl } }
            if (htr === minH) { const p = tileset.priorityIndex.get(tr); if (p < anyLowPri) { anyLowPri = p; anyLowT = tr } }
            if (hbl === minH) { const p = tileset.priorityIndex.get(bl); if (p < anyLowPri) { anyLowPri = p; anyLowT = bl } }
            if (hbr === minH) { const p = tileset.priorityIndex.get(br); if (p < anyLowPri) { anyLowPri = p; anyLowT = br } }
            const p1tl = htl === minH ? tl : anyLowT
            const p1tr = htr === minH ? tr : anyLowT
            const p1bl = hbl === minH ? bl : anyLowT
            const p1br = hbr === minH ? br : anyLowT
            drawDualGridCellTo(ctx, px, py, nw(p1tl), nw(p1tr), nw(p1bl), nw(p1br), rx, ry)
        }
    }
}

// --- Save / Load ---

// The name of the file currently being edited — set on Load/Save, used by
// Save to override the same file without prompting. Cleared on New.
let currentMapName = null
// File handle from the File System Access API, so "Save local" can overwrite
// the same local file without re-prompting. Only set in browsers that support it.
let localFileHandle = null

async function postMap(name, body) {
    const res = await fetch(`/maps/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    })
    return res.ok
}

function downloadMap(name, body) {
    const blob = new Blob([body], { type: 'application/json' })
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: name + '.json'
    })
    a.click()
    URL.revokeObjectURL(a.href)
}

async function applyMap(name, data) {
    // Check if the loaded map has a different tileset and switch if needed
    if (data.tileset && tilesetRegistry) {
        const targetTileset = tilesetRegistry.find(t => t.id === data.tileset)
        if (targetTileset && targetTileset.path !== tileset?.path) {
            await switchTileset(targetTileset.path)
            // Update the combobox selection
            const select = document.getElementById('tilesetSelect')
            if (select) select.value = targetTileset.path
        }
    }

    map = deserializeMap(data, tileset)
    map.id = name
    currentMapName = name
    // the loaded map is no longer the on-disk file a prior Save local pinned
    localFileHandle = null

    // Reset map_enter preview
    showMapEnterPreview = false
    mapEnterPreviewData = null
    const previewBtn = document.getElementById('btnMapEnterPreview')
    if (previewBtn) {
        previewBtn.classList.remove('active')
        previewBtn.textContent = '👁️'
        previewBtn.title = 'Preview map_enter (initial state)'
    }

    const field = document.getElementById('mapName')
    if (field) field.value = name
    sortedItemsDirty = true
    invalidateStaticCache()
    updateSpacer()
    renderMarksList()
    scheduleRender()
    exposeEditor()
}

async function save() {
    // Override the loaded file by name; if none is loaded yet, save to local disk.
    if (!currentMapName) return saveLocal()
    const name = currentMapName
    const body = JSON.stringify(serializeMap(map))
    if (await postMap(name, body)) return
    downloadMap(name, body)   // fallback: download as file
}

async function saveLocal() {
    const body = JSON.stringify(serializeMap(map))
    const field = document.getElementById('mapName')
    const defaultName = (currentMapName || field?.value || 'untitled').trim() || 'untitled'

    // File System Access API: a true Save-to-disk (can overwrite the same file).
    if (typeof window.showSaveFilePicker === 'function') {
        try {
            // Reuse a previously chosen handle so repeat saves overwrite silently.
            if (!localFileHandle) {
                localFileHandle = await window.showSaveFilePicker({
                    suggestedName: defaultName + '.json',
                    types: [{ description: 'Map JSON', accept: { 'application/json': ['.json'] } }]
                })
            }
            const writable = await localFileHandle.createWritable()
            await writable.write(body)
            await writable.close()
            const name = localFileHandle.name.replace(/\.json$/i, '')
            currentMapName = name
            if (field) field.value = name
            return
        } catch (e) {
            if (e && e.name === 'AbortError') return   // user cancelled
            // fall through to download fallback
        }
    }

    // Fallback: trigger a browser download.
    downloadMap(defaultName, body)
}

async function load() {
    const name = document.getElementById('mapName').value.trim() || 'untitled'
    // Don't try to fetch 'untitled' from server - it doesn't exist
    if (name !== 'untitled') {
        try {
            const res = await fetch(`/maps/${name}`)
            if (res.ok) {
                applyMap(name, await res.json())
                return
            }
        } catch {}
    }
    // fallback: open file picker (for 'untitled' or if server fetch failed)
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' })
    input.onchange = async () => {
        const f = input.files[0]
        // derive the map name (without extension) so Save overrides the same name
        const derived = f.name.replace(/\.json$/i, '')
        applyMap(derived, JSON.parse(await f.text()))
    }
    input.click()
}

init()