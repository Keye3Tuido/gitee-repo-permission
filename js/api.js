import { setStatus } from './utils.js';

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
  let r;
  try {
    r = await fetch(url.toString(), opts);
  } catch (netErr) {
    netErr.isNetworkError = true;
    throw netErr;
  }
  if (r.status === 204) return null;
  const clone = r.clone();
  const data = await r.json().catch(async function() {
    const body = await clone.text().catch(function() { return ''; });
    return { message: body ? body.slice(0, 200) : 'parse error' };
  });
  if (!r.ok) {
    var apiErr = new Error('API ' + r.status + ': ' + (data.message || r.statusText));
    apiErr.status = r.status;
    throw apiErr;
  }
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

function isRetryableApiError(err) {
  if (!err) return false;
  if (err.isNetworkError) return true;
  var status = err.status;
  if (status === 408 || status === 429) return true;
  return typeof status === "number" && status >= 500;
}
export { toggleTokenVisibility, rememberToken, clearTokenCache, getToken, giteeApi, giteeApiFetchAll, isRetryableApiError };
