// ============================================================
// Gitee Repo Permission Manager - app.js
// ============================================================

let allRepos = [];
let selectedRepos = new Set();
let currentRepo = null;
let collapsedGroups = new Set();
let currentCollabs = [];
let currentCollabsRepo = null;
let selectedCollabs = new Set();
let currentUser = '';
let currentSubmodules = [];
let currentSubmodulesRepo = null;
let _loadGeneration = 0;
let _userSearchCache = {};

(function init() {
  var saved = localStorage.getItem('gitee_perm_token') || '';
  if (saved) document.getElementById('token-input').value = saved;
  document.getElementById('batch-user').value = '';
})();

function toggleTokenVisibility() {
  const el = document.getElementById('token-input');
  el.type = el.type === 'password' ? 'text' : 'password';
}

function rememberToken() {
  var token = document.getElementById('token-input').value.trim();
  if (!token) { setStatus('请先输入 Token'); return; }
  localStorage.setItem('gitee_perm_token', token);
  setStatus('Token 已保存到本地缓存');
}

function clearTokenCache() {
  localStorage.removeItem('gitee_perm_token');
  sessionStorage.removeItem('gitee_perm_token');
  document.getElementById('token-input').value = '';
  setStatus('Token 缓存已清除');
}

function setStatus(msg) {
  document.getElementById('status-left').textContent = msg;
}

function hoverShow(name, url) {
  document.getElementById('status-right').textContent = name + (url ? ' (' + url + ')' : '');
}
function hoverClear() {
  document.getElementById('status-right').textContent = '';
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
  const opts = { method, headers: { 'Authorization': 'Bearer ' + token } };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
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

function extractRepoFullNamesFromText(text) {
  if (!text) return [];
  const repos = [];
  const re = /(?:https?:\/\/|git@|ssh:\/\/git@|git:\/\/)?(?:gitee\.com|gitee\.cn)[:\/]([^\/\s#?]+)\/([^\/\s#?"'<>]+?)(?:\.git)?(?=[\/\s#?"'<>]|$)/ig;
  let match = null;
  while ((match = re.exec(text)) !== null) {
    const owner = (match[1] || '').trim();
    const name = (match[2] || '').trim().replace(/\.git$/, '');
    if (!owner || !name) continue;
    repos.push(owner + '/' + name);
  }
  return Array.from(new Set(repos));
}

function repoMatchesFilter(repo, filter) {
  const keyword = (filter || '').trim().toLowerCase();
  if (!keyword) return true;
  return (repo.full_name || '').toLowerCase().indexOf(keyword) !== -1 ||
    (repo.html_url || '').toLowerCase().indexOf(keyword) !== -1;
}

function getRepoPermissionState(repo) {
  if (!repo || !repo.permissionLoaded) return 'loading';
  if (repo.permissionError) return 'failed';
  const permission = repo.permission || {};
  if (permission.admin) return 'admin';
  if (permission.push) return 'push';
  if (permission.pull) return 'pull';
  return 'unauthorized';
}

function canSelectRepo(repo) {
  const state = getRepoPermissionState(repo);
  return state === 'admin' || state === 'push' || state === 'pull';
}

function shouldClearRepoSelection(repo) {
  const state = getRepoPermissionState(repo);
  return state === 'unauthorized' || state === 'failed';
}

function getRepoSelectionDisabledTitle(repo) {
  const state = getRepoPermissionState(repo);
  if (state === 'loading') return '权限加载中';
  if (state === 'failed') return '权限请求失败，无法选中';
  if (state === 'unauthorized') return '无权限，无法选中';
  return '';
}

function shouldCopyRestrictedRepoUrl(repo) {
  const state = getRepoPermissionState(repo);
  return state === 'unauthorized' || state === 'failed';
}

function fallbackCopyText(text) {
  return new Promise(function(resolve, reject) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.pointerEvents = 'none';
      document.body.appendChild(area);
      area.focus();
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('浏览器未允许复制');
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).catch(function() {
      return fallbackCopyText(text);
    });
  }
  return fallbackCopyText(text);
}

function readTextFromClipboard() {
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    return navigator.clipboard.readText();
  }
  return Promise.reject(new Error('当前环境不支持直接读取剪贴板'));
}

function getRepoApiPath(fullName) {
  return '/repos/' + String(fullName || '').split('/').map(function(part) {
    return encodeURIComponent(part);
  }).join('/');
}

function applyRepoPermissionData(repo, data, isError) {
  if (!repo) return;
  repo.permission = data && data.permission ? data.permission : {};
  repo.permissionLoaded = true;
  repo.permissionError = !!isError || !(data && data.permission);
  if (data) {
    if (data.name) repo.name = data.name;
    if (data.html_url) repo.html_url = data.html_url;
    if (typeof data.private === 'boolean') repo.isPrivate = !!data.private;
  }
}

function findMainRepoByFullName(fullName) {
  for (let i = 0; i < allRepos.length; i++) {
    if (allRepos[i] && allRepos[i].full_name === fullName) return allRepos[i];
  }
  return null;
}

function ensureRepoInMainList(repo) {
  if (!repo || !repo.full_name) return null;
  const existing = findMainRepoByFullName(repo.full_name);
  if (existing) {
    existing.name = repo.name || existing.name;
    existing.html_url = repo.html_url || existing.html_url;
    existing.permission = repo.permission || existing.permission;
    existing.permissionLoaded = !!repo.permissionLoaded;
    existing.permissionError = !!repo.permissionError;
    existing.isPrivate = !!repo.isPrivate;
    return existing;
  }
  const added = {
    full_name: repo.full_name,
    name: repo.name || repo.full_name.split('/').slice(-1)[0],
    owner: repo.full_name.split('/')[0],
    permission: repo.permission || {},
    permissionLoaded: !!repo.permissionLoaded,
    permissionError: !!repo.permissionError,
    html_url: repo.html_url || ('https://gitee.com/' + repo.full_name),
    description: '',
    isPrivate: !!repo.isPrivate,
  };
  allRepos.push(added);
  return added;
}

async function requestRepoPermission(repo, linkedRepos, options) {
  const targets = [repo].concat(linkedRepos || []).filter(function(target, index, list) {
    return !!target && list.indexOf(target) === index;
  });
  try {
    const data = await giteeApi('GET', getRepoApiPath(repo.full_name));
    const isError = !(data && data.permission);
    for (let i = 0; i < targets.length; i++) applyRepoPermissionData(targets[i], data, isError);
    if (isError && !(options && options.silent)) {
      appendLog('获取权限失败: ' + repo.full_name + ' - API 未返回权限字段', 'err');
    }
    return { ok: !isError, data: data };
  } catch (e) {
    for (let i = 0; i < targets.length; i++) applyRepoPermissionData(targets[i], null, true);
    if (!(options && options.silent)) appendLog('获取权限失败: ' + repo.full_name + ' - ' + e.message, 'err');
    return { ok: false, error: e };
  }
}

function createRepoPermissionBadgeWrap(repo) {
  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'repo-perm-badges';
  const outsideCurrentList = !!(repo && repo.outsideCurrentList);
  const state = getRepoPermissionState(repo);

  function appendOutsideCurrentListBadge() {
    if (!outsideCurrentList) return;
    const span = document.createElement('span');
    span.className = 'perm-badge perm-note';
    span.textContent = '未加载到当前列表';
    badgeWrap.appendChild(span);
  }

  if (state === 'loading') {
    const span = document.createElement('span');
    span.className = 'perm-badge perm-loading';
    span.textContent = '权限: 加载中';
    badgeWrap.appendChild(span);
    appendOutsideCurrentListBadge();
    return badgeWrap;
  }
  if (state === 'failed') {
    const span = document.createElement('span');
    span.className = 'perm-badge perm-error';
    span.textContent = '权限请求失败';
    badgeWrap.appendChild(span);
    appendOutsideCurrentListBadge();
    return badgeWrap;
  }
  if (state === 'unauthorized') {
    const span = document.createElement('span');
    span.className = 'perm-badge perm-unauthorized';
    span.textContent = '无权限';
    badgeWrap.appendChild(span);
    appendOutsideCurrentListBadge();
    return badgeWrap;
  }
  const p = repo.permission || {};
  const items = [
    { label: 'admin', val: !!p.admin, color: 'var(--primary)' },
    { label: 'push', val: !!p.push, color: 'var(--success)' },
    { label: 'pull', val: !!p.pull, color: 'var(--text3)' },
  ];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const span = document.createElement('span');
    span.className = 'perm-badge';
    span.style.background = item.val ? item.color : '#ddd';
    span.textContent = item.label + ': ' + (item.val ? '\u2713' : '\u2717');
    badgeWrap.appendChild(span);
  }
  appendOutsideCurrentListBadge();
  return badgeWrap;
}

// ============================================================
// Load repos
// ============================================================
function setBatchLoading(loading) {
  var addBtn = document.querySelector('.batch-bar .btn-success');
  var rmBtn  = document.querySelector('.batch-bar .btn-danger');
  if (addBtn) addBtn.disabled = loading;
  if (rmBtn)  rmBtn.disabled  = loading;
}

async function loadAllRepos() {
  const token = getToken();
  if (!token) { setStatus('\u8bf7\u8f93\u5165 Token'); return; }
  const btn = document.getElementById('load-btn');
  btn.disabled = true; btn.textContent = '\u52a0\u8f7d\u4e2d\u2026';
  setBatchLoading(true);
  setStatus('\u6b63\u5728\u52a0\u8f7d\u4ed3\u5e93\u5217\u8868\u2026');
  allRepos = []; selectedRepos.clear(); currentRepo = null;
  _userSearchCache = {};
  document.getElementById('detail-placeholder').style.display = '';
  document.getElementById('detail-content').style.display = 'none';
  const myGeneration = ++_loadGeneration;

  const seen = new Set();

  function mergeRepo(r) {
    var existing = findMainRepoByFullName(r.full_name);
    var hasPerm = !!(r.permission && Object.keys(r.permission).length > 0);

    if (existing) {
      seen.add(r.full_name);
      existing.name = r.name || existing.name;
      existing.owner = (r.owner && r.owner.login) || existing.owner || r.full_name.split('/')[0];
      existing.html_url = r.html_url || existing.html_url;
      existing.description = r.description || existing.description || '';
      existing.isPrivate = typeof r.private === 'boolean' ? !!r.private : existing.isPrivate;
      if (hasPerm) {
        existing.permission = r.permission;
        existing.permissionLoaded = true;
        existing.permissionError = false;
      }
      return false;
    }

    if (seen.has(r.full_name)) return false;
    seen.add(r.full_name);
    allRepos.push({
      full_name: r.full_name,
      name: r.name,
      owner: (r.owner && r.owner.login) || r.full_name.split('/')[0],
      permission: hasPerm ? r.permission : {},
      permissionLoaded: hasPerm,
      permissionError: false,
      html_url: r.html_url,
      description: r.description || '',
      isPrivate: !!r.private,
    });
    return true;
  }

  function sortAndRender() {
    allRepos.sort(function(a, b) { return a.full_name.localeCompare(b.full_name); });
    renderRepoList();
  }

  // ── Permission pool — starts immediately as repos are discovered ──
  const permQueue = [];
  let permActive = 0;
  let permTotal = 0;
  let permDone = 0;
  const PERM_CONCURRENCY = 5;
  let permAllResolve = null;
  let phaseAComplete = false;

  function retryPendingPermissionRepos() {
    const pending = allRepos.filter(function(repo) { return !repo.permissionLoaded; });
    if (pending.length === 0) return false;
    appendLog('检测到 ' + pending.length + ' 个仓库权限仍未完成，正在补拉', 'info');
    for (let i = 0; i < pending.length; i++) enqueuePermFetch(pending[i]);
    return true;
  }

  function checkPermAllDone() {
    if (phaseAComplete && permDone >= permTotal) {
      if (retryPendingPermissionRepos()) return;
      if (permAllResolve) {
        var resolve = permAllResolve;
        permAllResolve = null;
        resolve();
      }
    }
  }

  function updateProgress() {
    var labelEl = document.getElementById('load-progress-label');
    var permEl  = document.getElementById('load-progress-perm');
    var fillEl  = document.getElementById('load-progress-fill');
    if (labelEl) labelEl.textContent = '\u4ed3\u5e93: ' + allRepos.length + ' \u4e2a';
    if (permEl)  permEl.textContent  = permTotal > 0 ? ('\u6743\u9650: ' + permDone + '/' + permTotal) : '';
    if (fillEl && permTotal > 0) fillEl.style.width = Math.round(permDone / permTotal * 100) + '%';
    if (phaseAComplete && permTotal > 0) setStatus('\u6b63\u5728\u83b7\u53d6\u6743\u9650 ' + permDone + '/' + permTotal + '\u2026');
  }

  async function permWorker() {
    try {
      while (permQueue.length > 0) {
        if (_loadGeneration !== myGeneration) return;
        var repo = permQueue.shift();
        await requestRepoPermission(repo);
        permDone++;
        if (repo.full_name === currentRepo) updateDetailPermBadges(repo.full_name);
        try { updateProgress(); } catch (e) { /* ignore render error */ }
        try {
          if (permDone % 10 === 0 || permDone >= permTotal) sortAndRender();
        } catch (e) { /* ignore render error */ }
        checkPermAllDone();
      }
    } finally {
      permActive--;
      checkPermAllDone();
    }
  }

  function enqueuePermFetch(repo) {
    permQueue.push(repo);
    permTotal++;
    updateProgress();
    // Spawn one new worker if under capacity; each worker drains the queue itself
    if (permActive < PERM_CONCURRENCY) {
      permActive++;
      permWorker();
    }
  }

  function addRepo(r) {
    if (!mergeRepo(r)) return false;
    var added = allRepos[allRepos.length - 1];
    if (!added.permissionLoaded) enqueuePermFetch(added);
    return true;
  }

  // Show progress bar (indeterminate shimmer during Phase A)
  var progressWrap = document.getElementById('load-progress-wrap');
  if (progressWrap) {
    progressWrap.style.display = '';
    progressWrap.classList.add('progress-indeterminate');
    var fillEl = document.getElementById('load-progress-fill');
    if (fillEl) fillEl.style.width = '0%';
  }
  updateProgress();

  // ── Get user info ───────────────────────────────────────────
  var user;
  try {
    user = await giteeApi('GET', '/user');
  } catch (e) {
    setStatus('\u52a0\u8f7d\u5931\u8d25: ' + e.message);
    appendLog('\u52a0\u8f7d\u5931\u8d25: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = '\u52a0\u8f7d\u4ed3\u5e93';
    setBatchLoading(false);
    if (progressWrap) progressWrap.style.display = 'none';
    renderRepoList(); // clear old list display
    return;
  }
  currentUser = user.login;
  var userDisplay = document.getElementById('current-user-display');
  var userNameEl  = document.getElementById('current-user-name');
  var userAvatarEl = document.getElementById('current-user-avatar');
  if (userDisplay && userNameEl) {
    userNameEl.textContent = user.login;
    if (userAvatarEl && user.avatar_url) {
      userAvatarEl.src = user.avatar_url;
      userAvatarEl.onerror = function() { userAvatarEl.style.display = 'none'; };
    }
    userDisplay.style.display = 'flex';
  }

  // ── Phase A: user repos + org repos all concurrent ──────────
  var fetchTasks = [];

  // User repos (always type=all so personal repos are always fetched)
  fetchTasks.push((async function fetchUserRepos() {
    var page = 1;
    while (page <= 100) {
      if (_loadGeneration !== myGeneration) return;
      var data = await giteeApi('GET', '/user/repos?type=all&sort=full_name&per_page=100&page=' + page);
      if (!Array.isArray(data) || data.length === 0) break;
      var added = 0;
      for (var i = 0; i < data.length; i++) if (addRepo(data[i])) added++;
      if (added > 0) { updateProgress(); sortAndRender(); }
      if (data.length < 100) break;
      page++;
    }
  })());

  // Org repos — fetch org list then all orgs concurrently
  fetchTasks.push((async function fetchOrgRepos() {
      var orgs;
      try { orgs = await giteeApiFetchAll('/user/orgs'); }
      catch (e) { appendLog('\u52a0\u8f7d\u7ec4\u7ec7\u5217\u8868\u5931\u8d25: ' + e.message, 'err'); return; }
      await Promise.all(orgs.map(function(org) {
        return (async function() {
          try {
            var orgPage = 1;
            while (orgPage <= 100) {
              if (_loadGeneration !== myGeneration) return;
              var data = await giteeApi('GET', '/orgs/' + org.login + '/repos?type=all&per_page=100&page=' + orgPage);
              if (!Array.isArray(data) || data.length === 0) break;
              var added = 0;
              for (var i = 0; i < data.length; i++) if (addRepo(data[i])) added++;
              if (added > 0) { updateProgress(); sortAndRender(); }
              if (data.length < 100) break;
              orgPage++;
            }
          } catch (e) {
            appendLog('\u52a0\u8f7d\u7ec4\u7ec7 ' + org.login + ' \u5931\u8d25: ' + e.message, 'err');
          }
        })();
      }));
    })());

  try {
    await Promise.all(fetchTasks);
  } catch (e) {
    setStatus('\u52a0\u8f7d\u5931\u8d25: ' + e.message);
    appendLog('\u52a0\u8f7d\u5931\u8d25: ' + e.message, 'err');
    btn.disabled = false; btn.textContent = '\u52a0\u8f7d\u4ed3\u5e93';
    setBatchLoading(false);
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }

  appendLog('\u4ed3\u5e93\u5217\u8868\u52a0\u8f7d\u5b8c\u6210: ' + allRepos.length + ' \u4e2a', 'ok');

  // Phase A done — unlock button; switch progress bar to determinate
  btn.disabled = false; btn.textContent = '\u52a0\u8f7d\u4ed3\u5e93';
  if (progressWrap) progressWrap.classList.remove('progress-indeterminate');
  phaseAComplete = true;

  // ── Phase B: wait for permission pool to drain ──────────────
  if (permTotal === 0) {
    setBatchLoading(false);
    setStatus('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93');
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }

  if (permDone < permTotal) {
    setStatus('\u6b63\u5728\u83b7\u53d6\u6743\u9650 ' + permDone + '/' + permTotal + '\u2026');
    await new Promise(function(resolve) {
      permAllResolve = resolve;
      checkPermAllDone(); // catch the case where pool already finished
    });
  }

  if (_loadGeneration !== myGeneration) return;
  setBatchLoading(false);
  setStatus('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93');
  appendLog('\u6743\u9650\u52a0\u8f7d\u5b8c\u6210', 'ok');
  sortAndRender();
  if (progressWrap) progressWrap.style.display = 'none';
}

// ============================================================
// Repo list rendering
// ============================================================
function getPermGroup(repo) {
  const state = getRepoPermissionState(repo);
  if (state === 'failed') return 'error';
  if (state === 'unauthorized') return 'unauthorized';
  return state;
}

function renderRepoList() {
  const container = document.getElementById('repo-list');
  container.innerHTML = '';
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();

  const groups = { loading: [], unauthorized: [], admin: [], push: [], pull: [], error: [] };
  for (var i = 0; i < allRepos.length; i++) {
    var r = allRepos[i];
    if (!repoMatchesFilter(r, filter)) continue;
    groups[getPermGroup(r)].push(r);
  }

  const GROUP_META = [
    { key: 'error',   label: '\u6743\u9650\u8bf7\u6c42\u5931\u8d25', cls: 'error' },
    { key: 'unauthorized', label: '\u65e0\u6743\u9650', cls: 'unauthorized' },
    { key: 'loading', label: '\u6743\u9650\u52a0\u8f7d\u4e2d', cls: 'loading' },
    { key: 'admin',   label: '\u7ba1\u7406\u5458', cls: 'admin' },
    { key: 'push',    label: '\u8bfb\u5199', cls: 'push' },
    { key: 'pull',    label: '\u53ea\u8bfb', cls: 'pull' },
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
    var toggleSpan = document.createElement('span');
    toggleSpan.className = 'toggle';
    toggleSpan.textContent = toggleChar;
    var badgeSpan = document.createElement('span');
    badgeSpan.className = 'badge ' + gm.cls;
    badgeSpan.textContent = gm.label;
    var countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = '(' + repos.length + ')';
    header.appendChild(toggleSpan);
    header.appendChild(badgeSpan);
    header.appendChild(countSpan);
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

          if (shouldClearRepoSelection(repo)) selectedRepos.delete(repo.full_name);
          const selectable = canSelectRepo(repo);

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selectedRepos.has(repo.full_name);
          cb.disabled = !selectable;
          if (!selectable) cb.title = getRepoSelectionDisabledTitle(repo);
          cb.onclick = function(e) {
            e.stopPropagation();
            if (cb.checked) selectedRepos.add(repo.full_name);
            else selectedRepos.delete(repo.full_name);
            renderRepoList();
            renderSubmoduleList();
          };

          const nameSpan = document.createElement('span');
          nameSpan.className = 'repo-name';
          nameSpan.textContent = repo.full_name;
          nameSpan.title = repo.full_name;

          const lockIcon = document.createElement('span');
          lockIcon.className = 'lock-icon';
          lockIcon.textContent = repo.isPrivate ? '\uD83D\uDD12' : '';

          div.appendChild(cb);
          div.appendChild(nameSpan);
          div.appendChild(lockIcon);
          div.title = repo.full_name;
          div.onmouseenter = function() { hoverShow(repo.full_name, repo.html_url); };
          div.onmouseleave = function() { hoverClear(); };
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

  const repoSelectAllEl = document.getElementById('repo-select-all');
  if (repoSelectAllEl) {
    const visibleSelectable = allRepos.filter(function(repo) {
      return repoMatchesFilter(repo, filter) && canSelectRepo(repo);
    });
    const selectedCount = visibleSelectable.filter(function(repo) {
      return selectedRepos.has(repo.full_name);
    }).length;
    repoSelectAllEl.disabled = visibleSelectable.length === 0;
    repoSelectAllEl.checked = visibleSelectable.length > 0 && selectedCount === visibleSelectable.length;
    repoSelectAllEl.indeterminate = selectedCount > 0 && selectedCount < visibleSelectable.length;
  }
}

document.getElementById('repo-search').addEventListener('input', function() { renderRepoList(); });

function toggleSelectAllVisible() {
  const repoSelectAllEl = document.getElementById('repo-select-all');
  if (!repoSelectAllEl) return;
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();
  const visibleSelectable = allRepos.filter(function(repo) {
    return repoMatchesFilter(repo, filter) && canSelectRepo(repo);
  });
  if (visibleSelectable.length === 0) {
    repoSelectAllEl.checked = false;
    repoSelectAllEl.indeterminate = false;
    return;
  }
  if (!repoSelectAllEl.checked) {
    visibleSelectable.forEach(function(repo) { selectedRepos.delete(repo.full_name); });
  } else {
    visibleSelectable.forEach(function(repo) { selectedRepos.add(repo.full_name); });
  }
  renderRepoList();
  renderSubmoduleList();
}

function selectAllVisible() {
  const repoSelectAllEl = document.getElementById('repo-select-all');
  if (!repoSelectAllEl) return;
  repoSelectAllEl.checked = true;
  repoSelectAllEl.indeterminate = false;
  toggleSelectAllVisible();
}

function deselectAll() {
  const repoSelectAllEl = document.getElementById('repo-select-all');
  if (!repoSelectAllEl) return;
  repoSelectAllEl.checked = false;
  repoSelectAllEl.indeterminate = false;
  toggleSelectAllVisible();
}

// ============================================================
// Repo detail & collaborators
// ============================================================

// Render permission badges + update add-collab button for the currently-open repo.
// Called both when the detail panel is first opened and when Phase-2 permission
// data arrives while the panel is already showing.
function updateDetailPermBadges(fullName) {
  if (fullName !== currentRepo) return;
  var repo = allRepos.find(function(r) { return r.full_name === fullName; });
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
  if (collabSearchEl && currentCollabsRepo === fullName && currentCollabs.length > 0) {
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
  currentCollabs = []; currentCollabsRepo = null;
  selectedCollabs.clear();
  var _batchBar = document.getElementById('collab-batch-bar'); if (_batchBar) _batchBar.style.display = 'none';

  try {
    const collabs = await giteeApiFetchAll('/repos/' + fullName + '/collaborators');
    // Discard stale response if user switched to another repo while loading
    if (fullName !== currentRepo) return;
    currentCollabs = collabs; currentCollabsRepo = fullName;
    renderCollabList('');
    // Load submodules for this repo
    loadSubmodules(fullName);
  } catch (e) {
    if (fullName !== currentRepo) return;
    currentCollabs = []; currentCollabsRepo = null;
    collabList.innerHTML = '';
    var _errDiv = document.createElement('div'); _errDiv.className = 'err-text'; _errDiv.textContent = '\u52a0\u8f7d\u5931\u8d25: ' + e.message; collabList.appendChild(_errDiv);
    // still try to load submodules even if collaborators failed
    loadSubmodules(fullName);
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

  // Hoist permission check — same for every item in this repo
  var repo = allRepos.find(function(r) { return r.full_name === fullName; });
  var permissionState = getRepoPermissionState(repo);
  var permissionLoading = permissionState === 'loading';
  var permissionFailed = permissionState === 'failed';
  var isAdmin = !!(repo && !repo.permissionError && repo.permission && repo.permission.admin);

  if (currentCollabs.length === 0) {
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
        cb.checked = selectedCollabs.has(c.login);
        cb.onchange = function() {
          if (cb.checked) selectedCollabs.add(c.login);
          else selectedCollabs.delete(c.login);
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

// ============================================================
// Submodules
// ============================================================
async function getSubmoduleRepos(fullName) {
  try {
    const data = await giteeApi('GET', '/repos/' + fullName + '/contents/.gitmodules');
    if (!data || !data.content) return [];
    const b64 = (data.content || '').replace(/\s+/g, '');
    const txt = atob(b64);
    const lines = txt.split(/\r?\n/);
    const repos = [];
    for (let line of lines) {
      const m = line.match(/url\s*=\s*(.+)/);
      if (!m) continue;
      repos.push.apply(repos, extractRepoFullNamesFromText(m[1].trim()));
    }
    return Array.from(new Set(repos));
  } catch (e) {
    return [];
  }
}

async function loadSubmodules(fullName) {
  const wrap = document.getElementById('submodule-list');
  const countEl = document.getElementById('submodule-count');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (countEl) countEl.textContent = '(加载中…)';
  currentSubmodules = []; currentSubmodulesRepo = null;
  try {
    const subs = await getSubmoduleRepos(fullName);
    if (fullName !== currentRepo) return;
    if (!subs || subs.length === 0) {
      wrap.innerHTML = '<div class="loading-text">暂无子模块</div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    // initialize submodule objects and render loading state
    currentSubmodules = subs.map(function(s) {
      return { full_name: s, name: s.split('/').slice(-1)[0], permission: {}, permissionLoaded: false, permissionError: false, html_url: 'https://gitee.com/' + s };
    });
    currentSubmodulesRepo = fullName;
    renderSubmoduleList();

    // fetch permission for each submodule
    // fetch permission for each submodule in parallel
    try {
      const promises = currentSubmodules.map(function(sub) {
        return giteeApi('GET', getRepoApiPath(sub.full_name)).then(function(d) {
          return { ok: true, data: d };
        }).catch(function(err) {
          return { ok: false, err: err };
        });
      });
      const results = await Promise.all(promises);
      if (fullName !== currentRepo) return;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const sub = currentSubmodules[i];
        if (res && res.ok && res.data) {
          sub.permission = res.data.permission || {};
          sub.permissionLoaded = true;
          sub.permissionError = false;
        } else {
          sub.permission = {};
          sub.permissionLoaded = true;
          sub.permissionError = true;
        }
      }
      renderSubmoduleList();
    } catch (e) {
      // if something unexpected happened, mark all as errored
      for (let i = 0; i < currentSubmodules.length; i++) {
        const sub = currentSubmodules[i];
        sub.permission = {};
        sub.permissionLoaded = true;
        sub.permissionError = true;
      }
      renderSubmoduleList();
    }
  } catch (e) {
    wrap.innerHTML = '<div class="err-text">加载子模块失败</div>';
    if (countEl) countEl.textContent = '';
  }
}

function renderSubmoduleList() {
  const wrap = document.getElementById('submodule-list');
  const countEl = document.getElementById('submodule-count');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!currentSubmodules || currentSubmodules.length === 0) {
    wrap.innerHTML = '<div class="loading-text">暂无子模块</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = '(' + currentSubmodules.length + ')';

  // header handled in HTML; render list
  for (let i = 0; i < currentSubmodules.length; i++) {
    const s = currentSubmodules[i];
    const div = document.createElement('div');
    div.className = 'repo-item';

    if (shouldClearRepoSelection(s)) selectedRepos.delete(s.full_name);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedRepos.has(s.full_name);
    const hasPerm = canSelectRepo(s);
    if (!hasPerm) cb.disabled = true;
    cb.onclick = function(e) {
      e.stopPropagation();
      if (cb.checked) selectedRepos.add(s.full_name);
      else selectedRepos.delete(s.full_name);
      renderSubmoduleList();
      renderRepoList();
    };

    const nameSpan = document.createElement('span');
    nameSpan.className = 'repo-name';
    nameSpan.textContent = s.full_name;
    nameSpan.title = s.full_name;

    const lockIcon = document.createElement('span');
    lockIcon.className = 'lock-icon';
    lockIcon.textContent = '';
    div.appendChild(cb);
    div.appendChild(nameSpan);
    div.title = s.full_name;
    div.onmouseenter = function() { hoverShow(s.full_name, s.html_url); };
    div.onmouseleave = function() { hoverClear(); };

    div.appendChild(createRepoPermissionBadgeWrap(s));
    wrap.appendChild(div);
  }

  // update select-all checkbox state
  const selAllEl = document.getElementById('submodule-select-all');
  if (selAllEl) {
    const selectable = currentSubmodules.filter(function(x) { return canSelectRepo(x); });
    const selCount = selectable.filter(function(x) { return selectedRepos.has(x.full_name); }).length;
    selAllEl.checked = selectable.length > 0 && selCount === selectable.length;
    selAllEl.indeterminate = selCount > 0 && selCount < selectable.length;
  }
}

function toggleSelectAllSubmodules() {
  if (!currentSubmodules || currentSubmodules.length === 0) return;
  const selAllEl = document.getElementById('submodule-select-all');
  const selectable = currentSubmodules.filter(function(x) { return canSelectRepo(x); });
  if (!selAllEl.checked) {
    // unselect all
    selectable.forEach(function(s) { selectedRepos.delete(s.full_name); });
  } else {
    selectable.forEach(function(s) { selectedRepos.add(s.full_name); });
  }
  renderSubmoduleList();
  renderRepoList();
}

async function copyUnauthorizedSubmoduleUrls() {
  if (!currentSubmodules || currentSubmodules.length === 0) {
    setStatus('当前没有可复制的子模块');
    return;
  }
  const targets = currentSubmodules.filter(function(sub) {
    return shouldCopyRestrictedRepoUrl(sub);
  });
  if (targets.length === 0) {
    setStatus('当前子模块中没有无权限或请求失败的仓库');
    return;
  }
  const text = targets.map(function(sub) {
    return sub.html_url || ('https://gitee.com/' + sub.full_name);
  }).join('\n');
  try {
    await copyTextToClipboard(text);
    setStatus('已复制 ' + targets.length + ' 个无权限或请求失败的子模块链接');
  } catch (e) {
    setStatus('复制失败: ' + e.message);
  }
}

function openClipboardSelectModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let parsedRepos = [];
  let clipboardReadVersion = 0;
  let parseRequestVersion = 0;

  const modal = document.createElement('div');
  modal.className = 'modal modal-wide';

  const title = document.createElement('h3');
  title.textContent = '从剪贴板选中仓库';
  modal.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'clipboard-modal-hint';
  hint.textContent = '可从剪贴板识别 Gitee 仓库 URL，允许内容中夹杂无关文字；如果浏览器限制访问剪贴板，也可以手动粘贴后解析。';
  modal.appendChild(hint);

  const toolbar = document.createElement('div');
  toolbar.className = 'clipboard-modal-toolbar';
  const selectAllWrap = document.createElement('label');
  selectAllWrap.style.display = 'flex';
  selectAllWrap.style.alignItems = 'center';
  selectAllWrap.style.gap = '.4rem';
  selectAllWrap.style.cursor = 'pointer';
  selectAllWrap.style.margin = '0';
  const selectAllInput = document.createElement('input');
  selectAllInput.type = 'checkbox';
  const selectAllText = document.createElement('span');
  selectAllText.textContent = '全选';
  selectAllWrap.appendChild(selectAllInput);
  selectAllWrap.appendChild(selectAllText);
  const parseBtn = document.createElement('button');
  parseBtn.className = 'btn btn-primary btn-sm';
  parseBtn.textContent = '解析 URL';
  toolbar.appendChild(parseBtn);
  modal.appendChild(toolbar);

  const textarea = document.createElement('textarea');
  textarea.className = 'clipboard-textarea';
  textarea.placeholder = '请粘贴包含仓库 URL 的内容';
  modal.appendChild(textarea);

  const selectToolbar = document.createElement('div');
  selectToolbar.className = 'clipboard-modal-toolbar';
  selectToolbar.appendChild(selectAllWrap);
  modal.appendChild(selectToolbar);

  const summary = document.createElement('div');
  summary.className = 'clipboard-modal-status';
  summary.textContent = '请粘贴内容后点击“解析 URL”';
  modal.appendChild(summary);

  const resultToolbar = document.createElement('div');
  resultToolbar.className = 'clipboard-modal-toolbar';
  const copyUnauthorizedBtn = document.createElement('button');
  copyUnauthorizedBtn.className = 'btn btn-ghost btn-sm';
  copyUnauthorizedBtn.textContent = '复制无权限或失败仓库链接';
  resultToolbar.appendChild(copyUnauthorizedBtn);
  modal.appendChild(resultToolbar);

  const list = document.createElement('div');
  list.className = 'clipboard-modal-list';
  modal.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost';
  closeBtn.textContent = '关闭';
  closeBtn.onclick = function() { overlay.remove(); };
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  selectAllInput.disabled = true;
  selectAllInput.checked = false;
  selectAllInput.indeterminate = false;
  const initialEmpty = document.createElement('div');
  initialEmpty.className = 'clipboard-empty';
  initialEmpty.textContent = '请先粘贴并解析 Gitee 仓库 URL。';
  list.appendChild(initialEmpty);

  function buildKnownRepoRefsMap() {
    const known = new Map();
    function remember(repo) {
      if (!repo || !repo.full_name) return;
      const key = repo.full_name.toLowerCase();
      if (!known.has(key)) known.set(key, []);
      const refs = known.get(key);
      if (refs.indexOf(repo) === -1) refs.push(repo);
    }
    allRepos.forEach(remember);
    currentSubmodules.forEach(remember);
    return known;
  }

  function createClipboardRepoCandidate(fullName, repoRefs) {
    const refs = repoRefs || [];
    const base = refs[0] || null;
    return {
      full_name: fullName,
      name: (base && base.name) || fullName.split('/').slice(-1)[0],
      html_url: (base && base.html_url) || ('https://gitee.com/' + fullName),
      permission: base && base.permission ? Object.assign({}, base.permission) : {},
      permissionLoaded: !!(base && base.permissionLoaded),
      permissionError: !!(base && base.permissionError),
      isPrivate: !!(base && base.isPrivate),
      outsideCurrentList: refs.length === 0,
      localRepoRefs: refs,
    };
  }

  function renderCandidates(repos) {
    parsedRepos = Array.isArray(repos) ? repos.slice() : [];
    list.innerHTML = '';
    if (!repos || repos.length === 0) {
      selectAllInput.disabled = true;
      selectAllInput.checked = false;
      selectAllInput.indeterminate = false;
      const empty = document.createElement('div');
      empty.className = 'clipboard-empty';
      empty.textContent = '未解析到任何 Gitee 仓库 URL。';
      list.appendChild(empty);
      summary.textContent = '未解析到任何 Gitee 仓库 URL';
      return;
    }

    let inCurrentList = 0;
    let selectable = 0;
    let selected = 0;
    let outsideCurrentListCount = 0;

    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      if (shouldClearRepoSelection(repo)) selectedRepos.delete(repo.full_name);
      const enabled = canSelectRepo(repo);
      if (repo.outsideCurrentList) outsideCurrentListCount++;
      else inCurrentList++;
      if (enabled) selectable++;
      if (selectedRepos.has(repo.full_name)) selected++;

      const row = document.createElement('div');
      row.className = 'clipboard-repo-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedRepos.has(repo.full_name);
      cb.disabled = !enabled;
      if (!enabled) cb.title = getRepoSelectionDisabledTitle(repo);
      cb.onclick = function(e) {
        e.stopPropagation();
        if (cb.checked) selectedRepos.add(repo.full_name);
        else selectedRepos.delete(repo.full_name);
        renderRepoList();
        renderSubmoduleList();
        renderCandidates(repos);
      };

      const main = document.createElement('div');
      main.className = 'clipboard-repo-main';
      const name = document.createElement('div');
      name.className = 'clipboard-repo-name';
      name.textContent = repo.full_name;
      const url = document.createElement('div');
      url.className = 'clipboard-repo-url';
      url.textContent = repo.html_url || ('https://gitee.com/' + repo.full_name);
      main.appendChild(name);
      main.appendChild(url);

      row.appendChild(cb);
      row.appendChild(main);
      row.appendChild(createRepoPermissionBadgeWrap(repo));
      list.appendChild(row);
    }

    selectAllInput.disabled = selectable === 0;
    selectAllInput.checked = selectable > 0 && selected === selectable;
    selectAllInput.indeterminate = selected > 0 && selected < selectable;

    summary.textContent = '已解析 ' + repos.length + ' 个仓库，当前列表已命中 ' + inCurrentList + ' 个，可选 ' + selectable + ' 个，已选 ' + selected + ' 个' + (outsideCurrentListCount > 0 ? ('，另有 ' + outsideCurrentListCount + ' 个未加载到当前列表') : '');
  }

  function toggleSelectAllParsedRepos() {
    if (!parsedRepos || parsedRepos.length === 0) return;
    if (!selectAllInput.checked) {
      for (let i = 0; i < parsedRepos.length; i++) {
        if (canSelectRepo(parsedRepos[i])) selectedRepos.delete(parsedRepos[i].full_name);
      }
    } else {
      for (let i = 0; i < parsedRepos.length; i++) {
        const repo = parsedRepos[i];
        if (canSelectRepo(repo)) selectedRepos.add(repo.full_name);
      }
    }
    renderRepoList();
    renderSubmoduleList();
    renderCandidates(parsedRepos);
  }

  async function copyUnauthorizedRepoUrls() {
    const repos = parsedRepos.filter(function(repo) {
      return shouldCopyRestrictedRepoUrl(repo);
    });
    if (repos.length === 0) {
      setStatus('当前解析结果中没有可复制的无权限或请求失败仓库');
      return;
    }
    const text = repos.map(function(repo) {
      return repo.html_url || ('https://gitee.com/' + repo.full_name);
    }).join('\n');
    try {
      await copyTextToClipboard(text);
      setStatus('已复制 ' + repos.length + ' 个无权限或请求失败仓库链接');
    } catch (e) {
      setStatus('复制失败: ' + e.message);
    }
  }

  function refreshParsedRepoPermissions(repos, requestVersion) {
    for (let i = 0; i < repos.length; i++) {
      (function(repo) {
        requestRepoPermission(repo, repo.localRepoRefs, { silent: true }).then(function(result) {
          if (result && result.ok) {
            const syncedRepo = ensureRepoInMainList(repo);
            if (syncedRepo) {
              repo.localRepoRefs = [syncedRepo];
              repo.outsideCurrentList = false;
            }
          }
          renderRepoList();
          renderSubmoduleList();
          if (requestVersion !== parseRequestVersion) return;
          renderCandidates(repos);
        });
      })(repos[i]);
    }
  }

  function parseClipboardText(text) {
    clipboardReadVersion++;
    const fullNames = extractRepoFullNamesFromText(text);
    if (fullNames.length === 0) {
      parseRequestVersion++;
      renderCandidates([]);
      return;
    }
    const known = buildKnownRepoRefsMap();
    const repos = fullNames.map(function(fullName) {
      return createClipboardRepoCandidate(fullName, known.get(fullName.toLowerCase()) || []);
    });
    renderCandidates(repos);
    const requestVersion = ++parseRequestVersion;
    refreshParsedRepoPermissions(repos, requestVersion);
  }

  copyUnauthorizedBtn.onclick = function() { copyUnauthorizedRepoUrls(); };
  selectAllInput.onchange = function() { toggleSelectAllParsedRepos(); };
  parseBtn.onclick = function() {
    clipboardReadVersion++;
    parseClipboardText(textarea.value);
  };

  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.getElementById('modal-container').appendChild(overlay);
  setTimeout(function() { textarea.focus(); }, 50);
}

function updateCollabBatchBar(filtered, isAdmin) {
  var bar = document.getElementById('collab-batch-bar');
  if (!bar) return;
  if (!isAdmin || filtered.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  var selAllCb = document.getElementById('collab-select-all');
  if (selAllCb) {
    var selInFiltered = filtered.filter(function(c) { return selectedCollabs.has(c.login); }).length;
    selAllCb.indeterminate = selInFiltered > 0 && selInFiltered < filtered.length;
    selAllCb.checked = filtered.length > 0 && selInFiltered === filtered.length;
  }
  var selCountEl = document.getElementById('collab-selected-count');
  if (selCountEl) selCountEl.textContent = '\u5df2\u9009 ' + selectedCollabs.size + ' \u4eba';
  var hasSelection = selectedCollabs.size > 0;
  var updateBtn = document.getElementById('collab-batch-update-btn');
  var rmBtn = document.getElementById('collab-batch-remove-btn');
  if (updateBtn) updateBtn.disabled = !hasSelection;
  if (rmBtn) rmBtn.disabled = !hasSelection;
}

function toggleSelectAllCollabs() {
  var searchEl = document.getElementById('collab-search');
  var filter = (searchEl ? searchEl.value : '').trim().toLowerCase();
  var filtered = filter ? currentCollabs.filter(function(c) {
    return (c.login || '').toLowerCase().indexOf(filter) !== -1 || (c.name || '').toLowerCase().indexOf(filter) !== -1;
  }) : currentCollabs.slice();
  var allSel = filtered.length > 0 && filtered.every(function(c) { return selectedCollabs.has(c.login); });
  filtered.forEach(function(c) { if (allSel) selectedCollabs.delete(c.login); else selectedCollabs.add(c.login); });
  renderCollabList(searchEl ? searchEl.value : '');
}

async function batchCollabUpdatePerm() {
  if (!currentRepo || selectedCollabs.size === 0) return;
  var permission = document.getElementById('collab-batch-perm').value;
  var permLabels = { pull: '\u53ea\u8bfb', push: '\u8bfb\u5199', admin: '\u7ba1\u7406\u5458' };
  var permLabel = permLabels[permission] || permission;
  var logins = Array.from(selectedCollabs);
  var isSelf = !!(currentUser && logins.some(function(l) { return l.toLowerCase() === currentUser.toLowerCase(); }));

  // Classify downgrades against currentCollabs cache (no API call needed)
  var targetLevel = PERM_LEVEL[permission];
  var dgRows = [];
  var safeLogins = [];
  for (var li = 0; li < logins.length; li++) {
    var login = logins[li];
    var curLvl = getCurrentPermLevel(currentRepo, login);
    if (curLvl >= 0 && curLvl > targetLevel) {
      dgRows.push({
        title: login + (isSelf && login.toLowerCase() === (currentUser || '').toLowerCase() ? '  \u26d4\u81ea\u5df1' : ''),
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
      headerText: '\u5373\u5c06\u5728 ' + currentRepo + ' \u4e2d\u5c06\u9009\u4e2d\u534f\u4f5c\u8005\u6743\u9650\u4fee\u6539\u4e3a ' + permLabel + '(' + permission + ')\u3002\u4ee5\u4e0b\u534f\u4f5c\u8005\u4f1a\u53d1\u751f\u964d\u7ea7\uff1a',
      downgrades: dgRows,
      failed: [],
      safeCount: safeLogins.length,
    });
    if (decision === 'cancel') return;
    if (decision === 'skip') finalLogins = safeLogins;
    else finalLogins = logins;
  } else {
    var confirmMsg = isSelf
      ? '\u26a0\ufe0f \u8b66\u544a\uff1a\u9009\u4e2d\u5217\u8868\u4e2d\u5305\u542b\u3010\u4f60\u81ea\u5df1\u3011\uff0c\u5c06\u4fee\u6539\u4f60\u5728 ' + currentRepo + ' \u7684\u6743\u9650\u4e3a ' + permLabel + '(' + permission + ')\u3002\n\n\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f'
      : '\u786e\u5b9a\u5c06\u4ee5\u4e0b ' + logins.length + ' \u4f4d\u534f\u4f5c\u8005\u5728 ' + currentRepo + ' \u7684\u6743\u9650\u4fee\u6539\u4e3a ' + permLabel + '(' + permission + ')\uff1f\n\n' + logins.join(', ');
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
        await giteeApi('PUT', '/repos/' + currentRepo + '/collaborators/' + finalLogins[i], { permission: permission });
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
  selectedCollabs.clear();
  loadRepoDetail(currentRepo);
}

async function batchCollabRemove() {
  if (!currentRepo || selectedCollabs.size === 0) return;
  var logins = Array.from(selectedCollabs);
  var isSelf = currentUser && logins.some(function(l) { return l.toLowerCase() === currentUser.toLowerCase(); });
  var msg = isSelf
    ? '\u26d4 \u8b66\u544a\uff1a\u9009\u4e2d\u5217\u8868\u4e2d\u5305\u542b\u300a\u4f60\u81ea\u5df1\u300b\uff0c\u4f60\u5c06\u4ece ' + currentRepo + ' \u88ab\u79fb\u9664\uff01\n\n\u79fb\u9664\u540e\u65e0\u6cd5\u81ea\u884c\u6062\u590d\uff01\n\n\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f'
    : '\u786e\u5b9a\u4ece ' + currentRepo + ' \u79fb\u9664\u4ee5\u4e0b ' + logins.length + ' \u4f4d\u534f\u4f5c\u8005\uff1f\n\n' + logins.join(', ');
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
        await giteeApi('DELETE', '/repos/' + currentRepo + '/collaborators/' + logins[i]);
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
  selectedCollabs.clear();
  loadRepoDetail(currentRepo);
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
    var _rawPerm = collab.permissions || collab.permission;
    if (typeof _rawPerm === 'string') return PERM_LEVEL[_rawPerm] !== undefined ? PERM_LEVEL[_rawPerm] : -1;
    if (_rawPerm && typeof _rawPerm === 'object') {
      if (_rawPerm.admin) return 2;
      if (_rawPerm.push) return 1;
      return 0;
    }
    return -1; // permission data missing from API response
  }
  return -1; // not found in cached collaborators
}

function permLevelToLabel(level) {
  if (level === 2) return '管理员(admin)';
  if (level === 1) return '读写(push)';
  if (level === 0) return '只读(pull)';
  if (level === -1) return '未授权';
  return '未知';
}

async function fetchTargetUserPermLevel(repoFullName, username) {
  try {
    var collabs = await giteeApiFetchAll('/repos/' + repoFullName + '/collaborators');
    var unameLower = username.toLowerCase();
    var c = collabs.find(function(x) { return x.login && x.login.toLowerCase() === unameLower; });
    if (!c) return { level: -1, error: false };
    var raw = c.permissions || c.permission;
    if (typeof raw === 'string') {
      var lvl = PERM_LEVEL[raw];
      return { level: lvl !== undefined ? lvl : null, error: lvl === undefined };
    }
    if (raw && typeof raw === 'object') {
      if (raw.admin) return { level: 2, error: false };
      if (raw.push)  return { level: 1, error: false };
      return { level: 0, error: false };
    }
    return { level: null, error: true };
  } catch (e) {
    return { level: null, error: true };
  }
}

async function precheckTargetUserPermissions(repos, username) {
  var levelMap = new Map();
  var i = 0;
  var done = 0;
  var concurrency = Math.min(5, repos.length);
  async function worker() {
    while (i < repos.length) {
      var idx = i++;
      var repo = repos[idx];
      var res = await fetchTargetUserPermLevel(repo, username);
      levelMap.set(repo, res);
      done++;
      setStatus('预检中… ' + done + '/' + repos.length);
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return { levelMap: levelMap };
}

function classifyDowngrades(repos, levelMap, targetLevel) {
  var downgrades = [];
  var failed = [];
  var safe = [];
  for (var i = 0; i < repos.length; i++) {
    var repo = repos[i];
    var entry = levelMap.get(repo);
    if (!entry || entry.error || entry.level === null) {
      failed.push({ repo: repo });
      continue;
    }
    if (entry.level > targetLevel) {
      downgrades.push({ repo: repo, currentLevel: entry.level, currentLabel: permLevelToLabel(entry.level) });
    } else {
      safe.push({ repo: repo, currentLevel: entry.level });
    }
  }
  return { downgrades: downgrades, failed: failed, safe: safe };
}

// Modal returns Promise<'keep' | 'skip' | 'cancel'>.
// opts: {
//   mode: 'batch' | 'single',
//   scope: '仓库' | '协作者',          // semantic of each row
//   headerText,                          // line above downgrade list
//   isSelf,
//   targetPermLabel,
//   downgrades: [{ title, sub }],        // sub is "currentLabel → targetLabel"
//   failed:     [{ title }],
//   safeCount,
// }
function showDowngradeDecisionModal(opts) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal modal-wide';

    var h3 = document.createElement('h3');
    h3.textContent = '⚠️ 检测到权限降级';
    h3.style.color = 'var(--warning)';
    modal.appendChild(h3);

    var desc = document.createElement('div');
    desc.className = 'clipboard-modal-hint';
    desc.textContent = opts.headerText || '';
    modal.appendChild(desc);

    if (opts.isSelf) {
      var selfNote = document.createElement('div');
      selfNote.style.color = 'var(--danger)';
      selfNote.style.fontWeight = '600';
      selfNote.style.margin = '.25rem 0 .75rem';
      selfNote.textContent = '⛔ 警告：操作涉及【你自己】，降级后可能无法自行恢复！';
      modal.appendChild(selfNote);
    }

    function buildSection(title, rows, rowBg, makeRow) {
      if (!rows || rows.length === 0) return;
      var wrap = document.createElement('div');
      var t = document.createElement('div');
      t.style.fontWeight = '600';
      t.style.margin = '.75rem 0 .25rem 0';
      t.textContent = title + ' (' + rows.length + ')';
      wrap.appendChild(t);
      var list = document.createElement('div');
      list.className = 'clipboard-modal-list';
      for (var i = 0; i < rows.length; i++) {
        var item = document.createElement('div');
        item.className = 'clipboard-repo-item';
        item.style.background = rowBg;
        item.appendChild(makeRow(rows[i]));
        list.appendChild(item);
      }
      wrap.appendChild(list);
      modal.appendChild(wrap);
    }

    buildSection('降级' + (opts.scope || '仓库'), opts.downgrades, '#fff4e6', function(r) {
      var main = document.createElement('div');
      main.className = 'clipboard-repo-main';
      var name = document.createElement('div');
      name.className = 'clipboard-repo-name';
      name.textContent = r.title;
      var sub = document.createElement('div');
      sub.className = 'clipboard-repo-url';
      sub.textContent = r.sub;
      main.appendChild(name);
      main.appendChild(sub);
      return main;
    });

    buildSection('权限未知（预检失败）', opts.failed, '#f5f5f5', function(r) {
      var main = document.createElement('div');
      main.className = 'clipboard-repo-main';
      var name = document.createElement('div');
      name.className = 'clipboard-repo-name';
      name.textContent = r.title;
      var sub = document.createElement('div');
      sub.className = 'clipboard-repo-url';
      sub.textContent = '无法确定该' + (opts.scope === '协作者' ? '协作者' : '用户') + '的现有权限';
      main.appendChild(name);
      main.appendChild(sub);
      return main;
    });

    if (opts.mode === 'batch' && opts.safeCount > 0) {
      var safeSummary = document.createElement('div');
      safeSummary.className = 'clipboard-modal-status';
      safeSummary.style.marginTop = '.5rem';
      safeSummary.textContent = '另有 ' + opts.safeCount + ' 个非降级' + (opts.scope || '仓库') + '（新增或同级 / 升级），不受影响。';
      modal.appendChild(safeSummary);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    function close(result) { overlay.remove(); resolve(result); }

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { close('cancel'); };
    actions.appendChild(cancelBtn);

    if (opts.mode === 'batch') {
      var skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-primary';
      skipBtn.textContent = '忽略降级（仅执行 ' + opts.safeCount + ' 个非降级）';
      skipBtn.disabled = !opts.safeCount;
      if (skipBtn.disabled) skipBtn.title = '没有可执行的非降级项';
      skipBtn.onclick = function() { close('skip'); };
      actions.appendChild(skipBtn);
    }

    var keepBtn = document.createElement('button');
    keepBtn.className = 'btn btn-danger';
    keepBtn.textContent = opts.mode === 'batch' ? '保留降级（按选择全部执行）' : '保留降级（继续执行）';
    keepBtn.onclick = function() { close('keep'); };
    actions.appendChild(keepBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close('cancel'); });
    document.getElementById('modal-container').appendChild(overlay);
  });
}

async function updateCollabPermission(repoFullName, username, permission) {
  var permLabels = { pull: '只读', push: '读写', admin: '管理员' };
  var permLabel = permLabels[permission] || permission;
  var isSelf = !!(currentUser && username.toLowerCase() === currentUser.toLowerCase());
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
    switchTab('log');
    loadRepoDetail(repoFullName);
  } catch (e) {
    setStatus('\u79fb\u9664\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u79fb\u9664 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
  }
}

function promptAddCollab() {
  if (!currentRepo) return;
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
    confirmBtn.disabled = true;
    try {
      await giteeApi('PUT', '/repos/' + currentRepo + '/collaborators/' + username, { permission: permission });
      appendLog(currentRepo + ': \u5df2\u6dfb\u52a0 ' + username + ' (' + permission + ')', 'ok');
      overlay.remove();
      // show logs and refresh detail
      switchTab('log');
      loadRepoDetail(currentRepo);
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
// ============================================================
async function batchAddCollab() {
  const username = document.getElementById('batch-user').value.trim();
  const permission = document.getElementById('batch-perm').value;
  if (!username) { setStatus('请输入用户名'); return; }
  if (selectedRepos.size === 0) { setStatus('请先选择仓库'); return; }

  const allSelected = Array.from(selectedRepos);
  var repos = allSelected.filter(function(fn) {
    var r = allRepos.find(function(x) { return x.full_name === fn; });
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
  var isSelf = !!(currentUser && username.toLowerCase() === currentUser.toLowerCase());

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
  if (selectedRepos.size === 0) { setStatus('\u8bf7\u5148\u9009\u62e9\u4ed3\u5e93'); return; }

  const allSelected = Array.from(selectedRepos);
  // Only include repos with confirmed admin permission; skip loading repos and non-admin
  var repos = allSelected.filter(function(fn) {
    var r = allRepos.find(function(x) { return x.full_name === fn; });
    if (!r) return false;
    return r.permissionLoaded && !!(r.permission && r.permission.admin);
  });
  var skipped = allSelected.length - repos.length;
  if (repos.length === 0) {
    setStatus('\u6240\u9009\u4ed3\u5e93\u5747\u65e0\u7ba1\u7406\u5458\u6743\u9650\uff08\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09');
    if (skipped > 0) appendLog('\u5df2\u8df3\u8fc7 ' + skipped + ' \u4e2a\u4ed3\u5e93\uff08\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09', 'err');
    return;
  }

  var isSelf = currentUser && username.toLowerCase() === currentUser.toLowerCase();
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
// ============================================================
function switchTab(tab) {
  var detailEl = document.getElementById('tab-detail');
  var logEl = document.getElementById('tab-log');
  if (detailEl) detailEl.style.display = tab === 'detail' ? '' : 'none';
  if (logEl) logEl.style.display = tab === 'log' ? '' : 'none';
  var btns = document.querySelectorAll('#tab-bar button');
  if (btns && btns.length >= 2) {
    btns[0].classList.toggle('active', tab === 'detail');
    btns[1].classList.toggle('active', tab === 'log');
  }
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

function setupUserSearch(inputEl, dropdownEl) {
  var searchTimer = null;
  inputEl.addEventListener('input', function() {
    clearTimeout(searchTimer);
    var q = inputEl.value.trim();
    if (q.length < 2) { closeUserDropdown(dropdownEl); return; }
    searchTimer = setTimeout(function() { doUserSearch(q, dropdownEl, inputEl); }, 300);
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
  dropdownEl.innerHTML = '';
  var hintEl = document.createElement('div'); hintEl.className = 'user-dropdown-hint'; hintEl.textContent = '\u641c\u7d22\u4e2d\u2026';
  dropdownEl.appendChild(hintEl);
  dropdownEl.classList.add('open');
  try {
    var token = getToken();
    if (!token) return;
    var url = 'https://gitee.com/api/v5/search/users?q=' + encodeURIComponent(query) + '&per_page=10';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) throw new Error('API ' + r.status);
    var data = await r.json();
    _userSearchCache[query] = data;
    renderUserDropdown(data, dropdownEl, inputEl);
  } catch (e) {
    dropdownEl.innerHTML = '';
    var _errHint = document.createElement('div'); _errHint.className = 'user-dropdown-hint'; _errHint.textContent = '\u641c\u7d22\u5931\u8d25'; dropdownEl.appendChild(_errHint);
    dropdownEl.classList.add('open');
  }
}

function renderUserDropdown(users, dropdownEl, inputEl) {
  dropdownEl.innerHTML = '';
  if (!users || users.length === 0) {
    var _noUserHint = document.createElement('div'); _noUserHint.className = 'user-dropdown-hint'; _noUserHint.textContent = '\u672a\u627e\u5230\u7528\u6237'; dropdownEl.appendChild(_noUserHint);
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
      var nameEl = document.createElement('div'); nameEl.className = 'ud-name'; nameEl.textContent = u.name || u.login;
      var loginEl = document.createElement('div'); loginEl.className = 'ud-login'; loginEl.textContent = '@' + u.login;
      info.appendChild(nameEl); info.appendChild(loginEl);
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
