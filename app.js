"use strict";

/* ---------- API client (talks to the Node/Express + MongoDB server in server/) ---------- */
const API_BASE = '/api';
let authToken = localStorage.getItem('genesis_token') || null;

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  opts.headers = Object.assign({}, opts.headers);
  if (opts.body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 204) return null;
  let json = null;
  try { json = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((json && json.error) || 'Erro inesperado.');
    err.status = res.status;
    err.apiMessage = (json && json.error) || 'Não foi possível completar a ação. Tente novamente.';
    throw err;
  }
  return json;
}
function apiErrorMessage(e) { return (e && e.apiMessage) || 'Não foi possível completar a ação. Tente novamente.'; }

/* ---------- constants ---------- */
const COLS = [
  { id: 'backlog', name: 'Backlog', dot: '#5F6878' },
  { id: 'todo', name: 'A Fazer', dot: '#8CBEFF' },
  { id: 'doing', name: 'Em Andamento', dot: '#0B71F5' },
  { id: 'review', name: 'Revisão', dot: '#F5A70B' },
  { id: 'done', name: 'Concluído', dot: '#2ECC8F' }
];
const PRIO = { Alta: '#FF4D5E', Média: '#F5A70B', Baixa: '#5F8CB8' };

/* ---------- escaping helpers (dynamic content is rendered via innerHTML) ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function brl(v) { return 'R$ ' + (v / 1000).toFixed(0) + 'k'; }
function timeAgo(ts) {
  if (!ts) return 'agora';
  const diffMs = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return 'há ' + min + ' min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'há ' + h + ' h';
  const d = Math.floor(h / 24);
  return 'há ' + d + (d === 1 ? ' dia' : ' dias');
}

/* ---------- state ---------- */
let state = {
  authReady: false, authed: false, currentUserId: null,
  loginEmail: '', loginPass: '', loginError: '', loginBusy: false,
  inviteError: '', inviteBusy: false,
  screen: 'dash', projectFilter: 'all', query: '', openId: null, projectId: null,
  form: null, draft: {}, commentDraft: '', dragId: null, showInvite: false,
  users: [], projects: [], tasks: []
};

function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = Object.assign({}, state, next);
  withFocusPreserved(render);
}

/* ---------- core logic ---------- */
function me() { return state.users.find(u => u.id === state.currentUserId) || { id: state.currentUserId, name: 'Carregando…', role: '', email: '', initials: '··', color: '#5F6878', isAdmin: false }; }
function user(id) { return state.users.find(u => u.id === id) || { id: id, name: '—', role: '—', email: '—', initials: '—', color: '#5F6878' }; }
function project(id) { return state.projects.find(p => p.id === id) || { id: id, name: '—', desc: '', color: '#5F6878', due: '—', status: '—', budget: 1, spent: 0, rate: '—' }; }
function colName(id) { return (COLS.find(c => c.id === id) || COLS[0]).name; }
function go(screen, extra) { setState(Object.assign({ screen: screen }, extra || {})); }

let pollHandle = null;

async function loadAllData() {
  const [usersRes, projectsRes, tasksRes] = await Promise.all([
    api('/users'), api('/projects'), api('/tasks')
  ]);
  setState({ users: usersRes.users, projects: projectsRes.projects, tasks: tasksRes.tasks });
}

function startSession(token, userObj) {
  authToken = token;
  localStorage.setItem('genesis_token', token);
  setState({ authed: true, authReady: true, currentUserId: userObj.id, loginError: '', loginPass: '', loginBusy: false });
  loadAllData().catch(e => console.error(e));
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => { if (state.authed) loadAllData().catch(() => {}); }, 8000);
}

function stopSession() {
  authToken = null;
  localStorage.removeItem('genesis_token');
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  setState({
    authed: false, authReady: true, currentUserId: null,
    users: [], projects: [], tasks: [], screen: 'dash', projectFilter: 'all',
    openId: null, form: null, showInvite: false, loginBusy: false
  });
}

async function bootstrapAuth() {
  if (!authToken) return setState({ authReady: true });
  try {
    const { user: me } = await api('/auth/me');
    startSession(authToken, me);
  } catch (e) {
    stopSession();
  }
}

async function login() {
  const email = state.loginEmail.trim().toLowerCase(), pass = state.loginPass;
  if (!email || !pass) return setState({ loginError: 'Informe e-mail e senha.' });
  setState({ loginBusy: true, loginError: '' });
  try {
    const { token, user: userObj } = await api('/auth/login', { method: 'POST', body: { email, password: pass } });
    startSession(token, userObj);
  } catch (e) {
    setState({ loginError: apiErrorMessage(e), loginBusy: false });
  }
}

function logout() { stopSession(); }

async function inviteUser() {
  const d = state.draft;
  if (!me().isAdmin) return;
  setState({ inviteBusy: true, inviteError: '' });
  try {
    const { user: newUser } = await api('/users', {
      method: 'POST',
      body: { name: d.name, email: d.email, password: d.pass, role: d.role, isAdmin: d.isAdmin === 'true' }
    });
    setState(s => ({ users: s.users.concat([newUser]), form: null, inviteBusy: false }));
  } catch (e) {
    setState({ inviteError: apiErrorMessage(e), inviteBusy: false });
  }
}

function augment(t) {
  const p = project(t.projectId), u = user(t.assigneeId);
  const total = t.checklist.length, done = t.checklist.filter(c => c.done).length;
  return Object.assign({}, t, {
    projectName: p.name, projectColor: p.color, colName: colName(t.col),
    initials: u.initials, avatarColor: u.color, prioColor: PRIO[t.priority] || PRIO.Baixa,
    checkLabel: total ? done + '/' + total : '—',
    checkPct: total ? Math.round(done / total * 100) : 0,
    dueColor: t.col === 'done' ? '#5F6878' : '#8A93A6'
  });
}

function buildBoard(list, projectId) {
  const q = state.query.trim().toLowerCase();
  const filtered = list.filter(t => !q || t.title.toLowerCase().indexOf(q) >= 0);
  return COLS.map(c => {
    const tasks = filtered.filter(t => t.col === c.id).map(t => augment(t));
    return {
      id: c.id, name: c.name, dot: c.dot, count: tasks.length, tasks: tasks,
      border: c.id === 'done' ? 'rgba(46,204,143,.18)' : 'rgba(246,253,255,.07)',
      bg: c.id === 'doing' ? 'rgba(11,113,245,.06)' : 'rgba(246,253,255,.02)',
      colId: c.id,
      addSeedProjectId: projectId || (state.projectFilter !== 'all' && state.projectFilter) || (state.projects[0] && state.projects[0].id) || ''
    };
  });
}

function openForm(kind, seed) {
  if (kind === 'user' && !me().isAdmin) return;
  if (kind === 'task' && !state.projects.length) kind = 'project';
  const d = Object.assign({
    title: '', desc: '',
    projectId: (state.projects[0] && state.projects[0].id) || '',
    assigneeId: (state.users[0] && state.users[0].id) || me().id,
    priority: 'Média', due: '', hours: '', col: 'todo', name: '', email: '', role: '', pass: '', isAdmin: 'false'
  }, seed || {});
  setState({ form: kind, draft: d, openId: null, inviteError: '' });
}
function setDraft(k, v) { setState(s => ({ draft: Object.assign({}, s.draft, { [k]: v }) })); }

function submit() {
  const d = state.draft, kind = state.form;
  if (kind === 'task') {
    if (!d.title.trim()) return;
    setState({ form: null });
    api('/tasks', {
      method: 'POST',
      body: { title: d.title, desc: d.desc, projectId: d.projectId, assigneeId: d.assigneeId, col: d.col, priority: d.priority, due: d.due, hours: d.hours }
    }).then(({ task }) => setState(s => ({ tasks: s.tasks.concat([task]) }))).catch(e => console.error(e));
  } else if (kind === 'project') {
    if (!d.name.trim()) return;
    setState({ form: null });
    api('/projects', { method: 'POST', body: { name: d.name, desc: d.desc, due: d.due, hours: d.hours } })
      .then(({ project: p }) => setState(s => ({ projects: s.projects.concat([p]) }))).catch(e => console.error(e));
  } else if (kind === 'user') {
    inviteUser();
  }
}

function patchTask(id, patch) {
  setState(s => ({ tasks: s.tasks.map(t => t.id === id ? Object.assign({}, t, patch) : t) }));
  api('/tasks/' + id, { method: 'PATCH', body: patch }).catch(e => console.error(e));
}

function deleteTask(id) {
  setState(s => ({ openId: null, tasks: s.tasks.filter(t => t.id !== id) }));
  api('/tasks/' + id, { method: 'DELETE' }).catch(e => console.error(e));
}

function addComment() {
  const txt = state.commentDraft.trim(), id = state.openId;
  if (!txt || !id) return;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const m = me();
  const comments = t.comments.concat([{ who: m.name, when: 'agora', text: txt, initials: m.initials, color: m.color }]);
  setState({ commentDraft: '' });
  patchTask(id, { comments });
}

/* ---------- view model (ported from renderVals()) ---------- */
function computeView() {
  const s = state, m = me();
  const mine = s.tasks.filter(t => t.assigneeId === m.id);
  const scoped = s.projectFilter === 'all' ? s.tasks : s.tasks.filter(t => t.projectId === s.projectFilter);

  const screens = {
    dash: ['Visão geral', 'Bom te ver, ' + m.name.split(' ')[0]],
    mine: ['Minhas tarefas', 'Atribuídas a mim'],
    board: ['Quadro geral', 'Kanban da equipe'],
    projects: ['Projetos', 'Todos os projetos'],
    project: ['Projeto', s.projectId ? project(s.projectId).name : 'Projeto'],
    team: ['Equipe', 'Pessoas e acessos'],
    finance: ['Financeiro', 'Orçamento por projeto']
  };
  const cur = screens[s.screen] || screens.dash;

  const navDef = [
    ['dash', 'Dashboard', 'ph ph-squares-four', null],
    ['mine', 'Minhas tarefas', 'ph ph-user-focus', mine.filter(t => t.col !== 'done').length],
    ['board', 'Quadro geral', 'ph ph-kanban', s.tasks.filter(t => t.col !== 'done').length],
    ['projects', 'Projetos', 'ph ph-folders', s.projects.length],
    ['team', 'Equipe', 'ph ph-users-three', s.users.length],
    ['finance', 'Financeiro', 'ph ph-chart-line-up', null]
  ];
  const nav = navDef.map(n => {
    const active = s.screen === n[0] || (n[0] === 'projects' && s.screen === 'project');
    return {
      id: n[0], label: n[1], icon: n[2], count: n[3],
      bg: active ? 'rgba(11,113,245,.14)' : 'transparent',
      border: active ? 'rgba(11,113,245,.45)' : 'transparent',
      color: active ? '#F6FDFF' : '#8A93A6'
    };
  });

  const projectFilters = [{ id: 'all', label: 'Todos' }].concat(s.projects.map(p => ({ id: p.id, label: p.name }))).map(f => {
    const on = s.projectFilter === f.id;
    return {
      id: f.id, label: f.label, bg: on ? 'rgba(11,113,245,.16)' : 'transparent',
      border: on ? 'rgba(11,113,245,.5)' : 'rgba(246,253,255,.1)',
      color: on ? '#8CBEFF' : '#8A93A6'
    };
  });

  const projectCards = s.projects.map(p => {
    const ts = s.tasks.filter(t => t.projectId === p.id);
    const done = ts.filter(t => t.col === 'done').length;
    const pct = ts.length ? Math.round(done / ts.length * 100) : 0;
    const team = [];
    ts.forEach(t => { const u = user(t.assigneeId); if (!team.some(mm => mm.initials === u.initials)) team.push({ initials: u.initials, color: u.color }); });
    return Object.assign({}, p, {
      pct: pct, pctLabel: pct + '%', doneLabel: done + ' de ' + ts.length + ' tarefas', team: team,
      statusColor: p.status === 'Em risco' ? '#FF7A86' : p.status === 'Planejado' ? '#8A93A6' : '#2ECC8F'
    });
  });

  const openTask = s.openId ? s.tasks.find(t => t.id === s.openId) : null;
  let modalTask = null;
  if (openTask) {
    modalTask = augment(openTask);
    modalTask.checklist = openTask.checklist.map((c, i) => ({
      t: c.t, i: i, icon: c.done ? 'ph-fill ph-check-square' : 'ph ph-square',
      iconColor: c.done ? '#0B71F5' : '#6F7A8D', color: c.done ? '#6F7A8D' : '#F6FDFF',
      deco: c.done ? 'line-through' : 'none'
    }));
  }

  const pj = (s.projectId ? project(s.projectId) : s.projects[0]) || { id: null, name: 'Nenhum projeto', color: '#5F6878', due: '—', status: '—', budget: 1, spent: 0, rate: '—' };
  const pjTasks = s.tasks.filter(t => t.projectId === pj.id);
  const pjDone = pjTasks.filter(t => t.col === 'done').length;

  const budgets = s.projects.map(p => {
    const pct = Math.round(p.spent / p.budget * 100);
    return { name: p.name, color: p.color, spent: brl(p.spent), budget: brl(p.budget), pct: pct, pctLabel: pct + '%', pctColor: pct > 90 ? '#FF7A86' : pct > 70 ? '#F5A70B' : '#2ECC8F', rate: p.rate };
  });

  const isBoard = s.screen === 'board' || s.screen === 'mine';
  const boardList = s.screen === 'mine' ? mine.filter(t => s.projectFilter === 'all' || t.projectId === s.projectFilter) : scoped;

  const formTitles = { task: ['Nova tarefa', 'criar tarefa'], project: ['Novo projeto', 'criar projeto'], user: ['Convidar pessoa', 'criar acesso'] };
  const ft = formTitles[s.form] || formTitles.task;
  const d = s.draft;
  const field = (label, key, opts) => Object.assign({ label: label, key: key, value: d[key] || '', placeholder: '', isText: true, isSelect: false, isArea: false }, opts || {});
  let formFields = [];
  if (s.form === 'task') formFields = [
    field('Título', 'title', { placeholder: 'O que precisa ser feito' }),
    field('Descrição', 'desc', { isText: false, isArea: true, placeholder: 'Contexto e critério de pronto' }),
    field('Projeto', 'projectId', { isText: false, isSelect: true, options: s.projects.map(p => ({ id: p.id, name: p.name })) }),
    field('Atribuir para', 'assigneeId', { isText: false, isSelect: true, options: s.users.map(u => ({ id: u.id, name: u.name + (u.id === m.id ? ' (eu)' : '') })) }),
    field('Coluna', 'col', { isText: false, isSelect: true, options: COLS.map(c => ({ id: c.id, name: c.name })) }),
    field('Prioridade', 'priority', { isText: false, isSelect: true, options: ['Alta', 'Média', 'Baixa'].map(p => ({ id: p, name: p })) }),
    field('Prazo', 'due', { placeholder: 'ex: 12 set' }),
    field('Estimativa (h)', 'hours', { placeholder: 'ex: 8' })
  ];
  if (s.form === 'project') formFields = [
    field('Nome do projeto', 'name', { placeholder: 'ex: App mobile' }),
    field('Descrição', 'desc', { isText: false, isArea: true, placeholder: 'Objetivo do projeto' }),
    field('Responsável', 'assigneeId', { isText: false, isSelect: true, options: s.users.map(u => ({ id: u.id, name: u.name })) }),
    field('Prazo', 'due', { placeholder: 'ex: 30 out' }),
    field('Orçamento (R$ mil)', 'hours', { placeholder: 'ex: 60' })
  ];
  if (s.form === 'user') formFields = [
    field('Nome', 'name', { placeholder: 'Nome completo' }),
    field('E-mail', 'email', { placeholder: 'nome@empresa.com' }),
    field('Função', 'role', { placeholder: 'ex: Engenharia' }),
    field('Senha temporária', 'pass', { placeholder: 'pelo menos 6 caracteres' }),
    field('Também vai ser admin?', 'isAdmin', { isText: false, isSelect: true, options: [{ id: 'false', name: 'Não' }, { id: 'true', name: 'Sim, pode adicionar gente' }] })
  ];
  return {
    authReady: s.authReady, isLogin: !s.authed, authed: s.authed,
    loginBusy: s.loginBusy,
    loginEmail: s.loginEmail, loginPass: s.loginPass, loginError: s.loginError,
    showInvite: s.showInvite, inviteError: s.inviteError, inviteBusy: s.inviteBusy,
    me: m, users: s.users, nav: nav, query: s.query,
    screenKicker: cur[0], screenTitle: cur[1],
    isDash: s.screen === 'dash', isBoard: isBoard, isProjects: s.screen === 'projects',
    isProject: s.screen === 'project', isTeam: s.screen === 'team', isFinance: s.screen === 'finance',

    kpis: [
      { label: 'Tarefas abertas', value: String(s.tasks.filter(t => t.col !== 'done').length), sub: 'em ' + s.projects.length + ' projetos', icon: 'ph ph-list-checks' },
      { label: 'Minhas tarefas', value: String(mine.filter(t => t.col !== 'done').length), sub: mine.filter(t => t.col === 'doing').length + ' em andamento', icon: 'ph ph-user-focus' },
      { label: 'Concluídas', value: String(s.tasks.filter(t => t.col === 'done').length), sub: 'no total', icon: 'ph ph-check-circle' }
    ],
    dashTasks: mine.filter(t => t.col !== 'done').slice(0, 4).map(t => augment(t)),
    activity: s.tasks.filter(t => t.createdAt).slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map(t => {
        const creator = t.createdById ? user(t.createdById) : null;
        const label = (creator || { name: t.createdBy || 'Alguém' }).name.split(' ')[0];
        const u = creator || { initials: '—', color: '#5F6878' };
        return { initials: u.initials, color: u.color, text: label + ' criou a tarefa ' + t.title, when: timeAgo(t.createdAt) };
      }),

    projectFilters: projectFilters,
    board: buildBoard(boardList, s.projectFilter === 'all' ? null : s.projectFilter),
    projectCards: projectCards,
    projectBoard: buildBoard(pjTasks, pj.id),
    projectStats: [
      { label: 'Progresso', value: (pjTasks.length ? Math.round(pjDone / pjTasks.length * 100) : 0) + '%' },
      { label: 'Tarefas', value: pjDone + ' / ' + pjTasks.length },
      { label: 'Prazo', value: pj.due },
      { label: 'Orçamento usado', value: Math.round(pj.spent / pj.budget * 100) + '%' }
    ],

    teamCards: s.users.map(u => ({
      id: u.id, name: u.name, role: u.role, email: u.email, initials: u.initials, color: u.color, isAdmin: !!u.isAdmin,
      openCount: s.tasks.filter(t => t.assigneeId === u.id && t.col !== 'done').length,
      doneCount: s.tasks.filter(t => t.assigneeId === u.id && t.col === 'done').length
    })),

    budgets: budgets,

    modalTask: modalTask, openTask: openTask, colOptions: COLS.map(c => ({ id: c.id, name: c.name })),
    prioOptions: ['Alta', 'Média', 'Baixa'].map(p => {
      const on = openTask && openTask.priority === p;
      return {
        label: p, bg: on ? PRIO[p] + '22' : 'transparent', border: on ? PRIO[p] : 'rgba(246,253,255,.12)',
        color: on ? PRIO[p] : '#8A93A6'
      };
    }),
    commentDraft: s.commentDraft,

    showForm: !!s.form, formTitle: ft[0], formCta: ft[1], formFields: formFields
  };
}

/* ---------- handler registry (rebuilt every render) + hover delegation ---------- */
let handlers = new Map();
let _hid = 0;
function on(fn) { const id = 'h' + (_hid++); handlers.set(id, fn); return id; }

function bindOnce() {
  document.addEventListener('click', e => { const el = e.target.closest('[data-click]'); if (el) { const f = handlers.get(el.dataset.click); if (f) f(e); } });
  document.addEventListener('input', e => { const el = e.target.closest('[data-input]'); if (el) { const f = handlers.get(el.dataset.input); if (f) f(e); } });
  document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (el) { const f = handlers.get(el.dataset.change); if (f) f(e); } });
  document.addEventListener('keydown', e => { const el = e.target.closest('[data-keydown]'); if (el) { const f = handlers.get(el.dataset.keydown); if (f) f(e); } });
  document.addEventListener('dragstart', e => { const el = e.target.closest('[data-dragstart]'); if (el) { const f = handlers.get(el.dataset.dragstart); if (f) f(e); } });
  document.addEventListener('dragover', e => { const el = e.target.closest('[data-dragover]'); if (el) { const f = handlers.get(el.dataset.dragover); if (f) f(e); } });
  document.addEventListener('drop', e => { const el = e.target.closest('[data-drop]'); if (el) { const f = handlers.get(el.dataset.drop); if (f) f(e); } });

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-hover]');
    if (el && !el.dataset.hovering) {
      el.dataset.hovering = '1';
      el.dataset.baseStyle = el.getAttribute('style') || '';
      el.setAttribute('style', el.dataset.baseStyle + ';' + el.dataset.hover);
    }
  });
  document.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-hover]');
    if (el && el.dataset.hovering) {
      const related = e.relatedTarget;
      if (related && el.contains(related)) return;
      delete el.dataset.hovering;
      el.setAttribute('style', el.dataset.baseStyle);
    }
  });
}

/* ---------- focus preservation across full re-renders ---------- */
function withFocusPreserved(fn) {
  const active = document.activeElement;
  let field = null, start = null, end = null, supportsSelection = false;
  if (active && active.dataset && active.dataset.field) {
    field = active.dataset.field;
    try {
      if (active.selectionStart != null) { start = active.selectionStart; end = active.selectionEnd; supportsSelection = true; }
    } catch (e) { /* input types like email/number don't support selection APIs */ }
  }
  fn();
  if (field) {
    const el = document.querySelector('[data-field="' + field.replace(/"/g, '') + '"]');
    if (el) {
      el.focus();
      if (supportsSelection && el.setSelectionRange) {
        try { el.setSelectionRange(start, end); } catch (e) {}
      } else if ('value' in el) {
        // types without selection support (email, number, ...) always land the caret at the end on refocus
        try { const v = el.value; el.value = ''; el.value = v; } catch (e) {}
      }
    }
  }
}

/* ---------- small UI builders ---------- */
function hoverAttr(hoverCss) { return hoverCss ? ` data-hover="${escAttr(hoverCss)}"` : ''; }

function selectHTML(field, changeFn, options, current, extraStyle) {
  const id = on(changeFn);
  return `<select data-field="${escAttr(field)}" data-change="${id}" style="width:100%; padding:${extraStyle || '8px 10px'}; border-radius:8px; border:1px solid rgba(246,253,255,.12); background:#111725; color:#F6FDFF; font-size:12.5px; outline:none">
    ${options.map(o => `<option value="${escAttr(o.id)}" ${String(o.id) === String(current) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
  </select>`;
}

/* ---------- templates ---------- */
function tLogin(V) {
  return `
  <div style="min-height:100vh; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.05fr); background:#000107; background-image:radial-gradient(900px 600px at 78% 8%, rgba(11,113,245,.2), transparent 68%); font-size:14px">
    <div style="display:flex; flex-direction:column; justify-content:center; gap:34px; padding:56px 60px; border-right:1px solid rgba(246,253,255,.07)">
      <div style="display:flex; align-items:center; gap:18px">
        <img src="assets/genesis-logo.jpg" alt="Genesis" style="width:82px; height:82px; object-fit:contain; filter:invert(1) brightness(1.15); mix-blend-mode:lighten">
        <div>
          <div style="font-size:22px; letter-spacing:.24em; font-weight:400">GENESIS</div>
          <div style="font-size:11px; color:#6F7A8D; letter-spacing:.16em; text-transform:uppercase; margin-top:5px">Sistema de operações</div>
        </div>
      </div>
      <div style="max-width:380px">
        <h1 style="margin:0 0 14px; font-size:30px; font-weight:400; line-height:1.25; letter-spacing:-.01em; text-wrap:pretty">Tudo o que a equipe está fazendo, em um só quadro.</h1>
        <p style="margin:0; font-size:13.5px; line-height:1.65; color:#8A93A6; text-wrap:pretty">Projetos, tarefas, atribuições e financeiro. Entre com sua conta para ver o que é seu e o que está com o time.</p>
      </div>
      <div style="display:flex; gap:26px; font-size:11px; color:#5F6878; letter-spacing:.14em; text-transform:uppercase">
        <span>Tecnologia</span><span>Confiança</span><span>Performance</span>
      </div>
    </div>

    <div style="display:flex; align-items:center; justify-content:center; padding:56px 44px">
      <div style="width:100%; max-width:372px; padding:30px; border-radius:14px; border:1px solid rgba(246,253,255,.1); background:linear-gradient(165deg, #10151F, #090C13); box-shadow:0 26px 70px rgba(0,0,0,.6)">
        <h2 style="margin:0 0 6px; font-size:19px; font-weight:400">Entrar</h2>
        <p style="margin:0 0 24px; font-size:12.5px; color:#8A93A6">Use o e-mail corporativo da sua conta.</p>
        <div style="display:flex; flex-direction:column; gap:15px">
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">E-mail</div>
            <input data-field="loginEmail" data-input="${on(e => setState({ loginEmail: e.target.value, loginError: '' }))}" data-keydown="${on(e => { if (e.key === 'Enter') login(); })}" value="${escAttr(V.loginEmail)}" type="email" placeholder="nome@suaempresa.com" autocomplete="username" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(246,253,255,.12); background:#111725; color:#F6FDFF; font-size:13px; outline:none">
          </div>
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:7px">
              <span style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D">Senha</span>
              <a href="#" style="font-size:11px">esqueci a senha</a>
            </div>
            <input data-field="loginPass" data-input="${on(e => setState({ loginPass: e.target.value, loginError: '' }))}" data-keydown="${on(e => { if (e.key === 'Enter') login(); })}" value="${escAttr(V.loginPass)}" type="password" placeholder="••••••••" autocomplete="current-password" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(246,253,255,.12); background:#111725; color:#F6FDFF; font-size:13px; outline:none">
          </div>
          ${V.loginError ? `
          <div style="display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:8px; border:1px solid rgba(255,77,94,.35); background:rgba(255,77,94,.08); font-size:12px; color:#FF9AA3">
            <i class="ph ph-warning-circle" style="font-size:14px"></i>${esc(V.loginError)}
          </div>` : ''}
          <button data-click="${on(() => login())}" ${V.loginBusy ? 'disabled' : ''} style="margin-top:4px; padding:11px; border-radius:8px; border:1px solid #0B71F5; background:rgba(11,113,245,.14); color:#8CBEFF; font-size:13px"${hoverAttr('background:rgba(11,113,245,.28); color:#F6FDFF')}>${V.loginBusy ? 'Aguarde…' : 'Entrar'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function tSidebar(V) {
  return `
  <aside style="width:238px; flex:none; border-right:1px solid rgba(246,253,255,.07); padding:22px 14px; display:flex; flex-direction:column; gap:26px; position:sticky; top:0; height:100vh">
    <div style="display:flex; align-items:center; gap:11px; padding:0 8px">
      <img src="assets/genesis-logo.jpg" alt="Genesis" style="width:38px; height:38px; flex:none; object-fit:contain; filter:invert(1) brightness(1.12); mix-blend-mode:lighten">
      <div>
        <div style="font-size:14px; font-weight:500; letter-spacing:.16em">GENESIS</div>
        <div style="font-size:10px; color:#6F7A8D; letter-spacing:.12em; text-transform:uppercase">Operações</div>
      </div>
    </div>

    <nav style="display:flex; flex-direction:column; gap:2px">
      ${V.nav.map(n => `
        <button data-click="${on(() => go(n.id))}" style="display:flex; align-items:center; gap:10px; width:100%; text-align:left; padding:9px 11px; border-radius:8px; border:1px solid ${n.border}; background:${n.bg}; color:${n.color}; font-size:13px; transition:background .15s, color .15s"${hoverAttr('background:rgba(246,253,255,.05); color:#F6FDFF')}>
          <i class="${n.icon}" style="font-size:17px"></i>
          <span style="flex:1">${esc(n.label)}</span>
          ${n.count != null ? `<span style="font-size:11px; color:#6F7A8D">${n.count}</span>` : ''}
        </button>
      `).join('')}
    </nav>

    <div style="margin-top:auto; display:flex; flex-direction:column; gap:12px">
      <button data-click="${on(() => openForm('task'))}" style="display:flex; align-items:center; justify-content:center; gap:8px; padding:10px; border-radius:8px; border:1px solid #0B71F5; background:transparent; color:#8CBEFF; font-size:13px"${hoverAttr('background:rgba(11,113,245,.14); color:#F6FDFF')}>
        <i class="ph ph-plus" style="font-size:15px"></i>Nova tarefa
      </button>
      <div style="display:flex; align-items:center; gap:10px; padding:9px 8px; border-top:1px solid rgba(246,253,255,.07)">
        <div style="width:28px; height:28px; border-radius:50%; background:rgba(11,113,245,.18); border:1px solid rgba(11,113,245,.45); color:#8CBEFF; font-size:11px; display:flex; align-items:center; justify-content:center">${esc(V.me.initials)}</div>
        <div style="min-width:0; flex:1">
          <div style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(V.me.name)}</div>
          <div style="font-size:10px; color:#6F7A8D">${esc(V.me.role)}</div>
        </div>
        <button data-click="${on(() => logout())}" title="Sair" style="width:26px; height:26px; flex:none; border-radius:7px; border:1px solid rgba(246,253,255,.1); background:none; color:#6F7A8D; display:flex; align-items:center; justify-content:center"${hoverAttr('color:#FF9AA3; border-color:rgba(255,77,94,.4)')}><i class="ph ph-sign-out" style="font-size:13px"></i></button>
      </div>
    </div>
  </aside>`;
}

function taskCard(t, small) {
  return `
  <div draggable="true" data-dragstart="${on(e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); state.dragId = t.id; })}" data-click="${on(() => setState({ openId: t.id, commentDraft: '' }))}" style="padding:12px; border-radius:9px; border:1px solid rgba(246,253,255,.08); background:#111725; cursor:pointer; display:flex; flex-direction:column; gap:9px; box-shadow:0 1px 2px rgba(0,0,0,.5)"${hoverAttr('border-color:rgba(11,113,245,.55); background:#141B2B')}>
    <div style="display:flex; align-items:center; gap:7px">
      <span style="width:5px; height:5px; border-radius:50%; background:${t.projectColor}"></span>
      <span style="font-size:10.5px; color:#8A93A6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(t.projectName)}</span>
    </div>
    <div style="font-size:13px; line-height:1.35; text-wrap:pretty">${esc(t.title)}</div>
    <div style="display:flex; gap:5px; flex-wrap:wrap">
      ${t.tags.map(tag => `<span style="font-size:10px; padding:2px 6px; border-radius:5px; background:rgba(246,253,255,.06); color:#8A93A6">${esc(tag)}</span>`).join('')}
    </div>
    <div style="display:flex; align-items:center; gap:8px; font-size:10.5px; color:#6F7A8D">
      <span style="width:20px; height:20px; border-radius:50%; background:${t.avatarColor}22; border:1px solid ${t.avatarColor}55; color:${t.avatarColor}; font-size:9px; display:flex; align-items:center; justify-content:center">${esc(t.initials)}</span>
      <span style="display:flex; align-items:center; gap:3px"><i class="ph ph-check-square-offset" style="font-size:12px"></i>${esc(t.checkLabel)}</span>
      <span style="margin-left:auto; display:flex; align-items:center; gap:4px; color:${t.dueColor}"><i class="ph ph-calendar-blank" style="font-size:12px"></i>${esc(t.due)}</span>
    </div>
    <div style="height:2px; border-radius:2px; background:${t.prioColor}; opacity:.65"></div>
  </div>`;
}

function boardColumn(c) {
  return `
  <div data-dragover="${on(e => e.preventDefault())}" data-drop="${on(e => { e.preventDefault(); const id = state.dragId; if (!id) return; setState(s => ({ dragId: null, tasks: s.tasks.map(t => t.id === id ? Object.assign({}, t, { col: c.colId }) : t) })); })}" style="display:flex; flex-direction:column; gap:10px; padding:11px; border-radius:11px; border:1px solid ${c.border}; background:${c.bg}; min-height:220px">
    <div style="display:flex; align-items:center; gap:8px; padding:2px 3px 8px; border-bottom:1px solid rgba(246,253,255,.07)">
      <span style="width:5px; height:5px; border-radius:50%; background:${c.dot}"></span>
      <span style="font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:#C4CCDA">${esc(c.name)}</span>
      <span style="margin-left:auto; font-size:11px; color:#6F7A8D">${c.count}</span>
    </div>
    ${c.tasks.map(t => taskCard(t)).join('')}
    <button data-click="${on(() => openForm('task', { col: c.colId, projectId: c.addSeedProjectId }))}" style="padding:8px; border-radius:8px; border:1px dashed rgba(246,253,255,.13); background:none; color:#6F7A8D; font-size:11.5px"${hoverAttr('color:#8CBEFF; border-color:rgba(11,113,245,.5)')}>+ adicionar</button>
  </div>`;
}

function tDash(V) {
  return `
  <div style="display:flex; flex-direction:column; gap:26px">
    <div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px">
      ${V.kpis.map(k => `
        <div style="padding:16px 17px; border-radius:10px; border:1px solid rgba(246,253,255,.08); background:linear-gradient(160deg, #10151F, #0B0E17)">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px">
            <span style="font-size:11px; color:#6F7A8D; letter-spacing:.1em; text-transform:uppercase">${esc(k.label)}</span>
            <i class="${k.icon}" style="font-size:16px; color:#4A9BFF"></i>
          </div>
          <div style="font-size:25px; font-weight:400; letter-spacing:-.01em">${esc(k.value)}</div>
          <div style="font-size:11.5px; color:#6F7A8D; margin-top:5px">${esc(k.sub)}</div>
        </div>`).join('')}
    </div>

    <div style="display:grid; grid-template-columns:minmax(0,1.55fr) minmax(0,1fr); gap:22px">
      <section>
        <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:12px">
          <h2 style="margin:0; font-size:15px; font-weight:500">Minhas tarefas em andamento</h2>
          <button data-click="${on(() => go('mine'))}" style="border:none; background:none; color:#4A9BFF; font-size:12px; padding:0">ver quadro</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(232px,1fr)); gap:12px">
          ${V.dashTasks.map(t => `
          <div data-click="${on(() => setState({ openId: t.id, commentDraft: '' }))}" style="padding:14px; border-radius:10px; border:1px solid rgba(246,253,255,.08); background:#0F1420; cursor:pointer; display:flex; flex-direction:column; gap:10px"${hoverAttr('border-color:rgba(11,113,245,.5); background:#121826')}>
            <div style="display:flex; align-items:center; gap:7px">
              <span style="width:6px; height:6px; border-radius:50%; background:${t.projectColor}"></span>
              <span style="font-size:11px; color:#8A93A6">${esc(t.projectName)}</span>
            </div>
            <div style="font-size:13.5px; line-height:1.35; text-wrap:pretty">${esc(t.title)}</div>
            <div style="display:flex; align-items:center; gap:8px; font-size:11px; color:#6F7A8D">
              <span style="padding:2px 7px; border-radius:20px; border:1px solid ${t.prioColor}; color:${t.prioColor}">${esc(t.priority)}</span>
              <span>${esc(t.colName)}</span>
              <span style="margin-left:auto">${esc(t.due)}</span>
            </div>
          </div>`).join('')}
        </div>
      </section>

      <section>
        <h2 style="margin:0 0 12px; font-size:15px; font-weight:500">Atividade da equipe</h2>
        <div style="display:flex; flex-direction:column; gap:10px">
          ${V.activity.length ? V.activity.map(a => `
          <div style="display:flex; gap:11px; padding:12px 13px; border-radius:10px; border:1px solid rgba(246,253,255,.07); background:#0C1017">
            <div style="width:26px; height:26px; flex:none; border-radius:50%; background:${a.color}22; border:1px solid ${a.color}66; color:${a.color}; font-size:10px; display:flex; align-items:center; justify-content:center">${esc(a.initials)}</div>
            <div style="min-width:0">
              <div style="font-size:12.5px; line-height:1.45; color:#C4CCDA; text-wrap:pretty">${esc(a.text)}</div>
              <div style="font-size:10.5px; color:#5F6878; margin-top:3px">${esc(a.when)}</div>
            </div>
          </div>`).join('') : `
          <div style="padding:20px 13px; border-radius:10px; border:1px dashed rgba(246,253,255,.1); color:#6F7A8D; font-size:12.5px; text-align:center">Nenhuma atividade ainda.</div>`}
        </div>
      </section>
    </div>
  </div>`;
}

function tBoard(V) {
  return `
  <div style="display:flex; flex-direction:column; gap:16px">
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
      <div style="display:flex; align-items:center; gap:8px; padding:7px 11px; border-radius:8px; border:1px solid rgba(246,253,255,.1); background:#0C1017; min-width:230px">
        <i class="ph ph-magnifying-glass" style="font-size:14px; color:#6F7A8D"></i>
        <input data-field="query" data-input="${on(e => setState({ query: e.target.value }))}" value="${escAttr(V.query)}" placeholder="Buscar tarefa" style="flex:1; border:none; background:none; color:#F6FDFF; font-size:12.5px; outline:none">
      </div>
      ${V.projectFilters.map(f => `<button data-click="${on(() => setState({ projectFilter: f.id }))}" style="padding:7px 12px; border-radius:20px; border:1px solid ${f.border}; background:${f.bg}; color:${f.color}; font-size:12px">${esc(f.label)}</button>`).join('')}
      <span style="margin-left:auto; font-size:11.5px; color:#6F7A8D">arraste os cards entre as colunas</span>
    </div>

    <div style="display:grid; grid-template-columns:repeat(5, minmax(228px,1fr)); gap:13px; align-items:start; overflow-x:auto; padding-bottom:6px">
      ${V.board.map(c => boardColumn(c)).join('')}
    </div>
  </div>`;
}

function tProjects(V) {
  return `
  <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(288px,1fr)); gap:15px">
    ${V.projectCards.map(p => `
    <div data-click="${on(() => go('project', { projectId: p.id }))}" style="padding:18px; border-radius:11px; border:1px solid rgba(246,253,255,.08); background:linear-gradient(165deg, #10151F, #0A0D14); cursor:pointer; display:flex; flex-direction:column; gap:14px"${hoverAttr('border-color:rgba(11,113,245,.5)')}>
      <div style="display:flex; align-items:flex-start; gap:11px">
        <span style="width:9px; height:9px; margin-top:6px; border-radius:50%; background:${p.color}; box-shadow:0 0 10px ${p.color}"></span>
        <div style="flex:1; min-width:0">
          <div style="font-size:15.5px; font-weight:500">${esc(p.name)}</div>
          <div style="font-size:12px; color:#8A93A6; margin-top:4px; line-height:1.45; text-wrap:pretty">${esc(p.desc)}</div>
        </div>
        <span style="font-size:10px; padding:3px 8px; border-radius:20px; border:1px solid ${p.statusColor}; color:${p.statusColor}; white-space:nowrap">${esc(p.status)}</span>
      </div>
      <div>
        <div style="display:flex; justify-content:space-between; font-size:11px; color:#6F7A8D; margin-bottom:6px">
          <span>${esc(p.doneLabel)}</span><span>${esc(p.pctLabel)}</span>
        </div>
        <div style="height:4px; border-radius:3px; background:rgba(246,253,255,.08); overflow:hidden">
          <div style="height:100%; width:${p.pct}%; background:${p.color}"></div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px; padding-top:12px; border-top:1px solid rgba(246,253,255,.07)">
        ${p.team.map(mm => `<span style="width:23px; height:23px; border-radius:50%; background:${mm.color}22; border:1px solid ${mm.color}55; color:${mm.color}; font-size:9.5px; display:flex; align-items:center; justify-content:center">${esc(mm.initials)}</span>`).join('')}
        <span style="margin-left:auto; font-size:11px; color:#6F7A8D; display:flex; align-items:center; gap:5px"><i class="ph ph-calendar-blank" style="font-size:13px"></i>${esc(p.due)}</span>
      </div>
    </div>`).join('')}
  </div>`;
}

function tProject(V) {
  return `
  <div style="display:flex; flex-direction:column; gap:20px">
    <div style="display:flex; gap:14px; flex-wrap:wrap">
      ${V.projectStats.map(st => `
      <div style="flex:1; min-width:170px; padding:14px 16px; border-radius:10px; border:1px solid rgba(246,253,255,.08); background:#0C1017">
        <div style="font-size:10.5px; color:#6F7A8D; letter-spacing:.1em; text-transform:uppercase">${esc(st.label)}</div>
        <div style="font-size:20px; margin-top:7px">${esc(st.value)}</div>
      </div>`).join('')}
      <button data-click="${on(() => go('projects'))}" style="align-self:center; padding:9px 13px; border-radius:8px; border:1px solid rgba(246,253,255,.14); background:none; color:#C4CCDA; font-size:12.5px"${hoverAttr('color:#F6FDFF')}>voltar aos projetos</button>
    </div>
    <div style="display:grid; grid-template-columns:repeat(5, minmax(228px,1fr)); gap:13px; align-items:start; overflow-x:auto; padding-bottom:6px">
      ${V.projectBoard.map(c => boardColumn(c)).join('')}
    </div>
  </div>`;
}

function tTeam(V) {
  return `
  <div style="display:flex; flex-direction:column; gap:18px">
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(258px,1fr)); gap:14px">
      ${V.teamCards.map(u => `
      <div style="padding:17px; border-radius:11px; border:1px solid rgba(246,253,255,.08); background:#0C1017; display:flex; flex-direction:column; gap:13px">
        <div style="display:flex; align-items:center; gap:12px">
          <div style="width:38px; height:38px; border-radius:50%; background:${u.color}22; border:1px solid ${u.color}66; color:${u.color}; font-size:13px; display:flex; align-items:center; justify-content:center">${esc(u.initials)}</div>
          <div style="min-width:0">
            <div style="display:flex; align-items:center; gap:7px">
              <span style="font-size:14px">${esc(u.name)}</span>
              ${u.isAdmin ? '<span style="font-size:9.5px; padding:2px 6px; border-radius:20px; border:1px solid rgba(11,113,245,.5); color:#8CBEFF; text-transform:uppercase; letter-spacing:.06em">admin</span>' : ''}
            </div>
            <div style="font-size:11.5px; color:#8A93A6">${esc(u.role)}</div>
          </div>
        </div>
        <div style="font-size:11.5px; color:#6F7A8D">${esc(u.email)}</div>
        <div style="display:flex; gap:16px; padding-top:12px; border-top:1px solid rgba(246,253,255,.07)">
          <div><div style="font-size:17px">${u.openCount}</div><div style="font-size:10.5px; color:#6F7A8D">abertas</div></div>
          <div><div style="font-size:17px">${u.doneCount}</div><div style="font-size:10.5px; color:#6F7A8D">concluídas</div></div>
          <button data-click="${on(() => openForm('task', { assigneeId: u.id }))}" style="margin-left:auto; align-self:flex-end; padding:7px 11px; border-radius:7px; border:1px solid rgba(11,113,245,.55); background:none; color:#8CBEFF; font-size:11.5px"${hoverAttr('background:rgba(11,113,245,.16)')}>atribuir</button>
        </div>
      </div>`).join('')}
      <button data-click="${on(() => V.me.isAdmin ? openForm('user') : setState({ showInvite: true }))}" style="min-height:150px; border-radius:11px; border:1px dashed rgba(246,253,255,.15); background:none; color:#6F7A8D; font-size:13px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px"${hoverAttr('border-color:rgba(11,113,245,.55); color:#8CBEFF')}>
        <i class="ph ph-user-plus" style="font-size:22px"></i>Adicionar usuário
      </button>
    </div>
  </div>`;
}

function tFinance(V) {
  if (!V.budgets.length) {
    return `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:80px 20px; color:#6F7A8D; text-align:center">
      <i class="ph ph-chart-line-up" style="font-size:28px"></i>
      <div style="font-size:13.5px">Nenhum projeto com orçamento ainda.</div>
      <div style="font-size:12px">Crie um projeto e informe o orçamento para ver o acompanhamento aqui.</div>
    </div>`;
  }
  return `
  <div style="display:flex; flex-direction:column; gap:24px">
    <section>
      <h2 style="margin:0 0 12px; font-size:15px; font-weight:500">Orçamento por projeto</h2>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px,1fr)); gap:12px">
        ${V.budgets.map(b => `
        <div style="padding:15px; border-radius:10px; border:1px solid rgba(246,253,255,.08); background:#0C1017">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px">
            <span style="width:7px; height:7px; border-radius:50%; background:${b.color}"></span>
            <span style="font-size:13px">${esc(b.name)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:11.5px; color:#6F7A8D; margin-bottom:6px">
            <span>${esc(b.spent)} de ${esc(b.budget)}</span><span style="color:${b.pctColor}">${esc(b.pctLabel)}</span>
          </div>
          <div style="height:4px; border-radius:3px; background:rgba(246,253,255,.08); overflow:hidden">
            <div style="height:100%; width:${b.pct}%; background:${b.pctColor}"></div>
          </div>
          <div style="font-size:11px; color:#6F7A8D; margin-top:10px">custo/hora médio ${esc(b.rate)}</div>
        </div>`).join('')}
      </div>
    </section>
  </div>`;
}

function tTaskModal(V) {
  const mt = V.modalTask, openTask = V.openTask;
  if (!mt) return '';
  return `
  <div data-click="${on(() => setState({ openId: null, form: null }))}" style="position:fixed; inset:0; background:rgba(0,1,7,.72); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; padding:36px; z-index:40">
    <div data-click="${on(e => e.stopPropagation())}" style="width:100%; max-width:760px; max-height:88vh; overflow:auto; border-radius:14px; border:1px solid rgba(246,253,255,.12); background:#0C1017; box-shadow:0 30px 80px rgba(0,0,0,.7)">
      <div style="display:flex; align-items:flex-start; gap:16px; padding:22px 24px 18px; border-bottom:1px solid rgba(246,253,255,.07)">
        <div style="flex:1; min-width:0">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:9px">
            <span style="width:6px; height:6px; border-radius:50%; background:${mt.projectColor}"></span>
            <span style="font-size:11.5px; color:#8A93A6">${esc(mt.projectName)}</span>
            <span style="font-size:11px; color:#5F6878">#${esc(mt.id)}</span>
          </div>
          <h2 style="margin:0; font-size:20px; font-weight:400; line-height:1.3; text-wrap:pretty">${esc(mt.title)}</h2>
        </div>
        <button data-click="${on(() => setState({ openId: null, form: null }))}" style="width:30px; height:30px; flex:none; border-radius:7px; border:1px solid rgba(246,253,255,.12); background:none; color:#8A93A6; display:flex; align-items:center; justify-content:center"${hoverAttr('color:#F6FDFF')}><i class="ph ph-x" style="font-size:15px"></i></button>
      </div>

      <div style="display:grid; grid-template-columns:minmax(0,1fr) 232px; gap:0">
        <div style="padding:20px 24px; display:flex; flex-direction:column; gap:22px; border-right:1px solid rgba(246,253,255,.07)">
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:9px">Descrição</div>
            <p style="margin:0; font-size:13px; line-height:1.6; color:#C4CCDA; text-wrap:pretty">${esc(mt.desc)}</p>
          </div>

          <div>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:11px">
              <span style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D">Checklist</span>
              <span style="font-size:11px; color:#8A93A6">${esc(mt.checkLabel)}</span>
              <div style="flex:1; height:3px; border-radius:2px; background:rgba(246,253,255,.08); overflow:hidden"><div style="height:100%; width:${mt.checkPct}%; background:#0B71F5"></div></div>
            </div>
            <div style="display:flex; flex-direction:column; gap:2px">
              ${mt.checklist.map(c => `
              <button data-click="${on(() => patchTask(openTask.id, { checklist: openTask.checklist.map((x, j) => j === c.i ? { t: x.t, done: !x.done } : x) }))}" style="display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:7px; border:none; background:none; color:${c.color}; font-size:12.5px; text-align:left; text-decoration:${c.deco}"${hoverAttr('background:rgba(246,253,255,.04)')}>
                <i class="${c.icon}" style="font-size:16px; color:${c.iconColor}"></i>${esc(c.t)}
              </button>`).join('')}
            </div>
          </div>

          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:10px">Anexos</div>
            <div style="display:flex; gap:9px; flex-wrap:wrap">
              ${mt.files.map(f => `
              <div style="display:flex; align-items:center; gap:8px; padding:8px 11px; border-radius:8px; border:1px solid rgba(246,253,255,.09); background:#111725; font-size:11.5px; color:#C4CCDA">
                <i class="ph ph-paperclip" style="font-size:14px; color:#6F7A8D"></i>${esc(f)}
              </div>`).join('')}
              <button style="display:flex; align-items:center; gap:7px; padding:8px 11px; border-radius:8px; border:1px dashed rgba(246,253,255,.14); background:none; font-size:11.5px; color:#6F7A8D"${hoverAttr('color:#8CBEFF')}><i class="ph ph-plus" style="font-size:13px"></i>anexar</button>
            </div>
          </div>

          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:12px">Comentários</div>
            <div style="display:flex; flex-direction:column; gap:14px">
              ${mt.comments.map(c => `
              <div style="display:flex; gap:11px">
                <div style="width:26px; height:26px; flex:none; border-radius:50%; background:${c.color}22; border:1px solid ${c.color}55; color:${c.color}; font-size:10px; display:flex; align-items:center; justify-content:center">${esc(c.initials)}</div>
                <div style="min-width:0">
                  <div style="font-size:11.5px; color:#8A93A6; margin-bottom:4px">${esc(c.who)} · ${esc(c.when)}</div>
                  <div style="font-size:12.5px; line-height:1.5; color:#C4CCDA; text-wrap:pretty">${esc(c.text)}</div>
                </div>
              </div>`).join('')}
              <div style="display:flex; gap:9px; align-items:center">
                <input data-field="commentDraft" data-input="${on(e => setState({ commentDraft: e.target.value }))}" data-keydown="${on(e => { if (e.key === 'Enter') addComment(); })}" value="${escAttr(V.commentDraft)}" placeholder="Escrever um comentário" style="flex:1; padding:9px 12px; border-radius:8px; border:1px solid rgba(246,253,255,.1); background:#111725; color:#F6FDFF; font-size:12.5px; outline:none">
                <button data-click="${on(() => addComment())}" style="padding:9px 13px; border-radius:8px; border:1px solid #0B71F5; background:rgba(11,113,245,.12); color:#8CBEFF; font-size:12px"${hoverAttr('background:rgba(11,113,245,.24); color:#F6FDFF')}>enviar</button>
              </div>
            </div>
          </div>
        </div>

        <div style="padding:20px 20px; display:flex; flex-direction:column; gap:17px">
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">Coluna</div>
            ${selectHTML('modalTask.col', e => patchTask(openTask.id, { col: e.target.value }), V.colOptions, mt.col)}
          </div>
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">Responsável</div>
            ${selectHTML('modalTask.assigneeId', e => patchTask(openTask.id, { assigneeId: e.target.value }), V.users.map(u => ({ id: u.id, name: u.name })), mt.assigneeId)}
          </div>
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">Prioridade</div>
            <div style="display:flex; gap:6px">
              ${V.prioOptions.map(p => `<button data-click="${on(() => openTask && patchTask(openTask.id, { priority: p.label }))}" style="flex:1; padding:7px 4px; border-radius:7px; border:1px solid ${p.border}; background:${p.bg}; color:${p.color}; font-size:11.5px">${esc(p.label)}</button>`).join('')}
            </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:12px; padding-top:15px; border-top:1px solid rgba(246,253,255,.07); font-size:12px; color:#8A93A6">
            <div style="display:flex; justify-content:space-between"><span>Prazo</span><span style="color:#F6FDFF">${esc(mt.due)}</span></div>
            <div style="display:flex; justify-content:space-between"><span>Estimativa</span><span style="color:#F6FDFF">${esc(mt.hours)}h</span></div>
            <div style="display:flex; justify-content:space-between"><span>Criada por</span><span style="color:#F6FDFF">${esc(mt.createdBy)}</span></div>
          </div>
          <div>
            <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:8px">Etiquetas</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap">
              ${mt.tags.map(tag => `<span style="font-size:10.5px; padding:3px 8px; border-radius:5px; background:rgba(11,113,245,.14); color:#8CBEFF">${esc(tag)}</span>`).join('')}
            </div>
          </div>
          <button data-click="${on(() => deleteTask(openTask.id))}" style="margin-top:auto; padding:9px; border-radius:8px; border:1px solid rgba(255,77,94,.35); background:none; color:#FF7A86; font-size:12px"${hoverAttr('background:rgba(255,77,94,.12)')}>excluir tarefa</button>
        </div>
      </div>
    </div>
  </div>`;
}

function formFieldHTML(f) {
  const setFn = e => setDraft(f.key, e.target.value);
  if (f.isSelect) {
    return `<div>
      <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">${esc(f.label)}</div>
      ${selectHTML('draft.' + f.key, setFn, f.options, f.value, '9px 11px')}
    </div>`;
  }
  if (f.isArea) {
    return `<div>
      <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">${esc(f.label)}</div>
      <textarea data-field="draft.${escAttr(f.key)}" data-input="${on(setFn)}" placeholder="${escAttr(f.placeholder)}" rows="3" style="width:100%; padding:9px 11px; border-radius:8px; border:1px solid rgba(246,253,255,.12); background:#111725; color:#F6FDFF; font-size:13px; outline:none; resize:vertical">${esc(f.value)}</textarea>
    </div>`;
  }
  return `<div>
    <div style="font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:#6F7A8D; margin-bottom:7px">${esc(f.label)}</div>
    <input data-field="draft.${escAttr(f.key)}" data-input="${on(setFn)}" value="${escAttr(f.value)}" placeholder="${escAttr(f.placeholder)}" style="width:100%; padding:9px 11px; border-radius:8px; border:1px solid rgba(246,253,255,.12); background:#111725; color:#F6FDFF; font-size:13px; outline:none">
  </div>`;
}

function tFormModal(V) {
  if (!V.showForm) return '';
  return `
  <div data-click="${on(() => setState({ openId: null, form: null }))}" style="position:fixed; inset:0; background:rgba(0,1,7,.72); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; padding:36px; z-index:45">
    <div data-click="${on(e => e.stopPropagation())}" style="width:100%; max-width:520px; border-radius:14px; border:1px solid rgba(246,253,255,.12); background:#0C1017; box-shadow:0 30px 80px rgba(0,0,0,.7)">
      <div style="display:flex; align-items:center; gap:12px; padding:20px 22px; border-bottom:1px solid rgba(246,253,255,.07)">
        <h2 style="margin:0; flex:1; font-size:17px; font-weight:400">${esc(V.formTitle)}</h2>
        <button data-click="${on(() => setState({ openId: null, form: null }))}" style="width:29px; height:29px; border-radius:7px; border:1px solid rgba(246,253,255,.12); background:none; color:#8A93A6"${hoverAttr('color:#F6FDFF')}><i class="ph ph-x" style="font-size:14px"></i></button>
      </div>
      <div style="padding:20px 22px; display:flex; flex-direction:column; gap:15px">
        ${V.formFields.map(f => formFieldHTML(f)).join('')}
        ${V.inviteError ? `
        <div style="display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:8px; border:1px solid rgba(255,77,94,.35); background:rgba(255,77,94,.08); font-size:12px; color:#FF9AA3">
          <i class="ph ph-warning-circle" style="font-size:14px"></i>${esc(V.inviteError)}
        </div>` : ''}
      </div>
      <div style="display:flex; gap:10px; justify-content:flex-end; padding:16px 22px; border-top:1px solid rgba(246,253,255,.07)">
        <button data-click="${on(() => setState({ openId: null, form: null }))}" style="padding:9px 15px; border-radius:8px; border:1px solid rgba(246,253,255,.14); background:none; color:#C4CCDA; font-size:12.5px"${hoverAttr('color:#F6FDFF')}>cancelar</button>
        <button data-click="${on(() => submit())}" ${V.inviteBusy ? 'disabled' : ''} style="padding:9px 17px; border-radius:8px; border:1px solid #0B71F5; background:rgba(11,113,245,.16); color:#8CBEFF; font-size:12.5px"${hoverAttr('background:rgba(11,113,245,.3); color:#F6FDFF')}>${V.inviteBusy ? 'Aguarde…' : esc(V.formCta)}</button>
      </div>
    </div>
  </div>`;
}

function tInviteModal(V) {
  if (!V.showInvite) return '';
  return `
  <div data-click="${on(() => setState({ showInvite: false }))}" style="position:fixed; inset:0; background:rgba(0,1,7,.72); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; padding:36px; z-index:45">
    <div data-click="${on(e => e.stopPropagation())}" style="width:100%; max-width:440px; border-radius:14px; border:1px solid rgba(246,253,255,.12); background:#0C1017; box-shadow:0 30px 80px rgba(0,0,0,.7); padding:22px 24px">
      <h2 style="margin:0 0 10px; font-size:17px; font-weight:400">Adicionar alguém à equipe</h2>
      <p style="margin:0 0 18px; font-size:13px; line-height:1.6; color:#8A93A6">Só quem tem acesso de administrador pode adicionar novas pessoas. Peça para um admin da equipe te incluir.</p>
      <button data-click="${on(() => setState({ showInvite: false }))}" style="padding:9px 15px; border-radius:8px; border:1px solid #0B71F5; background:rgba(11,113,245,.16); color:#8CBEFF; font-size:12.5px"${hoverAttr('background:rgba(11,113,245,.3); color:#F6FDFF')}>entendi</button>
    </div>
  </div>`;
}

function tShell(V) {
  let screenHTML = '';
  if (V.isDash) screenHTML = tDash(V);
  else if (V.isBoard) screenHTML = tBoard(V);
  else if (V.isProjects) screenHTML = tProjects(V);
  else if (V.isProject) screenHTML = tProject(V);
  else if (V.isTeam) screenHTML = tTeam(V);
  else if (V.isFinance) screenHTML = tFinance(V);

  return `
  <div style="display:flex; min-height:100vh; background:#000107; background-image:radial-gradient(1100px 520px at 12% -12%, rgba(11,113,245,.16), transparent 70%); font-size:14px">
    ${tSidebar(V)}
    <main style="flex:1; min-width:0; display:flex; flex-direction:column">
      <header style="display:flex; align-items:flex-end; gap:20px; padding:26px 32px 18px; border-bottom:1px solid rgba(246,253,255,.07)">
        <div style="flex:1; min-width:0">
          <div style="font-size:11px; color:#6F7A8D; letter-spacing:.14em; text-transform:uppercase; margin-bottom:7px">${esc(V.screenKicker)}</div>
          <h1 style="margin:0; font-size:26px; font-weight:400; letter-spacing:-.01em">${esc(V.screenTitle)}</h1>
        </div>
        <div style="display:flex; align-items:center; gap:9px">
          <button data-click="${on(() => openForm('project'))}" style="display:flex; align-items:center; gap:7px; padding:8px 13px; border-radius:8px; border:1px solid rgba(246,253,255,.14); background:transparent; color:#C4CCDA; font-size:12.5px"${hoverAttr('background:rgba(246,253,255,.05); color:#F6FDFF')}>
            <i class="ph ph-folder-simple-plus" style="font-size:15px"></i>Novo projeto
          </button>
          <button data-click="${on(() => openForm('task'))}" style="display:flex; align-items:center; gap:7px; padding:8px 13px; border-radius:8px; border:1px solid #0B71F5; background:rgba(11,113,245,.12); color:#8CBEFF; font-size:12.5px"${hoverAttr('background:rgba(11,113,245,.22); color:#F6FDFF')}>
            <i class="ph ph-plus" style="font-size:15px"></i>Nova tarefa
          </button>
        </div>
      </header>
      <div style="flex:1; min-width:0; padding:26px 32px 40px">
        ${screenHTML}
      </div>
    </main>
    ${tTaskModal(V)}
    ${tFormModal(V)}
    ${tInviteModal(V)}
  </div>`;
}

function tApp(V) {
  if (!V.authReady) return `<div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:#000107; color:#6F7A8D; font-size:13px">Carregando…</div>`;
  if (V.isLogin) return tLogin(V);
  if (!V.authed) return '';
  return tShell(V);
}

/* ---------- mount ---------- */
function render() {
  handlers = new Map();
  const app = document.getElementById('app');
  if (!app) return;
  const V = computeView();
  app.innerHTML = tApp(V);
}

document.addEventListener('DOMContentLoaded', () => {
  bindOnce();
  render();
  bootstrapAuth();
});
