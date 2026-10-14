/**
 * Action Schemas — Single Source of Truth for ECA Editor
 *
 * Contains:
 * - BUILTIN_EVENTS: 6 built-in events with context fields
 * - ACTION_SCHEMAS: 22 action types with field definitions
 * - Autocomplete data loaders for items, monsters, NPCs, maps, flags, variables
 * - Validation helpers
 */

// ─── Built-in Events ──────────────────────────────────────────────────────────
/**
 * Each event defines:
 * - id: event identifier
 * - label: human-readable name
 * - contextFields: fields available in condition expressions for this event
 * - requiredScope: which scope fields are relevant (map, tile, npc)
 */
export const BUILTIN_EVENTS = [
  {
    id: 'scenario_start',
    label: 'Scenario Start',
    description: 'Fires once when the scenario is first loaded',
    contextFields: [],
    requiredScope: []
  },
  {
    id: 'map_enter',
    label: 'Map Enter',
    description: 'Fires when the player enters a map',
    contextFields: ['map_id'],
    requiredScope: ['map']
  },
  {
    id: 'tile_approach',
    label: 'Tile Approach',
    description: 'Fires when the player tries to step onto a tile (before moving). Can block movement.',
    contextFields: ['x', 'y'],
    requiredScope: ['map', 'tile']
  },
  {
    id: 'tile_enter',
    label: 'Tile Enter',
    description: 'Fires after the player successfully moves onto a tile',
    contextFields: ['x', 'y'],
    requiredScope: ['map', 'tile']
  },
  {
    id: 'npc_interact',
    label: 'NPC Interact',
    description: 'Fires when the player interacts with (bumps into) an NPC',
    contextFields: ['npc_id', 'x', 'y'],
    requiredScope: ['map', 'npc']
  },
  {
    id: 'monster_defeated',
    label: 'Monster Defeated',
    description: 'Fires when the player wins a battle against a monster. Auto-increments kill counters.',
    contextFields: ['monster_type', 'monster_id', 'x', 'y', 'kills', 'total_kills'],
    requiredScope: ['map']
  }
];

// Custom events are user-defined strings fired via fire_event action
export const CUSTOM_EVENT_PLACEHOLDER = 'custom_event_name';


// ─── Action Schemas ───────────────────────────────────────────────────────────
/**
 * Each action defines:
 * - type: action type identifier (matches engine)
 * - label: human-readable name
 * - category: grouping for UI (Narrative, Environment, Movement, Flags & Variables, Inventory, World, Combat, Scenario)
 * - fields: array of field definitions
 * - description: help text
 *
 * Field types:
 * - 'text', 'textarea', 'number', 'select', 'checkbox'
 * - 'itemSelect': dropdown from item list
 * - 'monsterSelect': dropdown from monster list
 * - 'npcSelect': dropdown from NPC list
 * - 'mapSelect': dropdown from map list
 * - 'markSelect': dropdown from current map marks
 * - 'tilePicker': button to pick tile on map
 * - 'keyValue': { key: value } object (e.g., give: { "item_id": qty })
 * - 'json': raw JSON textarea for complex actions
 */
export const ACTION_SCHEMAS = {
  // Narrative
  show_dialog: {
    type: 'show_dialog',
    label: 'Show Dialog',
    category: 'Narrative',
    description: 'Shows a dialog box the player must dismiss (Space/Enter)',
    fields: [
      { name: 'text', type: 'textarea', required: true, placeholder: 'Dialog text...', description: 'Message to display' },
      { name: 'speaker', type: 'text', placeholder: 'Speaker name', description: 'Optional speaker name shown above the text' },
      { name: 'give', type: 'keyValue', valueType: 'itemQty', label: 'Give items (granted + shown)', description: 'Items granted to player AND shown as icons with quantity badges' },
      { name: 'show', type: 'keyValue', valueType: 'itemQty', label: 'Show items (shown only)', description: 'Items shown as icons with quantity badges but NOT granted' }
    ]
  },
  show_choice: {
    type: 'show_choice',
    label: 'Show Choice',
    category: 'Narrative',
    description: 'Shows a prompt with a list of buttons. Runs chosen option\'s actions.',
    fields: [
      { name: 'text', type: 'textarea', required: true, placeholder: 'Prompt text...', description: 'Prompt displayed above the choices' },
      { name: 'choices', type: 'json', required: true, placeholder: '[{"label": "Option 1", "condition": "flag(quest_started)", "actions": [...]}]', description: 'Array of choice objects with label, optional condition, and actions' }
    ]
  },
  show_message: {
    type: 'show_message',
    label: 'Show Message',
    category: 'Narrative',
    description: 'Shows a brief timed overlay message (does not block movement)',
    fields: [
      { name: 'text', type: 'textarea', required: true, placeholder: 'Message text...', description: 'Message to display' },
      { name: 'duration', type: 'number', default: 3000, min: 500, description: 'Display time in milliseconds' },
      { name: 'item', type: 'itemSelect', description: 'Single item to show as sprite alongside text' },
      { name: 'items', type: 'json', placeholder: '["item1", "item2"]', description: 'Array of item IDs to show as sprites' }
    ]
  },

  // Environment
  set_weather: {
    type: 'set_weather',
    label: 'Set Weather',
    category: 'Environment',
    description: 'Sets atmospheric weather for current map (rain/snow). Persists in-session.',
    fields: [
      { name: 'weather', type: 'select', required: true, options: ['none', 'rain', 'snow'], default: 'none', description: 'Weather type' },
      { name: 'intensity', type: 'number', default: 0.6, min: 0, max: 1, step: 0.1, description: 'Particle density 0-1' },
      { name: 'wind', type: 'number', default: 0, min: -100, max: 100, description: 'Horizontal particle tilt in px/s (also drives decoration lean)' },
      { name: 'transition_secs', type: 'number', default: 0, min: 0, description: 'Tween duration (omit/0 for instant)' }
    ]
  },
  set_lighting: {
    type: 'set_lighting',
    label: 'Set Lighting',
    category: 'Environment',
    description: 'Sets darkness/lighting overlay (night/sunset/day). Persists in-session. Composes with weather.',
    fields: [
      { name: 'lighting', type: 'select', required: true, options: ['day', 'night', 'sunset', 'custom'], default: 'day', description: 'Named preset or custom' },
      { name: 'custom', type: 'json', placeholder: '{"mode": "flat", "col": [0,1,10], "a": 0.8}', description: 'Custom lighting object (when lighting="custom")' },
      { name: 'transition_secs', type: 'number', default: 0, min: 0, description: 'Tween duration (night uses 2x slower)' }
    ]
  },

  // Movement
  block_move: {
    type: 'block_move',
    label: 'Block Move',
    category: 'Movement',
    description: 'Cancels the movement that triggered this script. Only meaningful in tile_approach scripts.',
    fields: []
  },

  // Flags & Variables
  set_flag: {
    type: 'set_flag',
    label: 'Set Flag',
    category: 'Flags & Variables',
    description: 'Sets a boolean flag (or clears it with value: false)',
    fields: [
      { name: 'name', type: 'text', required: true, placeholder: 'flag_name', description: 'Flag name' },
      { name: 'value', type: 'checkbox', default: true, description: 'Set to false to clear the flag' }
    ]
  },
  clear_flag: {
    type: 'clear_flag',
    label: 'Clear Flag',
    category: 'Flags & Variables',
    description: 'Removes a flag entirely (equivalent to never being set)',
    fields: [
      { name: 'name', type: 'text', required: true, placeholder: 'flag_name', description: 'Flag name to remove' }
    ]
  },
  set_variable: {
    type: 'set_variable',
    label: 'Set Variable',
    category: 'Flags & Variables',
    description: 'Sets a numeric (or string) variable to an exact value',
    fields: [
      { name: 'name', type: 'text', required: true, placeholder: 'variable_name', description: 'Variable name' },
      { name: 'value', type: 'number', required: true, default: 0, description: 'Value to set' }
    ]
  },
  add_variable: {
    type: 'add_variable',
    label: 'Add Variable',
    category: 'Flags & Variables',
    description: 'Adds a delta to a numeric variable (starts at 0 if not set)',
    fields: [
      { name: 'name', type: 'text', required: true, placeholder: 'variable_name', description: 'Variable name' },
      { name: 'delta', type: 'number', required: true, default: 1, description: 'Amount to add (can be negative)' }
    ]
  },

  // Inventory
  give_item: {
    type: 'give_item',
    label: 'Give Item',
    category: 'Inventory',
    description: 'Adds items to the player\'s inventory',
    fields: [
      { name: 'item_id', type: 'itemSelect', required: true, description: 'Item identifier' },
      { name: 'qty', type: 'number', default: 1, min: 1, description: 'Quantity to give' }
    ]
  },
  remove_item: {
    type: 'remove_item',
    label: 'Remove Item',
    category: 'Inventory',
    description: 'Removes items from the player\'s inventory (minimum 0)',
    fields: [
      { name: 'item_id', type: 'itemSelect', required: true, description: 'Item identifier' },
      { name: 'qty', type: 'number', default: 1, min: 1, description: 'Quantity to remove' }
    ]
  },

  // World
  fire_event: {
    type: 'fire_event',
    label: 'Fire Event',
    category: 'World',
    description: 'Fires a custom event immediately, running all matching scripts',
    fields: [
      { name: 'event', type: 'text', required: true, placeholder: 'my_custom_event', description: 'Custom event name to fire' },
      { name: 'data', type: 'json', placeholder: '{ "key": "value" }', description: 'Optional extra fields merged into event context' }
    ]
  },
  change_map: {
    type: 'change_map',
    label: 'Change Map',
    category: 'World',
    description: 'Moves the player to a different map',
    fields: [
      { name: 'map_id', type: 'mapSelect', required: true, description: 'Target map identifier' },
      { name: 'mark', type: 'markSelect', placeholder: 'Mark name on target map', description: 'Named tile on target map to spawn at (takes priority over x/y)' },
      { name: 'x', type: 'number', min: 0, description: 'Explicit spawn X (used if mark not set)' },
      { name: 'y', type: 'number', min: 0, description: 'Explicit spawn Y (used if mark not set)' }
    ]
  },
  spawn_monster: {
    type: 'spawn_monster',
    label: 'Spawn Monster',
    category: 'World',
    description: 'Spawns a monster on the current map',
    fields: [
      { name: 'monster', type: 'monsterSelect', required: true, label: 'Monster', description: 'Monster type name' },
      { name: 'position', type: 'positionPicker', label: 'Position', description: 'Spawn position - pick tile or enter mark/coordinates' },
      { name: 'radius', type: 'number', min: 0, label: 'Radius', description: 'Spawn within this radius of (x,y)' },
      { name: 'id', type: 'text', placeholder: 'unique_id', label: 'ID', description: 'Unique monster ID for npc_interact scoping (optional)' },
      { name: 'pool', type: 'text', placeholder: '2 or "1..3" or "1,3"', label: 'Pool', description: 'Question pool spec for battles with this monster' }
    ]
  },
  spawn_npc: {
    type: 'spawn_npc',
    label: 'Spawn NPC',
    category: 'World',
    description: 'Spawns an NPC on the current map',
    fields: [
      { name: 'npc', type: 'npcSelect', required: true, description: 'NPC type name (matches NPC_DEFS and sprite filename)' },
      { name: 'x', type: 'number', required: true, min: 0, description: 'Spawn tile X' },
      { name: 'y', type: 'number', required: true, min: 0, description: 'Spawn tile Y' },
      { name: 'id', type: 'text', required: true, placeholder: 'unique_npc_id', description: 'Unique NPC identifier for npc_interact scoping' },
      { name: 'flip_x', type: 'checkbox', default: false, description: 'Mirror sprite horizontally' }
    ]
  },
  pick_random: {
    type: 'pick_random',
    label: 'Pick Random',
    category: 'World',
    description: 'Runs the actions of one randomly chosen entry from a pool',
    fields: [
      { name: 'choices', type: 'json', required: true, placeholder: '[{"actions": [...]}, {"actions": [...]}]', description: 'Array of objects, each with an actions list. One picked at random with equal probability.' }
    ]
  },
  remove_decoration: {
    type: 'remove_decoration',
    label: 'Remove Decoration',
    category: 'World',
    description: 'Removes the decoration at the given tile from the current map. Persists in-session.',
    fields: [
      { name: 'x', type: 'number', required: true, min: 0, description: 'Tile X coordinate' },
      { name: 'y', type: 'number', required: true, min: 0, description: 'Tile Y coordinate' }
    ]
  },
  spawn_decoration: {
    type: 'spawn_decoration',
    label: 'Spawn Decoration',
    category: 'World',
    description: 'Spawns an asset as a decoration on the current map at the given tile. Overwrites existing. Persists in-session.',
    fields: [
      { name: 'asset_id', type: 'text', required: true, placeholder: 'asset_id', description: 'Asset identifier (from assets/definitions.json)' },
      { name: 'x', type: 'number', required: true, min: 0, description: 'Tile X coordinate' },
      { name: 'y', type: 'number', required: true, min: 0, description: 'Tile Y coordinate' }
    ]
  },
  spawn_item: {
    type: 'spawn_item',
    label: 'Spawn Item',
    category: 'World',
    description: 'Spawns an item on the current map at the given tile. Visible and auto-collected on enter.',
    fields: [
      { name: 'item_id', type: 'itemSelect', required: true, label: 'Item', description: 'Item identifier (from assets/items.json)' },
      { name: 'position', type: 'positionPicker', label: 'Position', description: 'Spawn position - pick tile or enter mark/coordinates' },
      { name: 'qty', type: 'number', default: 1, min: 1, label: 'Quantity', description: 'Quantity to spawn' }
    ]
  },
  change_tile: {
    type: 'change_tile',
    label: 'Change Tile',
    category: 'World',
    description: 'Replaces a single tile\'s terrain on the current map. Persists in-session.',
    fields: [
      { name: 'terrain', type: 'text', required: true, placeholder: 'grass or 7', description: 'Destination terrain (numeric ID or name like "grass", "water", "sand")' },
      { name: 'tile', type: 'tilePicker', description: 'Target tile — click "Pick Tile" button or enter mark name/coords' },
      { name: 'mark', type: 'markSelect', description: 'Named tile on current map (used if tile not set)' },
      { name: 'x', type: 'number', min: 0, description: 'Explicit target X (used if tile/mark not set)' },
      { name: 'y', type: 'number', min: 0, description: 'Explicit target Y (used if tile/mark not set)' }
    ]
  },

  // Combat
  start_combat: {
    type: 'start_combat',
    label: 'Start Combat',
    category: 'Combat',
    description: 'Starts a battle against a monster type. Script stops if player loses/flees.',
    fields: [
      { name: 'enemy_id', type: 'monsterSelect', required: true, description: 'Enemy type name' }
    ]
  },

  // Scenario Flow
  end_scenario: {
    type: 'end_scenario',
    label: 'End Scenario',
    category: 'Scenario',
    description: 'Ends the current scenario, optionally transitioning to another',
    fields: [
      { name: 'next', type: 'text', placeholder: 'scenario_2', description: 'Optional ID of next scenario to load' }
    ]
  },
  set_question_pool: {
    type: 'set_question_pool',
    label: 'Set Question Pool',
    category: 'Scenario',
    description: 'Sets global question pool spec for battles. Overrides default (pool 1).',
    fields: [
      { name: 'pool', type: 'text', required: true, placeholder: '2 or "1..3" or "1,3"', description: 'Question pool specification' }
    ]
  },
  clear_question_pool: {
    type: 'clear_question_pool',
    label: 'Clear Question Pool',
    category: 'Scenario',
    description: 'Clears global question pool spec, reverting to default (pool 1 only)',
    fields: []
  }
};

// Category order for UI dropdown
export const ACTION_CATEGORIES = [
  'Narrative',
  'Environment',
  'Movement',
  'Flags & Variables',
  'Inventory',
  'World',
  'Combat',
  'Scenario'
];


// ─── Autocomplete Data Loaders ────────────────────────────────────────────────
// These functions are called by the editor to get current data for dropdowns/autocomplete

/**
 * Get all item IDs from items.json and definitions.json (crafting)
 * @returns {Promise<string[]>} Sorted unique item IDs
 */
export async function getAllItemIds() {
  try {
    const [itemsRes, defsRes] = await Promise.all([
      fetch('../assets/items.json').then(r => r.ok ? r.json() : null),
      fetch('../assets/definitions.json').then(r => r.ok ? r.json() : null)
    ]);

    const ids = new Set();

    // From items.json
    if (itemsRes?.items) {
      Object.keys(itemsRes.items).forEach(id => ids.add(id));
    }
    if (itemsRes?.crafting) {
      Object.keys(itemsRes.crafting).forEach(id => ids.add(id));
    }

    // From definitions.json (assets that can be items)
    if (defsRes?.assets) {
      defsRes.assets.forEach(a => ids.add(a.id));
    }

    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[ECA] Failed to load items:', e);
    return [];
  }
}

/**
 * Get all monster type names from characters/enemies.json
 * @returns {Promise<string[]>} Sorted monster types
 */
export async function getAllMonsterTypes() {
  try {
    const res = await fetch('../characters/enemies.json');
    if (!res.ok) throw new Error('Failed to load enemies.json');
    const enemies = await res.json();
    // Extract unique monster names from the enemies array
    const names = enemies.map(e => e.name).filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[ECA] Failed to load monsters from enemies.json:', e);
    // Fallback to hardcoded list
    return [
      'Knight', 'Orc', 'OrcRogue', 'OrcShaman', 'OrcWarrior',
      'Rogue', 'Skeleton', 'SkeletonMage', 'SkeletonRogue', 'SkeletonWarrior', 'Wizard',
      'Skeleton Soldier', 'Skeleton Piercer', 'Skeleton Scholar',
      'Crab', 'Gorilla'
    ].sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Get all items with full data including icon positions for thumbnails
 * @param {Object} options - Options
 * @param {boolean} options.includeDefinitions - Whether to include assets from definitions.json (decorations, terrain). Default false for spawnable items.
 * @returns {Promise<Array<{id: string, icon: [number, number], type: string, bonuses: Object, light?: Object, source: string}>>} Items with icon data
 */
export async function getAllItemsWithData(options = {}) {
  const { includeDefinitions = false } = options;
  try {
    const [itemsRes, defsRes] = await Promise.all([
      fetch('../assets/items.json').then(r => r.ok ? r.json() : null),
      fetch('../assets/definitions.json').then(r => r.ok ? r.json() : null)
    ]);

    const items = [];

    // From items.json - items section (actual spawnable items)
    if (itemsRes?.items) {
      for (const [id, raw] of Object.entries(itemsRes.items)) {
        const icon = Array.isArray(raw) ? raw : (raw.icon ?? [0, 0]);
        items.push({
          id,
          icon,
          type: Array.isArray(raw) ? 'material' : (raw.type ?? 'material'),
          bonuses: Array.isArray(raw) ? {} : (raw.bonuses ?? {}),
          light: Array.isArray(raw) ? undefined : raw.light,
          source: 'items'
        });
      }
    }
    // From items.json - crafting section (crafting materials)
    if (itemsRes?.crafting) {
      for (const [id, raw] of Object.entries(itemsRes.crafting)) {
        const icon = Array.isArray(raw) ? raw : (raw.icon ?? [0, 0]);
        items.push({
          id,
          icon,
          type: Array.isArray(raw) ? 'crafting' : (raw.type ?? 'crafting'),
          bonuses: Array.isArray(raw) ? {} : (raw.bonuses ?? {}),
          light: Array.isArray(raw) ? undefined : raw.light,
          source: 'crafting'
        });
      }
    }

    // From definitions.json (assets - decorations, terrain, etc.) - only if explicitly requested
    if (includeDefinitions && defsRes?.assets) {
      for (const a of defsRes.assets) {
        // Only add if not already in items
        if (!items.find(i => i.id === a.id)) {
          items.push({
            id: a.id,
            icon: a.icon ?? [0, 0],
            type: 'asset',
            bonuses: {},
            source: 'definitions'
          });
        }
      }
    }

    return items.sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    console.warn('[ECA] Failed to load items with data:', e);
    return [];
  }
}

/**
 * Get all monsters with full data from enemies.json for thumbnails
 * @returns {Promise<Array<{name: string, charName: string, charZ: number, hp: number, attack: number, defense: number, armor: number, agility: number, base_dmg: number, xp: number, handRow?: number, lh?: Object, rh?: Object, wep1?: Object, wep2?: Object}>>} Monsters with full data
 */
export async function getAllMonstersWithData() {
  try {
    const res = await fetch('../characters/enemies.json');
    if (!res.ok) throw new Error('Failed to load enemies.json');
    const enemies = await res.json();
    // Return unique monsters by name with all their data
    const seen = new Set();
    const monsters = [];
    for (const e of enemies) {
      if (e.name && !seen.has(e.name)) {
        seen.add(e.name);
        monsters.push(e);
      }
    }
    return monsters.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.warn('[ECA] Failed to load monsters with data from enemies.json:', e);
    return [];
  }
}

/**
 * Get all NPC type names from game.js NPC_DEFS
 * @returns {Promise<string[]>} Sorted NPC types
 */
export async function getAllNPCTypes() {
  try {
    // NPC_DEFS is in game.js - for now return known ones
    return [
      'Hero-Mage', 'Merchant', 'Guard'
    ].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[ECA] Failed to load NPCs:', e);
    return [];
  }
}

/**
 * Get all map IDs from tileset registry and scenario
 * @returns {Promise<string[]>} Sorted map IDs
 */
export async function getAllMapIds() {
  try {
    const [registryRes, scenarioRes] = await Promise.all([
      fetch('../tilesets/tilesets.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('../scenarios/mystic_island_PL/scenario.json').then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    const ids = new Set();

    // From tileset registry (map files)
    if (registryRes?.tilesets) {
      registryRes.tilesets.forEach(t => ids.add(t.id));
    }

    // From scenario.json maps (would need to scan scenarios folder)
    // For now, add known maps
    ids.add('island_1');
    ids.add('cave');
    ids.add('map');
    ids.add('town');

    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[ECA] Failed to load maps:', e);
    return ['island_1', 'cave', 'map', 'town'];
  }
}

/**
 * Get all marks (named tiles) from current map
 * @param {Object} map - Current map object
 * @returns {Array<{name: string, x: number, y: number}>}
 */
export function getMapMarks(map) {
  if (!map?._marks) return [];
  return Object.entries(map._marks).map(([key, name]) => {
    const [x, y] = key.split(',').map(Number);
    return { name, x, y };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract all flags and variables from scenario and scripts
 * @param {Object} scenario - Scenario object
 * @param {Array} scripts - All scripts from all maps
 * @returns {{flags: string[], variables: string[]}}
 */
export function extractFlagsAndVariables(scenario, scripts) {
  const flags = new Set(Object.keys(scenario?.flags ?? {}));
  const variables = new Set(Object.keys(scenario?.variables ?? {}));

  if (scripts) {
    for (const script of scripts) {
      for (const action of script.actions ?? []) {
        if (action.type === 'set_flag' || action.type === 'clear_flag') {
          flags.add(action.name);
        }
        if (action.type === 'set_variable' || action.type === 'add_variable') {
          variables.add(action.name);
        }
      }
      // Also check conditions for flag()/stat() references
      if (script.condition) {
        const flagMatches = script.condition.match(/flag\(['"]?([^'")]+)['"]?/g);
        if (flagMatches) {
          flagMatches.forEach(m => {
            const name = m.match(/flag\(['"]?([^'")]+)['"]?/)[1];
            flags.add(name);
          });
        }
        const statMatches = script.condition.match(/stat\(([^)]+)\)/g);
        if (statMatches) {
          statMatches.forEach(m => {
            const attr = m.match(/stat\(([^)]+)\)/)[1].split(/[<>=!]+/)[0].trim();
            variables.add(attr);
          });
        }
      }
    }
  }

  return {
    flags: Array.from(flags).sort(),
    variables: Array.from(variables).sort()
  };
}


// ─── Validation Helpers ───────────────────────────────────────────────────────

/**
 * Validate a script object
 * @param {Object} script - Script to validate
 * @param {Object} context - { map, allScripts, scenario, items, monsters, npcs, maps }
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateScript(script, context = {}) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!script.id) errors.push('Script missing required "id"');
  if (!script.on) errors.push('Script missing required "on" event');
  if (!script.actions || !script.actions.length) errors.push('Script has no actions');

  // Validate event
  const event = BUILTIN_EVENTS.find(e => e.id === script.on);
  const isCustomEvent = !event && script.on !== CUSTOM_EVENT_PLACEHOLDER;

  if (!event && !isCustomEvent) {
    errors.push(`Unknown event: "${script.on}"`);
  }

  // Validate scopes
  if (event?.requiredScope) {
    if (event.requiredScope.includes('map') && !script.map) {
      warnings.push('Event requires map scope but "map" field is not set');
    }
    if (event.requiredScope.includes('tile') && !script.tile) {
      warnings.push('Event requires tile scope but "tile" field is not set');
    }
    if (event.requiredScope.includes('npc') && !script.npc) {
      warnings.push('Event requires NPC scope but "npc" field is not set');
    }
  }

  // Validate once requires id
  if (script.once && !script.id) {
    errors.push('"once: true" requires an "id" field');
  }

  // Validate actions
  if (script.actions) {
    script.actions.forEach((action, i) => {
      const actionErrors = validateSingleAction(action, context, i);
      errors.push(...actionErrors.errors);
      warnings.push(...actionErrors.warnings);
    });
  }

  // Validate condition syntax (using engine tokenizer/parser)
  if (script.condition) {
    const condValidation = validateCondition(script.condition);
    if (!condValidation.valid) {
      errors.push(`Condition syntax error: ${condValidation.error}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a single action
 */
function validateSingleAction(action, context, index) {
  const errors = [];
  const warnings = [];
  const prefix = `Action ${index + 1} (${action.type}):`;

  const schema = ACTION_SCHEMAS[action.type];
  if (!schema) {
    errors.push(`${prefix} Unknown action type "${action.type}"`);
    return { errors, warnings };
  }

  // Check required fields
  for (const field of schema.fields) {
    if (field.required && (action[field.name] === undefined || action[field.name] === '')) {
      errors.push(`${prefix} Required field "${field.name}" is missing`);
    }
  }

  // Type-specific validation
  switch (action.type) {
    case 'give_item':
    case 'remove_item':
    case 'spawn_item':
      if (action.item_id && context.items && !context.items.includes(action.item_id)) {
        warnings.push(`${prefix} Item "${action.item_id}" not found in item database`);
      }
      break;
    case 'spawn_monster':
    case 'start_combat':
      if (action.monster && context.monsters && !context.monsters.includes(action.monster)) {
        warnings.push(`${prefix} Monster "${action.monster}" not found in monster list`);
      }
      if (action.enemy_id && context.monsters && !context.monsters.includes(action.enemy_id)) {
        warnings.push(`${prefix} Enemy "${action.enemy_id}" not found in monster list`);
      }
      break;
    case 'spawn_npc':
      if (action.npc && context.npcs && !context.npcs.includes(action.npc)) {
        warnings.push(`${prefix} NPC "${action.npc}" not found in NPC list`);
      }
      break;
    case 'change_map':
      if (action.map_id && context.maps && !context.maps.includes(action.map_id)) {
        warnings.push(`${prefix} Map "${action.map_id}" not found in map list`);
      }
      break;
    case 'spawn_decoration':
      // Could validate against assetMap
      break;
    case 'change_tile':
      // Could validate terrain name
      break;
  }

  return { errors, warnings };
}

/**
 * Validate condition expression using shared engine tokenizer/parser
 * @param {string} condition - Condition string
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateCondition(condition) {
  try {
    // We'll import the engine's tokenizer/parser at runtime
    // For now, basic validation
    if (!condition.trim()) return { valid: true, error: null };

    // Check for balanced parentheses
    let paren = 0;
    for (const ch of condition) {
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      if (paren < 0) return { valid: false, error: 'Unbalanced parentheses' };
    }
    if (paren !== 0) return { valid: false, error: 'Unbalanced parentheses' };

    // Check for balanced brackets
    let brack = 0;
    for (const ch of condition) {
      if (ch === '[') brack++;
      else if (ch === ']') brack--;
      if (brack < 0) return { valid: false, error: 'Unbalanced brackets' };
    }
    if (brack !== 0) return { valid: false, error: 'Unbalanced brackets' };

    // Check for balanced quotes
    let inSingle = false, inDouble = false;
    for (let i = 0; i < condition.length; i++) {
      const ch = condition[i];
      if (ch === "'" && condition[i-1] !== '\\') inSingle = !inSingle;
      else if (ch === '"' && condition[i-1] !== '\\') inDouble = !inDouble;
    }
    if (inSingle || inDouble) return { valid: false, error: 'Unterminated string literal' };

    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Get event context fields for autocomplete in conditions
 */
export function getEventContextFields(eventId) {
  const event = BUILTIN_EVENTS.find(e => e.id === eventId);
  return event?.contextFields ?? [];
}

/**
 * Get all known condition functions for autocomplete
 */
export const CONDITION_FUNCTIONS = [
  { name: 'flag', signature: 'flag(name)', desc: 'True if named flag has been set', example: 'flag(cooper_visited)' },
  { name: 'flag', signature: 'flag(name, value)', desc: 'True if flag equals given string value', example: 'flag(quest_stage, started)' },
  { name: 'stat', signature: 'stat(name op value)', desc: 'Numeric variable comparison', example: 'stat(gold > 0)', operators: ['>=', '<=', '>', '<', '==', '!='] },
  { name: 'has_item', signature: 'has_item(item_id)', desc: 'True if player has at least 1 of the item', example: 'has_item(bread)' },
  { name: 'has_item', signature: 'has_item(item_id, qty)', desc: 'True if player has at least qty of the item', example: 'has_item(potion, 2)' },
  { name: 'has_tag', signature: 'has_tag(tag)', desc: 'True if player has any item whose id contains the tag', example: 'has_tag(key)' },
  { name: 'chance', signature: 'chance(probability)', desc: 'True with given probability (0.0-1.0)', example: 'chance(0.3)' },
  { name: 'map', signature: 'map(map_id)', desc: 'True if player is currently on the given map', example: 'map(cave)' },
  { name: 'near', signature: 'near(x, y, radius)', desc: 'True if player within radius tiles of (x,y)', example: 'near(10, 10, 3)' },
  { name: 'monster_type', signature: 'monster_type(\'Type\')', desc: 'True if slain monster type matches (monster_defeated only)', example: 'monster_type(\'Skeleton Reaper\')' },
  { name: 'kills', signature: 'kills', desc: 'Current event per-type tally (truthy if >0)', example: 'kills >= 2' },
  { name: 'kills', signature: 'kills[\'Type\']', desc: 'Running tally for Type', example: 'kills[\'Skeleton\'] >= 3' }
];

/**
 * Get all known condition operators for autocomplete
 */
export const CONDITION_OPERATORS = [
  { symbol: '==', desc: 'Equal to' },
  { symbol: '!=', desc: 'Not equal to' },
  { symbol: '>', desc: 'Greater than' },
  { symbol: '<', desc: 'Less than' },
  { symbol: '>=', desc: 'Greater than or equal' },
  { symbol: '<=', desc: 'Less than or equal' },
  { symbol: '&&', desc: 'Logical AND' },
  { symbol: '||', desc: 'Logical OR' },
  { symbol: '!', desc: 'Logical NOT' },
  { symbol: 'in', desc: 'Array/string contains' },
  { symbol: 'not in', desc: 'Array/string does not contain' }
];

// ─── Utility: Get schema for action type ──────────────────────────────────────
export function getActionSchema(type) {
  return ACTION_SCHEMAS[type];
}

export function getEventSchema(eventId) {
  return BUILTIN_EVENTS.find(e => e.id === eventId);
}

/**
 * Extract custom event names from all fire_event actions in current scripts
 * @returns {string[]} Sorted unique custom event names
 */
export function getCustomEvents(scripts = []) {
  const customEvents = new Set();
  for (const script of scripts) {
    for (const action of script.actions ?? []) {
      if (action.type === 'fire_event' && action.event) {
        customEvents.add(action.event);
      }
    }
  }
  return Array.from(customEvents).sort((a, b) => a.localeCompare(b));
}

/**
 * Get action schema by type (alias for getActionSchema)
 */
export function getSchema(type) {
  return ACTION_SCHEMAS[type];
}

/**
 * Validate an action object
 * @param {Object} action - Action to validate
 * @param {Object} context - Validation context
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateAction(action, context = {}) {
  const errors = [];
  const warnings = [];
  const prefix = `Action (${action.type}):`;

  const schema = ACTION_SCHEMAS[action.type];
  if (!schema) {
    errors.push(`${prefix} Unknown action type "${action.type}"`);
    return { errors, warnings };
  }

  // Check required fields
  for (const field of schema.fields) {
    if (field.required && (action[field.name] === undefined || action[field.name] === '')) {
      errors.push(`${prefix} Required field "${field.name}" is missing`);
    }
  }

  // Type-specific validation
  switch (action.type) {
    case 'give_item':
    case 'remove_item':
    case 'spawn_item':
      if (action.item_id && context.items && !context.items.includes(action.item_id)) {
        warnings.push(`${prefix} Item "${action.item_id}" not found in item database`);
      }
      break;
    case 'spawn_monster':
    case 'start_combat':
      if (action.monster && context.monsters && !context.monsters.includes(action.monster)) {
        warnings.push(`${prefix} Monster "${action.monster}" not found in monster list`);
      }
      if (action.enemy_id && context.monsters && !context.monsters.includes(action.enemy_id)) {
        warnings.push(`${prefix} Enemy "${action.enemy_id}" not found in monster list`);
      }
      break;
    case 'spawn_npc':
      if (action.npc && context.npcs && !context.npcs.includes(action.npc)) {
        warnings.push(`${prefix} NPC "${action.npc}" not found in NPC list`);
      }
      break;
    case 'change_map':
      if (action.map_id && context.maps && !context.maps.includes(action.map_id)) {
        warnings.push(`${prefix} Map "${action.map_id}" not found in map list`);
      }
      break;
  }

  return { errors, warnings };
}

/**
 * Load autocomplete options for a field type
 * @param {string} type - Field type (itemSelect, monsterSelect, etc.)
 * @returns {Promise<string[]>}
 */
export async function loadAutocompleteOptions(type) {
  switch (type) {
    case 'itemSelect':
      return getAllItemIds();
    case 'monsterSelect':
      return getAllMonsterTypes();
    case 'npcSelect':
      return getAllNPCTypes();
    case 'mapSelect':
      return getAllMapIds();
    case 'markSelect':
      // Requires map context - return empty for now
      return [];
    case 'autocomplete':
      // Generic - could combine multiple sources
      return [];
    default:
      return [];
  }
}