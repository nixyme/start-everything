// === State ===
let projects = [];
let currentProject = null;
let isEditMode = false;
let draggedElement = null;
let searchQuery = '';
let commandScheduleCache = {}; // projectId → { cmdIndex: schedule }

// === DOM ===
const projectList = document.getElementById('projectList');
const welcomeMessage = document.getElementById('welcomeMessage');
const projectDetails = document.getElementById('projectDetails');
const projectModal = document.getElementById('projectModal');
const toastContainer = document.getElementById('toastContainer');
const searchInput = document.getElementById('searchInput');

// === SVG Icons ===
const icons = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="40" height="40"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="40" height="40"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>',
  unpin: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  silent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

// === Init ===
document.addEventListener('DOMContentLoaded', async () => {
  await initLocale();
  loadProjects();
  setupEventListeners();
  setupKeyboardShortcuts();
  setupSettings();
  setupAutoUpdater();
  setupScheduleEvents();
  updateGlobalShortcutHint();
});

// === Global Shortcut Hint ===
async function updateGlobalShortcutHint() {
  const shortcut = await window.electronAPI.getGlobalShortcut();
  const el = document.getElementById('globalShortcutHint');
  if (!shortcut) { el.style.display = 'none'; return; }
  // 将 Electron accelerator 转为 kbd 显示（如 "CommandOrControl+Shift+L"）
  const parts = shortcut.replace(/CommandOrControl/g, '⌘').replace(/Command/g, '⌘')
    .replace(/Control/g, '⌃').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧')
    .replace(/Meta/g, '⌘').split('+');
  const kbds = parts.map(k => `<kbd>${k.trim()}</kbd>`).join(' + ');
  el.innerHTML = kbds + ' <span>' + (t('welcome.activate') || 'to activate window') + '</span>';
  el.style.display = '';
}

// === Event Listeners ===
function setupEventListeners() {
  document.getElementById('addProjectBtn').addEventListener('click', () => openModal(false));

  // Drag directory onto add button → new project with that path
  const addBtn = document.getElementById('addProjectBtn');
  addBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    addBtn.classList.add('drag-active');
  });
  addBtn.addEventListener('dragleave', () => addBtn.classList.remove('drag-active'));
  addBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    addBtn.classList.remove('drag-active');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const filePath = files[0].path;
      if (!filePath) return;
      const pathInfo = await window.electronAPI.checkPathType(filePath);
      if (!pathInfo.exists) return;

      if (pathInfo.isDirectory) {
        // 文件夹 → 填入项目路径
        openModal(false);
        setTimeout(() => {
          document.getElementById('modalProjectPath').value = filePath;
          const dirName = filePath.split('/').pop() || filePath;
          document.getElementById('modalProjectName').value = dirName;
          syncProjectPathToFolderList(filePath);
        }, 50);
      } else if (pathInfo.isFile) {
        // 文件 → 作为可执行命令添加
        const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
        const fileName = filePath.split('/').pop() || filePath;
        openModal(false);
        setTimeout(() => {
          document.getElementById('modalProjectPath').value = dirPath;
          document.getElementById('modalProjectName').value = fileName;
          renderCommandInputs([filePath], ['']);
          syncProjectPathToFolderList(dirPath);
        }, 50);
      }
    }
  });
  // Import/Export now in settings modal — no sidebar buttons
  document.getElementById('editProjectBtn').addEventListener('click', () => {
    if (currentProject) openModal(true, currentProject);
  });
  document.getElementById('deleteProjectBtn').addEventListener('click', deleteProject);
  document.getElementById('openOutputBtn').addEventListener('click', openOutputFolder);
  document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
  document.getElementById('saveProjectBtn').addEventListener('click', saveProject);
  document.getElementById('addCommandBtn').addEventListener('click', addCommandInput);
  document.getElementById('addUrlBtn').addEventListener('click', addUrlInput);
  document.getElementById('addFolderBtn').addEventListener('click', addFolderInput);
  document.getElementById('addFileBtn').addEventListener('click', addFileInput);
  document.getElementById('addSubprojectBtn').addEventListener('click', addSubprojectInput);

  // Drag and drop support for Add Folder button
  const addFolderBtn = document.getElementById('addFolderBtn');
  addFolderBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFolderBtn.style.opacity = '0.7';
    addFolderBtn.style.transform = 'scale(1.05)';
  });
  addFolderBtn.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFolderBtn.style.opacity = '';
    addFolderBtn.style.transform = '';
  });
  addFolderBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFolderBtn.style.opacity = '';
    addFolderBtn.style.transform = '';

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i].path;
        const pathInfo = await window.electronAPI.checkPathType(filePath);
        if (pathInfo && pathInfo.isDirectory) {
          const folderName = filePath.split('/').pop() || '';
          addFolderInputWithValue(filePath, folderName);
        }
      }
    }
  });

  // Drag and drop support for Add File button
  const addFileBtn = document.getElementById('addFileBtn');
  addFileBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFileBtn.style.opacity = '0.7';
    addFileBtn.style.transform = 'scale(1.05)';
  });
  addFileBtn.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFileBtn.style.opacity = '';
    addFileBtn.style.transform = '';
  });
  addFileBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    addFileBtn.style.opacity = '';
    addFileBtn.style.transform = '';

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i].path;
        const pathInfo = await window.electronAPI.checkPathType(filePath);
        // 支持所有类型：普通文件、.app 应用、符号链接等
        // 只排除不存在的路径
        if (pathInfo && pathInfo.exists) {
          const fileName = filePath.split('/').pop() || '';
          addFileInputWithValue(filePath, fileName);
        }
      }
    }
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('scheduleLogsBtn').addEventListener('click', openScheduleLogsModal);

  document.getElementById('browseProjectPathBtn').addEventListener('click', async () => {
    const result = await window.electronAPI.selectFolder();
    if (!result.canceled) {
      document.getElementById('modalProjectPath').value = result.path;
      if (!isEditMode) syncProjectPathToFolderList(result.path);
    }
  });
  document.getElementById('modalProjectPath').addEventListener('change', () => {
    if (!isEditMode) {
      const val = document.getElementById('modalProjectPath').value.trim();
      if (val) syncProjectPathToFolderList(val);
    }
  });
  document.getElementById('browseOutputPathBtn').addEventListener('click', async () => {
    const result = await window.electronAPI.selectFolder();
    if (!result.canceled) {
      document.getElementById('modalOutputPath').value = result.path;
      if (!isEditMode) syncProjectPathToFolderList(result.path);
    }
  });
  document.getElementById('modalOutputPath').addEventListener('change', () => {
    if (!isEditMode) {
      const val = document.getElementById('modalOutputPath').value.trim();
      if (val) syncProjectPathToFolderList(val);
    }
  });


  // Search
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderProjectList();
  });

  // Search history
  const searchHistoryDropdown = document.getElementById('searchHistoryDropdown');
  let searchHistoryCache = [];

  searchInput.addEventListener('focus', async () => {
    searchHistoryCache = await window.electronAPI.getSearchHistory() || [];
    renderSearchHistory();
  });

  searchInput.addEventListener('blur', () => {
    // Delay hide to allow click on items
    setTimeout(() => { searchHistoryDropdown.style.display = 'none'; }, 150);
  });

  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const val = searchInput.value.trim();
      if (val) {
        // Save to history (dedup, newest first, max 10)
        searchHistoryCache = searchHistoryCache.filter(h => h !== val);
        searchHistoryCache.unshift(val);
        if (searchHistoryCache.length > 10) searchHistoryCache.length = 10;
        await window.electronAPI.saveSearchHistory(searchHistoryCache);
        searchHistoryDropdown.style.display = 'none';
      }
    }
  });

  function renderSearchHistory() {
    if (searchHistoryCache.length === 0) {
      searchHistoryDropdown.style.display = 'none';
      return;
    }
    searchHistoryDropdown.innerHTML = '';
    searchHistoryCache.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'search-history-item';
      const text = document.createElement('span');
      text.className = 'search-history-text';
      text.textContent = item;
      text.addEventListener('mousedown', (e) => {
        e.preventDefault();
        searchInput.value = item;
        searchQuery = item.toLowerCase();
        renderProjectList();
        searchHistoryDropdown.style.display = 'none';
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'search-history-del';
      delBtn.innerHTML = icons.x;
      delBtn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        searchHistoryCache.splice(idx, 1);
        await window.electronAPI.saveSearchHistory(searchHistoryCache);
        renderSearchHistory();
      });
      row.appendChild(text);
      row.appendChild(delBtn);
      searchHistoryDropdown.appendChild(row);
    });
    searchHistoryDropdown.style.display = 'block';
  }
}

function navigateProjectList(key) {
  // Get all visible project items in the DOM (both pinned and unpinned)
  const pinnedItems = Array.from(document.querySelectorAll('.pinned-item'));
  const projectItems = Array.from(document.querySelectorAll('.project-item'));

  if (pinnedItems.length === 0 && projectItems.length === 0) return;

  // Find currently selected item
  const selectedPinned = document.querySelector('.pinned-item.active');
  const selectedProject = document.querySelector('.project-item.active');
  const selectedItem = selectedPinned || selectedProject;

  let nextItem = null;

  if (selectedPinned) {
    // Currently in pinned grid (3 columns)
    const currentIndex = pinnedItems.indexOf(selectedPinned);
    const cols = 3;
    const currentRow = Math.floor(currentIndex / cols);
    const currentCol = currentIndex % cols;
    const totalRows = Math.ceil(pinnedItems.length / cols);

    if (key === 'ArrowLeft') {
      // Move left in the same row
      if (currentCol > 0) {
        nextItem = pinnedItems[currentIndex - 1];
      } else {
        // Wrap to end of previous row
        const prevRowLastIndex = currentIndex - 1;
        if (prevRowLastIndex >= 0) {
          nextItem = pinnedItems[prevRowLastIndex];
        }
      }
    } else if (key === 'ArrowRight') {
      // Move right in the same row
      if (currentCol < cols - 1 && currentIndex + 1 < pinnedItems.length) {
        nextItem = pinnedItems[currentIndex + 1];
      } else {
        // Wrap to start of next row or first unpinned item
        if (currentRow < totalRows - 1 && currentIndex + 1 < pinnedItems.length) {
          nextItem = pinnedItems[currentIndex + 1];
        } else if (projectItems.length > 0) {
          nextItem = projectItems[0];
        }
      }
    } else if (key === 'ArrowUp') {
      // Move up one row
      const upIndex = currentIndex - cols;
      if (upIndex >= 0) {
        nextItem = pinnedItems[upIndex];
      } else {
        // Wrap to last row
        const lastRowStartIndex = (totalRows - 1) * cols;
        const targetIndex = lastRowStartIndex + currentCol;
        nextItem = pinnedItems[Math.min(targetIndex, pinnedItems.length - 1)];
      }
    } else if (key === 'ArrowDown') {
      // Move down one row
      const downIndex = currentIndex + cols;
      if (downIndex < pinnedItems.length) {
        nextItem = pinnedItems[downIndex];
      } else if (projectItems.length > 0) {
        // Move to first unpinned item
        nextItem = projectItems[0];
      } else {
        // Wrap to first row
        nextItem = pinnedItems[currentCol] || pinnedItems[0];
      }
    }
  } else if (selectedProject) {
    // Currently in unpinned list
    const currentIndex = projectItems.indexOf(selectedProject);

    if (key === 'ArrowDown' || key === 'ArrowRight') {
      if (currentIndex < projectItems.length - 1) {
        nextItem = projectItems[currentIndex + 1];
      } else if (pinnedItems.length > 0) {
        // Wrap to first pinned item
        nextItem = pinnedItems[0];
      } else {
        // Wrap to first unpinned item
        nextItem = projectItems[0];
      }
    } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
      if (currentIndex > 0) {
        nextItem = projectItems[currentIndex - 1];
      } else if (pinnedItems.length > 0) {
        // Move to last pinned item
        nextItem = pinnedItems[pinnedItems.length - 1];
      } else {
        // Wrap to last unpinned item
        nextItem = projectItems[projectItems.length - 1];
      }
    }
  } else {
    // No selection, select first item
    nextItem = pinnedItems[0] || projectItems[0];
  }

  if (nextItem) {
    const projectId = nextItem.dataset.projectId;
    const project = projects.find(p => p.id === projectId);
    if (project) {
      selectProject(project);
      nextItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + N: New project
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      openModal(false);
    }
    // Escape: Close modal
    if (e.key === 'Escape') {
      if (settingsModal.classList.contains('show')) closeSettings();
      else if (projectModal.classList.contains('show')) closeModal();
    }
    // Enter: Save in project modal
    if (e.key === 'Enter' && projectModal.classList.contains('show')) {
      e.preventDefault();
      saveProject();
    }
    // Cmd/Ctrl + S: Quick export settings
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      quickExportSettings();
    }
    // Cmd/Ctrl + H: Hide window
    if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
      e.preventDefault();
      window.electronAPI.hideWindow();
    }
    // Cmd/Ctrl + M: Minimize window
    if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
      e.preventDefault();
      window.electronAPI.minimizeWindow();
    }
    // Cmd/Ctrl + F: Focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
    }
    // Arrow keys: Navigate project list
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      // Only handle if not in input/textarea and no modal is open
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (projectModal.classList.contains('show') || settingsModal.classList.contains('show')) return;

      e.preventDefault();
      navigateProjectList(e.key);
    }
  });
}

// === Data ===
async function loadProjects() {
  const result = await window.electronAPI.getProjects();
  if (result.success) {
    projects = result.data;
    renderProjectList();
  } else {
    showToast(t('msg.loadFailed') + ': ' + result.error, 'error');
  }
}

// === Render ===
function renderProjectList() {
  projectList.innerHTML = '';
  const filtered = searchQuery
    ? projects.filter(p => p.name.toLowerCase().includes(searchQuery) || p.path.toLowerCase().includes(searchQuery))
    : projects;

  if (filtered.length === 0) {
    projectList.innerHTML = `
      <div class="empty-state">
        ${icons.folder}
        <p>${searchQuery ? t('msg.noMatch') : t('msg.noProjects')}</p>
      </div>`;
    return;
  }

  const pinned = filtered.filter(p => p.pinned);
  const unpinned = filtered.filter(p => !p.pinned);

  // Pinned grid
  if (pinned.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'pinned-grid';
    let pinnedDraggedEl = null;

    pinned.forEach((project) => {
      const item = document.createElement('div');
      item.className = 'pinned-item';
      if (currentProject && currentProject.id === project.id) item.classList.add('active');
      item.title = project.name;
      item.dataset.projectId = project.id;
      item.draggable = true;
      item.textContent = project.name;
      item.addEventListener('click', () => selectProject(project));

      // Drag & drop for pinned items
      item.addEventListener('dragstart', (e) => {
        pinnedDraggedEl = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/pinned', project.id);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        grid.querySelectorAll('.pinned-item').forEach(i => i.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (pinnedDraggedEl && pinnedDraggedEl !== item) item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!pinnedDraggedEl || pinnedDraggedEl === item) return;
        const draggedId = pinnedDraggedEl.dataset.projectId;
        const targetId = item.dataset.projectId;
        const draggedIdx = projects.findIndex(p => p.id === draggedId);
        const targetIdx = projects.findIndex(p => p.id === targetId);
        if (draggedIdx !== -1 && targetIdx !== -1) {
          const [removed] = projects.splice(draggedIdx, 1);
          projects.splice(targetIdx, 0, removed);
          await window.electronAPI.reorderProjects(projects.map(p => p.id));
          renderProjectList();
        }
      });

      grid.appendChild(item);
    });
    projectList.appendChild(grid);
  }

  // Normal list
  unpinned.forEach((project, index) => {
    const item = document.createElement('div');
    item.className = 'project-item';
    item.draggable = true;
    item.dataset.projectId = project.id;
    item.dataset.index = index;
    if (currentProject && currentProject.id === project.id) item.classList.add('active');
    item.innerHTML = `
      <div class="project-item-name">${escapeHtml(project.name)}</div>
      <div class="project-item-path">${escapeHtml(shortenPath(project.path))}</div>
    `;
    item.addEventListener('click', () => selectProject(project));
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragleave', handleDragLeave);
    projectList.appendChild(item);
  });
}

function shortenPath(p) {
  const home = p.replace(/^\/Users\/[^/]+/, '~');
  return home.length > 40 ? '...' + home.slice(-37) : home;
}

// === Drag & Drop ===
function handleDragStart(e) {
  draggedElement = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function handleDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.project-item').forEach(i => i.classList.remove('drag-over'));
}
function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (this !== draggedElement) this.classList.add('drag-over');
  return false;
}
function handleDragLeave() { this.classList.remove('drag-over'); }

async function handleDrop(e) {
  e.stopPropagation();
  if (draggedElement !== this) {
    const draggedId = draggedElement.dataset.projectId;
    const targetId = this.dataset.projectId;
    const draggedIdx = projects.findIndex(p => p.id === draggedId);
    const targetIdx = projects.findIndex(p => p.id === targetId);
    if (draggedIdx !== -1 && targetIdx !== -1) {
      const [removed] = projects.splice(draggedIdx, 1);
      projects.splice(targetIdx, 0, removed);
      await window.electronAPI.reorderProjects(projects.map(p => p.id));
      renderProjectList();
    }
  }
  return false;
}

// === Selection & Details ===
function selectProject(project) {
  currentProject = project;
  renderProjectList();
  showProjectDetails();
}

function showProjectDetails() {
  if (!currentProject) {
    welcomeMessage.style.display = 'flex';
    projectDetails.style.display = 'none';
    return;
  }
  welcomeMessage.style.display = 'none';
  projectDetails.style.display = 'block';
  document.getElementById('projectName').textContent = currentProject.name;
  document.getElementById('projectPath').textContent = currentProject.path || '';
  document.getElementById('outputPath').textContent = currentProject.result_path || '';

  // Hide path sections when empty
  const pathSection = document.getElementById('projectPath').closest('.info-item');
  if (pathSection) pathSection.style.display = currentProject.path ? '' : 'none';

  // Pin button in header
  let pinBtn = document.getElementById('pinProjectBtn');
  if (!pinBtn) {
    pinBtn = document.createElement('button');
    pinBtn.id = 'pinProjectBtn';
    pinBtn.className = 'btn-secondary';
    document.querySelector('.action-buttons').insertBefore(pinBtn, document.getElementById('editProjectBtn'));
  }
  const isPinned = currentProject.pinned;
  pinBtn.innerHTML = `${isPinned ? icons.unpin : icons.pin}<span>${isPinned ? t('pin.unpin') : t('pin.pin')}</span>`;
  pinBtn.onclick = async () => {
    const result = await window.electronAPI.togglePin(currentProject.id);
    if (result.success) {
      currentProject.pinned = result.data.pinned;
      const idx = projects.findIndex(p => p.id === currentProject.id);
      if (idx !== -1) projects[idx].pinned = currentProject.pinned;
      await loadProjects();
      const updated = projects.find(p => p.id === currentProject.id);
      if (updated) { currentProject = updated; showProjectDetails(); }
      renderProjectList();
    }
  };

  // Quick action buttons for URLs and Folders
  renderQuickActionButtons();

  // Hide output path section if empty
  const outputSection = document.getElementById('outputPathSection');
  if (outputSection) outputSection.style.display = currentProject.result_path ? '' : 'none';
  // Load schedule cache for current project then render commands
  loadScheduleCacheForProject(currentProject.id).then(() => {
    renderCommandsDisplay();
    renderUrlBlocks();
    renderFolderBlocks();
    renderFileBlocks();
    renderSubprojectBlocks();
  });
}

function renderCommandsDisplay() {
  const display = document.getElementById('commandsDisplay');
  display.innerHTML = '';
  const commands = currentProject.commands || [];
  const names = currentProject.command_names || [];
  const modes = currentProject.command_modes || [];
  let firstVarInput = null;
  let firstVarPos = -1;

  // 没有命令时隐藏整个命令区域
  const cmdSection = display.closest('.info-item');
  const hasCommands = commands.some(c => c && c.trim());
  if (cmdSection) cmdSection.style.display = hasCommands ? '' : 'none';
  if (!hasCommands) return;

  commands.forEach((command, index) => {
    if (!command && commands.length > 1) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'command-button-wrapper';
    wrapper.draggable = true;
    wrapper.dataset.cmdIndex = index;

    const mode = modes[index] || 'terminal';

    // Drag handle
    const handle = document.createElement('span');
    handle.className = 'cmd-drag-handle';
    handle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'command-input-editable';
    input.value = command || '';
    input.placeholder = 'claude --dangerously-skip-permissions ...';
    // Enter to execute
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = input.value.trim();
        if (cmd) executeCommand(cmd, index);
      }
    });

    // Track first {} variable position
    const varMatch = (command || '').indexOf('{}');
    if (varMatch !== -1 && !firstVarInput) {
      firstVarInput = input;
      firstVarPos = varMatch;
    }

    // Command name input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'command-name-input';
    nameInput.value = names[index] || '';
    nameInput.placeholder = t('details.cmdName') || 'Name';

    // Mode toggle button (terminal ↔ silent)
    const modeBtn = document.createElement('button');
    modeBtn.className = 'btn-mode-toggle' + (mode === 'silent' ? ' mode-silent' : '');
    modeBtn.innerHTML = mode === 'silent' ? icons.silent : icons.terminal;
    modeBtn.title = mode === 'silent' ? t('mode.clickToTerminal') : t('mode.clickToSilent');
    modeBtn.addEventListener('click', async () => {
      const newMode = mode === 'silent' ? 'terminal' : 'silent';
      const newModes = [...(currentProject.command_modes || [])];
      while (newModes.length <= index) newModes.push('terminal');
      newModes[index] = newMode;
      currentProject.command_modes = newModes;
      await window.electronAPI.updateProject(currentProject.id, { command_modes: newModes });
      renderCommandsDisplay();
    });

    // Schedule (闹钟) button
    const cachedSchedule = commandScheduleCache[currentProject.id]?.[index];
    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'btn-schedule-command';
    scheduleBtn.innerHTML = icons.clock;
    scheduleBtn.title = t('schedule.title') || 'Schedule';
    if (cachedSchedule && cachedSchedule.enabled) {
      scheduleBtn.classList.add('schedule-active');
    }
    scheduleBtn.addEventListener('click', () => {
      openScheduleDialog(currentProject, index, input.value.trim(), names[index] || '');
    });

    const execBtn = document.createElement('button');
    execBtn.className = 'btn-execute-command';
    if (mode === 'silent') {
      execBtn.innerHTML = `${icons.silent} ${t('action.runSilent')}`;
      execBtn.classList.add('btn-execute-silent');
    } else {
      execBtn.innerHTML = `${icons.play} ${t('action.run')}`;
    }
    execBtn.addEventListener('click', () => {
      const cmd = input.value.trim();
      if (cmd) executeCommand(cmd, index);
      else showToast(t('msg.emptyCommand'), 'error');
    });

    wrapper.appendChild(handle);
    wrapper.appendChild(input);
    wrapper.appendChild(nameInput);
    wrapper.appendChild(modeBtn);
    wrapper.appendChild(scheduleBtn);
    wrapper.appendChild(execBtn);
    display.appendChild(wrapper);
    setupCommandInputDragDrop(input);

    // Command row drag & drop reorder
    wrapper.addEventListener('dragstart', (e) => {
      if (e.target !== wrapper) { e.preventDefault(); return; }
      wrapper.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    });
    wrapper.addEventListener('dragend', () => {
      wrapper.classList.remove('dragging');
      display.querySelectorAll('.command-button-wrapper').forEach(w => w.classList.remove('cmd-drag-over'));
    });
    wrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = display.querySelector('.dragging');
      if (dragging && dragging !== wrapper) wrapper.classList.add('cmd-drag-over');
    });
    wrapper.addEventListener('dragleave', () => wrapper.classList.remove('cmd-drag-over'));
    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      wrapper.classList.remove('cmd-drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = parseInt(wrapper.dataset.cmdIndex);
      if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
      const cmds = [...currentProject.commands];
      const [moved] = cmds.splice(fromIdx, 1);
      cmds.splice(toIdx, 0, moved);
      const nms = [...(currentProject.command_names || [])];
      const [movedName] = nms.splice(fromIdx, 1);
      nms.splice(toIdx, 0, movedName || '');
      const mds = [...(currentProject.command_modes || [])];
      const [movedMode] = mds.splice(fromIdx, 1);
      mds.splice(toIdx, 0, movedMode || 'terminal');
      currentProject.commands = cmds;
      currentProject.command_names = nms;
      currentProject.command_modes = mds;
      window.electronAPI.updateProject(currentProject.id, { commands: cmds, command_names: nms, command_modes: mds });
      renderCommandsDisplay();
    });

    // Only handle drag on the handle, not the inputs
    handle.addEventListener('mousedown', () => { wrapper.draggable = true; });
    input.addEventListener('mousedown', () => { wrapper.draggable = false; });
    nameInput.addEventListener('mousedown', () => { wrapper.draggable = false; });
  });

  // Focus first {} variable
  if (firstVarInput) {
    setTimeout(() => {
      firstVarInput.focus();
      firstVarInput.setSelectionRange(firstVarPos, firstVarPos + 2);
    }, 100);
  }
}

// === URL Blocks (Details Page) ===
function renderUrlBlocks() {
  const urls = currentProject?.urls || [];
  // Remove existing url section
  let urlSection = document.getElementById('urlBlocksSection');
  if (urlSection) urlSection.remove();

  if (urls.length === 0) return;

  const detailsContent = document.querySelector('.details-content');
  urlSection = document.createElement('div');
  urlSection.id = 'urlBlocksSection';
  urlSection.className = 'info-item';
  const label = document.createElement('label');
  label.textContent = t('url.title') || 'URLs';
  const container = document.createElement('div');
  container.className = 'url-blocks';
  urls.forEach((u, index) => {
    const block = document.createElement('div');
    block.className = 'url-block';
    block.title = u.url;
    block.draggable = true;
    block.dataset.urlIndex = index;
    block.textContent = u.name || extractDomain(u.url);
    block.addEventListener('click', (e) => {
      if (block.classList.contains('url-dragging')) return;
      window.electronAPI.openUrl(u.url);
    });
    // Drag reorder
    block.addEventListener('dragstart', (e) => {
      block.classList.add('url-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/url-index', index.toString());
      e.dataTransfer.setData('text/drag-type', 'url');
      e.dataTransfer.setData('text/cross-drag-data', JSON.stringify({ type: 'url', url: u.url, name: u.name || '' }));
      e.dataTransfer.setData('text/cross-drag-index', index.toString());
    });
    block.addEventListener('dragend', () => {
      block.classList.remove('url-dragging');
      container.querySelectorAll('.url-block').forEach(b => b.classList.remove('url-drag-over'));
    });
    block.addEventListener('dragover', (e) => {
      // 只接受 URL 类型的拖放
      const dragging = container.querySelector('.url-dragging');
      if (!dragging) return; // 不是 URL 拖放，忽略
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragging !== block) block.classList.add('url-drag-over');
    });
    block.addEventListener('dragleave', () => block.classList.remove('url-drag-over'));
    block.addEventListener('drop', (e) => {
      block.classList.remove('url-drag-over');

      // 只处理 URL 内部排序，其他类型让事件冒泡到 container
      const dragType = e.dataTransfer.getData('text/drag-type');
      if (dragType !== 'url') return;
      e.preventDefault();
      e.stopPropagation();

      const fromIdx = parseInt(e.dataTransfer.getData('text/url-index'));
      if (isNaN(fromIdx)) return;

      const toIdx = parseInt(block.dataset.urlIndex);
      if (isNaN(toIdx) || fromIdx === toIdx) return;

      const newUrls = [...urls];
      const [moved] = newUrls.splice(fromIdx, 1);
      const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
      newUrls.splice(adjustedToIdx, 0, moved);
      currentProject.urls = newUrls;
      window.electronAPI.updateProject(currentProject.id, { urls: newUrls });
      renderUrlBlocks();
    });
    container.appendChild(block);
  });

  // Add quick add button
  const addBtn = document.createElement('button');
  addBtn.className = 'url-block add-url-btn';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = t('url.add') || '+ Add URL';
  addBtn.addEventListener('click', () => {
    openModal(true, currentProject);
    setTimeout(() => {
      // Auto add a new URL input
      addUrlInput();
      // Scroll to the URLs section
      setTimeout(() => {
        const urlsSection = document.getElementById('urlsList');
        if (urlsSection) {
          const lastInput = urlsSection.querySelector('.command-item:last-child input');
          if (lastInput) {
            lastInput.focus();
            lastInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }, 100);
    }, 250);
  });
  container.appendChild(addBtn);

  // Accept sp-item drops (move from subproject → URL list)
  container.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/drag-type')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  container.addEventListener('drop', async (e) => {
    const dragType = e.dataTransfer.getData('text/drag-type');
    if (dragType !== 'sp-item') return;
    e.preventDefault();
    e.stopPropagation();
    const itemDataStr = e.dataTransfer.getData('text/sp-item-data');
    if (!itemDataStr) return;
    const itemData = JSON.parse(itemDataStr);
    if (itemData.type !== 'url') return;
    // Add to urls
    const newUrl = { url: itemData.url, name: itemData.name || '' };
    currentProject.urls = [...(currentProject.urls || []), newUrl];
    // Remove from source subproject
    const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
    const fromItemIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
    if (!isNaN(fromSpIdx) && !isNaN(fromItemIdx) && currentProject.subprojects?.[fromSpIdx]) {
      currentProject.subprojects[fromSpIdx].items.splice(fromItemIdx, 1);
    }
    await window.electronAPI.updateProject(currentProject.id, { urls: currentProject.urls, subprojects: currentProject.subprojects });
    showProjectDetails();
  });

  urlSection.appendChild(label);
  urlSection.appendChild(container);

  // 插入到正确位置：URL 应该在 Folder 和 File 之前
  const folderSection = document.getElementById('folderBlocksSection');
  const fileSection = document.getElementById('fileBlocksSection');
  if (folderSection) {
    detailsContent.insertBefore(urlSection, folderSection);
  } else if (fileSection) {
    detailsContent.insertBefore(urlSection, fileSection);
  } else {
    detailsContent.appendChild(urlSection);
  }
}

// === Folder Blocks (Details Page) ===
function renderFolderBlocks() {
  const folders = currentProject?.folders || [];
  let folderSection = document.getElementById('folderBlocksSection');
  if (folderSection) folderSection.remove();
  if (folders.length === 0) return;

  const detailsContent = document.querySelector('.details-content');
  folderSection = document.createElement('div');
  folderSection.id = 'folderBlocksSection';
  folderSection.className = 'info-item';
  const label = document.createElement('label');
  label.textContent = t('folder.title') || 'Folders';
  const container = document.createElement('div');
  container.className = 'url-blocks';
  folders.forEach((f, index) => {
    const block = document.createElement('div');
    block.className = 'url-block folder-block';
    block.title = f.path;
    block.draggable = true;
    block.dataset.folderIndex = index;
    block.textContent = f.name || f.path.split('/').pop() || f.path;
    block.addEventListener('click', (e) => {
      if (block.classList.contains('folder-dragging')) return;
      window.electronAPI.openFolder(f.path);
    });
    // Drag reorder
    block.addEventListener('dragstart', (e) => {
      block.classList.add('folder-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/folder-index', index.toString());
      e.dataTransfer.setData('text/drag-type', 'folder');
      e.dataTransfer.setData('text/cross-drag-data', JSON.stringify({ type: 'folder', path: f.path, name: f.name || '' }));
      e.dataTransfer.setData('text/cross-drag-index', index.toString());
    });
    block.addEventListener('dragend', () => {
      block.classList.remove('folder-dragging');
      container.querySelectorAll('.folder-block').forEach(b => b.classList.remove('folder-drag-over'));
    });
    block.addEventListener('dragover', (e) => {
      // 只接受文件夹类型的拖放
      const dragging = container.querySelector('.folder-dragging');
      if (!dragging) return; // 不是文件夹拖放，忽略
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragging !== block) block.classList.add('folder-drag-over');
    });
    block.addEventListener('dragleave', () => block.classList.remove('folder-drag-over'));
    block.addEventListener('drop', (e) => {
      block.classList.remove('folder-drag-over');

      // 只处理 folder 内部排序，其他类型让事件冒泡到 container
      const dragType = e.dataTransfer.getData('text/drag-type');
      if (dragType !== 'folder') return;
      e.preventDefault();
      e.stopPropagation();

      console.log('[Folder Drag] === DROP EVENT ===');
      console.log('[Folder Drag] Dropped on block:', block.textContent);
      console.log('[Folder Drag] Block dataset.folderIndex:', block.dataset.folderIndex);

      const fromIdx = parseInt(e.dataTransfer.getData('text/folder-index'));
      console.log('[Folder Drag] From index (from dataTransfer):', fromIdx);
      if (isNaN(fromIdx)) {
        console.log('[Folder Drag] Invalid fromIdx, aborting');
        return;
      }

      // 使用 dataset 中的原始索引
      const toIdx = parseInt(block.dataset.folderIndex);
      console.log('[Folder Drag] To index (from dataset):', toIdx);
      console.log('[Folder Drag] Current folders before reorder:', folders.map((folder, i) => `${i}: ${folder.name || folder.path.split('/').pop()}`));

      if (isNaN(toIdx) || fromIdx === toIdx) {
        console.log('[Folder Drag] Invalid toIdx or same position, aborting');
        return;
      }

      // 正确的拖放排序逻辑
      const newFolders = [...folders];
      console.log('[Folder Drag] Step 1 - Copy array:', newFolders.map((folder, i) => `${i}: ${folder.name || folder.path.split('/').pop()}`));

      const [moved] = newFolders.splice(fromIdx, 1);
      console.log('[Folder Drag] Step 2 - After splice(fromIdx, 1):', newFolders.map((folder, i) => `${i}: ${folder.name || folder.path.split('/').pop()}`));
      console.log('[Folder Drag] Moved item:', moved.name || moved.path.split('/').pop());

      const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
      console.log('[Folder Drag] Adjusted toIdx:', adjustedToIdx, '(original:', toIdx, ', fromIdx:', fromIdx, ')');

      newFolders.splice(adjustedToIdx, 0, moved);
      console.log('[Folder Drag] Step 3 - After splice(adjustedToIdx, 0, moved):', newFolders.map((folder, i) => `${i}: ${folder.name || folder.path.split('/').pop()}`));

      currentProject.folders = newFolders;
      window.electronAPI.updateProject(currentProject.id, { folders: newFolders });
      console.log('[Folder Drag] === REORDERING COMPLETE, CALLING renderFolderBlocks() ===');
      renderFolderBlocks();
    });
    container.appendChild(block);
  });

  // Add quick add button
  const addBtn = document.createElement('button');
  addBtn.className = 'url-block add-url-btn';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = t('folder.add') || '+ Add Folder';
  addBtn.addEventListener('click', () => {
    openModal(true, currentProject);
    setTimeout(() => {
      // Auto add a new folder input
      addFolderInput();
      // Scroll to the Folders section and focus the new input
      setTimeout(() => {
        const foldersSection = document.getElementById('foldersList');
        if (foldersSection) {
          const lastItem = foldersSection.querySelector('.command-item:last-child');
          if (lastItem) {
            // Focus on the name input (second input in the item)
            const nameInput = lastItem.querySelectorAll('input')[1];
            if (nameInput) {
              nameInput.focus();
              nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }
      }, 100);
    }, 250);
  });

  // Drag and drop support for Add Folder button
  addBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Drag] Dragover on folder add button');
    addBtn.style.opacity = '0.7';
    addBtn.style.transform = 'scale(1.1)';
    addBtn.style.borderColor = 'rgba(59, 130, 246, 0.8)';
  });
  addBtn.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Drag] Dragleave on folder add button');
    addBtn.style.opacity = '';
    addBtn.style.transform = '';
    addBtn.style.borderColor = '';
  });
  addBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Drag] Drop on folder add button', e.dataTransfer.files);
    addBtn.style.opacity = '';
    addBtn.style.transform = '';
    addBtn.style.borderColor = '';

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const newFolders = [];
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i].path;
        console.log('[Drag] Checking path:', filePath);
        const pathInfo = await window.electronAPI.checkPathType(filePath);
        console.log('[Drag] Path info:', pathInfo);
        if (pathInfo && pathInfo.isDirectory) {
          const folderName = filePath.split('/').pop() || '';
          newFolders.push({ path: filePath, name: folderName });
        }
      }
      console.log('[Drag] New folders to add:', newFolders);
      if (newFolders.length > 0) {
        const updatedFolders = [...(currentProject.folders || []), ...newFolders];
        currentProject.folders = updatedFolders;
        await window.electronAPI.updateProject(currentProject.id, { folders: updatedFolders });
        renderFolderBlocks();
        showToast(`Added ${newFolders.length} folder(s)`, 'success');
      }
    }
  });

  container.appendChild(addBtn);

  // Accept sp-item drops (move from subproject → Folder list)
  container.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/drag-type')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  container.addEventListener('drop', async (e) => {
    const dragType = e.dataTransfer.getData('text/drag-type');
    if (dragType !== 'sp-item') return;
    e.preventDefault();
    e.stopPropagation();
    const itemDataStr = e.dataTransfer.getData('text/sp-item-data');
    if (!itemDataStr) return;
    const itemData = JSON.parse(itemDataStr);
    if (itemData.type !== 'folder') return;
    currentProject.folders = [...(currentProject.folders || []), { path: itemData.path, name: itemData.name || '' }];
    const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
    const fromItemIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
    if (!isNaN(fromSpIdx) && !isNaN(fromItemIdx) && currentProject.subprojects?.[fromSpIdx]) {
      currentProject.subprojects[fromSpIdx].items.splice(fromItemIdx, 1);
    }
    await window.electronAPI.updateProject(currentProject.id, { folders: currentProject.folders, subprojects: currentProject.subprojects });
    showProjectDetails();
  });

  folderSection.appendChild(label);
  folderSection.appendChild(container);

  // 插入到正确位置：Folder 应该在 URL 之后、File 之前
  const fileSection = document.getElementById('fileBlocksSection');
  if (fileSection) {
    detailsContent.insertBefore(folderSection, fileSection);
  } else {
    detailsContent.appendChild(folderSection);
  }
}

// === File Blocks (Details Page) ===
function renderFileBlocks() {
  const files = currentProject?.files || [];
  let fileSection = document.getElementById('fileBlocksSection');
  if (fileSection) fileSection.remove();
  if (files.length === 0) return;

  const detailsContent = document.querySelector('.details-content');
  fileSection = document.createElement('div');
  fileSection.id = 'fileBlocksSection';
  fileSection.className = 'info-item';
  const label = document.createElement('label');
  label.textContent = t('file.title') || 'Files';
  const container = document.createElement('div');
  container.className = 'url-blocks';
  files.forEach((f, index) => {
    const block = document.createElement('div');
    block.className = 'url-block file-block';
    block.title = f.path;
    block.draggable = true;
    block.dataset.fileIndex = index;
    block.textContent = f.name || f.path.split('/').pop() || f.path;
    block.addEventListener('click', (e) => {
      if (block.classList.contains('file-dragging')) return;
      window.electronAPI.openFileWithDefault(f.path);
    });
    // Drag reorder
    block.addEventListener('dragstart', (e) => {
      block.classList.add('file-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/file-index', index.toString());
      e.dataTransfer.setData('text/drag-type', 'file');
      e.dataTransfer.setData('text/cross-drag-data', JSON.stringify({ type: 'file', path: f.path, name: f.name || '' }));
      e.dataTransfer.setData('text/cross-drag-index', index.toString());
    });
    block.addEventListener('dragend', () => {
      block.classList.remove('file-dragging');
      container.querySelectorAll('.file-block').forEach(b => b.classList.remove('file-drag-over'));
    });
    block.addEventListener('dragover', (e) => {
      // 只接受文件类型的拖放
      const dragging = container.querySelector('.file-dragging');
      if (!dragging) return; // 不是文件拖放，忽略
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dragging !== block) block.classList.add('file-drag-over');
    });
    block.addEventListener('dragleave', () => block.classList.remove('file-drag-over'));
    block.addEventListener('drop', (e) => {
      block.classList.remove('file-drag-over');

      // 只处理 file 内部排序，其他类型让事件冒泡到 container
      const dragType = e.dataTransfer.getData('text/drag-type');
      if (dragType !== 'file') return;
      e.preventDefault();
      e.stopPropagation();

      console.log('[File Drag] === DROP EVENT ===');
      console.log('[File Drag] Dropped on block:', block.textContent);
      console.log('[File Drag] Block dataset.fileIndex:', block.dataset.fileIndex);

      const fromIdx = parseInt(e.dataTransfer.getData('text/file-index'));
      console.log('[File Drag] From index (from dataTransfer):', fromIdx);
      if (isNaN(fromIdx)) {
        console.log('[File Drag] Invalid fromIdx, aborting');
        return;
      }

      // 使用 dataset 中的原始索引
      const toIdx = parseInt(block.dataset.fileIndex);
      console.log('[File Drag] To index (from dataset):', toIdx);
      console.log('[File Drag] Current files before reorder:', files.map((file, i) => `${i}: ${file.name || file.path.split('/').pop()}`));

      if (isNaN(toIdx) || fromIdx === toIdx) {
        console.log('[File Drag] Invalid toIdx or same position, aborting');
        return;
      }

      // 正确的拖放排序逻辑
      const newFiles = [...files];
      console.log('[File Drag] Step 1 - Copy array:', newFiles.map((file, i) => `${i}: ${file.name || file.path.split('/').pop()}`));

      const [moved] = newFiles.splice(fromIdx, 1);
      console.log('[File Drag] Step 2 - After splice(fromIdx, 1):', newFiles.map((file, i) => `${i}: ${file.name || file.path.split('/').pop()}`));
      console.log('[File Drag] Moved item:', moved.name || moved.path.split('/').pop());

      const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
      console.log('[File Drag] Adjusted toIdx:', adjustedToIdx, '(original:', toIdx, ', fromIdx:', fromIdx, ')');

      newFiles.splice(adjustedToIdx, 0, moved);
      console.log('[File Drag] Step 3 - After splice(adjustedToIdx, 0, moved):', newFiles.map((file, i) => `${i}: ${file.name || file.path.split('/').pop()}`));

      currentProject.files = newFiles;
      window.electronAPI.updateProject(currentProject.id, { files: newFiles });
      console.log('[File Drag] === REORDERING COMPLETE, CALLING renderFileBlocks() ===');
      renderFileBlocks();
    });
    container.appendChild(block);
  });

  // Add quick add button
  const addBtn = document.createElement('button');
  addBtn.className = 'url-block add-url-btn';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = t('file.add') || '+ Add File';
  addBtn.addEventListener('click', () => {
    openModal(true, currentProject);
    setTimeout(() => {
      // Auto add a new file input
      addFileInput();
      // Scroll to the Files section and focus the new input
      setTimeout(() => {
        const filesSection = document.getElementById('filesList');
        if (filesSection) {
          const lastItem = filesSection.querySelector('.command-item:last-child');
          if (lastItem) {
            // Focus on the name input (second input in the item)
            const nameInput = lastItem.querySelectorAll('input')[1];
            if (nameInput) {
              nameInput.focus();
              nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }
      }, 100);
    }, 250);
  });

  // Drag and drop support for adding files
  container.addEventListener('dragover', (e) => {
    // 检查是否是内部拖放排序
    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasDragType = e.dataTransfer.types.includes('text/drag-type');

    // 如果有 drag-type 标记，说明是内部拖放排序，不处理
    if (hasDragType) return;

    // 只有从外部拖入文件时才处理
    if (!hasFiles) return;

    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = '0.7';
  });
  container.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = '';
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.style.opacity = '';

    // 检查是否是内部拖放排序
    const dragType = e.dataTransfer.getData('text/drag-type');
    if (dragType) return; // 内部拖放排序，不处理

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      const newFiles = [];
      for (let i = 0; i < droppedFiles.length; i++) {
        const filePath = droppedFiles[i].path;
        const pathInfo = await window.electronAPI.checkPathType(filePath);
        // 支持所有类型：普通文件、.app 应用、符号链接等
        // 只排除不存在的路径
        if (pathInfo && pathInfo.exists) {
          const fileName = filePath.split('/').pop() || '';
          newFiles.push({ path: filePath, name: fileName });
        }
      }
      console.log('[Drag] New files to add:', newFiles);
      if (newFiles.length > 0) {
        const updatedFiles = [...(currentProject.files || []), ...newFiles];
        currentProject.files = updatedFiles;
        await window.electronAPI.updateProject(currentProject.id, { files: updatedFiles });
        renderFileBlocks();
        showToast(`Added ${newFiles.length} file(s)`, 'success');
      }
    }
  });

  container.appendChild(addBtn);

  // Accept sp-item drops (move from subproject → File list)
  // Note: the container already has dragover/drop for external Files;
  // we add sp-item handling inside the existing drop handler cannot be easily merged,
  // so we add a capturing listener on the container
  const origDragover = container.ondragover;
  container.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/drag-type')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  container.addEventListener('drop', async (e) => {
    const dragType = e.dataTransfer.getData('text/drag-type');
    if (dragType !== 'sp-item') return;
    e.preventDefault();
    e.stopPropagation();
    const itemDataStr = e.dataTransfer.getData('text/sp-item-data');
    if (!itemDataStr) return;
    const itemData = JSON.parse(itemDataStr);
    if (itemData.type !== 'file') return;
    currentProject.files = [...(currentProject.files || []), { path: itemData.path, name: itemData.name || '' }];
    const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
    const fromItemIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
    if (!isNaN(fromSpIdx) && !isNaN(fromItemIdx) && currentProject.subprojects?.[fromSpIdx]) {
      currentProject.subprojects[fromSpIdx].items.splice(fromItemIdx, 1);
    }
    await window.electronAPI.updateProject(currentProject.id, { files: currentProject.files, subprojects: currentProject.subprojects });
    showProjectDetails();
  });

  fileSection.appendChild(label);
  fileSection.appendChild(container);
  detailsContent.appendChild(fileSection);
}

// === Quick Action Buttons (Header) - No longer used ===
function renderQuickActionButtons() {
  // Quick add buttons are now inline with URL/Folder blocks
}

// === Subproject Blocks (Details Page) ===
function renderSubprojectBlocks() {
  const subprojects = currentProject?.subprojects || [];
  let spSection = document.getElementById('subprojectBlocksSection');
  if (spSection) spSection.remove();
  if (subprojects.length === 0) return;

  const detailsContent = document.querySelector('.details-content');
  spSection = document.createElement('div');
  spSection.id = 'subprojectBlocksSection';

  subprojects.forEach((sp, spIndex) => {
    const section = document.createElement('div');
    section.className = 'subproject-section';
    section.dataset.spIndex = spIndex;

    // Header: drag handle + name (delete only in edit modal)
    const header = document.createElement('div');
    header.className = 'subproject-header';
    header.draggable = true;

    const dragHandle = document.createElement('div');
    dragHandle.className = 'sp-section-drag-handle';
    dragHandle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
    header.appendChild(dragHandle);

    const nameEl = document.createElement('span');
    nameEl.className = 'subproject-name';
    nameEl.textContent = sp.name || t('subproject.name');
    nameEl.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'subproject-name-input';
      input.value = sp.name || '';
      input.placeholder = t('subproject.name');
      header.draggable = false; // Disable drag during name edit
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        header.draggable = true; // Re-enable drag after edit
        const newName = input.value.trim() || sp.name;
        sp.name = newName;
        currentProject.subprojects[spIndex].name = newName;
        await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
        renderSubprojectBlocks();
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    });
    header.appendChild(nameEl);
    section.appendChild(header);

    // Subproject section drag reorder
    header.addEventListener('dragstart', (e) => {
      if (e.target.tagName === 'INPUT') { e.preventDefault(); return; }
      section.classList.add('subproject-section-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/drag-type', 'subproject-section');
      e.dataTransfer.setData('text/sp-section-index', spIndex.toString());
    });
    header.addEventListener('dragend', () => {
      section.classList.remove('subproject-section-dragging');
      spSection.querySelectorAll('.subproject-section').forEach(s => {
        s.classList.remove('sp-section-drag-over');
      });
    });

    // Items container
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'subproject-items';

    (sp.items || []).forEach((item, itemIndex) => {
      const block = document.createElement('div');
      block.className = `subproject-item-block type-${item.type}`;
      block.title = item.type === 'url' ? item.url : item.path;
      block.draggable = true;
      block.dataset.itemIndex = itemIndex;
      block.textContent = item.name || (item.type === 'url' ? extractDomain(item.url) : (item.path || '').split('/').pop());

      block.addEventListener('click', () => {
        if (block.classList.contains('sp-dragging')) return;
        if (item.type === 'url') window.electronAPI.openUrl(item.url);
        else if (item.type === 'folder') window.electronAPI.openFolder(item.path);
        else if (item.type === 'file') window.electronAPI.openFileWithDefault(item.path);
      });

      // Drag: carry full item data for cross-section drag
      block.addEventListener('dragstart', (e) => {
        block.classList.add('sp-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/sp-item-index', itemIndex.toString());
        e.dataTransfer.setData('text/sp-index', spIndex.toString());
        e.dataTransfer.setData('text/drag-type', 'sp-item');
        e.dataTransfer.setData('text/sp-item-data', JSON.stringify(item));
      });
      block.addEventListener('dragend', () => {
        block.classList.remove('sp-dragging');
        itemsContainer.querySelectorAll('.subproject-item-block').forEach(b => b.classList.remove('sp-drag-over'));
      });
      block.addEventListener('dragover', (e) => {
        const dragging = itemsContainer.querySelector('.sp-dragging');
        if (!dragging) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (dragging !== block) block.classList.add('sp-drag-over');
      });
      block.addEventListener('dragleave', () => block.classList.remove('sp-drag-over'));
      block.addEventListener('drop', async (e) => {
        block.classList.remove('sp-drag-over');
        const dragType = e.dataTransfer.getData('text/drag-type');
        // Only handle internal reorder (sp-item within same subproject)
        // Let other drag types bubble up to section handler
        if (dragType !== 'sp-item') return;
        const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
        if (fromSpIdx !== spIndex) return;
        e.preventDefault();
        e.stopPropagation();
        const fromIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
        const toIdx = parseInt(block.dataset.itemIndex);
        if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
        const items = [...sp.items];
        const [moved] = items.splice(fromIdx, 1);
        const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
        items.splice(adjustedToIdx, 0, moved);
        currentProject.subprojects[spIndex].items = items;
        await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
        renderSubprojectBlocks();
      });
      itemsContainer.appendChild(block);
    });

    // Add item drop zone / button — accepts external files AND cross-section drags
    const addZone = document.createElement('div');
    addZone.className = 'subproject-drop-zone';
    addZone.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    addZone.title = t('subproject.addItem');

    addZone.addEventListener('click', () => {
      openModal(true, currentProject);
      setTimeout(() => {
        const spList = document.getElementById('subprojectsList');
        if (spList) spList.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    });

    // Drop zone accepts: external files, url-blocks, folder-blocks, file-blocks, sp-items from other subprojects
    addZone.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer.types.includes('Files');
      const hasDragType = e.dataTransfer.types.includes('text/drag-type');
      // Accept external files
      if (hasFiles && !hasDragType) {
        e.preventDefault();
        e.stopPropagation();
        addZone.style.transform = 'scale(1.1)';
        addZone.style.borderColor = 'rgba(59, 130, 246, 0.8)';
        return;
      }
      // Accept cross-section drags (url, folder, file, sp-item from another subproject)
      if (hasDragType) {
        e.preventDefault();
        e.stopPropagation();
        addZone.style.transform = 'scale(1.1)';
        addZone.style.borderColor = 'rgba(59, 130, 246, 0.8)';
      }
    });
    addZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      addZone.style.transform = '';
      addZone.style.borderColor = '';
    });
    addZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      addZone.style.transform = '';
      addZone.style.borderColor = '';

      const dragType = e.dataTransfer.getData('text/drag-type');

      // Handle cross-section drag from URL/Folder/File blocks into this subproject
      if (dragType === 'url' || dragType === 'folder' || dragType === 'file') {
        const itemData = e.dataTransfer.getData('text/cross-drag-data');
        if (itemData) {
          const parsed = JSON.parse(itemData);
          if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
          currentProject.subprojects[spIndex].items.push(parsed);

          // Remove from source list
          const sourceIndex = parseInt(e.dataTransfer.getData('text/cross-drag-index'));
          if (!isNaN(sourceIndex)) {
            if (dragType === 'url') {
              currentProject.urls.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { urls: currentProject.urls, subprojects: currentProject.subprojects });
            } else if (dragType === 'folder') {
              currentProject.folders.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { folders: currentProject.folders, subprojects: currentProject.subprojects });
            } else if (dragType === 'file') {
              currentProject.files.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { files: currentProject.files, subprojects: currentProject.subprojects });
            }
          }
          showProjectDetails();
          return;
        }
      }

      // Handle sp-item from another subproject
      if (dragType === 'sp-item') {
        const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
        const fromItemIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
        if (fromSpIdx === spIndex) return; // Same subproject, handled by block drop
        if (isNaN(fromSpIdx) || isNaN(fromItemIdx)) return;
        const movedItem = currentProject.subprojects[fromSpIdx].items.splice(fromItemIdx, 1)[0];
        if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
        currentProject.subprojects[spIndex].items.push(movedItem);
        await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
        renderSubprojectBlocks();
        return;
      }

      // Handle external files from OS
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const newItems = [];
        for (let i = 0; i < files.length; i++) {
          const filePath = files[i].path;
          const pathInfo = await window.electronAPI.checkPathType(filePath);
          if (pathInfo && pathInfo.exists) {
            const itemName = filePath.split('/').pop() || '';
            if (pathInfo.isDirectory) {
              newItems.push({ type: 'folder', path: filePath, name: itemName });
            } else {
              newItems.push({ type: 'file', path: filePath, name: itemName });
            }
          }
        }
        if (newItems.length > 0) {
          if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
          currentProject.subprojects[spIndex].items.push(...newItems);
          await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
          renderSubprojectBlocks();
          showToast(`Added ${newItems.length} item(s)`, 'success');
        }
      }
    });
    itemsContainer.appendChild(addZone);

    section.appendChild(itemsContainer);

    // === Make the entire subproject section a drop zone ===
    section.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer.types.includes('Files');
      const hasDragType = e.dataTransfer.types.includes('text/drag-type');
      const isSectionReorder = e.dataTransfer.types.includes('text/sp-section-index');

      // Subproject section reorder — show border indicator
      if (isSectionReorder) {
        e.preventDefault();
        if (!section.classList.contains('subproject-section-dragging')) {
          section.classList.add('sp-section-drag-over');
        }
        return;
      }

      // Item drops — show fill highlight
      if (hasFiles && !hasDragType) {
        e.preventDefault();
        section.classList.add('subproject-section-drag-over');
        return;
      }
      if (hasDragType) {
        e.preventDefault();
        section.classList.add('subproject-section-drag-over');
      }
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget)) {
        section.classList.remove('subproject-section-drag-over');
        section.classList.remove('sp-section-drag-over');
      }
    });
    section.addEventListener('drop', async (e) => {
      e.preventDefault();
      section.classList.remove('subproject-section-drag-over');
      section.classList.remove('sp-section-drag-over');

      const dragType = e.dataTransfer.getData('text/drag-type');

      // Subproject section reorder
      if (dragType === 'subproject-section') {
        const fromIdx = parseInt(e.dataTransfer.getData('text/sp-section-index'));
        const toIdx = spIndex;
        if (isNaN(fromIdx) || fromIdx === toIdx) return;
        const sps = [...currentProject.subprojects];
        const [moved] = sps.splice(fromIdx, 1);
        const adjustedToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
        sps.splice(adjustedToIdx, 0, moved);
        currentProject.subprojects = sps;
        await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
        renderSubprojectBlocks();
        return;
      }

      // Cross-section drag from URL/Folder/File blocks
      if (dragType === 'url' || dragType === 'folder' || dragType === 'file') {
        const itemData = e.dataTransfer.getData('text/cross-drag-data');
        if (itemData) {
          const parsed = JSON.parse(itemData);
          if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
          currentProject.subprojects[spIndex].items.push(parsed);
          const sourceIndex = parseInt(e.dataTransfer.getData('text/cross-drag-index'));
          if (!isNaN(sourceIndex)) {
            if (dragType === 'url') {
              currentProject.urls.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { urls: currentProject.urls, subprojects: currentProject.subprojects });
            } else if (dragType === 'folder') {
              currentProject.folders.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { folders: currentProject.folders, subprojects: currentProject.subprojects });
            } else if (dragType === 'file') {
              currentProject.files.splice(sourceIndex, 1);
              await window.electronAPI.updateProject(currentProject.id, { files: currentProject.files, subprojects: currentProject.subprojects });
            }
          }
          showProjectDetails();
          return;
        }
      }

      // sp-item from another subproject
      if (dragType === 'sp-item') {
        const fromSpIdx = parseInt(e.dataTransfer.getData('text/sp-index'));
        const fromItemIdx = parseInt(e.dataTransfer.getData('text/sp-item-index'));
        if (fromSpIdx === spIndex) return;
        if (isNaN(fromSpIdx) || isNaN(fromItemIdx)) return;
        const movedItem = currentProject.subprojects[fromSpIdx].items.splice(fromItemIdx, 1)[0];
        if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
        currentProject.subprojects[spIndex].items.push(movedItem);
        await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
        renderSubprojectBlocks();
        return;
      }

      // External files from OS
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const newItems = [];
        for (let i = 0; i < files.length; i++) {
          const filePath = files[i].path;
          const pathInfo = await window.electronAPI.checkPathType(filePath);
          if (pathInfo && pathInfo.exists) {
            const itemName = filePath.split('/').pop() || '';
            if (pathInfo.isDirectory) {
              newItems.push({ type: 'folder', path: filePath, name: itemName });
            } else {
              newItems.push({ type: 'file', path: filePath, name: itemName });
            }
          }
        }
        if (newItems.length > 0) {
          if (!currentProject.subprojects[spIndex].items) currentProject.subprojects[spIndex].items = [];
          currentProject.subprojects[spIndex].items.push(...newItems);
          await window.electronAPI.updateProject(currentProject.id, { subprojects: currentProject.subprojects });
          renderSubprojectBlocks();
          showToast(`Added ${newItems.length} item(s)`, 'success');
        }
      }
    });

    spSection.appendChild(section);
  });

  detailsContent.appendChild(spSection);
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace('www.', '').split('.')[0];
  } catch {
    return url.slice(0, 10);
  }
}

// === Modal ===
function openModal(editMode = false, project = null) {
  isEditMode = editMode;
  document.getElementById('modalTitle').textContent = editMode ? t('modal.editProject') : t('modal.newProject');
  if (editMode && project) {
    document.getElementById('modalProjectName').value = project.name;
    document.getElementById('modalProjectPath').value = project.path;
    document.getElementById('modalOutputPath').value = project.result_path;
    renderCommandInputs(project.commands || [], project.command_names || [], project.command_modes || []);
    renderUrlInputs(project.urls || []);
    renderFolderInputs(project.folders || []);
    renderFileInputs(project.files || []);
    renderSubprojectInputs(project.subprojects || []);
  } else {
    document.getElementById('modalProjectName').value = '';
    document.getElementById('modalProjectPath').value = '';
    document.getElementById('modalOutputPath').value = '';
    renderCommandInputs(['claude --dangerously-skip-permissions '], [''], ['terminal']);
    renderUrlInputs([]);
    renderFolderInputs([]);
    renderSubprojectInputs([]);
  }
  projectModal.classList.add('show');
  // Focus first input after animation
  setTimeout(() => document.getElementById('modalProjectName').focus(), 220);
}

function renderCommandInputs(commands = [], names = [], modes = []) {
  const list = document.getElementById('commandsList');
  list.innerHTML = '';
  if (commands.length === 0) { commands = ['']; names = ['']; modes = ['terminal']; }
  commands.forEach((cmd, i) => addCommandInputWithValue(cmd, names[i] || '', modes[i] || 'terminal'));
}

function addCommandInputWithValue(value = '', name = '', mode = 'terminal') {
  const list = document.getElementById('commandsList');
  const item = document.createElement('div');
  item.className = 'command-item';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input';
  input.placeholder = 'claude --dangerously-skip-permissions ...';
  input.value = value;

  // 自动保存：命令输入框失焦时保存
  input.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input command-name-field';
  nameInput.placeholder = t('modal.cmdName') || 'Name';
  nameInput.value = name;

  // 自动保存：名称输入框失焦时保存
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  // Mode toggle for modal
  const modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.className = 'btn-mode-toggle-modal' + (mode === 'silent' ? ' mode-silent' : '');
  modeBtn.innerHTML = mode === 'silent' ? icons.silent : icons.terminal;
  modeBtn.title = mode === 'silent' ? t('mode.clickToTerminal') : t('mode.clickToSilent');
  modeBtn.dataset.mode = mode;
  modeBtn.addEventListener('click', () => {
    const cur = modeBtn.dataset.mode;
    const newMode = cur === 'silent' ? 'terminal' : 'silent';
    modeBtn.dataset.mode = newMode;
    modeBtn.innerHTML = newMode === 'silent' ? icons.silent : icons.terminal;
    modeBtn.title = newMode === 'silent' ? t('mode.clickToTerminal') : t('mode.clickToSilent');
    modeBtn.classList.toggle('mode-silent', newMode === 'silent');
    // 自动保存：模式切换时保存
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'btn-browse-cmd';
  browseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  browseBtn.title = t('modal.browseFile') || 'Browse file';
  browseBtn.addEventListener('click', async () => {
    const projectPath = document.getElementById('modalProjectPath').value.trim();
    const result = await window.electronAPI.selectFile(projectPath || undefined);
    if (!result.canceled && result.path) {
      // 使用绝对路径，不转换为相对路径
      input.value = result.path;
      input.focus();
      // 自动保存
      if (isEditMode && currentProject) {
        autoSaveProject();
      }
    }
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-command';
  removeBtn.innerHTML = icons.x;
  removeBtn.addEventListener('click', () => {
    item.remove();
    // 自动保存
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });
  item.appendChild(input);
  item.appendChild(nameInput);
  item.appendChild(modeBtn);
  item.appendChild(browseBtn);
  item.appendChild(removeBtn);
  list.appendChild(item);
}

function addCommandInput() {
  addCommandInputWithValue('claude --dangerously-skip-permissions ', '', 'terminal');
}

// === URL Inputs ===
function renderUrlInputs(urls = []) {
  const list = document.getElementById('urlsList');
  list.innerHTML = '';
  urls.forEach(u => addUrlInputWithValue(u.url || '', u.name || ''));
}

function addUrlInputWithValue(url = '', name = '') {
  const list = document.getElementById('urlsList');
  const item = document.createElement('div');
  item.className = 'command-item';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'form-input';
  urlInput.placeholder = 'https://...';
  urlInput.value = url;

  // 自动保存：URL 输入框失焦时保存
  urlInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input command-name-field';
  nameInput.placeholder = t('url.name') || 'Name';
  nameInput.value = name;

  // 自动保存：名称输入框失焦时保存
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-command';
  removeBtn.innerHTML = icons.x;
  removeBtn.addEventListener('click', () => {
    item.remove();
    // 自动保存
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });
  item.appendChild(urlInput);
  item.appendChild(nameInput);
  item.appendChild(removeBtn);
  list.appendChild(item);
}

function addUrlInput() {
  addUrlInputWithValue('', '');
}

// === Folder Inputs (Modal) ===
function renderFolderInputs(folders = []) {
  const list = document.getElementById('foldersList');
  list.innerHTML = '';
  folders.forEach(f => addFolderInputWithValue(f.path || '', f.name || ''));
}

function addFolderInputWithValue(folderPath = '', name = '') {
  const list = document.getElementById('foldersList');
  const item = document.createElement('div');
  item.className = 'command-item';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'form-input';
  pathInput.placeholder = '/path/to/folder';
  pathInput.value = folderPath;
  pathInput.readOnly = true;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input command-name-field';
  nameInput.placeholder = t('folder.name') || 'Name';
  nameInput.value = name;

  // 自动保存：名称输入框失焦时保存
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'btn-browse';
  browseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  browseBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.selectFolder();
    if (!result.canceled) {
      pathInput.value = result.path;
      if (!nameInput.value) nameInput.value = result.path.split('/').pop() || '';
      // 自动保存
      if (isEditMode && currentProject) {
        autoSaveProject();
      }
    }
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-command';
  removeBtn.innerHTML = icons.x;
  removeBtn.addEventListener('click', () => {
    item.remove();
    // 自动保存
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });
  item.appendChild(pathInput);
  item.appendChild(nameInput);
  item.appendChild(browseBtn);
  item.appendChild(removeBtn);
  list.appendChild(item);
}

function addFolderInput() {
  addFolderInputWithValue('', '');
}

// 新建项目时，将项目路径自动同步为文件夹列表的第一条
function syncProjectPathToFolderList(projPath) {
  if (!projPath) return;
  const list = document.getElementById('foldersList');
  const existing = list.querySelectorAll('.command-item');
  // 如果第一条路径为空或未填，替换它；否则在顶部插入
  if (existing.length > 0) {
    const firstPathInput = existing[0].querySelectorAll('input')[0];
    if (firstPathInput && !firstPathInput.value.trim()) {
      firstPathInput.value = projPath;
      return;
    }
  }
  // 检查是否已存在相同路径，避免重复添加
  for (const item of existing) {
    const inp = item.querySelectorAll('input')[0];
    if (inp && inp.value.trim() === projPath) return;
  }
  // 在列表顶部插入
  addFolderInputWithValue(projPath, '');
  if (list.children.length > 1) list.insertBefore(list.lastChild, list.firstChild);
}

// === File Inputs (Modal) ===
function renderFileInputs(files = []) {
  const list = document.getElementById('filesList');
  list.innerHTML = '';
  files.forEach(f => addFileInputWithValue(f.path || '', f.name || ''));
}

function addFileInputWithValue(filePath = '', name = '') {
  const list = document.getElementById('filesList');
  const item = document.createElement('div');
  item.className = 'command-item';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'form-input';
  pathInput.placeholder = '/path/to/file';
  pathInput.value = filePath;
  pathInput.readOnly = true;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input command-name-field';
  nameInput.placeholder = t('file.name') || 'Name';
  nameInput.value = name;

  // 自动保存：名称输入框失焦时保存
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });

  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'btn-browse';
  browseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  browseBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.selectFile(pathInput.value || undefined);
    if (!result.canceled) {
      pathInput.value = result.path;
      if (!nameInput.value) {
        nameInput.value = result.path.split('/').pop() || '';
      }
      // 自动保存
      if (isEditMode && currentProject) {
        autoSaveProject();
      }
    }
  });
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-command';
  removeBtn.innerHTML = icons.x;
  removeBtn.addEventListener('click', () => {
    item.remove();
    // 自动保存
    if (isEditMode && currentProject) {
      autoSaveProject();
    }
  });
  item.appendChild(pathInput);
  item.appendChild(nameInput);
  item.appendChild(browseBtn);
  item.appendChild(removeBtn);
  list.appendChild(item);
}

function addFileInput() {
  addFileInputWithValue('', '');
}

// === Subproject Inputs (Modal) ===
function renderSubprojectInputs(subprojects = []) {
  const list = document.getElementById('subprojectsList');
  list.innerHTML = '';
  subprojects.forEach(sp => addSubprojectInputWithValue(sp));
}

function addSubprojectInputWithValue(sp = { name: '', items: [] }) {
  const list = document.getElementById('subprojectsList');
  const container = document.createElement('div');
  container.className = 'subproject-modal-item';
  // 保留已有 ID 以便在 collect 时复用
  if (sp.id) container.dataset.spId = sp.id;

  // Header: name + remove subproject
  const header = document.createElement('div');
  header.className = 'subproject-modal-header';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input';
  nameInput.placeholder = t('subproject.name') || 'Subproject name';
  nameInput.value = sp.name || '';
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) autoSaveProject();
  });

  const removeSpBtn = document.createElement('button');
  removeSpBtn.type = 'button';
  removeSpBtn.className = 'btn-remove-command';
  removeSpBtn.innerHTML = icons.x;
  removeSpBtn.addEventListener('click', () => {
    container.remove();
    if (isEditMode && currentProject) autoSaveProject();
  });
  header.appendChild(nameInput);
  header.appendChild(removeSpBtn);
  container.appendChild(header);

  // Items list
  const itemsList = document.createElement('div');
  itemsList.className = 'subproject-modal-items';
  container.appendChild(itemsList);

  (sp.items || []).forEach(item => addSubprojectItemRow(itemsList, item));

  // Add item button with drag support
  const addItemBtn = document.createElement('button');
  addItemBtn.type = 'button';
  addItemBtn.className = 'subproject-modal-add-item';
  addItemBtn.textContent = t('subproject.addItem') || '+ Add Item';
  addItemBtn.addEventListener('click', () => {
    addSubprojectItemRow(itemsList, { type: 'url', url: '', name: '' });
  });

  // Drop files onto add-item button
  addItemBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemBtn.style.borderColor = 'var(--accent)';
    addItemBtn.style.background = 'rgba(59, 130, 246, 0.1)';
  });
  addItemBtn.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemBtn.style.borderColor = '';
    addItemBtn.style.background = '';
  });
  addItemBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItemBtn.style.borderColor = '';
    addItemBtn.style.background = '';
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i].path;
        const pathInfo = await window.electronAPI.checkPathType(filePath);
        if (pathInfo && pathInfo.exists) {
          const itemName = filePath.split('/').pop() || '';
          if (pathInfo.isDirectory) {
            addSubprojectItemRow(itemsList, { type: 'folder', path: filePath, name: itemName });
          } else {
            addSubprojectItemRow(itemsList, { type: 'file', path: filePath, name: itemName });
          }
        }
      }
      if (isEditMode && currentProject) autoSaveProject();
    }
  });

  container.appendChild(addItemBtn);
  list.appendChild(container);
}

function addSubprojectItemRow(itemsList, item = { type: 'url', url: '', name: '' }) {
  const row = document.createElement('div');
  row.className = 'subproject-modal-item-row';

  const typeSelect = document.createElement('select');
  typeSelect.innerHTML = `
    <option value="url"${item.type === 'url' ? ' selected' : ''}>${t('subproject.typeUrl')}</option>
    <option value="folder"${item.type === 'folder' ? ' selected' : ''}>${t('subproject.typeFolder')}</option>
    <option value="file"${item.type === 'file' ? ' selected' : ''}>${t('subproject.typeFile')}</option>
  `;
  typeSelect.addEventListener('change', () => {
    pathInput.readOnly = typeSelect.value !== 'url';
    pathInput.placeholder = typeSelect.value === 'url' ? 'https://...' : '/path/to/' + typeSelect.value;
    if (isEditMode && currentProject) autoSaveProject();
  });

  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'form-input';
  pathInput.value = item.type === 'url' ? (item.url || '') : (item.path || '');
  pathInput.placeholder = item.type === 'url' ? 'https://...' : '/path/to/' + item.type;
  pathInput.readOnly = item.type !== 'url';
  pathInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) autoSaveProject();
  });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'form-input item-name-field';
  nameInput.placeholder = t('url.name') || 'Name';
  nameInput.value = item.name || '';
  nameInput.addEventListener('blur', () => {
    if (isEditMode && currentProject) autoSaveProject();
  });

  // Browse button for folder/file types
  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'btn-browse-cmd';
  browseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  browseBtn.addEventListener('click', async () => {
    const tp = typeSelect.value;
    if (tp === 'url') return;
    let result;
    if (tp === 'folder') {
      result = await window.electronAPI.selectFolder();
    } else {
      result = await window.electronAPI.selectFile(pathInput.value || undefined);
    }
    if (result && !result.canceled) {
      pathInput.value = result.path;
      if (!nameInput.value) nameInput.value = result.path.split('/').pop() || '';
      if (isEditMode && currentProject) autoSaveProject();
    }
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-command';
  removeBtn.innerHTML = icons.x;
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (isEditMode && currentProject) autoSaveProject();
  });

  row.appendChild(typeSelect);
  row.appendChild(pathInput);
  row.appendChild(nameInput);
  row.appendChild(browseBtn);
  row.appendChild(removeBtn);
  itemsList.appendChild(row);
}

function addSubprojectInput() {
  addSubprojectInputWithValue({ name: '', items: [] });
}

function closeModal() { projectModal.classList.remove('show'); }

// === Collect Subprojects from Modal ===
function collectSubprojectsFromModal() {
  const spContainers = document.querySelectorAll('#subprojectsList .subproject-modal-item');
  const subprojects = [];
  spContainers.forEach(container => {
    const nameInput = container.querySelector('.subproject-modal-header input');
    const spName = nameInput ? nameInput.value.trim() : '';
    // 只要有名称就保留子项目
    if (!spName) return;
    const itemRows = container.querySelectorAll('.subproject-modal-item-row');
    const items = [];
    itemRows.forEach(row => {
      const typeSelect = row.querySelector('select');
      const inputs = row.querySelectorAll('input');
      const tp = typeSelect ? typeSelect.value : 'url';
      const pathOrUrl = inputs[0] ? inputs[0].value.trim() : '';
      const itemName = inputs[1] ? inputs[1].value.trim() : '';
      if (pathOrUrl) {
        if (tp === 'url') {
          items.push({ type: 'url', url: pathOrUrl, name: itemName });
        } else {
          items.push({ type: tp, path: pathOrUrl, name: itemName });
        }
      }
    });
    // 保留已有 ID 或生成新 ID
    const existingId = container.dataset.spId;
    const id = existingId || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    subprojects.push({ id, name: spName, items });
  });
  return subprojects;
}

// === Auto Save ===
let autoSaveTimeout = null;
async function autoSaveProject() {
  // 防抖：500ms 内只保存一次
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    if (!isEditMode || !currentProject) return;

    try {
      const name = document.getElementById('modalProjectName').value.trim();
      const projPath = document.getElementById('modalProjectPath').value.trim();
      const outputPath = document.getElementById('modalOutputPath').value.trim();

      // 收集命令
      const commandItems = document.querySelectorAll('#commandsList .command-item');
      const commands = [];
      const commandNames = [];
      const commandModes = [];
      commandItems.forEach(item => {
        const inputs = item.querySelectorAll('input');
        const cmd = inputs[0].value.trim();
        const name = inputs[1] ? inputs[1].value.trim() : '';
        const modeBtn = item.querySelector('.btn-mode-toggle-modal');
        const mode = modeBtn ? modeBtn.dataset.mode : 'terminal';
        if (cmd) {
          commands.push(cmd);
          commandNames.push(name);
          commandModes.push(mode);
        }
      });

      // 收集 URLs
      const urlItems = document.querySelectorAll('#urlsList .command-item');
      const urls = [];
      urlItems.forEach(item => {
        const inputs = item.querySelectorAll('input');
        const urlVal = inputs[0].value.trim();
        const urlName = inputs[1] ? inputs[1].value.trim() : '';
        if (urlVal) urls.push({ url: urlVal, name: urlName });
      });

      // 收集 Folders
      const folderItems = document.querySelectorAll('#foldersList .command-item');
      const folders = [];
      folderItems.forEach(item => {
        const inputs = item.querySelectorAll('input');
        const folderPath = inputs[0].value.trim();
        const folderName = inputs[1] ? inputs[1].value.trim() : '';
        if (folderPath) folders.push({ path: folderPath, name: folderName });
      });

      // 收集 Files
      const fileItems = document.querySelectorAll('#filesList .command-item');
      const files = [];
      fileItems.forEach(item => {
        const inputs = item.querySelectorAll('input');
        const filePath = inputs[0].value.trim();
        const fileName = inputs[1] ? inputs[1].value.trim() : '';
        if (filePath) files.push({ path: filePath, name: fileName });
      });

      // 收集 Subprojects
      const subprojects = collectSubprojectsFromModal();

      const result = await window.electronAPI.updateProject(currentProject.id, {
        name, path: projPath, commands, command_names: commandNames, command_modes: commandModes,
        result_path: outputPath, urls, folders, files, subprojects,
      });

      if (result.success) {
        // 更新当前项目数据
        Object.assign(currentProject, result.data);
        // 更新项目列表中的数据
        const idx = projects.findIndex(p => p.id === currentProject.id);
        if (idx !== -1) projects[idx] = currentProject;
        // 轻量级反馈：短暂显示保存图标
        showAutoSaveIndicator();
        // 刷新详情页显示
        renderProjectList();
        selectProject(currentProject);
      }
    } catch (e) {
      console.error('Auto save failed:', e);
    }
  }, 500);
}

function showAutoSaveIndicator() {
  const saveBtn = document.getElementById('saveProjectBtn');
  if (!saveBtn) return;
  const originalText = saveBtn.innerHTML;
  saveBtn.innerHTML = icons.check + '<span>' + (t('msg.projectUpdated') || 'Saved') + '</span>';
  saveBtn.style.opacity = '0.7';
  setTimeout(() => {
    saveBtn.innerHTML = originalText;
    saveBtn.style.opacity = '';
  }, 1000);
}

// === CRUD ===
async function saveProject() {
  const name = document.getElementById('modalProjectName').value.trim();
  const projPath = document.getElementById('modalProjectPath').value.trim();
  const outputPath = document.getElementById('modalOutputPath').value.trim();
  const commandItems = document.querySelectorAll('#commandsList .command-item');
  const commands = [];
  const commandNames = [];
  const commandModes = [];
  commandItems.forEach(item => {
    const inputs = item.querySelectorAll('input');
    const cmd = inputs[0].value.trim();
    const cmdName = inputs[1] ? inputs[1].value.trim() : '';
    const modeBtn = item.querySelector('.btn-mode-toggle-modal');
    const cmdMode = modeBtn ? modeBtn.dataset.mode : 'terminal';
    if (cmd.length > 0) {
      commands.push(cmd);
      commandNames.push(cmdName);
      commandModes.push(cmdMode);
    }
  });

  if (!name) {
    showToast(t('msg.nameRequired'), 'error');
    return;
  }

  // Collect URLs
  const urlItems = document.querySelectorAll('#urlsList .command-item');
  const urls = [];
  urlItems.forEach(item => {
    const inputs = item.querySelectorAll('input');
    const urlVal = inputs[0].value.trim();
    const urlName = inputs[1] ? inputs[1].value.trim() : '';
    if (urlVal) urls.push({ url: urlVal, name: urlName });
  });

  // Collect Folders
  const folderItems = document.querySelectorAll('#foldersList .command-item');
  const folders = [];
  folderItems.forEach(item => {
    const inputs = item.querySelectorAll('input');
    const folderPath = inputs[0].value.trim();
    const folderName = inputs[1] ? inputs[1].value.trim() : '';
    if (folderPath) folders.push({ path: folderPath, name: folderName });
  });

  // Collect Files
  const fileItems = document.querySelectorAll('#filesList .command-item');
  const files = [];
  fileItems.forEach(item => {
    const inputs = item.querySelectorAll('input');
    const filePath = inputs[0].value.trim();
    const fileName = inputs[1] ? inputs[1].value.trim() : '';
    if (filePath) files.push({ path: filePath, name: fileName });
  });

  // Collect Subprojects
  const subprojects = collectSubprojectsFromModal();

  let result;
  if (isEditMode && currentProject) {
    result = await window.electronAPI.updateProject(currentProject.id, {
      name, path: projPath, commands, command_names: commandNames, command_modes: commandModes, result_path: outputPath, urls, folders, files, subprojects,
    });
  } else {
    result = await window.electronAPI.addProject({
      name, path: projPath, commands, command_names: commandNames, command_modes: commandModes, result_path: outputPath, urls, folders, files, subprojects,
    });
  }

  if (result.success) {
    showToast(isEditMode ? t('msg.projectUpdated') : t('msg.projectAdded'), 'success');
    closeModal();
    await loadProjects();
    const toSelect = projects.find(p => p.id === result.data.id);
    if (toSelect) selectProject(toSelect);
  } else {
    showToast(t('msg.saveFailed') + ': ' + result.error, 'error');
  }
}

async function deleteProject() {
  if (!currentProject) return;
  const confirmed = await showConfirm(
    t('msg.deleteTitle'),
    t('msg.deleteConfirm', { name: currentProject.name })
  );
  if (!confirmed) return;

  const result = await window.electronAPI.deleteProject(currentProject.id);
  if (result.success) {
    showToast(t('msg.projectDeleted'), 'success');
    currentProject = null;
    await loadProjects();
    welcomeMessage.style.display = 'flex';
    projectDetails.style.display = 'none';
  } else {
    showToast(t('msg.deleteFailed') + ': ' + result.error, 'error');
  }
}

// === Execute ===
async function executeCommand(command, commandIndex = 0) {
  if (!currentProject || !command) return;
  const modes = currentProject.command_modes || [];
  const names = currentProject.command_names || [];
  const mode = modes[commandIndex] || 'terminal';
  const projectName = currentProject.name;
  const commandName = names[commandIndex] || '';

  if (mode === 'silent') {
    showToast(t('msg.executingSilent'), 'info');
    const result = await window.electronAPI.executeCommandSilent(
      currentProject.path, command, projectName, commandName
    );
    if (result.success) {
      showToast(t('msg.silentComplete', { duration: Math.round((result.durationMs || 0) / 1000) }), 'success');
    } else {
      showToast(t('msg.silentFailed') + ': ' + (result.error || result.status), 'error');
    }
  } else {
    showToast(t('msg.launching'), 'info');
    const result = await window.electronAPI.executeCommand(
      currentProject.path, command, projectName, commandName
    );
    if (result.success) {
      showToast(t('msg.launched'), 'success');
    } else {
      showToast(t('msg.execFailed') + ': ' + result.error, 'error');
    }
  }
}

async function openOutputFolder() {
  if (!currentProject?.result_path) return;
  await window.electronAPI.openFolder(currentProject.result_path);
}

// === Import / Export ===
async function quickExportSettings() {
  const result = await window.electronAPI.exportProjects();
  if (!result.success) { showToast(t('msg.exportFailed') + ': ' + result.error, 'error'); return; }
  const jsonStr = JSON.stringify(result.data, null, 2);
  const quickResult = await window.electronAPI.quickSaveFile(jsonStr);
  if (quickResult.success) {
    showToast(t('msg.exported'), 'success');
  } else {
    // 没有上次路径或写入失败，走弹窗流程
    const saveResult = await window.electronAPI.saveFile(jsonStr, 'start-everything-settings.json');
    if (!saveResult.canceled) showToast(t('msg.exported'), 'success');
  }
}

async function exportSettings() {
  const result = await window.electronAPI.exportProjects();
  if (!result.success) { showToast(t('msg.exportFailed') + ': ' + result.error, 'error'); return; }
  const jsonStr = JSON.stringify(result.data, null, 2);
  const saveResult = await window.electronAPI.saveFile(jsonStr, 'start-everything-settings.json');
  if (!saveResult.canceled) showToast(t('msg.exported'), 'success');
}

async function importSettings() {
  const fileResult = await window.electronAPI.openFile();
  if (fileResult.canceled) return;
  let data;
  try { data = JSON.parse(fileResult.data); } catch { showToast(t('msg.invalidJson'), 'error'); return; }
  const result = await window.electronAPI.importProjects(data);
  if (result.success) {
    const { added, updated, deleted } = result.data;
    showToast(t('msg.imported', { added, updated, deleted }), 'success');
    await loadProjects();
  } else {
    showToast(t('msg.importFailed') + ': ' + result.error, 'error');
  }
}

// === Toast Notification System ===
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const iconMap = { success: icons.check, error: icons.alert, info: icons.info };
  toast.innerHTML = `${iconMap[type] || iconMap.info}<span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);

  // Auto remove
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

// === Confirm Dialog ===
function showConfirm(title, message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        ${icons.trash}
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn-secondary confirm-cancel">${t('confirm.cancel')}</button>
          <button class="btn-danger confirm-ok" style="background:var(--danger);color:white;border:none;">${t('confirm.delete')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    });
    // Focus the cancel button for safety
    setTimeout(() => overlay.querySelector('.confirm-cancel').focus(), 50);
  });
}

// === Utilities ===
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// === Settings ===
const settingsModal = document.getElementById('settingsModal');

async function openSettings() {
  // Load current values
  const autoLaunch = await window.electronAPI.getAutoLaunch();
  document.getElementById('autoLaunchToggle').checked = autoLaunch;

  // Set current language
  document.getElementById('langSelect').value = currentLocale;

  // Terminal
  const terminal = await window.electronAPI.getTerminal();
  document.getElementById('terminalSelect').value = terminal;

  // Global shortcut
  const shortcut = await window.electronAPI.getGlobalShortcut();
  document.getElementById('shortcutInput').value = shortcut || '';

  const version = await window.electronAPI.getAppVersion();
  document.getElementById('appVersion').textContent = `v${version}`;

  settingsModal.classList.add('show');
}

function closeSettings() {
  settingsModal.classList.remove('show');
}

function setupSettings() {
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

  // Language select
  document.getElementById('langSelect').addEventListener('change', async (e) => {
    await setLocale(e.target.value);
    renderProjectList();
    if (currentProject) showProjectDetails();
  });

  // Terminal select
  document.getElementById('terminalSelect').addEventListener('change', async (e) => {
    await window.electronAPI.setTerminal(e.target.value);
    showToast(t('settings.terminalSet'), 'success');
  });

  // Global shortcut recording
  const shortcutInput = document.getElementById('shortcutInput');
  let recordingShortcut = false;

  shortcutInput.addEventListener('click', () => {
    recordingShortcut = true;
    shortcutInput.value = t('settings.pressKeys') || 'Press keys...';
    shortcutInput.classList.add('recording');
  });

  shortcutInput.addEventListener('blur', () => {
    if (recordingShortcut) {
      recordingShortcut = false;
      shortcutInput.classList.remove('recording');
      window.electronAPI.getGlobalShortcut().then(s => {
        shortcutInput.value = s || '';
      });
    }
  });

  // Show held modifiers in real-time
  shortcutInput.addEventListener('keydown', async (e) => {
    if (!recordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();

    const modifiers = [];
    if (e.metaKey || e.ctrlKey) modifiers.push('⌘');
    if (e.altKey) modifiers.push('⌥');
    if (e.shiftKey) modifiers.push('⇧');

    // If only modifiers held, show them as hint
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
      shortcutInput.value = modifiers.length ? modifiers.join('') + ' + ?' : (t('settings.pressKeys') || 'Press keys...');
      return;
    }

    // Build accelerator from e.code (immune to Option key character remapping)
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    if (parts.length === 0) return; // Must have at least one modifier

    let key = '';
    const code = e.code;
    if (code.startsWith('Key')) key = code.slice(3); // KeyA → A
    else if (code.startsWith('Digit')) key = code.slice(5); // Digit1 → 1
    else if (code === 'Space') key = 'Space';
    else if (code === 'Backspace') key = 'Backspace';
    else if (code === 'Delete') key = 'Delete';
    else if (code === 'Enter') key = 'Return';
    else if (code === 'Tab') key = 'Tab';
    else if (code === 'Escape') key = 'Escape';
    else if (code === 'ArrowUp') key = 'Up';
    else if (code === 'ArrowDown') key = 'Down';
    else if (code === 'ArrowLeft') key = 'Left';
    else if (code === 'ArrowRight') key = 'Right';
    else if (code.startsWith('F') && !isNaN(code.slice(1))) key = code; // F1-F12
    else if (code === 'Minus') key = '-';
    else if (code === 'Equal') key = '=';
    else if (code === 'BracketLeft') key = '[';
    else if (code === 'BracketRight') key = ']';
    else if (code === 'Backslash') key = '\\';
    else if (code === 'Semicolon') key = ';';
    else if (code === 'Quote') key = "'";
    else if (code === 'Comma') key = ',';
    else if (code === 'Period') key = '.';
    else if (code === 'Slash') key = '/';
    else if (code === 'Backquote') key = '`';
    else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;

    if (!key) return;
    parts.push(key);

    const accelerator = parts.join('+');
    recordingShortcut = false;
    shortcutInput.classList.remove('recording');

    const result = await window.electronAPI.setGlobalShortcut(accelerator);
    if (result.success) {
      shortcutInput.value = accelerator;
      showToast(t('settings.shortcutSet'), 'success');
      updateGlobalShortcutHint();
    } else if (result.error === 'conflict') {
      showToast(t('settings.shortcutConflict'), 'error');
      const s = await window.electronAPI.getGlobalShortcut();
      shortcutInput.value = s || '';
    } else {
      showToast(t('settings.shortcutFailed') + ': ' + result.error, 'error');
      const s = await window.electronAPI.getGlobalShortcut();
      shortcutInput.value = s || '';
    }
  });

  document.getElementById('clearShortcutBtn').addEventListener('click', async () => {
    await window.electronAPI.setGlobalShortcut('');
    document.getElementById('shortcutInput').value = '';
    showToast(t('settings.shortcutCleared'), 'success');
    updateGlobalShortcutHint();
  });

  // Import / Export (now in settings)
  document.getElementById('exportBtn').addEventListener('click', exportSettings);
  document.getElementById('importBtn').addEventListener('click', importSettings);

  // Open data directory
  document.getElementById('openDataDirBtn').addEventListener('click', async () => {
    const result = await window.electronAPI.getLastImportExportDir();
    if (result.success && result.path) {
      await window.electronAPI.openFolder(result.path);
    }
  });

  // Project URL link
  document.getElementById('projectUrlLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openUrl('https://github.com/nixyme/start-everything');
  });

  // Reset data
  document.getElementById('resetDataBtn').addEventListener('click', async () => {
    const confirmed = await showConfirm(
      t('settings.resetDataTitle'),
      t('settings.resetDataConfirm')
    );
    if (!confirmed) return;
    const result = await window.electronAPI.resetData();
    if (result.success) {
      showToast(t('settings.resetDataDone'), 'success');
      closeSettings();
      currentProject = null;
      await loadProjects();
      welcomeMessage.style.display = 'flex';
      projectDetails.style.display = 'none';
    }
  });

  document.getElementById('autoLaunchToggle').addEventListener('change', async (e) => {
    try {
      const result = await window.electronAPI.setAutoLaunch(e.target.checked);
      console.log('[Auto Launch] Result:', result);

      // Always verify with get to ensure accuracy
      const actualValue = await window.electronAPI.getAutoLaunch();
      console.log('[Auto Launch] Actual value:', actualValue);

      if (actualValue !== e.target.checked) {
        // Setting failed, revert the toggle
        e.target.checked = actualValue;

        // Check if we're in development mode
        const version = await window.electronAPI.getAppVersion();
        if (version.includes('dev') || !result.success) {
          showToast((t('settings.autoLaunchDevMode') || 'Auto-launch only works in production builds. Please build and install the app first.'), 'warning');
        } else {
          showToast(t('settings.autoLaunchFailed') || 'Failed to update auto-launch setting', 'error');
        }
      } else {
        showToast(e.target.checked ? (t('settings.autoLaunchOn') || 'Auto-launch enabled') : (t('settings.autoLaunchOff') || 'Auto-launch disabled'), 'success');
      }
    } catch (error) {
      console.error('[Auto Launch] Error:', error);
      showToast((t('settings.autoLaunchFailed') || 'Failed to update auto-launch setting') + ': ' + error.message, 'error');
      // Revert toggle
      try {
        const actualValue = await window.electronAPI.getAutoLaunch();
        e.target.checked = actualValue;
      } catch (e2) {
        console.error('[Auto Launch] Failed to get actual value:', e2);
      }
    }
  });

  document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('updateStatus');
    const btn = document.getElementById('checkUpdateBtn');
    btn.disabled = true;
    btn.textContent = t('settings.checking');
    statusEl.textContent = t('settings.checking');
    const result = await window.electronAPI.checkForUpdate();
    if (!result.success) {
      statusEl.textContent = t('settings.updateError') + ': ' + result.error;
      btn.disabled = false;
      btn.textContent = t('settings.checkUpdate');
      return;
    }
    const info = result.data;
    if (info.isNewer) {
      statusEl.textContent = t('settings.newVersion', { version: info.latestVersion });
      btn.textContent = t('settings.download');
      btn.disabled = false;
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '0%';
        statusEl.textContent = t('settings.downloading') || 'Downloading...';
        // 监听下载进度
        window.electronAPI.onUpdateDownloadProgress(({ percent }) => {
          btn.textContent = percent + '%';
        });
        const dlResult = await window.electronAPI.downloadUpdate(info.downloadUrl);
        if (dlResult.success) {
          statusEl.textContent = t('settings.downloadComplete') || 'Download complete';
          btn.textContent = t('settings.installRestart') || 'Install & Restart';
          btn.disabled = false;
          btn.onclick = async () => {
            btn.disabled = true;
            await window.electronAPI.installUpdate(dlResult.filePath);
          };
        } else {
          statusEl.textContent = (t('settings.updateError') || 'Error') + ': ' + dlResult.error;
          btn.textContent = t('settings.checkUpdate');
          btn.disabled = false;
          btn.onclick = null;
        }
      };
    } else {
      statusEl.textContent = t('settings.upToDate');
      btn.disabled = false;
      btn.textContent = t('settings.checkUpdate');
    }
  });
}

// setupAutoUpdater 不再需要 electron-updater 事件，保留空函数
function setupAutoUpdater() {
  // GitHub API 方式不需要事件监听，全部在 checkUpdateBtn click 中处理
}

// === Command Input: Paste Image & Drag File Support ===
function setupCommandInputDragDrop(input) {
  // Drag file into command input → append file path
  input.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    input.classList.add('drag-highlight');
  });
  input.addEventListener('dragleave', () => {
    input.classList.remove('drag-highlight');
  });
  input.addEventListener('drop', (e) => {
    e.preventDefault();
    input.classList.remove('drag-highlight');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const paths = Array.from(files).map(f => f.path).filter(Boolean);
      if (paths.length > 0) {
        const cur = input.value.trim();
        input.value = cur ? cur + ' ' + paths.join(' ') : paths.join(' ');
        input.dispatchEvent(new Event('input'));
      }
    }
  });

  // Paste image → insert as base64 data URI or file path
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          const cur = input.value.trim();
          input.value = cur ? cur + ' ' + reader.result : reader.result;
          input.dispatchEvent(new Event('input'));
          showToast(t('msg.imagePasted'), 'success');
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  });
}

// === Schedule Cache ===
async function loadScheduleCacheForProject(projectId) {
  const result = await window.electronAPI.getSchedules();
  if (!result.success) return;
  const cache = {};
  for (const s of result.data) {
    if (s.projectId === projectId) {
      cache[s.commandIndex] = s;
    }
  }
  commandScheduleCache[projectId] = cache;
}

// === Schedule Events ===
function setupScheduleEvents() {
  if (window.electronAPI.onScheduleExecuted) {
    window.electronAPI.onScheduleExecuted((data) => {
      if (currentProject) {
        loadScheduleCacheForProject(currentProject.id).then(() => {
          renderCommandsDisplay();
        });
      }
    });
  }
  if (window.electronAPI.onSilentExecutionComplete) {
    window.electronAPI.onSilentExecutionComplete((data) => {
      // Background notification already handled via toast in executeCommand
    });
  }
}

// === Schedule Dialog ===
function simpleConfigToCron(config) {
  if (!config) return '* * * * *';
  switch (config.type) {
    case 'interval':
      return `*/${config.minutes || 5} * * * *`;
    case 'daily':
      return `${config.minute || 0} ${config.hour || 9} * * *`;
    case 'weekly':
      return `${config.minute || 0} ${config.hour || 9} * * ${config.day || 1}`;
    default:
      return '* * * * *';
  }
}

function cronToSimpleConfig(cron) {
  if (!cron) return { type: 'daily', hour: 9, minute: 0 };
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return null;
  // interval: */N * * * *
  if (parts[0].startsWith('*/') && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return { type: 'interval', minutes: parseInt(parts[0].slice(2)) || 5 };
  }
  // daily: M H * * *
  if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*' && !parts[0].includes('/') && !parts[1].includes('/')) {
    return { type: 'daily', hour: parseInt(parts[1]) || 0, minute: parseInt(parts[0]) || 0 };
  }
  // weekly: M H * * D
  if (parts[2] === '*' && parts[3] === '*' && !parts[4].includes('*') && !parts[0].includes('/')) {
    return { type: 'weekly', hour: parseInt(parts[1]) || 0, minute: parseInt(parts[0]) || 0, day: parseInt(parts[4]) || 0 };
  }
  return null; // Can't map to simple
}

async function openScheduleDialog(project, commandIndex, command, commandName) {
  // Load existing schedule
  const result = await window.electronAPI.getScheduleForCommand(project.id, commandIndex);
  const existing = result.success ? result.data : null;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const simpleConfig = existing?.simpleConfig || { type: 'daily', hour: 9, minute: 0 };
  const cronExpr = existing?.cronExpression || simpleConfigToCron(simpleConfig);
  const isAdvanced = existing ? !existing.simpleConfig : false;

  const dayNames = [
    t('schedule.sun'), t('schedule.mon'), t('schedule.tue'),
    t('schedule.wed'), t('schedule.thu'), t('schedule.fri'), t('schedule.sat')
  ];

  const isEnabled = existing ? existing.enabled : true;

  overlay.innerHTML = `
    <div class="modal-content" style="max-width:440px;">
      <div class="modal-header">
        <h3>${escapeHtml(t('schedule.title'))}</h3>
        <button class="close-btn schedule-close-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="schedule-dialog-body">
        <div style="margin-bottom:14px;font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escapeHtml(commandName || command).substring(0, 100)}
        </div>
        ${existing ? `<div class="schedule-option-row" style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">
          <label style="font-weight:500;">${t('schedule.enableToggle')}</label>
          <label class="toggle-switch"><input type="checkbox" id="scheduleEnabled" ${isEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>` : ''}
        <div class="schedule-mode-toggle">
          <button class="schedule-mode-btn ${!isAdvanced ? 'active' : ''}" data-mode="simple">${t('schedule.simple')}</button>
          <button class="schedule-mode-btn ${isAdvanced ? 'active' : ''}" data-mode="advanced">${t('schedule.advanced')}</button>
        </div>
        <div id="scheduleSimplePanel" style="${isAdvanced ? 'display:none' : ''}">
          <div class="schedule-simple-compact">
            <select id="scheduleType" class="schedule-select">
              <option value="interval" ${simpleConfig.type === 'interval' ? 'selected' : ''}>${t('schedule.everyNMin')}</option>
              <option value="daily" ${simpleConfig.type === 'daily' ? 'selected' : ''}>${t('schedule.daily')}</option>
              <option value="weekly" ${simpleConfig.type === 'weekly' ? 'selected' : ''}>${t('schedule.weekly')}</option>
            </select>
            <span id="scheduleIntervalRow" class="schedule-inline" style="${simpleConfig.type === 'interval' ? '' : 'display:none'}">
              <input type="number" id="scheduleMinutes" min="1" max="1440" value="${simpleConfig.minutes || 5}" class="schedule-num-input"> <span class="schedule-unit">min</span>
            </span>
            <span id="scheduleDayRow" class="schedule-inline" style="${simpleConfig.type === 'weekly' ? '' : 'display:none'}">
              <select id="scheduleDay" class="schedule-select">
                ${dayNames.map((d, i) => `<option value="${i}" ${(simpleConfig.day || 0) === i ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </span>
            <span id="scheduleTimeRow" class="schedule-inline" style="${simpleConfig.type !== 'interval' ? '' : 'display:none'}">
              <input type="number" id="scheduleHour" min="0" max="23" value="${simpleConfig.hour || 9}" class="schedule-num-input"> : <input type="number" id="scheduleMinute" min="0" max="59" value="${simpleConfig.minute || 0}" class="schedule-num-input">
            </span>
          </div>
        </div>
        <div id="scheduleAdvancedPanel" style="${isAdvanced ? '' : 'display:none'}">
          <input type="text" id="scheduleCronInput" class="schedule-cron-input" value="${escapeHtml(cronExpr)}" placeholder="* * * * *">
          <div class="cron-hint" id="cronHint">${t('schedule.cronHint')}</div>
        </div>
        <div class="schedule-options">
          <div class="schedule-option-row">
            <label>${t('schedule.notify')}</label>
            <label class="toggle-switch"><input type="checkbox" id="scheduleNotify" ${existing?.notifyOnComplete !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
          </div>
          <div class="schedule-option-row">
            <label>${t('schedule.timeout')}</label>
            <div style="display:flex;align-items:center;gap:4px;"><input type="number" id="scheduleTimeout" min="1" max="1440" value="${existing?.timeoutMinutes || 60}" class="schedule-num-input" style="width:70px;"> <span class="schedule-unit">min</span></div>
          </div>
        </div>
      </div>
      <div class="schedule-footer">
        <div>${existing ? `<button class="btn-danger schedule-remove-btn">${t('schedule.remove')}</button>` : ''}</div>
        <div class="schedule-footer-right">
          <button class="btn-secondary schedule-cancel-btn">${t('modal.cancel')}</button>
          <button class="btn-primary schedule-save-btn">${t('modal.save')}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Mode toggle
  let currentMode = isAdvanced ? 'advanced' : 'simple';
  overlay.querySelectorAll('.schedule-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      overlay.querySelectorAll('.schedule-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      overlay.querySelector('#scheduleSimplePanel').style.display = currentMode === 'simple' ? '' : 'none';
      overlay.querySelector('#scheduleAdvancedPanel').style.display = currentMode === 'advanced' ? '' : 'none';
    });
  });

  // Type change
  const typeSelect = overlay.querySelector('#scheduleType');
  typeSelect.addEventListener('change', () => {
    const type = typeSelect.value;
    overlay.querySelector('#scheduleIntervalRow').style.display = type === 'interval' ? '' : 'none';
    overlay.querySelector('#scheduleTimeRow').style.display = type !== 'interval' ? '' : 'none';
    overlay.querySelector('#scheduleDayRow').style.display = type === 'weekly' ? '' : 'none';
  });

  // Cron validation
  const cronInput = overlay.querySelector('#scheduleCronInput');
  const cronHint = overlay.querySelector('#cronHint');
  cronInput.addEventListener('input', async () => {
    const val = cronInput.value.trim();
    if (!val) { cronInput.className = 'schedule-cron-input'; cronHint.textContent = t('schedule.cronHint'); return; }
    const r = await window.electronAPI.validateCron(val);
    if (r.valid) {
      cronInput.className = 'schedule-cron-input cron-valid';
      cronHint.textContent = t('schedule.cronValid');
    } else {
      cronInput.className = 'schedule-cron-input cron-invalid';
      cronHint.textContent = t('schedule.cronInvalid');
    }
  });

  const cleanup = () => overlay.remove();

  // Close
  overlay.querySelector('.schedule-close-btn').addEventListener('click', cleanup);
  overlay.querySelector('.schedule-cancel-btn').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

  // Remove
  const removeBtn = overlay.querySelector('.schedule-remove-btn');
  if (removeBtn && existing) {
    removeBtn.addEventListener('click', async () => {
      await window.electronAPI.deleteSchedule(existing.id);
      await loadScheduleCacheForProject(project.id);
      renderCommandsDisplay();
      showToast(t('schedule.removed'), 'success');
      cleanup();
    });
  }

  // Save
  overlay.querySelector('.schedule-save-btn').addEventListener('click', async () => {
    let cronExpression, sConfig;
    if (currentMode === 'simple') {
      const type = typeSelect.value;
      sConfig = { type };
      if (type === 'interval') {
        sConfig.minutes = parseInt(overlay.querySelector('#scheduleMinutes').value) || 5;
      } else {
        sConfig.hour = parseInt(overlay.querySelector('#scheduleHour').value) || 0;
        sConfig.minute = parseInt(overlay.querySelector('#scheduleMinute').value) || 0;
        if (type === 'weekly') {
          sConfig.day = parseInt(overlay.querySelector('#scheduleDay').value) || 0;
        }
      }
      cronExpression = simpleConfigToCron(sConfig);
    } else {
      cronExpression = cronInput.value.trim();
      sConfig = null;
      const vr = await window.electronAPI.validateCron(cronExpression);
      if (!vr.valid) {
        showToast(t('schedule.cronInvalid'), 'error');
        return;
      }
    }

    const enabledToggle = overlay.querySelector('#scheduleEnabled');
    const scheduleData = {
      projectId: project.id,
      commandIndex,
      command,
      projectPath: project.path,
      projectName: project.name,
      commandName: commandName || '',
      cronExpression,
      simpleConfig: sConfig,
      enabled: enabledToggle ? enabledToggle.checked : true,
      notifyOnComplete: overlay.querySelector('#scheduleNotify').checked,
      timeoutMinutes: parseInt(overlay.querySelector('#scheduleTimeout').value) || 60,
    };

    let saveResult;
    if (existing) {
      saveResult = await window.electronAPI.updateSchedule(existing.id, scheduleData);
    } else {
      saveResult = await window.electronAPI.addSchedule(scheduleData);
    }

    if (saveResult.success) {
      await loadScheduleCacheForProject(project.id);
      renderCommandsDisplay();
      showToast(t('schedule.saved'), 'success');
      cleanup();
    } else {
      showToast(t('schedule.saveFailed') + ': ' + saveResult.error, 'error');
    }
  });
}

// === Schedule Logs Modal ===
async function openScheduleLogsModal() {
  const result = await window.electronAPI.getScheduleLogs({ limit: 100 });
  const logs = result.success ? result.data.logs : [];

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const statusIcons = {
    success: `<svg class="log-status-icon status-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    failed: `<svg class="log-status-icon status-failed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    timeout: `<svg class="log-status-icon status-timeout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    error: `<svg class="log-status-icon status-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60000)}m`;
  }

  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString();
  }

  let logsHtml;
  if (logs.length === 0) {
    logsHtml = `<div class="log-empty">${t('logs.empty')}</div>`;
  } else {
    logsHtml = '<div class="log-list">' + logs.map(log => `
      <div class="log-entry" data-log-id="${log.id}">
        <div class="log-entry-header">
          ${statusIcons[log.status] || statusIcons.error}
          <span class="log-project-name">${escapeHtml(log.projectName || '')}</span>
          <span class="log-command-name">${escapeHtml(log.commandName || '')}</span>
          ${log.trigger ? `<span class="log-trigger log-trigger-${log.trigger}">${log.trigger === 'scheduled' ? t('logs.scheduled') : t('logs.manual')}</span>` : ''}
          <div class="log-meta">
            <span>${formatTime(log.startTime)}</span>
            <span>${formatDuration(log.durationMs || 0)}</span>
          </div>
        </div>
        <div class="log-detail">
          ${log.stdout ? `<div class="log-detail-label">STDOUT</div><pre>${escapeHtml(log.stdout)}</pre>` : ''}
          ${log.stderr ? `<div class="log-detail-label">STDERR</div><pre>${escapeHtml(log.stderr)}</pre>` : ''}
          ${!log.stdout && !log.stderr ? `<div style="font-size:12px;color:var(--text-muted)">${t('logs.noOutput')}</div>` : ''}
        </div>
      </div>
    `).join('') + '</div>';
  }

  overlay.innerHTML = `
    <div class="modal-content" style="max-width:640px;">
      <div class="modal-header">
        <h3>${t('logs.title')}</h3>
        <button class="close-btn log-close-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body" style="padding:16px 24px;">
        ${logs.length > 0 ? `<div class="log-header"><span style="font-size:12px;color:var(--text-muted)">${t('logs.total', { count: logs.length })}</span><button class="btn-danger log-clear-btn" style="font-size:12px;padding:4px 10px;">${t('logs.clearAll')}</button></div>` : ''}
        ${logsHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Toggle log detail
  overlay.querySelectorAll('.log-entry').forEach(entry => {
    entry.addEventListener('click', () => {
      entry.classList.toggle('expanded');
    });
  });

  const cleanup = () => overlay.remove();
  overlay.querySelector('.log-close-btn').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(); });

  // Clear all
  const clearBtn = overlay.querySelector('.log-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      await window.electronAPI.clearScheduleLogs();
      showToast(t('logs.cleared'), 'success');
      cleanup();
    });
  }
}
