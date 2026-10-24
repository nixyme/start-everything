const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRequest, normalizeError, getDroppedPaths, logicalDropPosition, dropPositionUsesLogicalUnits } = require('../src/bridge.js');
const { simpleConfigToCron, createMicrotaskBatch } = require('../src/frontend-utils.js');

test('简单计划保留午夜和星期日', () => {
  assert.equal(simpleConfigToCron({ type: 'daily', hour: 0, minute: 0 }), '0 0 * * *');
  assert.equal(simpleConfigToCron({ type: 'weekly', hour: 0, minute: 15, day: 0 }), '15 0 * * 0');
  assert.equal(simpleConfigToCron({ type: 'weekly' }), '0 9 * * 1');
});

test('搜索刷新在同一任务合并，并在微任务执行最新内容', async () => {
  let value = '';
  const rendered = [];
  const refresh = createMicrotaskBatch(() => rendered.push(value));
  value = 'first';
  refresh();
  value = 'second';
  refresh();
  await Promise.resolve();
  assert.deepEqual(rendered, ['second']);
  value = 'third';
  refresh();
  await Promise.resolve();
  assert.deepEqual(rendered, ['second', 'third']);
});

test('桥接参数保持项目、命令和计划数据', () => {
  const updates = { name: '中文项目', extra: { retained: true } };
  assert.deepEqual(buildRequest('updateProject', ['p1', updates]), {
    action: 'update-project', args: { id: 'p1', updates },
  });
  assert.deepEqual(buildRequest('executeCommand', ['/项目', 'pnpm run 开始', '项目', '开始']), {
    action: 'execute-command', args: { projectPath: '/项目', command: 'pnpm run 开始', projectName: '项目', commandName: '开始' },
  });
  assert.deepEqual(buildRequest('getScheduleForCommand', ['p1', 2]), {
    action: 'get-schedule-for-command', args: { projectId: 'p1', index: 2 },
  });
  assert.deepEqual(buildRequest('validateCron', ['*/5 * * * *']), {
    action: 'validate-cron', args: { cronExpression: '*/5 * * * *' },
  });
});

test('未知接口和参数数量错误立即失败', () => {
  assert.throws(() => buildRequest('unknown', []), /Unknown desktop method/);
  assert.throws(() => buildRequest('updateProject', ['p1']), /requires/);
});

test('桥接错误保留后端日志', () => {
  assert.deepEqual(normalizeError(new Error('写入失败')), { success: false, error: '写入失败' });
  assert.deepEqual(normalizeError({ message: '权限错误', details: '路径不可写' }), {
    success: false, error: '权限错误\n路径不可写',
  });
});

test('原生拖放仅传递后端提供的真实路径', () => {
  assert.deepEqual(getDroppedPaths({ detail: { nativePaths: ['/目录/文件.txt', '/中文 空格'] } }), ['/目录/文件.txt', '/中文 空格']);
  assert.deepEqual(getDroppedPaths({ dataTransfer: { files: [{ name: '文件.txt' }] } }), []);
});

test('拖放坐标按后端单位换算：macOS/Linux 逻辑坐标不缩放，Windows 物理像素除以缩放比', () => {
  assert.equal(dropPositionUsesLogicalUnits('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(dropPositionUsesLogicalUnits('Mozilla/5.0 (X11; Linux x86_64)'), true);
  assert.equal(dropPositionUsesLogicalUnits('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  // wry 的 macOS 后端上报逻辑坐标，Retina 屏上除以 devicePixelRatio 会定位错位
  assert.deepEqual(logicalDropPosition({ x: 170, y: 20 }, 2, 'Mozilla/5.0 (Macintosh)'), { x: 170, y: 20 });
  assert.deepEqual(logicalDropPosition({ x: 360, y: 240 }, 2, 'Mozilla/5.0 (Windows NT 10.0)'), { x: 180, y: 120 });
  assert.throws(() => logicalDropPosition({ x: 1, y: 1 }, NaN, ''), /Invalid display scale factor/);
});
