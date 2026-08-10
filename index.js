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
  let focusPane = null;   // 'input' | 'output' | 'all' | null
  let lastEditor = 'input';

  const INDENT = 2;

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
    };

    inputEditor = ace.edit('jsonInput');
    inputEditor.setTheme('ace/theme/github');
    inputEditor.session.setMode('ace/mode/json');
    inputEditor.setOptions(options);

    outputEditor = ace.edit('jsonOutput');
    outputEditor.setTheme('ace/theme/github');
    outputEditor.session.setMode('ace/mode/json');
    outputEditor.setOptions(options);
  }

  /* ---------- Status bar ---------- */
  function setStatus(state, message) {
    // state: 'idle' | 'ok' | 'error'
    statusbar.classList.toggle('is-ok', state === 'ok');
    statusbar.classList.toggle('is-error', state === 'error');
    statusText.textContent = message;
  }

  function updateStats(text) {
    if (!text || !text.trim()) {
      statusStats.textContent = '';
      return;
    }
    const lines = text.split('\n').length;
    const bytes = new Blob([text]).size;
    statusStats.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${formatBytes(bytes)}`;
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

  /* ---------- Core: live format ---------- */
  function formatJSON() {
    const input = inputEditor.getValue();

    if (!input.trim()) {
      outputEditor.setValue('', -1);
      setStatus('idle', 'Ready — paste JSON to begin');
      updateStats('');
      return;
    }

    try {
      const formatted = JSON.stringify(JSON.parse(input), null, INDENT);
      outputEditor.setValue(formatted, -1);
      setStatus('ok', 'Valid JSON — formatted');
      updateStats(formatted);
    } catch (error) {
      // Never destroy the user's input; just report.
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
    const savedPageTheme = localStorage.getItem('pageTheme') || 'light';
    const savedEditorTheme = localStorage.getItem('editorTheme') || 'github';
    setTheme(savedPageTheme, savedEditorTheme);

    const savedJsonInput = localStorage.getItem('jsonInput') || '';
    if (savedJsonInput.trim()) {
      inputEditor.setValue(savedJsonInput, -1);
      formatJSON();
    }
  }

  function storeJSON() {
    localStorage.setItem('jsonInput', inputEditor.getValue());
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
      setTheme(isDark ? 'light' : 'dark', isDark ? 'github' : 'monokai');
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
      navigator.clipboard
        .writeText(jsonData)
        .then(() => flashButton(copyButton, 'Copied ✓'))
        .catch(() => setStatus('error', 'Copy failed — clipboard unavailable'));
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
        setStatus('ok', 'Valid JSON');
        updateStats(formatted);
        flashButton(validateButton, 'Valid ✓');
      } catch (error) {
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
          if (event.shiftKey) {
            toggleFocus('all');
          } else {
            toggleFocus(focusPane && focusPane !== 'all' ? focusPane : lastEditor);
          }
        }
      }
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
      setStatus('ok', pretty ? 'Formatted' : 'Minified');
      updateStats(result);
    } catch (error) {
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
})();
