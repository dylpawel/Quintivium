/**
 * Script Editor Panel — Full ECA script editor with dropdowns and autocomplete
 *
 * Features:
 * - Event dropdown with argument descriptions
 * - Action list with add/remove/reorder
 * - Action schema-driven forms (from actionSchemas.js)
 * - Autocomplete for items, monsters, NPCs, maps, flags, variables
 * - Condition validation with live feedback
 */

import {
  BUILTIN_EVENTS,
  ACTION_SCHEMAS,
  getEventSchema,
  getActionSchema,
  validateCondition,
  getAllItemIds,
  getAllMonsterTypes,
  getAllNPCTypes,
  getAllMapIds,
  extractFlagsAndVariables,
  validateScript,
  CONDITION_FUNCTIONS
} from './actionSchemas.js'

/**
 * Create the Script Editor panel
 * @param {Object} deps - Dependencies
 * @param {Object} deps.script - Script object being edited (from map._scripts)
 * @param {Object} deps.map - Current map object
 * @param {Function} deps.onSave - Callback when saved (script)
 * @param {Function} deps.onCancel - Callback when cancelled
 * @param {Function} deps.onDelete - Callback when delete requested
 * @returns {HTMLElement}
 */
export function createScriptEditorPanel({ script, map, onSave, onCancel, onDelete }) {
  const panel = document.createElement('div')
  panel.id = 'script-editor-panel'
  panel.className = 'editor-panel'
  panel.style.cssText = `
    display: none;
    flex-direction: column;
    height: 100%;
    background: #1e1e1e;
    color: #e0e0e0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
  `

  // Clone script for editing (don't mutate original until save)
  const editScript = JSON.parse(JSON.stringify(script))

  // Initialize actions array if missing
  if (!editScript.actions) editScript.actions = []

  panel.innerHTML = `
    <div class="panel-header" style="
      padding: 10px 12px;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #252526;
    ">
      <h3 style="margin: 0; font-size: 14px; font-weight: 600;">Edit Script</h3>
      <div style="display: flex; gap: 8px;">
        <button id="script-editor-delete-btn" class="btn btn-danger" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #a4262c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
        ">Delete</button>
        <button id="script-editor-cancel-btn" class="btn" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
        ">Cancel</button>
        <button id="script-editor-save-btn" class="btn btn-primary" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
        ">Save</button>
      </div>
    </div>

    <div class="editor-content" style="flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 16px;">

      <!-- Basic Info -->
      <section style="background: #252526; border: 1px solid #333; border-radius: 4px; padding: 12px;">
        <h4 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #ccc;">Basic Information</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <label style="display: block; font-size: 11px; color: #888; margin-bottom: 4px;">Script ID (required)</label>
            <input type="text" id="script-id" value="${escapeHtml(editScript.id ?? '')}" style="
              width: 100%;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 13px;
              box-sizing: border-box;
            ">
            <span style="font-size: 10px; color: #888;">Unique identifier for this script (used for "once" tracking)</span>
          </div>
          <div>
            <label style="display: block; font-size: 11px; color: #888; margin-bottom: 4px;">Run Once</label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="script-once" ${editScript.once ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: #0e639c;">
              <span style="font-size: 13px;">Yes</span>
            </label>
          </div>
        </div>

        <div style="margin-top: 12px;">
          <label style="display: block; font-size: 11px; color: #888; margin-bottom: 4px;">Event (on)</label>
          <div style="display: flex; gap: 12px; align-items: flex-start;">
            <select id="script-event" style="
              flex: 1;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 13px;
            ">
              ${BUILTIN_EVENTS.map(e => `<option value="${e.id}" ${e.id === editScript.on ? 'selected' : ''}>${e.label} (${e.id})</option>`).join('')}
            </select>
            <button id="script-event-help" title="Event reference" style="
              padding: 6px 10px;
              background: #3a3a3a;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              cursor: pointer;
              font-size: 12px;
            ">?</button>
          </div>
          <div id="script-event-args" style="margin-top: 8px; padding: 8px; background: #1a1a1a; border-radius: 3px; font-size: 12px; color: #aaa; min-height: 40px;"></div>
        </div>

        <!-- Tile selection for tile events -->
        <div id="script-tile-field" style="margin-top: 12px; display: none;">
          <label style="display: block; font-size: 11px; color: #888; margin-bottom: 4px;">Tile Position (for tile events)</label>
          <div style="display: flex; gap: 8px; align-items: center;">
            <input type="number" id="script-tile-x" placeholder="X" value="${editScript.tile?.x ?? ''}" style="
              width: 80px;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 13px;
            ">
            <span style="color: #666;">×</span>
            <input type="number" id="script-tile-y" placeholder="Y" value="${editScript.tile?.y ?? ''}" style="
              width: 80px;
              padding: 6px 10px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 13px;
            ">
            <button id="script-tile-pick-btn" class="btn btn-primary" style="
              padding: 6px 12px;
              font-size: 12px;
              background: #0e639c;
              border: none;
              border-radius: 3px;
              color: white;
              cursor: pointer;
            ">🎯 Pick Tile</button>
            <button id="script-tile-mark-btn" class="btn" style="
              padding: 6px 12px;
              font-size: 12px;
              background: #3a3a3a;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              cursor: pointer;
            ">📍 Use Mark</button>
          </div>
          <div style="margin-top: 4px; font-size: 11px; color: #888;">
            Click "Pick Tile" then click on the map, or select a named mark from the map
          </div>
        </div>
      </section>

      <!-- Conditions -->
      <section style="background: #252526; border: 1px solid #333; border-radius: 4px; padding: 12px;">
        <h4 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #ccc;">Condition (Optional)</h4>
        <div style="margin-bottom: 8px;">
          <textarea id="script-condition" rows="4" placeholder="Enter condition expression...\nExample: flags.quest_started == true AND player.level >= 5\n\nAvailable: flags.*, vars.*, player.*, target.*, random(), hasItem(id), hasFlag(name), etc." style="
            width: 100%;
            padding: 8px 10px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            line-height: 1.5;
            box-sizing: border-box;
            resize: vertical;
          ">${escapeHtml(editScript.condition ?? editScript.conditions ?? '')}</textarea>
        </div>
        <div id="condition-validation" style="font-size: 11px; min-height: 16px;"></div>
        <div style="margin-top: 8px; font-size: 11px; color: #888;">
          <strong>Quick Reference:</strong>
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">flags.flag_name</code> |
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">vars.var_name</code> |
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">player.level</code> |
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">target.hp</code> |
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">hasItem('item_id')</code> |
          <code style="background: #1a1a1a; padding: 2px 6px; border-radius: 3px;">random() < 0.5</code>
          <br><br>
          For tile events, <code>event.x</code> and <code>event.y</code> are available
        </div>
      </section>

      <!-- Actions -->
      <section style="background: #252526; border: 1px solid #333; border-radius: 4px; padding: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: #ccc;">Actions (${editScript.actions.length})</h4>
          <button id="script-add-action-btn" class="btn btn-primary" style="
            padding: 4px 12px;
            font-size: 12px;
            background: #0e639c;
            border: none;
            border-radius: 3px;
            color: white;
            cursor: pointer;
          ">+ Add Action</button>
        </div>

        <div id="script-actions-list" style="flex: 1; overflow-y: auto; min-height: 200px;"></div>

        <div id="script-actions-empty" style="display: ${editScript.actions.length === 0 ? 'block' : 'none'}; text-align: center; padding: 20px; color: #666; font-style: italic;">
          No actions yet. Click "Add Action" to create one.
        </div>
      </section>

    </div>
  `

  // Cache DOM elements
  const idInput = panel.querySelector('#script-id')
  const onceCheckbox = panel.querySelector('#script-once')
  const eventSelect = panel.querySelector('#script-event')
  const eventArgsDiv = panel.querySelector('#script-event-args')
  const tileFieldDiv = panel.querySelector('#script-tile-field')
  const tileXInput = panel.querySelector('#script-tile-x')
  const tileYInput = panel.querySelector('#script-tile-y')
  const tilePickBtn = panel.querySelector('#script-tile-pick-btn')
  const tileMarkBtn = panel.querySelector('#script-tile-mark-btn')
  const conditionTextarea = panel.querySelector('#script-condition')
  const conditionValidation = panel.querySelector('#condition-validation')
  const actionsList = panel.querySelector('#script-actions-list')
  const actionsEmpty = panel.querySelector('#script-actions-empty')
  const addActionBtn = panel.querySelector('#script-add-action-btn')
  const saveBtn = panel.querySelector('#script-editor-save-btn')
  const cancelBtn = panel.querySelector('#script-editor-cancel-btn')
  const deleteBtn = panel.querySelector('#script-editor-delete-btn')
  const eventHelpBtn = panel.querySelector('#script-event-help')

  // Autocomplete data cache
  let autocompleteData = {
    items: [],
    monsters: [],
    npcs: [],
    maps: [],
    flags: [],
    variables: []
  }

  // Load autocomplete data using exported functions
  async function loadAutocompleteData() {
    try {
      const [items, monsters, npcs, maps] = await Promise.all([
        getAllItemIds(),
        getAllMonsterTypes(),
        getAllNPCTypes(),
        getAllMapIds()
      ])
      autocompleteData.items = items.map(id => ({ id, label: id }))
      autocompleteData.monsters = monsters.map(id => ({ id, label: id }))
      autocompleteData.npcs = npcs.map(id => ({ id, label: id }))
      autocompleteData.maps = maps.map(id => ({ id, label: id }))
      // Flags and variables need scenario/scripts context - will be loaded when needed
    } catch (err) {
      console.warn('[ScriptEditor] Failed to load autocomplete data:', err)
    }
  }

  // Load initial data
  loadAutocompleteData()

  // --- Event Handling ---

  function updateEventArgs() {
    const eventId = eventSelect.value
    const eventSchema = getEventSchema(eventId)

    // Show/hide tile field for tile events
    const isTileEvent = eventId === 'tile_enter' || eventId === 'tile_approach'
    tileFieldDiv.style.display = isTileEvent ? 'block' : 'none'

    if (eventSchema && eventSchema.args && eventSchema.args.length > 0) {
      eventArgsDiv.innerHTML = `
        <strong>Event Arguments:</strong>
        <ul style="margin: 4px 0 0 0; padding-left: 20px; font-size: 11px; color: #aaa;">
          ${eventSchema.args.map(arg => `<li><code>${arg.name}</code> (${arg.type}): ${arg.desc}</li>`).join('')}
        </ul>
        <div style="margin-top: 4px; font-size: 11px; color: #888;">
          Available in conditions as: <code>event.${eventSchema.args.map(a => a.name).join('</code>, <code>')}</code>
        </div>
      `
    } else {
      eventArgsDiv.innerHTML = '<em>No arguments for this event.</em>'
    }
  }

  // --- Action Rendering ---

  function renderActions() {
    actionsList.innerHTML = ''
    actionsEmpty.style.display = editScript.actions.length === 0 ? 'block' : 'none'

    if (editScript.actions.length > 0) {
      const header = document.createElement('div')
      header.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; padding: 4px 0; border-bottom: 1px solid #333;'
      header.innerHTML = `
        <div style="width: 24px; color: #666; font-size: 11px;">#</div>
        <div style="flex: 1; color: #888; font-size: 11px;">Action</div>
        <div style="width: 80px; color: #888; font-size: 11px; text-align: center;">Order</div>
        <div style="width: 60px;"></div>
      `
      actionsList.appendChild(header)
    }

    editScript.actions.forEach((action, index) => {
      const actionEl = createActionElement(action, index)
      actionsList.appendChild(actionEl)
    })

    // Update action count in header
    const countEl = panel.querySelector('#script-actions-list + h4') || panel.querySelector('h4')
    const actionCountEl = panel.querySelector('section:last-of-type h4')
    if (actionCountEl) {
      actionCountEl.textContent = `Actions (${editScript.actions.length})`
    }
  }

  // Local action validation (since validateAction is not exported)
  function validateAction(action) {
    const schema = getActionSchema(action.type)
    if (!schema) return { valid: false, error: `Unknown action type: ${action.type}` }

    // Check required fields
    for (const field of schema.fields) {
      if (field.required && (action[field.name] === undefined || action[field.name] === '')) {
        const fieldLabel = field.label || field.name
        return { valid: false, error: `Missing required field: ${fieldLabel}` }
      }
    }
    return { valid: true }
  }

  function createActionElement(action, index) {
    const schema = getActionSchema(action.type)
    const isValid = validateAction(action).valid

    const div = document.createElement('div')
    div.className = 'script-action-item'
    div.dataset.index = index
    div.style.cssText = `
      display: flex;
      gap: 8px;
      padding: 8px;
      margin: 4px 0;
      background: ${isValid ? '#2d2d2d' : '#3a2a2a'};
      border: 1px solid ${isValid ? '#3a3a3a' : '#5a3a3a'};
      border-radius: 3px;
      align-items: flex-start;
    `

    const typeLabel = schema ? schema.label : action.type
    const typeDesc = schema ? schema.desc : 'Unknown action type'

    div.innerHTML = `
      <div style="width: 24px; font-size: 11px; color: #888; padding-top: 2px;">${index + 1}</div>
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <span style="font-weight: 500; color: ${isValid ? '#e0e0e0' : '#ff8888'};">${typeLabel}</span>
          <span style="font-size: 11px; color: #888;">${typeDesc}</span>
          ${!isValid ? '<span style="font-size: 10px; color: #ff8888; background: #3a1a1a; padding: 1px 4px; border-radius: 2px;">Invalid</span>' : ''}
        </div>
        <div class="action-fields" style="font-size: 12px;"></div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 2px;">
        <button class="action-move-up" title="Move Up" ${index === 0 ? 'disabled' : ''} style="
          padding: 2px 6px;
          font-size: 10px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 2px;
          color: #e0e0e0;
          cursor: pointer;
          ${index === 0 ? 'opacity: 0.4;' : ''}
        ">↑</button>
        <button class="action-move-down" title="Move Down" ${index === editScript.actions.length - 1 ? 'disabled' : ''} style="
          padding: 2px 6px;
          font-size: 10px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 2px;
          color: #e0e0e0;
          cursor: pointer;
          ${index === editScript.actions.length - 1 ? 'opacity: 0.4;' : ''}
        ">↓</button>
      </div>
      <button class="action-delete" title="Delete" style="
        padding: 2px 8px;
        font-size: 11px;
        background: #3a3a3a;
        border: 1px solid #444;
        border-radius: 2px;
        color: #e0e0e0;
        cursor: pointer;
      ">×</button>
    `

    // Render fields for this action
    const fieldsContainer = div.querySelector('.action-fields')
    if (schema) {
      renderActionFields(fieldsContainer, action, schema, index)
    } else {
      fieldsContainer.innerHTML = '<em style="color: #ff8888;">Unknown action type</em>'
    }

    // Event listeners for this action
    div.querySelector('.action-move-up')?.addEventListener('click', () => {
      if (index > 0) {
        ;[editScript.actions[index], editScript.actions[index - 1]] = [editScript.actions[index - 1], editScript.actions[index]]
        renderActions()
      }
    })

    div.querySelector('.action-move-down')?.addEventListener('click', () => {
      if (index < editScript.actions.length - 1) {
        ;[editScript.actions[index], editScript.actions[index + 1]] = [editScript.actions[index + 1], editScript.actions[index]]
        renderActions()
      }
    })

    div.querySelector('.action-delete')?.addEventListener('click', () => {
      editScript.actions.splice(index, 1)
      renderActions()
    })

    return div
  }

  function renderActionFields(container, action, schema, actionIndex) {
    container.innerHTML = ''

    // Helper to get map marks for markSelect
    const getMapMarks = () => {
      if (!map || !map._marks) return []
      return Object.entries(map._marks).map(([key, name]) => {
        const [x, y] = key.split(',').map(Number)
        return { name, x, y, label: `${name} (${x},${y})` }
      })
    }

    // Helper to create a select dropdown with options
    function createSelectField(fieldId, field, options, value, label) {
      const optionElements = options.map(opt =>
        `<option value="${escapeHtml(opt.value)}" ${value === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
      ).join('')

      return `
        <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
        <select id="${fieldId}" style="
          padding: 4px 8px;
          background: #3c3c3c;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          font-size: 12px;
        ">
          <option value="">-- Select --</option>
          ${optionElements}
        </select>
        ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
      `
    }

    // Helper to create autocomplete/input with datalist
    function createAutocompleteField(fieldId, field, sourceData, value, label) {
      const options = sourceData.map(opt =>
        `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label || opt.id)}</option>`
      ).join('')

      return `
        <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
        <div style="position: relative;">
          <input type="text" id="${fieldId}" list="${fieldId}-list" value="${escapeHtml(value ?? '')}" style="
            padding: 4px 8px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
          ">
          <datalist id="${fieldId}-list">
            ${options}
          </datalist>
        </div>
        ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
      `
    }

    for (const field of schema.fields) {
      const fieldDiv = document.createElement('div')
      fieldDiv.style.cssText = 'margin: 4px 0; display: flex; flex-direction: column; gap: 2px;'

      const fieldId = `action-${actionIndex}-${field.name}`
      const value = action[field.name]
      const label = field.label || field.name  // Fallback to field name if label not provided
      let html = ''
      let bindEvents = null

      switch (field.type) {
        case 'textarea': {
          // Multi-line text area
          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <textarea id="${fieldId}" placeholder="${escapeHtml(field.placeholder ?? '')}" style="
              padding: 6px 8px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 12px;
              font-family: inherit;
              min-height: 60px;
              resize: vertical;
            ">${escapeHtml(value ?? '')}</textarea>
            ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            div.querySelector('textarea').addEventListener('input', (e) => {
              action[field.name] = e.target.value || undefined
            })
          }
          break
        }

        case 'keyValue': {
          // Key-value object editor (e.g., { "item_id": qty })
          const obj = value && typeof value === 'object' ? value : {}
          const entries = Object.entries(obj)
          let rowsHtml = entries.map(([k, v], i) => `
            <div style="display: flex; gap: 4px; margin: 2px 0;" data-index="${i}">
              <input type="text" class="kv-key" value="${escapeHtml(k)}" placeholder="Key" style="
                flex: 1; padding: 4px 8px; background: #3c3c3c; border: 1px solid #444; border-radius: 3px; color: #e0e0e0; font-size: 11px;
              ">
              <input type="number" class="kv-value" value="${escapeHtml(v ?? '')}" placeholder="Value" min="1" style="
                width: 60px; padding: 4px 8px; background: #3c3c3c; border: 1px solid #444; border-radius: 3px; color: #e0e0e0; font-size: 11px;
              ">
              <button class="kv-remove" style="
                padding: 4px 8px; background: #a4262c; border: none; border-radius: 3px; color: white; font-size: 10px; cursor: pointer;
              ">×</button>
            </div>
          `).join('')
          rowsHtml += `
            <button class="kv-add" style="
              margin-top: 4px; padding: 4px 10px; background: #3a3a3a; border: 1px solid #444; border-radius: 3px; color: #e0e0e0; font-size: 11px; cursor: pointer;
            ">+ Add Entry</button>
          `

          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <div id="${fieldId}-kv" style="display: flex; flex-direction: column; gap: 2px;">
              ${rowsHtml}
            </div>
            ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            const kvContainer = div.querySelector(`#${fieldId}-kv`)
            const rebuild = () => {
              const newObj = {}
              kvContainer.querySelectorAll('[data-index]').forEach(row => {
                const key = row.querySelector('.kv-key').value.trim()
                const val = row.querySelector('.kv-value').value
                if (key && val !== '') newObj[key] = Number(val)
              })
              action[field.name] = Object.keys(newObj).length > 0 ? newObj : undefined
            }

            kvContainer.addEventListener('input', (e) => {
              if (e.target.classList.contains('kv-key') || e.target.classList.contains('kv-value')) {
                rebuild()
              }
            })

            kvContainer.addEventListener('click', (e) => {
              if (e.target.classList.contains('kv-remove')) {
                e.target.closest('[data-index]').remove()
                rebuild()
              } else if (e.target.classList.contains('kv-add')) {
                const newRow = document.createElement('div')
                newRow.style.cssText = 'display: flex; gap: 4px; margin: 2px 0;'
                newRow.innerHTML = `
                  <input type="text" class="kv-key" placeholder="Key" style="
                    flex: 1; padding: 4px 8px; background: #3c3c3c; border: 1px solid #444; border-radius: 3px; color: #e0e0e0; font-size: 11px;
                  ">
                  <input type="number" class="kv-value" placeholder="Value" min="1" style="
                    width: 60px; padding: 4px 8px; background: #3c3c3c; border: 1px solid #444; border-radius: 3px; color: #e0e0e0; font-size: 11px;
                  ">
                  <button class="kv-remove" style="
                    padding: 4px 8px; background: #a4262c; border: none; border-radius: 3px; color: white; font-size: 10px; cursor: pointer;
                  ">×</button>
                `
                kvContainer.insertBefore(newRow, kvContainer.querySelector('.kv-add'))
                rebuild()
              }
            })
          }
          break
        }

        case 'json': {
          // Raw JSON textarea
          const jsonStr = value ? JSON.stringify(value, null, 2) : ''
          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <textarea id="${fieldId}" placeholder="${escapeHtml(field.placeholder ?? '')}" style="
              padding: 6px 8px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 11px;
              font-family: 'Consolas', monospace;
              min-height: 80px;
              resize: vertical;
            ">${escapeHtml(jsonStr)}</textarea>
            ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            div.querySelector('textarea').addEventListener('input', (e) => {
              try {
                const val = e.target.value.trim()
                action[field.name] = val ? JSON.parse(val) : undefined
              } catch {
                // Invalid JSON, leave as string for now
                action[field.name] = e.target.value
              }
            })
          }
          break
        }

        case 'itemSelect': {
          const options = autocompleteData.items.map(item => ({ value: item.id, label: item.id }))
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'mapSelect': {
          const options = autocompleteData.maps.map(m => ({ value: m.id, label: m.id }))
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'markSelect': {
          const marks = getMapMarks()
          const options = marks.map(m => ({ value: m.name, label: m.label }))
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'monsterSelect': {
          const options = autocompleteData.monsters.map(m => ({ value: m.id, label: m.id }))
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'npcSelect': {
          const options = autocompleteData.npcs.map(n => ({ value: n.id, label: n.id }))
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'select': {
          const options = (field.options || []).map(opt =>
            typeof opt === 'string' ? { value: opt, label: opt } : { value: opt.value, label: opt.label }
          )
          html = createSelectField(fieldId, field, options, value, label)
          bindEvents = (div) => {
            div.querySelector('select').addEventListener('change', (e) => {
              action[field.name] = e.target.value || undefined
              renderActions()
            })
          }
          break
        }

        case 'autocomplete': {
          const source = field.autocompleteSource
          let sourceData = []
          if (source === 'items') sourceData = autocompleteData.items
          else if (source === 'monsters') sourceData = autocompleteData.monsters
          else if (source === 'npcs') sourceData = autocompleteData.npcs
          else if (source === 'maps') sourceData = autocompleteData.maps
          else if (source === 'flags') sourceData = autocompleteData.flags
          else if (source === 'variables') sourceData = autocompleteData.variables

          html = createAutocompleteField(fieldId, field, sourceData, value, label)
          bindEvents = (div) => {
            div.querySelector('input').addEventListener('input', (e) => {
              action[field.name] = e.target.value || undefined
            })
          }
          break
        }

        case 'number': {
          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <input type="number" id="${fieldId}" value="${value ?? ''}" step="${field.step ?? 1}" min="${field.min ?? ''}" max="${field.max ?? ''}" style="
              padding: 4px 8px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 12px;
              width: 100px;
            ">
            ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            div.querySelector('input').addEventListener('input', (e) => {
              const val = e.target.value
              action[field.name] = val === '' ? undefined : Number(val)
              renderActions()
            })
          }
          break
        }

        case 'checkbox':
        case 'boolean': {
          html = `
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="${fieldId}" ${value ? 'checked' : ''} style="width: 14px; height: 14px; accent-color: #0e639c;">
              <span style="font-size: 12px;">${escapeHtml(label)}</span>
            </label>
            ${field.desc ? `<span style="font-size: 10px; color: #666; margin-left: 22px;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            div.querySelector('input').addEventListener('change', (e) => {
              action[field.name] = e.target.checked
            })
          }
          break
        }

        case 'tilePicker': {
          // Tile picker button that integrates with the tile picker tool
          const tileX = action.tile?.x ?? action.x
          const tileY = action.tile?.y ?? action.y
          const coordDisplay = (tileX !== undefined && tileY !== undefined) ? `(${tileX}, ${tileY})` : 'Not set'

          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <span id="${fieldId}-coord" style="
                padding: 6px 10px;
                background: #3c3c3c;
                border: 1px solid #444;
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 12px;
                font-family: 'Consolas', monospace;
                min-width: 100px;
              ">${escapeHtml(coordDisplay)}</span>
              <button id="${fieldId}-pick" class="btn btn-primary" style="
                padding: 6px 12px;
                font-size: 12px;
                background: #0e639c;
                border: none;
                border-radius: 3px;
                color: white;
                cursor: pointer;
              ">🎯 Pick Tile</button>
              ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
            </div>
          `
          bindEvents = (div) => {
            div.querySelector(`#${fieldId}-pick`).addEventListener('click', () => {
              window.dispatchEvent(new CustomEvent('script-editor-pick-tile', {
                detail: {
                  script: editScript,
                  actionField: field.name,
                  onTilePicked: (x, y) => {
                    const coordEl = div.querySelector(`#${fieldId}-coord`)
                    if (coordEl) coordEl.textContent = `(${x}, ${y})`

                    // Store in action.tile for change_tile, or action.x/action.y for others
                    if (!action.tile) action.tile = {}
                    action.tile.x = x
                    action.tile.y = y
                    action.x = x
                    action.y = y
                    renderActions()
                  }
                }
              }))
            })
          }
          break
        }

        default: {
          // Text field (default for 'text' and unknown types)
          html = `
            <label style="font-size: 10px; color: #888; text-transform: uppercase;">${escapeHtml(label)}</label>
            <input type="text" id="${fieldId}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(field.placeholder ?? '')}" style="
              padding: 4px 8px;
              background: #3c3c3c;
              border: 1px solid #444;
              border-radius: 3px;
              color: #e0e0e0;
              font-size: 12px;
            ">
            ${field.desc ? `<span style="font-size: 10px; color: #666;">${escapeHtml(field.desc)}</span>` : ''}
          `
          bindEvents = (div) => {
            div.querySelector('input').addEventListener('input', (e) => {
              action[field.name] = e.target.value || undefined
            })
          }
          break
        }
      }

      fieldDiv.innerHTML = html
      if (bindEvents) bindEvents(fieldDiv)
      container.appendChild(fieldDiv)
    }
  }

  // --- Condition Validation ---

  let validationDebounce = null
  conditionTextarea.addEventListener('input', () => {
    clearTimeout(validationDebounce)
    validationDebounce = setTimeout(() => {
      const condition = conditionTextarea.value.trim()
      if (condition) {
        const result = validateCondition(condition)
        if (result.valid) {
          conditionValidation.innerHTML = '<span style="color: #88cc88;">✓ Valid condition</span>'
        } else {
          conditionValidation.innerHTML = `<span style="color: #ff8888;">✗ ${result.error}</span>`
        }
      } else {
        conditionValidation.innerHTML = '<span style="color: #888;">No condition (always true)</span>'
      }
    }, 300)
  })

  // --- Event Listeners ---

  idInput.addEventListener('input', (e) => {
    editScript.id = e.target.value
  })

  onceCheckbox.addEventListener('change', (e) => {
    editScript.once = e.target.checked
  })

  eventSelect.addEventListener('change', (e) => {
    editScript.on = e.target.value
    updateEventArgs()
  })

  // Tile coordinate inputs
  tileXInput.addEventListener('input', (e) => {
    const val = e.target.value
    if (!editScript.tile) editScript.tile = {}
    editScript.tile.x = val === '' ? undefined : Number(val)
  })

  tileYInput.addEventListener('input', (e) => {
    const val = e.target.value
    if (!editScript.tile) editScript.tile = {}
    editScript.tile.y = val === '' ? undefined : Number(val)
  })

  // Tile picker button - activate tile picker tool
  tilePickBtn.addEventListener('click', () => {
    // Emit custom event to activate tile picker in editor
    window.dispatchEvent(new CustomEvent('script-editor-pick-tile', { detail: { script: editScript, onTilePicked: (x, y) => {
      tileXInput.value = x
      tileYInput.value = y
      if (!editScript.tile) editScript.tile = {}
      editScript.tile.x = x
      editScript.tile.y = y
    }}}))
  })

  // Mark picker button
  tileMarkBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('script-editor-pick-mark', { detail: { script: editScript, map, onMarkPicked: (markName, x, y) => {
      tileXInput.value = x
      tileYInput.value = y
      if (!editScript.tile) editScript.tile = {}
      editScript.tile.x = x
      editScript.tile.y = y
      // Optionally store mark name for reference
      editScript.tile.mark = markName
    }}}))
  })

  addActionBtn.addEventListener('click', () => {
    showActionTypePicker()
  })

  saveBtn.addEventListener('click', () => {
    // Final validation
    const condition = conditionTextarea.value.trim()
    if (condition) {
      const result = validateCondition(condition)
      if (!result.valid) {
        if (!confirm(`Condition has errors: ${result.error}\n\nSave anyway?`)) return
      }
    }

    // Validate required ID for "once" scripts
    if (editScript.once && !editScript.id) {
      if (!confirm('Script has "Run Once" enabled but no ID. This may cause issues. Save anyway?')) return
    }

    // Validate all actions
    const invalidActions = editScript.actions.filter(a => !validateAction(a).valid)
    if (invalidActions.length > 0) {
      if (!confirm(`${invalidActions.length} action(s) have validation errors. Save anyway?`)) return
    }

    editScript.condition = condition
    // Clean up undefined values
    if (editScript.tile && (editScript.tile.x === undefined && editScript.tile.y === undefined)) {
      delete editScript.tile
    }
    if (onSave) onSave(editScript)
  })

  cancelBtn.addEventListener('click', () => {
    if (onCancel) onCancel()
  })

  deleteBtn.addEventListener('click', () => {
    if (confirm('Delete this script permanently?')) {
      if (onDelete) onDelete(script.id)
    }
  })

  eventHelpBtn.addEventListener('click', () => {
    showEventReference()
  })

  // Initial render
  updateEventArgs()
  renderActions()

  // --- Helpers ---

  function showActionTypePicker() {
    const modal = document.createElement('div')
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `
    modal.innerHTML = `
      <div style="
        background: #252526;
        border: 1px solid #333;
        border-radius: 6px;
        padding: 16px;
        width: 400px;
        max-height: 80vh;
        overflow-y: auto;
        color: #e0e0e0;
      ">
        <h4 style="margin: 0 0 12px 0;">Add Action</h4>
        <input type="text" id="action-type-search" placeholder="Search actions..." style="
          width: 100%;
          padding: 8px;
          background: #3c3c3c;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          margin-bottom: 12px;
          box-sizing: border-box;
        ">
        <div id="action-type-list" style="display: grid; gap: 4px;"></div>
        <button id="action-type-cancel" style="
          margin-top: 16px;
          width: 100%;
          padding: 8px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
        ">Cancel</button>
      </div>
    `

    const list = modal.querySelector('#action-type-list')
    const search = modal.querySelector('#action-type-search')
    const cancel = modal.querySelector('#action-type-cancel')

    function renderActionTypes(filter = '') {
      list.innerHTML = ''
      const filtered = Object.values(ACTION_SCHEMAS).filter(a =>
        a.type.toLowerCase().includes(filter.toLowerCase()) ||
        a.label.toLowerCase().includes(filter.toLowerCase()) ||
        a.description.toLowerCase().includes(filter.toLowerCase())
      )

      for (const schema of filtered) {
        const btn = document.createElement('button')
        btn.style.cssText = `
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 10px;
          background: #2d2d2d;
          border: 1px solid #3a3a3a;
          border-radius: 3px;
          color: #e0e0e0;
          text-align: left;
          cursor: pointer;
          font-size: 12px;
        `
        btn.innerHTML = `
          <strong>${schema.label}</strong>
          <span style="font-size: 11px; color: #888;">${schema.desc}</span>
        `
        btn.addEventListener('click', () => {
          editScript.actions.push({ type: schema.type })
          renderActions()
          document.body.removeChild(modal)
        })
        list.appendChild(btn)
      }
    }

    search.addEventListener('input', (e) => renderActionTypes(e.target.value))
    cancel.addEventListener('click', () => document.body.removeChild(modal))
    modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal) })

    renderActionTypes()
    document.body.appendChild(modal)
    search.focus()
  }

  function showEventReference() {
    const modal = document.createElement('div')
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `
    modal.innerHTML = `
      <div style="
        background: #252526;
        border: 1px solid #333;
        border-radius: 6px;
        padding: 16px;
        width: 500px;
        max-height: 80vh;
        overflow-y: auto;
        color: #e0e0e0;
      ">
        <h4 style="margin: 0 0 12px 0;">Event Reference</h4>
        <div style="display: grid; gap: 8px;">
          ${BUILTIN_EVENTS.map(e => `
            <div style="background: #2d2d2d; border: 1px solid #3a3a3a; border-radius: 3px; padding: 10px;">
              <strong>${e.name} <code style="color: #888;">(${e.id})</code></strong>
              <p style="margin: 4px 0 0 0; font-size: 12px; color: #aaa;">${e.desc}</p>
              ${e.args && e.args.length > 0 ? `
                <ul style="margin: 4px 0 0 0; padding-left: 20px; font-size: 11px; color: #888;">
                  ${e.args.map(a => `<li><code>${a.name}</code> (${a.type}): ${a.desc}</li>`).join('')}
                </ul>
              ` : ''}
            </div>
          `).join('')}
        </div>
        <button id="event-ref-close" style="
          margin-top: 16px;
          width: 100%;
          padding: 8px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
        ">Close</button>
      </div>
    `
    modal.querySelector('#event-ref-close').addEventListener('click', () => document.body.removeChild(modal))
    modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal) })
    document.body.appendChild(modal)
  }

  function escapeHtml(text) {
    if (text === null || text === undefined) return ''
    return String(text)
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, "\"")
      .replace(/'/g, "'")
  }

  // Public API
  panel.refresh = () => {
    renderActions()
    updateEventArgs()
  }

  panel.show = () => { panel.style.display = 'flex' }
  panel.hide = () => { panel.style.display = 'none' }

  // Trigger initial validation
  conditionTextarea.dispatchEvent(new Event('input'))

  return panel
}