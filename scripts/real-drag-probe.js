// 真实拖动验证探针：打开第一个项目的编辑窗口，上报把手屏幕坐标，并持续上报命令行顺序。
(async () => {
  const api = window.electronAPI;

  function assert(condition, message) { if (!condition) throw new Error(message); }
  async function writeReport(data) {
    await api.invoke('test-report', data);
  }

  try {
    assert(window.__TAURI__?.core?.invoke, 'Tauri core 尚未加载');
    const initial = await api.getProjects();
    assert(initial.success && initial.data.length > 0, '没有项目数据');
    const project = initial.data.find(item => (item.commands || []).length >= 2);
    assert(project, '没有至少两条命令的项目');

    const item = Array.from(document.querySelectorAll('#projectList [data-project-id]')).find(node => node.dataset.projectId === project.id);
    assert(item, '项目列表缺少目标项目');
    item.click();
    await new Promise(resolve => setTimeout(resolve, 300));
    document.getElementById('editProjectBtn').click();
    const deadline = Date.now() + 5000;
    while (!document.querySelector('#projectModal.show') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(document.querySelector('#projectModal.show'), '编辑窗口没有打开');
    // 非激活窗口会吞掉第一击 CGEvent（仅激活不传递），先原生聚焦
    let focusApi = 'unavailable';
    try {
      await window.__TAURI__.window.getCurrentWindow().setFocus();
      focusApi = 'set-focus-ok';
    } catch (error) {
      focusApi = `failed: ${error?.message || error}`;
    }
    await new Promise(resolve => setTimeout(resolve, 600)); // 等待窗口动画结束

    const rows = [...document.querySelectorAll('#commandsList .command-item')];
    assert(rows.length >= 2, '命令行数量不足');
    const handle = rows[0].querySelector('.drag-handle');
    assert(handle, '第一行缺少拖动把手');
    const handleRect = handle.getBoundingClientRect();
    const secondRect = rows[1].getBoundingClientRect();
    const order = () => [...document.querySelectorAll('#commandsList .command-item')].map(row => row.querySelector('input').value);

    // 捕获阶段记录输入事件，诊断真实拖动时 WebKit 转发了什么
    const dragLog = [];
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'dragstart', 'drag', 'dragover', 'drop', 'dragend', 'pointerdown', 'pointermove']) {
      document.addEventListener(type, event => {
        if (dragLog.length < 400) {
          const target = event.target?.className?.toString().slice(0, 40) || event.target?.tagName || '';
          dragLog.push({ type, target, x: Math.round(event.clientX), y: Math.round(event.clientY) });
        }
      }, true);
    }
    // 上报相对视口的 rect，由驱动脚本结合 AppleScript 窗口坐标换算屏幕坐标
    const probe = {
      focusApi,
      viewport: { width: window.innerWidth, height: window.innerHeight, screenX: window.screenX, screenY: window.screenY, devicePixelRatio: window.devicePixelRatio },
      handle: { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2 },
      second: { x: secondRect.left + secondRect.width / 2, y: secondRect.top + secondRect.height / 2 },
      before: order(),
    };

    await writeReport({ phase: 'probe', ...probe });

    // 持续上报顺序，供驱动脚本在真实拖动后读取
    const deadlineAt = Date.now() + 45000;
    while (Date.now() < deadlineAt) {
      await writeReport({ phase: 'status', ...probe, after: order(), dragLog: dragLog.slice(-60) });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    await writeReport({ phase: 'error', message: error.message, stack: error.stack });
  }
})();
