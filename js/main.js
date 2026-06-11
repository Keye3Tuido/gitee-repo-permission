import { state } from './state.js';
import * as api from './api.js';
import * as repos from './repos.js';
import * as collabs from './collabs.js';
import * as batch from './batch.js';
import * as submodules from './submodules.js';
import * as tabs from './tabs.js';
import { setupUserSearch } from './userSearch.js';

// ── Init: restore token from localStorage ──
(function init() {
  var saved = localStorage.getItem('gitee_perm_token') || '';
  if (saved) document.getElementById('token-input').value = saved;
  document.getElementById('batch-user').value = '';
})();

// ── Event listeners ──
document.getElementById('repo-search').addEventListener('input', function() {
  repos.renderRepoList();
});

document.getElementById('token-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') repos.loadAllRepos();
});

// Collab search filter
(function() {
  var el = document.getElementById('collab-search');
  if (el) {
    el.addEventListener('input', function() {
      collabs.renderCollabList(el.value);
    });
  }
})();

// Attach to batch-user input
(function() {
  var batchInput = document.getElementById('batch-user');
  var batchDropdown = document.getElementById('batch-user-dropdown');
  if (batchInput && batchDropdown) setupUserSearch(batchInput, batchDropdown);
})();

// Initialize mobile: show repos tab by default
(function() {
  if (window.innerWidth <= 768) {
    tabs.switchMobileTab('repos');
  }
})();

// ── Expose functions referenced by inline onclick in index.html ──
Object.assign(window, {
  // api.js
  toggleTokenVisibility: api.toggleTokenVisibility,
  rememberToken: api.rememberToken,
  clearTokenCache: api.clearTokenCache,
  // repos.js
  loadAllRepos: repos.loadAllRepos,
  toggleSelectAllVisible: repos.toggleSelectAllVisible,
  openClipboardSelectModal: repos.openClipboardSelectModal,
  copySelectedRepoUrls: repos.copySelectedRepoUrls,
  // collabs.js
  promptAddCollab: collabs.promptAddCollab,
  toggleSelectAllCollabs: collabs.toggleSelectAllCollabs,
  batchCollabUpdatePerm: collabs.batchCollabUpdatePerm,
  batchCollabRemove: collabs.batchCollabRemove,
  // batch.js
  batchAddCollab: batch.batchAddCollab,
  batchRemoveCollab: batch.batchRemoveCollab,
  // submodules.js
  toggleSelectAllSubmodules: submodules.toggleSelectAllSubmodules,
  copyUnauthorizedSubmoduleUrls: submodules.copyUnauthorizedSubmoduleUrls,
  copyNonAdminSubmoduleUrls: submodules.copyNonAdminSubmoduleUrls,
  copySelectedSubmoduleUrls: submodules.copySelectedSubmoduleUrls,
  copyPullOnlySubmoduleUrls: submodules.copyPullOnlySubmoduleUrls,
  // tabs.js
  switchTab: tabs.switchTab,
  switchMobileTab: tabs.switchMobileTab,
  // dropdown menus
  toggleSubmoduleMenu: toggleSubmoduleMenu,
  closeSubmoduleMenu: closeSubmoduleMenu,
});

function toggleSubmoduleMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('submodule-dropdown');
  if (menu.style.display === 'none') {
    menu.style.display = 'block';
    setTimeout(function() {
      document.addEventListener('click', closeSubmoduleMenu);
      document.addEventListener('keydown', onSubmoduleMenuEsc);
    }, 0);
  } else {
    closeSubmoduleMenu();
  }
}

function closeSubmoduleMenu() {
  const menu = document.getElementById('submodule-dropdown');
  if (menu) menu.style.display = 'none';
  document.removeEventListener('click', closeSubmoduleMenu);
  document.removeEventListener('keydown', onSubmoduleMenuEsc);
}

function onSubmoduleMenuEsc(e) {
  if (e.key === 'Escape') closeSubmoduleMenu();
}
