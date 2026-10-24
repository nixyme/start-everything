// 更新链路与数据目录变更探针：验证 chip 初始态、真实更新检查、目录校验与设置页 UI。
(async () => {
  const api = window.electronAPI;

  function assert(condition, message) { if (!condition) throw new Error(message); }
  async function writeReport(data) {
    await api.invoke('test-report', data);
  }

  try {
    await new Promise(resolve => setTimeout(resolve, 800)); // 等待初始化完成

    const results = [];

    // A. 左上角 chip 存在且初始隐藏（无更新时）
    const chip = document.getElementById('updateChip');
    assert(chip, '更新 chip 不存在');
    results.push({ name: 'chip 初始隐藏', passed: chip.style.display === 'none' });

    // B. 真实更新检查：当前版本比线上 release 新 → isNewer=false
    const check = await api.checkForUpdate();
    assert(check.success, 'checkForUpdate 失败: ' + check.error);
    results.push({
      name: '更新检查 isNewer=false',
      passed: check.data.isNewer === false && check.data.currentVersion.length > 0 && check.data.autoCapable === false,
      detail: { current: check.data.currentVersion, latest: check.data.latestVersion, autoCapable: check.data.autoCapable },
    });

    // C. 数据目录信息：env 覆盖目录 + isCustom
    const info = await api.getDataDirInfo();
    assert(info.success, 'getDataDirInfo 失败');
    results.push({
      name: '数据目录信息',
      passed: info.data.isCustom === true && info.data.dataDir.length > 0,
      detail: info.data,
    });

    // D. 目标目录已有数据 → 拒绝
    const currentDir = info.data.dataDir;
    const rejectBusy = await api.setDataDir(currentDir);
    results.push({ name: '拒绝含数据目录', passed: !rejectBusy.success && /project data/.test(rejectBusy.error || '') });

    // E. 相对路径 → 拒绝
    const rejectRelative = await api.setDataDir('relative/dir');
    results.push({ name: '拒绝相对路径', passed: !rejectRelative.success && /absolute/.test(rejectRelative.error || '') });

    // F. 合法新目录 → 成功并复制数据
    const newDir = window.__UPDATE_TEST_NEW_DIR;
    assert(newDir, '缺少测试目标目录注入');
    const change = await api.setDataDir(newDir);
    results.push({ name: '变更数据目录成功', passed: change.success === true, detail: change.data || change.error });

    // G. 未下载更新时 install → 拒绝
    const install = await api.installUpdate('/tmp/not-downloaded.dmg');
    results.push({ name: '未下载更新时拒绝安装', passed: !install.success && /No verified update/.test(install.error || '') });

    // H. 设置页 UI：目录行、按钮渲染
    document.getElementById('settingsBtn').click();
    const deadline = Date.now() + 3000;
    while (!document.querySelector('#settingsModal.show') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const pathEl = document.getElementById('dataDirPath');
    const resetBtn = document.getElementById('resetDataDirBtn');
    results.push({
      name: '设置页目录行渲染',
      passed: !!pathEl && pathEl.textContent.length > 0 && resetBtn.style.display !== 'none',
      detail: { path: pathEl?.textContent, resetVisible: resetBtn?.style.display },
    });

    const failed = results.filter(item => !item.passed);
    await writeReport({ phase: 'done', passed: results.length - failed.length, failed: failed.length, results, errors: failed.map(item => item.name) });
  } catch (error) {
    await writeReport({ phase: 'error', message: error.message, stack: error.stack });
  }
})();
