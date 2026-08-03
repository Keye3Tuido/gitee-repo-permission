import { state } from './state.js';
import { giteeApi, giteeApiFetchAll } from './api.js';

// Default number of org badges rendered inline; the rest collapse into "+N".
const DEFAULT_MAX_BADGES = 2;

// In-flight guards so concurrent callers share one request.
let myOrgsPromise = null;
let myOrgIndexPromise = null;

// The organizations the authenticated user belongs to.
function loadMyOrgs() {
  if (state._myOrgs) return Promise.resolve(state._myOrgs);
  if (myOrgsPromise) return myOrgsPromise;
  myOrgsPromise = giteeApi('GET', '/user/orgs?per_page=100')
    .then(function(orgs) {
      const list = (Array.isArray(orgs) ? orgs : []).map(function(o) {
        return { login: o.login, name: o.name };
      });
      state._myOrgs = list;
      return list;
    })
    .catch(function() { return null; })
    .then(function(r) { myOrgsPromise = null; return r; });
  return myOrgsPromise;
}

// Reverse index of MY organizations: login -> [org...].
// Gitee only exposes *public* org membership via /users/{login}/orgs, which is
// empty for most users. Listing members of orgs we belong to works regardless
// of the other person's visibility setting.
function loadMyOrgMemberIndex() {
  if (state._myOrgMemberIndex) return Promise.resolve(state._myOrgMemberIndex);
  if (myOrgIndexPromise) return myOrgIndexPromise;
  myOrgIndexPromise = loadMyOrgs()
    .then(function(list) {
      if (!list) throw new Error('orgs unavailable');
      return Promise.all(list.map(function(o) {
        return giteeApiFetchAll('/orgs/' + encodeURIComponent(o.login) + '/members')
          .then(function(members) { return { org: o, members: Array.isArray(members) ? members : [] }; })
          .catch(function() { return { org: o, members: [] }; });
      }));
    })
    .then(function(pairs) {
      const index = {};
      pairs.forEach(function(pair) {
        pair.members.forEach(function(m) {
          if (!m || !m.login) return;
          const key = m.login.toLowerCase();
          if (!index[key]) index[key] = [];
          index[key].push({ login: pair.org.login, name: pair.org.name, shared: true });
        });
      });
      state._myOrgMemberIndex = index;
      return index;
    })
    .catch(function() { return null; })
    .then(function(r) { myOrgIndexPromise = null; return r; });
  return myOrgIndexPromise;
}

// Per-user public orgs. Cached; failure resolves to null and is not cached.
function fetchUserPublicOrgs(login) {
  if (Object.prototype.hasOwnProperty.call(state._userOrgsCache, login)) {
    return Promise.resolve(state._userOrgsCache[login]);
  }
  if (state._pendingUserOrgs[login]) return state._pendingUserOrgs[login];
  const p = giteeApi('GET', '/users/' + encodeURIComponent(login) + '/orgs')
    .then(function(data) {
      const orgs = Array.isArray(data) ? data : [];
      state._userOrgsCache[login] = orgs;
      return orgs;
    })
    .catch(function() { return null; })
    .then(function(r) { delete state._pendingUserOrgs[login]; return r; });
  state._pendingUserOrgs[login] = p;
  return p;
}

// Merge two sources: orgs shared with me (reliable) + the user's public orgs.
// opts.publicOrgs === false -> index only, i.e. zero extra requests per user.
// Used for potentially long lists (repo collaborators) to avoid rate limiting.
function resolveUserOrgs(login, opts) {
  const wantPublic = !(opts && opts.publicOrgs === false);
  return Promise.all([
    loadMyOrgMemberIndex(),
    wantPublic ? fetchUserPublicOrgs(login) : Promise.resolve([])
  ]).then(function(res) {
    const index = res[0];
    const publicOrgs = res[1];
    const shared = (index && index[String(login).toLowerCase()]) || [];
    const merged = shared.slice();
    const seen = {};
    merged.forEach(function(o) { seen[String(o.login).toLowerCase()] = true; });
    (publicOrgs || []).forEach(function(o) {
      const key = String(o.login).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      merged.push({ login: o.login, name: o.name, shared: false });
    });
    // When the public source is skipped, the index alone decides failure.
    const failed = wantPublic ? (index === null && publicOrgs === null) : index === null;
    return { orgs: merged, failed: failed };
  });
}

// ---- "+N" hover popover: shows every org immediately ----
let orgPopover = null;

function hideOrgPopover() {
  if (orgPopover && orgPopover.remove) orgPopover.remove();
  orgPopover = null;
}

function showOrgPopover(anchor, orgs) {
  hideOrgPopover();
  // A fixed-position popover would visually detach on scroll/resize, and its
  // anchor may be re-rendered away while hovered (mouseleave then never fires).
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('scroll', hideOrgPopover, { once: true, capture: true });
    window.addEventListener('resize', hideOrgPopover, { once: true });
  }
  const pop = document.createElement('div');
  pop.className = 'org-popover';
  orgs.forEach(function(org) { pop.appendChild(makeOrgBadge(org)); });
  document.body.appendChild(pop);
  orgPopover = pop;

  // Position under the "+N" chip, kept inside the viewport.
  if (anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 260;
    const h = pop.offsetHeight || 0;
    let left = r.left;
    let top = r.bottom + 4;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (h && top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
}

function orgLabel(org) {
  const label = org.name || org.login || '';
  const at = org.login ? ' (' + org.login + ')' : '';
  return label + at + (org.shared === false ? ' \u2013 \u4ec5\u516c\u5f00\u4fe1\u606f' : '');
}


function makeOrgBadge(org) {
  const badge = document.createElement('span');
  badge.className = 'ud-org' + (org.shared === false ? '' : ' ud-org-shared');
  badge.textContent = org.name || org.login || '';
  // Per-badge title only: it explains a name truncated by CSS ellipsis.
  // The container / "+N" intentionally carry NO title, otherwise the native
  // tooltip (~1s delay) would pop up on top of the instant "+N" popover.
  badge.title = orgLabel(org);
  return badge;
}

// Shared badge renderer. Handles none / single / many (many -> "+N").
// opts: { max, emptyText, failedText }
function renderOrgBadges(container, result, opts) {
  const o = opts || {};
  const max = o.max || DEFAULT_MAX_BADGES;
  const orgs = (result && result.orgs) || [];
  // Any re-render may destroy a hovered "+N", whose mouseleave would then never
  // fire and leave the popover stranded on screen.
  hideOrgPopover();
  container.innerHTML = '';
  container.title = '';
  if (orgs.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'ud-org-none';
    hint.textContent = (result && result.failed)
      ? (o.failedText || '\u7ec4\u7ec7\u4fe1\u606f\u83b7\u53d6\u5931\u8d25')
      : (o.emptyText || '\u65e0\u5171\u540c\u7ec4\u7ec7');
    container.appendChild(hint);
    return;
  }
  orgs.slice(0, max).forEach(function(org) {
    container.appendChild(makeOrgBadge(org));
  });
  const hidden = orgs.slice(max);
  if (hidden.length > 0) {
    const more = document.createElement('span');
    more.className = 'ud-org ud-org-more';
    more.textContent = '+' + hidden.length;
    container.appendChild(more);

    // Hover "+N" -> instantly show ALL orgs in a floating panel (native title
    // has a ~1s delay). A popover on <body> avoids both layout shift and the
    // parent's overflow:hidden clipping (inline expansion gets squeezed flat).
    more.onmouseenter = function() { showOrgPopover(more, orgs); };
    more.onmouseleave = hideOrgPopover;
  }
}

// Render the signed-in user's own organizations into the top-right profile area.
function renderMyOrgsBadge() {
  const container = document.getElementById('current-user-orgs');
  if (!container) return Promise.resolve(null);
  container.innerHTML = '';
  const loading = document.createElement('span');
  loading.className = 'ud-org-none';
  loading.textContent = '\u7ec4\u7ec7\u52a0\u8f7d\u4e2d\u2026';
  container.appendChild(loading);
  return loadMyOrgs().then(function(list) {
    renderOrgBadges(container, { orgs: list || [], failed: list === null }, {
      max: 2,
      // For ourselves this really does mean "no orgs" (we can see our own).
      emptyText: '\u65e0\u7ec4\u7ec7',
    });
    return list;
  });
}

// Create an org row, resolve it asynchronously and render into it.
// isStale() lets callers discard results after a re-render / repo switch.
function attachOrgRow(login, opts) {
  const o = opts || {};
  const row = document.createElement('div');
  row.className = o.className || 'ud-orgs';
  const loading = document.createElement('span');
  loading.className = 'ud-org-none';
  loading.textContent = '\u7ec4\u7ec7\u52a0\u8f7d\u4e2d\u2026';
  row.appendChild(loading);
  if (!login) {
    renderOrgBadges(row, { orgs: [], failed: false }, o.render);
    return row;
  }
  resolveUserOrgs(login, o).then(function(result) {
    if (o.isStale && o.isStale()) return;
    renderOrgBadges(row, result, o.render);
  });
  return row;
}

// Org data is account-scoped: must be dropped when the token/account changes.
function resetOrgCaches() {
  state._myOrgs = null;
  state._myOrgMemberIndex = null;
  state._userOrgsCache = {};
  state._pendingUserOrgs = {};
  myOrgsPromise = null;
  myOrgIndexPromise = null;
}

export { loadMyOrgs, loadMyOrgMemberIndex, fetchUserPublicOrgs, resolveUserOrgs,
         renderOrgBadges, renderMyOrgsBadge, attachOrgRow, hideOrgPopover, resetOrgCaches };
