/**
 * Panel 2: Script Event Editor
 *
 * Edits individual ECA events with:
 * - id (required)
 * - once (checkbox)
 * - event type (combobox: built-in + custom)
 * - tile scope (x, y, mark with picker)
 * - npc scope (autocomplete from map)
 * - map scope (autocomplete from known maps)
 * - condition (expression with Test button)
 * - actions list (add/edit/delete/reorder)
 * - Show JSON button
 */

import { scriptState } from './scriptState.js';
import { showJsonModal, createJsonButton, createPanelHeader } from './scriptJsonViewer.js';
import {
  BUILTIN_EVENTS as EVENT_TYPES,
  CONDITION_FUNCTIONS,
  CONDITION_OPERATORS,
  validateScript as validateEvent
} from './actionSchemas.js';
import { getMapNpcs, getKnownMaps } from './editorAutocomplete.js';

/**
 * Create the Event Editor panel
 * @returns {HTMLElement}
 */
export function createScriptEventEditor() {
  const panel = document.createElement('div');
  panel.id = 'script-event-editor';
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
    <div id="event-editor-header"></div>
    <div class="panel-content" style="
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    ">
      <form id="event-form"></form>
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
      <button id="event-cancel-btn" style="
        padding: 6px 16px;
        background: #3a3a3a;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 12px;
      ">Cancel</button>
      <div style="display: flex; gap: 8px;">
        <button id="event-test-condition-btn" title="Test Condition" style="
          padding: 6px 16px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
          font-size: 12px;
        ">🧪 Test Condition</button>
        <button id="event-save-btn" type="button" style="
          padding: 6px 16px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        ">Save Event</button>
      </div>
    </div>
  `;

  const headerContainer = panel.querySelector('#event-editor-header');
  const form = panel.querySelector('#event-form');
  const cancelBtn = panel.querySelector('#event-cancel-btn');
  const testConditionBtn = panel.querySelector('#event-test-condition-btn');
  const saveBtn = panel.querySelector('#event-save-btn');

  // --- Build Form ---
  function buildForm() {
    const event = scriptState.currentEvent;
    const isNew = scriptState.isNewEvent;

    const actions = [
      { label: '← Back to Events', onClick: () => scriptState.popPanel() },
    ];
    if (!isNew) {
      actions.unshift(
        { label: '🗑 Delete', onClick: deleteEvent, danger: true },
        { label: '📋 Duplicate', onClick: duplicateEvent }
      );
    }
    headerContainer.innerHTML = '';
    headerContainer.appendChild(createPanelHeader(isNew ? 'New Event' : `Edit: ${event.id}`, actions));

    form.innerHTML = `
      <div class="form-section" style="margin-bottom: 16px;">
        <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Basic</h3>
        <div class="form-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-field">
            <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Event ID <span style="color: #f88;">*</span></label>
            <input type="text" name="id" required value="${escapeHtml(event.id ?? '')}" style="
              width: 100%;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 12px;
              box-sizing: border-box;
            ">
            <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Unique identifier for this event</div>
          </div>
          <div class="form-field">
            <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Once</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="checkbox" name="once" ${event.once ? 'checked' : ''} style="
                width: 16px;
                height: 16px;
                accent-color: #0e639c;
              ">
              <span style="font-size: 12px; color: #ccc;">Run only once per session</span>
            </div>
          </div>
        </div>
        <div class="form-row" style="display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px;">
          <div class="form-field">
            <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Event Type <span style="color: #f88;">*</span></label>
            <select name="on" required id="event-type-select" style="
              width: 100%;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 12px;
              box-sizing: border-box;
            ">
              ${buildEventTypeOptions(event.on)}
            </select>
            <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">When this event triggers</div>
          </div>
        </div>
      </div>

      <div class="form-section" style="margin-bottom: 16px;">
        <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">Scope</h3>
        <div id="scope-fields"></div>
      </div>

      <div class="form-section" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">Condition</h3>
          <button type="button" id="condition-help-btn" style="
            padding: 2px 8px;
            font-size: 10px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #aaa;
            cursor: pointer;
          ">📖 Functions</button>
        </div>
        <div class="form-field">
          <textarea name="condition" rows="4" placeholder="flag('key') == true && stat('hp') > 50&#10;has_item('key', 1) || chance(0.25)" style="
            width: 100%;
            padding: 8px 10px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            font-family: 'Consolas', 'Monaco', monospace;
            line-height: 1.5;
            box-sizing: border-box;
            resize: vertical;
          ">${escapeHtml(event.condition ?? '')}</textarea>
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Leave empty for no condition. Click "📖 Functions" for available functions and operators.</div>
        </div>
      </div>

      <div class="form-section" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">Actions</h3>
          <button type="button" id="add-action-btn" style="
            padding: 4px 10px;
            font-size: 11px;
            background: #0e639c;
            border: none;
            border-radius: 3px;
            color: white;
            cursor: pointer;
          ">➕ Add Action</button>
        </div>
        <div id="actions-list" style="min-height: 100px;"></div>
      </div>
    `;

    // Attach listeners after form is built
    attachFormListeners(event);
    renderActionsList(event);
  }

  function buildEventTypeOptions(selected) {
    const customEvents = scriptState.getCustomEvents();
    let html = '';

    // Built-in events
    for (const def of EVENT_TYPES) {
      const type = def.id;
      const sel = selected === type ? 'selected' : '';
      html += `<option value="${type}" ${sel}>${def.label} — ${def.description}</option>`;
    }

    if (customEvents.length > 0) {
      html += '<optgroup label="--- Custom Events ---">';
      for (const custom of customEvents) {
        const sel = selected === custom ? 'selected' : '';
        html += `<option value="${custom}" ${sel}>${custom} (custom)</option>`;
      }
    }

    return html;
  }

  // --- Scope Field Builders (Dynamic based on event type) ---
  // Event type -> required scopes mapping (matches BUILTIN_EVENTS.requiredScope)
  const EVENT_SCOPES = {
    scenario_start: {},
    map_enter: { map: true },
    tile_approach: { map: true, tile: true },
    tile_enter: { map: true, tile: true },
    npc_interact: { map: true, npc: true, tile: true },
    monster_defeated: { map: true },
  };

  function buildScopeFields(eventType, event) {
    const scopes = EVENT_SCOPES[eventType] || {};
    let html = '';

    if (scopes.tile) {
      const tile = event.tile || {};
      html += `
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Tile Scope</label>
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: nowrap;">
            <div style="display: flex; align-items: center; gap: 2px;">
              <span style="font-size: 10px; color: #888;">x:</span>
              <input type="number" name="tile_x" value="${tile.x ?? ''}" placeholder="x" style="
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
              <input type="number" name="tile_y" value="${tile.y ?? ''}" placeholder="y" style="
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
              <input type="text" name="tile_mark" value="${escapeHtml(tile.mark ?? '')}" placeholder="mark name" style="
                width: 140px;
                padding: 4px 8px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
              ">
            </div>
            <button type="button" class="tile-picker-btn" style="
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
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">For tile_approach / tile_enter. Leave blank for any tile. Picking a marked tile will use its mark name.</div>
        </div>
      `;
    }

    if (scopes.npc) {
      html += `
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">NPC Scope</label>
          <input type="text" name="npc" value="${escapeHtml(event.npc ?? '')}" placeholder="NPC id (autocomplete)" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">For npc_interact. Start typing to see NPCs from current map.</div>
        </div>
      `;
    }

    if (scopes.map) {
      html += `
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Map Scope</label>
          <input type="text" name="map" value="${escapeHtml(event.map ?? '')}" placeholder="Map id (autocomplete)" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">For map_enter. Start typing to see known maps.</div>
        </div>
      `;
    }

    if (!scopes.tile && !scopes.npc && !scopes.map) {
      html = '<div class="form-field" style="color: #888; font-style: italic;">No scope fields required for this event type.</div>';
    }

    return html;
  }

  function updateScopeFields() {
    const eventType = form.querySelector('[name="on"]').value;
    const container = form.querySelector('#scope-fields');
    if (container) {
      container.innerHTML = buildScopeFields(eventType, scriptState.currentEvent);

      // Re-attach tile picker listener if present
      const pickerBtn = container.querySelector('.tile-picker-btn');
      if (pickerBtn) {
        pickerBtn.addEventListener('click', () => openTilePicker());
      }

      // Re-attach NPC autocomplete if present
      const npcInput = container.querySelector('[name="npc"]');
      if (npcInput) {
        setupAutocomplete(npcInput, () => getMapNpcs(), 'npc');
      }

      // Re-attach Map autocomplete if present
      const mapInput = container.querySelector('[name="map"]');
      if (mapInput) {
        setupAutocomplete(mapInput, () => getKnownMaps(), 'map');
      }
    }
  }

  // --- Attach Listeners ---
  function attachFormListeners(event) {
    // Event type change - rebuild scope fields
    const eventTypeSelect = form.querySelector('#event-type-select');
    if (eventTypeSelect) {
      eventTypeSelect.addEventListener('change', () => {
        updateScopeFields();
      });
    }

    // Initialize scope fields (also attaches tile picker, NPC autocomplete, Map autocomplete)
    updateScopeFields();

    // Condition help
    form.querySelector('#condition-help-btn').addEventListener('click', () => {
      showConditionHelp();
    });

    // Add action
    form.querySelector('#add-action-btn').addEventListener('click', () => {
      scriptState.addAction();
    });

    // Test condition
    testConditionBtn.addEventListener('click', () => {
      testCondition();
    });

    // Cancel
    cancelBtn.addEventListener('click', () => {
      scriptState.popPanel();
    });

    // Save
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveEvent();
    });
  }

  function setupAutocomplete(input, getOptions, type) {
    let datalist = input.parentElement.querySelector('datalist');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = `autocomplete-${type}-${Date.now()}`;
      input.parentElement.appendChild(datalist);
      input.setAttribute('list', datalist.id);
    }

    input.addEventListener('focus', async () => {
      const options = await getOptions();
      datalist.innerHTML = options.map(opt => `<option value="${escapeHtml(opt)}">`).join('');
    });
  }

  // --- Actions List ---
  function renderActionsList(event) {
    const container = form.querySelector('#actions-list');
    container.innerHTML = '';

    if (!event.actions || event.actions.length === 0) {
      container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #666; font-style: italic;">
          No actions yet. Click "Add Action" to add one.
        </div>
      `;
      return;
    }

    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; margin: 0; padding: 0;';

    event.actions.forEach((action, index) => {
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

      const actionType = action.type || 'unknown';
      const actionDesc = getActionDescription(action);

      li.innerHTML = `
        <span class="drag-handle" style="
          cursor: grab;
          color: #666;
          padding: 0 4px;
          user-select: none;
        ">⋮⋮</span>
        <div class="action-info" style="flex: 1; min-width: 0;">
          <div class="action-type" style="
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          ">${escapeHtml(actionType)}</div>
          <div class="action-desc" style="
            font-size: 11px;
            color: #888;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          ">${escapeHtml(actionDesc)}</div>
        </div>
        <div style="display: flex; gap: 4px;">
          <button type="button" class="action-edit-btn" data-index="${index}" title="Edit" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
          ">✎</button>
          <button type="button" class="action-up-btn" data-index="${index}" title="Move Up" ${index === 0 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === 0 ? '#555' : '#e0e0e0'};
            cursor: ${index === 0 ? 'not-allowed' : 'pointer'};
          ">▲</button>
          <button type="button" class="action-down-btn" data-index="${index}" title="Move Down" ${index === event.actions.length - 1 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === event.actions.length - 1 ? '#555' : '#e0e0e0'};
            cursor: ${index === event.actions.length - 1 ? 'not-allowed' : 'pointer'};
          ">▼</button>
          <button type="button" class="action-delete-btn" data-index="${index}" title="Delete" style="
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

      // Drag and drop for reordering
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', index);
        li.style.opacity = '0.5';
      });
      li.addEventListener('dragend', () => {
        li.style.opacity = '1';
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        li.style.borderColor = '#0e639c';
      });
      li.addEventListener('dragleave', () => {
        li.style.borderColor = '#3a3a3a';
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.style.borderColor = '#3a3a3a';
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (fromIndex !== index) {
          moveAction(fromIndex, index);
        }
      });

      li.querySelector('.action-edit-btn').addEventListener('click', () => {
        scriptState.goToActionEditor(index);
      });

      li.querySelector('.action-up-btn').addEventListener('click', () => {
        moveAction(index, index - 1);
      });

      li.querySelector('.action-down-btn').addEventListener('click', () => {
        moveAction(index, index + 1);
      });

      li.querySelector('.action-delete-btn').addEventListener('click', () => {
        if (confirm('Delete this action?')) {
          event.actions.splice(index, 1);
          renderActionsList(event);
        }
      });

      list.appendChild(li);
    });

    container.appendChild(list);
  }

  function getActionDescription(action) {
    switch (action.type) {
      case 'show_text': return action.text ? `"${action.text.substring(0, 50)}${action.text.length > 50 ? '...' : ''}"` : 'No text';
      case 'set_flag': return `${action.key} = ${action.value ?? true}`;
      case 'change_stat': return `${action.stat} ${action.op || '+'}= ${action.value}`;
      case 'give_item': return `${action.item} x${action.amount || 1}`;
      case 'take_item': return `${action.item} x${action.amount || 1}`;
      case 'move_player': return `to (${action.x}, ${action.y})${action.map ? ` on ${action.map}` : ''}`;
      case 'move_npc': return `${action.npc} to (${action.x}, ${action.y})`;
      case 'spawn_npc': return `${action.npc} at (${action.x}, ${action.y})`;
      case 'despawn_npc': return action.npc;
      case 'change_tile': return `(${action.x}, ${action.y}) → ${action.tile}`;
      case 'change_map': return action.map;
      case 'play_sound': return action.sound;
      case 'show_choice': return `${action.choices?.length || 0} choices`;
      case 'pick_random': return `${action.branches?.length || 0} branches`;
      case 'fire_event': return action.event;
      case 'wait': return `${action.ms}ms`;
      case 'start_combat': return action.monster;
      case 'end_scenario': return action.result || 'victory';
      default: return JSON.stringify(action).substring(0, 50);
    }
  }

  function moveAction(fromIndex, toIndex) {
    const event = scriptState.currentEvent;
    if (!event.actions) return;
    const [action] = event.actions.splice(fromIndex, 1);
    event.actions.splice(toIndex, 0, action);
    renderActionsList(event);
  }

  // --- Tile Picker (Map Click Mode) ---
  let tilePickMode = false;
  let tilePickTargetField = null; // 'tile' for event editor

  function openTilePicker() {
    const currentMap = window.editor?.currentMap;
    if (!currentMap || !currentMap.width) {
      alert('No map loaded for tile picking.');
      return;
    }

    const btn = form.querySelector('.tile-picker-btn');
    const canvas = document.getElementById('mapCanvas');
    if (!canvas) {
      alert('Map canvas not found.');
      return;
    }

    if (tilePickMode) {
      // Exit picking mode
      exitTilePickMode(btn, canvas);
    } else {
      // Enter picking mode
      enterTilePickMode(btn, canvas);
    }
  }

  function enterTilePickMode(btn, canvas) {
    tilePickMode = true;
    tilePickTargetField = 'tile';
    btn.textContent = '✕ Cancel';
    btn.style.background = '#cc4444';
    canvas.style.cursor = 'crosshair';
    canvas.classList.add('tile-picking');

    // Add click handler to map canvas
    canvas.addEventListener('click', onMapTileClick);

    // Show temporary instruction
    showPickHint('Click on the map to pick tile coordinates. Click "Cancel" to exit.');
  }

  function exitTilePickMode(btn, canvas) {
    tilePickMode = false;
    tilePickTargetField = null;
    btn.textContent = '📍 Pick';
    btn.style.background = '';
    canvas.style.cursor = '';
    canvas.classList.remove('tile-picking');
    canvas.removeEventListener('click', onMapTileClick);
    hidePickHint();
  }

  function onMapTileClick(e) {
    if (!tilePickMode) return;

    const { x: tileX, y: tileY } = window.editor.tileFromEvent(e);

    // Validate bounds
    const currentMap = window.editor?.currentMap;
    if (!currentMap || tileX < 0 || tileY < 0 || tileX >= currentMap.width || tileY >= currentMap.height) {
      return; // Out of bounds
    }

    // Check if this tile has a mark
    const markKey = `${tileX},${tileY}`;
    const markName = currentMap._marks?.[markKey];

    // Fill in the inputs - prefer mark if available
    if (markName) {
      form.querySelector('[name="tile_mark"]').value = markName;
      form.querySelector('[name="tile_x"]').value = '';
      form.querySelector('[name="tile_y"]').value = '';
    } else {
      form.querySelector('[name="tile_x"]').value = tileX;
      form.querySelector('[name="tile_y"]').value = tileY;
      form.querySelector('[name="tile_mark"]').value = '';
    }

    // Exit picking mode
    const btn = form.querySelector('.tile-picker-btn');
    const canvasEl = document.getElementById('mapCanvas');
    exitTilePickMode(btn, canvasEl);
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

  // --- Condition Help Modal ---
  function showConditionHelp() {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.9);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: monospace;
    `;

    modal.innerHTML = `
      <div style="background: #252526; border: 1px solid #333; border-radius: 8px; padding: 20px; max-width: 700px; max-height: 80vh; overflow: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="margin: 0;">Condition Functions & Operators</h3>
          <button id="close-help" style="background: none; border: none; color: #aaa; font-size: 24px; cursor: pointer;">✕</button>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div>
            <h4 style="color: #88cc88; margin: 0 0 8px;">Functions</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="color: #888;"><th style="text-align: left; padding: 4px;">Function</th><th style="text-align: left; padding: 4px;">Description</th></tr>
              </thead>
              <tbody>
                ${Object.entries(CONDITION_FUNCTIONS).map(([name, fn]) => `
                  <tr style="border-top: 1px solid #333;">
                    <td style="padding: 4px; color: #0e639c; font-family: monospace;">${name}</td>
                    <td style="padding: 4px;">${fn.desc}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div>
            <h4 style="color: #88cc88; margin: 0 0 8px;">Operators</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="color: #888;"><th style="text-align: left; padding: 4px;">Operator</th><th style="text-align: left; padding: 4px;">Description</th></tr>
              </thead>
              <tbody>
                ${CONDITION_OPERATORS.map(op => `
                  <tr style="border-top: 1px solid #333;">
                    <td style="padding: 4px; color: #0e639c;">${op.symbol}</td>
                    <td style="padding: 4px;">${op.desc}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            <h4 style="color: #88cc88; margin: 16px 0 8px;">Examples</h4>
            <pre style="background: #1a1a1a; padding: 10px; border-radius: 4px; overflow: auto; font-size: 11px; color: #ccc;"><code>flag('door_open') == true
stat('hp') > 50
has_item('key', 1)
chance(0.25)
map('dungeon_1')
near('player', 5)
monster_type('goblin')
kills('goblin') >= 10</code></pre>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.querySelector('#close-help').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }

  // --- Test Condition ---
  function testCondition() {
    const condition = form.querySelector('[name="condition"]').value.trim();
    if (!condition) {
      alert('Condition is empty.');
      return;
    }

    // Create a mock context for testing
    const mockContext = {
      flags: { 'door_open': true, 'quest_started': false },
      stats: { hp: 75, mp: 30, level: 5 },
      inventory: { 'key': 1, 'potion': 3, 'sword': 1 },
      map: 'dungeon_1',
      player: { x: 10, y: 10 },
      monsters: { goblin: 3, slime: 2 }
    };

    try {
      const result = evaluateCondition(condition, mockContext);
      alert(`Condition Result: ${result}\n\nMock Context:\n${JSON.stringify(mockContext, null, 2)}`);
    } catch (e) {
      alert(`Error evaluating condition:\n${e.message}`);
    }
  }

  function evaluateCondition(expr, context) {
    // Simple evaluator for testing - supports basic functions
    const functions = {
      flag: (key) => context.flags[key] ?? false,
      stat: (key) => context.stats[key] ?? 0,
      has_item: (item, count = 1) => (context.inventory[item] ?? 0) >= count,
      has_tag: (tag) => false, // Not in mock
      chance: (p) => Math.random() < p,
      map: (id) => context.map === id,
      near: (target, dist) => {
        if (target === 'player') {
          const dx = context.player.x - context.player.x; // mock
          return true;
        }
        return false;
      },
      monster_type: (type) => context.monsters[type] > 0,
      kills: (type) => context.monsters[type] ?? 0,
    };

    // Replace function calls
    let jsExpr = expr;
    for (const [name, fn] of Object.entries(functions)) {
      const regex = new RegExp(`\\b${name}\\s*\\(`, 'g');
      jsExpr = jsExpr.replace(regex, `functions.${name}(`);
    }

    // Replace operators
    jsExpr = jsExpr
      .replace(/==/g, '===')
      .replace(/!=/g, '!==')
      .replace(/&&/g, '&&')
      .replace(/\\|\\|/g, '||');

    // eslint-disable-next-line no-new-func
    const func = new Function('functions', 'return ' + jsExpr);
    return func(functions);
  }

  // --- Save/Delete/Duplicate ---
  function saveEvent() {
    const formData = new FormData(form);
    const event = scriptState.currentEvent;

    event.id = formData.get('id').trim();
    event.once = formData.get('once') === 'on';
    event.on = formData.get('on');

    // Tile fields are absent without tile scope, so get() returns null
    const tileX = formData.get('tile_x') ?? '';
    const tileY = formData.get('tile_y') ?? '';
    const tileMark = formData.get('tile_mark') ?? '';
    if (tileX !== '' || tileY !== '' || tileMark !== '') {
      event.tile = {};
      if (tileX !== '') event.tile.x = parseInt(tileX, 10);
      if (tileY !== '') event.tile.y = parseInt(tileY, 10);
      if (tileMark !== '') event.tile.mark = tileMark;
    } else {
      delete event.tile;
    }

    // NPC (may not exist for all event types)
    const npc = (formData.get('npc') ?? '').trim();
    event.npc = npc || undefined;

    // Map (may not exist for all event types)
    const map = (formData.get('map') ?? '').trim();
    event.map = map || undefined;

    // Condition
    const condition = (formData.get('condition') ?? '').trim();
    event.condition = condition || undefined;

    // Validate
    const errors = validateEvent(event);
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.join('\n'));
      return;
    }

    // Check ID uniqueness (if new or ID changed)
    const allEvents = scriptState.currentEvents;
    const existingIndex = allEvents.findIndex(e => e.id === event.id && e !== event);
    if (existingIndex >= 0) {
      if (!confirm(`Event with ID "${event.id}" already exists. Overwrite?`)) return;
      allEvents.splice(existingIndex, 1);
    }

    if (scriptState.isNewEvent) {
      allEvents.push(event);
    }

    scriptState.popPanel();
  }

  function deleteEvent() {
    if (confirm('Delete this event?')) {
      const index = scriptState.currentEventIndex;
      if (index >= 0) {
        scriptState.currentEvents.splice(index, 1);
      }
      scriptState.popPanel();
    }
  }

  function duplicateEvent() {
    const event = { ...scriptState.currentEvent };
    event.id = event.id + '_copy';
    scriptState.currentEvents.splice(scriptState.currentEventIndex + 1, 0, event);
    scriptState.currentEventIndex = scriptState.currentEventIndex + 1;
    scriptState.isNewEvent = false;
    buildForm();
  }

  // --- Public API ---
  panel.show = () => {
    panel.style.display = 'flex';
    buildForm();
  };

  panel.hide = () => { panel.style.display = 'none' };

  // Expose renderActionsList for external callbacks
  panel.renderActionsList = (event) => renderActionsList(event);

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