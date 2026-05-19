function switchTab(tab) {
  var detailEl = document.getElementById('tab-detail');
  var logEl = document.getElementById('tab-log');
  if (detailEl) detailEl.style.display = tab === 'detail' ? '' : 'none';
  if (logEl) logEl.style.display = tab === 'log' ? '' : 'none';
  var btns = document.querySelectorAll('#tab-bar button');
  if (btns && btns.length >= 2) {
    btns[0].classList.toggle('active', tab === 'detail');
    btns[1].classList.toggle('active', tab === 'log');
  }
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

export { switchTab, switchMobileTab };
