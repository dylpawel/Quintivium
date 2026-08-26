export function createMap(width, height, tileset) {
  const baseId = tileset.baseTerrain.id
  return {
    width,
    height,
    tileset: tileset.id,
    _terrain: Array.from({ length: height + 2 }, () =>
      Array(width + 2).fill(baseId)
    ),
    _heights: Array.from({ length: height + 2 }, () =>
      Array(width + 2).fill(0)
    ),
    _decorations: Array.from({ length: height }, () =>
      Array(width).fill(null)
    ),
    _items: Array.from({ length: height }, () =>
      Array(width).fill(null)
    ),
    // _ramps[y][x]: true if cell (x,y) has a ramp on its south face (going down to row y+1).
    // Ramps are always 2 cells wide; both (x,y) and (x+1,y) are set true for one ramp.
    _ramps: Array.from({ length: height }, () => Array(width).fill(false)),
    // Horizontal fence edges: _hFences[cy][cx] is the segment between corners (cx,cy)–(cx+1,cy).
    // cy ∈ [0, height], cx ∈ [0, width-1]
    _hFences: Array.from({ length: height + 1 }, () => Array(width).fill(null)),
    // Vertical fence edges: _vFences[cy][cx] is the segment between corners (cx,cy)–(cx,cy+1).
    // cy ∈ [0, height-1], cx ∈ [0, width]
    _vFences: Array.from({ length: height }, () => Array(width + 1).fill(null)),
    _marks: {},  // key: "x,y" → name string
    _effects: [] // [{ type, wx, wy, scale, phase }]
  }
}

export function setCell(map, x, y, terrainId) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
  map._terrain[y + 1][x + 1] = terrainId
}

export function getCell(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null
  return map._terrain[y + 1][x + 1]
}

export function placeDecoration(map, assetId, x, y, jitter, stateId, flipAllowed = true, scaleMin = 1.0, scaleMax = 1.0) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
  const dx = jitter > 0 ? Math.round((Math.random() * 2 - 1) * jitter) : 0
  const dy = jitter > 0 ? Math.round((Math.random() * 2 - 1) * jitter) : 0
  const flipX = flipAllowed && Math.random() < 0.5
  const scale = scaleMin >= scaleMax
    ? scaleMin
    : Math.round((scaleMin + Math.random() * (scaleMax - scaleMin)) * 100) / 100
  const dec = { assetId, x, y, dx, dy, flipX, scale }
  if (stateId) dec.stateId = stateId
  map._decorations[y][x] = dec
}

export function removeDecoration(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
  map._decorations[y][x] = null
}

export function getDecorations(map) {
  const result = []
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (map._decorations[y][x] !== null)
        result.push(map._decorations[y][x])
  return result
}

// used by renderer — includes padding, no bounds check
export function getRaw(map, x, y) {
  return map._terrain[y][x]
}

export function getHeight(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0
  return map._heights[y + 1][x + 1]
}

export function setHeight(map, x, y, val) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return
  map._heights[y + 1][x + 1] = Math.max(0, Math.min(4, val))
}

export function getRawHeight(map, x, y) {
  return map._heights[y]?.[x] ?? 0
}

export function getRamp(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height - 1) return false
  return map._ramps[y][x]
}

export function setRamp(map, x, y, val) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height - 1) return
  map._ramps[y][x] = val
}

// Horizontal fence edges — segment between corners (cx,cy) and (cx+1,cy)
// cx ∈ [0, width-1], cy ∈ [0, height]
export function getHFence(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= map.width || cy > map.height) return null
  return map._hFences[cy]?.[cx] ?? null
}
export function setHFence(map, cx, cy, typeId) {
  if (cx < 0 || cy < 0 || cx >= map.width || cy > map.height) return
  map._hFences[cy][cx] = typeId
}
export function removeHFence(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= map.width || cy > map.height) return
  map._hFences[cy][cx] = null
}

// Vertical fence edges — segment between corners (cx,cy) and (cx,cy+1)
// cx ∈ [0, width], cy ∈ [0, height-1]
export function getVFence(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx > map.width || cy >= map.height) return null
  return map._vFences[cy]?.[cx] ?? null
}
export function setVFence(map, cx, cy, typeId) {
  if (cx < 0 || cy < 0 || cx > map.width || cy >= map.height) return
  map._vFences[cy][cx] = typeId
}
export function removeVFence(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx > map.width || cy >= map.height) return
  map._vFences[cy][cx] = null
}

export function floodFill(map, startX, startY, newId) {
  const oldId = getCell(map, startX, startY)
  if (oldId === null || oldId === newId) return
  const stack = [[startX, startY]]
  while (stack.length) {
    const [x, y] = stack.pop()
    if (getCell(map, x, y) !== oldId) continue
    setCell(map, x, y, newId)
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1])
  }
}

export function serializeMap(map) {
  const decorations = []
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (map._decorations[y][x] !== null)
        decorations.push(map._decorations[y][x])

  const items = []
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (map._items[y][x] !== null)
        items.push({ ...map._items[y][x], x, y })

  const ramps = []
  for (let y = 0; y < map.height - 1; y++)
    for (let x = 0; x < map.width; x++)
      if (map._ramps[y][x]) ramps.push([x, y])

  return {
    width:  map.width,
    height: map.height,
    tileset: map.tileset,
    terrain: Array.from({ length: map.height }, (_, y) =>
      Array.from({ length: map.width }, (__, x) => getCell(map, x, y))
    ),
    heights: Array.from({ length: map.height }, (_, y) =>
      Array.from({ length: map.width }, (__, x) => getHeight(map, x, y))
    ),
    decorations,
    items,
    ramps,
    marks: Object.entries(map._marks).map(([k, v]) => {
      const [x, y] = k.split(',').map(Number)
      return { x, y, name: v }
    }),
    effects: map._effects ?? [],
    hFences: (() => {
      const arr = []
      for (let cy = 0; cy <= map.height; cy++)
        for (let cx = 0; cx < map.width; cx++)
          if (map._hFences[cy][cx]) arr.push({ x: cx, y: cy, t: map._hFences[cy][cx] })
      return arr
    })(),
    vFences: (() => {
      const arr = []
      for (let cy = 0; cy < map.height; cy++)
        for (let cx = 0; cx <= map.width; cx++)
          if (map._vFences[cy][cx]) arr.push({ x: cx, y: cy, t: map._vFences[cy][cx] })
      return arr
    })()
  }
}

export function deserializeMap(data, tileset) {
  const map = createMap(data.width, data.height, tileset)
  for (let y = 0; y < data.height; y++)
    for (let x = 0; x < data.width; x++)
      setCell(map, x, y, data.terrain[y][x])
  for (const d of data.decorations ?? [])
    if (d.x >= 0 && d.y >= 0 && d.x < map.width && d.y < map.height)
      map._decorations[d.y][d.x] = d
  for (const item of data.items ?? [])
    if (item.x >= 0 && item.y >= 0 && item.x < map.width && item.y < map.height)
      map._items[item.y][item.x] = { itemId: item.itemId, qty: item.qty }
  for (let y = 0; y < data.height; y++)
    for (let x = 0; x < data.width; x++)
      if (data.heights?.[y]?.[x] !== undefined)
        setHeight(map, x, y, data.heights[y][x])
  for (const [x, y] of data.ramps ?? []) setRamp(map, x, y, true)
  for (const { x, y, name } of data.marks ?? []) map._marks[`${x},${y}`] = name
  for (const { x, y, t } of data.hFences ?? []) setHFence(map, x, y, t)
  for (const { x, y, t } of data.vFences ?? []) setVFence(map, x, y, t)
  map._effects = [...(data.effects ?? [])]
  // Migrate old wx/wy world-pixel format to x/y/dx/dy tile format (TILE=32)
  for (const ef of map._effects) {
    if ('wx' in ef && !('x' in ef)) {
      ef.x = Math.floor(ef.wx / 32)
      ef.y = Math.floor(ef.wy / 32)
      ef.dx = Math.round(ef.wx - (ef.x * 32 + 16))
      ef.dy = Math.round(ef.wy - (ef.y * 32 + 16))
      delete ef.wx
      delete ef.wy
    }
  }
  return map
}