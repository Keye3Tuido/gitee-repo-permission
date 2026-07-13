import { copyTextToClipboard, setStatus, repoUrl } from './utils.js';

let activeMenuId = null;

function showContextMenu(options) {
  const { id, x, y, item, label, onCopy } = options;
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = id;

  const copyItem = document.createElement('div');
  copyItem.className = 'context-menu-item';
  copyItem.textContent = label;
  copyItem.onclick = async function() {
    closeContextMenu();
    try {
      await onCopy(item);
    } catch (e) {
      setStatus('复制失败: ' + e.message);
    }
  };

  menu.appendChild(copyItem);
  document.body.appendChild(menu);

  // 边界检测
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 10;
  const maxY = window.innerHeight - rect.height - 10;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';

  activeMenuId = id;

  function closeOnClick(e) {
    if (!menu.contains(e.target)) {
      closeContextMenu();
      document.removeEventListener('click', closeOnClick);
      document.removeEventListener('keydown', closeOnEsc);
    }
  }
  function closeOnEsc(e) {
    if (e.key === 'Escape') {
      closeContextMenu();
      document.removeEventListener('click', closeOnClick);
      document.removeEventListener('keydown', closeOnEsc);
    }
  }
  setTimeout(function() {
    document.addEventListener('click', closeOnClick);
    document.addEventListener('keydown', closeOnEsc);
  }, 0);
}

function closeContextMenu() {
  if (activeMenuId) {
    const existing = document.getElementById(activeMenuId);
    if (existing) existing.remove();
    activeMenuId = null;
  }
}

function showRepoContextMenu(repo, x, y) {
  showContextMenu({
    id: 'repo-context-menu',
    x: x,
    y: y,
    item: repo,
    label: '📋 复制仓库链接',
    onCopy: async function(repo) {
      await copyTextToClipboard(repoUrl(repo));
      setStatus('已复制: ' + repo.full_name);
    }
  });
}

function showSubmoduleContextMenu(submodule, x, y) {
  showContextMenu({
    id: 'submodule-context-menu',
    x: x,
    y: y,
    item: submodule,
    label: '📋 复制子模块链接',
    onCopy: async function(submodule) {
      await copyTextToClipboard(repoUrl(submodule));
      setStatus('已复制: ' + submodule.full_name);
    }
  });
}

export { showRepoContextMenu, showSubmoduleContextMenu, closeContextMenu };
