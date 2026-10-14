/**
 * Editor Autocomplete Helpers
 *
 * Provides autocomplete data for the ECA editor panels.
 * Fetches NPCs from current map and known maps from scenario/tilesets.
 */

let cachedMapNpcs = null;
let cachedMaps = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds

/**
 * Get NPC IDs from the currently loaded map in the editor
 * @returns {string[]} Sorted NPC IDs
 */
export function getMapNpcs() {
  // Try to get NPCs from editor's current map
  const editor = window.editor;
  if (editor?.currentMap?.npcs) {
    const npcs = editor.currentMap.npcs;
    // npcs could be array or object
    const ids = Array.isArray(npcs) ? npcs.map(n => n.id).filter(Boolean) : Object.keys(npcs);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  // Fallback: check map data
  if (editor?.currentMap?._npcDefs) {
    return [...new Set(editor.currentMap._npcDefs.map(n => n.id))].sort();
  }

  // Fallback: try to get from map data
  if (editor?.currentMap?.npcData) {
    const ids = Array.isArray(editor.currentMap.npcData)
      ? editor.currentMap.npcData.map(n => n.id).filter(Boolean)
      : Object.keys(editor.currentMap.npcData);
    return [...new Set(ids)].sort();
  }

  // Last resort: return known NPC types from game
  return [
    'Hero-Mage',
    'Merchant',
    'Guard',
    'Villager',
    'Elder'
  ];
}

/**
 * Get all known map IDs from tilesets and scenario
 * @returns {Promise<string[]>} Sorted map IDs
 */
export async function getKnownMaps() {
  const now = Date.now();
  if (cachedMaps && now - cacheTimestamp < CACHE_TTL) {
    return cachedMaps;
  }

  try {
    const [registryRes, scenarioRes] = await Promise.all([
      fetch('../tilesets/tilesets.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('../scenarios/mystic_island_PL/scenario.json').then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    const ids = new Set();

    // From tileset registry
    if (registryRes?.tilesets) {
      registryRes.tilesets.forEach(t => ids.add(t.id));
    }

    // From scenario.json
    if (scenarioRes?.maps) {
      scenarioRes.maps.forEach(m => ids.add(m.id));
    }

    // Also check editor's loaded maps
    if (window.editor?.maps) {
      for (const map of Object.values(window.editor.maps)) {
        if (map?.id) ids.add(map.id);
      }
    }

    cachedMaps = Array.from(ids).sort((a, b) => a.localeCompare(b));
    cacheTimestamp = now;
    return cachedMaps;
  } catch (e) {
    console.warn('[EditorAutocomplete] Failed to load maps:', e);
    return ['island_1', 'cave', 'map', 'town'];
  }
}

/**
 * Get all marks (named tiles) from current map
 * @returns {Array<{name: string, x: number, y: number}>}
 */
export function getMapMarks() {
  const editor = window.editor;
  const map = editor?.currentMap;
  if (!map?._marks) return [];

  return Object.entries(map._marks).map(([key, name]) => {
    const [x, y] = key.split(',').map(Number);
    return { name, x, y };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get all flags and variables from scenario and loaded scripts
 * @returns {{flags: string[], variables: string[]}}
 */
export function getFlagsAndVariables() {
  const editor = window.editor;
  const flags = new Set();
  const variables = new Set();

  // From scenario
  if (editor?.scenario) {
    Object.keys(editor.scenario.flags ?? {}).forEach(f => flags.add(f));
    Object.keys(editor.scenario.variables ?? {}).forEach(v => variables.add(v));
  }

  // From loaded scripts (all maps)
  if (editor?.scriptFiles) {
    for (const scripts of Object.values(editor.scriptFiles)) {
      for (const script of scripts) {
        for (const action of script.actions ?? []) {
          if (action.type === 'set_flag' || action.type === 'clear_flag') {
            flags.add(action.name);
          }
          if (action.type === 'set_variable' || action.type === 'add_variable') {
            variables.add(action.name);
          }
        }
        // Also check conditions
        if (script.condition) {
          const flagMatches = script.condition.match(/flag\(['"]?([^'")]+)['"]?/g);
          if (flagMatches) {
            flagMatches.forEach(m => {
              const match = m.match(/flag\(['"]?([^'")]+)['"]?/);
              if (match) flags.add(match[1]);
            });
          }
          const statMatches = script.condition.match(/stat\(([^)]+)\)/g);
          if (statMatches) {
            statMatches.forEach(m => {
              const match = m.match(/stat\(([^)]+)\)/);
              if (match) {
                const attr = match[1].split(/[<>=!]+/)[0].trim();
                variables.add(attr);
              }
            });
          }
        }
      }
    }
  }

  return {
    flags: Array.from(flags).sort(),
    variables: Array.from(variables).sort()
  };
}

/**
 * Clear autocomplete caches
 */
export function clearAutocompleteCache() {
  cachedMapNpcs = null;
  cachedMaps = null;
  cacheTimestamp = 0;
}