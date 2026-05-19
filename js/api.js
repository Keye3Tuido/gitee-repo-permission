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

export { toggleTokenVisibility, rememberToken, clearTokenCache, getToken, giteeApi, giteeApiFetchAll };
