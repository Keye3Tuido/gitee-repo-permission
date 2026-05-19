import { state, PERM_LEVEL } from './state.js';
import { giteeApi } from './api.js';
import { setStatus, appendLog, clearLog } from './utils.js';
import { precheckTargetUserPermissions, classifyDowngrades,
         permLevelToLabel } from './permissions.js';
import { showDowngradeDecisionModal } from './modal.js';
import { switchTab } from './tabs.js';

async function batchAddCollab() {
  const username = document.getElementById('batch-user').value.trim();
  const permission = document.getElementById('batch-perm').value;
  if (!username) { setStatus('请输入用户名'); return; }
  if (state.selectedRepos.size === 0) { setStatus('请先选择仓库'); return; }

  const allSelected = Array.from(state.selectedRepos);
  var repos = allSelected.filter(function(fn) {
    var r = state.allRepos.find(function(x) { return x.full_name === fn; });
    if (!r) return false;
    return r.permissionLoaded && !!(r.permission && r.permission.admin);
  });
  var skipped = allSelected.length - repos.length;
  if (repos.length === 0) {
    setStatus('所选仓库均无管理员权限（或权限仍在加载中）');
    if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个仓库（无管理员权限或权限仍在加载中）', 'err');
    return;
  }

  var permLabels = { pull: '只读', push: '读写', admin: '管理员' };
  var permLabel = permLabels[permission] || permission;
  var isSelf = !!(state.currentUser && username.toLowerCase() === state.currentUser.toLowerCase());

  var confirmMsg = isSelf
    ? '⚠️ 警告：你正在批量修改【自己】在 ' + repos.length + ' 个仓库的权限为 ' + permLabel + '(' + permission + ')。\n\n确定要继续吗？'
    : '确定为 ' + username + ' 添加 ' + permLabel + '(' + permission + ') 权限到 ' + repos.length + ' 个仓库？';
  if (skipped > 0) confirmMsg += '\n\n（已自动跳过 ' + skipped + ' 个无管理员权限或权限仍在加载中的仓库）';
  if (!confirm(confirmMsg)) return;

  const addBtn = document.querySelector('.batch-bar .btn-success');
  const removeBtn = document.querySelector('.batch-bar .btn-danger');
  const loadBtn = document.getElementById('load-btn');
  const addCollabBtn = document.getElementById('add-collab-btn');
  const collabUpdateBtn = document.getElementById('collab-batch-update-btn');
  const collabRmBtn = document.getElementById('collab-batch-remove-btn');
  function setBatchButtons(disabled) {
    if (addBtn) addBtn.disabled = disabled;
    if (removeBtn) removeBtn.disabled = disabled;
    if (loadBtn) loadBtn.disabled = disabled;
    if (addCollabBtn) addCollabBtn.disabled = disabled;
    if (collabUpdateBtn) collabUpdateBtn.disabled = disabled;
    if (collabRmBtn) collabRmBtn.disabled = disabled;
  }
  setBatchButtons(true);
  clearLog();
  switchTab('log');
  if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个仓库（无管理员权限或权限仍在加载中）', 'info');

  appendLog('正在预检 ' + username + ' 在所选仓库的现有权限…', 'info');
  setStatus('预检中… 0/' + repos.length);
  var precheck;
  try {
    precheck = await precheckTargetUserPermissions(repos, username);
  } catch (e) {
    appendLog('预检失败: ' + e.message, 'err');
    setStatus('预检失败');
    setBatchButtons(false);
    return;
  }
  var classify = classifyDowngrades(repos, precheck.levelMap, PERM_LEVEL[permission]);

  var finalRepos;
  if (classify.downgrades.length > 0 || classify.failed.length > 0) {
    var dgRows = classify.downgrades.map(function(d) {
      return { title: d.repo, sub: d.currentLabel + ' → ' + permLabel + '(' + permission + ')' };
    });
    var failedRows = classify.failed.map(function(f) { return { title: f.repo }; });
    setStatus('请处理降级仓库');
    var decision = await showDowngradeDecisionModal({
      mode: 'batch',
      scope: '仓库',
      isSelf: isSelf,
      targetPermLabel: permLabel + '(' + permission + ')',
      headerText: '即将为 ' + username + ' 在 ' + repos.length + ' 个仓库授予 ' + permLabel + '(' + permission + ')。请明确处理以下情况：',
      downgrades: dgRows,
      failed: failedRows,
      safeCount: classify.safe.length,
    });
    if (decision === 'cancel') {
      appendLog('操作已取消', 'info');
      setStatus('操作已取消');
      setBatchButtons(false);
      return;
    }
    if (decision === 'skip') {
      finalRepos = classify.safe.map(function(s) { return s.repo; });
      appendLog('已忽略 ' + classify.downgrades.length + ' 个降级仓库与 ' + classify.failed.length + ' 个权限未知仓库', 'info');
    } else {
      finalRepos = repos;
      if (classify.downgrades.length > 0) appendLog('用户选择保留降级：将对 ' + classify.downgrades.length + ' 个降级仓库继续执行', 'info');
    }
  } else {
    finalRepos = repos;
  }

  if (finalRepos.length === 0) {
    appendLog('没有需要执行的仓库', 'info');
    setStatus('完成: 0 成功, 0 失败');
    setBatchButtons(false);
    return;
  }

  appendLog('开始批量添加: ' + username + ' -> ' + permission + ' (' + finalRepos.length + ' 个仓库)', 'info');
  setStatus('批量添加中… 0/' + finalRepos.length);

  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < finalRepos.length; i++) {
      setStatus('批量添加中… ' + (i + 1) + '/' + finalRepos.length);
      try {
        await giteeApi('PUT', '/repos/' + finalRepos[i] + '/collaborators/' + username, { permission: permission });
        appendLog('✓ ' + finalRepos[i], 'ok');
        ok++;
      } catch (e) {
        appendLog('✗ ' + finalRepos[i] + ': ' + e.message, 'err');
        fail++;
      }
    }
  } finally {
    setBatchButtons(false);
  }
  appendLog('完成: ' + ok + ' 成功, ' + fail + ' 失败', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('批量添加完成: ' + ok + ' 成功, ' + fail + ' 失败');
}

async function batchRemoveCollab() {
  const username = document.getElementById('batch-user').value.trim();
  if (!username) { setStatus('\u8bf7\u8f93\u5165\u7528\u6237\u540d'); return; }
  if (state.selectedRepos.size === 0) { setStatus('\u8bf7\u5148\u9009\u62e9\u4ed3\u5e93'); return; }

  const allSelected = Array.from(state.selectedRepos);
  // Only include repos with confirmed admin permission; skip loading repos and non-admin
  var repos = allSelected.filter(function(fn) {
    var r = state.allRepos.find(function(x) { return x.full_name === fn; });
    if (!r) return false;
    return r.permissionLoaded && !!(r.permission && r.permission.admin);
  });
  var skipped = allSelected.length - repos.length;
  if (repos.length === 0) {
    setStatus('\u6240\u9009\u4ed3\u5e93\u5747\u65e0\u7ba1\u7406\u5458\u6743\u9650\uff08\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09');
    if (skipped > 0) appendLog('\u5df2\u8df3\u8fc7 ' + skipped + ' \u4e2a\u4ed3\u5e93\uff08\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09', 'err');
    return;
  }

  var isSelf = state.currentUser && username.toLowerCase() === state.currentUser.toLowerCase();
  var confirmMsg;
  if (isSelf) {
    confirmMsg = '⛔ 警告：你正在批量将【自己】从 ' + repos.length + ' 个仓库移除！\n\n移除后你将无法访问这些仓库，且无法自行恢复！\n\n确定要继续吗？';
  } else {
    confirmMsg = '\u786e\u5b9a\u4ece ' + repos.length + ' \u4e2a\u4ed3\u5e93\u79fb\u9664 ' + username + '\uff1f';
  }
  if (skipped > 0) confirmMsg += '\n\n\uff08\u5df2\u81ea\u52a8\u8df3\u8fc7 ' + skipped + ' \u4e2a\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\u7684\u4ed3\u5e93\uff09';
  if (!confirm(confirmMsg)) return;

  const addBtn = document.querySelector('.batch-bar .btn-success');
  const rmBtn = document.querySelector('.batch-bar .btn-danger');
  const loadBtn = document.getElementById('load-btn');
  const addCollabBtn = document.getElementById('add-collab-btn');
  const collabUpdateBtn = document.getElementById('collab-batch-update-btn');
  const collabRmBtn = document.getElementById('collab-batch-remove-btn');
  if (addBtn) addBtn.disabled = true;
  if (rmBtn) rmBtn.disabled = true;
  if (loadBtn) loadBtn.disabled = true;
  if (addCollabBtn) addCollabBtn.disabled = true;
  if (collabUpdateBtn) collabUpdateBtn.disabled = true;
  if (collabRmBtn) collabRmBtn.disabled = true;
  clearLog();
  switchTab('log');
  if (skipped > 0) appendLog('\u5df2\u8df3\u8fc7 ' + skipped + ' \u4e2a\u4ed3\u5e93\uff08\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09', 'info');
  appendLog('\u5f00\u59cb\u6279\u91cf\u79fb\u9664: ' + username + ' (' + repos.length + ' \u4e2a\u4ed3\u5e93)', 'info');
  setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 0/' + repos.length);

  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < repos.length; i++) {
      setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 ' + (i + 1) + '/' + repos.length);
      try {
        await giteeApi('DELETE', '/repos/' + repos[i] + '/collaborators/' + username);
        appendLog('\u2713 ' + repos[i], 'ok');
        ok++;
      } catch (e) {
        appendLog('\u2717 ' + repos[i] + ': ' + e.message, 'err');
        fail++;
      }
    }
  } finally {
    if (addBtn) addBtn.disabled = false;
    if (rmBtn) rmBtn.disabled = false;
    if (loadBtn) loadBtn.disabled = false;
    if (addCollabBtn) addCollabBtn.disabled = false;
    if (collabUpdateBtn) collabUpdateBtn.disabled = false;
    if (collabRmBtn) collabRmBtn.disabled = false;
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u79fb\u9664\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
}

// ============================================================
// Tabs

export { batchAddCollab, batchRemoveCollab };
