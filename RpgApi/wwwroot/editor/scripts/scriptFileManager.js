/**
 * Panel 1: Script File Manager
 *
 * Displays:
 * - File selector dropdown (load/create script files)
 * - Event list for current file with Add/Edit/Delete
 * - Show JSON button for entire file
 */

import { scriptState } from './scriptState.js';
import { cleanScriptForSave } from '../map.js';
import { showJsonModal, createJsonButton, createPanelHeader } from './scriptJsonViewer.js';
import { getScriptFilesInfo, loadScriptFile, saveScriptFile, createScriptFileForMap } from './scriptStorage.js';

const STORAGE_KEY = 'quintivium_script_file_';

/**
 * Create the Script File Manager panel
 * @param {Object} deps - Dependencies
 * @param {Object} deps.map - Current map object
 * @returns {HTMLElement}
 */
export function createScriptFileManager({ map }) {
  const panel = document.createElement('div');
  panel.id = 'script-file-manager';
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

  // Get stored script file for this map
  const storedFile = localStorage.getItem(STORAGE_KEY + (map.id ?? 'default'));
  let currentScriptFile = storedFile;

  panel.innerHTML = `
    <div id="file-manager-header"></div>
    <div class="panel-toolbar" style="
      padding: 8px 12px;
      border-bottom: 1px solid #333;
      background: #2d2d2d;
      display: flex;
      gap: 8px;
      align-items: center;
    ">
      <input type="text" id="event-search" placeholder="Filter events..." style="
        flex: 1;
        padding: 4px 8px;
        background: #3c3c3c;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        font-size: 12px;
      ">
      <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; color: #aaa;">
        <input type="checkbox" id="show-disabled-events"> Show Disabled
      </label>
    </div>
    <div class="event-list-container" style="
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    ">
      <ul id="event-list" style="
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
      <span id="event-count">0 events</span>
      <span id="file-status" style="color: #666;"></span>
    </div>
  `;

  const headerContainer = panel.querySelector('#file-manager-header');
  const searchInput = panel.querySelector('#event-search');
  const showDisabledCheckbox = panel.querySelector('#show-disabled-events');
  const list = panel.querySelector('#event-list');
  const countEl = panel.querySelector('#event-count');
  const statusEl = panel.querySelector('#file-status');

  let filterText = '';
  let showDisabled = false;

  // --- Header with file controls ---
  function buildHeader() {
    const actions = [
      { label: '📁 Load File', onClick: () => fileLoadInput.click() },
      { label: '➕ New File', onClick: createNewScriptFile, primary: true },
      { label: '💾 Save', onClick: saveCurrentFile, primary: true },
    ];

    headerContainer.innerHTML = '';
    headerContainer.appendChild(createPanelHeader('Script File Manager', actions));

    // File selector row
    const fileRow = document.createElement('div');
    fileRow.style.cssText = `
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 0 12px 10px;
      background: #252526;
      border-bottom: 1px solid #333;
      flex-wrap: wrap;
    `;
    fileRow.innerHTML = `
      <select id="script-file-select" style="
        flex: 1;
        min-width: 200px;
        padding: 4px 8px;
        background: #3c3c3c;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        font-size: 12px;
      ">
        <option value="">-- Select Script File --</option>
      </select>
      <input type="file" id="script-file-load" accept=".json" style="display: none;">
    `;
    headerContainer.appendChild(fileRow);

    const fileSelect = fileRow.querySelector('#script-file-select');
    const fileLoadInput = fileRow.querySelector('#script-file-load');

    // Populate file select
    populateFileSelect(fileSelect);

    fileSelect.addEventListener('change', async (e) => {
      const value = e.target.value;
      if (value === '__create_new__') {
        await createNewScriptFile();
      } else if (value === '__load_local__') {
        fileLoadInput.click();
      } else if (value) {
        currentScriptFile = value;
        localStorage.setItem(STORAGE_KEY + (map.id ?? 'default'), value);
        await loadCurrentFile();
      } else {
        currentScriptFile = null;
        scriptState.currentEvents = [];
        renderEvents();
        statusEl.textContent = '';
      }
    });

    fileLoadInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        await handleLocalFileLoad(file);
      }
      e.target.value = '';
      fileSelect.value = currentScriptFile || '';
    });
  }

  // --- File Operations ---
  async function populateFileSelect(selectEl) {
    try {
      const info = await getScriptFilesInfo();
      selectEl.innerHTML = '<option value="">-- Select Script File --</option>';

      const existingFiles = new Set(info.map(e => e.file));

      for (const entry of info) {
        const label = entry.map ? `${entry.file} (map: ${entry.map})` : entry.file;
        const option = document.createElement('option');
        option.value = entry.file;
        option.textContent = `${label} [${entry.scriptCount} events]`;
        if (entry.file === currentScriptFile) option.selected = true;
        selectEl.appendChild(option);
      }

      // Convention-based file for current map
      if (map.id) {
        const conventionFile = `${map.id}_script.json`;
        if (!existingFiles.has(conventionFile)) {
          try {
            const res = await fetch(`../scenarios/mystic_island_PL/${conventionFile}`);
            if (res.ok) {
              const scripts = await res.json();
              const option = document.createElement('option');
              option.value = conventionFile;
              option.textContent = `${conventionFile} (map: ${map.id}) [${scripts.length} events]`;
              if (conventionFile === currentScriptFile) option.selected = true;
              selectEl.appendChild(option);
              existingFiles.add(conventionFile);
            }
          } catch (e) {
            // File doesn't exist
          }
        }

        // Create new option
        const createOption = document.createElement('option');
        createOption.value = '__create_new__';
        createOption.textContent = `➕ Create ${map.id}_script.json`;
        selectEl.appendChild(createOption);
      }

      // Load local option
      const localOption = document.createElement('option');
      localOption.value = '__load_local__';
      localOption.textContent = '📁 Load from local file...';
      selectEl.appendChild(localOption);

    } catch (e) {
      console.warn('[ScriptFileManager] Failed to populate file select:', e);
    }
  }

  async function loadCurrentFile() {
    if (!currentScriptFile) return;

    try {
      scriptState.currentFile = currentScriptFile;
      scriptState.currentEvents = await loadScriptFile(currentScriptFile);
      statusEl.textContent = `Loaded: ${currentScriptFile}`;
      statusEl.style.color = '#88cc88';
    } catch (e) {
      console.error('[ScriptFileManager] Failed to load scripts:', e);
      scriptState.currentEvents = [];
      statusEl.textContent = `Error loading ${currentScriptFile}`;
      statusEl.style.color = '#ff8888';
    }
    renderEvents();
  }

  async function saveCurrentFile() {
    if (!currentScriptFile) {
      alert('No script file selected.');
      return;
    }

    try {
      // Clean events before saving
      const cleanedEvents = scriptState.currentEvents.map(cleanEventForSave);
      const success = await saveScriptFile(currentScriptFile, cleanedEvents);
      if (success) {
        statusEl.textContent = `Saved: ${currentScriptFile}`;
        statusEl.style.color = '#88cc88';
        await populateFileSelect(headerContainer.querySelector('#script-file-select'));
      } else {
        statusEl.textContent = `Failed to save ${currentScriptFile}`;
        statusEl.style.color = '#ff8888';
      }
    } catch (e) {
      console.error('[ScriptFileManager] Failed to save scripts:', e);
      statusEl.textContent = `Error saving ${currentScriptFile}`;
      statusEl.style.color = '#ff8888';
    }
  }

  async function createNewScriptFile() {
    if (!map.id) {
      alert('Map has no ID. Please save the map first.');
      return;
    }

    try {
      const fileName = await createScriptFileForMap(map.id);
      currentScriptFile = fileName;
      localStorage.setItem(STORAGE_KEY + map.id, fileName);
      await populateFileSelect(headerContainer.querySelector('#script-file-select'));
      headerContainer.querySelector('#script-file-select').value = fileName;
      scriptState.currentEvents = [];
      renderEvents();
      statusEl.textContent = `Created: ${fileName}`;
      statusEl.style.color = '#88cc88';
    } catch (e) {
      console.error('[ScriptFileManager] Failed to create script file:', e);
      alert('Failed to create script file');
    }
  }

  async function handleLocalFileLoad(file) {
    try {
      const text = await file.text();
      const scripts = JSON.parse(text);
      scriptState.currentEvents = Array.isArray(scripts) ? scripts : [];
      currentScriptFile = file.name;
      localStorage.setItem(STORAGE_KEY + (map.id ?? 'default'), currentScriptFile);
      await populateFileSelect(headerContainer.querySelector('#script-file-select'));
      headerContainer.querySelector('#script-file-select').value = currentScriptFile;
      renderEvents();
      statusEl.textContent = `Loaded from local: ${file.name}`;
      statusEl.style.color = '#88cc88';
    } catch (e) {
      console.error('[ScriptFileManager] Failed to load local file:', e);
      alert('Failed to load file: ' + e.message);
    }
  }

  // --- Event List Rendering ---
  function renderEvents() {
    let events = [...scriptState.currentEvents];

    if (!showDisabled) {
      events = events.filter(e => e.enabled !== false);
    }

    if (filterText) {
      const lower = filterText.toLowerCase();
      events = events.filter(e =>
        (e.id ?? '').toLowerCase().includes(lower) ||
        (e.on ?? '').toLowerCase().includes(lower) ||
        (e.name ?? '').toLowerCase().includes(lower)
      );
    }

    list.innerHTML = '';

    // Header row: [Add] [Show JSON]
    const headerRow = document.createElement('li');
    headerRow.style.cssText = `
      display: flex;
      align-items: center;
      padding: 8px 10px;
      margin-bottom: 4px;
      background: #252526;
      border: 1px solid #333;
      border-radius: 4px;
      gap: 8px;
      font-weight: 600;
      font-size: 12px;
    `;
    headerRow.innerHTML = `
      <span style="flex: 1; color: #888;">Event ID</span>
      <span style="width: 120px; color: #888; text-align: center;">Event Type</span>
      <span style="width: 80px; color: #888; text-align: center;">Actions</span>
      <div style="display: flex; gap: 4px;">
        <button id="add-event-btn" title="Add Event" style="
          padding: 4px 10px;
          font-size: 11px;
          background: #0e639c;
          border: none;
          border-radius: 3px;
          color: white;
          cursor: pointer;
        ">➕ Add</button>
      </div>
    `;
    list.appendChild(headerRow);

    // Add JSON button to header
    const jsonBtn = createJsonButton(() => {
      showJsonModal(scriptState.getFileJSON(), `${currentScriptFile || 'Script File'} - All Events`);
    }, 'Show JSON for entire file');
    jsonBtn.style.marginLeft = '8px';
    headerRow.querySelector('div').appendChild(jsonBtn);

    headerRow.querySelector('#add-event-btn').addEventListener('click', () => {
      scriptState.addEvent();
    });

    if (events.length === 0) {
      const emptyMsg = document.createElement('li');
      emptyMsg.style.cssText = `
        padding: 20px;
        text-align: center;
        color: #666;
        font-style: italic;
      `;
      if (!currentScriptFile) {
        emptyMsg.textContent = 'No script file selected. Choose a file from the dropdown above.';
      } else {
        emptyMsg.textContent = filterText ? 'No matching events' : 'No events yet. Click "Add" to create one.';
      }
      list.appendChild(emptyMsg);
    } else {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        // Find original index in scriptState.currentEvents
        const originalIndex = scriptState.currentEvents.findIndex(e => e === event);
        const li = createEventRow(event, originalIndex);
        list.appendChild(li);
      }
    }

    countEl.textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;
  }

  function createEventRow(event, index) {
    const li = document.createElement('li');
    li.style.cssText = `
      display: flex;
      align-items: center;
      padding: 8px 10px;
      margin: 2px 0;
      background: ${event.enabled === false ? '#2a2a2a' : '#2d2d2d'};
      border: 1px solid ${event.enabled === false ? '#333' : '#3a3a3a'};
      border-radius: 4px;
      gap: 8px;
      transition: background 0.1s, border-color 0.1s;
    `;

    const displayName = event.id ?? 'Unnamed Event';
    const eventName = event.on ?? 'unknown';
    const hasCondition = event.condition && event.condition.trim() !== '';
    const actionCount = event.actions?.length ?? 0;

    li.innerHTML = `
      <input type="checkbox" class="event-enabled" data-index="${index}" ${event.enabled !== false ? 'checked' : ''} style="
        width: 16px;
        height: 16px;
        accent-color: #0e639c;
        flex-shrink: 0;
      ">
      <div class="event-info" style="flex: 1; min-width: 0;">
        <div class="event-name" style="
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          ${event.enabled === false ? 'color: #888;' : ''}
        ">${escapeHtml(displayName)}</div>
        <div class="event-meta" style="
          font-size: 11px;
          color: #888;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        ">
          Event: ${escapeHtml(eventName)} • ${actionCount} action(s)${hasCondition ? ' • Has condition' : ''}
        </div>
      </div>
      <div style="width: 120px; text-align: center; font-size: 11px; color: #aaa;">${escapeHtml(eventName)}</div>
      <div style="width: 80px; text-align: center; font-size: 11px; color: #aaa;">${actionCount}</div>
      <div style="display: flex; gap: 4px;">
        <button class="event-edit-btn" data-index="${index}" title="Edit" style="
          padding: 4px 8px;
          font-size: 11px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
        ">✎</button>
        <button class="event-delete-btn" data-index="${index}" title="Delete" style="
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

    // Hover effects
    li.addEventListener('mouseover', () => {
      if (!li.querySelector('.empty-msg')) {
        li.style.background = '#3a3a3a';
        li.style.borderColor = '#444';
      }
    });
    li.addEventListener('mouseout', () => {
      if (!li.querySelector('.empty-msg')) {
        li.style.background = event.enabled === false ? '#2a2a2a' : '#2d2d2d';
        li.style.borderColor = event.enabled === false ? '#333' : '#3a3a3a';
      }
    });

    // Event listeners
    li.querySelector('.event-edit-btn').addEventListener('click', () => {
      scriptState.goToEventEditor(index);
    });

    li.querySelector('.event-delete-btn').addEventListener('click', () => {
      if (confirm('Delete this event?')) {
        scriptState.currentEvents.splice(index, 1);
        renderEvents();
      }
    });

    li.querySelector('.event-enabled').addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      scriptState.currentEvents[idx].enabled = e.target.checked;
      renderEvents();
    });

    return li;
  }

  // --- Clean event for saving (remove editor-only fields) ---
  function cleanEventForSave(event) {
    return cleanScriptForSave(event);
  }

  // --- Event Listeners ---
  searchInput.addEventListener('input', (e) => {
    filterText = e.target.value;
    renderEvents();
  });

  showDisabledCheckbox.addEventListener('change', (e) => {
    showDisabled = e.target.checked;
    renderEvents();
  });

  // --- Public API ---
  panel.show = () => {
    panel.style.display = 'flex';
    buildHeader();
    // Load scripts if file is already selected
    if (currentScriptFile && scriptState.currentEvents.length === 0) {
      loadCurrentFile();
    } else {
      renderEvents();
    }
  };

  panel.hide = () => { panel.style.display = 'none' };

  panel.refresh = renderEvents;

  // Initial header build
  buildHeader();

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