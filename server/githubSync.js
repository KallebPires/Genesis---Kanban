const { getDb, ObjectId } = require('./db');
const github = require('./github');
const { pickColor } = require('./utils');

function mapLabels(labels) {
  return (labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

function matchAssignee(issue, users) {
  const logins = (issue.assignees || []).map(a => a.login.toLowerCase());
  if (!logins.length) return null;
  return users.find(u => u.githubUsername && logins.includes(u.githubUsername.toLowerCase())) || null;
}

async function pullNewComments(owner, repo, number, taskDoc, sinceIso) {
  const comments = await github.fetchIssueComments(owner, repo, number, sinceIso);
  if (!comments.length) return;
  const existingIds = new Set((taskDoc.comments || []).map(c => c.githubCommentId).filter(Boolean));
  const newOnes = comments.filter(c => !existingIds.has(c.id)).map(c => ({
    who: (c.user && c.user.login) || 'GitHub', when: 'via GitHub', text: c.body,
    initials: ((c.user && c.user.login) || 'GH').slice(0, 2).toUpperCase(), color: '#8A93A6',
    githubCommentId: c.id
  }));
  if (!newOnes.length) return;
  await getDb().collection('tasks').updateOne({ _id: taskDoc._id }, {
    $set: { comments: (taskDoc.comments || []).concat(newOnes), lastCommentSyncAt: new Date().toISOString() }
  });
}

async function ensureProject(name, ownerRepo) {
  const db = getDb();
  const existing = await db.collection('projects').findOne({ githubFullName: ownerRepo });
  if (existing) return existing;
  const count = await db.collection('projects').countDocuments();
  const doc = {
    name, desc: 'Issues sincronizadas de ' + ownerRepo, color: pickColor(count),
    due: 'sem prazo', status: 'Em andamento', budget: 30000, spent: 0, rate: 'R$ 130',
    githubFullName: ownerRepo, createdAt: new Date().toISOString()
  };
  const result = await db.collection('projects').insertOne(doc);
  doc._id = result.insertedId;
  return doc;
}

async function syncRepo(repoDoc) {
  const db = getDb();
  const { owner, repo, projectId } = repoDoc;
  const repoId = repoDoc._id.toString();
  const since = repoDoc.lastSyncedAt || null;
  const issues = await github.fetchIssuesSince(owner, repo, since);
  const users = await db.collection('users').find({}).toArray();
  let created = 0, updated = 0;

  for (const issue of issues) {
    const existing = await db.collection('tasks').findOne({ githubRepoId: repoId, githubIssueNumber: issue.number });
    if (!existing) {
      const assignee = matchAssignee(issue, users);
      const doc = {
        title: issue.title, desc: issue.body || 'Sem descrição.',
        projectId, assigneeId: assignee ? assignee.id : '', col: issue.state === 'closed' ? 'done' : 'todo',
        priority: 'Média', due: 'sem prazo', hours: 0, tags: mapLabels(issue.labels),
        createdBy: 'GitHub', createdById: null, checklist: [], files: [], comments: [],
        githubRepoId: repoId, githubIssueNumber: issue.number, githubUrl: issue.html_url,
        githubUpdatedAt: issue.updated_at, createdAt: issue.created_at, updatedAt: new Date().toISOString()
      };
      const result = await db.collection('tasks').insertOne(doc);
      doc._id = result.insertedId;
      await pullNewComments(owner, repo, issue.number, doc, null);
      created++;
    } else {
      const patch = {
        title: issue.title, desc: issue.body || 'Sem descrição.', tags: mapLabels(issue.labels),
        githubUpdatedAt: issue.updated_at, updatedAt: new Date().toISOString()
      };
      if (issue.state === 'closed') patch.col = 'done';
      else if (existing.col === 'done') patch.col = 'todo'; // reopened on GitHub since our last poll
      await db.collection('tasks').updateOne({ _id: existing._id }, { $set: patch });
      await pullNewComments(owner, repo, issue.number, existing, existing.lastCommentSyncAt || null);
      updated++;
    }
  }
  await db.collection('githubRepos').updateOne({ _id: repoId }, { $set: { lastSyncedAt: new Date().toISOString() } });
  return { owner, repo, created, updated, total: issues.length };
}

async function connectRepo(owner, repo) {
  const db = getDb();
  const fullName = owner + '/' + repo;
  const existing = await db.collection('githubRepos').findOne({ owner, repo });
  if (existing) throw Object.assign(new Error('Esse repositório já está conectado.'), { status: 409 });
  const project = await ensureProject(repo, fullName);
  const doc = { owner, repo, projectId: project._id.toString(), lastSyncedAt: null, createdAt: new Date().toISOString() };
  const result = await db.collection('githubRepos').insertOne(doc);
  doc._id = result.insertedId;
  const summary = await syncRepo(doc);
  return { repo: doc, project, summary };
}

async function syncAll() {
  const repos = await getDb().collection('githubRepos').find({}).toArray();
  const results = [];
  for (const r of repos) {
    try { results.push(await syncRepo(r)); }
    catch (e) { console.error('github sync failed for', r.owner + '/' + r.repo, e.message); results.push({ owner: r.owner, repo: r.repo, error: e.message }); }
  }
  return results;
}

// Push a local Kanban change back to GitHub for a task linked to an issue.
// Best-effort: failures are logged, never block the local write that triggered them.
async function pushTaskChangeToGithub(beforeDoc, patch) {
  if (!beforeDoc.githubRepoId) return;
  const db = getDb();
  const repoDoc = await db.collection('githubRepos').findOne({ _id: new ObjectId(beforeDoc.githubRepoId) });
  if (!repoDoc) return;
  const { owner, repo } = repoDoc;
  const number = beforeDoc.githubIssueNumber;

  try {
    if (patch.col && patch.col !== beforeDoc.col) {
      if (patch.col === 'done' && beforeDoc.col !== 'done') {
        const issue = await github.setIssueState(owner, repo, number, 'closed');
        await db.collection('tasks').updateOne({ _id: beforeDoc._id }, { $set: { githubUpdatedAt: issue.updated_at } });
      } else if (beforeDoc.col === 'done' && patch.col !== 'done') {
        const issue = await github.setIssueState(owner, repo, number, 'open');
        await db.collection('tasks').updateOne({ _id: beforeDoc._id }, { $set: { githubUpdatedAt: issue.updated_at } });
      }
    }
    if (patch.comments && Array.isArray(patch.comments)) {
      const before = beforeDoc.comments || [];
      const newOnes = patch.comments.slice(before.length).filter(c => !c.githubCommentId);
      for (const c of newOnes) {
        const created = await github.postIssueComment(owner, repo, number, c.text);
        c.githubCommentId = created.id; // tag it so a later pull doesn't re-import our own comment
      }
      if (newOnes.length) await db.collection('tasks').updateOne({ _id: beforeDoc._id }, { $set: { comments: patch.comments } });
    }
  } catch (e) {
    console.error('failed to push task change to GitHub:', e.message);
  }
}

module.exports = { syncRepo, syncAll, connectRepo, pushTaskChangeToGithub };
