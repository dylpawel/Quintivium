import { loadImage } from './imaging.js'

export async function loadTilesetRegistry() {
  const res = await fetch('../tilesets/tilesets.json')
  return res.json()
}

export async function loadTileset(path) {
  const res = await fetch(path)
  const def = await res.json()

  const base = path.substring(0, path.lastIndexOf('/') + 1)

  const terrains = await Promise.all(def.terrains.map(async t => {
    const img = t.sprite ? await loadImage(base + t.sprite) : createEmptyTile(def.tileSize)
    const topImg = t.topSprite ? await loadImage(base + t.topSprite) : null
    return {
      ...t,
      base:     t.base     ?? false,
      variants: t.variants ?? 1,
      img,
      topImg
    }
  }))

  // load cliff sprites
  const cliffImg = def.cliff ? await loadImage(base + def.cliff) : null
  const cliffMaskCanvas = def.cliffMask ? await buildAlphaMask(base + def.cliffMask) : null

  // load elevation sprites
  const elevationImg       = def.elevation       ? await loadImage(base + def.elevation)       : null
  const elevationBottomImg = def.elevationBottom ? await loadImage(base + def.elevationBottom) : null
  const elevationMaskCanvas       = def.elevationMask   ? await buildAlphaMask(base + def.elevationMask)        : null
  const elevationShadowMaskCanvas = def.elevationMask   ? await buildInverseAlphaMask(base + def.elevationMask) : null
  const elevationShadowImg        = def.elevationShadow       ? await loadImage(base + def.elevationShadow)       : null
  const elevationBottomShadowImg  = def.elevationBottomShadow ? await loadImage(base + def.elevationBottomShadow) : null
  const rampImg       = def.ramp       ? await loadImage(base + def.ramp)       : null
  const rampShadowImg = def.rampShadow ? await loadImage(base + def.rampShadow) : null

  const fences = await Promise.all((def.fences ?? []).map(async f => {
    const img = await loadImage(base + f.sprite)
    return { ...f, img }
  }))

  return {
    ...def,
    terrains,
    cliffImg,
    cliffMaskCanvas,
    elevationImg,
    elevationBottomImg,
    elevationMaskCanvas,
    elevationShadowMaskCanvas,
    elevationShadowImg,
    elevationBottomShadowImg,
    rampImg,
    rampShadowImg,
    fences,
    fenceMap: Object.fromEntries(fences.map(f => [f.id, f])),
    baseTerrain:  terrains.find(t => t.base),
    waterTerrain: terrains.find(t => t.water) ?? terrains.find(t => t.base),
    priorityList: [...terrains].sort((a, b) =>
      def.priority.indexOf(a.id) - def.priority.indexOf(b.id)
    )
  }
}

function createEmptyTile(size) {
  const mc = document.createElement('canvas')
  mc.width = size
  mc.height = size
  const ctx = mc.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, size, size)
  const img = new Image()
  img.src = mc.toDataURL()
  return img
}

async function buildAlphaMask(src) {
  const img = await loadImage(src)
  const mc = document.createElement('canvas')
  mc.width  = img.width
  mc.height = img.height
  const mctx = mc.getContext('2d')
  mctx.drawImage(img, 0, 0)
  const id = mctx.getImageData(0, 0, mc.width, mc.height)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    // luminance of the B&W pixel becomes the alpha; RGB set to white
    d[i + 3] = Math.round((d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114))
    d[i] = d[i+1] = d[i+2] = 255
  }
  mctx.putImageData(id, 0, 0)
  return mc
}

async function buildInverseAlphaMask(src) {
  const img = await loadImage(src)
  const mc = document.createElement('canvas')
  mc.width  = img.width
  mc.height = img.height
  const mctx = mc.getContext('2d')
  mctx.drawImage(img, 0, 0)
  const id = mctx.getImageData(0, 0, mc.width, mc.height)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    // white pixels in mask = shadow area; alpha = luminance (white→opaque), RGB = black
    d[i + 3] = Math.round((d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114))
    d[i] = d[i+1] = d[i+2] = 0
  }
  mctx.putImageData(id, 0, 0)
  return mc
}