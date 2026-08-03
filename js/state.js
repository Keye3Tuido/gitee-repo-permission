export const state = {
  allRepos: [],
  selectedRepos: new Set(),
  currentRepo: null,
  collapsedGroups: new Set(),
  currentCollabs: [],
  currentCollabsRepo: null,
  selectedCollabs: new Set(),
  currentUser: '',
  currentSubmodules: [],
  currentSubmodulesRepo: null,
  currentSubmodulesBranch: null,
  currentBranches: [],
  _loadGeneration: 0,
  _userSearchCache: {},
  _userOrgsCache: {},
  _pendingUserOrgs: {},
  _myOrgs: null,
  _myOrgMemberIndex: null,
};

export const PERM_LEVEL = { pull: 0, push: 1, admin: 2 };
