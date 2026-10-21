/**
 * Panel 1: Map Scripts Manager (replaces Script File Manager)
 *
 * Works directly with map._scripts array (embedded in map file).
 * No separate script files - scripts are part of the map JSON.
 */

import { scriptState } from './scriptState.js';
import { cleanScriptForSave } from '../map.js';
import { showJsonModal, createJsonButton, createPanelHeader } from './scriptJsonViewer.js';

/**
 * Create the Map Scripts Manager panel
 * @param {Object} deps - Dependencies
 * @param {Object} deps.map - Current map object
 * @returns {HTMLElement}
 */
export function createMapScriptManager({ map }) {
  const panel = document.createElement('div');
  panel.id = 'map-script-manager';
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
    <div id="map-script-header"></div>
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
      <span id="map-script-status" style="color: #666;">Scripts embedded in map file</span>
    </div>
  `;

  const headerContainer = panel.querySelector('#map-script-header');
  const searchInput = panel.querySelector('#event-search');
  const list = panel.querySelector('#event-list');
  const countEl = panel.querySelector('#event-count');
  const statusEl = panel.querySelector('#map-script-status');

  let filterText = '';

  // --- Header ---
  function buildHeader() {
    const actions = [
      { label: '💾 Save Map', onClick: () => saveMapWithScripts(map), primary: true },
    ];

    headerContainer.innerHTML = '';
    headerContainer.appendChild(createPanelHeader('Map Scripts', actions));
  }

  // --- Event List Rendering ---
  function renderEvents() {
    // Get events from map._scripts
    let events = map._scripts ? [...map._scripts] : [];

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
      showJsonModal(events.map(cleanEventForJSON), `${map.id || 'Map'} - All Events`);
    }, 'Show JSON for all map events');
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
      emptyMsg.textContent = filterText ? 'No matching events' : 'No events yet. Click "Add" to create one.';
      list.appendChild(emptyMsg);
    } else {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        // Find original index in map._scripts
        const originalIndex = map._scripts ? map._scripts.findIndex(e => e === event) : -1;
        if (originalIndex >= 0) {
          const li = createEventRow(event, originalIndex);
          list.appendChild(li);
        }
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
      background: #2d2d2d;
      border: 1px solid #3a3a3a;
      border-radius: 4px;
      gap: 8px;
      transition: background 0.1s, border-color 0.1s;
    `;

    const displayName = event.id ?? 'Unnamed Event';
    const eventName = event.on ?? 'unknown';
    const hasCondition = event.condition && event.condition.trim() !== '';
    const actionCount = event.actions?.length ?? 0;

    li.innerHTML = `
      <div class="event-info" style="flex: 1; min-width: 0;">
        <div class="event-name" style="
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
        li.style.background = '#2d2d2d';
        li.style.borderColor = '#3a3a3a';
      }
    });

    // Event listeners
    li.querySelector('.event-edit-btn').addEventListener('click', () => {
      scriptState.goToEventEditor(index);
    });

    li.querySelector('.event-delete-btn').addEventListener('click', () => {
      if (confirm('Delete this event?')) {
        if (map._scripts) {
          map._scripts.splice(index, 1);
        }
        renderEvents();
      }
    });

    return li;
  }

  // --- Clean event for JSON display (omit default/empty values) ---
  function cleanEventForJSON(event) {
    const cleaned = cleanScriptForSave(event);
    cleaned.actions = cleaned.actions.map(cleanActionForJSON);
    return cleaned;
  }

  /**
   * Clean action for JSON display - omit default values
   */
  function cleanActionForJSON(action) {
    const cleaned = { ...action };

    switch (action.type) {
      case 'show_message':
        if (cleaned.duration === 3000 || cleaned.duration === undefined) delete cleaned.duration;
        break;
      case 'set_weather':
        if (cleaned.weather === 'none') { delete cleaned.weather; delete cleaned.intensity; delete cleaned.wind; delete cleaned.transition_secs; }
        else {
          if (cleaned.intensity === 0.6) delete cleaned.intensity;
          if (cleaned.wind === 0) delete cleaned.wind;
          if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs;
        }
        break;
      case 'set_lighting':
        if (cleaned.lighting === 'day') { delete cleaned.lighting; delete cleaned.custom; delete cleaned.transition_secs; }
        else {
          if (!cleaned.transition_secs || cleaned.transition_secs === 0) delete cleaned.transition_secs;
          if (cleaned.lighting !== 'custom') delete cleaned.custom;
        }
        break;
      case 'set_flag':
        if (cleaned.value === true) delete cleaned.value;
        break;
      case 'set_variable':
      case 'add_variable':
      case 'give_item':
      case 'remove_item':
      case 'spawn_item':
        if (cleaned.qty === 1) delete cleaned.qty;
        break;
      case 'spawn_monster':
        if (cleaned.position) {
          if (cleaned.position.x === '' || cleaned.position.x == null) delete cleaned.position.x;
          if (cleaned.position.y === '' || cleaned.position.y == null) delete cleaned.position.y;
          if (!cleaned.position.mark) delete cleaned.position.mark;
          if (Object.keys(cleaned.position).length === 0) {
            delete cleaned.position;
          }
        }
        if (cleaned.x === '' || cleaned.x == null) delete cleaned.x;
        if (cleaned.y === '' || cleaned.y == null) delete cleaned.y;
        if (!cleaned.radius) delete cleaned.radius;
        if (!cleaned.id) delete cleaned.id;
        if (!cleaned.pool) delete cleaned.pool;
        break;
      case 'spawn_npc':
        if (cleaned.flip_x === false) delete cleaned.flip_x;
        break;
      case 'change_map':
        if (!cleaned.mark) delete cleaned.mark;
        if (cleaned.x === '' || cleaned.x == null) delete cleaned.x;
        if (cleaned.y === '' || cleaned.y == null) delete cleaned.y;
        break;
      case 'change_tile':
        if (!cleaned.mark) delete cleaned.mark;
        if (cleaned.x === '' || cleaned.x == null) delete cleaned.x;
        if (cleaned.y === '' || cleaned.y == null) delete cleaned.y;
        break;
      case 'end_scenario':
        if (!cleaned.next) delete cleaned.next;
        break;
      case 'set_question_pool':
        if (!cleaned.pool) delete cleaned.pool;
        break;
    }

    // Clean nested actions
    if (cleaned.type === 'show_choice' && cleaned.choices) {
      cleaned.choices = cleaned.choices.map(c => ({
        ...c,
        actions: c.actions ? c.actions.map(cleanActionForJSON) : undefined
      })).map(c => {
        const cc = { ...c };
        if (!cc.condition || cc.condition.trim() === '') delete cc.condition;
        if (!cc.actions || cc.actions.length === 0) delete cc.actions;
        return cc;
      });
    }

    if (cleaned.type === 'pick_random' && cleaned.choices) {
      cleaned.choices = cleaned.choices.map(c => ({
        ...c,
        actions: c.actions ? c.actions.map(cleanActionForJSON) : undefined
      })).filter(c => c.actions && c.actions.length > 0);
    }

    // Remove empty data object
    if (cleaned.data && Object.keys(cleaned.data).length === 0) delete cleaned.data;

    return cleaned;
  }

  // --- Event Listeners ---
  searchInput.addEventListener('input', (e) => {
    filterText = e.target.value;
    renderEvents();
  });

  // --- Public API ---
  panel.show = () => {
    panel.style.display = 'flex';
    buildHeader();
    renderEvents();
  };

  panel.hide = () => { panel.style.display = 'none' };

  panel.refresh = renderEvents;

  // Initial header build
  buildHeader();

  return panel;
}

// Helper to save the map (triggers the editor's save function)
function saveMapWithScripts(map) {
  // Dispatch a custom event that editor.js listens for
  window.dispatchEvent(new CustomEvent('save-map-with-scripts', { detail: { map } }));
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