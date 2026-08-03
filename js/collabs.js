import { state, PERM_LEVEL } from './state.js';
import { giteeApi, giteeApiFetchAll } from './api.js';
import { setStatus, appendLog, clearLog } from './utils.js';
import { getRepoPermissionState, permLevelToLabel,
         getCurrentPermLevel } from './permissions.js';
import { showDowngradeDecisionModal } from './modal.js';
import { switchTab } from './tabs.js';
import { setupUserSearch } from './userSearch.js';
import { loadSubmodules } from './submodules.js';
import { attachOrgRow } from './orgs.js';
import { setBatchLoading } from './repos.js';

function updateDetailPermBadges(fullName) {
  if (fullName !== state.currentRepo) return;
  var repo = state.allRepos.find(function(r) { return r.full_name === fullName; });
  if (!repo) return;

  var badges = document.getElementById('detail-badges');
  if (!badges) return;
  badges.innerHTML = '';
  var permissionState = getRepoPermissionState(repo);

  if (permissionState === 'loading') {
    var loadSpan = document.createElement('span');
    loadSpan.className = 'perm-badge perm-loading';
    loadSpan.textContent = '\u6743\u9650\u52a0\u8f7d\u4e2d\u2026';
    badges.appendChild(loadSpan);
  } else if (permissionState === 'failed') {
    var errSpan = document.createElement('span');
    errSpan.className = 'perm-badge perm-error';
    errSpan.textContent = '\u26a0\ufe0f \u6743\u9650\u8bf7\u6c42\u5931\u8d25';
    badges.appendChild(errSpan);
  } else if (permissionState === 'unauthorized') {
    var unauthorizedSpan = document.createElement('span');
    unauthorizedSpan.className = 'perm-badge perm-unauthorized';
    unauthorizedSpan.textContent = '\u65e0\u6743\u9650';
    badges.appendChild(unauthorizedSpan);
  } else {
    var p = repo.permission;
    var items = [
      { label: 'admin', val: !!p.admin, color: 'var(--primary)' },
      { label: 'push',  val: !!p.push,  color: 'var(--success)' },
      { label: 'pull',  val: !!p.pull,  color: 'var(--text3)' },
    ];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var span = document.createElement('span');
      span.className = 'perm-badge' + (item.val ? ' perm-on' : ' perm-off');
      span.style.background = item.val ? item.color : '#ddd';
      span.textContent = item.label + ': ' + (item.val ? '\u2713' : '\u2717');
      badges.appendChild(span);
    }
  }
  if (repo.isPrivate) {
    var privSpan = document.createElement('span');
    privSpan.className = 'perm-badge perm-on';
    privSpan.style.background = 'var(--warning)';
    privSpan.textContent = '\uD83D\uDD12 \u79c1\u6709';
    badges.appendChild(privSpan);
  }
  if (repo.html_url) {
    var a = document.createElement('a');
    a.href = repo.html_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.className = 'repo-link';
    a.textContent = '\u2197 \u6253\u5f00 Gitee';
    badges.appendChild(a);
  }

  // Update add-collab button: only disable when permission is definitely NOT admin
  var addBtn = document.getElementById('add-collab-btn');
  if (addBtn) {
    if (permissionState === 'loading') {
      addBtn.disabled = true;
      addBtn.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
    } else if (permissionState === 'failed') {
      addBtn.disabled = true;
      addBtn.title = '\u6743\u9650\u8bf7\u6c42\u5931\u8d25\uff0c\u65e0\u6cd5\u786e\u8ba4\u7ba1\u7406\u5458\u6743\u9650';
    } else if (repo.permission && repo.permission.admin) {
      addBtn.disabled = false;
      addBtn.title = '';
    } else {
      addBtn.disabled = true;
      addBtn.title = '\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u624d\u80fd\u6dfb\u52a0\u534f\u4f5c\u8005';
    }
  }

  // Re-render collab list so controls reflect the newly-arrived permission
  var collabSearchEl = document.getElementById('collab-search');
  if (collabSearchEl && state.currentCollabsRepo === fullName && state.currentCollabs.length > 0) {
    renderCollabList(collabSearchEl.value);
  }
}

async function loadRepoDetail(fullName) {
  document.getElementById('detail-placeholder').style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';
  document.getElementById('detail-repo-name').textContent = fullName;

  updateDetailPermBadges(fullName);

  const collabList = document.getElementById('collab-list');
  collabList.innerHTML = '';
  var _loadingDiv = document.createElement('div'); _loadingDiv.className = 'loading-text'; _loadingDiv.textContent = '\u52a0\u8f7d\u4e2d\u2026'; collabList.appendChild(_loadingDiv);
  var collabSearchEl = document.getElementById('collab-search');
  if (collabSearchEl) collabSearchEl.value = '';
  var collabCountEl = document.getElementById('collab-count');
  if (collabCountEl) collabCountEl.textContent = '(\u52a0\u8f7d\u4e2d\u2026)';
  state.currentCollabs = []; state.currentCollabsRepo = null;
  state.selectedCollabs.clear();
  var _batchBar = document.getElementById('collab-batch-bar'); if (_batchBar) _batchBar.style.display = 'none';

  try {
    const collabs = await giteeApiFetchAll('/repos/' + fullName + '/collaborators');
    // Discard stale response if user switched to another repo while loading
    if (fullName !== state.currentRepo) return;
    state.currentCollabs = collabs; state.currentCollabsRepo = fullName;
    renderCollabList('');
    // Load submodules for this repo
    loadSubmodules(fullName);
  } catch (e) {
    if (fullName !== state.currentRepo) return;
    state.currentCollabs = []; state.currentCollabsRepo = null;
    collabList.innerHTML = '';
    var _errDiv = document.createElement('div'); _errDiv.className = 'err-text'; _errDiv.textContent = '\u52a0\u8f7d\u5931\u8d25: ' + e.message; collabList.appendChild(_errDiv);
    // still try to load submodules even if collaborators failed
    loadSubmodules(fullName);
  }
}

function renderCollabList(filter) {
  var fullName = state.currentRepo;
  var collabList = document.getElementById('collab-list');
  collabList.innerHTML = '';
  filter = (filter || '').trim().toLowerCase();

  var filtered = state.currentCollabs;
  if (filter) {
    filtered = state.currentCollabs.filter(function(c) {
      var login = (c.login || '').toLowerCase();
      var name = (c.name || '').toLowerCase();
      return login.indexOf(filter) !== -1 || name.indexOf(filter) !== -1;
    });
  }

  // Update count
  var countEl = document.getElementById('collab-count');
  if (countEl) {
    if (filter && filtered.length !== state.currentCollabs.length) {
      countEl.textContent = '(' + filtered.length + '/' + state.currentCollabs.length + ')';
    } else {
      countEl.textContent = state.currentCollabs.length > 0 ? '(' + state.currentCollabs.length + ')' : '';
    }
  }

  // Hoist permission check — same for every item in this repo
  var repo = state.allRepos.find(function(r) { return r.full_name === fullName; });
  var permissionState = getRepoPermissionState(repo);
  var permissionLoading = permissionState === 'loading';
  var permissionFailed = permissionState === 'failed';
  var isAdmin = permissionState === 'admin';

  if (state.currentCollabs.length === 0) {
    updateCollabBatchBar([], isAdmin);
    var _emptyDiv = document.createElement('div'); _emptyDiv.className = 'loading-text'; _emptyDiv.textContent = '\u6682\u65e0\u534f\u4f5c\u8005'; collabList.appendChild(_emptyDiv);
    return;
  }

  if (filtered.length === 0) {
    updateCollabBatchBar([], isAdmin);
    var _noMatchDiv = document.createElement('div'); _noMatchDiv.className = 'loading-text'; _noMatchDiv.textContent = '\u672a\u627e\u5230\u5339\u914d\u7684\u534f\u4f5c\u8005'; collabList.appendChild(_noMatchDiv);
    return;
  }

  for (var ci = 0; ci < filtered.length; ci++) {
    (function(c) {
      const div = document.createElement('div');
      div.className = 'collab-item';

      if (isAdmin) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'collab-item-cb';
        cb.checked = state.selectedCollabs.has(c.login);
        cb.onchange = function() {
          if (cb.checked) state.selectedCollabs.add(c.login);
          else state.selectedCollabs.delete(c.login);
          updateCollabBatchBar(filtered, isAdmin);
        };
        div.appendChild(cb);
      }

      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = c.avatar_url || '';
      avatar.onerror = function() { avatar.style.display = 'none'; };

      const info = document.createElement('div');
      info.className = 'collab-info';
      var nameDiv = document.createElement('div'); nameDiv.className = 'collab-name'; nameDiv.textContent = c.name || c.login;
      var loginDiv = document.createElement('div'); loginDiv.className = 'collab-login'; loginDiv.textContent = '@' + c.login;
      info.appendChild(nameDiv); info.appendChild(loginDiv);
      // 组织：协作者可能上百人，故只用已建好的反向索引（publicOrgs:false = 每人零额外请求）
      info.appendChild(attachOrgRow(c.login, {
        publicOrgs: false,
        isStale: function() { return state.currentRepo !== fullName; },
      }));

      // Resolve collaborator permission — Gitee API returns `permissions` (object) or `permission` (object or string)
      var _rawPerm = c.permissions || c.permission;
      var _permValue = null;
      if (typeof _rawPerm === 'string' && (_rawPerm === 'pull' || _rawPerm === 'push' || _rawPerm === 'admin')) {
        _permValue = _rawPerm;
      } else if (_rawPerm && typeof _rawPerm === 'object') {
        _permValue = _rawPerm.admin ? 'admin' : _rawPerm.push ? 'push' : 'pull';
      }

      const permSelect = document.createElement('select');
      if (_permValue === null) {
        permSelect.innerHTML = '<option value="">\u6743\u9650\u672a\u77e5</option><option value="pull">\u53ea\u8bfb</option><option value="push">\u8bfb\u5199</option><option value="admin">\u7ba1\u7406\u5458</option>';
        permSelect.disabled = true;
        permSelect.title = 'API \u672a\u8fd4\u56de\u6743\u9650\u4fe1\u606f';
      } else {
        permSelect.innerHTML = '<option value="pull">\u53ea\u8bfb</option><option value="push">\u8bfb\u5199</option><option value="admin">\u7ba1\u7406\u5458</option>';
        permSelect.value = _permValue;
        if (permissionLoading) {
          permSelect.disabled = true;
          permSelect.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
        } else if (permissionFailed) {
          permSelect.disabled = true;
          permSelect.title = '\u6743\u9650\u8bf7\u6c42\u5931\u8d25\uff0c\u65e0\u6cd5\u786e\u8ba4\u7ba1\u7406\u5458\u6743\u9650';
        } else if (!isAdmin) {
          permSelect.disabled = true;
          permSelect.title = '\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u624d\u80fd\u4fee\u6539';
        } else {
          permSelect.onchange = function() { updateCollabPermission(fullName, c.login, permSelect.value); };
        }
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger btn-sm';
      removeBtn.textContent = '\u79fb\u9664';
      if (permissionLoading) {
        removeBtn.disabled = true;
        removeBtn.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
      } else if (permissionFailed) {
        removeBtn.disabled = true;
        removeBtn.title = '\u6743\u9650\u8bf7\u6c42\u5931\u8d25\uff0c\u65e0\u6cd5\u786e\u8ba4\u7ba1\u7406\u5458\u6743\u9650';
      } else if (!isAdmin) {
        removeBtn.disabled = true;
        removeBtn.title = '\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u624d\u80fd\u79fb\u9664';
      } else {
        removeBtn.onclick = function() { removeCollab(fullName, c.login); };
      }

      div.appendChild(avatar);
      div.appendChild(info);
      div.appendChild(permSelect);
      div.appendChild(removeBtn);
      collabList.appendChild(div);
    })(filtered[ci]);
  }

  updateCollabBatchBar(filtered, isAdmin);
}

function updateCollabBatchBar(filtered, isAdmin) {
  var bar = document.getElementById('collab-batch-bar');
  if (!bar) return;
  if (!isAdmin || filtered.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  var selAllCb = document.getElementById('collab-select-all');
  if (selAllCb) {
    var selInFiltered = filtered.filter(function(c) { return state.selectedCollabs.has(c.login); }).length;
    selAllCb.indeterminate = selInFiltered > 0 && selInFiltered < filtered.length;
    selAllCb.checked = filtered.length > 0 && selInFiltered === filtered.length;
  }
  var selCountEl = document.getElementById('collab-selected-count');
  if (selCountEl) selCountEl.textContent = '\u5df2\u9009 ' + state.selectedCollabs.size + ' \u4eba';
  var hasSelection = state.selectedCollabs.size > 0;
  var updateBtn = document.getElementById('collab-batch-update-btn');
  var rmBtn = document.getElementById('collab-batch-remove-btn');
  if (updateBtn) updateBtn.disabled = !hasSelection;
  if (rmBtn) rmBtn.disabled = !hasSelection;
}

function toggleSelectAllCollabs() {
  var searchEl = document.getElementById('collab-search');
  var filter = (searchEl ? searchEl.value : '').trim().toLowerCase();
  var filtered = filter ? state.currentCollabs.filter(function(c) {
    return (c.login || '').toLowerCase().indexOf(filter) !== -1 || (c.name || '').toLowerCase().indexOf(filter) !== -1;
  }) : state.currentCollabs.slice();
  var allSel = filtered.length > 0 && filtered.every(function(c) { return state.selectedCollabs.has(c.login); });
  filtered.forEach(function(c) { if (allSel) state.selectedCollabs.delete(c.login); else state.selectedCollabs.add(c.login); });
  renderCollabList(searchEl ? searchEl.value : '');
}

async function batchCollabUpdatePerm() {
  if (!state.currentRepo || state.selectedCollabs.size === 0) return;
  var permission = document.getElementById('collab-batch-perm').value;
  var permLabels = { pull: '\u53ea\u8bfb', push: '\u8bfb\u5199', admin: '\u7ba1\u7406\u5458' };
  var permLabel = permLabels[permission] || permission;
  var logins = Array.from(state.selectedCollabs);
  var isSelf = !!(state.currentUser && logins.some(function(l) { return l.toLowerCase() === state.currentUser.toLowerCase(); }));

  // Classify downgrades against state.currentCollabs cache (no API call needed)
  var targetLevel = PERM_LEVEL[permission];
  var dgRows = [];
  var safeLogins = [];
  for (var li = 0; li < logins.length; li++) {
    var login = logins[li];
    var curLvl = getCurrentPermLevel(state.currentRepo, login);
    if (curLvl >= 0 && curLvl > targetLevel) {
      dgRows.push({
        title: login + (isSelf && login.toLowerCase() === (state.currentUser || '').toLowerCase() ? '  \u26d4\u81ea\u5df1' : ''),
        sub: permLevelToLabel(curLvl) + ' \u2192 ' + permLabel + '(' + permission + ')',
        login: login,
      });
    } else {
      safeLogins.push(login);
    }
  }

  var finalLogins;
  if (dgRows.length > 0) {
    var decision = await showDowngradeDecisionModal({
      mode: 'batch',
      scope: '\u534f\u4f5c\u8005',
      isSelf: isSelf,
      targetPermLabel: permLabel + '(' + permission + ')',
      headerText: '\u5373\u5c06\u5728 ' + state.currentRepo + ' \u4e2d\u5c06\u9009\u4e2d\u534f\u4f5c\u8005\u6743\u9650\u4fee\u6539\u4e3a ' + permLabel + '(' + permission + ')\u3002\u4ee5\u4e0b\u534f\u4f5c\u8005\u4f1a\u53d1\u751f\u964d\u7ea7\uff1a',
      downgrades: dgRows,
      failed: [],
      safeCount: safeLogins.length,
    });
    if (decision === 'cancel') return;
    if (decision === 'skip') finalLogins = safeLogins;
    else finalLogins = logins;
  } else {
    var confirmMsg = isSelf
      ? '\u26a0\ufe0f \u8b66\u544a\uff1a\u9009\u4e2d\u5217\u8868\u4e2d\u5305\u542b\u3010\u4f60\u81ea\u5df1\u3011\uff0c\u5c06\u4fee\u6539\u4f60\u5728 ' + state.currentRepo + ' \u7684\u6743\u9650\u4e3a ' + permLabel + '(' + permission + ')\u3002\n\n\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f'
      : '\u786e\u5b9a\u5c06\u4ee5\u4e0b ' + logins.length + ' \u4f4d\u534f\u4f5c\u8005\u5728 ' + state.currentRepo + ' \u7684\u6743\u9650\u4fee\u6539\u4e3a ' + permLabel + '(' + permission + ')\uff1f\n\n' + logins.join(', ');
    if (!confirm(confirmMsg)) return;
    finalLogins = logins;
  }

  if (finalLogins.length === 0) {
    setStatus('\u6ca1\u6709\u9700\u8981\u6267\u884c\u7684\u534f\u4f5c\u8005');
    return;
  }

  var loadBtn = document.getElementById('load-btn');
  var addBtn = document.getElementById('add-collab-btn');
  var updateBtn = document.getElementById('collab-batch-update-btn');
  var rmBtn = document.getElementById('collab-batch-remove-btn');
  if (loadBtn) loadBtn.disabled = true;
  if (addBtn) addBtn.disabled = true;
  if (updateBtn) updateBtn.disabled = true;
  if (rmBtn) rmBtn.disabled = true;
  setBatchLoading(true);
  switchTab('log'); clearLog();
  if (finalLogins.length !== logins.length) {
    appendLog('\u5df2\u5ffd\u7565 ' + (logins.length - finalLogins.length) + ' \u4f4d\u964d\u7ea7\u534f\u4f5c\u8005', 'info');
  }
  appendLog('\u5f00\u59cb\u6279\u91cf\u4fee\u6539\u6743\u9650: ' + permission + ' (' + finalLogins.length + ' \u4eba)', 'info');
  setStatus('\u6279\u91cf\u4fee\u6539\u6743\u9650\u4e2d\u2026 0/' + finalLogins.length);

  var ok = 0, fail = 0;
  try {
    for (var i = 0; i < finalLogins.length; i++) {
      setStatus('\u6279\u91cf\u4fee\u6539\u6743\u9650\u4e2d\u2026 ' + (i + 1) + '/' + finalLogins.length);
      try {
        await giteeApi('PUT', '/repos/' + state.currentRepo + '/collaborators/' + finalLogins[i], { permission: permission });
        appendLog('\u2713 ' + finalLogins[i], 'ok');
        ok++;
      } catch (e) {
        appendLog('\u2717 ' + finalLogins[i] + ': ' + e.message, 'err');
        fail++;
      }
    }
  } finally {
    setBatchLoading(false);
    if (loadBtn) loadBtn.disabled = false;
    if (addBtn) addBtn.disabled = false;
    if (updateBtn) updateBtn.disabled = false;
    if (rmBtn) rmBtn.disabled = false;
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u4fee\u6539\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
  state.selectedCollabs.clear();
  loadRepoDetail(state.currentRepo);
}

async function batchCollabRemove() {
  if (!state.currentRepo || state.selectedCollabs.size === 0) return;
  var logins = Array.from(state.selectedCollabs);
  var isSelf = state.currentUser && logins.some(function(l) { return l.toLowerCase() === state.currentUser.toLowerCase(); });
  var msg = isSelf
    ? '\u26d4 \u8b66\u544a\uff1a\u9009\u4e2d\u5217\u8868\u4e2d\u5305\u542b\u300a\u4f60\u81ea\u5df1\u300b\uff0c\u4f60\u5c06\u4ece ' + state.currentRepo + ' \u88ab\u79fb\u9664\uff01\n\n\u79fb\u9664\u540e\u65e0\u6cd5\u81ea\u884c\u6062\u590d\uff01\n\n\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f'
    : '\u786e\u5b9a\u4ece ' + state.currentRepo + ' \u79fb\u9664\u4ee5\u4e0b ' + logins.length + ' \u4f4d\u534f\u4f5c\u8005\uff1f\n\n' + logins.join(', ');
  if (!confirm(msg)) return;

  var loadBtn = document.getElementById('load-btn');
  var addBtn = document.getElementById('add-collab-btn');
  var updateBtn = document.getElementById('collab-batch-update-btn');
  var rmBtn = document.getElementById('collab-batch-remove-btn');
  if (loadBtn) loadBtn.disabled = true;
  if (addBtn) addBtn.disabled = true;
  if (updateBtn) updateBtn.disabled = true;
  if (rmBtn) rmBtn.disabled = true;
  setBatchLoading(true);
  switchTab('log'); clearLog();
  appendLog('\u5f00\u59cb\u6279\u91cf\u79fb\u9664: ' + logins.length + ' \u4eba', 'info');
  setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 0/' + logins.length);

  var ok = 0, fail = 0;
  try {
    for (var i = 0; i < logins.length; i++) {
      setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 ' + (i + 1) + '/' + logins.length);
      try {
        await giteeApi('DELETE', '/repos/' + state.currentRepo + '/collaborators/' + logins[i]);
        appendLog('\u2713 ' + logins[i], 'ok');
        ok++;
      } catch (e) {
        appendLog('\u2717 ' + logins[i] + ': ' + e.message, 'err');
        fail++;
      }
    }
  } finally {
    setBatchLoading(false);
    if (loadBtn) loadBtn.disabled = false;
    if (addBtn) addBtn.disabled = false;
    if (updateBtn) updateBtn.disabled = false;
    if (rmBtn) rmBtn.disabled = false;
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u79fb\u9664\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
  state.selectedCollabs.clear();
  loadRepoDetail(state.currentRepo);
}

// ============================================================
// Collaborator CRUD

async function updateCollabPermission(repoFullName, username, permission) {
  var permLabels = { pull: '只读', push: '读写', admin: '管理员' };
  var permLabel = permLabels[permission] || permission;
  var isSelf = !!(state.currentUser && username.toLowerCase() === state.currentUser.toLowerCase());
  var curLevel = getCurrentPermLevel(repoFullName, username);
  var newLevel = PERM_LEVEL[permission] !== undefined ? PERM_LEVEL[permission] : -1;
  var isDowngrade = curLevel >= 0 && curLevel > newLevel;

  if (isDowngrade) {
    var decision = await showDowngradeDecisionModal({
      mode: 'single',
      scope: '仓库',
      isSelf: isSelf,
      targetPermLabel: permLabel + '(' + permission + ')',
      headerText: '即将将 ' + username + ' 在 ' + repoFullName + ' 的权限修改为 ' + permLabel + '(' + permission + ')，将发生降级：',
      downgrades: [{
        title: repoFullName,
        sub: permLevelToLabel(curLevel) + ' → ' + permLabel + '(' + permission + ')',
      }],
      failed: [],
      safeCount: 0,
    });
    if (decision !== 'keep') {
      loadRepoDetail(repoFullName);
      return;
    }
  } else {
    var msg = isSelf
      ? '⚠️ 警告：你正在修改【自己】在 ' + repoFullName + ' 的权限为 ' + permLabel + '(' + permission + ')。\n\n确定要继续吗？'
      : '确定将 ' + username + ' 在 ' + repoFullName + ' 的权限修改为 ' + permLabel + '(' + permission + ')？';
    if (!confirm(msg)) {
      loadRepoDetail(repoFullName);
      return;
    }
  }

  setStatus('\u6b63\u5728\u66f4\u65b0 ' + username + ' \u5728 ' + repoFullName + ' \u7684\u6743\u9650\u2026');
  try {
    await giteeApi('PUT', '/repos/' + repoFullName + '/collaborators/' + username, { permission: permission });
    setStatus('\u5df2\u66f4\u65b0: ' + username + ' -> ' + permission);
    appendLog(repoFullName + ': ' + username + ' -> ' + permission, 'ok');
    // show operation log and refresh detail in background
    switchTab('log');
    loadRepoDetail(repoFullName);
  } catch (e) {
    setStatus('\u66f4\u65b0\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u66f4\u65b0 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
    switchTab('log');
    loadRepoDetail(repoFullName);
  }
}

async function removeCollab(repoFullName, username) {
  if (state.currentUser && username.toLowerCase() === state.currentUser.toLowerCase()) {
    if (!confirm('⛔ 警告：你正在将【自己】从 ' + repoFullName + ' 移除！\n\n移除后你将无法访问该仓库，且无法自行恢复！\n\n确定要继续吗？')) return;
  } else {
    if (!confirm('\u786e\u5b9a\u4ece ' + repoFullName + ' \u79fb\u9664 ' + username + '\uff1f')) return;
  }
  setStatus('\u6b63\u5728\u79fb\u9664 ' + username + '\u2026');
  try {
    await giteeApi('DELETE', '/repos/' + repoFullName + '/collaborators/' + username);
    setStatus('\u5df2\u79fb\u9664: ' + username);
    appendLog(repoFullName + ': \u5df2\u79fb\u9664 ' + username, 'ok');
    switchTab('log');
    loadRepoDetail(repoFullName);
  } catch (e) {
    setStatus('\u79fb\u9664\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u79fb\u9664 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
    switchTab('log');
    loadRepoDetail(repoFullName);
  }
}

function promptAddCollab() {
  if (!state.currentRepo) return;
  var overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  var modal = document.createElement('div'); modal.className = 'modal';
  var h3 = document.createElement('h3'); h3.textContent = '\u6dfb\u52a0\u534f\u4f5c\u8005'; modal.appendChild(h3);

  // Username with search
  var userLabel = document.createElement('label'); userLabel.textContent = '\u7528\u6237\u540d'; modal.appendChild(userLabel);
  var userWrap = document.createElement('div'); userWrap.className = 'user-search-wrap';
  var userInput = document.createElement('input'); userInput.type = 'text'; userInput.placeholder = '';
  var userDropdown = document.createElement('div'); userDropdown.className = 'user-dropdown';
  userWrap.appendChild(userInput);
  userWrap.appendChild(userDropdown);
  modal.appendChild(userWrap);
  setupUserSearch(userInput, userDropdown);

  // Permission select
  var permLabel = document.createElement('label'); permLabel.textContent = '\u6743\u9650'; modal.appendChild(permLabel);
  var permSelect = document.createElement('select');
  permSelect.innerHTML = '<option value="push">\u8bfb\u5199 (push)</option><option value="pull">\u53ea\u8bfb (pull)</option><option value="admin">\u7ba1\u7406\u5458 (admin)</option>';
  permSelect.value = 'push';
  modal.appendChild(permSelect);

  var actions = document.createElement('div'); actions.className = 'modal-actions';
  var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = '\u53d6\u6d88';
  cancelBtn.onclick = function() { overlay.remove(); };
  var confirmBtn = document.createElement('button'); confirmBtn.className = 'btn btn-primary'; confirmBtn.textContent = '\u786e\u8ba4';
  confirmBtn.onclick = async function() {
    var username = userInput.value.trim();
    var permission = permSelect.value;
    if (!username) { setStatus('\u8bf7\u8f93\u5165\u7528\u6237\u540d'); return; }
    var permLabels = { pull: '只读', push: '读写', admin: '管理员' };
    var permLabel = permLabels[permission] || permission;
    if (!confirm('确定将 ' + username + ' 以 ' + permLabel + '(' + permission + ') 权限添加到 ' + state.currentRepo + '？')) return;
    confirmBtn.disabled = true;
    try {
      await giteeApi('PUT', '/repos/' + state.currentRepo + '/collaborators/' + username, { permission: permission });
      appendLog(state.currentRepo + ': \u5df2\u6dfb\u52a0 ' + username + ' (' + permission + ')', 'ok');
      overlay.remove();
      // show logs and refresh detail
      switchTab('log');
      loadRepoDetail(state.currentRepo);
    } catch (e) {
      setStatus('\u64cd\u4f5c\u5931\u8d25: ' + e.message);
      appendLog('\u64cd\u4f5c\u5931\u8d25: ' + e.message, 'err');
      confirmBtn.disabled = false;
    }
  };
  actions.appendChild(cancelBtn); actions.appendChild(confirmBtn); modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modal-container').appendChild(overlay);
  setTimeout(function() { userInput.focus(); }, 50);
}

// ============================================================
// Batch operations

export { updateDetailPermBadges, loadRepoDetail, renderCollabList, updateCollabBatchBar, toggleSelectAllCollabs, batchCollabUpdatePerm, batchCollabRemove, updateCollabPermission, removeCollab, promptAddCollab };
