// ─── Shared image loader ─────────────────────────────────────────────────────
// Single Promise wrapper around `new Image()` so game.js, tileset.js, and
// assets.js don't each keep their own copy.

export function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload  = () => resolve(img)
        img.onerror = () => reject(new Error(`Failed to load: ${src}`))
        img.src = src
    })
}
