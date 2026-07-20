import { state } from './state.js';
import { giteeApi, isRetryableApiError } from './api.js';
import { extractRepoFullNamesFromText, hoverShow, hoverClear,
         copyTextToClipboard, setStatus, repoUrl } from './utils.js';
import { getRepoApiPath, shouldClearRepoSelection, canSelectRepo,
         createRepoPermissionBadgeWrap,
         getRepoPermissionState } from './permissions.js';
import { renderRepoList } from './repos.js';
import { showSubmoduleContextMenu } from './contextMenu.js';
import { registerPermRetry } from './permRetry.js';

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
  state.currentSubmodules = []; state.currentSubmodulesRepo = null;
  try {
    const subs = await getSubmoduleRepos(fullName);
    if (fullName !== state.currentRepo) return;
    if (!subs || subs.length === 0) {
      wrap.innerHTML = '<div class="loading-text">暂无子模块</div>';
      if (countEl) countEl.textContent = '';
      return;
    }
    // initialize submodule objects and render loading state
    state.currentSubmodules = subs.map(function(s) {
      return { full_name: s, name: s.split('/').slice(-1)[0], permission: {}, permissionLoaded: false, permissionError: false, html_url: 'https://gitee.com/' + s };
    });
    state.currentSubmodulesRepo = fullName;
    renderSubmoduleList();

    // fetch permission for each submodule in parallel
    try {
      const promises = state.currentSubmodules.map(function(sub) {
        return giteeApi('GET', getRepoApiPath(sub.full_name)).then(function(d) {
          return { ok: true, data: d };
        }).catch(function(err) {
          return { ok: false, err: err };
        });
      });
      const results = await Promise.all(promises);
      if (fullName !== state.currentRepo) return;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const sub = state.currentSubmodules[i];
        if (res && res.ok && res.data) {
          sub.permission = res.data.permission || {};
          sub.permissionLoaded = true;
          sub.permissionError = false;
        } else {
          var subErr = res && res.err;
          var subStatus = subErr && subErr.status;
          sub.permission = {};
          sub.permissionLoaded = true;
          if (subStatus === 403 || subStatus === 404) {
            // 403/404 = 无访问权限（如未加入相应团队）→ 归“无权限”，而非请求失败，不重试
            sub.permissionError = false;
          } else {
            sub.permissionError = true;
            if (isRetryableApiError(subErr)) registerSubmoduleRetry(fullName, sub);
          }
        }
      }
      renderSubmoduleList();
    } catch (e) {
      // if something unexpected happened, mark all as errored
      for (let i = 0; i < state.currentSubmodules.length; i++) {
        const sub = state.currentSubmodules[i];
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

function registerSubmoduleRetry(repoFullName, sub) {
  registerPermRetry('sub:' + repoFullName + ':' + sub.full_name, {
    label: sub.full_name,
    isValid: function() {
      return state.currentRepo === repoFullName
        && state.currentSubmodulesRepo === repoFullName
        && state.currentSubmodules.indexOf(sub) !== -1
        && !!sub.permissionError;
    },
    run: function() {
      return giteeApi('GET', getRepoApiPath(sub.full_name)).then(function(d) {
        if (d && d.permission) {
          sub.permission = d.permission;
          sub.permissionLoaded = true;
          sub.permissionError = false;
          renderSubmoduleList();
          return 'ok';
        }
        return 'stop';
      }).catch(function(err) { return isRetryableApiError(err) ? 'retry' : 'stop'; });
    }
  });
}

function renderSubmoduleList() {
  const wrap = document.getElementById('submodule-list');
  const countEl = document.getElementById('submodule-count');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!state.currentSubmodules || state.currentSubmodules.length === 0) {
    wrap.innerHTML = '<div class="loading-text">暂无子模块</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = '(' + state.currentSubmodules.length + ')';

  // header handled in HTML; render list
  for (let i = 0; i < state.currentSubmodules.length; i++) {
    const s = state.currentSubmodules[i];
    const div = document.createElement('div');
    div.className = 'repo-item';

    if (shouldClearRepoSelection(s)) state.selectedRepos.delete(s.full_name);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedRepos.has(s.full_name);
    const hasPerm = canSelectRepo(s);
    if (!hasPerm) cb.disabled = true;
    cb.onclick = function(e) {
      e.stopPropagation();
      if (cb.checked) state.selectedRepos.add(s.full_name);
      else state.selectedRepos.delete(s.full_name);
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
    div.oncontextmenu = function(e) {
      e.preventDefault();
      showSubmoduleContextMenu(s, e.clientX, e.clientY);
    };

    div.appendChild(createRepoPermissionBadgeWrap(s));
    wrap.appendChild(div);
  }

  // update select-all checkbox state
  const selAllEl = document.getElementById('submodule-select-all');
  if (selAllEl) {
    const selectable = state.currentSubmodules.filter(function(x) { return canSelectRepo(x); });
    const selCount = selectable.filter(function(x) { return state.selectedRepos.has(x.full_name); }).length;
    selAllEl.checked = selectable.length > 0 && selCount === selectable.length;
    selAllEl.indeterminate = selCount > 0 && selCount < selectable.length;
  }
}

function toggleSelectAllSubmodules() {
  if (!state.currentSubmodules || state.currentSubmodules.length === 0) return;
  const selAllEl = document.getElementById('submodule-select-all');
  const selectable = state.currentSubmodules.filter(function(x) { return canSelectRepo(x); });
  if (!selAllEl.checked) {
    // unselect all
    selectable.forEach(function(s) { state.selectedRepos.delete(s.full_name); });
  } else {
    selectable.forEach(function(s) { state.selectedRepos.add(s.full_name); });
  }
  renderSubmoduleList();
  renderRepoList();
}

async function copySubmoduleUrlsByFilter(filterFn, emptyMsg, successMsg) {
  if (!state.currentSubmodules || state.currentSubmodules.length === 0) {
    setStatus('当前没有可复制的子模块');
    return;
  }
  const targets = state.currentSubmodules.filter(filterFn);
  if (targets.length === 0) {
    setStatus(emptyMsg);
    return;
  }
  const urls = targets.map(repoUrl).join('\n');
  try {
    await copyTextToClipboard(urls);
    setStatus(successMsg.replace('{count}', targets.length));
  } catch (e) {
    setStatus('复制失败: ' + e.message);
  }
}

async function copyUnauthorizedSubmoduleUrls() {
  await copySubmoduleUrlsByFilter(
    function(sub) { return getRepoPermissionState(sub) === 'unauthorized'; },
    '当前子模块中没有无权限的仓库',
    '已复制 {count} 个无权限的子模块链接'
  );
}

async function copyNonAdminSubmoduleUrls() {
  await copySubmoduleUrlsByFilter(
    function(sub) { return getRepoPermissionState(sub) !== 'admin'; },
    '所有子模块均有管理权限',
    '已复制 {count} 个无管理权限的子模块链接'
  );
}

async function copySelectedSubmoduleUrls() {
  await copySubmoduleUrlsByFilter(
    function(sub) { return state.selectedRepos.has(sub.full_name); },
    '请先选中子模块',
    '已复制 {count} 个子模块链接'
  );
}

async function copyPullOnlySubmoduleUrls() {
  await copySubmoduleUrlsByFilter(
    function(sub) { return getRepoPermissionState(sub) === 'pull'; },
    '当前子模块中没有只读权限的仓库',
    '已复制 {count} 个只读权限的子模块链接'
  );
}

async function copyFailedSubmoduleUrls() {
  await copySubmoduleUrlsByFilter(
    function(sub) { return getRepoPermissionState(sub) === 'failed'; },
    '当前子模块中没有权限请求失败的仓库',
    '已复制 {count} 个权限请求失败的子模块链接'
  );
}

export { getSubmoduleRepos, loadSubmodules, renderSubmoduleList, toggleSelectAllSubmodules, copyUnauthorizedSubmoduleUrls, copyNonAdminSubmoduleUrls, copySelectedSubmoduleUrls, copyPullOnlySubmoduleUrls, copyFailedSubmoduleUrls };
