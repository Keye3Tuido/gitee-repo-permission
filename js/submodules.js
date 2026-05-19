import { state } from './state.js';
import { giteeApi } from './api.js';
import { extractRepoFullNamesFromText, hoverShow, hoverClear,
         copyTextToClipboard, setStatus } from './utils.js';
import { getRepoApiPath, shouldClearRepoSelection, canSelectRepo,
         createRepoPermissionBadgeWrap, shouldCopyRestrictedRepoUrl } from './permissions.js';
import { renderRepoList } from './repos.js';

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

    // fetch permission for each submodule
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
          sub.permission = {};
          sub.permissionLoaded = true;
          sub.permissionError = true;
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

async function copyUnauthorizedSubmoduleUrls() {
  if (!state.currentSubmodules || state.currentSubmodules.length === 0) {
    setStatus('当前没有可复制的子模块');
    return;
  }
  const targets = state.currentSubmodules.filter(function(sub) {
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

export { getSubmoduleRepos, loadSubmodules, renderSubmoduleList, toggleSelectAllSubmodules, copyUnauthorizedSubmoduleUrls };
