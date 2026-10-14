/**
 * Script List Panel — Displays list of scripts for current map
 * Allows creating, editing, deleting, and enabling/disabling scripts
 * Supports independent script file selection and saving
 */

import {
  getScriptsForMap,
  addScript,
  removeScript,
  updateScript
} from '../map.js'
import {
  loadScriptFile,
  saveScriptFile,
  loadScriptFileLocal,
  getScriptFilesInfo,
  createScriptFileForMap
} from './scriptStorage.js'

const STORAGE_KEY = 'quintivium_script_file_'

/**
 * Create the Script List panel HTML element
 * @param {Object} deps - Dependencies
 * @param {Object} deps.map - Current map object
 * @param {Function} deps.onEdit - Callback when edit requested (script)
 * @param {Function} deps.onDelete - Callback when delete requested (scriptId)
 * @param {Function} deps.onToggle - Callback when enabled toggled (script, enabled)
 * @returns {HTMLElement}
 */
export function createScriptListPanel({ map, onEdit, onDelete, onToggle }) {
  const panel = document.createElement('div')
  panel.id = 'script-list-panel'
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

  // Get stored script file for this map
  const storedFile = localStorage.getItem(STORAGE_KEY + (map.id ?? 'default'))
  let currentScriptFile = storedFile
  let currentScripts = []

  panel.innerHTML = `
    <div class="panel-header" style="
      padding: 10px 12px;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #252526;
      flex-wrap: wrap;
      gap: 8px;
    ">
      <h3 style="margin: 0; font-size: 14px; font-weight: 600;">Scripts</h3>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <select id="script-file-select" style="
          padding: 4px 8px;
          background: #3c3c3c;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          font-size: 12px;
          min-width: 200px;
        ">
          <option value="">-- Select Script File --</option>
        </select>
        <input type="file" id="script-file-load" accept=".json" style="display: none;">
        <button id="script-file-browse" class="btn" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
        ">📁 Load File</button>
        <button id="script-file-save" class="btn btn-primary" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
          display: none;
        ">💾 Save File</button>
        <button id="script-list-new-btn" class="btn btn-primary" style="
          padding: 4px 10px;
          font-size: 12px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
        ">+ New Script</button>
      </div>
    </div>
    <div class="panel-toolbar" style="
      padding: 8px 12px;
      border-bottom: 1px solid #333;
      background: #2d2d2d;
      display: flex;
      gap: 8px;
      align-items: center;
    ">
      <input type="text" id="script-list-search" placeholder="Filter scripts..." style="
        flex: 1;
        padding: 4px 8px;
        background: #3c3c3c;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        font-size: 12px;
      ">
      <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; color: #aaa;">
        <input type="checkbox" id="script-list-show-disabled"> Show Disabled
      </label>
    </div>
    <div class="script-list-container" style="
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    ">
      <ul id="script-list" style="
        list-style: none;
        margin: 0;
        padding: 0;
      "></ul>
    </div>
    <div class="panel-footer" style="
      padding: 8px 12px;
      border-top: 1px solid #333;
      background: #252526;
      font-size: 11px;
      color: #888;
      display: flex;
      justify-content: space-between;
      align-items: center;
    ">
      <span id="script-list-count">0 scripts</span>
      <span id="script-file-status" style="color: #666;"></span>
    </div>
  `

  const list = panel.querySelector('#script-list')
  const searchInput = panel.querySelector('#script-list-search')
  const showDisabledCheckbox = panel.querySelector('#script-list-show-disabled')
  const newBtn = panel.querySelector('#script-list-new-btn')
  const countEl = panel.querySelector('#script-list-count')
  const fileSelect = panel.querySelector('#script-file-select')
  const fileLoadInput = panel.querySelector('#script-file-load')
  const fileBrowseBtn = panel.querySelector('#script-file-browse')
  const fileSaveBtn = panel.querySelector('#script-file-save')
  const fileStatusEl = panel.querySelector('#script-file-status')

  let filterText = ''
  let showDisabled = false

  // Populate file select dropdown
  async function populateFileSelect() {
    try {
      const info = await getScriptFilesInfo()
      fileSelect.innerHTML = '<option value="">-- Select Script File --</option>'

      const existingFiles = new Set(info.map(e => e.file))

      for (const entry of info) {
        const label = entry.map ? `${entry.file} (map: ${entry.map})` : entry.file
        const option = document.createElement('option')
        option.value = entry.file
        option.textContent = `${label} [${entry.scriptCount} scripts]`
        if (entry.file === currentScriptFile) option.selected = true
        fileSelect.appendChild(option)
      }

      // Also check for convention-based file for current map (e.g., cave_1_script.json)
      // even if not in scenario.json
      if (map.id) {
        const conventionFile = `${map.id}_script.json`
        if (!existingFiles.has(conventionFile)) {
          // Try to fetch it to see if it exists
          try {
            const res = await fetch(`../scenarios/mystic_island_PL/${conventionFile}`)
            if (res.ok) {
              const scripts = await res.json()
              const option = document.createElement('option')
              option.value = conventionFile
              option.textContent = `${conventionFile} (map: ${map.id}) [${scripts.length} scripts]`
              if (conventionFile === currentScriptFile) option.selected = true
              fileSelect.appendChild(option)
              existingFiles.add(conventionFile)
            }
          } catch (e) {
            // File doesn't exist, that's fine
          }
        }

        // Add option to create new file for current map
        const createOption = document.createElement('option')
        createOption.value = '__create_new__'
        createOption.textContent = `➕ Create ${map.id}_script.json`
        fileSelect.appendChild(createOption)
      }

      // Add option to load from local file
      const localOption = document.createElement('option')
      localOption.value = '__load_local__'
      localOption.textContent = '📁 Load from local file...'
      fileSelect.appendChild(localOption)
    } catch (e) {
      console.warn('[ScriptList] Failed to populate file select:', e)
    }
  }

  // Load scripts from current file
  async function loadScripts() {
    if (!currentScriptFile) {
      currentScripts = []
      render()
      return
    }

    try {
      currentScripts = await loadScriptFile(currentScriptFile)
      fileStatusEl.textContent = `Loaded: ${currentScriptFile}`
      fileStatusEl.style.color = '#88cc88'
    } catch (e) {
      console.error('[ScriptList] Failed to load scripts:', e)
      currentScripts = []
      fileStatusEl.textContent = `Error loading ${currentScriptFile}`
      fileStatusEl.style.color = '#ff8888'
    }
    render()
  }

  // Save scripts to current file
  async function saveScripts() {
    if (!currentScriptFile) {
      alert('No script file selected. Please select or create a script file first.')
      return
    }

    try {
      const success = await saveScriptFile(currentScriptFile, currentScripts)
      if (success) {
        fileStatusEl.textContent = `Saved: ${currentScriptFile}`
        fileStatusEl.style.color = '#88cc88'
        // Refresh file list to update script count
        populateFileSelect()
      } else {
        fileStatusEl.textContent = `Failed to save ${currentScriptFile}`
        fileStatusEl.style.color = '#ff8888'
      }
    } catch (e) {
      console.error('[ScriptList] Failed to save scripts:', e)
      fileStatusEl.textContent = `Error saving ${currentScriptFile}`
      fileStatusEl.style.color = '#ff8888'
    }
  }

  // Create new script file for current map
  async function createNewScriptFile() {
    if (!map.id) {
      alert('Map has no ID. Please save the map first.')
      return
    }

    try {
      const fileName = await createScriptFileForMap(map.id)
      currentScriptFile = fileName
      localStorage.setItem(STORAGE_KEY + map.id, fileName)
      await populateFileSelect()
      fileSelect.value = fileName
      currentScripts = []
      render()
      fileStatusEl.textContent = `Created: ${fileName}`
      fileStatusEl.style.color = '#88cc88'
    } catch (e) {
      console.error('[ScriptList] Failed to create script file:', e)
      alert('Failed to create script file')
    }
  }

  // Handle local file load
  async function handleLocalFileLoad(file) {
    try {
      const scripts = await loadScriptFileLocal(file)
      currentScripts = scripts
      // Use the file name as the script file name (without path)
      currentScriptFile = file.name
      localStorage.setItem(STORAGE_KEY + (map.id ?? 'default'), currentScriptFile)
      await populateFileSelect()
      fileSelect.value = currentScriptFile
      render()
      fileStatusEl.textContent = `Loaded from local: ${file.name}`
      fileStatusEl.style.color = '#88cc88'
      fileSaveBtn.style.display = 'inline-flex'
    } catch (e) {
      console.error('[ScriptList] Failed to load local file:', e)
      alert('Failed to load file: ' + e.message)
    }
  }

  function render() {
    let scripts = [...currentScripts]

    if (!showDisabled) {
      scripts = scripts.filter(s => s.enabled !== false)
    }

    if (filterText) {
      const lower = filterText.toLowerCase()
      scripts = scripts.filter(s =>
        (s.name ?? '').toLowerCase().includes(lower) ||
        (s.on ?? s.event ?? '').toLowerCase().includes(lower) ||
        (s.id ?? '').toLowerCase().includes(lower)
      )
    }

    list.innerHTML = ''

    if (scripts.length === 0) {
      const emptyMsg = document.createElement('li')
      emptyMsg.style.cssText = `
        padding: 20px;
        text-align: center;
        color: #666;
        font-style: italic;
      `
      if (!currentScriptFile) {
        emptyMsg.textContent = 'No script file selected. Choose a file from the dropdown above.'
      } else {
        emptyMsg.textContent = filterText ? 'No matching scripts' : 'No scripts yet. Click "New Script" to create one.'
      }
      list.appendChild(emptyMsg)
    } else {
      for (const script of scripts) {
        const li = document.createElement('li')
        li.style.cssText = `
          display: flex;
          align-items: center;
          padding: 8px 10px;
          margin: 2px 0;
          background: ${script.enabled === false ? '#2a2a2a' : '#2d2d2d'};
          border: 1px solid ${script.enabled === false ? '#333' : '#3a3a3a'};
          border-radius: 4px;
          gap: 8px;
          transition: background 0.1s, border-color 0.1s;
        `
        // Use name, or id, or 'Unnamed Script'
        const displayName = script.name ?? script.id ?? 'Unnamed Script'
        // Use on (engine format) or event (legacy)
        const eventName = script.on ?? script.event ?? 'unknown'
        const hasCondition = script.condition ?? script.conditions ?? ''

        li.innerHTML = `
          <input type="checkbox" class="script-enabled" data-id="${script.id}" ${script.enabled !== false ? 'checked' : ''} style="
            width: 16px;
            height: 16px;
            accent-color: #0e639c;
            flex-shrink: 0;
          ">
          <div class="script-info" style="flex: 1; min-width: 0;">
            <div class="script-name" style="
              font-weight: 500;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              ${script.enabled === false ? 'color: #888;' : ''}
            ">${escapeHtml(displayName)}</div>
            <div class="script-meta" style="
              font-size: 11px;
              color: #888;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            ">
              Event: ${escapeHtml(eventName)} • ${script.actions?.length ?? 0} action(s)${hasCondition ? ' • Has condition' : ''}
            </div>
          </div>
          <button class="script-edit-btn" data-id="${script.id}" title="Edit" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
          ">Edit</button>
          <button class="script-delete-btn" data-id="${script.id}" title="Delete" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
          ">Delete</button>
        `
        list.appendChild(li)
      }
    }

    countEl.textContent = `${scripts.length} script${scripts.length !== 1 ? 's' : ''}`
  }

  // Escape HTML helper
  function escapeHtml(text) {
    if (text === null || text === undefined) return ''
    return String(text)
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, "\"")
      .replace(/'/g, "'")
  }

  // Event listeners
  newBtn.addEventListener('click', () => {
    if (!currentScriptFile) {
      alert('Please select a script file first.')
      return
    }
    const newScript = {
      id: crypto.randomUUID(),
      name: 'New Script',
      on: 'tile_enter',  // Default to tile_enter as common use case
      once: false,
      condition: '',
      actions: [],
      enabled: true
    }
    currentScripts.push(newScript)
    render()
    if (onEdit) onEdit(newScript)
  })

  searchInput.addEventListener('input', (e) => {
    filterText = e.target.value
    render()
  })

  showDisabledCheckbox.addEventListener('change', (e) => {
    showDisabled = e.target.checked
    render()
  })

  fileSelect.addEventListener('change', async (e) => {
    const value = e.target.value
    if (value === '__create_new__') {
      await createNewScriptFile()
    } else if (value === '__load_local__') {
      fileLoadInput.click()
    } else if (value) {
      currentScriptFile = value
      localStorage.setItem(STORAGE_KEY + (map.id ?? 'default'), value)
      fileSaveBtn.style.display = 'inline-flex'
      await loadScripts()
    } else {
      currentScriptFile = null
      currentScripts = []
      render()
      fileSaveBtn.style.display = 'none'
      fileStatusEl.textContent = ''
    }
  })

  fileLoadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (file) {
      await handleLocalFileLoad(file)
    }
    // Reset input so same file can be loaded again
    e.target.value = ''
    // Reset dropdown selection
    fileSelect.value = currentScriptFile || ''
  })

  fileBrowseBtn.addEventListener('click', () => {
    fileLoadInput.click()
  })

  fileSaveBtn.addEventListener('click', saveScripts)

  list.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.script-edit-btn')
    const deleteBtn = e.target.closest('.script-delete-btn')
    const checkbox = e.target.closest('.script-enabled')

    if (editBtn) {
      const scriptId = editBtn.dataset.id
      const script = currentScripts.find(s => s.id === scriptId)
      if (script && onEdit) onEdit(script)
    } else if (deleteBtn) {
      const scriptId = deleteBtn.dataset.id
      if (confirm('Delete this script?')) {
        currentScripts = currentScripts.filter(s => s.id !== scriptId)
        render()
        if (onDelete) onDelete(scriptId)
      }
    } else if (checkbox) {
      const scriptId = checkbox.dataset.id
      const script = currentScripts.find(s => s.id === scriptId)
      if (script) {
        const enabled = checkbox.checked
        script.enabled = enabled
        render()
        if (onToggle) onToggle(script, enabled)
      }
    }
  })

  // Hover effects
  list.addEventListener('mouseover', (e) => {
    const li = e.target.closest('li')
    if (li && !li.querySelector('.empty-msg')) {
      li.style.background = '#3a3a3a'
      li.style.borderColor = '#444'
    }
  })

  list.addEventListener('mouseout', (e) => {
    const li = e.target.closest('li')
    if (li && !li.querySelector('.empty-msg')) {
      const scriptId = li.querySelector('.script-edit-btn')?.dataset.id
      const script = scriptId ? currentScripts.find(s => s.id === scriptId) : null
      li.style.background = script?.enabled === false ? '#2a2a2a' : '#2d2d2d'
      li.style.borderColor = script?.enabled === false ? '#333' : '#3a3a3a'
    }
  })

  // Public API
  panel.refresh = render
  panel.show = () => {
    panel.style.display = 'flex'
    // Populate file select on show
    populateFileSelect()
    // Load scripts if file is already selected
    if (currentScriptFile) {
      loadScripts()
    }
  }
  panel.hide = () => { panel.style.display = 'none' }

  // Update a script in the internal array by ID
  panel.updateScript = (scriptId, updates) => {
    const idx = currentScripts.findIndex(s => s.id === scriptId)
    if (idx !== -1) {
      currentScripts[idx] = { ...currentScripts[idx], ...updates }
      render()
      return true
    }
    return false
  }

  // Get current scripts array (for saving)
  panel.getScripts = () => currentScripts

  // Get current script file
  panel.getScriptFile = () => currentScriptFile

  // Save scripts to current file
  panel.saveScripts = saveScripts

  // Initial render
  render()

  return panel
}