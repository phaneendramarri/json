/* ============================================================
   Best JSON Formatter — App logic
   Vanilla JS. Ace Editor for the panes, localStorage for state.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Element refs ---------- */
  const uploadButton = document.getElementById('uploadButton');
  const downloadButton = document.getElementById('downloadButton');
  const copyButton = document.getElementById('copyButton');
  const themeToggleButton = document.getElementById('themeToggle');
  const themeSelect = document.getElementById('themeSelect');
  const findInputButton = document.getElementById('findInputButton');
  const findOutputButton = document.getElementById('findOutputButton');
  const replaceInputButton = document.getElementById('replaceInputButton');
  const replaceOutputButton = document.getElementById('replaceOutputButton');
  const uploadFileInput = document.getElementById('uploadFile');
  const validateButton = document.getElementById('validateButton');
  const statusbar = document.querySelector('.statusbar');
  const statusText = document.getElementById('statusText');
  const statusStats = document.getElementById('statusStats');
  const siteHeader = document.getElementById('siteHeader');

  let inputEditor;
  let outputEditor;
  let debounceTimer = null;
  let storeTimer = null;
  let focusPane = null;   // 'input' | 'output' | 'all' | null
  let lastEditor = 'input';
  let treeViewActive = false;
  let syncScrollActive = false;

  let INDENT = 2;

  const SAMPLE_JSON = {
    user: { id: 42, name: 'Ada', roles: ['admin', 'editor'], active: true },
    meta: { source: 'api', ms: 12, tags: ['demo', 'sample'] },
  };

  /* ---------- Ace setup ---------- */
  function initializeAce() {
    const options = {
      showLineNumbers: true,
      showPrintMargin: false,
      printMargin: false,
      wrap: true,
      tabSize: INDENT,
      useSoftTabs: true,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: '14px',
      placeholder: 'Paste or drop JSON here…',
    };

    inputEditor = ace.edit('jsonInput');
    inputEditor.setTheme('ace/theme/github');
    inputEditor.session.setMode('ace/mode/json');
    inputEditor.setOptions(options);

    outputEditor = ace.edit('jsonOutput');
    outputEditor.setTheme('ace/theme/github');
    outputEditor.session.setMode('ace/mode/json');
    outputEditor.setOptions(options);
    outputEditor.setReadOnly(true);
  }

  /* ---------- Status bar ---------- */
  function setStatus(state, message) {
    // state: 'idle' | 'ok' | 'error'
    statusbar.classList.toggle('is-ok', state === 'ok');
    statusbar.classList.toggle('is-error', state === 'error');
    statusText.textContent = message;
  }

  function computeJsonStats(text) {
    try {
      const parsed = JSON.parse(text);
      let keys = 0;
      let maxDepth = 0;
      let arrays = 0;
      (function walk(v, d) {
        if (d > maxDepth) maxDepth = d;
        if (Array.isArray(v)) {
          arrays++;
          v.forEach((x) => walk(x, d + 1));
        } else if (v && typeof v === 'object') {
          keys += Object.keys(v).length;
          Object.values(v).forEach((x) => walk(x, d + 1));
        }
      })(parsed, 0);
      return { keys, maxDepth, arrays };
    } catch (e) {
      return null;
    }
  }

  function updateStats(text) {
    if (!text || !text.trim()) {
      statusStats.textContent = '';
      return;
    }
    const lines = text.split('\n').length;
    const bytes = new Blob([text]).size;
    const s = computeJsonStats(text);
    let extra = '';
    if (s) extra = ` · ${s.keys} key${s.keys === 1 ? '' : 's'} · depth ${s.maxDepth} · ${s.arrays} array${s.arrays === 1 ? '' : 's'}`;
    statusStats.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${formatBytes(bytes)}${extra}`;
  }

  function copyText(text, onDone) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onDone).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok && onDone) onDone();
      } catch (e) { /* ignore */ }
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /* ---------- JSON helpers ---------- */
  function parseErrorPosition(error, text) {
    // V8: "Unexpected token } in JSON at position 123"
    const posMatch = /position (\d+)/i.exec(error.message);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const upTo = text.slice(0, pos);
      const line = upTo.split('\n').length;
      const col = pos - upTo.lastIndexOf('\n');
      return { line, col };
    }
    // Firefox: "line 3 column 5"
    const lcMatch = /line (\d+) column (\d+)/i.exec(error.message);
    if (lcMatch) return { line: Number(lcMatch[1]), col: Number(lcMatch[2]) };
    return null;
  }

  function friendlyError(error, text) {
    const where = parseErrorPosition(error, text);
    // Trim noisy modern V8 snippets: '... "..." is not valid JSON'
    const short = error.message
      .replace(/in JSON at position \d+/i, '')
      .replace(/,?\s*["']?\.\.\..*is not valid JSON$/is, '')
      .replace(/\s+/g, ' ')
      .trim();
    return where ? `Invalid JSON — line ${where.line}, col ${where.col}: ${short}` : `Invalid JSON: ${short}`;
  }

  function annotateError(editor, error, text) {
    const where = parseErrorPosition(error, text);
    const short = friendlyError(error, text);
    if (where) {
      editor.session.setAnnotations([{
        row: Math.max(0, where.line - 1),
        column: Math.max(0, where.col - 1),
        text: short,
        type: 'error',
      }]);
    } else {
      editor.session.setAnnotations([]);
    }
  }

  function clearAnnotations(editor) {
    editor.session.setAnnotations([]);
  }

  function simpleDiff(a, b) {
    // Returns array of {type:'eq'|'add'|'del', text}
    const n = a.length, m = b.length;
    // LCS table
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const res = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { res.push({ type: 'eq', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ type: 'del', text: a[i] }); i++; }
      else { res.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) { res.push({ type: 'del', text: a[i++] }); }
    while (j < m) { res.push({ type: 'add', text: b[j++] }); }
    return res;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderTree(value, path) {
    path = path || '$';
    if (value === null) return '<span class="tv-null">null</span>';
    if (typeof value === 'string') return `<span class="tv-str">"${escapeHtml(value)}"</span>`;
    if (typeof value === 'number') return `<span class="tv-num">${escapeHtml(value)}</span>`;
    if (typeof value === 'boolean') return `<span class="tv-bool">${value}</span>`;
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const items = value.map((v, i) => `<li>${renderTree(v, path + '[' + i + ']')}</li>`).join('');
      return `<details open><summary>[${value.length}]</summary><ul>${items}</ul></details>`;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) return '{}';
      const items = keys.map((k) => `<li><span class="tv-key">${escapeHtml(k)}</span>: ${renderTree(value[k], path + '.' + k)}</li>`).join('');
      return `<details open><summary>{${keys.length}}</summary><ul>${items}</ul></details>`;
    }
    return escapeHtml(value);
  }

  function sortKeys(value) {
    if (Array.isArray(value)) {
      return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach((key) => {
        out[key] = sortKeys(value[key]);
      });
      return out;
    }
    return value;
  }

  /* ---------- Core: live format ---------- */
  function formatJSON() {
    const input = inputEditor.getValue();

    if (!input.trim()) {
      outputEditor.setValue('', -1);
      outputEditor.resize();
      clearAnnotations(inputEditor);
      setStatus('idle', 'Ready — paste JSON to begin');
      updateStats('');
      return;
    }

    try {
      const formatted = JSON.stringify(JSON.parse(input), null, INDENT);
      outputEditor.setValue(formatted, -1);
      outputEditor.resize();
      clearAnnotations(inputEditor);
      if (treeViewActive) renderTreeView();
      setStatus('ok', 'Valid JSON — formatted');
      updateStats(formatted);
    } catch (error) {
      // Never destroy the user's input; just report.
      annotateError(inputEditor, error, input);
      setStatus('error', friendlyError(error, input));
      updateStats(input);
    }
  }

  function scheduleFormat() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(formatJSON, 250);
  }

  /* ---------- Themes ---------- */
  function setTheme(pageTheme, aceTheme) {
    const isDark = pageTheme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);
    themeToggleButton.setAttribute('aria-pressed', String(isDark));
    inputEditor.setTheme(`ace/theme/${aceTheme}`);
    outputEditor.setTheme(`ace/theme/${aceTheme}`);
    themeSelect.value = aceTheme;
    localStorage.setItem('pageTheme', pageTheme);
    localStorage.setItem('editorTheme', aceTheme);
  }

  function checkAndApplyThemeAndJSON() {
    let savedPageTheme = null;
    let savedEditorTheme = 'github';
    let savedJsonInput = '';
    try {
      savedPageTheme = localStorage.getItem('pageTheme'); // null if never set
      savedEditorTheme = localStorage.getItem('editorTheme') || 'github';
      savedJsonInput = localStorage.getItem('jsonInput') || '';
    } catch (e) {
      // localStorage unavailable (private mode); keep defaults
    }
    if (!savedPageTheme) {
      savedPageTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    setTheme(savedPageTheme, savedEditorTheme);

    if (savedJsonInput.trim()) {
      inputEditor.setValue(savedJsonInput, -1);
      inputEditor.resize();
      formatJSON();
    }
  }

  function storeJSON() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => {
      try {
        localStorage.setItem('jsonInput', inputEditor.getValue());
      } catch (e) {
        // Storage may be full or unavailable; ignore.
      }
    }, 400);
  }

  /* ---------- Button feedback ---------- */
  function flashButton(button, label, restoreAfter = 1600) {
    const original = button.dataset.originalLabel || button.textContent;
    button.dataset.originalLabel = original;
    button.textContent = label;
    clearTimeout(button._flashTimer);
    button._flashTimer = setTimeout(() => {
      button.textContent = original;
    }, restoreAfter);
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    // Theme toggle
    themeToggleButton.addEventListener('click', () => {
      const isDark = document.body.classList.contains('dark-theme');
      setTheme(isDark ? 'light' : 'dark', themeSelect.value);
    });

    // Editor theme dropdown
    themeSelect.addEventListener('change', (event) => {
      const selected = event.target.value;
      inputEditor.setTheme(`ace/theme/${selected}`);
      outputEditor.setTheme(`ace/theme/${selected}`);
      localStorage.setItem('editorTheme', selected);
    });

    // Live format (debounced) + persist
    inputEditor.session.on('change', () => {
      scheduleFormat();
      storeJSON();
    });
    window.addEventListener('beforeunload', storeJSON);

    // Track last-used editor for the "F" focus shortcut
    inputEditor.on('focus', () => { lastEditor = 'input'; });
    outputEditor.on('focus', () => { lastEditor = 'output'; });

    // Upload
    uploadButton.addEventListener('click', () => uploadFileInput.click());
    uploadFileInput.addEventListener('change', handleFileUpload);

    // Download
    downloadButton.addEventListener('click', () => {
      const jsonData = outputEditor.getValue();
      try {
        const jsonObject = JSON.parse(jsonData);
        const blob = new Blob([JSON.stringify(jsonObject, null, INDENT)], {
          type: 'application/json',
        });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `formatted-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        flashButton(downloadButton, 'Saved ✓');
      } catch (error) {
        setStatus('error', 'Nothing valid to download — fix the JSON first');
      }
    });

    // Copy
    copyButton.addEventListener('click', () => {
      const jsonData = outputEditor.getValue();
      if (!jsonData.trim()) {
        setStatus('idle', 'Nothing to copy yet');
        return;
      }
      const doFlash = () => flashButton(copyButton, 'Copied ✓');
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(jsonData).then(doFlash).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      function fallbackCopy() {
        try {
          const ta = document.createElement('textarea');
          ta.value = jsonData;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) doFlash();
          else setStatus('error', 'Copy failed — clipboard unavailable');
        } catch (e) {
          setStatus('error', 'Copy failed — clipboard unavailable');
        }
      }
    });

    // Validate
    validateButton.addEventListener('click', () => {
      const input = inputEditor.getValue();
      if (!input.trim()) {
        setStatus('idle', 'Nothing to validate yet');
        return;
      }
      try {
        const formatted = JSON.stringify(JSON.parse(input), null, INDENT);
        outputEditor.setValue(formatted, -1);
        outputEditor.resize();
        clearAnnotations(inputEditor);
        if (treeViewActive) renderTreeView();
        setStatus('ok', 'Valid JSON');
        updateStats(formatted);
        flashButton(validateButton, 'Valid ✓');
      } catch (error) {
        annotateError(inputEditor, error, input);
        setStatus('error', friendlyError(error, input));
        flashButton(validateButton, 'Invalid ✕');
      }
    });

    // Find / replace
    findInputButton.addEventListener('click', () => inputEditor.execCommand('find'));
    findOutputButton.addEventListener('click', () => outputEditor.execCommand('find'));
    replaceInputButton.addEventListener('click', () => inputEditor.execCommand('replace'));
    replaceOutputButton.addEventListener('click', () => outputEditor.execCommand('replace'));

    // Format / minify per pane
    document.getElementById('formatInputButton').addEventListener('click', () => transformInPlace(inputEditor, true));
    document.getElementById('formatOutputButton').addEventListener('click', () => transformInPlace(outputEditor, true));
    document.getElementById('minifyInputButton').addEventListener('click', () => transformInPlace(inputEditor, false));
    document.getElementById('minifyOutputButton').addEventListener('click', () => transformInPlace(outputEditor, false));

    // Fold all (output)
    document.getElementById('foldOutputButton').addEventListener('click', () => {
      outputEditor.session.foldAll();
    });
    document.getElementById('unfoldAllOutputButton')?.addEventListener('click', () => {
      outputEditor.session.unfold();
    });

    // Export CSV
    document.getElementById('exportCsvButton').addEventListener('click', () => {
      const v = outputEditor.getValue();
      if (!v.trim()) { setStatus('idle', 'Nothing to export'); return; }
      try {
        const data = JSON.parse(v);
        const arr = Array.isArray(data) ? data : [data];
        if (!arr.length || typeof arr[0] !== 'object' || arr[0] === null) {
          setStatus('error', 'CSV export needs an array of objects');
          return;
        }
        const keys = Array.from(new Set(arr.flatMap((o) => Object.keys(o || {}))));
        const esc = (val) => {
          const s = val === null || val === undefined ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [keys.join(','), ...arr.map((o) => keys.map((k) => esc(o ? o[k] : '')).join(','))].join('\\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `export-${Date.now()}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
        flashButton(document.getElementById('exportCsvButton'), 'Exported ✓');
      } catch (e) {
        setStatus('error', 'CSV export failed — invalid JSON');
      }
    });

    // Copy minified / escaped
    document.getElementById('copyMinOutputButton').addEventListener('click', () => {
      const v = outputEditor.getValue();
      if (!v.trim()) { setStatus('idle', 'Nothing to copy yet'); return; }
      try {
        const min = JSON.stringify(JSON.parse(v));
        copyText(min, () => flashButton(document.getElementById('copyMinOutputButton'), 'Copied ✓'));
      } catch (e) {
        setStatus('error', 'Nothing valid to copy');
      }
    });
    document.getElementById('copyEscOutputButton').addEventListener('click', () => {
      const v = outputEditor.getValue();
      if (!v.trim()) { setStatus('idle', 'Nothing to copy yet'); return; }
      copyText(JSON.stringify(v), () => flashButton(document.getElementById('copyEscOutputButton'), 'Copied ✓'));
    });

    // Load from URL
    document.getElementById('loadUrlButton').addEventListener('click', async () => {
      const url = window.prompt('Enter a URL that returns JSON:');
      if (!url) return;
      setStatus('idle', 'Loading…');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        inputEditor.setValue(text, -1);
        inputEditor.resize();
        formatJSON();
        switchPane('output');
      } catch (error) {
        clearTimeout(timer);
        const msg = error && error.name === 'AbortError' ? 'Request timed out' : (error && error.message) || 'Load failed';
        setStatus('error', `Load failed: ${msg} (CORS may block cross-origin requests)`);
      }
    });

    // Sync scroll toggle
    const syncBtn = document.getElementById('syncScrollButton');
    function syncSyncLabel() {
      syncBtn.setAttribute('aria-pressed', String(syncScrollActive));
      syncBtn.title = syncScrollActive ? 'Sync scroll: on (click to disable)' : 'Sync scroll: off (click to enable)';
    }
    syncSyncLabel();
    syncBtn.addEventListener('click', () => {
      syncScrollActive = !syncScrollActive;
      syncSyncLabel();
    });
    let syncing = false;
    function linkScroll(src, dst) {
      src.session.on('changeScrollTop', () => {
        if (!syncScrollActive || syncing) return;
        syncing = true;
        dst.renderer.scrollToY(src.renderer.scrollTop);
        syncing = false;
      });
    }
    linkScroll(inputEditor, outputEditor);
    linkScroll(outputEditor, inputEditor);

    // Clear / Sample (input)
    document.getElementById('clearInputButton').addEventListener('click', () => {
      inputEditor.setValue('', -1);
      inputEditor.resize();
      formatJSON();
      setStatus('idle', 'Cleared');
    });
    document.getElementById('sampleInputButton').addEventListener('click', () => {
      inputEditor.setValue(JSON.stringify(SAMPLE_JSON, null, INDENT), -1);
      inputEditor.resize();
      formatJSON();
    });

    // Sort keys (input, non-mutating)
    document.getElementById('sortInputButton').addEventListener('click', () => {
      const value = inputEditor.getValue();
      if (!value.trim()) return;
      try {
        const parsed = JSON.parse(value);
        const sorted = sortKeys(parsed);
        const result = JSON.stringify(sorted, null, INDENT);
        inputEditor.setValue(result, -1);
        inputEditor.resize();
        formatJSON();
        setStatus('ok', 'Keys sorted');
      } catch (error) {
        annotateError(inputEditor, error, value);
        setStatus('error', friendlyError(error, value));
      }
    });

    // Indentation selector
    const indentSelect = document.getElementById('indentSelect');
    indentSelect.value = String(INDENT);
    indentSelect.addEventListener('change', (event) => {
      const next = Number(event.target.value) || 2;
      INDENT = next;
      inputEditor.setOption('tabSize', INDENT);
      outputEditor.setOption('tabSize', INDENT);
      // Re-format with new indent if there is content
      if (inputEditor.getValue().trim()) formatJSON();
    });

    // Read-only toggle (output)
    const readOnlyBtn = document.getElementById('readOnlyOutputButton');
    function syncReadOnlyLabel() {
      const ro = outputEditor.getReadOnly();
      readOnlyBtn.setAttribute('aria-pressed', String(ro));
      readOnlyBtn.title = ro ? 'Read-only: on (click to disable)' : 'Read-only: off (click to enable)';
    }
    syncReadOnlyLabel();
    readOnlyBtn.addEventListener('click', () => {
      outputEditor.setReadOnly(!outputEditor.getReadOnly());
      syncReadOnlyLabel();
    });

    // Tree view toggle
    const treeBtn = document.getElementById('treeViewButton');
    const treeViewEl = document.getElementById('treeView');
    const outputEditorEl = document.getElementById('jsonOutput');
    function syncTreeLabel() {
      treeBtn.setAttribute('aria-pressed', String(treeViewActive));
      treeBtn.title = treeViewActive ? 'Tree view: on (click to disable)' : 'Tree view: off (click to enable)';
    }
    function renderTreeView() {
      const v = outputEditor.getValue();
      if (!v.trim()) { treeViewEl.innerHTML = ''; return; }
      try {
        treeViewEl.innerHTML = renderTree(JSON.parse(v));
      } catch (e) {
        treeViewEl.innerHTML = '<span class="tv-null">Invalid JSON</span>';
      }
    }
    function setTreeView(active) {
      treeViewActive = active;
      syncTreeLabel();
      outputEditorEl.hidden = active;
      treeViewEl.hidden = !active;
      if (active) renderTreeView();
    }
    syncTreeLabel();
    treeBtn.addEventListener('click', () => setTreeView(!treeViewActive));

    // Drag-and-drop JSON import
    const inputPane = document.getElementById('inputPane');
    ['dragenter', 'dragover'].forEach((ev) => {
      inputPane.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputPane.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      inputPane.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputPane.classList.remove('is-dragover');
      });
    });
    inputPane.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const looksJson = file.type === 'application/json' || /\.json$/i.test(file.name);
      if (!looksJson) {
        setStatus('error', 'Please drop a .json file');
        return;
      }
      const reader = new FileReader();
      reader.onload = function (ev) {
        inputEditor.setValue(String(ev.target.result), -1);
        inputEditor.resize();
        formatJSON();
        switchPane('output');
      };
      reader.readAsText(file);
    });

    // Shortcuts modal
    const shortcutsModal = document.getElementById('shortcutsModal');
    function openShortcuts() {
      shortcutsModal.hidden = false;
    }
    function closeShortcuts() {
      shortcutsModal.hidden = true;
    }
    shortcutsModal.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', closeShortcuts);
    });

    // Compare modal
    const compareModal = document.getElementById('compareModal');
    const compareLeft = document.getElementById('compareLeft');
    const compareRight = document.getElementById('compareRight');
    const compareResult = document.getElementById('compareResult');
    function openCompare() {
      // prefill with current input/output if empty
      if (!compareLeft.value.trim()) compareLeft.value = inputEditor.getValue();
      if (!compareRight.value.trim()) compareRight.value = outputEditor.getValue();
      compareModal.hidden = false;
    }
    function closeCompare() { compareModal.hidden = true; }
    document.getElementById('compareButton').addEventListener('click', openCompare);
    compareModal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeCompare));
    document.getElementById('compareRunButton').addEventListener('click', () => {
      const a = compareLeft.value.split('\\n');
      const b = compareRight.value.split('\\n');
      const diff = simpleDiff(a, b);
      compareResult.innerHTML = diff.map((line) => {
        if (line.type === 'add') return `<span style="color:var(--ok)">+ ${escapeHtml(line.text)}</span>`;
        if (line.type === 'del') return `<span style="color:var(--err)">- ${escapeHtml(line.text)}</span>`;
        return `  ${escapeHtml(line.text)}`;
      }).join('\\n');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (event) => {
      const tag = (event.target && event.target.tagName || '').toLowerCase();
      const typing =
        tag === 'input' || tag === 'textarea' || tag === 'select' ||
        (event.target && event.target.isContentEditable) ||
        (event.target && event.target.closest && event.target.closest('.ace_editor'));
      // ? help (not while typing)
      if (event.key === '?' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (shortcutsModal.hidden) openShortcuts(); else closeShortcuts();
        return;
      }
      // Ctrl/Cmd+Enter -> validate
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        validateButton.click();
        return;
      }
      // Ctrl/Cmd+Shift+C -> copy output
      if ((event.key === 'c' || event.key === 'C') && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        // only when not typing in an editor selection? allow
        event.preventDefault();
        copyButton.click();
        return;
      }
      if (event.key === 'Escape' && !shortcutsModal.hidden) {
        closeShortcuts();
      }
    }, true);

    // Focus mode — expand one editor to fill the screen
    document.getElementById('focusInputButton').addEventListener('click', () => toggleFocus('input'));
    document.getElementById('focusOutputButton').addEventListener('click', () => toggleFocus('output'));

    // Fullscreen — both editors side by side
    document.getElementById('focusAllButton').addEventListener('click', () => toggleFocus('all'));

    // Footer actions
    document.getElementById('footerFullscreen').addEventListener('click', () => {
      document.getElementById('tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => toggleFocus('all'), 400);
    });
    document.getElementById('backToTop').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.getElementById('footerYear').textContent = String(new Date().getFullYear());

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && focusPane) {
        exitFocus();
        return;
      }
      // "F" toggles focus on the last-used editor, "Shift+F" fullscreen — never while typing
      if ((event.key === 'f' || event.key === 'F') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const el = event.target;
        const tag = (el.tagName || '').toLowerCase();
        const typing =
          tag === 'input' || tag === 'textarea' || tag === 'select' ||
          el.isContentEditable || (el.closest && el.closest('.ace_editor'));
        if (!typing) {
          event.preventDefault();
          // "F" always opens fullscreen (both editors side by side); single-editor
          // focus remains available via the per-pane Focus buttons.
          toggleFocus('all');
        }
      }
    });

    // More menus
    document.querySelectorAll('.more-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = btn.nextElementSibling;
        const open = menu.hidden;
        // close all
        document.querySelectorAll('.more-menu').forEach((m) => { m.hidden = true; });
        document.querySelectorAll('.more-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        if (open) {
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.more-menu').forEach((m) => { m.hidden = true; });
      document.querySelectorAll('.more-toggle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    });

    // Mobile pane tabs
    document.querySelectorAll('.pane-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchPane(tab.dataset.pane));
    });

    // Header shadow on scroll
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* Format (true) or minify (false) an editor's content in place. */
  function transformInPlace(editor, pretty) {
    const value = editor.getValue();
    if (!value.trim()) return;
    try {
      const result = JSON.stringify(JSON.parse(value), null, pretty ? INDENT : 0);
      editor.setValue(result, -1);
      editor.resize();
      clearAnnotations(editor);
      setStatus('ok', pretty ? 'Formatted' : 'Minified');
      updateStats(result);
    } catch (error) {
      annotateError(editor, error, value);
      setStatus('error', friendlyError(error, value));
    }
  }

  function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const looksJson = file.type === 'application/json' || /\.json$/i.test(file.name);
    if (!looksJson) {
      setStatus('error', 'Please choose a .json file');
      uploadFileInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      inputEditor.setValue(String(e.target.result), -1);
      inputEditor.resize();
      formatJSON();
      switchPane('output');
    };
    reader.readAsText(file);
    uploadFileInput.value = '';
  }

  /* ---------- Focus mode ---------- */
  function toggleFocus(name) {
    if (focusPane === name) {
      exitFocus();
      return;
    }
    focusPane = name;
    document.body.classList.add('has-focus');
    const workbench = document.querySelector('.workbench');
    const inputPane = document.getElementById('inputPane');
    const outputPane = document.getElementById('outputPane');

    workbench.classList.toggle('is-focus', name === 'all');
    inputPane.classList.toggle('is-focus', name === 'input');
    outputPane.classList.toggle('is-focus', name === 'output');

    // On mobile fullscreen, make sure both panes are reachable via tabs
    if (name === 'all') {
      inputPane.classList.add('is-active');
      outputPane.classList.remove('is-active');
      switchPane('input');
    }

    const editor = name === 'output' ? outputEditor : inputEditor;
    requestAnimationFrame(() => {
      inputEditor.resize();
      outputEditor.resize();
      editor.focus();
    });
  }

  function exitFocus() {
    focusPane = null;
    document.body.classList.remove('has-focus');
    document.querySelector('.workbench').classList.remove('is-focus');
    document.getElementById('inputPane').classList.remove('is-focus');
    document.getElementById('outputPane').classList.remove('is-focus');
    requestAnimationFrame(() => {
      inputEditor.resize();
      outputEditor.resize();
    });
  }

  /* ---------- Mobile pane switcher ---------- */
  function switchPane(name) {
    document.querySelectorAll('.pane-tab').forEach((tab) => {
      const active = tab.dataset.pane === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.getElementById('inputPane').classList.toggle('is-active', name === 'input');
    document.getElementById('outputPane').classList.toggle('is-active', name === 'output');
    // Ace needs a resize nudge after becoming visible
    const editor = name === 'input' ? inputEditor : outputEditor;
    requestAnimationFrame(() => editor.resize());
  }

  /* ---------- Header scroll state ---------- */
  function onScroll() {
    siteHeader.classList.toggle('is-scrolled', window.scrollY > 8);
  }

  /* ---------- Scroll reveal ---------- */
  function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    items.forEach((el) => observer.observe(el));
  }

  /* ---------- Boot ---------- */
  initializeAce();
  bindEvents();
  checkAndApplyThemeAndJSON();
  initReveal();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
