/**
 * Shared Monster Sprite Rendering
 * Used by both scriptActionEditor (dropdown thumbnails) and editor (map_enter preview)
 */

// Monster types in Enemies.png (matching game.js MONSTER_TYPES)
export const MONSTER_TYPES = [
  'Knight', 'Orc', 'OrcRogue', 'OrcShaman', 'OrcWarrior',
  'Rogue', 'Skeleton', 'SkeletonMage', 'SkeletonRogue', 'SkeletonWarrior', 'Wizard'
]

// Constants from game.js
export const MONSTER_FRAME_W = 32
export const MONSTER_FRAME_H = 32
export const ENEMY_HAND_CELL = 16
export const ENEMY_WEP_CELL = 16
export const FRAME_BOB = [0, 1, 2, 1]

// Image caches (shared across importers)
let enemiesImg = null
let individualMonsterSprites = {}
let weaponHandsImg = null
let weaponBoneImg = null
let weaponWoodImg = null

const MONSTER_NAME_MAP = {
  'Skeleton Fighter': 'Skeleton',
  'Skeleton Bandit': 'SkeletonRogue',
  'Skeleton Footman': 'SkeletonWarrior',
  'Skeleton Soldier': 'SkeletonWarrior',
  'Skeleton Piercer': 'SkeletonRogue',
  'Skeleton Mage': 'SkeletonMage',
  'Skeleton Scholar': 'SkeletonMage',
  'Skeleton Rogue': 'SkeletonRogue',
  'Skeleton Warrior': 'SkeletonWarrior',
  'Skeleton': 'Skeleton',
  'Orc': 'Orc',
  'Orc Rogue': 'OrcRogue',
  'Orc Shaman': 'OrcShaman',
  'Orc Warrior': 'OrcWarrior',
  'Knight': 'Knight',
  'Rogue': 'Rogue',
  'Wizard': 'Wizard',
  'Gorilla': 'Gorilla',
  'Hero-Crab': 'Hero-Crab',
  'Crab': 'Hero-Crab'
}

// Weapon trim cache (replicates game.js _wepTrimCache)
const wepTrimCache = {}

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
    // Absolute source coordinates in the original image (matching AnimationDemo.html)
    sx: sx + minX, sy: sy + minY,
    sw: tw, sh: th,
    // dx, dy = offset from cell center to visual center (matching AnimationDemo.html)
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
  // Handle undefined col/row (missing weapon data)
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
 * Preload all required monster images
 * @returns {Promise<void>}
 */
export async function preloadMonsterImages() {
  const promises = []

  // Helper to load/retry an image
  const loadImg = (imgRef, src) => {
    // If image exists and loaded successfully, skip
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      return Promise.resolve()
    }
    const img = new Image()
    img.src = src
    imgRef.current = img
    return new Promise(resolve => { img.onload = img.onerror = resolve })
  }

  // Use refs to allow reassignment
  const enemiesRef = { current: enemiesImg }
  const handsRef = { current: weaponHandsImg }
  const boneRef = { current: weaponBoneImg }
  const woodRef = { current: weaponWoodImg }

  promises.push(loadImg(enemiesRef, '../characters/Enemies.png'))
  promises.push(loadImg(handsRef, '../characters/Weapon-Hands.png'))
  promises.push(loadImg(boneRef, '../characters/Weapon-Bone.png'))
  promises.push(loadImg(woodRef, '../characters/Weapon-Wood.png'))

  for (const charName of ['Gorilla', 'Hero-Crab']) {
    const ref = { current: individualMonsterSprites[charName] }
    promises.push(loadImg(ref, `../characters/${charName}.png`).then(() => {
      individualMonsterSprites[charName] = ref.current
    }))
  }

  await Promise.all(promises)

  // Update module-level variables
  enemiesImg = enemiesRef.current
  weaponHandsImg = handsRef.current
  weaponBoneImg = boneRef.current
  weaponWoodImg = woodRef.current
}

/**
 * Get monster sprite canvas (first frame only) for preview/thumbnails
 * @param {string} monsterName - Monster display name
 * @returns {HTMLCanvasElement|null} 32x32 canvas with first frame, or null
 */
export function getMonsterPreviewSprite(monsterName) {
  const spriteName = MONSTER_NAME_MAP[monsterName] || monsterName

  // Check Enemies.png first
  const rowIndex = MONSTER_TYPES.indexOf(spriteName)
  if (rowIndex >= 0 && enemiesImg && enemiesImg.complete && enemiesImg.naturalWidth > 0) {
    const rowHeight = enemiesImg.height / MONSTER_TYPES.length
    const canvas = document.createElement('canvas')
    canvas.width = MONSTER_FRAME_W
    canvas.height = MONSTER_FRAME_H
    const cctx = canvas.getContext('2d')
    cctx.imageSmoothingEnabled = false
    cctx.drawImage(enemiesImg, 0, rowIndex * rowHeight, MONSTER_FRAME_W, rowHeight, 0, 0, MONSTER_FRAME_W, MONSTER_FRAME_H)
    return canvas
  }

  // Check individual sprite files
  if (individualMonsterSprites[spriteName] && individualMonsterSprites[spriteName].complete && individualMonsterSprites[spriteName].naturalWidth > 0) {
    const img = individualMonsterSprites[spriteName]
    const canvas = document.createElement('canvas')
    canvas.width = MONSTER_FRAME_W
    canvas.height = MONSTER_FRAME_H
    const cctx = canvas.getContext('2d')
    cctx.imageSmoothingEnabled = false
    const frameW = img.width / 4
    cctx.drawImage(img, 0, 0, frameW, img.height, 0, 0, MONSTER_FRAME_W, MONSTER_FRAME_H)
    return canvas
  }

  return null
}

/**
 * Draw monster preview sprite at world position (for map_enter preview)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {string} monsterName - Monster display name
 * @param {number} worldX - World X position (center)
 * @param {number} worldY - World Y position (center)
 * @param {number} scale - Scale factor (default 1)
 * @param {number} alpha - Opacity (default 0.7)
 */
export function drawMonsterPreview(ctx, monsterName, worldX, worldY, scale = 1, alpha = 0.7) {
  const sprite = getMonsterPreviewSprite(monsterName)
  if (!sprite) return false

  const dw = MONSTER_FRAME_W * scale
  const dh = MONSTER_FRAME_H * scale

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(worldX, worldY)
  ctx.drawImage(sprite, 0, 0, MONSTER_FRAME_W, MONSTER_FRAME_H, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
  return true
}

/**
 * Draw composite enemy (body + hands + weapons) to canvas at given scale
 * For use in dropdown thumbnails (scale=1) and stats display (scale=3 or 4)
 * @param {CanvasRenderingContext2D} ctx - Canvas context (canvas should be sized appropriately for scale)
 * @param {Object} def - Monster definition from enemies.json
 * @param {number} scale - Scale factor (1 = 32x32, 3 = 96x96, 4 = 128x128)
 * @param {number} frame - Animation frame (default 0 for idle)
 */
export function drawCompositeEnemy(ctx, def, scale = 1, frame = 0) {
  const bob = FRAME_BOB[frame]
  const lh = def.lh ?? { x: -10, y: 6, z: 3 }
  const rh = def.rh ?? { x: 10, y: 6, z: 3 }
  const charZ = def.charZ ?? def.char?.z ?? 1
  const handRow = def.handRow ?? null
  const weps = [def.wep1, def.wep2].filter(w => w && w.col != null)

  // Center of the canvas
  const cx = (MONSTER_FRAME_W * scale) / 2
  const cy = (MONSTER_FRAME_H * scale) / 2

  ctx.save()
  ctx.translate(cx, cy)
  ctx.imageSmoothingEnabled = false

  const layers = []

  // Character body
  const charSprite = getCharacterSprite(def.charName)
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
 * @param {string} charName - Character/sprite name
 * @returns {HTMLCanvasElement|null} Canvas with full row, or null
 */
export function getCharacterSprite(charName) {
  const spriteName = MONSTER_NAME_MAP[charName] || charName
  const rowIndex = MONSTER_TYPES.indexOf(spriteName)

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

  if (individualMonsterSprites[spriteName] && individualMonsterSprites[spriteName].complete && individualMonsterSprites[spriteName].naturalWidth > 0) {
    return individualMonsterSprites[spriteName]
  }

  return null
}