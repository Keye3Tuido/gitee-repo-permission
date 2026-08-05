import { setStatus, appendLog } from './utils.js';

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

// Retry-After 的采纳上限：避免服务端给出很大的值时界面长时间无响应
const MAX_RETRY_AFTER_MS = 10000;

// 请求标识：带上方法与路径，让每条报错都能定位到具体接口
function apiLabel(method, path) {
  return method + ' ' + String(path).split('?')[0];
}

// fetch 被 reject 时浏览器不提供任何状态码，控制台只给 CORS / net::ERR_FAILED。
// 这里把"可能的成因"写进消息，避免用户只看到无意义的 Failed to fetch。
function networkErrorMessage(label, offline, rawMessage) {
  if (offline) {
    return '请求失败: ' + label + ' — 浏览器当前处于离线状态';
  }
  return '请求失败: ' + label + ' — 未收到响应'
    + '（可能是浏览器扩展/网络拦截、跨域预检被拦或网络中断；'
    + '控制台会显示为 CORS 或 net::ERR_FAILED。可开无痕窗口禁用扩展后重试）'
    + (rawMessage ? ' [' + rawMessage + ']' : '');
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
  const label = apiLabel(method, path);
  let r;
  try {
    r = await fetch(url.toString(), opts);
  } catch (netErr) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const e = new Error(networkErrorMessage(label, offline, netErr && netErr.message));
    e.isNetworkError = true;
    e.offline = offline;
    e.method = method; e.path = path; e.label = label;
    e.cause = netErr;
    throw e;
  }
  if (r.status === 204) return null;
  const clone = r.clone();
  const data = await r.json().catch(async function() {
    const body = await clone.text().catch(function() { return ''; });
    return { message: body ? body.slice(0, 200) : 'parse error' };
  });
  if (!r.ok) {
    var retryAfter = null;
    try {
      var ra = r.headers && r.headers.get ? r.headers.get('Retry-After') : null;
      // 只认数值形式（也可能是 HTTP-date，那种就退回指数退避）；
      // 并且必须设上限——服务端给个 3600 就等一小时，界面等于卡死。
      if (ra && !isNaN(Number(ra))) {
        retryAfter = Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS);
      }
    } catch (e) { /* headers 不可读时忽略 */ }
    var apiErr = new Error('API ' + r.status + ': ' + (data.message || r.statusText) + ' [' + label + ']');
    apiErr.status = r.status;
    apiErr.method = method; apiErr.path = path; apiErr.label = label;
    if (retryAfter) apiErr.retryAfter = retryAfter;
    throw apiErr;
  }
  return data;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function logQuietly(msg, type) {
  // 日志面板可能不存在（如脚本早于 DOM、或被单独复用）；
  // 记日志失败绝不能盖掉真正的业务错误。
  try { appendLog(msg, type); } catch (e) { /* ignore */ }
}

// 网络类失败（含被拦截而表现为 CORS 失败的情形）与 408/429/5xx 自动指数退避重试。
// 每次重试都写日志：否则"重试了几次、为什么"对用户完全不可见，排查时没有线索。
//
// 只对幂等方法（GET/HEAD）自动重试：网络类失败无法区分"请求没发出去"和
// "已生效但响应丢了"，对 POST/PUT/DELETE 重试可能重复执行（例如重复添加协作者）。
// 确有需要时显式传 { allowUnsafeRetry: true }。
// options: { attempts, silent, allowUnsafeRetry }
async function giteeApiRetry(method, path, body, options) {
  const opts = options || {};
  const attempts = opts.attempts || 3;
  const label = apiLabel(method, path);
  const idempotent = method === 'GET' || method === 'HEAD';
  if (!idempotent && !opts.allowUnsafeRetry) return giteeApi(method, path, body);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await giteeApi(method, path, body);
      if (i > 0 && !opts.silent) {
        logQuietly(label + ' 第 ' + (i + 1) + ' 次尝试成功', 'ok');
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (!isRetryableApiError(e)) throw e;
      if (i === attempts - 1) {
        if (!opts.silent) {
          logQuietly(label + ' 重试 ' + attempts + ' 次后仍失败: ' + e.message, 'err');
        }
        throw e;
      }
      // 服务端明确给了 Retry-After 就照它等，否则指数退避 + 抖动
      const wait = e.retryAfter || (500 * Math.pow(2, i) + Math.floor(Math.random() * 250));
      if (!opts.silent) {
        logQuietly(label + ' 第 ' + (i + 1) + '/' + attempts + ' 次失败: ' + e.message
          + ' — ' + wait + 'ms 后重试' + (e.retryAfter ? '（服务端要求）' : ''), 'info');
      }
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function giteeApiFetchAll(path) {
  const results = []; let page = 1;
  while (page <= 100) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await giteeApiRetry('GET', path + sep + 'per_page=100&page=' + page);
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
export { toggleTokenVisibility, rememberToken, clearTokenCache, getToken, giteeApi, giteeApiRetry, giteeApiFetchAll, isRetryableApiError };
