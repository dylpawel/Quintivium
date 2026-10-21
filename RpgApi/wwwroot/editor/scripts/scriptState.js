/**
 * Script Editor State Management
 *
 * Manages the 3-panel navigation stack and current editing context:
 * - Panel 1: Map Scripts Manager (event list for current map)
 * - Panel 2: Event Editor (single ECA script)
 * - Panel 3: Action Editor (single action)
 */

import { cleanScriptForSave } from '../map.js';

export const PANEL_MODE = {
  MAP_SCRIPTS: 'map_scripts',
  EVENT_EDITOR: 'event_editor',
  ACTION_EDITOR: 'action_editor',
  NESTED_ACTION_EDITOR: 'nested_action_editor'
};

export class ScriptState {
  constructor() {
    this.panelStack = [PANEL_MODE.MAP_SCRIPTS];
    this.map = null;                         // Reference to current map object
    this.currentEvents = [];                 // Array of event scripts from map._scripts
    this.currentEvent = null;                // Event being edited (Panel 2)
    this.currentEventIndex = -1;             // Index in currentEvents (map._scripts)
    this.isNewEvent = false;                 // Whether current event is new
    this.currentAction = null;               // Action being edited (Panel 3)
    this.currentActionIndex = -1;            // Index in currentEvent.actions
    this.isNewAction = false;                // Whether current action is new
    this.currentActionParent = null;         // For nested actions: 'event' | 'choice' | 'pick_random'
    this.currentChoiceIndex = -1;            // Index of choice in show_choice
    this.currentPickRandomIndex = -1;        // Index of branch in pick_random
    this.currentNestedIndex = -1;            // Index of nested action parent in event.actions
    this.currentNestedType = null;           // 'choices' or 'branches'
    this.currentNestedItem = null;           // The choice/branch object being edited

    // Callbacks (set by editor.js)
    this.onPanelChange = null;               // (newMode, prevMode) => void
    this.onSaveEvent = null;                 // (event, index) => void
    this.onDeleteEvent = null;               // (index) => void
    this.onSaveAction = null;                // (action, parentContext) => void
    this.onDeleteAction = null;              // (parentContext, index) => void
  }

  // --- Map Reference ---

  setMap(map) {
    this.map = map;
    this.currentEvents = map._scripts || [];
    // Ensure map._scripts exists
    if (!map._scripts) map._scripts = [];
    this.currentEvents = map._scripts;
  }

  // --- Panel Navigation ---

  get currentMode() {
    return this.panelStack[this.panelStack.length - 1];
  }

  pushPanel(mode) {
    const prevMode = this.currentMode;
    this.panelStack.push(mode);
    if (this.onPanelChange) this.onPanelChange(mode, prevMode);
  }

  popPanel() {
    if (this.panelStack.length <= 1) return false;
    const prevMode = this.panelStack.pop();
    const newMode = this.currentMode;
    if (this.onPanelChange) this.onPanelChange(newMode, prevMode);
    return true;
  }

  goToMapScripts() {
    this.panelStack = [PANEL_MODE.MAP_SCRIPTS];
    this.currentEvent = null;
    this.currentEventIndex = -1;
    this.currentAction = null;
    this.currentActionIndex = -1;
    if (this.onPanelChange) this.onPanelChange(PANEL_MODE.MAP_SCRIPTS, null);
  }

  goToEventEditor(eventIndex) {
    this.currentEventIndex = eventIndex;
    this.currentEvent = this.currentEvents[eventIndex] ?? this.createEmptyEvent();
    this.isNewEvent = eventIndex < 0 || eventIndex >= this.currentEvents.length;
    this.currentAction = null;
    this.currentActionIndex = -1;
    this.currentActionParent = 'event';  // Set parent context for actions
    this.currentChoiceIndex = -1;
    this.currentPickRandomIndex = -1;
    this.panelStack = [PANEL_MODE.MAP_SCRIPTS, PANEL_MODE.EVENT_EDITOR];
    if (this.onPanelChange) this.onPanelChange(PANEL_MODE.EVENT_EDITOR, PANEL_MODE.MAP_SCRIPTS);
  }

  goToActionEditor(actionIndex, parentContext = 'event', parentActionIndex = -1, choiceBranchIndex = -1) {
    const event = this.currentEvent;
    if (!event) return;

    this.currentActionIndex = actionIndex;
    this.currentActionParent = parentContext;
    this.currentChoiceIndex = parentActionIndex;    // Index of parent action in event.actions
    this.currentPickRandomIndex = choiceBranchIndex; // Index of choice/branch in parent action's choices

    let actions;
    if (parentContext === 'event') {
      actions = event.actions ?? [];
    } else if (parentContext === 'choice') {
      const parentAction = event.actions[parentActionIndex];
      const choice = parentAction?.choices?.[choiceBranchIndex];
      actions = choice?.actions ?? (choice.actions = []);
    } else if (parentContext === 'pick_random') {
      const parentAction = event.actions[parentActionIndex];
      const branch = parentAction?.choices?.[choiceBranchIndex];
      actions = branch?.actions ?? (branch.actions = []);
    }

    this.isNewAction = actionIndex < 0 || actionIndex >= actions.length;
    this.currentAction = actions[actionIndex] ?? { type: '' };

    this.panelStack = [PANEL_MODE.MAP_SCRIPTS, PANEL_MODE.EVENT_EDITOR, PANEL_MODE.ACTION_EDITOR];
    if (this.onPanelChange) this.onPanelChange(PANEL_MODE.ACTION_EDITOR, PANEL_MODE.EVENT_EDITOR);
  }

  goToNestedActionEditor(nestedIndex, nestedType, itemIndex) {
    // nestedType: 'choices' or 'branches'
    const event = this.currentEvent;
    if (!event) return;

    this.currentNestedIndex = nestedIndex;
    this.currentNestedType = nestedType; // 'choices' or 'branches'
    const items = nestedType === 'choices' ? event.actions[nestedIndex]?.choices : event.actions[nestedIndex]?.branches;
    this.currentNestedItem = items?.[itemIndex] ?? { actions: [] };

    // Add nested action editor to stack (new panel mode)
    this.panelStack.push(PANEL_MODE.NESTED_ACTION_EDITOR);
    if (this.onPanelChange) this.onPanelChange(PANEL_MODE.NESTED_ACTION_EDITOR, PANEL_MODE.EVENT_EDITOR);
  }

  // --- Event Operations ---

  createEmptyEvent() {
    return {
      id: crypto.randomUUID(),
      name: '',
      on: 'tile_enter',
      once: false,
      condition: '',
      tile: null,
      map: null,
      npc: null,
      actions: []
    };
  }

  addEvent() {
    const newEvent = this.createEmptyEvent();
    this.currentEvents.push(newEvent);
    this.isNewEvent = true;
    this.goToEventEditor(this.currentEvents.length - 1);
  }

  saveEvent() {
    if (this.currentEventIndex >= 0 && this.currentEvent) {
      this.currentEvents[this.currentEventIndex] = { ...this.currentEvent };
    } else if (this.currentEvent) {
      // New event being created
      this.currentEvents.push({ ...this.currentEvent });
      this.currentEventIndex = this.currentEvents.length - 1;
    }
    if (this.onSaveEvent) this.onSaveEvent(this.currentEvent, this.currentEventIndex);
    this.popPanel(); // Back to map scripts
  }

  deleteEvent() {
    if (this.currentEventIndex >= 0) {
      this.currentEvents.splice(this.currentEventIndex, 1);
      if (this.onDeleteEvent) this.onDeleteEvent(this.currentEventIndex);
    }
    this.goToMapScripts();
  }

  // --- Action Operations ---

  getCurrentActionArray() {
    const event = this.currentEvent;
    if (!event) return null;

    if (this.currentActionParent === 'event') {
      return event.actions ?? (event.actions = []);
    } else if (this.currentActionParent === 'choice') {
      // currentChoiceIndex = index of show_choice action in event.actions
      // currentPickRandomIndex = index of choice within that action's choices
      const choiceAction = event.actions[this.currentChoiceIndex];
      const choice = choiceAction?.choices?.[this.currentPickRandomIndex];
      return choice?.actions ?? (choice.actions = []);
    } else if (this.currentActionParent === 'pick_random') {
      const prAction = event.actions[this.currentPickRandomIndex];
      const branch = prAction?.choices?.[this.currentChoiceIndex];
      return branch?.actions ?? (branch.actions = []);
    }
    return null;
  }

  addAction() {
    const actions = this.getCurrentActionArray();
    if (!actions) return;
    const newAction = { type: 'show_dialog' };
    actions.push(newAction);
    this.isNewAction = true;
    this.goToActionEditor(actions.length - 1, this.currentActionParent, this.currentChoiceIndex, this.currentPickRandomIndex);
  }

  saveAction() {
    const actions = this.getCurrentActionArray();
    if (!actions || this.currentActionIndex < 0) return;

    actions[this.currentActionIndex] = { ...this.currentAction };

    const parentContext = {
      parent: this.currentActionParent,
      parentActionIndex: this.currentChoiceIndex,
      choiceBranchIndex: this.currentPickRandomIndex,
      actionIndex: this.currentActionIndex
    };

    if (this.onSaveAction) this.onSaveAction(this.currentAction, parentContext);
    this.popPanel(); // Back to event editor
  }

  deleteAction() {
    const actions = this.getCurrentActionArray();
    if (!actions || this.currentActionIndex < 0) return;

    actions.splice(this.currentActionIndex, 1);

    const parentContext = {
      parent: this.currentActionParent,
      parentActionIndex: this.currentChoiceIndex,
      choiceBranchIndex: this.currentPickRandomIndex,
      actionIndex: this.currentActionIndex
    };

    if (this.onDeleteAction) this.onDeleteAction(parentContext, this.currentActionIndex);
    this.popPanel(); // Back to event editor
  }

  // --- Helpers ---

  getCustomEvents() {
    // Extract unique custom event names from fire_event actions in current file
    const events = new Set();
    for (const evt of this.currentEvents) {
      for (const action of evt.actions ?? []) {
        if (action.type === 'fire_event' && action.event) {
          events.add(action.event);
        }
        // Check nested actions
        this.extractCustomEvents(action, events);
      }
    }
    return Array.from(events).sort();
  }

  extractCustomEvents(action, events) {
    if (action.type === 'show_choice' && action.choices) {
      for (const choice of action.choices) {
        for (const a of choice.actions ?? []) this.extractCustomEvents(a, events);
      }
    } else if (action.type === 'pick_random' && action.choices) {
      for (const choice of action.choices) {
        for (const a of choice.actions ?? []) this.extractCustomEvents(a, events);
      }
    }
  }

  // --- JSON Export ---

  getFileJSON() {
    return this.currentEvents.map(cleanEventForJSON);
  }

  getEventJSON() {
    return this.currentEvent ? cleanEventForJSON(this.currentEvent) : null;
  }

  getActionJSON() {
    return this.currentAction ? cleanActionForJSON(this.currentAction) : null;
  }
}

/**
 * Clean event for JSON display - omit default/empty values
 */
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

  // Import schemas to get defaults
  // For now, handle known defaults inline
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
      // Handle new position field format { x, y, mark }
      if (cleaned.position) {
        if (cleaned.position.x === '' || cleaned.position.x == null) delete cleaned.position.x;
        if (cleaned.position.y === '' || cleaned.position.y == null) delete cleaned.position.y;
        if (!cleaned.position.mark) delete cleaned.position.mark;
        // If position is empty, remove it
        if (Object.keys(cleaned.position).length === 0) {
          delete cleaned.position;
        }
      }
      // Legacy x, y fields (for backwards compatibility)
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

// Singleton instance
export const scriptState = new ScriptState();