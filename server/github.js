const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN não configurado no .env.');
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function ghFetch(path, options) {
  const res = await fetch(GITHUB_API + path, Object.assign({ headers: ghHeaders() }, options || {}));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('GitHub API ' + res.status + ' em ' + path + ': ' + body.slice(0, 300));
  }
  return res;
}

// Follows Link-header pagination, capped so a runaway repo can't loop forever.
async function ghFetchAllPages(path, maxPages) {
  let url = path;
  const items = [];
  for (let page = 0; page < (maxPages || 10) && url; page++) {
    const res = await ghFetch(url);
    const batch = await res.json();
    items.push(...batch);
    const link = res.headers.get('link') || '';
    const next = link.split(',').map(s => s.trim()).find(s => s.endsWith('rel="next"'));
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')).replace(GITHUB_API, '') : null;
  }
  return items;
}

async function fetchIssuesSince(owner, repo, sinceIso) {
  const params = new URLSearchParams({ state: 'all', per_page: '100', sort: 'updated', direction: 'asc' });
  if (sinceIso) params.set('since', sinceIso);
  const items = await ghFetchAllPages(`/repos/${owner}/${repo}/issues?${params}`, 10);
  return items.filter(it => !it.pull_request); // the issues endpoint also returns PRs; we only want real issues
}

async function fetchIssueComments(owner, repo, number, sinceIso) {
  const params = new URLSearchParams({ per_page: '100' });
  if (sinceIso) params.set('since', sinceIso);
  return ghFetchAllPages(`/repos/${owner}/${repo}/issues/${number}/comments?${params}`, 5);
}

async function setIssueState(owner, repo, number, state) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH',
    headers: Object.assign(ghHeaders(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ state })
  });
  return res.json();
}

async function postIssueComment(owner, repo, number, body) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: Object.assign(ghHeaders(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ body })
  });
  return res.json();
}

module.exports = { fetchIssuesSince, fetchIssueComments, setIssueState, postIssueComment };
