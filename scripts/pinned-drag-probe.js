// 置顶格子真实拖动探针：上报置顶格子屏幕相对坐标，并持续上报当前顺序。
(async () => {
  const api = window.electronAPI;

  function assert(condition, message) { if (!condition) throw new Error(message); }
  async function writeReport(data) {
    await api.invoke('test-report', data);
  }

  try {
    assert(window.__TAURI__?.core?.invoke, 'Tauri core 尚未加载');
    const initial = await api.getProjects();
    assert(initial.success, '读取项目失败');
    const pinned = initial.data.filter(item => item.pinned);
    assert(pinned.length >= 2, '置顶项目数量不足');

    const cells = pinned
      .map(project => document.querySelector(`.pinned-item[data-project-id="${project.id}"]`))
      .filter(Boolean);
    assert(cells.length >= 2, '置顶格子未渲染');

    let focusApi = 'unavailable';
    try {
      await window.__TAURI__.window.getCurrentWindow().setFocus();
      focusApi = 'set-focus-ok';
    } catch (error) {
      focusApi = `failed: ${error?.message || error}`;
    }
    await new Promise(resolve => setTimeout(resolve, 600));

    const firstRect = cells[0].getBoundingClientRect();
    const secondRect = cells[1].getBoundingClientRect();
    const order = () => [...document.querySelectorAll('.pinned-item')].map(node => node.dataset.projectId);

    const dragLog = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dragstart']) {
      document.addEventListener(type, event => {
        if (dragLog.length < 300) {
          dragLog.push({ type, target: event.target?.className?.toString().slice(0, 30) || '', x: Math.round(event.clientX), y: Math.round(event.clientY) });
        }
      }, true);
    }

    const probe = {
      focusApi,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      start: { x: firstRect.left + firstRect.width / 2, y: firstRect.top + firstRect.height / 2 },
      // 目标格子右半边：指针落点在右半 → 插到目标后面
      end: { x: secondRect.right - secondRect.width / 4, y: secondRect.top + secondRect.height / 2 },
      before: order(),
    };
    await writeReport({ phase: 'probe', ...probe });

    const deadlineAt = Date.now() + 45000;
    while (Date.now() < deadlineAt) {
      await writeReport({ phase: 'status', ...probe, after: order(), dragLog: dragLog.slice(-60) });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    await writeReport({ phase: 'error', message: error.message, stack: error.stack });
  }
})();
