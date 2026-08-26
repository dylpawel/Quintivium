// ─── Shared tile math + tile-canvas builder ──────────────────────────────────
// Single source of truth for the dual-grid terrain algorithm shared between
// the game (game/game.js) and the editor (editor/editor.js). Clamping a copy in
// each file previously let them drift: the editor copy assumed every base
// terrain had a sprite sheet, which throws for sprite-less base terrains.
// Keep this framework-agnostic — no game/editor state, only `tileset` + TILE.

const TILE = 32

/**
 * Deterministic hash of a grid coordinate — produces visually uncorrelated
 * integers, avoiding the diagonal banding of a linear formula.
 */
export function tileHash(rx, ry) {
    let s = Math.imul(rx + 1, 0x9e3779b9) ^ Math.imul(ry + 1, 0x85ebca6b)
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    return (s ^ (s >>> 16)) >>> 0
}

/**
 * Pick a variant sprite index for (rx,ry) from the first terrain in the
 * priority list that has more than one variant. 0 when none vary.
 */
export function getVariantIndex(tileset, rx, ry) {
    for (const t of tileset.priorityList)
        if ((t.variants ?? 1) > 1) return tileHash(rx, ry) % t.variants
    return 0
}

/**
 * Build a single TILE×TILE canvas for one dual-grid node from its four corner
 * terrain ids. Lowest-priority terrain is filled first so feathered sprite
 * edges blend against it instead of transparent black; a sprite-less base
 * terrain falls back to the tileset's solid `backgroundColor`.
 */
export function buildTileCanvas(tileset, tl, tr, bl, br, rx, ry) {
    const c    = document.createElement('canvas')
    c.width = c.height = TILE
    const cctx = c.getContext('2d')
    cctx.imageSmoothingEnabled = false

    const base    = tileset.priorityList[0]
    const baseVar = tileHash(rx, ry) % (base.variants ?? 1)
    if (base.sprite) {
        cctx.drawImage(base.img, 15 * TILE, baseVar * TILE, TILE, TILE, 0, 0, TILE, TILE)
    } else {
        cctx.fillStyle = tileset.backgroundColor ?? '#000000'
        cctx.fillRect(0, 0, TILE, TILE)
    }

    for (const terrain of tileset.priorityList) {
        const id   = terrain.id
        const mask = ((tl === id ? 1 : 0) << 3) | ((tr === id ? 1 : 0) << 2)
                   | ((bl === id ? 1 : 0) << 1) |  (br === id ? 1 : 0)
        if (!mask) continue
        const variant = tileHash(rx, ry) % (terrain.variants ?? 1)
        cctx.drawImage(terrain.img, mask * TILE, variant * TILE, TILE, TILE, 0, 0, TILE, TILE)
    }
    return c
}
