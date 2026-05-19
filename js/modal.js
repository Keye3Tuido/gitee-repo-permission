function showDowngradeDecisionModal(opts) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal modal-wide';

    var h3 = document.createElement('h3');
    h3.textContent = '⚠️ 检测到权限降级';
    h3.style.color = 'var(--warning)';
    modal.appendChild(h3);

    var desc = document.createElement('div');
    desc.className = 'clipboard-modal-hint';
    desc.textContent = opts.headerText || '';
    modal.appendChild(desc);

    if (opts.isSelf) {
      var selfNote = document.createElement('div');
      selfNote.style.color = 'var(--danger)';
      selfNote.style.fontWeight = '600';
      selfNote.style.margin = '.25rem 0 .75rem';
      selfNote.textContent = '⛔ 警告：操作涉及【你自己】，降级后可能无法自行恢复！';
      modal.appendChild(selfNote);
    }

    function buildSection(title, rows, rowBg, makeRow) {
      if (!rows || rows.length === 0) return;
      var wrap = document.createElement('div');
      var t = document.createElement('div');
      t.style.fontWeight = '600';
      t.style.margin = '.75rem 0 .25rem 0';
      t.textContent = title + ' (' + rows.length + ')';
      wrap.appendChild(t);
      var list = document.createElement('div');
      list.className = 'clipboard-modal-list';
      for (var i = 0; i < rows.length; i++) {
        var item = document.createElement('div');
        item.className = 'clipboard-repo-item';
        item.style.background = rowBg;
        item.appendChild(makeRow(rows[i]));
        list.appendChild(item);
      }
      wrap.appendChild(list);
      modal.appendChild(wrap);
    }

    buildSection('降级' + (opts.scope || '仓库'), opts.downgrades, '#fff4e6', function(r) {
      var main = document.createElement('div');
      main.className = 'clipboard-repo-main';
      var name = document.createElement('div');
      name.className = 'clipboard-repo-name';
      name.textContent = r.title;
      var sub = document.createElement('div');
      sub.className = 'clipboard-repo-url';
      sub.textContent = r.sub;
      main.appendChild(name);
      main.appendChild(sub);
      return main;
    });

    buildSection('权限未知（预检失败）', opts.failed, '#f5f5f5', function(r) {
      var main = document.createElement('div');
      main.className = 'clipboard-repo-main';
      var name = document.createElement('div');
      name.className = 'clipboard-repo-name';
      name.textContent = r.title;
      var sub = document.createElement('div');
      sub.className = 'clipboard-repo-url';
      sub.textContent = '无法确定该' + (opts.scope === '协作者' ? '协作者' : '用户') + '的现有权限';
      main.appendChild(name);
      main.appendChild(sub);
      return main;
    });

    if (opts.mode === 'batch' && opts.safeCount > 0) {
      var safeSummary = document.createElement('div');
      safeSummary.className = 'clipboard-modal-status';
      safeSummary.style.marginTop = '.5rem';
      safeSummary.textContent = '另有 ' + opts.safeCount + ' 个非降级' + (opts.scope || '仓库') + '（新增或同级 / 升级），不受影响。';
      modal.appendChild(safeSummary);
    }

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    function close(result) { overlay.remove(); resolve(result); }

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function() { close('cancel'); };
    actions.appendChild(cancelBtn);

    if (opts.mode === 'batch') {
      var skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-primary';
      skipBtn.textContent = '忽略降级（仅执行 ' + opts.safeCount + ' 个非降级）';
      skipBtn.disabled = !opts.safeCount;
      if (skipBtn.disabled) skipBtn.title = '没有可执行的非降级项';
      skipBtn.onclick = function() { close('skip'); };
      actions.appendChild(skipBtn);
    }

    var keepBtn = document.createElement('button');
    keepBtn.className = 'btn btn-danger';
    keepBtn.textContent = opts.mode === 'batch' ? '保留降级（按选择全部执行）' : '保留降级（继续执行）';
    keepBtn.onclick = function() { close('keep'); };
    actions.appendChild(keepBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close('cancel'); });
    document.getElementById('modal-container').appendChild(overlay);
  });
}

export { showDowngradeDecisionModal };
