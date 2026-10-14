/**
 * Panel 3: Script Action Editor
 *
 * Schema-driven form for editing individual actions.
 * Uses actionSchemas.js for field definitions, validation, and autocomplete.
 */

import { scriptState } from './scriptState.js';
import { showJsonModal, createJsonButton, createPanelHeader } from './scriptJsonViewer.js';
import {
  ACTION_SCHEMAS,
  ACTION_CATEGORIES,
  getSchema,
  validateAction,
  loadAutocompleteOptions,
  getAllItemsWithData,
  getAllMonstersWithData
} from './actionSchemas.js';
import { preloadMonsterImages, getCharacterSprite, getMonsterPreviewSprite, drawMonsterPreview, drawCompositeEnemy } from './monsterSprites.js';

// ─── Monster Stats Cache ────────────────────────────────────────────────────────
let monsterDataCache = null;

/**
 * Fetch full monster data from enemies.json
 * @returns {Promise<Array>} Array of monster objects with stats and sprite info
 */
async function loadMonsterData() {
  if (monsterDataCache) return monsterDataCache;
  try {
    const res = await fetch('../characters/enemies.json');
    if (!res.ok) throw new Error('Failed to load enemies.json');
    monsterDataCache = await res.json();
    return monsterDataCache;
  } catch (e) {
    console.warn('[ActionEditor] Failed to load monster data:', e);
    return [];
  }
}

/**
 * Find a monster by name in the loaded data
 * @param {string} name - Monster name to find
 * @returns {Promise<Object|null>} Monster object or null if not found
 */
async function findMonsterByName(name) {
  const data = await loadMonsterData();
  return data.find(m => m.name === name) || null;
}

/**
 * Render monster stats display
 * @param {Object} monster - Monster object from enemies.json
 * @returns {string} HTML for the stats display
 */
function renderMonsterStats(monster) {
  if (!monster) return '';

  const spriteUrl = `../characters/${monster.charName}.png`;
  const charZ = monster.charZ || 1;

  return `
    <div id="monster-stats-display" style="
      margin-top: 12px;
      padding: 12px;
      background: #252526;
      border: 1px solid #333;
      border-radius: 4px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      align-items: flex-start;
    ">
      <!-- Sprite Preview -->
      <div style="
        width: 128px;
        height: 128px;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
        position: relative;
      ">
        <canvas id="monster-sprite-canvas" width="160" height="160" style="
          image-rendering: pixelated;
          image-rendering: crisp-edges;
          width: 128px;
          height: 128px;
          display: block;
        "></canvas>
        <div id="monster-sprite-fallback" style="display: none; align-items: center; justify-content: center; width: 100%; height: 100%; color: #666; font-size: 10px;">No Sprite</div>
        <img id="monster-sprite-img" src="${spriteUrl}" alt="${monster.name}" style="display: none;" data-char-z="${charZ}">
      </div>

      <!-- Stats -->
      <div style="flex: 1; min-width: 200px;">
        <div style="font-weight: 600; font-size: 13px; color: #e0e0e0; margin-bottom: 8px;">${monster.name}</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 6px; font-size: 11px;">
          <div style="color: #aaa;"><span style="color: #e0e0e0;">HP:</span> ${monster.hp ?? '—'}</div>
          <div style="color: #aaa;"><span style="color: #e0e0e0;">Attack:</span> ${monster.attack ?? '—'}</div>
          <div style="color: #aaa;"><span style="color: #e0e0e0;">Defense:</span> ${monster.defense ?? '—'}</div>
          <div style="color: #aaa;"><span style="color: #e0e0e0;">Armor:</span> ${monster.armor ?? '—'}</div>
          <div style="color: #aaa;"><span style="color: #e0e0e0;">Agility:</span> ${monster.agility ?? '—'}</div>
          <div style="color: #aaa;"><span style="color: #e0e0e0;">XP:</span> ${monster.xp ?? '—'}</div>
        </div>
      </div>
    </div>
  `;
}


/**
 * Setup monster select field with stats display
 * @param {HTMLInputElement} input - The monster select input element
 * @param {string} fieldName - The field name
 */
function setupMonsterSelect(input, fieldName) {
  let statsContainer = null;

  // Create or find the stats display container (insert after the input's parent)
  const fieldWrapper = input.closest('.form-field');
  if (fieldWrapper) {
    // Check if stats container already exists
    statsContainer = fieldWrapper.querySelector('#monster-stats-container');
    if (!statsContainer) {
      statsContainer = document.createElement('div');
      statsContainer.id = 'monster-stats-container';
      statsContainer.style.cssText = 'margin-top: 8px;';
      fieldWrapper.appendChild(statsContainer);
    }
  }

  // Function to update stats display
  async function updateStatsDisplay() {
    const monsterName = input.value.trim();
    if (!monsterName || !statsContainer) {
      if (statsContainer) statsContainer.innerHTML = '';
      return;
    }

    const monster = await findMonsterByName(monsterName);
    if (monster) {
      statsContainer.innerHTML = renderMonsterStats(monster);

      // Load and draw sprite frame to canvas using shared module
      const canvas = statsContainer.querySelector('#monster-sprite-canvas');
      const fallback = statsContainer.querySelector('#monster-sprite-fallback');

      if (canvas && monster.charName) {
        // Prevent concurrent draws on the same canvas
        if (canvas._drawing) return;
        canvas._drawing = true;

        try {
          // Preload monster images
          await preloadMonsterImages();
          // Draw composite enemy at 4x scale (128px from 32px base)
          drawCompositeEnemy(canvas.getContext('2d'), monster, 4);
        } catch (e) {
          console.warn('[ActionEditor] Failed to draw monster sprite:', e);
          canvas.style.display = 'none';
          if (fallback) fallback.style.display = 'flex';
        } finally {
          canvas._drawing = false;
        }
      }
    } else {
      statsContainer.innerHTML = `
        <div style="color: #888; font-size: 11px; padding: 8px; background: #1a1a1a; border-radius: 3px;">
          Monster "${monsterName}" not found in enemies.json
        </div>
      `;
    }
  }

  // Listen for changes (change to catch datalist selection, blur as fallback)
  ['change', 'blur'].forEach(eventType => {
    input.addEventListener(eventType, () => {
      // Debounce slightly to avoid excessive fetches
      clearTimeout(input._statsDebounce);
      input._statsDebounce = setTimeout(updateStatsDisplay, 100);
    });
  });
}

/**
 * Create the Action Editor panel
 * @returns {HTMLElement}
 */
export function createScriptActionEditor() {
  const panel = document.createElement('div');
  panel.id = 'script-action-editor';
  panel.className = 'editor-panel';
  panel.style.cssText = `
    display: none;
    flex-direction: column;
    height: 100%;
    background: #1e1e1e;
    color: #e0e0e0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
  `;

  panel.innerHTML = `
    <div id="action-editor-header"></div>
    <div class="panel-content" style="
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    ">
      <form id="action-form"></form>
    </div>
    <div class="panel-footer" style="
      padding: 8px 12px;
      border-top: 1px solid #333;
      background: #252526;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    ">
      <button id="action-cancel-btn" style="
        padding: 6px 16px;
        background: #3a3a3a;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 12px;
      ">Cancel</button>
      <div style="display: flex; gap: 8px;">
        <button id="action-test-btn" title="Test Action" style="
          padding: 6px 16px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
          font-size: 12px;
        ">🧪 Test</button>
        <button id="action-save-btn" type="button" style="
          padding: 6px 16px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        ">Save Action</button>
      </div>
    </div>
  `;

  const headerContainer = panel.querySelector('#action-editor-header');
  const form = panel.querySelector('#action-form');
  const cancelBtn = panel.querySelector('#action-cancel-btn');
  const testBtn = panel.querySelector('#action-test-btn');
  const saveBtn = panel.querySelector('#action-save-btn');

  let currentSchema = null;
  let autocompleteCache = {};

  // --- Build Form ---
  function buildForm() {
    const action = scriptState.currentAction;
    const isNew = scriptState.isNewAction;
    const schema = getSchema(action.type);

    if (!schema) {
      form.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #f88;">
          Unknown action type: ${escapeHtml(action.type)}
        </div>
      `;
      return;
    }

    currentSchema = schema;

    const actions = [
      { label: '← Back to Event', onClick: () => scriptState.popPanel() },
    ];
    if (!isNew) {
      actions.unshift({ label: '🗑 Delete', onClick: deleteAction, danger: true });
    }
    headerContainer.innerHTML = '';
    headerContainer.appendChild(createPanelHeader(
      isNew ? `New Action: ${action.type}` : `Edit Action: ${action.type}`,
      actions
    ));

    form.innerHTML = `
      <div class="form-section" style="margin-bottom: 16px;">
        <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Action Type</h3>
        <div class="form-field">
          <select name="type" id="action-type-select" required style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
            ${buildActionTypeOptions(action.type)}
          </select>
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Changing type will reset action fields</div>
        </div>
      </div>

      <div id="action-fields" class="action-fields"></div>

      ${schema.supportsNested ? buildNestedActionsSection(action) : ''}
    `;

    // Build fields based on schema
    renderFields(schema, action);

    // Add custom tile picker for spawn_monster x,y fields
    addSpawnMonsterTilePicker(action);

    // Attach listeners
    attachFormListeners(action);
  }

  function buildActionTypeOptions(selected) {
    // Group action types by category
    const categories = {};
    for (const [type, schema] of Object.entries(ACTION_SCHEMAS)) {
      const cat = schema.category || 'Other';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ type, label: schema.label, desc: schema.description });
    }

    // Sort categories in the desired order
    const categoryOrder = [
      'Narrative',
      'Environment',
      'Movement',
      'Flags & Variables',
      'Inventory',
      'World',
      'Combat',
      'Scenario'
    ];

    let html = '';
    for (const catName of categoryOrder) {
      const types = categories[catName];
      if (!types || types.length === 0) continue;
      html += `<optgroup label="${catName}">`;
      for (const { type, label, desc } of types) {
        const sel = selected === type ? 'selected' : '';
        html += `<option value="${type}" ${sel}>${label} — ${desc}</option>`;
      }
      html += '</optgroup>';
    }
    // Add any remaining categories not in the order list
    for (const [catName, types] of Object.entries(categories)) {
      if (categoryOrder.includes(catName)) continue;
      html += `<optgroup label="${catName}">`;
      for (const { type, label, desc } of types) {
        const sel = selected === type ? 'selected' : '';
        html += `<option value="${type}" ${sel}>${label} — ${desc}</option>`;
      }
      html += '</optgroup>';
    }
    return html;
  }

  function buildNestedActionsSection(action) {
    // For show_choice and pick_random which have nested actions
    const isChoice = action.type === 'show_choice';
    const isRandom = action.type === 'pick_random';
    const items = action.choices || action.branches || [];
    const itemName = isChoice ? 'choice' : 'branch';

    return `
      <div class="form-section" style="margin-bottom: 16px; margin-top: 16px; padding-top: 16px; border-top: 1px solid #333;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">
            ${isChoice ? 'Choices' : 'Branches'} (nested actions)
          </h3>
          <button type="button" id="add-nested-btn" style="
            padding: 4px 10px;
            font-size: 11px;
            background: #0e639c;
            border: none;
            border-radius: 3px;
            color: white;
            cursor: pointer;
          ">➕ Add ${itemName.charAt(0).toUpperCase() + itemName.slice(1)}</button>
        </div>
        <div id="nested-list" style="min-height: 60px;"></div>
      </div>
    `;
  }

  function renderFields(schema, action) {
    const container = form.querySelector('#action-fields');
    container.innerHTML = '';

    for (const field of schema.fields) {
      const value = action[field.name];
      const fieldEl = createFieldElement(field, value, action);
      container.appendChild(fieldEl);
    }
  }

  // Add tile picker button for spawn_monster x,y fields
  function addSpawnMonsterTilePicker(action) {
    if (action.type !== 'spawn_monster') return;

    const container = form.querySelector('#action-fields');
    const xInput = container.querySelector('input[name="x"]');
    const yInput = container.querySelector('input[name="y"]');
    if (!xInput || !yInput) return;

    // Find the x field wrapper (parent of the x input)
    const xWrapper = xInput.closest('.form-field');
    if (!xWrapper) return;

    // Add a tile picker button after the x field
    const pickerBtn = document.createElement('button');
    pickerBtn.type = 'button';
    pickerBtn.className = 'tile-picker-btn';
    pickerBtn.textContent = '📍 Pick Tile';
    pickerBtn.style.cssText = `
      margin-top: 8px;
      padding: 6px 10px;
      font-size: 11px;
      background: #3a3a3a;
      border: 1px solid #444;
      border-radius: 3px;
      color: #e0e0e0;
      cursor: pointer;
    `;

    pickerBtn.addEventListener('click', () => openSpawnMonsterTilePicker(xInput, yInput));

    // Insert after the x field wrapper
    xWrapper.parentNode.insertBefore(pickerBtn, xWrapper.nextSibling);
  }

  function openSpawnMonsterTilePicker(xInput, yInput) {
    const currentMap = window.editor?.currentMap;
    if (!currentMap || !currentMap.width) {
      alert('No map loaded for tile picking.');
      return;
    }

    const canvas = document.getElementById('mapCanvas');
    if (!canvas) {
      alert('Map canvas not found.');
      return;
    }

    enterSpawnMonsterPickMode(xInput, yInput, canvas);
  }

  let spawnMonsterPickMode = false;
  let spawnMonsterPickInputs = null;

  function enterSpawnMonsterPickMode(xInput, yInput, canvas) {
    spawnMonsterPickMode = true;
    spawnMonsterPickInputs = { xInput, yInput };

    const btn = form.querySelector('.tile-picker-btn');
    if (btn) {
      btn.textContent = '✕ Cancel';
      btn.style.background = '#cc4444';
    }

    canvas.style.cursor = 'crosshair';
    canvas.classList.add('tile-picking');
    canvas.addEventListener('click', onSpawnMonsterMapClick);

    showPickHint('Click on the map to pick spawn coordinates. Click "Cancel" to exit.');
  }

  function exitSpawnMonsterPickMode() {
    spawnMonsterPickMode = false;
    spawnMonsterPickInputs = null;

    const btn = form.querySelector('.tile-picker-btn');
    const canvas = document.getElementById('mapCanvas');
    if (btn) {
      btn.textContent = '📍 Pick Tile';
      btn.style.background = '';
    }
    if (canvas) {
      canvas.style.cursor = '';
      canvas.classList.remove('tile-picking');
      canvas.removeEventListener('click', onSpawnMonsterMapClick);
    }
    hidePickHint();
  }

  function onSpawnMonsterMapClick(e) {
    if (!spawnMonsterPickMode || !spawnMonsterPickInputs) return;

    const canvas = document.getElementById('mapCanvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Convert to world coordinates (accounting for pan/zoom)
    const editorZoom = window.editor?.zoom ?? 1;
    const editorTile = window.editor?.TILE ?? 32;
    const worldX = (clientX * scaleX) / editorZoom;
    const worldY = (clientY * scaleY) / editorZoom;

    // Convert to tile coordinates
    const tileX = Math.floor(worldX / editorTile);
    const tileY = Math.floor(worldY / editorTile);

    // Validate bounds
    const currentMap = window.editor?.currentMap;
    if (!currentMap || tileX < 0 || tileY < 0 || tileX >= currentMap.width || tileY >= currentMap.height) {
      return; // Out of bounds
    }

    // Fill in the inputs
    spawnMonsterPickInputs.xInput.value = tileX;
    spawnMonsterPickInputs.yInput.value = tileY;

    // Exit picking mode
    exitSpawnMonsterPickMode();
  }

  function createFieldElement(field, value, action) {
    const wrapper = document.createElement('div');
    wrapper.className = 'form-field';
    wrapper.style.marginBottom = '12px';
    wrapper.dataset.fieldName = field.name;

    const required = field.required ? '<span style="color: #f88;">*</span>' : '';
    const hint = field.hint ? `<div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">${field.hint}</div>` : '';

    let inputHtml = '';
    const inputId = `field-${field.name}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    switch (field.type) {
      case 'select':
        inputHtml = `
          <select name="${field.name}" id="${inputId}" ${field.required ? 'required' : ''} style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
            ${field.options.map(opt => {
              const sel = value === opt.value ? 'selected' : '';
              return `<option value="${escapeHtml(opt.value)}" ${sel}>${escapeHtml(opt.label)}</option>`;
            }).join('')}
          </select>
        `;
        break;

      case 'autocomplete':
        inputHtml = `
          <input type="text" name="${field.name}" id="${inputId}" list="${inputId}-list" value="${escapeHtml(value ?? '')}" ${field.required ? 'required' : ''} style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <datalist id="${inputId}-list"></datalist>
        `;
        break;

      case 'itemSelect':
      case 'monsterSelect':
        // Custom dropdown with thumbnails - no native datalist
        inputHtml = `
          <input type="text" name="${field.name}" id="${inputId}" value="${escapeHtml(value ?? '')}" ${field.required ? 'required' : ''} autocomplete="off" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
        `;
        break;

      case 'npcSelect':
      case 'mapSelect':
      case 'markSelect':
        inputHtml = `
          <input type="text" name="${field.name}" id="${inputId}" list="${inputId}-list" value="${escapeHtml(value ?? '')}" ${field.required ? 'required' : ''} style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <datalist id="${inputId}-list"></datalist>
        `;
        break;

      case 'tilePicker':
        inputHtml = `
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 80px;">
              <span style="font-size: 11px; color: #888;">x:</span>
              <input type="number" name="${field.name}_x" value="${value?.x ?? ''}" placeholder="x" style="
                width: 60px;
                padding: 4px 8px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 80px;">
              <span style="font-size: 11px; color: #888;">y:</span>
              <input type="number" name="${field.name}_y" value="${value?.y ?? ''}" placeholder="y" style="
                width: 60px;
                padding: 4px 8px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <button type="button" class="tile-picker-btn" data-field="${field.name}" style="
              padding: 6px 10px;
              font-size: 11px;
              background: #3a3a3a;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              cursor: pointer;
              align-self: flex-end;
            ">📍 Pick Tile</button>
          </div>
        `;
        break;

      case 'positionPicker':
        // positionPicker: [x][y][mark][pick] in one line, prefers mark if tile has one
        inputHtml = `
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: nowrap;">
            <div style="display: flex; align-items: center; gap: 2px;">
              <span style="font-size: 10px; color: #888;">x:</span>
              <input type="number" name="${field.name}_x" value="${value?.x ?? ''}" placeholder="x" style="
                width: 50px;
                padding: 4px 6px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <div style="display: flex; align-items: center; gap: 2px;">
              <span style="font-size: 10px; color: #888;">y:</span>
              <input type="number" name="${field.name}_y" value="${value?.y ?? ''}" placeholder="y" style="
                width: 50px;
                padding: 4px 6px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <div style="display: flex; align-items: center; gap: 2px;">
              <span style="font-size: 10px; color: #888;">mark:</span>
              <input type="text" name="${field.name}_mark" value="${escapeHtml(value?.mark ?? '')}" placeholder="mark name" style="
                width: 140px;
                padding: 4px 8px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <button type="button" class="position-picker-btn" data-field="${field.name}" style="
              padding: 4px 10px;
              font-size: 11px;
              background: #3a3a3a;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              cursor: pointer;
              white-space: nowrap;
            ">📍 Pick</button>
          </div>
        `;
        break;

      case 'keyValue':
        // Check if this is an itemQty dictionary (multiple items with quantities)
        if (field.valueType === 'itemQty') {
          // value is an object like { "item_id1": qty1, "item_id2": qty2 }
          const entries = value && typeof value === 'object' ? Object.entries(value) : [];
          inputHtml = `
            <div class="item-qty-dict" data-field="${field.name}">
              <div class="item-qty-entries" style="display: flex; flex-direction: column; gap: 6px;">
                ${entries.length > 0 ? entries.map(([key, val], idx) => `
                  <div class="item-qty-entry" style="display: flex; gap: 8px; align-items: center;">
                    <div style="flex: 1;">
                      <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Item</label>
                      <input type="text" name="${field.name}_key_${idx}" value="${escapeHtml(key)}" class="item-autocomplete" autocomplete="off" style="
                        width: 100%;
                        padding: 6px 10px;
                        background: #3c3c3c;
                        border: 1px solid #444;
                        border-radius: 3px;
                        color: #e0e0e0;
                        font-size: 12px;
                        box-sizing: border-box;
                      ">
                    </div>
                    <div style="width: 80px;">
                      <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Qty</label>
                      <input type="number" name="${field.name}_value_${idx}" value="${escapeHtml(String(val))}" min="1" style="
                        width: 100%;
                        padding: 6px 10px;
                        background: #3c3c3c;
                        border: 1px solid #444;
                        border-radius: 3px;
                        color: #e0e0e0;
                        font-size: 12px;
                        box-sizing: border-box;
                      ">
                    </div>
                    <button type="button" class="remove-item-btn" data-idx="${idx}" style="
                      padding: 6px 10px;
                      background: #803030;
                      border: none;
                      border-radius: 3px;
                      color: #fff;
                      font-size: 11px;
                      cursor: pointer;
                      align-self: flex-end;
                    ">Remove</button>
                  </div>
                `).join('') : `
                  <div class="item-qty-entry" style="display: flex; gap: 8px; align-items: center;">
                    <div style="flex: 1;">
                      <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Item</label>
                      <input type="text" name="${field.name}_key_0" value="" class="item-autocomplete" autocomplete="off" style="
                        width: 100%;
                        padding: 6px 10px;
                        background: #3c3c3c;
                        border: 1px solid #444;
                        border-radius: 3px;
                        color: #e0e0e0;
                        font-size: 12px;
                        box-sizing: border-box;
                      ">
                      </div>
                    <div style="width: 80px;">
                      <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Qty</label>
                      <input type="number" name="${field.name}_value_0" value="1" min="1" style="
                        width: 100%;
                        padding: 6px 10px;
                        background: #3c3c3c;
                        border: 1px solid #444;
                        border-radius: 3px;
                        color: #e0e0e0;
                        font-size: 12px;
                        box-sizing: border-box;
                      ">
                    </div>
                    <button type="button" class="remove-item-btn" data-idx="0" style="
                      padding: 6px 10px;
                      background: #803030;
                      border: none;
                      border-radius: 3px;
                      color: #fff;
                      font-size: 11px;
                      cursor: pointer;
                      align-self: flex-end;
                    ">Remove</button>
                  </div>
                `}
              </div>
              <button type="button" class="add-item-btn" data-field="${field.name}" style="
                margin-top: 8px;
                padding: 6px 12px;
                background: #3a3a3a;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 11px;
                cursor: pointer;
              ">+ Add Item</button>
            </div>
          `;
        } else {
          // Original single key-value pair
          inputHtml = `
            <div style="display: flex; gap: 8px;">
              <div style="flex: 1;">
                <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Key</label>
                <input type="text" name="${field.name}_key" value="${escapeHtml(value?.key ?? '')}" style="
                  width: 100%;
                  padding: 6px 10px;
                  background: #3c3c3c;
                  border: 1px solid #444;
                  border-radius: 3px;
                  color: #e0e0e0;
                  font-size: 12px;
                  box-sizing: border-box;
                ">
              </div>
              <div style="flex: 1;">
                <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Value</label>
                <input type="text" name="${field.name}_value" value="${escapeHtml(value?.value ?? '')}" style="
                  width: 100%;
                  padding: 6px 10px;
                  background: #3c3c3c;
                  border: 1px solid #444;
                  border-radius: 3px;
                  color: #e0e0e0;
                  font-size: 12px;
                  box-sizing: border-box;
                ">
              </div>
            </div>
          `;
        }
        break;

      case 'json':
        inputHtml = `
          <textarea name="${field.name}" id="${inputId}" rows="4" placeholder="JSON object" style="
            width: 100%;
            padding: 8px 10px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 11px;
            font-family: 'Consolas', 'Monaco', monospace;
            line-height: 1.5;
            box-sizing: border-box;
            resize: vertical;
          ">${escapeHtml(value ? JSON.stringify(value, null, 2) : '')}</textarea>
        `;
        break;

      case 'textarea':
        inputHtml = `
          <textarea name="${field.name}" id="${inputId}" rows="${field.rows || 3}" placeholder="${escapeHtml(field.placeholder || '')}" style="
            width: 100%;
            padding: 8px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            font-family: inherit;
            line-height: 1.5;
            box-sizing: border-box;
            resize: vertical;
          ">${escapeHtml(value ?? '')}</textarea>
        `;
        break;

      case 'number':
        inputHtml = `
          <input type="number" name="${field.name}" id="${inputId}" value="${value ?? ''}" ${field.required ? 'required' : ''} ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step ? `step="${field.step}"` : ''} style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
        `;
        break;

      case 'checkbox':
        inputHtml = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" name="${field.name}" id="${inputId}" ${value ? 'checked' : ''} style="
              width: 16px;
              height: 16px;
              accent-color: #0e639c;
            ">
            <label for="${inputId}" style="font-size: 12px; color: #ccc; cursor: pointer;">${field.label || 'Enabled'}</label>
          </div>
        `;
        break;

      default:
        inputHtml = `
          <input type="text" name="${field.name}" id="${inputId}" value="${escapeHtml(value ?? '')}" ${field.required ? 'required' : ''} style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
        `;
    }

    wrapper.innerHTML = `
      <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">${escapeHtml(field.label)}${required}</label>
      ${inputHtml}
      ${hint}
    `;

    // Setup autocomplete if needed
    if (['autocomplete', 'itemSelect', 'monsterSelect', 'npcSelect', 'mapSelect', 'markSelect'].includes(field.type)) {
      const input = wrapper.querySelector(`#${inputId}`);
      const datalist = wrapper.querySelector(`#${inputId}-list`);
      setupAutocomplete(input, datalist, field.type);

      // Special handling for monsterSelect: add stats display
      if (field.type === 'monsterSelect') {
        setupMonsterSelect(input, field.name);
      }
    }

    // Setup autocomplete for itemQtyDict fields (item-autocomplete class)
    if (field.valueType === 'itemQty') {
      const inputs = wrapper.querySelectorAll('.item-autocomplete');
      inputs.forEach(input => {
        setupAutocomplete(input, null, 'itemSelect');
      });
    }

    return wrapper;
  }

  // --- ItemQtyDict Helpers ---
  function addItemQtyEntry(fieldName) {
    const container = form.querySelector(`.item-qty-dict[data-field="${fieldName}"] .item-qty-entries`);
    if (!container) return;

    const entryCount = container.querySelectorAll('.item-qty-entry').length;
    const newIdx = entryCount;

    const inputId = `${fieldName}-items`; // Same datalist ID for all entries

    const entryHtml = `
      <div class="item-qty-entry" style="display: flex; gap: 8px; align-items: center;">
        <div style="flex: 1;">
          <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Item</label>
          <input type="text" name="${fieldName}_key_${newIdx}" value="" class="item-autocomplete" autocomplete="off" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
        </div>
        <div style="width: 80px;">
          <label style="display: block; font-size: 10px; color: #888; margin-bottom: 2px;">Qty</label>
          <input type="number" name="${fieldName}_value_${newIdx}" value="1" min="1" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
        </div>
        <button type="button" class="remove-item-btn" data-field="${fieldName}" data-idx="${newIdx}" style="
          padding: 6px 10px;
          background: #803030;
          border: none;
          border-radius: 3px;
          color: #fff;
          font-size: 11px;
          cursor: pointer;
          align-self: flex-end;
        ">Remove</button>
      </div>
    `;

    container.insertAdjacentHTML('beforeend', entryHtml);

    // Setup autocomplete for the new input
    const newInput = container.querySelector(`[name="${fieldName}_key_${newIdx}"]`);
    if (newInput) {
      setupAutocomplete(newInput, null, 'itemSelect');
    }

    // Add remove listener for the new button
    const newRemoveBtn = container.querySelector(`.remove-item-btn[data-field="${fieldName}"][data-idx="${newIdx}"]`);
    if (newRemoveBtn) {
      newRemoveBtn.addEventListener('click', () => removeItemQtyEntry(fieldName, newIdx));
    }

    // Re-index all remove buttons (since indices may have shifted)
    reindexItemQtyEntries(fieldName);
  }

  function removeItemQtyEntry(fieldName, idx) {
    const container = form.querySelector(`.item-qty-dict[data-field="${fieldName}"] .item-qty-entries`);
    if (!container) return;

    const entries = container.querySelectorAll('.item-qty-entry');
    if (entries[idx]) {
      entries[idx].remove();
    }

    // Re-index remaining entries
    reindexItemQtyEntries(fieldName);
  }

  function reindexItemQtyEntries(fieldName) {
    const container = form.querySelector(`.item-qty-dict[data-field="${fieldName}"] .item-qty-entries`);
    if (!container) return;

    const entries = container.querySelectorAll('.item-qty-entry');
    entries.forEach((entry, newIdx) => {
      // Update input names
      const keyInput = entry.querySelector('input[name$="_key_"]');
      const valueInput = entry.querySelector('input[name$="_value_"]');
      const removeBtn = entry.querySelector('.remove-item-btn');

      if (keyInput) keyInput.name = `${fieldName}_key_${newIdx}`;
      if (valueInput) valueInput.name = `${fieldName}_value_${newIdx}`;
      if (removeBtn) {
        removeBtn.dataset.idx = newIdx;
        // Update event listener
        removeBtn.onclick = null;
        removeBtn.addEventListener('click', () => removeItemQtyEntry(fieldName, newIdx));
      }
    });
  }

  function setupAutocomplete(input, datalist, type) {
    // For itemSelect and monsterSelect, use custom dropdown with thumbnails
    if (type === 'itemSelect' || type === 'monsterSelect') {
      setupCustomDropdown(input, type);
      return;
    }

    input.addEventListener('focus', async () => {
      if (autocompleteCache[type]) {
        datalist.innerHTML = autocompleteCache[type].map(opt => `<option value="${escapeHtml(opt)}">`).join('');
        return;
      }

      try {
        const options = await loadAutocompleteOptions(type);
        autocompleteCache[type] = options;
        datalist.innerHTML = options.map(opt => `<option value="${escapeHtml(opt)}">`).join('');
      } catch (e) {
        console.warn(`[ActionEditor] Failed to load autocomplete for ${type}:`, e);
      }
    });
  }

  // --- Custom Dropdown with Thumbnails ---
  let itemDataCache = null;
  let monsterDataCache = null;
  let customDropdown = null; // Currently open dropdown

  // Image caches (for items only - monsters use shared module)
  let itemsImg = null;           // items.png
  let craftingImg = null;        // crafting.png

  /**
   * Preload item images
   */
  async function preloadItemImages() {
    const promises = [];

    if (!itemsImg) {
      itemsImg = new Image();
      itemsImg.src = '../assets/items.png';
      promises.push(new Promise(resolve => { itemsImg.onload = itemsImg.onerror = resolve; }));
    }

    if (!craftingImg) {
      craftingImg = new Image();
      craftingImg.src = '../assets/crafting.png';
      promises.push(new Promise(resolve => { craftingImg.onload = craftingImg.onerror = resolve; }));
    }

    await Promise.all(promises);
  }

  /**
   * Setup custom dropdown with thumbnails for itemSelect/monsterSelect
   */
  function setupCustomDropdown(input, type) {
    // Create dropdown container if it doesn't exist
    if (!customDropdown) {
      customDropdown = document.createElement('div');
      customDropdown.className = 'eca-custom-dropdown';
      customDropdown.style.cssText = `
        position: absolute;
        z-index: 10000;
        background: #1e1e1e;
        border: 1px solid #3a3a3a;
        border-radius: 4px;
        max-height: 300px;
        overflow-y: auto;
        min-width: 200px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        display: none;
        font-size: 12px;
      `;
      document.body.appendChild(customDropdown);
    }

    let debounceTimer = null;

    const showDropdown = async () => {
      // Preload images on first show
      await preloadItemImages();
      // Preload monster images if needed
      if (type === 'monsterSelect') {
        await preloadMonsterImages();
      }

      // Load data if not cached
      let data;
      if (type === 'itemSelect') {
        if (!itemDataCache) {
          itemDataCache = await getAllItemsWithData();
        }
        data = itemDataCache;
      } else if (type === 'monsterSelect') {
        if (!monsterDataCache) {
          monsterDataCache = await getAllMonstersWithData();
        }
        data = monsterDataCache;
      }

      if (!data || data.length === 0) return;

      // Filter based on input value
      const filter = input.value.toLowerCase();
      const filtered = data.filter(item => {
        const name = type === 'itemSelect' ? item.id : item.name;
        return name.toLowerCase().includes(filter);
      });

      // Render dropdown items
      customDropdown.innerHTML = '';
      filtered.slice(0, 50).forEach(item => {
        const name = type === 'itemSelect' ? item.id : item.name;
        const itemEl = document.createElement('div');
        itemEl.className = 'eca-dropdown-item';
        itemEl.style.cssText = `
          display: flex;
          align-items: center;
          padding: 6px 10px;
          cursor: pointer;
          gap: 8px;
          white-space: nowrap;
        `;
        itemEl.dataset.value = name;

        // Create thumbnail canvas
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 32;
        thumbCanvas.height = 32;
        thumbCanvas.style.cssText = `
          width: 32px;
          height: 32px;
          image-rendering: pixelated;
          border: 1px solid #333;
          flex-shrink: 0;
        `;
        itemEl.appendChild(thumbCanvas);

        // Draw thumbnail
        drawThumbnail(thumbCanvas, item, type);

        // Name text
        const nameEl = document.createElement('span');
        nameEl.textContent = name;
        nameEl.style.cssText = 'color: #e0e0e0; overflow: hidden; text-overflow: ellipsis;';
        itemEl.appendChild(nameEl);

        itemEl.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = name;
          // Set flag to prevent dropdown from re-showing due to input event
          input._skipDropdownShow = true;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // Clear flag after a short delay
          setTimeout(() => { input._skipDropdownShow = false; }, 100);
          hideDropdown();
        });

        itemEl.addEventListener('mouseenter', () => {
          itemEl.style.background = '#0e639c';
        });
        itemEl.addEventListener('mouseleave', () => {
          itemEl.style.background = 'transparent';
        });

        customDropdown.appendChild(itemEl);
      });

      // Position dropdown below input
      const rect = input.getBoundingClientRect();
      customDropdown.style.left = rect.left + 'px';
      customDropdown.style.top = (rect.bottom + 2) + 'px';
      customDropdown.style.minWidth = rect.width + 'px';
      customDropdown.style.display = 'block';
    };

    const hideDropdown = () => {
      if (customDropdown) {
        customDropdown.style.display = 'none';
      }
    };

    // Show on focus
    input.addEventListener('focus', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(showDropdown, 50);
    });

    // Filter on input
    input.addEventListener('input', () => {
      // Skip if we just selected from dropdown
      if (input._skipDropdownShow) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(showDropdown, 50);
    });

    // Hide on blur (with delay to allow click)
    input.addEventListener('blur', () => {
      setTimeout(hideDropdown, 150);
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
      if (customDropdown.style.display !== 'block') return;

      const items = customDropdown.querySelectorAll('.eca-dropdown-item');
      if (items.length === 0) return;

      let selected = customDropdown.querySelector('.eca-dropdown-item.selected');
      let index = selected ? Array.from(items).indexOf(selected) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        index = Math.min(index + 1, items.length - 1);
        updateSelection(items, index);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        index = Math.max(index - 1, 0);
        updateSelection(items, index);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selected) {
          input.value = selected.dataset.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          hideDropdown();
        }
      } else if (e.key === 'Escape') {
        hideDropdown();
      }
    });

    function updateSelection(items, index) {
      items.forEach((el, i) => {
        el.classList.toggle('selected', i === index);
        el.style.background = i === index ? '#0e639c' : 'transparent';
      });
      // Scroll into view
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Draw thumbnail for item or monster on canvas
   */
  function drawThumbnail(canvas, item, type) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 32, 32);

    if (type === 'itemSelect') {
      // Draw item from items.png or crafting.png spritesheet
      const icon = item.icon;
      if (!icon || !Array.isArray(icon)) return;

      const [col, row] = icon;
      // Determine which spritesheet to use based on source
      const img = item.source === 'crafting' ? craftingImg : itemsImg;
      if (img && img.complete) {
        ctx.drawImage(img, col * 32, row * 32, 32, 32, 0, 0, 32, 32);
      } else if (img) {
        img.onload = () => {
          ctx.drawImage(img, col * 32, row * 32, 32, 32, 0, 0, 32, 32);
        };
      }
    } else if (type === 'monsterSelect') {
      // Draw composite monster using shared module
      drawCompositeEnemy(ctx, item, 1);
    }
  }

  // --- Attach Listeners ---
  function attachFormListeners(action) {
    // Type change
    form.querySelector('#action-type-select').addEventListener('change', (e) => {
      const newType = e.target.value;
      if (newType !== action.type) {
        action.type = newType;
        buildForm(); // Rebuild entire form
      }
    });

    // Tile pickers
    form.querySelectorAll('.tile-picker-btn').forEach(btn => {
      btn.addEventListener('click', () => openTilePicker(btn.dataset.field));
    });

    // Position pickers (x, y, mark with tile pick)
    form.querySelectorAll('.position-picker-btn').forEach(btn => {
      btn.addEventListener('click', () => openPositionPicker(btn.dataset.field));
    });

    // ItemQtyDict (give/show fields) - Add Item button
    form.querySelectorAll('.add-item-btn').forEach(btn => {
      btn.addEventListener('click', () => addItemQtyEntry(btn.dataset.field));
    });

    // ItemQtyDict - Remove buttons
    form.querySelectorAll('.remove-item-btn').forEach(btn => {
      btn.addEventListener('click', () => removeItemQtyEntry(btn.dataset.field, parseInt(btn.dataset.idx, 10)));
    });

    // Nested actions
    const addNestedBtn = form.querySelector('#add-nested-btn');
    if (addNestedBtn) {
      addNestedBtn.addEventListener('click', () => addNestedAction(action));
    }

    renderNestedActions(action);

    // Cancel
    cancelBtn.addEventListener('click', () => scriptState.popPanel());

    // Test
    testBtn.addEventListener('click', () => testAction(action));

    // Save
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveAction(action);
    });
  }

  // --- Nested Actions (for show_choice / pick_random) ---
  function renderNestedActions(action) {
    const container = form.querySelector('#nested-list');
    if (!container) return;

    const isChoice = action.type === 'show_choice';
    const isRandom = action.type === 'pick_random';
    const items = isChoice ? (action.choices || []) : (action.branches || []);
    const itemName = isChoice ? 'choice' : 'branch';

    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div style="padding: 16px; text-align: center; color: #666; font-style: italic;">
          No ${itemName}s yet. Click "Add ${itemName.charAt(0).toUpperCase() + itemName.slice(1)}" to add one.
        </div>
      `;
      return;
    }

    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; margin: 0; padding: 0;';

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.style.cssText = `
        display: flex;
        align-items: center;
        padding: 8px 10px;
        margin: 2px 0;
        background: #2d2d2d;
        border: 1px solid #3a3a3a;
        border-radius: 4px;
        gap: 8px;
      `;

      const label = isChoice ? (item.text || item.label || `Choice ${index + 1}`) : (item.label || `Branch ${index + 1}`);
      const actionCount = item.actions?.length ?? 0;
      const weight = item.weight !== undefined ? ` (weight: ${item.weight})` : '';

      li.innerHTML = `
        <div class="nested-info" style="flex: 1; min-width: 0;">
          <div style="font-weight: 500;">${escapeHtml(label)}${weight}</div>
          <div style="font-size: 11px; color: #888;">${actionCount} action(s)</div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="nested-edit-btn" data-index="${index}" title="Edit Actions" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #0e639c;
            border: none;
            border-radius: 3px;
            color: white;
            cursor: pointer;
          ">✎ Actions</button>
          <button class="nested-up-btn" data-index="${index}" ${index === 0 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === 0 ? '#555' : '#e0e0e0'};
            cursor: ${index === 0 ? 'not-allowed' : 'pointer'};
          ">▲</button>
          <button class="nested-down-btn" data-index="${index}" ${index === items.length - 1 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === items.length - 1 ? '#555' : '#e0e0e0'};
            cursor: ${index === items.length - 1 ? 'not-allowed' : 'pointer'};
          ">▼</button>
          <button class="nested-delete-btn" data-index="${index}" title="Delete" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
          ">🗑</button>
        </div>
      `;

      li.querySelector('.nested-edit-btn').addEventListener('click', () => {
        // Navigate to nested action editor for this choice/branch
        scriptState.goToNestedActionEditor(index, isChoice ? 'choices' : 'branches', index);
      });

      li.querySelector('.nested-up-btn').addEventListener('click', () => {
        moveNestedAction(action, index, index - 1);
      });

      li.querySelector('.nested-down-btn').addEventListener('click', () => {
        moveNestedAction(action, index, index + 1);
      });

      li.querySelector('.nested-delete-btn').addEventListener('click', () => {
        if (confirm(`Delete this ${itemName}?`)) {
          items.splice(index, 1);
          renderNestedActions(action);
        }
      });

      list.appendChild(li);
    });

    container.appendChild(list);
  }

  function moveNestedAction(action, fromIndex, toIndex) {
    const isChoice = action.type === 'show_choice';
    const items = isChoice ? action.choices : action.branches;
    const [item] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, item);
    renderNestedActions(action);
  }

  function addNestedAction(action) {
    const isChoice = action.type === 'show_choice';
    const items = isChoice ? (action.choices = action.choices || []) : (action.branches = action.branches || []);
    const newItem = isChoice
      ? { text: `Choice ${items.length + 1}`, actions: [] }
      : { label: `Branch ${items.length + 1}`, weight: 1, actions: [] };
    items.push(newItem);
    renderNestedActions(action);
  }

  // --- Tile Picker (Map Click Mode) ---
  let tilePickMode = false;
  let tilePickTargetField = null; // field name for action editor

  function openTilePicker(fieldName) {
    const currentMap = window.editor?.currentMap;
    if (!currentMap || !currentMap.width) {
      alert('No map loaded for tile picking.');
      return;
    }

    const btn = form.querySelector(`.tile-picker-btn[data-field="${fieldName}"]`);
    const canvas = document.getElementById('mapCanvas');
    if (!canvas) {
      alert('Map canvas not found.');
      return;
    }

    if (tilePickMode && tilePickTargetField === fieldName) {
      // Exit picking mode for this field
      exitTilePickMode(btn, canvas);
    } else if (tilePickMode) {
      // Switch to this field
      tilePickTargetField = fieldName;
      // Update button text to show current field
      btn.textContent = '✕ Cancel';
      btn.style.background = '#cc4444';
      showPickHint(`Click on the map to pick tile coordinates for ${fieldName}. Click "Cancel" to exit.`);
    } else {
      // Enter picking mode
      enterTilePickMode(btn, canvas, fieldName);
    }
  }

  function enterTilePickMode(btn, canvas, fieldName) {
    tilePickMode = true;
    tilePickTargetField = fieldName;
    btn.textContent = '✕ Cancel';
    btn.style.background = '#cc4444';
    canvas.style.cursor = 'crosshair';
    canvas.classList.add('tile-picking');

    // Add click handler to map canvas
    canvas.addEventListener('click', onMapTileClick);

    // Show temporary instruction
    showPickHint(`Click on the map to pick tile coordinates for ${fieldName}. Click "Cancel" to exit.`);
  }

  function exitTilePickMode(btn, canvas) {
    tilePickMode = false;
    tilePickTargetField = null;
    if (btn) {
      btn.textContent = '📍 Pick';
      btn.style.background = '';
    }
    canvas.style.cursor = '';
    canvas.classList.remove('tile-picking');
    canvas.removeEventListener('click', onMapTileClick);
    hidePickHint();
  }

  function onMapTileClick(e) {
    if (!tilePickMode || !tilePickTargetField) return;

    const canvas = document.getElementById('mapCanvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Convert to world coordinates (accounting for pan/zoom)
    const editorZoom = window.editor?.zoom ?? 1;
    const editorTile = window.editor?.TILE ?? 32;
    const worldX = (clientX * scaleX) / editorZoom;
    const worldY = (clientY * scaleY) / editorZoom;

    // Convert to tile coordinates
    const tileX = Math.floor(worldX / editorTile);
    const tileY = Math.floor(worldY / editorTile);

    // Validate bounds
    const currentMap = window.editor?.currentMap;
    if (!currentMap || tileX < 0 || tileY < 0 || tileX >= currentMap.width || tileY >= currentMap.height) {
      return; // Out of bounds
    }

    // Fill in the inputs
    form.querySelector(`[name="${tilePickTargetField}_x"]`).value = tileX;
    form.querySelector(`[name="${tilePickTargetField}_y"]`).value = tileY;

    // Exit picking mode
    const btn = form.querySelector(`.tile-picker-btn[data-field="${tilePickTargetField}"]`);
    const canvasEl = document.getElementById('mapCanvas');
    exitTilePickMode(btn, canvasEl);
  }

  // --- Position Picker (Map Click Mode with Mark Support) ---
  let positionPickMode = false;
  let positionPickTargetField = null;

  function openPositionPicker(fieldName) {
    const currentMap = window.editor?.currentMap;
    if (!currentMap || !currentMap.width) {
      alert('No map loaded for tile picking.');
      return;
    }

    const btn = form.querySelector(`.position-picker-btn[data-field="${fieldName}"]`);
    const canvas = document.getElementById('mapCanvas');
    if (!canvas) {
      alert('Map canvas not found.');
      return;
    }

    if (positionPickMode && positionPickTargetField === fieldName) {
      exitPositionPickMode(btn, canvas);
    } else if (positionPickMode) {
      positionPickTargetField = fieldName;
      btn.textContent = '✕ Cancel';
      btn.style.background = '#cc4444';
      showPickHint(`Click on the map to pick position for ${fieldName}. Marked tiles will use their mark name. Click "Cancel" to exit.`);
    } else {
      enterPositionPickMode(btn, canvas, fieldName);
    }
  }

  function enterPositionPickMode(btn, canvas, fieldName) {
    positionPickMode = true;
    positionPickTargetField = fieldName;
    btn.textContent = '✕ Cancel';
    btn.style.background = '#cc4444';
    canvas.style.cursor = 'crosshair';
    canvas.classList.add('tile-picking');

    canvas.addEventListener('click', onPositionMapClick);

    showPickHint(`Click on the map to pick position for ${fieldName}. Marked tiles will use their mark name. Click "Cancel" to exit.`);
  }

  function exitPositionPickMode(btn, canvas) {
    positionPickMode = false;
    positionPickTargetField = null;
    if (btn) {
      btn.textContent = '📍 Pick';
      btn.style.background = '';
    }
    canvas.style.cursor = '';
    canvas.classList.remove('tile-picking');
    canvas.removeEventListener('click', onPositionMapClick);
    hidePickHint();
  }

  function onPositionMapClick(e) {
    if (!positionPickMode || !positionPickTargetField) return;

    const canvas = document.getElementById('mapCanvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const editorZoom = window.editor?.zoom ?? 1;
    const editorTile = window.editor?.TILE ?? 32;
    const worldX = (clientX * scaleX) / editorZoom;
    const worldY = (clientY * scaleY) / editorZoom;

    const tileX = Math.floor(worldX / editorTile);
    const tileY = Math.floor(worldY / editorTile);

    const currentMap = window.editor?.currentMap;
    if (!currentMap || tileX < 0 || tileY < 0 || tileX >= currentMap.width || tileY >= currentMap.height) {
      return;
    }

    // Check if this tile has a mark
    const markKey = `${tileX},${tileY}`;
    const markName = currentMap._marks?.[markKey];

    // Fill in the inputs - prefer mark if available
    if (markName) {
      form.querySelector(`[name="${positionPickTargetField}_mark"]`).value = markName;
      form.querySelector(`[name="${positionPickTargetField}_x"]`).value = '';
      form.querySelector(`[name="${positionPickTargetField}_y"]`).value = '';
    } else {
      form.querySelector(`[name="${positionPickTargetField}_x"]`).value = tileX;
      form.querySelector(`[name="${positionPickTargetField}_y"]`).value = tileY;
      form.querySelector(`[name="${positionPickTargetField}_mark"]`).value = '';
    }

    const btn = form.querySelector(`.position-picker-btn[data-field="${positionPickTargetField}"]`);
    const canvasEl = document.getElementById('mapCanvas');
    exitPositionPickMode(btn, canvasEl);
  }

  function showPickHint(message) {
    hidePickHint();
    const hint = document.createElement('div');
    hint.id = 'tile-pick-hint';
    hint.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #0e639c;
      color: white;
      padding: 10px 20px;
      border-radius: 4px;
      font-size: 13px;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      animation: slideUp 0.2s ease;
    `;
    hint.textContent = message;
    document.body.appendChild(hint);

    // Add animation style
    if (!document.getElementById('tile-pick-style')) {
      const style = document.createElement('style');
      style.id = 'tile-pick-style';
      style.textContent = `
        @keyframes slideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  function hidePickHint() {
    const hint = document.getElementById('tile-pick-hint');
    if (hint) hint.remove();
  }

  // --- Test Action ---
  function testAction(action) {
    // Show what the action would do with mock data
    const schema = getSchema(action.type);
    if (!schema) return;

    let desc = `Action: ${action.type}\n`;
    desc += `Description: ${schema.desc}\n\n`;
    desc += 'Parameters:\n';

    for (const field of schema.fields) {
      const value = action[field.name];
      if (value !== undefined && value !== '' && value !== null) {
        if (typeof value === 'object') {
          desc += `  ${field.name}: ${JSON.stringify(value)}\n`;
        } else {
          desc += `  ${field.name}: ${value}\n`;
        }
      }
    }

    alert(desc);
  }

  // --- Save/Delete ---
  function saveAction(action) {
    const formData = new FormData(form);

    // Clear action object, keep only type and nested structures
    const newAction = { type: action.type };
    if (action.choices) newAction.choices = action.choices;
    if (action.branches) newAction.branches = action.branches;

    // Collect fields from schema
    if (!currentSchema) return;

    for (const field of currentSchema.fields) {
      let value;

      switch (field.type) {
        case 'tilePicker':
          const x = formData.get(`${field.name}_x`);
          const y = formData.get(`${field.name}_y`);
          if (x !== '' || y !== '') {
            value = { x: parseInt(x, 10), y: parseInt(y, 10) };
          }
          break;

        case 'positionPicker':
          const px = formData.get(`${field.name}_x`);
          const py = formData.get(`${field.name}_y`);
          const pmark = formData.get(`${field.name}_mark`);
          if (pmark !== '' || px !== '' || py !== '') {
            value = {};
            if (pmark !== '') value.mark = pmark;
            if (px !== '') value.x = parseInt(px, 10);
            if (py !== '') value.y = parseInt(py, 10);
          }
          // Special handling for spawn_monster and spawn_item: flatten position into x, y
          if ((action.type === 'spawn_monster' || action.type === 'spawn_item') && field.name === 'position' && value) {
            if (value.x !== undefined) newAction.x = value.x;
            if (value.y !== undefined) newAction.y = value.y;
            if (value.mark !== undefined) newAction.mark = value.mark;
            value = undefined; // Don't add position object
          }
          break;

        case 'keyValue':
          // Check if this is an itemQty dictionary (multiple items with quantities)
          if (field.valueType === 'itemQty') {
            // Collect all key-value pairs from indexed inputs
            const dict = {};
            let hasEntries = false;
            for (const [name, val] of formData.entries()) {
              const match = name.match(new RegExp(`^${field.name}_key_(\\d+)$`));
              if (match) {
                const idx = match[1];
                const key = formData.get(`${field.name}_key_${idx}`);
                const qty = formData.get(`${field.name}_value_${idx}`);
                if (key && key.trim() !== '' && qty && qty.trim() !== '') {
                  const qtyNum = parseInt(qty, 10);
                  if (!isNaN(qtyNum) && qtyNum > 0) {
                    dict[key.trim()] = qtyNum;
                    hasEntries = true;
                  }
                }
              }
            }
            if (hasEntries) {
              value = dict;
            }
          } else {
            // Original single key-value pair
            const key = formData.get(`${field.name}_key`);
            const val = formData.get(`${field.name}_value`);
            if (key !== '' || val !== '') {
              value = { key, value: val };
            }
          }
          break;

        case 'json':
          const jsonStr = formData.get(field.name);
          if (jsonStr && jsonStr.trim()) {
            try {
              value = JSON.parse(jsonStr);
            } catch (e) {
              alert(`Invalid JSON in ${field.name}: ${e.message}`);
              return;
            }
          }
          break;

        case 'checkbox':
          value = formData.get(field.name) === 'on';
          break;

        case 'number':
          const num = formData.get(field.name);
          value = num !== '' ? parseFloat(num) : undefined;
          break;

        default:
          value = formData.get(field.name);
          if (value === '') value = undefined;
      }

      if (value !== undefined) {
        newAction[field.name] = value;
      }
    }

    // Validate
    const errors = validateAction(newAction);
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.join('\n'));
      return;
    }

    // Update or add action
    const event = scriptState.currentEvent;
    if (!event.actions) event.actions = [];

    if (scriptState.isNewAction) {
      event.actions.push(newAction);
    } else {
      event.actions[scriptState.currentActionIndex] = newAction;
    }

    scriptState.popPanel();
  }

  function deleteAction() {
    if (confirm('Delete this action?')) {
      const event = scriptState.currentEvent;
      event.actions.splice(scriptState.currentActionIndex, 1);
      scriptState.popPanel();
    }
  }

  // --- Public API ---
  panel.show = () => {
    panel.style.display = 'flex';
    buildForm();
  };

  panel.hide = () => { panel.style.display = 'none' };

  return panel;
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}