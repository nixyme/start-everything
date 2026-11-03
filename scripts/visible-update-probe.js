(async () => {
  const api = window.electronAPI;
  const checks = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const check = (name, condition, details) => {
    assert(condition, name);
    checks.push({ name, passed: true, details });
  };
  const rect = element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const panel = document.getElementById('updatePanel');
  const action = document.getElementById('checkUpdateBtn');
  const version = await api.getAppVersion();
  check('主界面常驻显示当前版本', panel.getBoundingClientRect().height > 0 && document.getElementById('currentVersion').textContent === `v${version}`, { version });
  check('更新入口位于应用名称右侧', !!panel.closest('.app-header') && !action.closest('.modal') && panel.getBoundingClientRect().x > document.querySelector('.app-brand').getBoundingClientRect().x, { panel: rect(panel) });
  check('更新入口只存在一个', document.querySelectorAll('#checkUpdateBtn').length === 1 && !document.getElementById('settingsModal').contains(action));
  const promise = updateCheck();
  check('真实检查时按钮禁用并显示状态', UpdateCenter.state === 'checking' && action.disabled && document.getElementById('updateStatus').textContent === t('settings.checking'));
  await updateCheck();
  check('重复检查不会改变进行中的状态', UpdateCenter.state === 'checking');
  await promise;
  assert(UpdateCenter.info, `真实更新检查失败：${UpdateCenter.error}`);
  check('真实更新接口完成并恢复按钮', UpdateCenter.state === 'idle' && !action.disabled && UpdateCenter.info.currentVersion === version, { current: version, latest: UpdateCenter.info.latestVersion });
  check('没有新版本时仍可检查更新', !panel.hidden && document.getElementById('updateStatus').textContent === t('settings.upToDate'));
  for (const locale of ['en', 'zh', 'ja', 'fr']) {
    await setLocale(locale);
    renderUpdateUi();
    const label = document.getElementById('currentVersionLabel').textContent;
    check(`${locale} 更新文案完整`, label === t('update.currentVersion') && !label.startsWith('update.') && document.getElementById('updateActionLabel').textContent === t('settings.checkUpdate'));
  }
  await setLocale('zh');
  renderUpdateUi();
  check('主界面没有横向溢出', document.documentElement.scrollWidth <= window.innerWidth, { width: window.innerWidth, header: rect(document.querySelector('.app-header')) });
  check('更新按钮位于可见区域', action.getBoundingClientRect().right <= window.innerWidth && action.getBoundingClientRect().bottom <= window.innerHeight, { action: rect(action) });
  check('初始化没有错误弹窗', !document.querySelector('[role="alertdialog"]'));
  await api.invoke('test-report', { phase: 'done', passed: checks.length, failed: 0, checks });
})();
