/**
 * Script JSON Viewer - Reusable modal for displaying formatted JSON
 * Used by all 3 panels for "Show JSON" functionality
 */

/**
 * Show a modal with formatted JSON
 * @param {Object|Array} data - Data to display
 * @param {string} title - Modal title
 * @param {Object} options - { onCopy: callback, readOnly: boolean }
 */
export function showJsonModal(data, title = 'JSON Output', options = {}) {
  const { onCopy, readOnly = true } = options;

  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
    box-sizing: border-box;
  `;

  const jsonStr = JSON.stringify(data, null, 2);

  modal.innerHTML = `
    <div style="
      background: #1e1e1e;
      border: 1px solid #333;
      border-radius: 6px;
      width: 100%;
      max-width: 800px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      color: #e0e0e0;
      font-family: 'Segoe UI', system-ui, sans-serif;
    ">
      <div style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #333;
        background: #252526;
        border-radius: 6px 6px 0 0;
      ">
        <h3 style="margin: 0; font-size: 14px; font-weight: 600;">${escapeHtml(title)}</h3>
        <div style="display: flex; gap: 8px;">
          ${!readOnly ? `
            <button id="json-save" style="
              padding: 6px 12px;
              background: #0e639c;
              border: none;
              border-radius: 3px;
              color: white;
              cursor: pointer;
              font-size: 12px;
            ">Save Changes</button>
          ` : ''}
          <button id="json-copy" style="
            padding: 6px 12px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 12px;
          ">📋 Copy</button>
          <button id="json-close" style="
            padding: 6px 12px;
            background: #3a3a3a;
            border: 1px solid #444;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 12px;
          ">Close</button>
        </div>
      </div>
      <div style="
        flex: 1;
        overflow: auto;
        padding: 16px;
        background: #1a1a1a;
        min-height: 200px;
        max-height: 60vh;
      ">
        <pre id="json-content" style="
          margin: 0;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 12px;
          line-height: 1.5;
          color: #d4d4d4;
          white-space: pre-wrap;
          word-wrap: break-word;
        ">${escapeHtml(jsonStr)}</pre>
        ${!readOnly ? `
          <textarea id="json-edit" style="
            display: none;
            width: 100%;
            height: 100%;
            min-height: 300px;
            padding: 12px;
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 3px;
            color: #d4d4d4;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            line-height: 1.5;
            box-sizing: border-box;
            resize: vertical;
          ">${jsonStr}</textarea>
        ` : ''}
      </div>
      <div id="json-status" style="
        padding: 8px 16px;
        border-top: 1px solid #333;
        font-size: 11px;
        color: #888;
        text-align: right;
      ">${jsonStr.length} characters</div>
    </div>
  `;

  const closeBtn = modal.querySelector('#json-close');
  const copyBtn = modal.querySelector('#json-copy');
  const saveBtn = modal.querySelector('#json-save');
  const contentEl = modal.querySelector('#json-content');
  const editEl = modal.querySelector('#json-edit');
  const statusEl = modal.querySelector('#json-status');

  let isEditing = false;

  function close() {
    document.body.removeChild(modal);
  }

  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(jsonStr);
      copyBtn.textContent = '✓ Copied!';
      copyBtn.style.background = '#2a6b2a';
      setTimeout(() => {
        copyBtn.textContent = '📋 Copy';
        copyBtn.style.background = '#3a3a3a';
      }, 2000);
    } catch (e) {
      copyBtn.textContent = 'Failed';
      setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
    }
  });

  if (saveBtn && onCopy) {
    saveBtn.addEventListener('click', async () => {
      const text = editEl.value;
      try {
        const parsed = JSON.parse(text);
        await onCopy(parsed);
        saveBtn.textContent = 'Saved!';
        saveBtn.style.background = '#2a6b2a';
        setTimeout(() => {
          saveBtn.textContent = 'Save Changes';
          saveBtn.style.background = '#0e639c';
        }, 2000);
        // Update view
        contentEl.textContent = JSON.stringify(parsed, null, 2);
        editEl.value = contentEl.textContent;
        isEditing = false;
        contentEl.style.display = 'block';
        editEl.style.display = 'none';
        saveBtn.style.display = 'none';
      } catch (e) {
        statusEl.textContent = `Invalid JSON: ${e.message}`;
        statusEl.style.color = '#ff8888';
      }
    });

    // Double-click to edit
    contentEl.addEventListener('dblclick', () => {
      isEditing = true;
      contentEl.style.display = 'none';
      editEl.style.display = 'block';
      editEl.focus();
      saveBtn.style.display = 'inline-block';
    });

    // Escape to cancel edit
    editEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        isEditing = false;
        editEl.value = contentEl.textContent;
        contentEl.style.display = 'block';
        editEl.style.display = 'none';
        saveBtn.style.display = 'none';
      }
    });
  }

  // Keyboard: Escape to close
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', escHandler);
      close();
    }
  }, { once: true });

  document.body.appendChild(modal);
  return modal;
}

/**
 * Create a "Show JSON" button with consistent styling
 * @param {Function} onClick - Click handler
 * @param {string} tooltip - Tooltip text
 * @returns {HTMLButtonElement}
 */
export function createJsonButton(onClick, tooltip = 'Show JSON') {
  const btn = document.createElement('button');
  btn.title = tooltip;
  btn.style.cssText = `
    padding: 4px 8px;
    background: #3a3a3a;
    border: 1px solid #444;
    border-radius: 3px;
    color: #e0e0e0;
    cursor: pointer;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `;
  btn.innerHTML = '👁';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Create a header with title and action buttons
 * @param {string} title
 * @param {Array<{label: string, onClick: Function, primary?: boolean, danger?: boolean}>} actions
 * @returns {HTMLElement}
 */
export function createPanelHeader(title, actions = []) {
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid #333;
    background: #252526;
    flex-wrap: wrap;
    gap: 8px;
  `;

  const titleEl = document.createElement('h3');
  titleEl.style.cssText = 'margin: 0; font-size: 14px; font-weight: 600;';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const actionGroup = document.createElement('div');
  actionGroup.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;';

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.style.cssText = `
      padding: 4px 10px;
      font-size: 12px;
      border-radius: 3px;
      cursor: pointer;
      border: none;
      ${action.primary ? 'background: #0e639c; color: white;' : ''}
      ${action.danger ? 'background: #a4262c; color: white;' : ''}
      ${!action.primary && !action.danger ? 'background: #3a3a3a; border: 1px solid #444; color: #e0e0e0;' : ''}
    `;
    btn.addEventListener('click', action.onClick);
    actionGroup.appendChild(btn);
  }

  header.appendChild(actionGroup);
  return header;
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