import { state } from './state.js';
import { getToken } from './api.js';

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
  if (state._userSearchCache[query]) {
    renderUserDropdown(state._userSearchCache[query], dropdownEl, inputEl);
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
    state._userSearchCache[query] = data;
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

export { setupUserSearch, doUserSearch, renderUserDropdown, closeUserDropdown };
