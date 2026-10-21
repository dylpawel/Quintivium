/**
 * Shared Monster Sprite Rendering
 * Used by both scriptActionEditor (dropdown thumbnails) and editor (map_enter preview)
 * Reads sprite configuration from unified enemies.json
 */

// Constants (matching game.js)
export const MONSTER_FRAME_W = 32
export const MONSTER_FRAME_H = 32
export const ENEMY_HAND_CELL = 16
export const ENEMY_WEP_CELL = 16
export const FRAME_BOB = [0, 1, 2, 1]

// Fixed row order in Enemies.png (must match game.js MONSTER_TYPES)
export const MONSTER_TYPES = [
  'Knight', 'Orc', 'OrcRogue', 'OrcShaman', 'OrcWarrior',
  'Rogue', 'Skeleton', 'SkeletonMage', 'SkeletonRogue', 'SkeletonWarrior', 'Wizard'
]

// Image caches (shared across importers)
let enemiesImg = null
let individualMonsterSprites = {}
let weaponHandsImg = null
let weaponBoneImg = null
let weaponWoodImg = null

// Data cache
let enemiesData = null

// Weapon trim cache (replicates game.js _wepTrimCache)
const wepTrimCache = {}

/**
 * Load enemies data and derive MONSTER_NAME_MAP
 * @returns {Promise<Array>} Array of enemy definitions
 */
export async function loadEnemiesData() {
  if (enemiesData) return enemiesData
  const res = await fetch('../characters/enemies.json')
  if (!res.ok) throw new Error('Failed to load enemies.json')
  enemiesData = await res.json()
  return enemiesData
}

/**
 * Get MONSTER_TYPES actually used in enemies.json (in Enemies.png row order)
 * @returns {Promise<Array<string>>}
 */
export async function getMonsterTypes() {
  const data = await loadEnemiesData()
  const usedBases = new Set()
  for (const e of data) {
    if (e.sprite && (e.sprite.mode === 'composite' || e.sprite.mode === 'sheet')) {
      usedBases.add(e.sprite.base)
    }
  }
  // Return in the fixed Enemies.png row order
  return MONSTER_TYPES.filter(base => usedBases.has(base))
}

/**
 * Get MONSTER_NAME_MAP derived from enemies.json
 * Maps enemy display name -> sprite base name
 * @returns {Promise<Object>}
 */
export async function getMonsterNameMap() {
  const data = await loadEnemiesData()
  const map = {}
  for (const e of data) {
    if (e.sprite) {
      map[e.name] = e.sprite.base
    }
  }
  // Add fallback for names not in data (e.g., base names themselves)
  for (const e of data) {
    if (e.sprite) {
      map[e.sprite.base] = e.sprite.base
    }
  }
  return map
}

/**
 * Compute weapon trim (replicates game.js _computeWeaponTrim)
 * @param {HTMLImageElement} img - Weapon spritesheet image
 * @param {number} sx - Source X
 * @param {number} sy - Source Y
 * @param {number} sw - Source width
 * @param {number} sh - Source height
 * @returns {Object|null} Trim data {sx, sy, sw, sh, dx, dy} or null
 */
function computeWeaponTrim(img, sx, sy, sw, sh) {
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const tmp = document.createElement('canvas')
  tmp.width = sw; tmp.height = sh
  const tctx = tmp.getContext('2d')
  tctx.imageSmoothingEnabled = false
  tctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const data = tctx.getImageData(0, 0, sw, sh).data
  let minX = sw, minY = sh, maxX = -1, maxY = -1
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const alpha = data[(y * sw + x) * 4 + 3]
      if (alpha > 16) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) return null
  const tw = maxX - minX + 1
  const th = maxY - minY + 1
  return {
    sx: sx + minX, sy: sy + minY,
    sw: tw, sh: th,
    dx: (minX + tw / 2) - sw / 2,
    dy: (minY + th / 2) - sh / 2
  }
}

/**
 * Get weapon trim (replicates game.js _getWeaponTrim)
 * @param {string} file - Weapon file name
 * @param {number} col - Column
 * @param {number} row - Row
 * @param {number} cols - Number of columns
 * @param {number} rows - Number of rows
 * @returns {Object|null} Trim data or null
 */
function getWeaponTrim(file, col, row, cols, rows) {
  if (col == null || row == null) return null
  const key = `${file}:${col},${row},${cols},${rows}`
  if (key in wepTrimCache) return wepTrimCache[key]
  let img
  if (file === 'Weapon-Hands') img = weaponHandsImg
  else if (file === 'Weapon-Bone') img = weaponBoneImg
  else if (file === 'Weapon-Wood') img = weaponWoodImg
  else return null
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const t = computeWeaponTrim(img, col * ENEMY_WEP_CELL, row * ENEMY_WEP_CELL,
                              cols * ENEMY_WEP_CELL, rows * ENEMY_WEP_CELL)
  wepTrimCache[key] = t
  return t
}

/**
 * Preload all required monster images based on enemies.json
 * @returns {Promise<void>}
 */
export async function preloadMonsterImages() {
  const data = await loadEnemiesData()
  const promises = []

  // Helper to load/retry an image
  const loadImg = (imgRef, src) => {
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      return Promise.resolve()
    }
    const img = new Image()
    img.src = src
    imgRef.current = img
    return new Promise(resolve => { img.onload = img.onerror = resolve })
  }

  // Collect unique sprite bases/files needed
  const sheetBases = new Set()
  const individualFiles = new Set()
  for (const e of data) {
    const s = e.sprite
    if (s.mode === 'composite' || s.mode === 'sheet') {
      sheetBases.add(s.base)
    } else if (s.mode === 'simple' || s.mode === 'hero') {
      individualFiles.add(s.file)
    }
  }

  // Load Enemies.png if any sheet-based sprites needed
  if (sheetBases.size > 0) {
    const enemiesRef = { current: enemiesImg }
    promises.push(loadImg(enemiesRef, '../characters/Enemies.png').then(() => {
      enemiesImg = enemiesRef.current
    }))
  }

  // Load individual sprite files
  for (const file of individualFiles) {
    const base = file.replace('.png', '')
    const ref = { current: individualMonsterSprites[base] }
    promises.push(loadImg(ref, `../characters/${file}`).then(() => {
      individualMonsterSprites[base] = ref.current
    }))
  }

  // Weapon sprites
  const handsRef = { current: weaponHandsImg }
  const boneRef = { current: weaponBoneImg }
  const woodRef = { current: weaponWoodImg }
  promises.push(loadImg(handsRef, '../characters/Weapon-Hands.png').then(() => { weaponHandsImg = handsRef.current }))
  promises.push(loadImg(boneRef, '../characters/Weapon-Bone.png').then(() => { weaponBoneImg = boneRef.current }))
  promises.push(loadImg(woodRef, '../characters/Weapon-Wood.png').then(() => { weaponWoodImg = woodRef.current }))

  await Promise.all(promises)
}

/**
 * Get monster thumbnail (first frame) for combobox/dropdown previews
 * Handles all sprite modes: composite, sheet, simple, hero
 * @param {string} enemyName - Enemy display name
 * @param {number} size - Output size (default 32)
 * @returns {Promise<HTMLCanvasElement|null>} Canvas with thumbnail or null
 */
export async function getMonsterThumbnail(enemyName, size = 32) {
  const data = await loadEnemiesData()
  const enemy = data.find(e => e.name === enemyName)
  if (!enemy || !enemy.sprite) return null

  await preloadMonsterImages()

  const sprite = enemy.sprite
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  switch (sprite.mode) {
    case 'composite':
      // Draw composite at frame 0, scaled to size
      // Use a temporary canvas at base resolution then scale
      const baseCanvas = document.createElement('canvas')
      baseCanvas.width = MONSTER_FRAME_W
      baseCanvas.height = MONSTER_FRAME_H
      const bctx = baseCanvas.getContext('2d')
      bctx.imageSmoothingEnabled = false
      drawCompositeEnemyOnContext(bctx, enemy, 1, 0)
      ctx.drawImage(baseCanvas, 0, 0, size, size)
      break

    case 'sheet': {
      // Draw first frame from Enemies.png row (use full MONSTER_TYPES for correct row positions)
      const rowIndex = MONSTER_TYPES.indexOf(sprite.base)
      if (rowIndex >= 0 && enemiesImg && enemiesImg.complete && enemiesImg.naturalWidth > 0) {
        const rowHeight = enemiesImg.height / MONSTER_TYPES.length
        ctx.drawImage(enemiesImg, 0, rowIndex * rowHeight, enemiesImg.width, rowHeight, 0, 0, size, size)
      }
      break
    }

    case 'simple':
    case 'hero': {
      // Draw first frame from individual file
      const img = individualMonsterSprites[sprite.base]
      if (img && img.complete && img.naturalWidth > 0) {
        const frameW = img.width / (sprite.frames || 4)
        const srcW = frameW
        const srcH = img.height
        ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, size, size)
      }
      break
    }
  }

  return canvas
}

/**
 * Get monster preview sprite (first frame) - synchronous version using cached images
 * @param {string} enemyName - Enemy display name
 * @returns {HTMLCanvasElement|null} 32x32 canvas with first frame, or null
 */
export function getMonsterPreviewSprite(enemyName) {
  // Find enemy in cached data
  if (!enemiesData) return null
  const enemy = enemiesData.find(e => e.name === enemyName)
  if (!enemy || !enemy.sprite) return null

  const sprite = enemy.sprite

  // Check individual sprite files first (for simple/hero)
  if ((sprite.mode === 'simple' || sprite.mode === 'hero') &&
      individualMonsterSprites[sprite.base] &&
      individualMonsterSprites[sprite.base].complete &&
      individualMonsterSprites[sprite.base].naturalWidth > 0) {
    const img = individualMonsterSprites[sprite.base]
    // Use sprite config frame dimensions (fallback to defaults)
    const frameW = sprite.frameW ?? MONSTER_FRAME_W
    const frameH = sprite.frameH ?? MONSTER_FRAME_H
    const canvas = document.createElement('canvas')
    canvas.width = frameW
    canvas.height = frameH
    const cctx = canvas.getContext('2d')
    cctx.imageSmoothingEnabled = false
    const srcFrameW = img.width / (sprite.frames || 4)
    cctx.drawImage(img, 0, 0, srcFrameW, img.height, 0, 0, frameW, frameH)
    return canvas
  }

  // Check Enemies.png for sheet/composite
  const rowIndex = MONSTER_TYPES.indexOf(sprite.base)
  if ((sprite.mode === 'composite' || sprite.mode === 'sheet') &&
      rowIndex >= 0 && enemiesImg && enemiesImg.complete && enemiesImg.naturalWidth > 0) {
    const rowHeight = enemiesImg.height / MONSTER_TYPES.length
    const canvas = document.createElement('canvas')
    canvas.width = MONSTER_FRAME_W
    canvas.height = MONSTER_FRAME_H
    const cctx = canvas.getContext('2d')
    cctx.imageSmoothingEnabled = false
    cctx.drawImage(enemiesImg, 0, rowIndex * rowHeight, MONSTER_FRAME_W, rowHeight, 0, 0, MONSTER_FRAME_W, MONSTER_FRAME_H)
    return canvas
  }

  return null
}

/**
 * Draw monster preview sprite at world position (for map_enter preview)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {string} enemyName - Enemy display name
 * @param {number} worldX - World X position (center)
 * @param {number} worldY - World Y position (center)
 * @param {number} scale - Scale factor (default 1)
 * @param {number} alpha - Opacity (default 0.7)
 */
export function drawMonsterPreview(ctx, enemyName, worldX, worldY, scale = 1, alpha = 0.7) {
  const data = enemiesData
  if (!data) return false
  const enemy = data.find(e => e.name === enemyName)
  if (!enemy || !enemy.sprite) return false

  const sprite = getMonsterPreviewSprite(enemyName)
  if (!sprite) return false

  // Use sprite config frame dimensions for proper scaling
  const frameW = enemy.sprite.frameW ?? MONSTER_FRAME_W
  const frameH = enemy.sprite.frameH ?? MONSTER_FRAME_H
  const dw = frameW * scale
  const dh = frameH * scale

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(worldX, worldY)
  ctx.drawImage(sprite, 0, 0, frameW, frameH, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
  return true
}

/**
 * Draw composite enemy (body + hands + weapons) to canvas at given scale
 * For use in dropdown thumbnails (scale=1) and stats display (scale=3 or 4)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} enemy - Enemy definition from enemies.json (with sprite config)
 * @param {number} scale - Scale factor (1 = 32x32, 3 = 96x96, 4 = 128x128)
 * @param {number} frame - Animation frame (default 0 for idle)
 */
export function drawCompositeEnemy(ctx, enemy, scale = 1, frame = 0) {
  const sprite = enemy.sprite
  if (sprite.mode !== 'composite') return

  drawCompositeEnemyOnContext(ctx, enemy, scale, frame)
}

/**
 * Internal: Draw composite enemy on a context
 */
function drawCompositeEnemyOnContext(ctx, enemy, scale, frame) {
  const sprite = enemy.sprite
  const bob = FRAME_BOB[frame]
  const lh = sprite.hands?.left ?? { x: -10, y: 6, z: 3 }
  const rh = sprite.hands?.right ?? { x: 10, y: 6, z: 3 }
  const charZ = sprite.z ?? 1
  const handRow = sprite.handRow ?? null
  const weps = (sprite.weapons ?? []).filter(w => w && w.col != null)

  // Center of the canvas
  const cx = (MONSTER_FRAME_W * scale) / 2
  const cy = (MONSTER_FRAME_H * scale) / 2

  ctx.save()
  ctx.translate(cx, cy)
  ctx.imageSmoothingEnabled = false

  const layers = []

  // Character body
  const charSprite = getCharacterSprite(sprite.base)
  if (charSprite) {
    layers.push({ z: charZ, fn: () => {
      const fw = MONSTER_FRAME_W * scale
      const fh = MONSTER_FRAME_H * scale
      ctx.drawImage(charSprite,
        frame * MONSTER_FRAME_W, 0, MONSTER_FRAME_W, MONSTER_FRAME_H,
        -fw / 2, -fh / 2, fw, fh)
    }})
  }

  // Hands
  if (weaponHandsImg && handRow !== null) {
    for (const [col, side] of [[0, lh], [1, rh]]) {
      const s = side
      layers.push({ z: s.z ?? 3, fn: () => {
        const hw = ENEMY_HAND_CELL * scale
        const hh = ENEMY_HAND_CELL * scale
        ctx.drawImage(weaponHandsImg,
          col * ENEMY_HAND_CELL, handRow * ENEMY_HAND_CELL, ENEMY_HAND_CELL, ENEMY_HAND_CELL,
          s.x * scale - hw / 2, (s.y + bob) * scale - hh / 2, hw, hh)
      }})
    }
  }

  // Weapons
  for (const w of weps) {
    let wImg
    if (w.file === 'Weapon-Hands') wImg = weaponHandsImg
    else if (w.file === 'Weapon-Bone') wImg = weaponBoneImg
    else if (w.file === 'Weapon-Wood') wImg = weaponWoodImg
    if (!wImg) continue

    const t = getWeaponTrim(w.file, w.col, w.row, w.cols ?? 1, w.rows ?? 1)
    if (!t) continue

    const rot = (w.rot ?? 0) * Math.PI / 180
    const fH = w.flipH ?? false
    const fV = w.flipV ?? false
    const wz = w.z ?? 2

    layers.push({ z: wz, fn: () => {
      const ox = (w.x + t.dx) * scale
      const oy = (w.y + bob + t.dy) * scale
      const dw = t.sw * scale
      const dh = t.sh * scale
      ctx.save()
      ctx.translate(ox, oy)
      if (rot) ctx.rotate(rot)
      if (fH || fV) ctx.scale(fH ? -1 : 1, fV ? -1 : 1)
      ctx.drawImage(wImg, t.sx, t.sy, t.sw, t.sh, -dw / 2, -dh / 2, dw, dh)
      ctx.restore()
    }})
  }

  layers.sort((a, b) => a.z - b.z)
  layers.forEach(l => l.fn())
  ctx.restore()
}

/**
 * Get the full character sprite row (all frames) for custom dropdown rendering
 * @param {string} baseName - Character/sprite base name (e.g., "Skeleton")
 * @returns {HTMLCanvasElement|null} Canvas with full row, or null
 */
export function getCharacterSprite(baseName) {
  const rowIndex = MONSTER_TYPES.indexOf(baseName)

  if (rowIndex >= 0 && enemiesImg && enemiesImg.complete && enemiesImg.naturalWidth > 0) {
    const rowHeight = enemiesImg.height / MONSTER_TYPES.length
    const canvas = document.createElement('canvas')
    canvas.width = enemiesImg.width
    canvas.height = rowHeight
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(enemiesImg, 0, rowIndex * rowHeight, enemiesImg.width, rowHeight, 0, 0, enemiesImg.width, rowHeight)
    return canvas
  }

  if (individualMonsterSprites[baseName] && individualMonsterSprites[baseName].complete && individualMonsterSprites[baseName].naturalWidth > 0) {
    return individualMonsterSprites[baseName]
  }

  return null
}

// Derived constants - populated after loadEnemiesData()
export let USED_MONSTER_TYPES = []
export let MONSTER_NAME_MAP = {}

/**
 * Initialize derived constants (call after loadEnemiesData)
 */
export async function initMonsterConstants() {
  await loadEnemiesData()
  USED_MONSTER_TYPES = await getMonsterTypes()
  MONSTER_NAME_MAP = await getMonsterNameMap()
}