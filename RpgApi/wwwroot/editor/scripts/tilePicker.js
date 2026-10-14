/**
 * Tile Picker Tool — Click on map to get tile coordinates
 *
 * Usage:
 * - Activate tool from toolbar
 * - Click any tile on the map
 * - Coordinates copied to clipboard and shown in status
 * - Can insert into active script action field
 */

import { getCell, getRaw, getRawHeight, getHeight } from '../map.js'

/**
 * Create Tile Picker tool
 * @param {Object} deps - Dependencies
 * @param {HTMLCanvasElement} deps.canvas - Editor canvas element
 * @param {HTMLElement} deps.container - Map container (for scrollLeft/scrollTop)
 * @param {Function} deps.getZoom - Function returning current zoom level
 * @param {Function} deps.getMap - Function returning current map
 * @param {Function} deps.onCoordsPicked - Callback with { x, y, terrainId, height }
 * @returns {Object} Tool API { activate, deactivate, isActive }
 */
export function createTilePickerTool({ canvas, container, getZoom, getMap, onCoordsPicked }) {
  let isActive = false
  let statusElement = null
  let overlayCanvas = null
  let overlayCtx = null

  // Create status display
  function createStatusDisplay() {
    statusElement = document.createElement('div')
    statusElement.id = 'tile-picker-status'
    statusElement.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.9);
      color: #0f0;
      padding: 10px 16px;
      border-radius: 4px;
      font-family: 'Consolas', monospace;
      font-size: 14px;
      border: 1px solid #0f0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 1000;
      pointer-events: none;
      display: none;
      min-width: 280px;
      text-align: center;
    `
    document.body.appendChild(statusElement)
  }

  // Create overlay canvas for highlighting
  function createOverlay() {
    const existing = canvas?.parentElement?.querySelector('#tile-picker-overlay')
    if (existing) return existing

    overlayCanvas = document.createElement('canvas')
    overlayCanvas.id = 'tile-picker-overlay'
    overlayCanvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      pointer-events: none;
      z-index: 50;
    `
    if (canvas?.parentElement) {
      canvas.parentElement.appendChild(overlayCanvas)
    }
    overlayCtx = overlayCanvas.getContext('2d')
    overlayCtx.imageSmoothingEnabled = false

    // Size to match editor canvas
    resizeOverlay()
    return overlayCanvas
  }

  function resizeOverlay() {
    if (!overlayCanvas || !canvas) return
    overlayCanvas.width = canvas.width
    overlayCanvas.height = canvas.height
  }

  // Highlight tile under mouse
  function highlightTile(tileX, tileY) {
    if (!overlayCtx || !canvas) return

    const zoom = getZoom()
    const TILE = 32
    const scrollX = container.scrollLeft
    const scrollY = container.scrollTop

    // Convert tile world position to screen coordinates
    // worldX = tileX * TILE, screenX = (worldX - scrollX) * zoom
    const screenX = Math.floor((tileX * TILE - scrollX) * zoom)
    const screenY = Math.floor((tileY * TILE - scrollY) * zoom)
    const tileSize = Math.floor(TILE * zoom)

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

    // Draw highlight
    overlayCtx.strokeStyle = '#0f0'
    overlayCtx.lineWidth = Math.max(1, 2 / zoom)
    overlayCtx.strokeRect(screenX + 0.5, screenY + 0.5, tileSize - 1, tileSize - 1)

    // Draw coordinate label
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.8)'
    overlayCtx.fillRect(screenX, screenY - 20, 120, 20)
    overlayCtx.fillStyle = '#0f0'
    overlayCtx.font = '11px Consolas, monospace'
    overlayCtx.fillText(`(${tileX}, ${tileY})`, screenX + 4, screenY - 6)
  }

  function clearHighlight() {
    if (overlayCtx) {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
    }
  }

  // Handle canvas click
  function handleCanvasClick(e) {
    if (!isActive) return

    // Get canvas-relative coordinates
    const rect = canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top

    // Convert to world coordinates
    // worldX = (canvasX + scrollX) / zoom
    const zoom = getZoom()
    const worldX = (canvasX + container.scrollLeft) / zoom
    const worldY = (canvasY + container.scrollTop) / zoom

    // Convert to tile coordinates (TILE = 32)
    const TILE = 32
    const tileX = Math.floor(worldX / TILE)
    const tileY = Math.floor(worldY / TILE)

    // Check bounds
    if (tileX < 0 || tileY < 0 || tileX >= getMap().width || tileY >= getMap().height) {
      showStatus(`Click out of bounds: (${tileX}, ${tileY})`, 'error')
      return
    }

    // Get tile info
    const terrainId = getCell(getMap(), tileX, tileY)
    const height = getHeight(getMap(), tileX, tileY)
    const rawTerrain = getRaw(getMap(), tileX + 1, tileY + 1) // With padding
    const rawHeight = getRawHeight(getMap(), tileX + 1, tileY + 1)

    const info = {
      x: tileX,
      y: tileY,
      worldX: tileX * TILE,
      worldY: tileY * TILE,
      terrainId,
      height,
      rawTerrain,
      rawHeight
    }

    // Copy to clipboard
    const coordText = `(${tileX}, ${tileY})`
    navigator.clipboard.writeText(coordText).then(() => {
      showStatus(`Tile: (${tileX}, ${tileY}) | Terrain: ${terrainId} | Height: ${height} | Copied!`, 'success')
    }).catch(() => {
      showStatus(`Tile: (${tileX}, ${tileY}) | Terrain: ${terrainId} | Height: ${height}`, 'success')
    })

    // Callback for integration
    if (tool.onCoordsPicked) tool.onCoordsPicked(info)
  }

  function handleMouseMove(e) {
    if (!isActive) return

    const rect = canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top

    const zoom = getZoom()
    const worldX = (canvasX + container.scrollLeft) / zoom
    const worldY = (canvasY + container.scrollTop) / zoom

    const TILE = 32
    const tileX = Math.floor(worldX / TILE)
    const tileY = Math.floor(worldY / TILE)

    if (tileX >= 0 && tileY >= 0 && tileX < getMap().width && tileY < getMap().height) {
      highlightTile(tileX, tileY)
      showStatus(`Hover: (${tileX}, ${tileY}) | Terrain: ${getCell(getMap(), tileX, tileY)} | Height: ${getHeight(getMap(), tileX, tileY)}`, 'hover')
    } else {
      clearHighlight()
      hideStatus()
    }
  }

  function handleMouseLeave() {
    clearHighlight()
    hideStatus()
  }

  function showStatus(message, type = 'info') {
    if (!statusElement) createStatusDisplay()

    const colors = {
      success: '#0f0',
      error: '#f44',
      hover: '#ff0',
      info: '#0af'
    }

    statusElement.style.borderColor = colors[type] || colors.info
    statusElement.style.color = colors[type] || colors.info
    statusElement.textContent = message
    statusElement.style.display = 'block'
  }

  function hideStatus() {
    if (statusElement) statusElement.style.display = 'none'
  }

  // Tool API
  const tool = {
    activate() {
      isActive = true
      createOverlay()
      createStatusDisplay()

      canvas.addEventListener('click', handleCanvasClick)
      canvas.addEventListener('mousemove', handleMouseMove)
      canvas.addEventListener('mouseleave', handleMouseLeave)
      canvas.style.cursor = 'crosshair'

      showStatus('Click a tile to pick coordinates (copied to clipboard)', 'info')
      console.log('[TilePicker] Activated')
    },

    deactivate() {
      isActive = false

      canvas.removeEventListener('click', handleCanvasClick)
      canvas.removeEventListener('mousemove', handleMouseMove)
      canvas.removeEventListener('mouseleave', handleMouseLeave)
      canvas.style.cursor = ''

      clearHighlight()
      hideStatus()

      if (overlayCanvas?.parentElement) {
        overlayCanvas.parentElement.removeChild(overlayCanvas)
      }
      overlayCanvas = null
      overlayCtx = null

      console.log('[TilePicker] Deactivated')
    },

    isActive() {
      return isActive
    },

    // Insert coordinates into a target input
    insertIntoInput(inputElement) {
      // This would be called with the last picked coordinates
      // For now, just a placeholder
      if (tool.lastPicked) {
        inputElement.value = `(${tool.lastPicked.x}, ${tool.lastPicked.y})`
        inputElement.dispatchEvent(new Event('input'))
      }
    },

    lastPicked: null
  }

  // Override onCoordsPicked to store last picked
  const originalCallback = onCoordsPicked
  tool.onCoordsPicked = (info) => {
    tool.lastPicked = info
    if (originalCallback) originalCallback(info)
  }

  // Allow setting a temporary callback (e.g., for script editor)
  tool.setCallback = (callback) => {
    tool.onCoordsPicked = (info) => {
      tool.lastPicked = info
      if (callback) callback(info)
    }
  }

  // Restore original callback
  tool.restoreCallback = () => {
    tool.onCoordsPicked = (info) => {
      tool.lastPicked = info
      if (originalCallback) originalCallback(info)
    }
  }

  return tool
}

// Standalone function to get tile info at coordinates (for use in other tools)
export function getTileInfoAt(map, tileX, tileY) {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) {
    return null
  }

  return {
    x: tileX,
    y: tileY,
    worldX: tileX * 32,
    worldY: tileY * 32,
    terrainId: getCell(map, tileX, tileY),
    height: getHeight(map, tileX, tileY),
    rawTerrain: getRaw(map, tileX + 1, tileY + 1),
    rawHeight: getRawHeight(map, tileX + 1, tileY + 1)
  }
}

// Get all unique terrain IDs used in map
export function getUsedTerrainIds(map) {
  const ids = new Set()
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      ids.add(getCell(map, x, y))
    }
  }
  return Array.from(ids)
}

// Get all unique decoration asset IDs used in map
export function getUsedDecorationIds(map) {
  const ids = new Set()
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const dec = map._decorations[y][x]
      if (dec?.assetId) ids.add(dec.assetId)
    }
  }
  return Array.from(ids)
}