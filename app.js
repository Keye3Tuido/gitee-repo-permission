// ============================================================
// Gitee Repo Permission Manager - app.js
// ============================================================

const STORAGE_KEY = 'gitee_perm_config';
let allRepos = [];
let selectedRepos = new Set();
let currentRepo = null;
let collapsedGroups = new Set();
let currentCollabs = []; // cached collaborators for current repo
let currentCollabsRepo = null; // which repo currentCollabs belongs to
let selectedCollabs = new Set(); // collaborators selected in detail panel
let currentUser = '';   // logged-in username
let _loadGeneration = 0; // incremented on each loadAllRepos(); Phase 2 checks this to self-cancel

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
  setConfig({ token, lastUser: document.getElementById('batch-user').value.trim() });
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
    if (seen.has(r.full_name)) return false;
    seen.add(r.full_name);
    var hasPerm = !!(r.permission && Object.keys(r.permission).length > 0);
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

  function checkPermAllDone() {
    if (phaseAComplete && permDone >= permTotal && permAllResolve) {
      var resolve = permAllResolve;
      permAllResolve = null;
      resolve();
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
        try {
          var d = await giteeApi('GET', '/repos/' + repo.full_name);
          if (!d.permission) {
            repo.permissionError = true;
            appendLog('\u83b7\u53d6\u6743\u9650\u5931\u8d25: ' + repo.full_name + ' - API \u672a\u8fd4\u56de\u6743\u9650\u5b57\u6bb5', 'err');
          } else {
            repo.permission = d.permission;
          }
          repo.permissionLoaded = true;
        } catch (e) {
          repo.permissionLoaded = true;
          repo.permissionError = true;
          appendLog('\u83b7\u53d6\u6743\u9650\u5931\u8d25: ' + repo.full_name + ' - ' + e.message, 'err');
        }
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

  const includeOrg = document.getElementById('org-toggle').checked;
  const repoType = includeOrg ? 'all' : 'personal';

  // ── Phase A: user repos + org repos all concurrent ──────────
  var fetchTasks = [];

  // User repos — page by page
  fetchTasks.push((async function fetchUserRepos() {
    var page = 1;
    while (page <= 100) {
      if (_loadGeneration !== myGeneration) return;
      var data = await giteeApi('GET', '/user/repos?type=' + repoType + '&sort=full_name&per_page=100&page=' + page);
      if (!Array.isArray(data) || data.length === 0) break;
      var added = 0;
      for (var i = 0; i < data.length; i++) if (addRepo(data[i])) added++;
      if (added > 0) { updateProgress(); sortAndRender(); }
      if (data.length < 100) break;
      page++;
    }
  })());

  // Org repos — fetch org list then all orgs concurrently
  if (includeOrg) {
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
  }

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
    setStatus('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93', user.login);
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }

  if (permDone < permTotal) {
    setStatus('\u6b63\u5728\u83b7\u53d6\u6743\u9650 ' + permDone + '/' + permTotal + '\u2026', user.login);
    await new Promise(function(resolve) {
      permAllResolve = resolve;
      checkPermAllDone(); // catch the case where pool already finished
    });
  }

  if (_loadGeneration !== myGeneration) return;
  setBatchLoading(false);
  setStatus('\u5df2\u52a0\u8f7d ' + allRepos.length + ' \u4e2a\u4ed3\u5e93', user.login);
  appendLog('\u6743\u9650\u52a0\u8f7d\u5b8c\u6210', 'ok');
  sortAndRender();
  if (progressWrap) progressWrap.style.display = 'none';
}

// ============================================================
// Repo list rendering
// ============================================================
function getPermGroup(repo) {
  if (!repo.permissionLoaded) return 'loading';
  if (repo.permissionError) return 'error';
  const p = repo.permission;
  if (p.admin) return 'admin';
  if (p.push) return 'push';
  return 'pull';
}

function renderRepoList() {
  const container = document.getElementById('repo-list');
  container.innerHTML = '';
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();

  const groups = { loading: [], admin: [], push: [], pull: [], error: [] };
  for (var i = 0; i < allRepos.length; i++) {
    var r = allRepos[i];
    if (filter && r.full_name.toLowerCase().indexOf(filter) === -1) continue;
    groups[getPermGroup(r)].push(r);
  }

  const GROUP_META = [
    { key: 'error',   label: '\u6743\u9650\u83b7\u53d6\u5931\u8d25', cls: 'error' },
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
    var repo = allRepos[i];
    if (!repo.permissionLoaded) continue; // skip repos still loading permissions
    if (!filter || repo.full_name.toLowerCase().indexOf(filter) !== -1) {
      selectedRepos.add(repo.full_name);
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

  if (!repo.permissionLoaded) {
    var loadSpan = document.createElement('span');
    loadSpan.className = 'perm-badge perm-loading';
    loadSpan.textContent = '\u6743\u9650\u52a0\u8f7d\u4e2d\u2026';
    badges.appendChild(loadSpan);
  } else if (repo.permissionError) {
    var errSpan = document.createElement('span');
    errSpan.className = 'perm-badge perm-error';
    errSpan.textContent = '\u26a0\ufe0f \u6743\u9650\u83b7\u53d6\u5931\u8d25';
    badges.appendChild(errSpan);
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
    if (!repo.permissionLoaded) {
      addBtn.disabled = true;
      addBtn.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
    } else if (repo.permissionError) {
      addBtn.disabled = true;
      addBtn.title = '\u6743\u9650\u83b7\u53d6\u5931\u8d25\uff0c\u65e0\u6cd5\u786e\u8ba4\u7ba1\u7406\u5458\u6743\u9650';
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
  } catch (e) {
    if (fullName !== currentRepo) return;
    currentCollabs = []; currentCollabsRepo = null;
    collabList.innerHTML = '';
    var _errDiv = document.createElement('div'); _errDiv.className = 'err-text'; _errDiv.textContent = '\u52a0\u8f7d\u5931\u8d25: ' + e.message; collabList.appendChild(_errDiv);
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
  var permKnown = !!(repo && repo.permissionLoaded && !repo.permissionError);
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
        if (!permKnown) {
          permSelect.disabled = true;
          permSelect.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
        } else if (permKnown && !isAdmin) {
          permSelect.disabled = true;
          permSelect.title = '\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u624d\u80fd\u4fee\u6539';
        } else {
          permSelect.onchange = function() { updateCollabPermission(fullName, c.login, permSelect.value); };
        }
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger btn-sm';
      removeBtn.textContent = '\u79fb\u9664';
      if (!permKnown) {
        removeBtn.disabled = true;
        removeBtn.title = '\u6743\u9650\u52a0\u8f7d\u4e2d\uff0c\u8bf7\u7a0d\u5019';
      } else if (permKnown && !isAdmin) {
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
  var isSelf = currentUser && logins.some(function(l) { return l.toLowerCase() === currentUser.toLowerCase(); });
  var msg = isSelf
    ? '\u26a0\ufe0f \u8b66\u544a\uff1a\u9009\u4e2d\u5217\u8868\u4e2d\u5305\u542b\u300a\u4f60\u81ea\u5df1\u300b\uff0c\u5c06\u4fee\u6539\u4f60\u5728 ' + currentRepo + ' \u7684\u6743\u9650\u4e3a ' + permLabel + '\uff01\n\n\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f'
    : '\u786e\u5b9a\u5c06\u4ee5\u4e0b ' + logins.length + ' \u4f4d\u534f\u4f5c\u8005\u5728 ' + currentRepo + ' \u7684\u6743\u9650\u4fee\u6539\u4e3a ' + permLabel + '(' + permission + ')\uff1f\n\n' + logins.join(', ');
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
  appendLog('\u5f00\u59cb\u6279\u91cf\u4fee\u6539\u6743\u9650: ' + permission + ' (' + logins.length + ' \u4eba)', 'info');
  setStatus('\u6279\u91cf\u4fee\u6539\u6743\u9650\u4e2d\u2026 0/' + logins.length);

  var ok = 0, fail = 0;
  try {
    for (var i = 0; i < logins.length; i++) {
      setStatus('\u6279\u91cf\u4fee\u6539\u6743\u9650\u4e2d\u2026 ' + (i + 1) + '/' + logins.length, logins[i]);
      try {
        await giteeApi('PUT', '/repos/' + currentRepo + '/collaborators/' + logins[i], { permission: permission });
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
      setStatus('\u6279\u91cf\u79fb\u9664\u4e2d\u2026 ' + (i + 1) + '/' + logins.length, logins[i]);
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

async function updateCollabPermission(repoFullName, username, permission) {
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
    loadRepoDetail(repoFullName);
  } catch (e) {
    setStatus('\u66f4\u65b0\u5931\u8d25: ' + e.message);
    appendLog(repoFullName + ': \u66f4\u65b0 ' + username + ' \u5931\u8d25 - ' + e.message, 'err');
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
  if (!username) { setStatus('\u8bf7\u8f93\u5165\u7528\u6237\u540d'); return; }
  if (selectedRepos.size === 0) { setStatus('\u8bf7\u5148\u9009\u62e9\u4ed3\u5e93'); return; }
  setConfig({ token: getToken(), lastUser: username });

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
    var newLevel = PERM_LEVEL[permission] !== undefined ? PERM_LEVEL[permission] : -1;
    var demotionCount = 0;
    for (var di = 0; di < repos.length; di++) {
      var repo = allRepos.find(function(r) { return r.full_name === repos[di]; });
      if (repo && repo.permissionLoaded && !repo.permissionError) {
        var rp = repo.permission;
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
  if (skipped > 0) confirmMsg += '\n\n\uff08\u5df2\u81ea\u52a8\u8df3\u8fc7 ' + skipped + ' \u4e2a\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\u7684\u4ed3\u5e93\uff09';
  if (!confirm(confirmMsg)) return;

  const addBtn = document.querySelector('.batch-bar .btn-success');
  const removeBtn = document.querySelector('.batch-bar .btn-danger');
  const loadBtn = document.getElementById('load-btn');
  const addCollabBtn = document.getElementById('add-collab-btn');
  const collabUpdateBtn = document.getElementById('collab-batch-update-btn');
  const collabRmBtn = document.getElementById('collab-batch-remove-btn');
  if (addBtn) addBtn.disabled = true;
  if (removeBtn) removeBtn.disabled = true;
  if (loadBtn) loadBtn.disabled = true;
  if (addCollabBtn) addCollabBtn.disabled = true;
  if (collabUpdateBtn) collabUpdateBtn.disabled = true;
  if (collabRmBtn) collabRmBtn.disabled = true;
  clearLog();
  switchTab('log');
  if (skipped > 0) appendLog('\u5df2\u8df3\u8fc7 ' + skipped + ' \u4e2a\u4ed3\u5e93\uff08\u65e0\u7ba1\u7406\u5458\u6743\u9650\u6216\u6743\u9650\u4ecd\u5728\u52a0\u8f7d\u4e2d\uff09', 'info');
  appendLog('\u5f00\u59cb\u6279\u91cf\u6dfb\u52a0: ' + username + ' -> ' + permission + ' (' + repos.length + ' \u4e2a\u4ed3\u5e93)', 'info');
  setStatus('\u6279\u91cf\u6dfb\u52a0\u4e2d\u2026 0/' + repos.length);

  let ok = 0, fail = 0;
  try {
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
  } finally {
    if (addBtn) addBtn.disabled = false;
    if (removeBtn) removeBtn.disabled = false;
    if (loadBtn) loadBtn.disabled = false;
    if (addCollabBtn) addCollabBtn.disabled = false;
    if (collabUpdateBtn) collabUpdateBtn.disabled = false;
    if (collabRmBtn) collabRmBtn.disabled = false;
  }
  appendLog('\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25', ok > 0 && fail === 0 ? 'ok' : 'err');
  setStatus('\u6279\u91cf\u6dfb\u52a0\u5b8c\u6210: ' + ok + ' \u6210\u529f, ' + fail + ' \u5931\u8d25');
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
var _userSearchCache = {};

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
