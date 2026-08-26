import { loadImage } from './imaging.js'

export async function loadAssets(basePath) {
  const res = await fetch(basePath + 'definitions.json')
  const def = await res.json()

  // load tileset images
  const tilesetMap = {}
  await Promise.all(def.tilesets.map(async ts => {
    const img = await loadImage(basePath + ts.file)
    tilesetMap[ts.id] = { ...ts, img }
  }))

  // normalise assets
  const assets = def.assets.map(a => {
    // Support both old format (top-level region) and new states-based format
    const normalizedStates = normaliseStates(a)
    const defaultStateId = a.defaultState || (normalizedStates[0]?.id ?? '')
    const activeState = normalizedStates.find(s => s.id === defaultStateId) ?? normalizedStates[0]

    return {
      ...a,
      states:      normalizedStates,
      defaultState: defaultStateId,
      region:      activeState.region,      // [x, y, w, h] from default state
      traversable: activeState.traversable ?? null,
      pivot:       a.pivot   ?? [0.5, 0.5],
      jitter:      a.jitter  ?? 0,
      surface:     a.surface ?? [],
      tags:        a.tags    ?? [],
      shadow:      normaliseShadow(a),
      flip:        a.flip !== false,
      scaleMin:    a.scaleMin ?? 1.0,
      scaleMax:    a.scaleMax ?? 1.0,
      tileset:     tilesetMap[a.tileset_id]
    }
  })

  // build id lookup
  const assetMap = {}
  for (const a of assets) assetMap[a.id] = a

  return { assets, assetMap }
}

function normaliseStates(a) {
  if (a.states && a.states.length > 0) {
    return a.states.map(s => ({
      ...s,
      region: normaliseRegion(s.region)
    }))
  }
  // legacy: top-level region / traversable
  const s = { id: 'default', region: normaliseRegion(a.region ?? [0, 0, 1, 1]) }
  if (a.traversable) s.traversable = a.traversable
  return [s]
}

function normaliseRegion(r) {
  if (!r) return [0, 0, 1, 1]
  return r.length === 2 ? [...r, 1, 1] : [...r]
}

function normaliseShadow(a) {
  if (a.ovalShadow)   return { type: 'oval',   rx: a.ovalShadow[0], ry: a.ovalShadow[1], opacity: a.ovalShadow[2] }
  if (a.spriteShadow) return { type: 'sprite', d: a.spriteShadow[0], opacity: a.spriteShadow[1] }
  if (a.skewShadow !== undefined) return { type: 'skew', opacity: a.skewShadow }
  if (a.rayTracedShadow) return { type: 'ray', angle: a.rayTracedShadow[0], length: a.rayTracedShadow[1], opacity: a.rayTracedShadow[2] }
  return null
}

