// ─── Event-Condition-Action Engine ───────────────────────────────────────────
// Loads a scenario (scenario.json + scripts.json), maintains game state
// (variables, flags, inventory), and fires events that run matching scripts.

// ─── Condition tokeniser ──────────────────────────────────────────────────────
function tokenise(src) {
    const tokens = []
    let i = 0
    while (i < src.length) {
        if (/\s/.test(src[i])) { i++; continue }
        const upper = src.slice(i).toUpperCase()
        if (upper.startsWith('AND') && !/\w/.test(src[i+3]||'')) { tokens.push({t:'AND'}); i+=3; continue }
        if (upper.startsWith('OR')  && !/\w/.test(src[i+2]||'')) { tokens.push({t:'OR'});  i+=2; continue }
        if (upper.startsWith('NOT') && !/\w/.test(src[i+3]||'')) { tokens.push({t:'NOT'}); i+=3; continue }
        if (src.slice(i,i+2)==='&&') { tokens.push({t:'AND'}); i+=2; continue }
        if (src.slice(i,i+2)==='||') { tokens.push({t:'OR'});  i+=2; continue }
        if (src[i]==='!' && src[i+1]!=='=') { tokens.push({t:'NOT'}); i++; continue }
        if (src[i]==='(') { tokens.push({t:'LP'}); i++; continue }
        if (src[i]===')') { tokens.push({t:'RP'}); i++; continue }
        if (src[i]===',') { tokens.push({t:'COM'}); i++; continue }
        if (src[i]==='[') { tokens.push({t:'LB'}); i++; continue }
        if (src[i]===']') { tokens.push({t:'RB'}); i++; continue }
        if (src[i]==='"' || src[i]==="'") {
            const quote = src[i++]
            let s = ''
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\' && i + 1 < src.length) { s += src[i+1]; i += 2; continue }
                s += src[i++]
            }
            if (i >= src.length) throw new Error(`Unterminated string literal at position ${i}`)
            i++ // consume closing quote
            tokens.push({t:'STRING', v:s}); continue
        }
        if (src.slice(i,i+2).match(/^(<=|>=|==|!=)/)) { tokens.push({t:'OP', v:src.slice(i,i+2)}); i+=2; continue }
        if ('<>'.includes(src[i])) { tokens.push({t:'OP', v:src[i]}); i++; continue }
        if (/[\d.]/.test(src[i])) {
            let n = ''
            while (i < src.length && /[\d.]/.test(src[i])) n += src[i++]
            tokens.push({t:'NUM', v:parseFloat(n)}); continue
        }
        if (/[a-zA-Z_]/.test(src[i])) {
            let w = ''
            while (i < src.length && /\w/.test(src[i])) w += src[i++]
            tokens.push({t:'ID', v:w}); continue
        }
        throw new Error(`Unexpected character "${src[i]}" at position ${i}`)
    }
    tokens.push({t:'EOF'})
    return tokens
}

// ─── Condition parser → AST ───────────────────────────────────────────────────
function parseCondition(tokens) {
    let pos = 0
    const peek    = ()     => tokens[pos]
    const consume = (type) => {
        if (peek().t !== type) throw new Error(`Expected ${type} but got ${peek().t} ("${peek().v ?? ''}")`)
        return tokens[pos++]
    }
    const accept  = (t)    => { if (peek().t === t) { pos++; return true } return false }

    function commaArgs() {
        consume('LP')
        const a = []
        if (peek().t !== 'RP') {
            a.push(tokens[pos++])
            while (accept('COM')) a.push(tokens[pos++])
        }
        consume('RP')
        return a
    }

    // `kills['Skeleton Reaper']` — bracket-indexed form. Reads STRING/ID args
    // up to the closing bracket, comma-separated. Mirrors commaArgs() but for [].
    function bracketArgs() {
        consume('LB')
        const a = []
        if (peek().t !== 'RB') {
            a.push(tokens[pos++])
            while (accept('COM')) a.push(tokens[pos++])
        }
        consume('RB')
        return a
    }

    // Accept a single type-name argument which may be a STRING literal ('Skeleton Reaper')
    // or an ID (Skeleton). Returns the raw string value.
    function typeNameFromArg(a, fnName) {
        if (!a.length) throw new Error(`${fnName}() requires a monster type name (string)`)
        return a[0].v
    }

    // Apply a trailing `OP NUM` to a value-producing atom node, producing a
    // comparison node. Returns the original node (truthiness) when no operator
    // follows — so bare `kills` is a valid boolean predicate (non-zero).
    function withOptionalComparison(node) {
        if (peek().t !== 'OP') return node
        const op  = consume('OP')
        if (peek().t === 'STRING') {
            // String comparison (e.g. id == 'boss_crab').
            const val = consume('STRING')
            return { type: 'comparison', source: node, op: op.v, string_value: val.v }
        }
        const val = consume('NUM')
        return { type: 'comparison', source: node, op: op.v, value: val.v }
    }

    function parseAtom() {
        const nameTok = consume('ID')
        const name    = nameTok.v.toLowerCase()

        // ── Value-producing atoms yield a NUMBER and may be followed by `OP NUM`
        //    (e.g. `kills >= 2`, `kills['Skeleton'] >= 5`, `stat(total_kills) >= 10`).
        //    Without a trailing operator they act as a truthiness check (non-zero).
        if (name === 'stat') {
            consume('LP')
            const attr = consume('ID')
            // `stat(name)` — optional trailing `op value` inside the parens, kept
            // for backward compat with existing scenarios (`stat(gold >= 5)`).
            if (peek().t === 'OP') {
                const op  = consume('OP')
                const val = consume('NUM')
                consume('RP')
                return { type: 'comparison',
                         source: { type: 'attribute_value', attr: attr.v },
                         op: op.v, value: val.v }
            }
            consume('RP')
            return withOptionalComparison({ type: 'attribute_value', attr: attr.v })
        }

        if (name === 'kills') {
            // Bare `kills` (no parens/brackets) → context-variable form, resolving
            // to the current event's per-type tally.
            const base = (() => {
                if (peek().t === 'LP') {
                    const a = commaArgs()
                    return { type: 'kill_count', type_name: a.length ? a[0].v : null }
                }
                if (peek().t === 'LB') {
                    const a = bracketArgs()
                    return { type: 'kill_count', type_name: a.length ? a[0].v : null }
                }
                return { type: 'kill_count', type_name: null }
            })()
            return withOptionalComparison(base)
        }

        // id / monster_type — dual-path: function-call `name('X')` or comparison `name == 'X'`.
        if (name === 'id' || name === 'monster_type') {
            // Function-call form: name('X')
            if (peek().t === 'LP') {
                const a = commaArgs()
                if (name === 'id')
                    return { type: 'monster_id_pred', monster_id: a[0]?.v ?? null }
                else
                    return { type: 'monster_type', type_name: typeNameFromArg(a, 'monster_type') }
            }
            // Value-atom form: name == 'X' or bare name (truthy)
            const nodeType = name === 'id' ? 'monster_id_value' : 'monster_type_value'
            return withOptionalComparison({ type: nodeType })
        }

        const a = commaArgs()

        if (name === 'flag') {
            if (!a.length) throw new Error('flag() requires a name')
            return a[1]
                ? { type: 'flag_equals', flag: a[0].v, value: a[1].v }
                : { type: 'flag_set',    flag: a[0].v }
        }
        if (name === 'has_item') {
            if (!a.length) throw new Error('has_item() requires an item id')
            return { type: 'has_item', item_id: a[0].v, qty: a[1]?.v ?? 1 }
        }
        if (name === 'has_tag') {
            if (!a.length) throw new Error('has_tag() requires a tag name')
            return { type: 'has_tag', tag: a[0].v, qty: a[1]?.v ?? 1 }
        }
        if (name === 'chance') {
            if (!a.length || a[0].t !== 'NUM') throw new Error('chance() requires a probability (0.0–1.0)')
            return { type: 'random_chance', chance: a[0].v }
        }
        if (name === 'map') {
            if (!a.length) throw new Error('map() requires a map id')
            return { type: 'current_map', map_id: a[0].v }
        }
        if (name === 'near') {
            if (a.length < 2) throw new Error('near() requires a location and radius')
            if (a[0].t === 'NUM' && a[1].t === 'NUM' && a[2]?.t === 'NUM')
                return { type: 'player_near', x: a[0].v, y: a[1].v, radius: a[2].v }
            return { type: 'player_near', named: a[0].v, radius: a[1].v }
        }
        if (name === 'tile') {
            if (!a.length) throw new Error('tile() requires a location or coordinates')
            if (a.length === 2 && a[0].t === 'NUM')
                return { type: 'entering_tile', x: a[0].v, y: a[1].v }
            return { type: 'entering_tile', named: a[0].v }
        }
        if (name === 'combat') {
            if (!a.length) throw new Error('combat() requires an outcome: won, lost, fled')
            return { type: 'combat_outcome', outcome: a[0].v }
        }

        const KNOWN = ['has_item','has_tag','flag','stat','tile','near','map','combat','monster_type','id','kills','chance']
        throw new Error(`Unknown condition: "${name}". Available: ${KNOWN.join(', ')}`)
    }

    function parsePrimary() {
        if (peek().t === 'LP') { pos++; const e = parseExpr(); consume('RP'); return e }
        return parseAtom()
    }
    function parseNot() {
        if (peek().t === 'NOT') { pos++; return { type: 'not', child: parseNot() } }
        return parsePrimary()
    }
    function parseAnd() {
        let left = parseNot()
        while (peek().t === 'AND') { pos++; left = { type: 'and', children: [left, parseNot()] } }
        return left
    }
    function parseOr() {
        let left = parseAnd()
        while (peek().t === 'OR') { pos++; left = { type: 'or', children: [left, parseAnd()] } }
        return left
    }
    function parseExpr() { return parseOr() }

    return parseExpr()
}

// ─── Condition evaluator ──────────────────────────────────────────────────────
// Compare a value-producing source node against a number with an operator.
function _applyOp(op, lhs, rhs) {
    switch (op) {
        case '>=': return lhs >= rhs
        case '<=': return lhs <= rhs
        case '>':  return lhs >  rhs
        case '<':  return lhs <  rhs
        case '==': return lhs == rhs
        case '!=': return lhs != rhs
    }
    return false
}

// Resolve a value-producing node to a NUMBER (or STRING for text comparisons).
function _valueOf(node, state, eventCtx) {
    switch (node.type) {
        case 'attribute_value': {
            // Migration: old saves / scenarios use 'dexterity' — map to 'agility'
            const attr = node.attr === 'dexterity' ? 'agility' : node.attr
            return state.variables[attr] ?? 0
        }
        case 'kill_count': {
            // No type specified: this event's per-type tally (bound in the ctx).
            if (node.type_name == null) return eventCtx.kills ?? 0
            // If this query names the SAME type the event is about, use the bound
            // count (which includes the just-recorded kill). Otherwise fall back
            // to the persistent per-type counter.
            const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '')
            if (eventCtx.monster_type != null && norm(node.type_name) === norm(eventCtx.monster_type))
                return eventCtx.kills ?? 0
            return state.variables[_killCounterName(node.type_name)] ?? 0
        }
        // Standalone boolean nodes coerced to a number for truthiness.
        case 'monster_id_value':
            return eventCtx.monster_id ?? null
        case 'monster_type_value':
            return eventCtx.monster_type ?? null
        default:
            return evaluateNode(node, state, eventCtx) ? 1 : 0
    }
}

// Total count across inventory AND equipped slots (equipping removes from the pool,
// so a held item would otherwise be invisible to has_item()).
function _countItem(state, itemId) {
    let n = state.inventory[itemId] ?? 0
    const eq = state.equipped || {}
    for (const slot of SLOT_ORDER) if (eq[slot] === itemId) n++
    return n
}

// Substring tag match across inventory AND equipped slots (same rationale as _countItem).
function _hasTagAnywhere(state, tag) {
    const needle = tag.toLowerCase()
    const match = id => id && id.toLowerCase().includes(needle)
    for (const [id, qty] of Object.entries(state.inventory)) {
        if (qty > 0 && match(id)) return true
    }
    const eq = state.equipped || {}
    for (const slot of SLOT_ORDER) if (match(eq[slot])) return true
    return false
}

function evaluateNode(node, state, eventCtx) {
    switch (node.type) {
        case 'and': return node.children.every(c => evaluateNode(c, state, eventCtx))
        case 'or':  return node.children.some(c  => evaluateNode(c, state, eventCtx))
        case 'not': return !evaluateNode(node.child, state, eventCtx)

        case 'comparison': {
            const lhs = _valueOf(node.source, state, eventCtx)
            const rhs = node.string_value != null ? node.string_value : node.value
            return _applyOp(node.op, lhs, rhs)
        }
        // value-producing atom used bare: truthiness (non-zero count)
        case 'attribute_value':
            return (state.variables[node.attr] ?? 0) != 0
        case 'kill_count':
            return _valueOf(node, state, eventCtx) != 0

        // legacy; the parser now emits `comparison` instead.
        case 'attribute_check': {
            const val = state.variables[node.attr] ?? 0
            return _applyOp(node.op, val, node.value)
        }

        case 'monster_type': {
            const norm = s => String(s).toLowerCase().replace(/[\s_]+/g, '')
            return norm(eventCtx.monster_type) === norm(node.type_name)
        }

        case 'monster_id_pred': {
            if (eventCtx.monster_id == null) return false
            return String(eventCtx.monster_id).toLowerCase() === String(node.monster_id).toLowerCase()
        }

        // Bare value-atom used as boolean: truthy when non-null and non-empty.
        case 'monster_id_value':
            return eventCtx.monster_id != null && eventCtx.monster_id !== ''
        case 'monster_type_value':
            return eventCtx.monster_type != null && eventCtx.monster_type !== ''

        case 'flag_set':    return !!state.flags[node.flag]
        case 'flag_equals': return String(state.flags[node.flag]) === String(node.value)

        case 'has_item':
            // Count both the inventory pool AND equipped slots — an item worn/held
            // (e.g. a torch in hand) still satisfies has_item(), since equipping
            // removes it from inventory. Each occupied slot contributes 1.
            return _countItem(state, node.item_id) >= node.qty

        case 'has_tag':
            // Match across inventory pool AND equipped slots (same rationale: a
            // held torch should match has_tag(torch) just like a loose one).
            return _hasTagAnywhere(state, node.tag)

        case 'random_chance':
            return Math.random() < node.chance

        case 'current_map':
            return eventCtx.map_id === node.map_id

        case 'entering_tile':
            if (node.named !== undefined) {
                console.warn('[ECA] tile(name) condition needs mark lookup — not yet implemented')
                return false
            }
            return eventCtx.x === node.x && eventCtx.y === node.y

        case 'player_near':
            if (node.x !== undefined) {
                const dx = (eventCtx.x ?? 0) - node.x
                const dy = (eventCtx.y ?? 0) - node.y
                return Math.sqrt(dx*dx + dy*dy) <= node.radius
            }
            console.warn('[ECA] near(name, radius) needs named location lookup — not yet implemented')
            return false

        case 'combat_outcome':
            return eventCtx.outcome === node.outcome

        default:
            console.warn('[ECA] Unknown condition node:', node.type)
            return false
    }
}

function evaluateCondition(expr, state, eventCtx) {
    try {
        const tokens = tokenise(expr)
        const tree   = parseCondition(tokens)
        return evaluateNode(tree, state, eventCtx)
    } catch (e) {
        console.error('[ECA] Condition error:', e.message, '| expression:', expr)
        return false
    }
}

// Persisted kill-counter var: "Skeleton Reaper" → "skeleton_reaper_kills". Underscores
// let authors read/clear counters via stat(name)/set_variable in snake_case.
function _killCounterName(type) {
    return String(type).toLowerCase().replace(/\s+/g, '_') + '_kills'
}

// ─── Engine state ─────────────────────────────────────────────────────────────
let _state = {
    variables:  {},
    flags:      {},
    inventory:  {},   // { item_id: qty }
    // Equipped slots → item_id. null = empty. Two hand slots (hand_l/hand_r)
    // both contribute their bonuses in combat; there is no single "weapon".
    equipped:   { head: null, hand_l: null, hand_r: null, neck: null, torso: null, feet: null },
    firedOnce:  new Set(),
    currentMap: null,
    weather:    {},   // mapId → weatherRecord (persistent in-session override; survives change_map)
    lighting:   {},   // mapId → lightingRecord (darkness tint; persists in-session like weather)
}

// Slot → accepted item type. `hand` items fit either hand_l or hand_r.
const SLOT_TYPES = {
    head: 'head', hand_l: 'hand', hand_r: 'hand', neck: 'neck', torso: 'torso', feet: 'feet',
}
// Human-readable slot order for the body diagram + iteration.
const SLOT_ORDER = ['head', 'neck', 'hand_l', 'hand_r', 'torso', 'feet']
// Types that actually occupy a body slot. Anything else (e.g. 'material') is
// not equippable and itemSlotType returns null for it.
const EQUIPPABLE_TYPES = new Set(['head', 'hand', 'neck', 'torso', 'feet'])

let _scripts  = []
let _scenario = null
let _hooks    = {}
let _marks    = {}   // name.toLowerCase() → { x, y }

// ─── Public API ───────────────────────────────────────────────────────────────

/** Register callbacks for actions the engine cannot perform itself. */
export function setHooks(hooks) {
    _hooks = hooks
}

/** Fire onInventoryChange hook — game.js uses this to refresh the equipment panel. */
function _notifyInventory() {
    if (_hooks.onInventoryChange) _hooks.onInventoryChange()
}

/** Public API to notify inventory change (e.g. after loading a save game). */
export function notifyInventoryChange() {
    _notifyInventory()
}

/** Update the named-tile (mark) table for the current map. */
export function setMapMarks(marksArray) {
    _marks = {}
    for (const m of marksArray ?? []) {
        _marks[m.name.toLowerCase()] = { x: m.x, y: m.y }
    }
}

/** Read-only view of the current state (variables, flags, inventory). */
export function getState() { return _state }

// Item definitions registry (set by game.js after assets load). Each def:
//   { icon:[col,row], type:string, bonuses:{attack,defense,armor,agility,base_dmg,...} }
// `type` decides which slot(s) an item can occupy (head|hand|neck|torso|feet).
let _itemDefs = {}
export function setItemDefs(defs) { _itemDefs = defs || {} }

/** Return the slot type an item fits (head|hand|neck|torso|feet), or null. */
export function itemSlotType(itemId) {
    const def = _itemDefs[itemId]
    const t = def?.type
    return t && EQUIPPABLE_TYPES.has(t) ? t : null
}

/**
 * Equip `itemId` into `slot`, swapping/unequipping sensibly. Updates inventory
 * (removes 1 from the pool when equipping, returns it when unequipping).
 * `slot` optional: if omitted, picks a compatible empty slot (auto-equip).
 * Returns the slot used, or null if the item can't be equipped.
 */
export function equipItem(itemId, slot = null) {
    const type = itemSlotType(itemId)
    if (!type) return null
    // Validate slot
    if (slot && SLOT_TYPES[slot] !== type) return null
    if (!slot) {
        // Auto-pick: prefer hand_l, then hand_r for hand items; else the matching slot
        if (type === 'hand') {
            slot = _state.equipped.hand_l == null ? 'hand_l'
                 : _state.equipped.hand_r == null ? 'hand_r' : null
        } else {
            slot = _state.equipped[type] == null ? type : null
        }
        if (!slot) return null   // no empty compatible slot
    }
    // Return any item currently in that slot to the pool first
    const prev = _state.equipped[slot]
    if (prev) _state.inventory[prev] = (_state.inventory[prev] ?? 0) + 1
    // Take 1 of the new item from inventory (if present there)
    const have = _state.inventory[itemId] ?? 0
    if (have > 0) _state.inventory[itemId] = Math.max(0, have - 1)
    _state.equipped[slot] = itemId
    _syncEquippedWeapon()
    _notifyInventory()
    return slot
}

/** Remove the item in `slot` back to the inventory pool. */
export function unequipItem(slot) {
    const id = _state.equipped?.[slot]
    if (!id) return null
    _state.equipped[slot] = null
    _state.inventory[id] = (_state.inventory[id] ?? 0) + 1
    _syncEquippedWeapon()
    _notifyInventory()
    return id
}

/** Sum bonuses across all currently-equipped slots for combat. */
export function equippedBonuses() {
    const out = { attack: 0, defense: 0, armor: 0, agility: 0, base_dmg: 0 }
    const eq = _state.equipped || {}
    for (const slot of SLOT_ORDER) {
        const id = eq[slot]
        if (!id) continue
        const b = _itemDefs[id]?.bonuses
        if (!b) continue
        for (const k of Object.keys(out)) if (b[k]) out[k] += b[k]
    }
    return out
}

// Keep the legacy `equipped_weapon` variable mirroring the first occupied hand
// slot, for any code that still reads playerStats.equippedWeapon.
function _syncEquippedWeapon() {
    const eq = _state.equipped || {}
    _state.variables.equipped_weapon = eq.hand_l || eq.hand_r || null
}

// ─── Weather ───────────────────────────────────────────────────────────────────
// Per-map weather is resolved as: saved override `_state.weather[mapId]` → else the
// map's authored default `_scenario.weather[mapId]` → else `none`. A record's optional
// `t = { from, durationSec, elapsedSec }` is an active transition tween; the renderer
// advances it via tickWeather() and lerps all numeric params each frame.
//
// Per-type transition-time multiplier. Night fades slower (2×) for natural dusk/dawn.
// (Weather currently has no per-type multipliers — only lighting does.)
const LIGHTING_TRANS_MULT = { night: 2 }

/** Hard ceiling on weather wind (px/s). Both authored wind (set_weather / scenario)
 *  and the live lerped wind are clamped to ±MAX_WIND. The renderer normalizes wind
 *  to [-1, 1] against this value to drive decoration lean + sway inflation. */
export const MAX_WIND = 100

function _clampWind(w) {
    return Math.max(-MAX_WIND, Math.min(MAX_WIND, w ?? 0))
}

/** Default weather for a map id from the scenario's authored `weather` block, or none. */
function _defaultWeatherFor(mapId) {
    const def = _scenario?.weather?.[mapId]
    if (!def) return { type: 'none', intensity: 0, wind: 0, t: null }
    return { type: def.type ?? 'none', intensity: def.intensity ?? 0.5, wind: _clampWind(def.wind), t: null }
}

/** Coerce a set_weather action into a normalized weather record (target). */
function _normalizeWeather(action) {
    const type = (action.weather ?? 'none').toLowerCase()
    return {
        type,
        intensity: action.intensity ?? (type === 'none' ? 0 : 0.6),
        wind:      _clampWind(action.wind),
        t:         null,   // filled by the caller based on transition_secs
    }
}

/**
 * Resolve the live (current) weather record for a map, applying any active transition.
 * Returns a freshly-lerped snapshot the renderer can read without mutating engine state.
 *   { type, intensity, wind, t: null }  — t is null in the snapshot (already applied).
 */
export function getWeatherFor(mapId) {
    const rec = _state.weather[mapId] ?? _defaultWeatherFor(mapId)
    if (!rec.t) return { type: rec.type, intensity: rec.intensity, wind: _clampWind(rec.wind), t: null, transition: null }
    // Mid-transition: lerp numeric params from `t.from` toward the target by t.elapsedSec/duration.
    const k = Math.min(1, rec.t.elapsedSec / rec.t.durationSec)
    const from = rec.t.from
    const lerp = (a, b) => a + (b - a) * k
    // Expose the outgoing snapshot + k so the renderer can CROSS-FADE an overlay type
    // change (night→clear): without this the target renders from frame 1 and "clear"
    // after "night" would snap dark off instead of dimming back to day.
    return {
        type:       rec.type,
        intensity:  lerp(from.intensity ?? 0, rec.intensity),
        wind:       _clampWind(lerp(from.wind ?? 0, rec.wind)),
        t:          null,
        transition: { fromType: from.type, fromIntensity: from.intensity ?? 0, k },
    }
}

/** Advance active weather transitions for a map by dt seconds. Safe no-op when idle. */
export function tickWeather(mapId, dt) {
    const rec = _state.weather[mapId]
    if (!rec?.t) return                  // no override or no active tween → nothing to advance
    rec.t.elapsedSec += dt
    if (rec.t.elapsedSec >= rec.t.durationSec) rec.t = null   // tween done → snap to target
}

// ─── Lighting ───────────────────────────────────────────────────────────────
// Per-map lighting resolves: override → scenario default → none.
// Lighting records: { tint: { mode?, col, a }, t: { from, durationSec, elapsedSec } | null }
//   mode: 'flat' (default — a solid rgba fill) | 'sunset' (a screen-space radial glow).
// Night fades slower (2×) to feel like a natural dusk/dawn.

function _defaultLightingFor(mapId) {
    const def = _scenario?.lighting?.[mapId]
    if (!def) return { tint: null, t: null }  // no authored lighting → fully lit
    return { tint: { mode: def.mode ?? 'flat', col: def.col ?? [0, 0, 10], a: def.a ?? 1.0 }, t: null }
}

function _normalizeLighting(action) {
    // Accept a named preset (string) or a full tint object.
    const PRESETS = {
        night:  { mode: 'flat',   col: [0, 1, 10],       a: 1.0 },
        day:    { mode: 'flat',   col: [0, 0, 0],        a: 0.0 },   // cleared overlay
        sunset: { mode: 'sunset', col: [255, 140, 40],   a: 0.18 },
    }
    const name = typeof action.lighting === 'string' ? action.lighting.toLowerCase() : null
    const src = name ? PRESETS[name] ?? null
        : (action.lighting && typeof action.lighting === 'object' ? action.lighting : null)
    const tint = src ?? action.tint ?? PRESETS.night
    return {
        tint: { mode: tint.mode ?? 'flat', col: tint.col ?? [0, 1, 10], a: tint.a ?? (tint.mode === 'sunset' ? 0.18 : 1.0) },
        t: null,
    }
}

export function getLightingFor(mapId) {
    const rec = _state.lighting[mapId] ?? _defaultLightingFor(mapId)
    if (!rec.t) return { tint: rec.tint, transition: null }
    // From = the currently-rendered snapshot so chaining starts from what's on screen.
    // SAME mode → one lerped tint (col + α morph). DIFFERENT mode → cross-fade: expose
    // both endpoints via `transition` at lerped alpha so e.g. night→sunset feels continuous
    // (the flat tint recedes as the radial glow emerges, neither snaps in early).
    const k = Math.min(1, rec.t.elapsedSec / rec.t.durationSec)
    const from = rec.t.from
    const lerp = (a, b) => a + (b - a) * k
    // A null origin (no authored lighting — e.g. the world map's first set_lighting) is
    // coerced to a "day" tint so day→night animates from clear→dark (and the renderer
    // doesn't deref a null `from.a`).
    const DAY_TINT = { mode: 'flat', col: [0, 0, 0], a: 0 }
    const ft = from?.tint ?? DAY_TINT
    const tt = rec.tint ?? DAY_TINT
    if ((ft.mode ?? 'flat') === (tt.mode ?? 'flat')) {
        const fc = ft.col, tc = tt.col
        return {
            tint: {
                mode: tt.mode ?? 'flat',
                col:  [lerp(fc[0], tc[0]), lerp(fc[1], tc[1]), lerp(fc[2], tc[2])],
                a:    lerp(ft.a ?? 0, tt.a),
            },
            transition: null,
        }
    }
    // Mode-swap cross-fade: report the target tint at rising α + the origin at fading α.
    return {
        tint: tt,
        transition: { from: ft, to: tt, k },
    }
}

export function tickLighting(mapId, dt) {
    const rec = _state.lighting[mapId]
    if (!rec?.t) return
    rec.t.elapsedSec += dt
    if (rec.t.elapsedSec >= rec.t.durationSec) rec.t = null
}

/** Load scenario index: { folderId: { name, help } }. Returns the JSON object. */
export async function loadScenarioList(basePath = '/scenarios') {
    const res = await fetch(`${basePath}/scenarios.json`)
    if (!res.ok) throw new Error(`Failed to load scenario list: ${res.status}`)
    return res.json()
}

/** Load a scenario by folder name. Resets state to scenario defaults. */
export async function loadScenario(id, basePath = '/scenarios') {
    const sRes = await fetch(`${basePath}/${id}/scenario.json`)
    if (!sRes.ok) throw new Error(`scenario.json not found for "${id}"`)
    _scenario = await sRes.json()

    // Support scriptFiles array in scenario.json; fall back to scripts.json
    let allScripts = []
    if (_scenario.scriptFiles?.length) {
        const entries = _scenario.scriptFiles.map(e =>
            typeof e === 'string' ? { file: e, map: null } : e
        )
        const responses = await Promise.all(
            entries.map(e => fetch(`${basePath}/${id}/${e.file}`))
        )
        for (let i = 0; i < responses.length; i++) {
            const res = responses[i]
            if (!res.ok) throw new Error(`Script file not found: ${entries[i].file}`)
            const scripts = await res.json()
            const scopeMap = entries[i].map
            if (scopeMap) scripts.forEach(s => { if (!s.map) s.map = scopeMap })
            allScripts.push(...scripts)
        }
    } else {
        const scRes = await fetch(`${basePath}/${id}/scripts.json`)
        if (!scRes.ok) throw new Error(`scripts.json not found for "${id}"`)
        allScripts = await scRes.json()
    }
    _scripts = allScripts

    _state = {
        // Combat defaults match game.js playerStats so a level-up never
        // replaces an unset ("undefined ?? 0") value with +1, silently
        // discarding the base (e.g. base_dmg 10 → 1). Scenario values win.
        variables:  {
            level: 1, xp: 0, equipped_weapon: null,
            max_hp: 100,
            base_dmg: 10, attack: 0, defense: 0, armor: 0, agility: 0,
            ..._scenario.variables
        },
        flags:      { ..._scenario.flags },
        inventory:  {},
        equipped:   { head: null, hand_l: null, hand_r: null, neck: null, torso: null, feet: null },
        firedOnce:  new Set(),
        currentMap: _scenario.start_map,
        lighting:   {},   // per-map lighting overrides reset on fresh scenario load
        weather:    {},   // per-map overrides reset on fresh scenario load
    }

    console.log(`[ECA] Loaded scenario: "${_scenario.title ?? id}" (${_scripts.length} scripts)`)
    return _scenario
}

// ─── XP & Leveling ─────────────────────────────────────────────────────────────
/** XP needed to reach the next level. */
export function xpToNext(level) {
    return 100 + 50 * (level - 1) * level / 2
}

/** Add XP and auto-level-up in a loop. Fires `level_up` on each level gained. */
export async function addXp(amount) {
    _state.variables.xp = (_state.variables.xp ?? 0) + amount
    let leveled = false
    while ((_state.variables.xp ?? 0) >= xpToNext(_state.variables.level ?? 1)) {
        _state.variables.xp -= xpToNext(_state.variables.level ?? 1)
        _state.variables.level = (_state.variables.level ?? 1) + 1
        leveled = true
        await applyLevelUpStats()
        await fireEvent('level_up', { level: _state.variables.level })
    }
    if (leveled) {
        // Sync hp after multiple level-ups could have happened
        const hp = _state.variables.hp ?? 100
        const maxHp = _state.variables.max_hp ?? 100
        _state.variables.hp = Math.min(hp, maxHp)
    }
}

// ─── Cheat helpers (Ctrl+X panel) ───────────────────────────────────────────
// These mutate engine state directly so the equipment panel / HUD refresh
// through the same hooks as normal play. Returns a short result string.
const _STAT_VAR = {
    att:    'attack',
    def:    'defense',
    arm:    'armor',
    agi:    'agility',
    dmg:    'base_dmg',
    hp:     'max_hp',
}

export function cheatGive(itemId, qty = 1) {
    if (!itemId) return 'no item id'
    _state.inventory[itemId] = (_state.inventory[itemId] ?? 0) + qty
    // Auto-equip equippable items into a free slot (like ECA give_item).
    if (itemSlotType(itemId)) equipItem(itemId, null)
    _notifyInventory()
    return `+${qty}× ${itemId}`
}

export async function cheatAddXp(amount) {
    await addXp(amount)   // awaits any level-up dialog so stats are applied
    return `+${amount} XP`
}

export function cheatAddStat(key, amount) {
    const v = _STAT_VAR[key]
    if (!v) return `unknown stat: ${key}`
    const inc = (key === 'hp') ? 10 * amount : 1 * amount  // hp → max_hp +10·n
    _state.variables[v] = (_state.variables[v] ?? 0) + inc
    if (key === 'hp') _state.variables.hp ??= _state.variables.max_hp
    return `+${inc} ${v}`
}

/**
 * Parse and run a single cheat line. Keys:
 *   item <id>      — grant one (auto-equipped if equippable)
 *   item <id> <n>  — grant n
 *   xp <n>         — award n XP
 *   att|def|arm|agi|dmg <n>  — +n to that stat
 *   hp <n>         — +10·n to max HP
 */
export async function runCheat(line) {
    const trimmed = (line || '').trim()
    const parts = trimmed.split(/\s+/)
    if (!parts.length) return ''
    const cmd = parts[0].toLowerCase()
    if (cmd === 'item') {
        // Item ids may contain spaces (e.g. "Red Potion", "Wooden Shield"),
        // and an optional trailing count. Split off a trailing integer first
        // (only when there's more than one token after "item"), keep the rest
        // as the id.
        const rest = trimmed.slice(parts[0].length).trim()
        if (!rest) return 'usage: item <id> [n]'
        const tokens = rest.split(/\s+/)
        let qty = 1, idTokens = tokens
        if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) {
            qty = Number(tokens[tokens.length - 1]) || 1
            idTokens = tokens.slice(0, -1)
        }
        return cheatGive(idTokens.join(' '), qty)
    }
    if (cmd === 'xp') return cheatAddXp(Number(parts[1] ?? 0) || 0)
    if (_STAT_VAR[cmd]) {
        const n = Number(parts[1]) || 1
        return cheatAddStat(cmd, n)
    }
    return `unknown command: ${cmd}`
}

// All possible two-stat bonus sets (ordered pairs can overlap).
const _LEVEL_UP_SETS = [
    ['attack', 'attack'],
    ['attack', 'defense'],
    ['attack', 'max_hp'],
    ['attack', 'agility'],
    ['attack', 'base_dmg'],
    ['defense', 'defense'],
    ['defense', 'max_hp'],
    ['defense', 'agility'],
    ['defense', 'base_dmg'],
    ['max_hp', 'max_hp'],
    ['max_hp', 'agility'],
    ['max_hp', 'base_dmg'],
    ['agility', 'agility'],
    ['agility', 'base_dmg'],
    ['base_dmg', 'base_dmg'],
]

const _LEVEL_UP_DISPLAY = {
    attack:    { label: 'Atak',      val: '+1',  gain: 1,  icon: 'Double Axe' },
    defense:   { label: 'Obrona',    val: '+1',  gain: 1,  icon: 'Wooden Shield' },
    max_hp:    { label: 'HP',        val: '+10', gain: 10, icon: 'Red Potion' },
    agility:   { label: 'Zręczność', val: '+1',  gain: 1,  icon: 'Leather Shoes' },
    base_dmg:  { label: 'Obrażenia', val: '+1',  gain: 1,  icon: 'Leather Gloves' },
}

/** Pick 3 random unique stat-sets and present them to the player via the hook. */
async function applyLevelUpStats() {
    // Shuffle a copy and take 3 distinct sets
    const pool = [..._LEVEL_UP_SETS]
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const choices = pool.slice(0, 3).map(set => {
        // Collapse repeated stats into a single icon with a count (e.g. ['attack','attack'] → 1 icon ×2).
        const counts = {}
        for (const s of set) counts[s] = (counts[s] ?? 0) + 1
        const icons = Object.entries(counts).map(([stat, count]) => {
            const d = _LEVEL_UP_DISPLAY[stat]
            const gain = d.gain * count
            return { icon: d.icon, name: d.label, val: '+' + gain, count }
        })
        return {
            stats: set,
            label: set.map(s => `${_LEVEL_UP_DISPLAY[s].label} ${_LEVEL_UP_DISPLAY[s].val}`).join(' + '),
            icons,
        }
    })

    let idx = 0
    if (_hooks.showLevelUp) {
        idx = await _hooks.showLevelUp(choices)
    }
    _applyStatBonus(choices[idx].stats)
}

function _applyStatBonus(stats) {
    for (const stat of stats) {
        if (stat === 'max_hp') {
            _state.variables.max_hp = (_state.variables.max_hp ?? 100) + 10
        } else {
            _state.variables[stat] = (_state.variables[stat] ?? 0) + 1
        }
    }
}

/**
 * Record a monster defeat: bump the per-type kill counter and the global total,
 * then fire `monster_defeated`. The event ctx binds `monster_type` (string),
 * `monster_id` (author-supplied id, null/omitted if none), `kills` (this type's
 * running tally, including this kill), and `total_kills` (all types). `x`/`y`
 * are the kill tile (omitted for off-map start_combat kills).
 * Returns the fireEvent promise so callers may ignore it (fire-and-forget)
 * or await it as needed.
 */
export async function recordMonsterDefeat(type, x = null, y = null, monsterId = null) {
    const key = _killCounterName(type)
    const kills = (_state.variables[key] ?? 0) + 1
    _state.variables[key] = kills
    _state.variables.total_kills = (_state.variables.total_kills ?? 0) + 1
    return fireEvent('monster_defeated', {
        monster_type: type,
        monster_id:   monsterId,
        x, y,
        kills,
        total_kills: _state.variables.total_kills,
    })
}

/**
 * Fire a named event with optional context.
 * Returns { blocked: true } if any script used block_move.
 */
export async function fireEvent(name, eventCtx = {}) {
    const ctx     = { map_id: _state.currentMap, ...eventCtx }
    let   blocked = false

    for (const script of _scripts) {
        if (script.on !== name) continue

        // Map scope filter
        if (script.map && ctx.map_id !== script.map) continue

        // Tile scope filter (tile_approach / tile_enter). `tile` is either:
        //   "Start"            → named map mark (string)  [preferred shorthand]
        //   { "x": n, "y": m } → explicit tile coordinates
        if (script.tile) {
            const t = script.tile
            if (typeof t === 'string') {
                const resolved = _marks[t.toLowerCase()]
                if (!resolved || ctx.x !== resolved.x || ctx.y !== resolved.y) continue
            } else {
                if (ctx.x !== t.x || ctx.y !== t.y) continue
            }
        }

        // NPC scope filter (npc_interact)
        if (script.npc && ctx.npc_id !== script.npc) continue

        // once: skip if already fired
        if (script.once && _state.firedOnce.has(script.id)) continue

        // Condition check
        if (script.condition) {
            if (!evaluateCondition(script.condition, _state, ctx)) continue
        }

        const result = await _runActions(script.actions ?? [], ctx)
        if (result.blocked) blocked = true

        if (script.once) _state.firedOnce.add(script.id)
    }

    return { blocked }
}

// ─── Action runner ────────────────────────────────────────────────────────────
async function _runActions(actions, eventCtx) {
    let blocked = false
    for (const action of actions) {
        const result = await _runAction(action, eventCtx)
        if (result?.blocked) blocked = true
    }
    return { blocked }
}

async function _runAction(action, eventCtx) {
    switch (action.type) {

        // ── Narrative ───────────────────────────────────────────────────────
        case 'show_dialog': {
            // `give`: { item_id: qty, ... } — items added to inventory (and shown by default)
            // `show`: { item_id: qty, ... } — items only displayed, not granted
            if (action.give) {
                for (const [item_id, qty] of Object.entries(action.give)) {
                    const n = Number(qty) || 1
                    _state.inventory[item_id] = (_state.inventory[item_id] ?? 0) + n
                    console.log(`[ECA] +${n}× ${item_id} → inventory`)
                    if (itemSlotType(item_id)) {
                        const auto = equipItem(item_id, null)
                        if (auto) console.log(`[ECA] auto-equipped ${item_id} → ${auto}`)
                    }
                }
                _notifyInventory()
            }
            // Display set: explicit `show` wins; else show granted `give` items; else legacy `items`/`item`.
            let _items = null
            if (action.show)        _items = action.show
            else if (action.give)  _items = action.give
            else                   _items = action.items ?? (action.item ? [action.item] : null)
            if (_hooks.showDialog)
                await _hooks.showDialog(action.text, action.speaker ?? null, _items)
            else
                console.log(`[ECA] Dialog${action.speaker ? ` [${action.speaker}]` : ''}: ${action.text}`)
            break
        }

        case 'show_choice': {
            if (_hooks.showChoice) {
                const allChoices = action.choices ?? []
                const visible = allChoices.filter(c =>
                    !c.condition || evaluateCondition(c.condition, _state, eventCtx)
                )
                if (!visible.length) break
                const idx = await _hooks.showChoice(action.text, visible)
                const chosen = visible[idx]
                if (chosen?.actions?.length) {
                    const r = await _runActions(chosen.actions, eventCtx)
                    if (r.blocked) return { blocked: true }
                }
            } else {
                console.log(`[ECA] show_choice: hook not registered`)
            }
            break
        }



        case 'show_message':
            if (_hooks.showMessage)
                _hooks.showMessage(action.text, action.duration ?? 3000,
                    action.items ?? (action.item ? [action.item] : null))
            else
                console.log(`[ECA] Message: ${action.text}`)
            break

        // ── Movement ────────────────────────────────────────────────────────
        case 'block_move':
            return { blocked: true }

        // ── Flags & variables ───────────────────────────────────────────────
        case 'set_flag':
            _state.flags[action.name] = action.value !== false
            break

        case 'clear_flag':
            delete _state.flags[action.name]
            break

        case 'set_variable':
            _state.variables[action.name] = action.value
            break

        case 'add_variable':
            _state.variables[action.name] = (_state.variables[action.name] ?? 0) + action.delta
            break

        // ── Inventory ───────────────────────────────────────────────────────
        case 'give_item': {
            const qty = action.qty ?? 1
            _state.inventory[action.item_id] = (_state.inventory[action.item_id] ?? 0) + qty
            console.log(`[ECA] +${qty}× ${action.item_id} → inventory`)
            // Auto-equip: if this is an equippable item and a compatible slot is
            // empty, place one into it directly (picks one from the just-given qty).
            if (itemSlotType(action.item_id)) {
                let auto = equipItem(action.item_id, null)
                if (auto) console.log(`[ECA] auto-equipped ${action.item_id} → ${auto}`)
            }
            _notifyInventory()
            break
        }

        case 'remove_item': {
            const qty = action.qty ?? 1
            const itemId = action.item_id
            // Drain the pool first; if short, also remove equipped instances (unequipItem
            // returns to the pool then we re-subtract — net removed matches the claim, consistent
            // with has_item() counting equipped). Non-equippables never hit the fallback.
            let remaining = qty
            const have = _state.inventory[itemId] ?? 0
            const take = Math.min(remaining, have)
            _state.inventory[itemId] = Math.max(0, have - take)
            remaining -= take
            if (remaining > 0) {
                // Free hand slots first (torches/weapons), then the other slots.
                const order = ['hand_l', 'hand_r', ...SLOT_ORDER.filter(s => s !== 'hand_l' && s !== 'hand_r')]
                for (const slot of order) {
                    if (remaining <= 0) break
                    if (_state.equipped?.[slot] !== itemId) continue
                    unequipItem(slot)                                   // held item → inventory (+1)
                    _state.inventory[itemId] = Math.max(0, (_state.inventory[itemId] ?? 0) - 1)  // remove it
                    remaining -= 1
                }
            }
            console.log(`[ECA] -${qty}× ${itemId} (inventory${remaining < qty ? ' + equipped' : ''})`)
            _notifyInventory()
            break
        }

        case 'fire_event': {
            const r = await fireEvent(action.event, { ...eventCtx, ...(action.data ?? {}) })
            if (r.blocked) return { blocked: true }
            break
        }

        case 'pick_random': {
            const pool = action.choices ?? []
            if (pool.length) {
                const picked = pool[Math.floor(Math.random() * pool.length)]
                if (picked?.actions?.length) {
                    const r = await _runActions(picked.actions, eventCtx)
                    if (r.blocked) return { blocked: true }
                }
            }
            break
        }

        // ── World ───────────────────────────────────────────────────────────
        case 'change_map':
            _state.currentMap = action.map_id
            if (_hooks.changeMap)
                await _hooks.changeMap(action.map_id, action.x, action.y, action.mark ?? null)
            else
                console.log(`[ECA] change_map → ${action.map_id} @ ${action.mark ? 'mark:'+action.mark : `(${action.x ?? '?'}, ${action.y ?? '?'})`}`)
            break

        case 'spawn_decoration':
            if (_hooks.spawnDecoration) _hooks.spawnDecoration(action.x, action.y, action.asset_id)
            else console.log(`[ECA] spawn_decoration: ${action.asset_id} @ (${action.x}, ${action.y}) — hook not registered`)
            break

        case 'spawn_item': {
            const qty = action.qty ?? 1
            if (_hooks.spawnItem) _hooks.spawnItem(action.x, action.y, action.item_id, qty)
            else console.log(`[ECA] spawn_item: ${action.item_id} x${qty} @ (${action.x}, ${action.y}) — hook not registered`)
            break
        }

        case 'spawn_monster':
            if (_hooks.spawnMonster)
                await _hooks.spawnMonster(action.monster, {
                    x:      action.x,
                    y:      action.y,
                    radius: action.radius,
                    id:     action.id,
                    pool:   action.pool,
                })
            else
                console.log(`[ECA] spawn_monster: ${action.monster} — hook not registered`)
            break

        case 'spawn_npc':
            if (_hooks.spawnNpc)
                await _hooks.spawnNpc(action.npc, action.x, action.y, {
                    id:    action.id,
                    flipX: action.flip_x ?? false,
                })
            else
                console.log(`[ECA] spawn_npc: ${action.npc} — hook not registered`)
            break

        case 'remove_decoration':
            if (_hooks.removeDecoration) _hooks.removeDecoration(action.x, action.y)
            else console.log(`[ECA] remove_decoration @ (${action.x}, ${action.y}) — hook not registered`)
            break

        // Replace one tile's terrain. Target precedence: "tile":"Mark" → named mark,
        // "tile":{x,y} → coords, "mark"/"x"+"y" → fallback forms. `terrain` is an id or name
        // resolved against the tileset by the game.js hook (engine doesn't own the tileset).
        case 'change_tile': {
            const t = action.tile
            let tx = action.x, ty = action.y
            if (t) {
                if (typeof t === 'string') {
                    const resolved = _marks[t.toLowerCase()]
                    if (!resolved) {
                        console.warn(`[ECA] change_tile: unknown mark "${t}"`)
                        break
                    }
                    tx = resolved.x; ty = resolved.y
                } else {
                    tx = t.x; ty = t.y
                }
            } else if (action.mark) {
                const resolved = _marks[action.mark.toLowerCase()]
                if (!resolved) {
                    console.warn(`[ECA] change_tile: unknown mark "${action.mark}"`)
                    break
                }
                tx = resolved.x; ty = resolved.y
            }
            if (tx == null || ty == null) {
                console.warn('[ECA] change_tile: no target tile (set "tile", "mark", or "x"/"y")')
                break
            }
            if (_hooks.changeTile) _hooks.changeTile(tx, ty, action.terrain)
            else console.log(`[ECA] change_tile @ (${tx}, ${ty}) → ${action.terrain} — hook not registered`)
            break
        }

        // ── Combat ──────────────────────────────────────────────────────────
        case 'start_combat':
            if (_hooks.startCombat) {
                const r = await _hooks.startCombat(action.enemy_id)
                if (r?.blocked) return { blocked: true }
            } else {
                console.log(`[ECA] start_combat: ${action.enemy_id} — hook not registered`)
            }
            break

        // ── World ───────────────────────────────────────────────────────────
        case 'set_weather': {
            // Weather for the current map, persisted in-session. weather/intensity/wind optional;
            // transition_secs tweens all params (0/omitted = snap). Night+sunset are LIGHTING
            // overlays (set_lighting), not weather — rain/snow compose with any lighting.
            const mapId = _state.currentMap
            if (!mapId) { console.warn('[ECA] set_weather with no current map'); break }
            const target = _normalizeWeather(action)
            // Capture the *currently rendered* weather (lerped if mid-tween) as the transition
            // origin, so chaining set_weather while a tween runs starts from what's on screen.
            const prev = getWeatherFor(mapId)
            if (action.transition_secs && action.transition_secs > 0) {
                // No per-type weather multipliers currently (only lighting has one
                // for night). Keep a plain `mult = 1` so adding a WEATHER_TRANS_MULT
                // table later is a one-line change.
                const mult = 1
                target.t = { from: prev, durationSec: action.transition_secs * mult, elapsedSec: 0 }
            } else {
                target.t = null
            }
            _state.weather[mapId] = target
            console.log(`[ECA] set_weather: ${mapId} → ${target.type}` +
                (target.t ? ` (transition ${target.t.durationSec}s)` : ' (snap)'))
            break
        }

        case 'set_lighting': {
            const mapId = _state.currentMap
            if (!mapId) { console.warn('[ECA] set_lighting with no current map'); break }
            const target = _normalizeLighting(action)
            const prev = getLightingFor(mapId)
            if (action.transition_secs && action.transition_secs > 0) {
                // Slow night transitions (2×) so dusk/dawn read as a paced dimming. Detect
                // "night" via the normalized target tint being a dark blue (B dominant, low R/G).
                const c = target.tint.col
                const isNight = c[2] > 30 && c[2] > c[0] + c[1]
                const mult = isNight ? LIGHTING_TRANS_MULT.night : 1
                target.t = { from: prev, durationSec: action.transition_secs * mult, elapsedSec: 0 }
            } else {
                target.t = null
            }
            _state.lighting[mapId] = target
            console.log(`[ECA] set_lighting: ${mapId} → tint ${target.tint.col}` +
                (target.t ? ` (transition ${target.t.durationSec}s)` : ' (snap)'))
            break
        }

        // ── Question pool ─────────────────────────────────────────────────────
        case 'set_question_pool': {
            // Set global question pool spec. Formats: "2", "1,3", "1..3", 2
            // This overrides the default pool 1 for all battles unless a monster
            // specifies its own pool via spawn_monster.
            _state.variables.questionPool = action.pool
            console.log(`[ECA] set_question_pool: ${action.pool}`)
            break
        }

        case 'clear_question_pool': {
            // Clear global question pool spec, reverting to default (pool 1).
            delete _state.variables.questionPool
            console.log('[ECA] clear_question_pool')
            break
        }

        // ── Scenario flow ───────────────────────────────────────────────────
        case 'end_scenario':
            console.log(`[ECA] end_scenario → next: ${action.next ?? '(none)'} — not yet implemented`)
            if (_hooks.endScenario) await _hooks.endScenario(action.next ?? null)
            break

        default:
            console.warn('[ECA] Unknown action type:', action.type)
    }
    return {}
}
