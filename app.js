// ============================================================
// Gitee Repo Permission Manager - app.js
// ============================================================

const STORAGE_KEY = 'gitee_perm_config';
let allRepos = [];
let selectedRepos = new Set();
let currentRepo = null;
let collapsedGroups = new Set();
let currentCollabs = []; // cached collaborators for current repo
let currentUser = '';   // logged-in username

function getConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    stored.token = sessionStorage.getItem('gitee_perm_token') || '';
    return stored;
  } catch { return {}; }
}
function setConfig(c) {
  sessionStorage.setItem('gitee_perm_token', c.token || '');
  const toStore = { ...c }; delete toStore.token;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
}

(function init() {
  const c = getConfig();
  document.getElementById('token-input').value = c.token || '';
  document.getElementById('batch-user').value = c.lastUser || '';
})();

function toggleTokenVisibility() {
  const el = document.getElementById('token-input');
  el.type = el.type === 'password' ? 'text' : 'password';
}

function setStatus(msg, right) {
  document.getElementById('status-left').textContent = msg;
  if (right !== undefined) document.getElementById('status-right').textContent = right;
}

function appendLog(msg, type) {
  type = type || 'info';
  const panel = document.getElementById('log-panel');
  const div = document.createElement('div');
  div.className = 'log-' + type;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

function clearLog() {
  document.getElementById('log-panel').innerHTML = '';
}

function getToken() {
  return document.getElementById('token-input').value.trim();
}

async function giteeApi(method, path, body) {
  const token = getToken();
  if (!token) throw new Error('\u8bf7\u5148\u8f93\u5165 Token');
  const url = new URL('https://gitee.com/api/v5' + path);
  const opts = { method, headers: {} };
  if (method === 'GET') {
    url.searchParams.set('access_token', token);
  } else {
    opts.headers['Content-Type'] = 'application/json';
    body = body || {};
    body.access_token = token;
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url.toString(), opts);
  if (r.status === 204) return null;
  const data = await r.json().catch(function() { return {}; });
  if (!r.ok) throw new Error('API ' + r.status + ': ' + (data.message || r.statusText));
  return data;
}

async function giteeApiFetchAll(path) {
  const results = []; let page = 1;
  while (page <= 100) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await giteeApi('GET', path + sep + 'per_page=100&page=' + page);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ============================================================
// Load repos
// ============================================================
async function loadAllRepos() {
  const token = getToken();
  if (!token) { setStatus('\u8bf7\u8f93\u5165 Token'); return; }
  setConfig({ token, lastUser: document.getElementById('batch-user').value.trim() });
  const btn = document.getElementById('load-btn');
  btn.disabled = true; btn.textContent = '\u52a0\u8f7d\u4e2d\u2026';
  setStatus('\u6b63\u5728\u52a0\u8f7d\u4ed3\u5e93\u5217\u8868\u2026');
  allRepos = []; selectedRepos.clear(); currentRepo = null;

  try {
    const user = await giteeApi('GET', '/user');
    currentUser = user.login;
    // Show current user in topbar
    var userDisplay = document.getElementById('current-user-display');
    var userNameEl = document.getElementById('current-user-name');
    var userAvatarEl = document.getElementById('current-user-avatar');
    if (userDisplay && userNameEl) {
      userNameEl.textContent = user.login;
      if (userAvatarEl && user.avatar_url) {
        userAvatarEl.src = user.avatar_url;
        userAvatarEl.onerror = function() { userAvatarEl.style.display = 'none'; };
      }
      userDisplay.style.display = 'flex';
    }
    setStatus('\u6b63\u5728\u52a0\u8f7d ' + user.login + ' \u7684\u4ed3\u5e93\u2026', user.login);

    const includeOrg = document.getElementById('org-toggle').checked;
    // type=personal: only user's own repos; type=all: includes org repos
    const repoType = includeOrg ? 'all' : 'personal';
    const ownRepos = await giteeApiFetchAll('/user/repos?type=' + repoType + '&sort=full_name');

    // If including orgs, also fetch repos from each org (catches repos not returned by /user/repos)
    let orgRepos = [];
    if (includeOrg) {
      const orgs = await giteeApiFetchAll('/user/orgs');
      for (const org of orgs) {
        setStatus('\u6b63\u5728\u52a0\u8f7d\u7ec4\u7ec7: ' + org.login + '\u2026');
        try {
          const repos = await giteeApiFetchAll('/orgs/' + org.login + '/repos?type=all');
          orgRepos.push(...repos);
        } catch (e) {
          appendLog('\u52a0\u8f7d\u7ec4\u7ec7 ' + org.login + ' \u5931\u8d25: ' + e.message, 'err');
        }
      }
    }

    const seen = new Set();
    const merged = [];
    var allRaw = ownRepos.concat(orgRepos);
    for (var i = 0; i < allRaw.length; i++) {
      var r = allRaw[i];
      if (seen.has(r.full_name)) continue;
      seen.add(r.full_name);
      merged.push({
        full_name: r.full_name,
        name: r.name,
        owner: (r.owner && r.owner.login) || r.full_name.split('/')[0],
        permission: r.permission || {},
        html_url: r.html_url,
        description: r.description || '',
        isPrivate: !!r.private,
      });
    }

    const needPerm = merged.filter(function(r) { return !r.permission || Object.keys(r.permission).length === 0; });
    if (needPerm.length > 0) {
      setStatus('\u6b63\u5728\u83b7\u53d6 ' + needPerm.length + ' \u4e2a\u4ed3\u5e93\u7684\u6743\u9650\u4fe1\u606f\u2026');
      for (var j = 0; j < needPerm.length; j++) {
        try {
          const detail = await giteeApi('GET', '/repos/' + needPerm[j].full_name);
          needPerm[j].permission = detail.permission || {};
        } catch (e) { /* skip */ }
      }
    }

    allRepos = merged.sort(function(a, b) { return a.full_name.localeCompare(b.full_name); });
    setStatus('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93', user.login);
    appendLog('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93', 'ok');
    renderRepoList();
  } catch (e) {
    setStatus('\u52a0\u8f7d\u5931\u8d25: ' + e.message);
    appendLog('\u52a0\u8f7d\u5931\u8d25: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '\u52a0\u8f7d\u4ed3\u5e93';
  }
}

// ============================================================
// Repo list rendering
// ============================================================
function getPermGroup(repo) {
  const p = repo.permission || {};
  if (p.admin) return 'admin';
  if (p.push) return 'push';
  return 'pull';
}

function renderRepoList() {
  const container = document.getElementById('repo-list');
  container.innerHTML = '';
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();

  const groups = { admin: [], push: [], pull: [] };
  for (var i = 0; i < allRepos.length; i++) {
    var r = allRepos[i];
    if (filter && r.full_name.toLowerCase().indexOf(filter) === -1) continue;
    groups[getPermGroup(r)].push(r);
  }

  const GROUP_META = [
    { key: 'admin', label: '\u7ba1\u7406\u5458', cls: 'admin' },
    { key: 'push',  label: '\u8bfb\u5199', cls: 'push' },
    { key: 'pull',  label: '\u53ea\u8bfb', cls: 'pull' },
  ];

  let totalVisible = 0;
  for (var g = 0; g < GROUP_META.length; g++) {
    var gm = GROUP_META[g];
    var repos = groups[gm.key];
    if (repos.length === 0) continue;
    totalVisible += repos.length;

    const header = document.createElement('div');
    header.className = 'group-header';
    var toggleChar = collapsedGroups.has(gm.key) ? '\u25B6' : '\u25BC';
    header.innerHTML = '<span class="toggle">' + toggleChar + '</span>' +
      '<span class="badge ' + gm.cls + '">' + gm.label + '</span>' +
      '<span class="count">(' + repos.length + ')</span>';
    (function(key) {
      header.onclick = function() {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        renderRepoList();
      };
    })(gm.key);
    container.appendChild(header);

    if (!collapsedGroups.has(gm.key)) {
      for (var ri = 0; ri < repos.length; ri++) {
        (function(repo) {
          const div = document.createElement('div');
          div.className = 'repo-item' + (currentRepo === repo.full_name ? ' selected' : '');

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selectedRepos.has(repo.full_name);
          cb.onclick = function(e) {
            e.stopPropagation();
            if (cb.checked) selectedRepos.add(repo.full_name);
            else selectedRepos.delete(repo.full_name);
          };

          const nameSpan = document.createElement('span');
          nameSpan.className = 'repo-name';
          nameSpan.textContent = repo.full_name;

          const lockIcon = document.createElement('span');
          lockIcon.className = 'lock-icon';
          lockIcon.textContent = repo.isPrivate ? '\uD83D\uDD12' : '';

          div.appendChild(cb);
          div.appendChild(nameSpan);
          div.appendChild(lockIcon);
          div.onclick = function(e) {
            if (e.target === cb) return;
            currentRepo = repo.full_name;
            renderRepoList();
            loadRepoDetail(repo.full_name);
            if (window.innerWidth <= 768) switchMobileTab('detail');
          };
          container.appendChild(div);
        })(repos[ri]);
      }
    }
  }

  document.getElementById('repo-count').textContent = totalVisible > 0 ? '(' + totalVisible + ')' : '';
}

document.getElementById('repo-search').addEventListener('input', function() { renderRepoList(); });

function selectAllVisible() {
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();
  for (var i = 0; i < allRepos.length; i++) {
    if (!filter || allRepos[i].full_name.toLowerCase().indexOf(filter) !== -1) {
      selectedRepos.add(allRepos[i].full_name);
    }
  }
  renderRepoList();
}

function deselectAll() {
  selectedRepos.clear();
  renderRepoList();
}

// ============================================================
// Repo detail & collaborators
// ============================================================
async function loadRepoDetail(fullName) {
  document.getElementById('detail-placeholder').style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';
  document.getElementById('detail-repo-name').textContent = fullName;

  const repo = allRepos.find(function(r) { return r.full_name === fullName; });
  const badges = document.getElementById('detail-badges');
  badges.innerHTML = '';

  if (repo) {
    const p = repo.permission || {};
    const items = [
      { label: 'admin', val: !!p.admin, color: 'var(--primary)' },
      { label: 'push', val: !!p.push, color: 'var(--success)' },
      { label: 'pull', val: !!p.pull, color: 'var(--text3)' },
    ];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      const span = document.createElement('span');
      span.className = 'perm-badge' + (item.val ? ' perm-on' : ' perm-off');
      span.style.background = item.val ? item.color : '#ddd';
      span.textContent = item.label + ': ' + (item.val ? '\u2713' : '\u2717');
      badges.appendChild(span);
    }
    if (repo.isPrivate) {
      const span = document.createElement('span');
      span.className = 'perm-badge perm-on';
      span.style.background = 'var(--warning)';
      span.textContent = '\uD83D\uDD12 \u79c1\u6709';
      badges.appendChild(span);
    }
    if (repo.html_url) {
      const a = document.createElement('a');
      a.href = repo.html_url; a.target = '_blank';
      a.className = 'repo-link';
      a.textContent = '\u2197 \u6253\u5f00 Gitee';
      badges.appendChild(a);
    }
  }

  const collabList = document.getElementById('collab-list');
  collabList.innerHTML = '<div class="loading-text">\u52a0\u8f7d\u4e2d\u2026</div>';
  // Reset search
  var collabSearchEl = document.getElementById('collab-search');
  if (collabSearchEl) collabSearchEl.value = '';

  // Enable/disable add button based on admin permission
  var addBtn = document.getElementById('add-collab-btn');
  if (addBtn) {
    var isAdmin = repo && repo.permission && repo.permission.admin;
    addBtn.disabled = !isAdmin;
    addBtn.title = isAdmin ? '' : '需要管理员权限才能添加协作者';
  }

  try {
    const collabs = await giteeApiFetchAll('/repos/' + fullName + '/collaborators');
    currentCollabs = collabs;
    renderCollabList('');
  } catch (e) {
    currentCollabs = [];
    collabList.innerHTML = '<div class="err-text">\u52a0\u8f7d\u5931\u8d25: ' + e.message + '</div>';
  }
}

function renderCollabList(filter) {
  var fullName = currentRepo;
  var collabList = document.getElementById('collab-list');
  collabList.innerHTML = '';
  filter = (filter || '').trim().toLowerCase();

  var filtered = currentCollabs;
  if (filter) {
    filtered = currentCollabs.filter(function(c) {
      var login = (c.login || '').toLowerCase();
      var name = (c.name || '').toLowerCase();
      return login.indexOf(filter) !== -1 || name.indexOf(filter) !== -1;
    });
  }

  // Update count
  var countEl = document.getElementById('collab-count');
  if (countEl) {
    if (filter && filtered.length !== currentCollabs.length) {
      countEl.textContent = '(' + filtered.length + '/' + currentCollabs.length + ')';
    } else {
      countEl.textContent = currentCollabs.length > 0 ? '(' + currentCollabs.length + ')' : '';
    }
  }

  if (currentCollabs.length === 0) {
    collabList.innerHTML = '<div class="loading-text">\u6682\u65e0\u534f\u4f5c\u8005</div>';
    return;
  }

  if (filtered.length === 0) {
    collabList.innerHTML = '<div class="loading-text">\u672a\u627e\u5230\u5339\u914d\u7684\u534f\u4f5c\u8005</div>';
    return;
  }

  for (var ci = 0; ci < filtered.length; ci++) {
    (function(c) {
      const div = document.createElement('div');
      div.className = 'collab-item';

      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = c.avatar_url || '';
      avatar.onerror = function() { avatar.style.display = 'none'; };

      const info = document.createElement('div');
      info.className = 'collab-info';
      info.innerHTML = '<div class="collab-name">' + (c.name || c.login) + '</div><div class="collab-login">@' + c.login + '</div>';

      // Check if current user has admin permission on this repo
      var repo = allRepos.find(function(r) { return r.full_name === fullName; });
      var isAdmin = repo && repo.permission && repo.permission.admin;

      const permSelect = document.createElement('select');
      permSelect.innerHTML = '<option value="pull">\u53ea\u8bfb</option><option value="push">\u8bfb\u5199</option><option value="admin">\u7ba1\u7406\u5458</option>';
      const cp = c.permissions || c.permission || {};
      if (cp.admin) permSelect.value = 'admin';
      else if (cp.push) permSelect.value = 'push';
      else permSelect.value = 'pull';
      if (!isAdmin) {
        permSelect.disabled = true;
        permSelect.title = '需要管理员权限才能修改';
      } else {
        permSelect.onchange = function() { updateCollabPermission(fullName, c.login, permSelect.value); };
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger btn-sm';
      removeBtn.textContent = '\u79fb\u9664';
      if (!isAdmin) {
        removeBtn.disabled = true;
        removeBtn.title = '需要管理员权限才能移除';
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
}

// ============================================================
// Collaborator CRUD
// ============================================================
var PERM_LEVEL = { pull: 0, push: 1, admin: 2 };

function getCurrentPermLevel(repoFullName, username) {
  // Look up from cached collaborators
  var collab = currentCollabs.find(function(c) {
    return c.login && c.login.toLowerCase() === username.toLowerCase();
  });
  if (collab) {
    var cp = collab.permissions || collab.permission || {};
    if (cp.admin) return 2;
    if (cp.push) return 1;
    return 0;
  }
  return -1; // unknown
}

async function updateCollabPermission(repoFullName, username, permission) {
  // Check admin permission
  var repo = allRepos.find(function(r) { return r.full_name === repoFullName; });
  if (!repo || !repo.permission || !repo.permission.admin) {
    setStatus('无权操作：你不是 ' + repoFullName + ' 的管理员');
    appendLog(repoFullName + ': 无管理员权限，无法修改协作者', 'err');
    return;
  }

  var permLabels = { pull: '只读', push: '读写', admin: '管理员' };
  var permLabel = permLabels[permission] || permission;

  // Detect self-modification with stronger warning
  if (currentUser && username.toLowerCase() === currentUser.toLowerCase()) {
    var curLevel = getCurrentPermLevel(repoFullName, username);
    var newLevel = PERM_LEVEL[permission] !== undefined ? PERM_LEVEL[permission] : -1;
    var isDemotion = curLevel > newLevel;

    var msg = '⚠️ 警告：你正在修改【自己】在 ' + repoFullName + ' 的权限为 ' + permLabel + '(' + permission + ')！\n\n';
    if (isDemotion) {
      msg += '⛔ 这是一个降级操作！降级后你可能无法恢复自己的权限！\n\n确定要继续吗？';
    } else {
      msg += '确定要继续吗？';
    }
    if (!confirm(msg)) {
      loadRepoDetail(repoFullName);
      return;
    }
  } else {
    if (!confirm('确定将 ' + username + ' 在 ' + repoFullName + ' 的权限修改为 ' + permLabel + '(' + permission + ')？')) {
      loadRepoDetail(repoFullName);
      return;
    }
  }

  setStatus('\u6b63\u5728\u66f4\u65b0 ' + username + ' \u5728 ' + repoFullName + ' \u7684\u6743\u9650\u2026');
  try {
    await giteeApi('PUT', '/repos/' + repoFullName + '/collaborators/' + username, { permission: permission });
    setStatus('\u5df2\u66f4\u65b0: ' + username + ' -> ' + permission);
    appendLog(repoFullName + ': ' + username + ' -> ' + permission, 'ok');
  } catch (e) {
    setStatus('\u66f4\u65b0\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u66f4\u65b0 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
    loadRepoDetail(repoFullName);
  }
}

async function removeCollab(repoFullName, username) {
  // Check admin permission
  var repo = allRepos.find(function(r) { return r.full_name === repoFullName; });
  if (!repo || !repo.permission || !repo.permission.admin) {
    setStatus('无权操作：你不是 ' + repoFullName + ' 的管理员');
    appendLog(repoFullName + ': 无管理员权限，无法移除协作者', 'err');
    return;
  }

  if (currentUser && username.toLowerCase() === currentUser.toLowerCase()) {
    if (!confirm('⛔ 警告：你正在将【自己】从 ' + repoFullName + ' 移除！\n\n移除后你将无法访问该仓库，且无法自行恢复！\n\n确定要继续吗？')) return;
  } else {
    if (!confirm('\u786e\u5b9a\u4ece ' + repoFullName + ' \u79fb\u9664 ' + username + '\uff1f')) return;
  }
  setStatus('\u6b63\u5728\u79fb\u9664 ' + username + '\u2026');
  try {
    await giteeApi('DELETE', '/repos/' + repoFullName + '/collaborators/' + username);
    setStatus('\u5df2\u79fb\u9664: ' + username);
    appendLog(repoFullName + ': \u5df2\u79fb\u9664 ' + username, 'ok');
    loadRepoDetail(repoFullName);
  } catch (e) {
    setStatus('\u79fb\u9664\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u79fb\u9664 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
  }
}

function promptAddCollab() {
  if (!currentRepo) return;
  // Check admin permission
  var repo = allRepos.find(function(r) { return r.full_name === currentRepo; });
  if (!repo || !repo.permission || !repo.permission.admin) {
    setStatus('无权操作：你不是 ' + currentRepo + ' 的管理员');
    return;
  }
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
    if (!confirm('确定将 ' + username + ' 以 ' + permLabel + '(' + permission + ') 权限添加到 ' + currentRepo + '？')) return;
    try {
      await giteeApi('PUT', '/repos/' + currentRepo + '/collaborators/' + username, { permission: permission });
      appendLog(currentRepo + ': \u5df2\u6dfb\u52a0 ' + username + ' (' + permission + ')', 'ok');
      overlay.remove();
      loadRepoDetail(currentRepo);
    } catch (e) {
      setStatus('\u64cd\u4f5c\u5931\u8d25: ' + e.message);
      appendLog('\u64cd\u4f5c\u5931\u8d25: ' + e.message, 'err');
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
// ============================================================
async function batchAddCollab() {
  const username = document.getElementById('batch-user').value.trim();
  const permission = document.getElementById('batch-perm').value;
  if (!username) { setStatus('\u8bf7\u8f93\u5165\u7528\u6237\u540d'); return; }
  if (selectedRepos.size === 0) { setStatus('\u8bf7\u5148\u9009\u62e9\u4ed3\u5e93'); return; }
  setConfig({ token: getToken(), lastUser: username });

  const allSelected = Array.from(selectedRepos);
  // Filter to repos where current user has admin permission
  var repos = allSelected.filter(function(fn) {
    var r = allRepos.find(function(x) { return x.full_name === fn; });
    return r && r.permission && r.permission.admin;
  });
  var skipped = allSelected.length - repos.length;
  if (repos.length === 0) {
    setStatus('所选仓库中没有你拥有管理员权限的仓库');
    if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个无管理员权限的仓库', 'err');
    return;
  }

  var isSelf = currentUser && username.toLowerCase() === currentUser.toLowerCase();
  var confirmMsg;
  if (isSelf) {
    var newLevel = PERM_LEVEL[permission] !== undefined ? PERM_LEVEL[permission] : -1;
    var demotionCount = 0;
    for (var di = 0; di < repos.length; di++) {
      var repo = allRepos.find(function(r) { return r.full_name === repos[di]; });
      if (repo) {
        var rp = repo.permission || {};
        var curLvl = rp.admin ? 2 : rp.push ? 1 : 0;
        if (curLvl > newLevel) demotionCount++;
      }
    }
    if (demotionCount > 0) {
      confirmMsg = '⚠️ 警告：你正在批量修改【自己】在 ' + repos.length + ' 个仓库的权限为 ' + permission + '！\n\n⛔ 其中 ' + demotionCount + ' 个仓库是降级操作，降级后你可能无法恢复权限！\n\n确定要继续吗？';
    } else {
      confirmMsg = '你正在批量修改【自己】在 ' + repos.length + ' 个仓库的权限为 ' + permission + '，确定要继续吗？';
    }
  } else {
    confirmMsg = '\u786e\u5b9a\u4e3a ' + username + ' \u6dfb\u52a0 ' + permission + ' \u6743\u9650\u5230 ' + repos.length + ' \u4e2a\u4ed3\u5e93\uff1f';
  }
  if (skipped > 0) confirmMsg += '\n\n（已自动跳过 ' + skipped + ' 个无管理员权限的仓库）';
  if (!confirm(confirmMsg)) return;

  clearLog();
  switchTab('log');
  if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个无管理员权限的仓库', 'info');
  appendLog('\u5f00\u59cb\u6279\u91cf\u6dfb\u52a0: ' + username + ' -> ' + permission + ' (' + repos.length + ' \u4e2a\u4ed3\u5e93)', 'info');
  setStatus('\u6279\u91cf\u6dfb\u52a0\u4e2d\u2026 0/' + repos.length);

  let ok = 0, fail = 0;
  for (let i = 0; i < repos.length; i++) {
    setStatus('\u6279\u91cf\u6dfb\u52a0\u4e2d\u2026 ' + (i + 1) + '/' + repos.length, repos[i]);
    try {
      await giteeApi('PUT', '/repos/' + repos[i] + '/collaborators/' + username, { permission: permission });
      appendLog('\u2713 ' + repos[i], 'ok');
      ok++;
    } catch (e) {
      appendLog('\u2717 ' + repos[i] + ': ' + e.message, 'err');
      fail++;
    }
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u6dfb\u52a0\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
}

async function batchRemoveCollab() {
  const username = document.getElementById('batch-user').value.trim();
  if (!username) { setStatus('\u8bf7\u8f93\u5165\u7528\u6237\u540d'); return; }
  if (selectedRepos.size === 0) { setStatus('\u8bf7\u5148\u9009\u62e9\u4ed3\u5e93'); return; }

  const allSelected = Array.from(selectedRepos);
  var repos = allSelected.filter(function(fn) {
    var r = allRepos.find(function(x) { return x.full_name === fn; });
    return r && r.permission && r.permission.admin;
  });
  var skipped = allSelected.length - repos.length;
  if (repos.length === 0) {
    setStatus('所选仓库中没有你拥有管理员权限的仓库');
    if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个无管理员权限的仓库', 'err');
    return;
  }

  var isSelf = currentUser && username.toLowerCase() === currentUser.toLowerCase();
  var confirmMsg;
  if (isSelf) {
    confirmMsg = '⛔ 警告：你正在批量将【自己】从 ' + repos.length + ' 个仓库移除！\n\n移除后你将无法访问这些仓库，且无法自行恢复！\n\n确定要继续吗？';
  } else {
    confirmMsg = '\u786e\u5b9a\u4ece ' + repos.length + ' \u4e2a\u4ed3\u5e93\u79fb\u9664 ' + username + '\uff1f';
  }
  if (skipped > 0) confirmMsg += '\n\n（已自动跳过 ' + skipped + ' 个无管理员权限的仓库）';
  if (!confirm(confirmMsg)) return;

  clearLog();
  switchTab('log');
  if (skipped > 0) appendLog('已跳过 ' + skipped + ' 个无管理员权限的仓库', 'info');
  appendLog('\u5f00\u59cb\u6279\u91cf\u79fb\u9664: ' + username + ' (' + repos.length + ' \u4e2a\u4ed3\u5e93)', 'info');
  setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 0/' + repos.length);

  let ok = 0, fail = 0;
  for (let i = 0; i < repos.length; i++) {
    setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 ' + (i + 1) + '/' + repos.length, repos[i]);
    try {
      await giteeApi('DELETE', '/repos/' + repos[i] + '/collaborators/' + username);
      appendLog('\u2713 ' + repos[i], 'ok');
      ok++;
    } catch (e) {
      appendLog('\u2717 ' + repos[i] + ': ' + e.message, 'err');
      fail++;
    }
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u79fb\u9664\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
}

// ============================================================
// Tabs
// ============================================================
function switchTab(tab) {
  document.getElementById('tab-detail').style.display = tab === 'detail' ? '' : 'none';
  document.getElementById('tab-log').style.display = tab === 'log' ? '' : 'none';
  const btns = document.querySelectorAll('#tab-bar button');
  btns[0].classList.toggle('active', tab === 'detail');
  btns[1].classList.toggle('active', tab === 'log');
  // On mobile, also switch the mobile tab
  if (window.innerWidth <= 768) {
    var mobileTab = tab === 'log' ? 'log' : 'detail';
    var sidebar = document.getElementById('repos-panel');
    var content = document.querySelector('.content');
    if (sidebar) sidebar.classList.remove('mobile-visible');
    if (content) content.classList.add('mobile-visible');
    var mbtns = document.querySelectorAll('#mobile-tabs button');
    for (var i = 0; i < mbtns.length; i++) mbtns[i].classList.remove('active');
    var idx = { detail: 1, log: 2 };
    if (mbtns[idx[mobileTab]]) mbtns[idx[mobileTab]].classList.add('active');
  }
}

// ============================================================
// Modal helper
// ============================================================
function showModal(title, inputs, selects, onConfirm) {
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  const modal = document.createElement('div'); modal.className = 'modal';
  const h3 = document.createElement('h3'); h3.textContent = title; modal.appendChild(h3);
  const fields = {};

  for (var i = 0; i < inputs.length; i++) {
    var f = inputs[i];
    const label = document.createElement('label'); label.textContent = f.label; modal.appendChild(label);
    const input = document.createElement('input'); input.type = 'text'; input.value = f.value || ''; input.placeholder = f.placeholder || '';
    fields[f.key] = input; modal.appendChild(input);
  }

  var sels = selects || [];
  for (var si = 0; si < sels.length; si++) {
    var s = sels[si];
    const label = document.createElement('label'); label.textContent = s.label; modal.appendChild(label);
    const select = document.createElement('select');
    for (var oi = 0; oi < s.options.length; oi++) {
      const o = document.createElement('option'); o.value = s.options[oi].value; o.textContent = s.options[oi].text; select.appendChild(o);
    }
    if (s.defaultValue) select.value = s.defaultValue;
    fields[s.key] = select; modal.appendChild(select);
  }

  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn-ghost'; cancelBtn.textContent = '\u53d6\u6d88';
  cancelBtn.onclick = function() { overlay.remove(); };
  const confirmBtn = document.createElement('button'); confirmBtn.className = 'btn btn-primary'; confirmBtn.textContent = '\u786e\u8ba4';
  confirmBtn.onclick = async function() {
    const values = {};
    for (const k in fields) values[k] = fields[k].value.trim();
    try { await onConfirm(values); overlay.remove(); }
    catch (e) { setStatus('\u64cd\u4f5c\u5931\u8d25: ' + e.message); appendLog('\u64cd\u4f5c\u5931\u8d25: ' + e.message, 'err'); }
  };
  actions.appendChild(cancelBtn); actions.appendChild(confirmBtn); modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modal-container').appendChild(overlay);
  var first = null;
  for (var k in fields) { first = fields[k]; break; }
  if (first) setTimeout(function() { first.focus(); }, 50);
}

document.getElementById('token-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') loadAllRepos();
});

// Collab search filter
(function() {
  var el = document.getElementById('collab-search');
  if (el) {
    el.addEventListener('input', function() {
      renderCollabList(el.value);
    });
  }
})();

// ============================================================
// User search (autocomplete via Gitee search API)
// ============================================================
var _userSearchTimer = null;
var _userSearchCache = {};

function setupUserSearch(inputEl, dropdownEl) {
  inputEl.addEventListener('input', function() {
    clearTimeout(_userSearchTimer);
    var q = inputEl.value.trim();
    if (q.length < 2) { closeUserDropdown(dropdownEl); return; }
    _userSearchTimer = setTimeout(function() { doUserSearch(q, dropdownEl, inputEl); }, 300);
  });
  inputEl.addEventListener('focus', function() {
    var q = inputEl.value.trim();
    if (q.length >= 2) doUserSearch(q, dropdownEl, inputEl);
  });
  inputEl.addEventListener('blur', function() {
    setTimeout(function() { closeUserDropdown(dropdownEl); }, 200);
  });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeUserDropdown(dropdownEl);
  });
}

async function doUserSearch(query, dropdownEl, inputEl) {
  if (_userSearchCache[query]) {
    renderUserDropdown(_userSearchCache[query], dropdownEl, inputEl);
    return;
  }
  dropdownEl.innerHTML = '<div class="user-dropdown-hint">\u641c\u7d22\u4e2d\u2026</div>';
  dropdownEl.classList.add('open');
  try {
    var token = getToken();
    if (!token) return;
    var url = 'https://gitee.com/api/v5/search/users?access_token=' + encodeURIComponent(token) + '&q=' + encodeURIComponent(query) + '&per_page=10';
    var r = await fetch(url);
    if (!r.ok) throw new Error('API ' + r.status);
    var data = await r.json();
    _userSearchCache[query] = data;
    renderUserDropdown(data, dropdownEl, inputEl);
  } catch (e) {
    dropdownEl.innerHTML = '<div class="user-dropdown-hint">\u641c\u7d22\u5931\u8d25</div>';
  }
}

function renderUserDropdown(users, dropdownEl, inputEl) {
  dropdownEl.innerHTML = '';
  if (!users || users.length === 0) {
    dropdownEl.innerHTML = '<div class="user-dropdown-hint">\u672a\u627e\u5230\u7528\u6237</div>';
    dropdownEl.classList.add('open');
    return;
  }
  for (var i = 0; i < users.length; i++) {
    (function(u) {
      var div = document.createElement('div');
      div.className = 'user-dropdown-item';
      var img = document.createElement('img');
      img.src = u.avatar_url || '';
      img.onerror = function() { img.style.display = 'none'; };
      var info = document.createElement('div');
      info.innerHTML = '<div class="ud-name">' + (u.name || u.login) + '</div><div class="ud-login">@' + u.login + '</div>';
      div.appendChild(img);
      div.appendChild(info);
      div.addEventListener('mousedown', function(e) {
        e.preventDefault();
        inputEl.value = u.login;
        closeUserDropdown(dropdownEl);
      });
      dropdownEl.appendChild(div);
    })(users[i]);
  }
  dropdownEl.classList.add('open');
}

function closeUserDropdown(dropdownEl) {
  dropdownEl.classList.remove('open');
}

// Attach to batch-user input
(function() {
  var batchInput = document.getElementById('batch-user');
  var batchDropdown = document.getElementById('batch-user-dropdown');
  if (batchInput && batchDropdown) setupUserSearch(batchInput, batchDropdown);
})();

// ============================================================
// Mobile tab switching
// ============================================================
function switchMobileTab(tab) {
  var sidebar = document.getElementById('repos-panel');
  var content = document.querySelector('.content');

  // Remove mobile-visible from all
  if (sidebar) sidebar.classList.remove('mobile-visible');
  if (content) content.classList.remove('mobile-visible');

  if (tab === 'repos') {
    if (sidebar) sidebar.classList.add('mobile-visible');
  } else if (tab === 'detail') {
    if (content) content.classList.add('mobile-visible');
    switchTab('detail');
  } else if (tab === 'log') {
    if (content) content.classList.add('mobile-visible');
    switchTab('log');
  }

  // Update tab buttons
  var btns = document.querySelectorAll('#mobile-tabs button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  var idx = { repos: 0, detail: 1, log: 2 };
  if (btns[idx[tab]]) btns[idx[tab]].classList.add('active');
}

// Initialize mobile: show repos tab by default
(function() {
  if (window.innerWidth <= 768) {
    switchMobileTab('repos');
  }
})();
