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
    _effects: [], // [{ type, wx, wy, scale, phase }]
    _scripts: [] // [{ id, name, on, once, condition, tile, map, npc, actions }]
  }
}

/**
 * Script schema - defines all valid script fields per ECA_REFERENCE.md
 * Required: id, on, actions
 * Optional: condition, once, map, tile, npc
 * This ensures no field ever disappears during serialization/deserialization
 */
export const SCRIPT_SCHEMA = {
  id: () => crypto.randomUUID(),
  on: undefined,      // REQUIRED - must be set explicitly (no default)
  condition: '',      // optional, empty string = omitted in output
  once: false,        // optional, default false
  tile: null,         // optional: string mark name OR { x, y, mark? } | null
  map: null,          // optional: map id string | null
  npc: null,          // optional: npc id string | null
  actions: []         // REQUIRED - array of action objects
}

/**
 * Normalize a script object to match SCRIPT_SCHEMA (ECA_REFERENCE.md)
 * Ensures required fields exist, migrates old field names, applies defaults
 * @param {Object} script - Raw script object (from JSON, user input, etc.)
 * @returns {Object} Normalized script with all valid fields
 */
export function normalizeScript(script) {
  if (!script || typeof script !== 'object') return createEmptyScript()

  // Migrate old field names
  const on = script.on ?? script.event
  const condition = script.condition ?? script.conditions ?? ''
  const once = script.once === true
  const tile = normalizeTile(script.tile)
  const map = script.map || null
  const npc = script.npc || null
  const actions = Array.isArray(script.actions) ? script.actions : []
  const id = script.id ?? crypto.randomUUID()

  // Return normalized script with ONLY valid fields (no name, no enabled, no event/conditions)
  return {
    id,
    on,
    condition,
    once,
    tile,
    map,
    npc,
    actions
  }
}

/**
 * Create a new empty script with required fields set to defaults
 * Caller MUST provide 'on' (event type) and ideally 'actions'
 * @param {Object} overrides - Fields to override (must include 'on')
 * @returns {Object} New script object
 */
export function createEmptyScript(overrides = {}) {
  return normalizeScript(overrides)
}

/**
 * Normalize all scripts in an array
 * @param {Array} scripts - Array of raw script objects
 * @returns {Array} Array of normalized scripts
 */
export function normalizeScripts(scripts) {
  if (!Array.isArray(scripts)) return []
  const seen = new Set()
  return scripts.map(normalizeScript).map(s => {
    // ids must be unique (used for `once` tracking)
    if (seen.has(s.id)) s.id = crypto.randomUUID()
    seen.add(s.id)
    return s
  })
}

/**
 * Reduce a tile scope to the ECA form: a mark name string, or { x, y }.
 * A mark wins over coordinates; incomplete coordinates yield null.
 */
export function normalizeTile(tile) {
  if (typeof tile === 'string') return tile.trim() || null
  if (!tile || typeof tile !== 'object') return null
  const mark = typeof tile.mark === 'string' ? tile.mark.trim() : ''
  if (mark) return mark
  if (Number.isFinite(tile.x) && Number.isFinite(tile.y)) return { x: tile.x, y: tile.y }
  return null
}

/**
 * Script fields as written to disk (ECA_REFERENCE.md): id, on and actions are
 * always present; once/map/tile/npc/condition are omitted when unset.
 * Actions are returned as-is — callers clean them.
 */
export function cleanScriptForSave(script) {
  const out = { id: script.id, on: script.on ?? script.event }
  const str = v => (typeof v === 'string' ? v.trim() : '')
  const map = str(script.map)
  const npc = str(script.npc)
  const condition = str(script.condition ?? script.conditions)
  const tile = normalizeTile(script.tile)
  if (script.once === true) out.once = true
  if (map) out.map = map
  if (tile) out.tile = tile
  if (npc) out.npc = npc
  if (condition) out.condition = condition
  out.actions = Array.isArray(script.actions) ? script.actions : []
  return out
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

/**
 * Custom JSON serializer for map data with compact-but-readable formatting:
 * - terrain/heights: each row on one line
 * - decorations/ramps/marks/effects/hFences/vFences: each entry on one line
 * - scripts: compact event with tile on one line, each action on one line
 */
export function serializeMapFormatted(map) {
  const decorations = []
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (map._decorations[y][x] !== null)
        decorations.push(map._decorations[y][x])

  const ramps = []
  for (let y = 0; y < map.height - 1; y++)
    for (let x = 0; x < map.width; x++)
      if (map._ramps[y][x]) ramps.push([x, y])

  const marks = Object.entries(map._marks).map(([k, v]) => {
    const [x, y] = k.split(',').map(Number)
    return { x, y, name: v }
  })

  const effects = map._effects ?? []

  const scripts = normalizeScripts(map._scripts)

  const hFences = []
  for (let cy = 0; cy <= map.height; cy++)
    for (let cx = 0; cx < map.width; cx++)
      if (map._hFences[cy][cx]) hFences.push({ x: cx, y: cy, t: map._hFences[cy][cx] })

  const vFences = []
  for (let cy = 0; cy < map.height; cy++)
    for (let cx = 0; cx <= map.width; cx++)
      if (map._vFences[cy][cx]) vFences.push({ x: cx, y: cy, t: map._vFences[cy][cx] })

  // Build the map object
  const mapData = {
    width: map.width,
    height: map.height,
    tileset: map.tileset,
    terrain: Array.from({ length: map.height }, (_, y) =>
      Array.from({ length: map.width }, (__, x) => getCell(map, x, y))
    ),
    heights: Array.from({ length: map.height }, (_, y) =>
      Array.from({ length: map.width }, (__, x) => getHeight(map, x, y))
    ),
    decorations,
    ramps,
    marks,
    effects,
    scripts,
    hFences,
    vFences
  }

  return formatMapJSON(mapData)
}

/**
 * Format map data as compact-but-readable JSON string
 */
function formatMapJSON(data) {
  const lines = []
  lines.push('{')

  // Simple fields
  lines.push(`  "width": ${data.width},`)
  lines.push(`  "height": ${data.height},`)
  lines.push(`  "tileset": "${escapeJsonString(data.tileset)}",`)

  // terrain - each row on one line
  lines.push('  "terrain": [')
  for (let y = 0; y < data.terrain.length; y++) {
    const row = data.terrain[y]
    const rowStr = '[' + row.join(',') + ']'
    lines.push(`    ${rowStr}${y < data.terrain.length - 1 ? ',' : ''}`)
  }
  lines.push('  ],')

  // heights - each row on one line
  lines.push('  "heights": [')
  for (let y = 0; y < data.heights.length; y++) {
    const row = data.heights[y]
    const rowStr = '[' + row.join(',') + ']'
    lines.push(`    ${rowStr}${y < data.heights.length - 1 ? ',' : ''}`)
  }
  lines.push('  ],')

  // Array fields - each entry on one line
  const arrayFields = ['decorations', 'ramps', 'marks', 'effects', 'hFences', 'vFences']
  for (let fi = 0; fi < arrayFields.length; fi++) {
    const field = arrayFields[fi]
    const arr = data[field] ?? []
    lines.push(`  "${field}": [`)
    for (let i = 0; i < arr.length; i++) {
      const entry = JSON.stringify(arr[i])
      lines.push(`    ${entry}${i < arr.length - 1 ? ',' : ''}`)
    }
    // "scripts" always follows, so every array field needs a trailing comma
    lines.push('  ],')
  }

  // scripts - special formatting
  lines.push('  "scripts": [')
  const scripts = data.scripts ?? []
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i]
    const scriptLines = formatScript(script)
    for (const line of scriptLines) {
      lines.push(`    ${line}`)
    }
    if (i < scripts.length - 1) {
      // Remove trailing comma from last line of this script and add comma
      lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '') + ','
    }
  }
  lines.push('  ]')

  lines.push('}')
  return lines.join('\n')
}

/**
 * Format a single script with compact event and actions each on one line
 */
function formatScript(script) {
  const clean = cleanScriptForSave(script)
  const lines = ['{']

  // Scalar fields in fixed order; actions are written last
  const fieldLines = []
  for (const field of ['id', 'on', 'once', 'map', 'tile', 'npc', 'condition']) {
    if (!(field in clean)) continue
    fieldLines.push(`  "${field}": ${JSON.stringify(clean[field])}`)
  }
  for (const line of fieldLines) lines.push(`${line},`)

  // actions - each on one line
  if (clean.actions.length === 0) {
    lines.push('  "actions": []')
  } else {
    lines.push('  "actions": [')
    for (let j = 0; j < clean.actions.length; j++) {
      lines.push(`    ${formatAction(clean.actions[j])}${j < clean.actions.length - 1 ? ',' : ''}`)
    }
    lines.push('  ]')
  }

  lines.push('}')
  return lines
}

/**
 * Format a single action as compact JSON on one line
 */
function formatAction(action) {
  // Clean up action for output (omit defaults)
  const cleaned = cleanActionForJSON(action)
  return JSON.stringify(cleaned)
}

/**
 * Escape string for JSON
 */
function escapeJsonString(str) {
  return str.replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/**
 * Clean action for JSON display - omit default/empty values (copied from scriptState)
 */
function cleanActionForJSON(action) {
  const cleaned = { ...action }

  switch (action.type) {
    case 'show_message':
      if (cleaned.duration === 3000 || cleaned.duration === undefined) delete cleaned.duration
      break
    case 'set_weather':
      if (cleaned.weather === 'none') { delete cleaned.weather; delete cleaned.intensity; delete cleaned.wind; delete cleaned.transition_secs }
      else {
        if (cleaned.intensity === 0.6) delete cleaned.intensity
        if (cleaned.wind === 0) delete cleaned.wind
        if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs
      }
      break
    case 'set_lighting':
      if (cleaned.lighting === 'day') { delete cleaned.lighting; delete cleaned.custom; delete cleaned.transition_secs }
      else {
        if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs
        if (cleaned.lighting !== 'custom') delete cleaned.custom
      }
      break
    case 'set_flag':
      if (cleaned.value === true) delete cleaned.value
      break
    case 'set_variable':
    case 'add_variable':
    case 'give_item':
    case 'remove_item':
    case 'spawn_item':
      if (cleaned.qty === 1) delete cleaned.qty
      break
    case 'spawn_monster':
      if (cleaned.position) {
        if (cleaned.position.x === '' || cleaned.position.x == null) delete cleaned.position.x
        if (cleaned.position.y === '' || cleaned.position.y == null) delete cleaned.position.y
        if (!cleaned.position.mark) delete cleaned.position.mark
        if (Object.keys(cleaned.position).length === 0) delete cleaned.position
      }
      if (cleaned.x === '' || cleaned.x == null) delete cleaned.x
      if (cleaned.y === '' || cleaned.y == null) delete cleaned.y
      if (!cleaned.radius) delete cleaned.radius
      if (!cleaned.id) delete cleaned.id
      if (!cleaned.pool) delete cleaned.pool
      break
    case 'spawn_npc':
      if (cleaned.flip_x === false) delete cleaned.flip_x
      break
    case 'change_map':
      if (!cleaned.mark) delete cleaned.mark
      if (cleaned.x === '' || cleaned.x == null) delete cleaned.x
      if (cleaned.y === '' || cleaned.y == null) delete cleaned.y
      break
    case 'change_tile':
      if (!cleaned.mark) delete cleaned.mark
      if (cleaned.x === '' || cleaned.x == null) delete cleaned.x
      if (cleaned.y === '' || cleaned.y == null) delete cleaned.y
      break
    case 'end_scenario':
      if (!cleaned.next) delete cleaned.next
      break
    case 'set_question_pool':
      if (!cleaned.pool) delete cleaned.pool
      break
  }

  // Clean nested actions
  if (cleaned.type === 'show_choice' && cleaned.choices) {
    cleaned.choices = cleaned.choices.map(c => ({
      ...c,
      actions: c.actions ? c.actions.map(cleanActionForJSON) : undefined
    })).map(c => {
      const cc = { ...c }
      if (!cc.condition || cc.condition.trim() === '') delete cc.condition
      if (!cc.actions || cc.actions.length === 0) delete cc.actions
      return cc
    })
  }

  if (cleaned.type === 'pick_random' && cleaned.choices) {
    cleaned.choices = cleaned.choices.map(c => ({
      ...c,
      actions: c.actions ? c.actions.map(cleanActionForJSON) : undefined
    })).filter(c => c.actions && c.actions.length > 0)
  }

  if (cleaned.data && Object.keys(cleaned.data).length === 0) delete cleaned.data

  return cleaned
}

// Keep original serializeMap for backward compatibility
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
    width: map.width,
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
    scripts: normalizeScripts(map._scripts).map(s => {
      const c = cleanScriptForSave(s)
      c.actions = c.actions.map(cleanActionForJSON)
      return c
    }),
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
  // Load and normalize scripts (migrates old format, ensures all fields)
  map._scripts = normalizeScripts(data.scripts)
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

/**
 * Script management helpers
 */

export function addScript(map, script) {
  const newScript = createEmptyScript({
    id: script.id,
    name: script.name ?? 'Unnamed Script',
    on: script.on ?? 'onEnter',
    condition: script.condition ?? '',
    actions: script.actions,
    map: script.map ?? map.id,
    once: script.once,
    tile: script.tile,
    npc: script.npc
  })
  map._scripts.push(newScript)
  return newScript
}

export function removeScript(map, scriptId) {
  const idx = map._scripts.findIndex(s => s.id === scriptId)
  if (idx !== -1) {
    map._scripts.splice(idx, 1)
    return true
  }
  return false
}

export function getScript(map, scriptId) {
  return map._scripts.find(s => s.id === scriptId) ?? null
}

export function updateScript(map, scriptId, updates) {
  const script = getScript(map, scriptId)
  if (script) {
    Object.assign(script, updates)
    return script
  }
  return null
}

export function getScriptsForMap(map) {
  return [...map._scripts]
}

export function getAllScripts(map) {
  return [...map._scripts]
}