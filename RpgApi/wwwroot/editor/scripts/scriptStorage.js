/**
 * Script Storage — Load/Save per-map script files
 *
 * Matches the scriptFiles structure in scenario.json:
 * - "scripts.json" — global scripts (no auto map scope)
 * - { "file": "map_scripts.json", "map": "map_id" } — per-map scripts with auto map scope
 */

const SCRIPTS_BASE_PATH = '../scenarios/mystic_island_PL'; // Current scenario path (relative to editor page)

/**
 * Custom JSON stringify that keeps actions and position objects compact (on single lines)
 * @param {any} obj - Object to stringify
 * @param {number} indent - Indent spaces for main structure (default 2)
 * @returns {string} JSON string with compact actions and positions
 */
function stringifyScript(obj, indent = 2) {
  const indentStr = ' '.repeat(indent);
  const newLine = '\n';

  // Helper to check if an object is a "position-like" object (tile, position)
  function isPositionLike(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj);
    return keys.length <= 3 && keys.every(k => ['x', 'y', 'mark'].includes(k));
  }

  // Helper to check if an object is an action-like object (has type)
  function isActionLike(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return 'type' in obj;
  }

  // Recursive stringify with special handling
  function stringifyValue(val, depth, isAction = false, isPosition = false) {
    if (val === null) return 'null';
    if (val === undefined) return undefined;
    if (typeof val === 'string') return JSON.stringify(val);
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
      // For actions array, each action on one line
      if (val.length > 0 && isActionLike(val[0])) {
        const items = val.map(item => stringifyValue(item, depth + 1, true, false));
        return '[' + newLine + items.map(i => indentStr.repeat(depth + 1) + i).join(',' + newLine) + newLine + indentStr.repeat(depth) + ']';
      }
      // For other arrays, use standard formatting
      if (val.length === 0) return '[]';
      const items = val.map(item => stringifyValue(item, depth + 1));
      if (items.every(i => i.length < 50 && !i.includes('\n'))) {
        return '[' + items.join(', ') + ']';
      }
      return '[' + newLine + items.map(i => indentStr.repeat(depth + 1) + i).join(',' + newLine) + newLine + indentStr.repeat(depth) + ']';
    }
    // Object
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';

    // Check if this is a position-like object
    const posLike = isPositionLike(val);
    // Check if this is an action-like object
    const actLike = isActionLike(val) && !posLike;

    const pairs = keys.map(key => {
      const value = val[key];
      if (value === undefined) return undefined;
      const keyStr = JSON.stringify(key);
      const valueStr = stringifyValue(value, depth + 1, actLike, posLike);
      if (valueStr === undefined) return undefined;
      return keyStr + ': ' + valueStr;
    }).filter(Boolean);

    if (posLike || actLike) {
      // Compact format for positions and actions
      return '{ ' + pairs.join(', ') + ' }';
    }

    // Standard pretty format for other objects
    return '{' + newLine + pairs.map(p => indentStr.repeat(depth + 1) + p).join(',' + newLine) + newLine + indentStr.repeat(depth) + '}';
  }

  return stringifyValue(obj, 0);
}

// Cache for loaded scripts to prevent duplicate fetches
let scriptsCache = null;
let cachePromise = null;

/**
 * Load all scripts for the current scenario
 * Reads scenario.json to get scriptFiles, then loads each file
 * Uses caching to prevent duplicate fetches
 * @returns {Promise<Array>} All scripts combined
 */
export async function loadAllScripts() {
  // Return cached result if available
  if (scriptsCache !== null) {
    return scriptsCache;
  }

  // Return in-flight promise if already loading
  if (cachePromise) {
    return cachePromise;
  }

  // Start loading
  cachePromise = loadAllScriptsInternal();
  try {
    scriptsCache = await cachePromise;
    return scriptsCache;
  } finally {
    cachePromise = null;
  }
}

/**
 * Internal implementation of loadAllScripts (without caching)
 * @returns {Promise<Array>} All scripts combined
 */
async function loadAllScriptsInternal() {
  try {
    // First load scenario.json to get scriptFiles
    const scenarioRes = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (!scenarioRes.ok) throw new Error('Failed to load scenario.json');

    const scenario = await scenarioRes.json();
    const scriptFiles = scenario.scriptFiles ?? ['scripts.json'];

    const allScripts = [];

    for (const entry of scriptFiles) {
      let filePath, autoMapScope;

      if (typeof entry === 'string') {
        filePath = entry;
        autoMapScope = null;
      } else if (entry?.file) {
        filePath = entry.file;
        autoMapScope = entry.map ?? null;
      } else {
        continue;
      }

      try {
        const res = await fetch(`${SCRIPTS_BASE_PATH}/${filePath}`, { cache: 'no-store' });
        if (res.ok) {
          const scripts = await res.json();
          // Apply auto map scope to scripts that don't have one
          if (autoMapScope) {
            scripts.forEach(s => {
              if (!s.map) s.map = autoMapScope;
            });
          }
          allScripts.push(...scripts);
        }
      } catch (e) {
        console.warn(`[ScriptStorage] Failed to load ${filePath}:`, e);
      }
    }

    return allScripts;
  } catch (e) {
    console.error('[ScriptStorage] Failed to load scripts:', e);
    return [];
  }
}

/**
 * Invalidate the scripts cache (call after saving scripts)
 */
export function invalidateScriptsCache() {
  scriptsCache = null;
}

/**
 * Load scripts for a specific map
 * @param {string} mapId - Map identifier
 * @returns {Promise<Array>} Scripts scoped to this map
 */
export async function loadMapScripts(mapId) {
  const allScripts = await loadAllScripts();
  return allScripts.filter(s => !s.map || s.map === mapId);
}

/**
 * Load global scripts (no map scope)
 * @returns {Promise<Array>} Global scripts
 */
export async function loadGlobalScripts() {
  const allScripts = await loadAllScripts();
  return allScripts.filter(s => !s.map);
}

/**
 * Save scripts for a specific map to its script file
 * @param {string} mapId - Map identifier
 * @param {Array} scripts - Scripts to save (will be filtered to this map)
 * @returns {Promise<boolean>} Success
 */
export async function saveMapScripts(mapId, scripts) {
  // Determine the script file for this map
  const scriptFile = getScriptFileForMap(mapId);
  if (!scriptFile) {
    console.error('[ScriptStorage] No script file configured for map:', mapId);
    return false;
  }

  // Filter scripts for this map
  const mapScripts = scripts.filter(s => s.map === mapId);

  try {
    // Clean scripts before saving
    const cleanedScripts = mapScripts.map(cleanScriptForSave);
    const body = stringifyScript(cleanedScripts, 2);

    // Try server save first
    const res = await fetch(`${SCRIPTS_BASE_PATH}/${scriptFile}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (res.ok) {
      invalidateScriptsCache();
      return true;
    }

    // Fallback: trigger download
    downloadScriptFile(scriptFile, body);
    invalidateScriptsCache();
    return true;
  } catch (e) {
    console.error('[ScriptStorage] Failed to save scripts:', e);
    downloadScriptFile(scriptFile, body);
    invalidateScriptsCache();
    return true; // Download succeeded
  }
}

/**
 * Save global scripts to scripts.json
 * @param {Array} scripts - Global scripts to save
 * @returns {Promise<boolean>} Success
 */
export async function saveGlobalScripts(scripts) {
  const globalScripts = scripts.filter(s => !s.map);

  try {
    // Clean scripts before saving
    const cleanedScripts = globalScripts.map(cleanScriptForSave);
    const body = stringifyScript(cleanedScripts, 2);
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scripts.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (res.ok) {
      invalidateScriptsCache();
      return true;
    }

    downloadScriptFile('scripts.json', body);
    invalidateScriptsCache();
    return true;
  } catch (e) {
    console.error('[ScriptStorage] Failed to save global scripts:', e);
    downloadScriptFile('scripts.json', body);
    invalidateScriptsCache();
    return true;
  }
}

/**
 * Get the script file name for a given map from scenario.json
 * @param {string} mapId
 * @returns {Promise<string|null>} Script file name or null
 */
export async function getScriptFileForMap(mapId) {
  try {
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (!res.ok) return null;

    const scenario = await res.json();
    const scriptFiles = scenario.scriptFiles ?? ['scripts.json'];

    for (const entry of scriptFiles) {
      if (typeof entry === 'object' && entry?.map === mapId) {
        return entry.file;
      }
    }

    // If no specific file, check if there's a convention
    // e.g., map_id + '_script.json'
    return `${mapId}_script.json`;
  } catch (e) {
    console.warn('[ScriptStorage] Could not determine script file for map:', mapId);
    return `${mapId}_script.json`;
  }
}

/**
 * Sync scenario.json scriptFiles with current map scripts
 * Adds entries for maps that have scripts but aren't in scriptFiles
 * @param {Array} allScripts - All scripts
 * @returns {Promise<void>}
 */
export async function syncScenarioScriptFiles(allScripts) {
  try {
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (!res.ok) return;

    const scenario = await res.json();
    const scriptFiles = scenario.scriptFiles ?? ['scripts.json'];

    // Find maps that have scripts
    const mapsWithScripts = new Set();
    for (const script of allScripts) {
      if (script.map) mapsWithScripts.add(script.map);
    }

    // Check if each map has a script file entry
    for (const mapId of mapsWithScripts) {
      const hasEntry = scriptFiles.some(entry =>
        typeof entry === 'object' && entry?.map === mapId
      );

      if (!hasEntry) {
        // Add new entry
        scriptFiles.push({
          file: `${mapId}_script.json`,
          map: mapId
        });
      }
    }

    // Save updated scenario.json
    await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scenario, null, 2)
    });
    invalidateScriptsCache();
  } catch (e) {
    console.warn('[ScriptStorage] Failed to sync scenario scriptFiles:', e);
  }
}

/**
 * Download a script file (fallback when server save fails)
 * @param {string} filename
 * @param {string} content
 */
function downloadScriptFile(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Create a new script file for a map and add to scenario.json
 * @param {string} mapId
 * @returns {Promise<string>} The created script file name
 */
export async function createScriptFileForMap(mapId) {
  const fileName = `${mapId}_script.json`;

  // Create empty file on server
  try {
    await fetch(`${SCRIPTS_BASE_PATH}/${fileName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([], null, 2)
    });
  } catch (e) {
    console.warn('[ScriptStorage] Could not create script file on server:', e);
  }

  // Add to scenario.json
  try {
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (res.ok) {
      const scenario = await res.json();
      const scriptFiles = scenario.scriptFiles ?? ['scripts.json'];

      if (!scriptFiles.some(e => typeof e === 'object' && e?.map === mapId)) {
        scriptFiles.push({ file: fileName, map: mapId });
        await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scenario, null, 2)
        });
      }
    }
  } catch (e) {
    console.warn('[ScriptStorage] Could not update scenario.json:', e);
  }

  invalidateScriptsCache();
  return fileName;
}

/**
 * Delete a script file and remove from scenario.json
 * @param {string} mapId
 * @returns {Promise<void>}
 */
export async function deleteScriptFileForMap(mapId) {
  const fileName = `${mapId}_script.json`;

  try {
    // Remove from scenario.json
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (res.ok) {
      const scenario = await res.json();
      scenario.scriptFiles = (scenario.scriptFiles ?? []).filter(
        e => !(typeof e === 'object' && e?.map === mapId)
      );
      await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenario, null, 2)
      });
    }
  } catch (e) {
    console.warn('[ScriptStorage] Failed to remove from scenario.json:', e);
  }

  invalidateScriptsCache();
}

/**
 * Get script file info for UI display
 * @returns {Promise<Array<{file: string, map: string|null, scriptCount: number}>>}
 */
export async function getScriptFilesInfo() {
  try {
    const res = await fetch(`${SCRIPTS_BASE_PATH}/scenario.json`);
    if (!res.ok) return [];

    const scenario = await res.json();
    const scriptFiles = scenario.scriptFiles ?? ['scripts.json'];

    const info = [];

    for (const entry of scriptFiles) {
      let filePath, mapScope;

      if (typeof entry === 'string') {
        filePath = entry;
        mapScope = null;
      } else if (entry?.file) {
        filePath = entry.file;
        mapScope = entry.map ?? null;
      } else {
        continue;
      }

      let scriptCount = 0;
      try {
        const scriptRes = await fetch(`${SCRIPTS_BASE_PATH}/${filePath}`);
        if (scriptRes.ok) {
          const scripts = await scriptRes.json();
          scriptCount = scripts.length;
        }
      } catch (e) {
        // File doesn't exist yet
      }

      info.push({ file: filePath, map: mapScope, scriptCount });
    }

    return info;
  } catch (e) {
    console.error('[ScriptStorage] Failed to get script files info:', e);
    return [];
  }
}

/**
 * Load scripts from a specific file (not tied to map)
 * @param {string} filePath - Path to script file relative to scenario directory
 * @returns {Promise<Array>} Scripts from the file
 */
export async function loadScriptFile(filePath) {
  try {
    const res = await fetch(`${SCRIPTS_BASE_PATH}/${filePath}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn(`[ScriptStorage] Failed to load script file ${filePath}:`, e);
    return [];
  }
}

/**
 * Clean a script object for saving - remove default/empty fields
 * @param {Object} script - Script object
 * @returns {Object} Cleaned script object
 */
function cleanScriptForSave(script) {
  const cleaned = { ...script };

  // Remove name entirely (not used by engine)
  delete cleaned.name;

  // Remove enabled entirely (not used by engine, default is true)
  delete cleaned.enabled;

  // Remove condition if empty or undefined
  if (!cleaned.condition || cleaned.condition.trim() === '') {
    delete cleaned.condition;
  }

  // Remove tile if it has no x/y/mark
  if (cleaned.tile && (!Number.isFinite(cleaned.tile.x) && !Number.isFinite(cleaned.tile.y) && !cleaned.tile.mark)) {
    delete cleaned.tile;
  }

  // Remove map if not set (global scripts don't need it)
  if (!cleaned.map) {
    delete cleaned.map;
  }

  // Remove npc if not set
  if (!cleaned.npc) {
    delete cleaned.npc;
  }

  // Normalize event -> on
  if (cleaned.event && !cleaned.on) {
    cleaned.on = cleaned.event;
    delete cleaned.event;
  }

  // Clean actions - remove default/empty fields from each action
  if (cleaned.actions) {
    cleaned.actions = cleaned.actions.map(cleanActionForSave);
  }

  return cleaned;
}

/**
 * Clean an action object for saving - remove default values
 * @param {Object} action - Action object
 * @returns {Object} Cleaned action object
 */
function cleanActionForSave(action) {
  const cleaned = { ...action };

  // Remove fields with default values that the engine will use anyway
  // These are the engine defaults that don't need to be in the JSON

  switch (cleaned.type) {
    case 'set_weather':
      if (cleaned.intensity === 0.6) delete cleaned.intensity;
      if (cleaned.wind === 0) delete cleaned.wind;
      if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs;
      break;

    case 'set_lighting':
      if (cleaned.lighting === 'day') delete cleaned.lighting;
      if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs;
      break;

    case 'set_flag':
      if (cleaned.value === true) delete cleaned.value; // default is true
      break;

    case 'set_variable':
    case 'add_variable':
      if (cleaned.value === 0) delete cleaned.value;
      if (cleaned.delta === 1) delete cleaned.delta;
      break;

    case 'give_item':
    case 'remove_item':
    case 'spawn_item':
      if (cleaned.qty === 1) delete cleaned.qty;
      break;

    case 'show_message':
      if (cleaned.duration === 3000) delete cleaned.duration;
      break;

    case 'spawn_monster':
      if (!cleaned.radius || cleaned.radius === 0) delete cleaned.radius;
      if (!cleaned.pool) delete cleaned.pool;
      break;

    case 'spawn_npc':
      if (cleaned.flip_x === false) delete cleaned.flip_x;
      break;

    case 'change_map':
      if (!cleaned.mark) delete cleaned.mark;
      if (!cleaned.x) delete cleaned.x;
      if (!cleaned.y) delete cleaned.y;
      break;

    case 'change_tile':
      if (!cleaned.mark) delete cleaned.mark;
      if (!cleaned.x) delete cleaned.x;
      if (!cleaned.y) delete cleaned.y;
      break;

    case 'show_dialog':
    case 'show_choice':
    case 'show_message':
      if (!cleaned.speaker) delete cleaned.speaker;
      if (!cleaned.give) delete cleaned.give;
      if (!cleaned.show) delete cleaned.show;
      if (!cleaned.item) delete cleaned.item;
      if (!cleaned.items) delete cleaned.items;
      break;
  }

  // Clean nested actions in show_choice and pick_random
  if (cleaned.choices) {
    cleaned.choices = cleaned.choices.map(choice => ({
      ...choice,
      actions: choice.actions ? choice.actions.map(cleanActionForSave) : []
    }));
    // Remove choices with no actions (optional)
    cleaned.choices = cleaned.choices.filter(c => c.actions && c.actions.length > 0);
    if (cleaned.choices.length === 0) delete cleaned.choices;
  }

  if (cleaned.branches) {
    cleaned.branches = cleaned.branches.map(branch => ({
      ...branch,
      actions: branch.actions ? branch.actions.map(cleanActionForSave) : []
    }));
    cleaned.branches = cleaned.branches.filter(b => b.actions && b.actions.length > 0);
    if (cleaned.branches.length === 0) delete cleaned.branches;
  }

  // Remove empty data objects
  if (cleaned.data && Object.keys(cleaned.data).length === 0) delete cleaned.data;

  return cleaned;
}

// File handle cache for File System Access API (persisted per file)
const scriptFileHandles = new Map();

async function writeToHandle(handle, body) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) !== 'granted' &&
      (await handle.requestPermission(opts)) !== 'granted') {
    throw new Error('Write permission denied');
  }
  const writable = await handle.createWritable();
  await writable.write(body);
  await writable.close();
}

/**
 * Save scripts to a specific file
 * @param {string} filePath - Path to script file relative to scenario directory
 * @param {Array} scripts - Scripts to save
 * @returns {Promise<boolean>} Success
 */
export async function saveScriptFile(filePath, scripts) {
  let body;
  try {
    // Clean scripts before saving
    const cleanedScripts = scripts.map(cleanScriptForSave);
    body = stringifyScript(cleanedScripts, 2);

    const canPick = typeof window.showSaveFilePicker === 'function';

    // Reuse the handle from the first save so repeat saves overwrite the same file.
    // Done before any await so the click's user activation is still valid for re-prompting.
    const cached = scriptFileHandles.get(filePath);
    if (cached) {
      try {
        await writeToHandle(cached, body);
        invalidateScriptsCache();
        return true;
      } catch (e) {
        console.warn('[ScriptStorage] Cached file handle failed, re-picking:', e);
        scriptFileHandles.delete(filePath);
      }
    }

    // With no server this throws; that must not skip the local-save fallbacks.
    try {
      const res = await fetch(`${SCRIPTS_BASE_PATH}/${filePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) {
        invalidateScriptsCache();
        return true;
      }
    } catch (e) {
      console.warn('[ScriptStorage] Server save unavailable:', e);
    }

    if (canPick) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filePath,
          types: [{ description: 'Script JSON', accept: { 'application/json': ['.json'] } }]
        });
        await writeToHandle(handle, body);
        scriptFileHandles.set(filePath, handle);
        invalidateScriptsCache();
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // user cancelled
        console.warn('[ScriptStorage] File System Access API failed:', e);
      }
    }

    downloadScriptFile(filePath, body);
    invalidateScriptsCache();
    return true;
  } catch (e) {
    console.error('[ScriptStorage] Failed to save script file:', e);
    downloadScriptFile(filePath, body);
    invalidateScriptsCache();
    return true;
  }
}

/**
 * Load scripts from a local file (File API)
 * @param {File} file - File object from input
 * @returns {Promise<Array>} Scripts from the file
 */
export function loadScriptFileLocal(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const scripts = JSON.parse(e.target.result);
        resolve(Array.isArray(scripts) ? scripts : []);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}