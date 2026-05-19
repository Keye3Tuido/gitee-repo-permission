import { state } from './state.js';
import { giteeApi, giteeApiFetchAll, getToken } from './api.js';
import { setStatus, appendLog, copyTextToClipboard } from './utils.js';
import { repoMatchesFilter, getRepoPermissionState, canSelectRepo,
         shouldClearRepoSelection, getRepoSelectionDisabledTitle,
         shouldCopyRestrictedRepoUrl, requestRepoPermission,
         createRepoPermissionBadgeWrap, findMainRepoByFullName,
         ensureRepoInMainList } from './permissions.js';
import { extractRepoFullNamesFromText, hoverShow, hoverClear } from './utils.js';
import { switchMobileTab } from './tabs.js';
import { loadRepoDetail, updateDetailPermBadges } from './collabs.js';
import { renderSubmoduleList } from './submodules.js';

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
  state.allRepos = []; state.selectedRepos.clear(); state.currentRepo = null;
  state._userSearchCache = {};
  document.getElementById('detail-placeholder').style.display = '';
  document.getElementById('detail-content').style.display = 'none';
  const myGeneration = ++state._loadGeneration;

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
    state.allRepos.push({
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
    state.allRepos.sort(function(a, b) { return a.full_name.localeCompare(b.full_name); });
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
    const pending = state.allRepos.filter(function(repo) { return !repo.permissionLoaded; });
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
    if (labelEl) labelEl.textContent = '\u4ed3\u5e93: ' + state.allRepos.length + ' \u4e2a';
    if (permEl)  permEl.textContent  = permTotal > 0 ? ('\u6743\u9650: ' + permDone + '/' + permTotal) : '';
    if (fillEl && permTotal > 0) fillEl.style.width = Math.round(permDone / permTotal * 100) + '%';
    if (phaseAComplete && permTotal > 0) setStatus('\u6b63\u5728\u83b7\u53d6\u6743\u9650 ' + permDone + '/' + permTotal + '\u2026');
  }

  async function permWorker() {
    try {
      while (permQueue.length > 0) {
        if (state._loadGeneration !== myGeneration) return;
        var repo = permQueue.shift();
        await requestRepoPermission(repo);
        permDone++;
        if (repo.full_name === state.currentRepo) updateDetailPermBadges(repo.full_name);
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
    var added = state.allRepos[state.allRepos.length - 1];
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
  state.currentUser = user.login;
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
      if (state._loadGeneration !== myGeneration) return;
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
              if (state._loadGeneration !== myGeneration) return;
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

  appendLog('\u4ed3\u5e93\u5217\u8868\u52a0\u8f7d\u5b8c\u6210: ' + state.allRepos.length + ' \u4e2a', 'ok');

  // Phase A done — unlock button; switch progress bar to determinate
  btn.disabled = false; btn.textContent = '\u52a0\u8f7d\u4ed3\u5e93';
  if (progressWrap) progressWrap.classList.remove('progress-indeterminate');
  phaseAComplete = true;

  // ── Phase B: wait for permission pool to drain ──────────────
  if (permTotal === 0) {
    setBatchLoading(false);
    setStatus('\u5df2\u52a0\u8f7d ' + state.allRepos.length + ' \u4e2a\u4ed3\u5e93');
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

  if (state._loadGeneration !== myGeneration) return;
  setBatchLoading(false);
  setStatus('\u5df2\u52a0\u8f7d ' + state.allRepos.length + ' \u4e2a\u4ed3\u5e93');
  appendLog('\u6743\u9650\u52a0\u8f7d\u5b8c\u6210', 'ok');
  sortAndRender();
  if (progressWrap) progressWrap.style.display = 'none';
}

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
  for (var i = 0; i < state.allRepos.length; i++) {
    var r = state.allRepos[i];
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
    var toggleChar = state.collapsedGroups.has(gm.key) ? '\u25B6' : '\u25BC';
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
        if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
        else state.collapsedGroups.add(key);
        renderRepoList();
      };
    })(gm.key);
    container.appendChild(header);

    if (!state.collapsedGroups.has(gm.key)) {
      for (var ri = 0; ri < repos.length; ri++) {
        (function(repo) {
          const div = document.createElement('div');
          div.className = 'repo-item' + (state.currentRepo === repo.full_name ? ' selected' : '');

          if (shouldClearRepoSelection(repo)) state.selectedRepos.delete(repo.full_name);
          const selectable = canSelectRepo(repo);

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = state.selectedRepos.has(repo.full_name);
          cb.disabled = !selectable;
          if (!selectable) cb.title = getRepoSelectionDisabledTitle(repo);
          cb.onclick = function(e) {
            e.stopPropagation();
            if (cb.checked) state.selectedRepos.add(repo.full_name);
            else state.selectedRepos.delete(repo.full_name);
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
            state.currentRepo = repo.full_name;
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
    const visibleSelectable = state.allRepos.filter(function(repo) {
      return repoMatchesFilter(repo, filter) && canSelectRepo(repo);
    });
    const selectedCount = visibleSelectable.filter(function(repo) {
      return state.selectedRepos.has(repo.full_name);
    }).length;
    repoSelectAllEl.disabled = visibleSelectable.length === 0;
    repoSelectAllEl.checked = visibleSelectable.length > 0 && selectedCount === visibleSelectable.length;
    repoSelectAllEl.indeterminate = selectedCount > 0 && selectedCount < visibleSelectable.length;
  }
}



function toggleSelectAllVisible() {
  const repoSelectAllEl = document.getElementById('repo-select-all');
  if (!repoSelectAllEl) return;
  const filter = document.getElementById('repo-search').value.trim().toLowerCase();
  const visibleSelectable = state.allRepos.filter(function(repo) {
    return repoMatchesFilter(repo, filter) && canSelectRepo(repo);
  });
  if (visibleSelectable.length === 0) {
    repoSelectAllEl.checked = false;
    repoSelectAllEl.indeterminate = false;
    return;
  }
  if (!repoSelectAllEl.checked) {
    visibleSelectable.forEach(function(repo) { state.selectedRepos.delete(repo.full_name); });
  } else {
    visibleSelectable.forEach(function(repo) { state.selectedRepos.add(repo.full_name); });
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
    state.allRepos.forEach(remember);
    state.currentSubmodules.forEach(remember);
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
      if (shouldClearRepoSelection(repo)) state.selectedRepos.delete(repo.full_name);
      const enabled = canSelectRepo(repo);
      if (repo.outsideCurrentList) outsideCurrentListCount++;
      else inCurrentList++;
      if (enabled) selectable++;
      if (state.selectedRepos.has(repo.full_name)) selected++;

      const row = document.createElement('div');
      row.className = 'clipboard-repo-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selectedRepos.has(repo.full_name);
      cb.disabled = !enabled;
      if (!enabled) cb.title = getRepoSelectionDisabledTitle(repo);
      cb.onclick = function(e) {
        e.stopPropagation();
        if (cb.checked) state.selectedRepos.add(repo.full_name);
        else state.selectedRepos.delete(repo.full_name);
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
        if (canSelectRepo(parsedRepos[i])) state.selectedRepos.delete(parsedRepos[i].full_name);
      }
    } else {
      for (let i = 0; i < parsedRepos.length; i++) {
        const repo = parsedRepos[i];
        if (canSelectRepo(repo)) state.selectedRepos.add(repo.full_name);
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

export { setBatchLoading, loadAllRepos, getPermGroup, renderRepoList, toggleSelectAllVisible, selectAllVisible, deselectAll, openClipboardSelectModal };
