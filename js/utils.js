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

function repoUrl(item) {
  if (item && item.html_url) return item.html_url;
  var fullName = item && item.full_name ? item.full_name : '';
  return 'https://gitee.com/' + fullName;
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

export { setStatus, hoverShow, hoverClear, appendLog, clearLog, extractRepoFullNamesFromText, repoUrl, fallbackCopyText, copyTextToClipboard, readTextFromClipboard };
