import { state, PERM_LEVEL } from './state.js';
import { giteeApi, giteeApiFetchAll, isRetryableApiError } from './api.js';
import { setStatus, appendLog } from './utils.js';

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
  for (let i = 0; i < state.allRepos.length; i++) {
    if (state.allRepos[i] && state.allRepos[i].full_name === fullName) return state.allRepos[i];
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
  state.allRepos.push(added);
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
    return { ok: !isError, data: data, retryable: false };
  } catch (e) {
    for (let i = 0; i < targets.length; i++) applyRepoPermissionData(targets[i], null, true);
    if (!(options && options.silent)) appendLog('获取权限失败: ' + repo.full_name + ' - ' + e.message, 'err');
    return { ok: false, error: e, retryable: isRetryableApiError(e) };
  }
}

function createRepoPermissionBadgeWrap(repo) {
  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'repo-perm-badges';
  const outsideCurrentList = !!(repo && repo.outsideCurrentList);
  const permState = getRepoPermissionState(repo);

  function appendOutsideCurrentListBadge() {
    if (!outsideCurrentList) return;
    const span = document.createElement('span');
    span.className = 'perm-badge perm-note';
    span.textContent = '未加载到当前列表';
    badgeWrap.appendChild(span);
  }

  if (permState === 'loading') {
    const span = document.createElement('span');
    span.className = 'perm-badge perm-loading';
    span.textContent = '权限: 加载中';
    badgeWrap.appendChild(span);
    appendOutsideCurrentListBadge();
    return badgeWrap;
  }
  if (permState === 'failed') {
    const span = document.createElement('span');
    span.className = 'perm-badge perm-error';
    span.textContent = '权限请求失败';
    badgeWrap.appendChild(span);
    appendOutsideCurrentListBadge();
    return badgeWrap;
  }
  if (permState === 'unauthorized') {
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

function getCurrentPermLevel(repoFullName, username) {
  // Look up from cached collaborators
  var collab = state.currentCollabs.find(function(c) {
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

export { repoMatchesFilter, getRepoPermissionState, canSelectRepo, shouldClearRepoSelection, getRepoSelectionDisabledTitle, shouldCopyRestrictedRepoUrl, getRepoApiPath, applyRepoPermissionData, findMainRepoByFullName, ensureRepoInMainList, requestRepoPermission, createRepoPermissionBadgeWrap, getCurrentPermLevel, permLevelToLabel, fetchTargetUserPermLevel, precheckTargetUserPermissions, classifyDowngrades };
