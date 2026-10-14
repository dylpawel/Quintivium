/**
 * Panel: Nested Action Editor
 *
 * For editing nested actions within show_choice choices or pick_random branches.
 * Uses the same action schema system as the main action editor.
 */

import { scriptState } from './scriptState.js';
import { showJsonModal, createJsonButton, createPanelHeader } from './scriptJsonViewer.js';
import {
  ACTION_SCHEMAS,
  ACTION_CATEGORIES,
  getSchema,
  validateAction,
  loadAutocompleteOptions
} from './actionSchemas.js';

/**
 * Create the Nested Action Editor panel
 * @returns {HTMLElement}
 */
export function createScriptNestedActionEditor() {
  const panel = document.createElement('div');
  panel.id = 'script-nested-action-editor';
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
    <div id="nested-action-editor-header"></div>
    <div class="panel-content" style="
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    ">
      <form id="nested-action-form"></form>
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
      <button id="nested-action-cancel-btn" style="
        padding: 6px 16px;
        background: #3a3a3a;
        border: 1px solid #444;
        border-radius: 3px;
        color: #e0e0e0;
        cursor: pointer;
        font-size: 12px;
      ">Cancel</button>
      <div style="display: flex; gap: 8px;">
        <button id="nested-action-test-btn" title="Test Action" style="
          padding: 6px 16px;
          background: #3a3a3a;
          border: 1px solid #444;
          border-radius: 3px;
          color: #e0e0e0;
          cursor: pointer;
          font-size: 12px;
        ">🧪 Test</button>
        <button id="nested-action-save-btn" type="button" style="
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

  const headerContainer = panel.querySelector('#nested-action-editor-header');
  const form = panel.querySelector('#nested-action-form');
  const cancelBtn = panel.querySelector('#nested-action-cancel-btn');
  const testBtn = panel.querySelector('#nested-action-test-btn');
  const saveBtn = panel.querySelector('#nested-action-save-btn');

  let currentSchema = null;
  let autocompleteCache = {};

  // --- Build Form ---
  function buildForm() {
    const nestedItem = scriptState.currentNestedItem;
    const isChoice = scriptState.currentNestedType === 'choices';
    const itemName = isChoice ? 'Choice' : 'Branch';

    if (!nestedItem) {
      form.innerHTML = '<div style="padding: 20px; text-align: center; color: #f88;">No nested item selected</div>';
      return;
    }

    const actions = [
      { label: '← Back to Event', onClick: () => scriptState.popPanel() },
      { label: '🗑 Delete', onClick: deleteNestedItem, danger: true }
    ];
    headerContainer.innerHTML = '';
    headerContainer.appendChild(createPanelHeader(
      `Edit ${itemName} Actions`,
      actions
    ));

    form.innerHTML = `
      <div class="form-section" style="margin-bottom: 16px;">
        <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px;">${itemName} Properties</h3>
        ${isChoice ? buildChoiceProperties(nestedItem) : buildBranchProperties(nestedItem)}
      </div>

      <div class="form-section" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <h3 style="font-size: 12px; font-weight: 600; color: #888; margin: 0; text-transform: uppercase; letter-spacing: 0.5px;">Actions</h3>
          <button type="button" id="add-nested-action-btn" style="
            padding: 4px 10px;
            font-size: 11px;
            background: #0e639c;
            border: none;
            border-radius: 3px;
            color: white;
            cursor: pointer;
          ">➕ Add Action</button>
        </div>
        <div id="nested-actions-list" style="min-height: 100px;"></div>
      </div>
    `;

    renderNestedActionsList(nestedItem);
    attachFormListeners(nestedItem);
  }

  function buildChoiceProperties(choice) {
    return `
      <div class="form-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Label/Text <span style="color: #f88;">*</span></label>
          <input type="text" name="text" required value="${escapeHtml(choice.text ?? '')}" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Text shown on the choice button</div>
        </div>
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Condition (Optional)</label>
          <input type="text" name="condition" value="${escapeHtml(choice.condition ?? '')}" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Condition expression (choice hidden if false)</div>
        </div>
      </div>
    `;
  }

  function buildBranchProperties(branch) {
    return `
      <div class="form-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Label (Optional)</label>
          <input type="text" name="label" value="${escapeHtml(branch.label ?? '')}" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Debug label for this branch</div>
        </div>
        <div class="form-field">
          <label style="display: block; font-size: 11px; color: #aaa; margin-bottom: 4px;">Weight</label>
          <input type="number" name="weight" value="${branch.weight ?? 1}" min="1" step="1" style="
            width: 100%;
            padding: 6px 10px;
            background: #3c3c3c;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            font-size: 12px;
            box-sizing: border-box;
          ">
          <div class="field-hint" style="font-size: 10px; color: #666; margin-top: 2px;">Probability weight (default 1)</div>
        </div>
      </div>
    `;
  }

  function renderNestedActionsList(nestedItem) {
    const container = form.querySelector('#nested-actions-list');
    container.innerHTML = '';

    const actions = nestedItem.actions || [];

    if (actions.length === 0) {
      container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #666; font-style: italic;">
          No actions yet. Click "Add Action" to add one.
        </div>
      `;
      return;
    }

    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; margin: 0; padding: 0;';

    actions.forEach((action, index) => {
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
          <button type="button" class="nested-action-edit-btn" data-index="${index}" title="Edit" style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
          ">✎</button>
          <button type="button" class="nested-action-up-btn" data-index="${index}" title="Move Up" ${index === 0 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === 0 ? '#555' : '#e0e0e0'};
            cursor: ${index === 0 ? 'not-allowed' : 'pointer'};
          ">▲</button>
          <button type="button" class="nested-action-down-btn" data-index="${index}" title="Move Down" ${index === actions.length - 1 ? 'disabled' : ''} style="
            padding: 4px 8px;
            font-size: 11px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: ${index === actions.length - 1 ? '#555' : '#e0e0e0'};
            cursor: ${index === actions.length - 1 ? 'not-allowed' : 'pointer'};
          ">▼</button>
          <button type="button" class="nested-action-delete-btn" data-index="${index}" title="Delete" style="
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

      // Drag and drop
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', index);
        li.style.opacity = '0.5';
      });
      li.addEventListener('dragend', () => li.style.opacity = '1');
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        li.style.borderColor = '#0e639c';
      });
      li.addEventListener('dragleave', () => li.style.borderColor = '#3a3a3a');
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.style.borderColor = '#3a3a3a';
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (fromIndex !== index) {
          moveNestedAction(fromIndex, index);
        }
      });

      li.querySelector('.nested-action-edit-btn').addEventListener('click', () => {
        scriptState.goToActionEditor(index, true); // true = nested
      });

      li.querySelector('.nested-action-up-btn').addEventListener('click', () => {
        moveNestedAction(index, index - 1);
      });

      li.querySelector('.nested-action-down-btn').addEventListener('click', () => {
        moveNestedAction(index, index + 1);
      });

      li.querySelector('.nested-action-delete-btn').addEventListener('click', () => {
        if (confirm('Delete this action?')) {
          nestedItem.actions.splice(index, 1);
          renderNestedActionsList(nestedItem);
        }
      });

      list.appendChild(li);
    });

    container.appendChild(list);
  }

  function moveNestedAction(fromIndex, toIndex) {
    const nestedItem = scriptState.currentNestedItem;
    if (!nestedItem?.actions) return;
    const [action] = nestedItem.actions.splice(fromIndex, 1);
    nestedItem.actions.splice(toIndex, 0, action);
    renderNestedActionsList(nestedItem);
  }

  function attachFormListeners(nestedItem) {
    const isChoice = scriptState.currentNestedType === 'choices';

    // Add action
    form.querySelector('#add-nested-action-btn').addEventListener('click', () => {
      scriptState.addAction(true); // true = nested
    });

    // Test
    testBtn.addEventListener('click', () => testNestedItem(nestedItem));

    // Cancel
    cancelBtn.addEventListener('click', () => scriptState.popPanel());

    // Save nested item properties
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveNestedItem(nestedItem);
    });
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

  function testNestedItem(nestedItem) {
    const isChoice = scriptState.currentNestedType === 'choices';
    const itemName = isChoice ? 'Choice' : 'Branch';

    let desc = `${itemName} Properties:\n`;
    if (isChoice) {
      desc += `  Text: ${nestedItem.text || '(empty)'}\n`;
      desc += `  Condition: ${nestedItem.condition || '(none)'}\n`;
    } else {
      desc += `  Label: ${nestedItem.label || '(auto)'}\n`;
      desc += `  Weight: ${nestedItem.weight || 1}\n`;
    }
    desc += `\nActions (${nestedItem.actions?.length || 0}):\n`;

    if (nestedItem.actions) {
      nestedItem.actions.forEach((action, i) => {
        desc += `  ${i + 1}. ${action.type}: ${getActionDescription(action)}\n`;
      });
    }

    alert(desc);
  }

  function saveNestedItem(nestedItem) {
    const formData = new FormData(form);
    const isChoice = scriptState.currentNestedType === 'choices';

    if (isChoice) {
      nestedItem.text = formData.get('text').trim();
      nestedItem.condition = formData.get('condition').trim() || undefined;
      if (!nestedItem.text) {
        alert('Choice text is required');
        return;
      }
    } else {
      nestedItem.label = formData.get('label').trim() || undefined;
      nestedItem.weight = parseInt(formData.get('weight'), 10) || 1;
    }

    scriptState.popPanel();
  }

  function deleteNestedItem() {
    if (confirm('Delete this choice/branch?')) {
      const event = scriptState.currentEvent;
      const items = scriptState.currentNestedType === 'choices' ? event.choices : event.branches;
      if (items) {
        items.splice(scriptState.currentNestedIndex, 1);
      }
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