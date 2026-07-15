const { app, BrowserWindow, shell, dialog, Menu, powerSaveBlocker } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs   = require('node:fs');
const http = require('node:http');
const net  = require('node:net');
const os   = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

let mainWindow     = null;
let settingsWindow = null;
let proxyServer    = null;
let proxyPort      = null;

// ---------------------------------------------------------------------------
// App settings — stored in userData/settings.json
// ---------------------------------------------------------------------------

const settingsFile = path.join(
  process.env.LOCALAPPDATA || (process.env.APPDATA ? path.join(process.env.APPDATA, '..', 'Local') : os.homedir()),
  'NotesIntel', 'settings.json'
);
let appSettings = { provider: 'claude', openaiKey: '', folderPath: '' };

function loadSettings() {
  try { Object.assign(appSettings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch { }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(appSettings, null, 2), 'utf8');
  } catch (e) { log(`saveSettings error: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Logging — written to %LOCALAPPDATA%\NotesIntel\main.log
// ---------------------------------------------------------------------------

const logDir  = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'NotesIntel');
const logFile = path.join(logDir, 'main.log');

function log(msg) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* never crash on log failure */ }
}

// ---------------------------------------------------------------------------
// Claude CLI helpers (identical to QA Dashboard)
// ---------------------------------------------------------------------------

function resolveClaudeCli() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),  // Claude desktop install (Windows)
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'claude';
}

function cliModelAlias(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus'))  return 'opus';
  return 'sonnet';
}

// Flatten Anthropic Messages API body → single prompt string + temp image paths.
// Identical to QA Dashboard's _notes_intel_prompt().
function buildPrompt(body) {
  const parts     = [];
  const tempFiles = [];
  if (body.system) parts.push('SYSTEM INSTRUCTIONS (follow strictly):\n' + body.system);
  for (const message of body.messages || []) {
    const content = message.content;
    if (typeof content === 'string') { parts.push(content); continue; }
    for (const block of content || []) {
      if (block.type === 'text') {
        parts.push(String(block.text || ''));
      } else if (block.type === 'image') {
        const source  = block.source || {};
        const ext     = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' })[source.media_type] || '.png';
        const tmpDir  = path.join(os.tmpdir(), 'notes-intel-attachments');
        fs.mkdirSync(tmpDir, { recursive: true });
        const imgPath = path.join(tmpDir, `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        fs.writeFileSync(imgPath, Buffer.from(source.data || '', 'base64'));
        tempFiles.push(imgPath);
        // Use forward slashes — Claude CLI handles them on Windows and avoids escape issues
        const imgPathFwd = imgPath.replace(/\\/g, '/');
        parts.push(
          'A screenshot is attached. FIRST use the Read tool to view the image file at this path: ' + imgPathFwd + '\n' +
          'Everything visible in the image is primary input content. Describe it fully and base your analysis on it.'
        );
      }
    }
  }
  return { prompt: parts.filter(Boolean).join('\n\n'), tempFiles };
}


function cleanupTempFiles(files) {
  for (const f of files) { try { fs.unlinkSync(f); } catch { } }
}

// ---------------------------------------------------------------------------
// Local HTTP server
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// In-memory results for async jobs (code cross-check) — polled via /api/job/<id>
const claudeJobs = {};

// svn ls -R results per root URL — module pins are stable, so this never goes stale mid-session.
const svnLsCache = new Map();

// Run an svn command, resolve with stdout. Rejects on non-zero exit.
function svn(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('svn', args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs || 60000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { reject(new Error((stderr || err.message || '').slice(0, 300))); return; }
        resolve(stdout || '');
      });
  });
}

// Derive the trunk URL from a branch URL: .../<Repo>/branches/<name>[/...] -> .../<Repo>/trunk
function deriveTrunkUrl(branchUrl) {
  const m = branchUrl.match(/^(.*)\/branches\/[^/]+/);
  return m ? m[1] + '/trunk' : null;
}

// Parse an svn:externals property block into [{local, url, rev}].
function parseExternals(text) {
  const out = [];
  (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    const tok = line.split(/\s+/);
    let rev = null, url = null, local = null;
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (t === '-r' && tok[i + 1]) { rev = tok[i + 1]; i++; continue; }
      const rm = t.match(/^-r(\d+)$/); if (rm) { rev = rm[1]; continue; }
      if (t.includes('://') || t.startsWith('^/') || t.startsWith('^../') || t.startsWith('../') || t.startsWith('/')) { url = t; continue; }
      if (!local) local = t;
    }
    if (!url) return;
    const at = url.lastIndexOf('@');
    if (at > 0 && /^\d+$/.test(url.slice(at + 1))) { if (!rev) rev = url.slice(at + 1); url = url.slice(0, at); }
    out.push({ local: local || url, url, rev });
  });
  return out;
}

// Parse `svn diff --summarize` output into file/dir/skipped buckets.
function parseSummarizeLines(summary, skip) {
  const lines = summary.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const fileEntries = [], dirEntries = [], skipped = [];
  for (const line of lines) {
    const m = line.match(/^(.)(.)\s+(\S.*)$/); // col1 content, col2 property
    if (!m) continue;
    const cst = m[1].trim(), pst = m[2].trim(), url = m[3].trim();
    if (cst === 'D') { skipped.push({ url, why: 'deleted' }); continue; }
    if (skip(url)) { skipped.push({ url, why: 'asset/generated' }); continue; }
    if (!cst && pst === 'M') { dirEntries.push(url); continue; } // property-only → likely externals/mergeinfo
    fileEntries.push({ status: cst || pst, url });
  }
  return { fileEntries, dirEntries, skipped };
}

// .../<Repo>/(trunk|branches|tags)/... -> .../<Repo>
function moduleRootFromUrl(u) {
  const m = (u || '').match(/^(.*?)\/(trunk|branches|tags)(\/|@|$)/);
  return m ? m[1] : null;
}

// Reject targets that svn would read as an option (leading '-') — defends the
// endpoints that take renderer/user-influenced URLs from svn argument injection
// (e.g. --config-dir=… → hostile [tunnels] → command execution). All svn calls
// on external targets below also use the '--' end-of-options separator.
function isSafeSvnTarget(s) {
  return typeof s === 'string' && s.length > 0 && s[0] !== '-';
}

async function svnExists(url) {
  if (!isSafeSvnTarget(url)) return false;
  try { await svn(['info', '--show-item', 'kind', '--', url], 20000); return true; } catch (e) { return false; }
}

// All module roots referenced by svn:externals anywhere under the branch.
// One recursive server-side propget; cached per branch@peg (results are stable).
const svnExtRootsCache = new Map();
async function collectExternalModuleRoots(branchUrl, peg, resolveUrl) {
  const key = branchUrl + (peg || '');
  if (svnExtRootsCache.has(key)) return svnExtRootsCache.get(key);
  let txt = '';
  // Don't cache transient failures — a re-run (the natural response to missing module
  // files) must retry, not keep serving [].
  try { txt = await svn(['propget', 'svn:externals', '-R', branchUrl + (peg || '@HEAD')], 180000); }
  catch (e) { log(`externals scan failed: ${(e.message || '').slice(0, 120)}`); return []; }
  const roots = new Set();
  for (let line of txt.split(/\r?\n/)) {
    line = line.replace(/^\S+ - /, '').trim(); // strip the "<dir-url> - " block prefix
    if (!line) continue;
    for (const ext of parseExternals(line)) {
      const root = moduleRootFromUrl(resolveUrl(ext.url));
      if (root) roots.add(root);
    }
  }
  const arr = [...roots].slice(0, 25);
  // Only cache pinned (revision-pegged) results — those are immutable. An unpinned
  // (@HEAD) scan can change between runs, so caching it would hide a module added
  // mid-session (the exact case this discovery exists for).
  if (peg) svnExtRootsCache.set(key, arr);
  return arr;
}

// Diff a (module) branch against its own trunk at the branch's copy point.
async function branchChangeEntries(branchUrl, skip) {
  const trunkUrl = deriveTrunkUrl(branchUrl);
  if (!trunkUrl) return { entries: [], commitLog: '' };
  let copyRev = null;
  try {
    const xml = await svn(['log', '--stop-on-copy', '-v', '--xml', branchUrl], 60000);
    const cm = [...xml.matchAll(/copyfrom-rev="(\d+)"/g)];
    if (cm.length) copyRev = cm[cm.length - 1][1];
  } catch (e) {}
  let summary;
  try { summary = await svn(['diff', '--summarize', trunkUrl + (copyRev ? '@' + copyRev : '@HEAD'), branchUrl], 120000); }
  catch (e) { return { entries: [], commitLog: '' }; }
  const p = parseSummarizeLines(summary, skip);
  const entries = p.fileEntries.map(f => {
    const bU = f.url.indexOf(trunkUrl) === 0 ? branchUrl + f.url.slice(trunkUrl.length) : f.url;
    return { rel: bU.replace(branchUrl, '').replace(/^\//, ''), status: f.status, catUrl: bU };
  });
  let commitLog = '';
  try { commitLog = await svn(['log', '--stop-on-copy', '-l', '10', branchUrl], 30000); } catch (e) {}
  return { entries, commitLog };
}

// Follow svn:externals pin changes on the given dirs into their module repos.
// dirUrls are OLD (trunk) side; ctx maps them to the branch side.
async function followPinChanges(dirUrls, ctx) {
  const out = { entries: [], externalModules: [], pinnedRoots: new Set() };
  for (const dirUrl of dirUrls) {
    if (!ctx.trunkUrl) continue;
    const trunkDirUrl = dirUrl;                 // already trunk-based
    const branchDirUrl = ctx.toBranch(dirUrl);  // branch-side
    let extB = [], extT = [];
    try { extB = parseExternals(await svn(['propget', 'svn:externals', branchDirUrl + (ctx.peg || '@HEAD')], 30000)); } catch (e) {}
    try { extT = parseExternals(await svn(['propget', 'svn:externals', trunkDirUrl + (ctx.copyRev ? '@' + ctx.copyRev : '@HEAD')], 30000)); } catch (e) {}
    if (!extB.length) continue;
    for (const eb of extB) {
      const et = extT.find(x => x.local === eb.local);
      const newU = ctx.resolveUrl(eb.url), newR = eb.rev;
      const oldU = et ? ctx.resolveUrl(et.url) : null, oldR = et ? et.rev : null;
      if (!oldU || (oldU === newU && oldR === newR)) continue; // pin unchanged
      out.externalModules.push({ local: eb.local, oldU, oldR, newU, newR });
      out.pinnedRoots.add(moduleRootFromUrl(newU) || newU);
      // Diff the module between the old pin and the new pin.
      try {
        const modSum = await svn(['diff', '--summarize', oldU + (oldR ? '@' + oldR : '@HEAD'), newU + (newR ? '@' + newR : '@HEAD')], 120000);
        const mp = parseSummarizeLines(modSum, ctx.skip);
        for (const mf of mp.fileEntries) {
          // module diff prints old-side (oldU) paths; map to the new pin and cat at the new rev.
          const catUrl = mf.url.indexOf(oldU) === 0 ? newU + mf.url.slice(oldU.length) : mf.url;
          out.entries.push({ path: '[' + eb.local + '] ' + mf.url.replace(oldU, '').replace(/^\//, ''), status: mf.status, catUrl, catPeg: newR ? '@' + newR : '', source: 'module-pin' });
        }
      } catch (e) { log(`module diff failed for ${eb.local}: ${(e.message || '').slice(0, 120)}`); }
    }
  }
  return out;
}

// Diff Packages/manifest.json dependencies between trunk (old) and branch (new).
// A cheap, high-value signal: an SDK/package version bump is a real regression-risk
// area even when no game code changed. Returns null when no manifest changed or the
// diff is empty. (Idea lifted from the release-level compare_releases.py.)
async function computePackageChanges(entries, copyRev) {
  const isManifest = en => en.source === 'branch' && /(^|\/)Packages\/manifest\.json$/i.test(en.path);
  const man = entries.find(isManifest);
  if (!man) return null;
  const parseDeps = txt => { try { return JSON.parse(txt).dependencies || {}; } catch (e) { return null; } };
  let newDeps, oldDeps;
  try { newDeps = parseDeps(await svn(['cat', '--', man.catUrl + (man.catPeg || '')], 45000)); } catch (e) { return null; }
  try { oldDeps = parseDeps(await svn(['cat', '--', man.srcUrl + (copyRev ? '@' + copyRev : '@HEAD')], 45000)); } catch (e) { oldDeps = null; }
  if (!newDeps || !oldDeps) return null;
  const added = [], removed = [], changed = [];
  for (const k of [...new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)])].sort()) {
    if (!(k in oldDeps)) added.push({ name: k, version: newDeps[k] });
    else if (!(k in newDeps)) removed.push({ name: k, version: oldDeps[k] });
    else if (oldDeps[k] !== newDeps[k]) changed.push({ name: k, from: oldDeps[k], to: newDeps[k] });
  }
  if (!added.length && !removed.length && !changed.length) return null;
  return { added, removed, changed };
}

// Collect everything the BRANCH changed relative to trunk — full text, or metadata
// only when opts.summaryOnly (the two-stage flow plans retrieval before fetching).
// Compares branch@rev against the branch's copy point on trunk (so trunk drift adds no noise).
// Module code is found two ways:
//  - svn:externals pin changes are followed into the module repo (re-pinned case), and
//  - module branches carrying the same name as the game branch (or a name parsed from a
//    pasted code-review link → opts.branchNames) are discovered via the externals list and
//    diffed against their own trunk — covers the "module not re-pinned yet" case.
async function fetchSvnChangedFiles(baseUrl, rev, opts) {
  opts = opts || {};
  const SKIP_EXT = /\.(meta|png|jpg|jpeg|gif|tga|psd|fbx|anim|controller|prefab|unity|asset|dll|so|a|mat|wav|mp3|ogg|ttf|otf|bytes|spriteatlas|atlas)$/i;
  // Generated / non-authored code that only adds noise and tokens.
  const SKIP_NAME = /(_Autogenerated|\.g|\.designer)\.cs$/i;
  const skip = u => SKIP_EXT.test(u) || SKIP_NAME.test(u);
  const MAX_FILES = 14;
  const MAX_FILE_BYTES = 55000;
  const peg = rev ? '@' + rev : '';
  const trunkUrl = deriveTrunkUrl(baseUrl);
  let copyRev = null;
  let summary, mode;
  if (trunkUrl) {
    try {
      const xml = await svn(['log', '--stop-on-copy', '-v', '--xml', baseUrl + (peg || '@HEAD')], 60000);
      const cm = [...xml.matchAll(/copyfrom-rev="(\d+)"/g)];
      if (cm.length) copyRev = cm[cm.length - 1][1];
    } catch (e) {}
    const trunkPeg = copyRev ? '@' + copyRev : '@HEAD';
    try {
      summary = await svn(['diff', '--summarize', trunkUrl + trunkPeg, baseUrl + (peg || '@HEAD')], 120000);
      mode = 'branch-vs-trunk';
    } catch (e) {
      log(`branch-vs-trunk failed (${(e.message || '').slice(0, 120)}) — falling back to single revision`);
      summary = await svn(['diff', '--summarize', '-c', rev || 'HEAD', baseUrl], 120000);
      mode = 'single-revision (trunk not found)';
    }
  } else {
    summary = await svn(['diff', '--summarize', '-c', rev || 'HEAD', baseUrl], 120000);
    mode = 'single-revision';
  }

  // repo root for resolving ^/ externals
  let reposRoot = '';
  try { reposRoot = (await svn(['info', '--show-item', 'repos-root-url', baseUrl + (peg || '@HEAD')], 30000)).trim(); } catch (e) {}
  const resolveUrl = u => (u && u.startsWith('^/')) ? reposRoot + u.slice(1) : u;
  // svn diff --summarize prints paths on the OLD (first) target's URL. In branch-vs-trunk
  // mode that's the trunk prefix — map it back to the branch to read the branch's version.
  const isBvT = mode === 'branch-vs-trunk';
  const toBranch = u => (isBvT && trunkUrl && u.indexOf(trunkUrl) === 0) ? baseUrl + u.slice(trunkUrl.length) : u;
  const ctx = { trunkUrl, peg, copyRev, toBranch, resolveUrl, skip };

  const parsed = parseSummarizeLines(summary, skip);
  const skipped = parsed.skipped;

  // Unified list of everything reviewable: {path, status, catUrl, catPeg, srcUrl, source}
  const entries = [];
  const seenCat = new Set();
  const addEntry = en => { if (!seenCat.has(en.catUrl)) { seenCat.add(en.catUrl); entries.push(en); } };

  // 1) Direct files changed in the branch itself (map old-side path -> branch, cat at branch rev).
  // A summarize entry whose basename has no extension is almost certainly a directory
  // (e.g. an added dir carrying an svn:externals pin) — route it to the pin-follow step
  // instead of trying to cat it. This unifies both modes: previously the full path
  // recovered such dirs via a late cat-failure pass that summaryOnly never ran.
  const dirLike = [];
  for (const f of parsed.fileEntries) {
    const bUrl = toBranch(f.url);
    const baseName = bUrl.split('/').pop() || '';
    if (baseName.indexOf('.') === -1) { dirLike.push(f.url); continue; }
    addEntry({ path: bUrl.replace(baseUrl, '').replace(/^\//, ''), status: f.status, catUrl: bUrl, catPeg: peg, srcUrl: f.url, source: 'branch' });
  }

  // 2) Follow svn:externals pin changes into the module repos (re-pinned case).
  const pins = await followPinChanges(parsed.dirEntries.concat(dirLike), ctx);
  const externalModules = pins.externalModules;
  for (const en of pins.entries) addEntry(en);

  // 3) Discover module branches carrying the ticket's branch name (not re-pinned yet).
  const moduleBranches = [];
  const moduleLogs = [];
  const ownName = (baseUrl.match(/\/branches\/([^/]+)/) || [])[1];
  const names = [...new Set([ownName].concat(opts.branchNames || []).filter(Boolean))].slice(0, 4);
  if (names.length && trunkUrl) {
    const roots = (await collectExternalModuleRoots(baseUrl, peg, resolveUrl))
      .filter(r => !pins.pinnedRoots.has(r) && r !== moduleRootFromUrl(baseUrl));
    const found = await Promise.all(roots.map(async root => {
      for (const nm of names) {
        const bUrl = root + '/branches/' + nm;
        if (await svnExists(bUrl)) return { root, url: bUrl, name: nm };
      }
      return null;
    }));
    for (const mb of found.filter(Boolean)) {
      moduleBranches.push(mb);
      const modName = mb.root.split('/').pop();
      const sub = await branchChangeEntries(mb.url, skip);
      for (const en of sub.entries) addEntry({ path: '[' + modName + '] ' + en.rel, status: en.status, catUrl: en.catUrl, catPeg: '', source: 'module-branch' });
      if (sub.commitLog) moduleLogs.push(`--- module ${modName} (branch ${mb.name}) ---\n` + sub.commitLog.slice(0, 1500));
      log(`module branch discovered: ${mb.url} (+${sub.entries.length} files)`);
    }
  }

  // Cheap package/SDK diff (manifest.json). If found, summarise it and drop the raw
  // manifest from the review set — the diff summary replaces dumping the whole file.
  let packageChanges = null;
  try { packageChanges = await computePackageChanges(entries, copyRev); } catch (e) {}
  if (packageChanges) {
    const isManifest = en => en.source === 'branch' && /(^|\/)Packages\/manifest\.json$/i.test(en.path);
    // Drop the raw manifest from the review set (the diff summary replaces it) — but keep it
    // if it's the ONLY change, so a package-only ticket still produces a report.
    if (entries.some(en => !isManifest(en))) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (isManifest(entries[i])) { seenCat.delete(entries[i].catUrl); entries.splice(i, 1); }
      }
    }
    log(`package changes: +${packageChanges.added.length} -${packageChanges.removed.length} ~${packageChanges.changed.length}`);
  }

  let logMsg = '';
  try {
    logMsg = mode.startsWith('branch-vs-trunk')
      ? await svn(['log', '--stop-on-copy', '-l', '15', baseUrl + (peg || '@HEAD')], 30000)
      : await svn(['log', '-c', rev || 'HEAD', baseUrl], 30000);
  } catch (e) {}
  const commitLog = (logMsg.slice(0, 2000) + (moduleLogs.length ? '\n' + moduleLogs.join('\n') : '')).slice(0, 6000);

  const base = {
    mode,
    packageChanges,
    externalModules: externalModules.map(m => ({ module: m.local, from: (m.oldU || '').split('/').slice(-2).join('/') + '@' + (m.oldR || 'HEAD'), to: (m.newU || '').split('/').slice(-2).join('/') + '@' + (m.newR || 'HEAD') })),
    moduleBranches: moduleBranches.map(m => ({ module: m.root.split('/').pop(), url: m.url, branch: m.name })),
    commitLog,
    changedCount: entries.length,
    skipped: skipped.slice(0, 30)
  };

  if (opts.summaryOnly) {
    return Object.assign(base, {
      entries: entries.map(en => ({ path: en.path, status: en.status, catUrl: en.catUrl, catPeg: en.catPeg, source: en.source }))
    });
  }

  // 4) Fetch full text (capped). Directories are already diverted to the pin-follow
  // step above, so every entry here is a real file.
  const files = [];
  for (const en of entries.slice(0, MAX_FILES)) {
    try {
      let content = await svn(['cat', '--', en.catUrl + (en.catPeg || '')], 60000);
      let truncated = false;
      if (content.length > MAX_FILE_BYTES) { content = content.slice(0, MAX_FILE_BYTES); truncated = true; }
      files.push({ path: en.path, status: en.status, content, truncated });
    } catch (e) {
      if (!/E200009|refers to a directory|was not found/i.test(e.message || '')) {
        files.push({ path: en.path, status: en.status, content: '', error: e.message });
      }
    }
  }

  return Object.assign(base, {
    files,
    includedCount: files.length,
    droppedForCap: Math.max(0, entries.length - files.length)
  });
}

function handleClaudeRequest(req, res) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return;
    }

    const { prompt, tempFiles } = buildPrompt(body);
    if (!prompt.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'empty_prompt' })); return;
    }

    const claudePath = resolveClaudeCli();
    const model      = cliModelAlias(body.model);
    // Code cross-check mode: read-only tools scoped to the repo, never skip-permissions.
    // repoPath can be a local checkout folder OR a remote SVN URL (svn:// or https?://) —
    // remote mode runs in a scratch dir and the agent reads files via svn cat/ls.
    const repoVal = (appSettings.repoPath || '').trim();
    const isRemoteRepo = /^(svn(\+\w+)?|https?):\/\//i.test(repoVal);
    const useRepo = body.useRepo === true && repoVal && (isRemoteRepo || fs.existsSync(repoVal));
    // JSON output format lets us capture token usage + cost. Used for code cross-check
    // (useRepo agentic mode) and any call that opts in with body.meter (e.g. fast mode).
    const jsonOut = useRepo || body.meter === true;
    // Optional reasoning-effort control (only when the caller sets it, e.g. code cross-check).
    // Lower effort = fewer thinking tokens = cheaper. Whitelisted values only.
    const effortArg = ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort) ? ['--effort', body.effort] : [];
    const args = (useRepo
      ? ['--allowedTools', 'Read Grep Glob Bash(svn:*) Bash(git:*)', '--output-format', 'json', '--model', model, '-p']
      : jsonOut
        ? ['--dangerously-skip-permissions', '--output-format', 'json', '--model', model, '-p']
        : ['--dangerously-skip-permissions', '--model', model, '-p']).concat(effortArg);

    // shell:true required on Windows to execute .cmd batch files.
    // Prepend npm global bin so claude.cmd is found even when Electron
    // doesn't inherit the user's full terminal PATH.
    const npmBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
    const spawnOpts = {
      env: { ...process.env, PYTHONUTF8: '1', PATH: `${npmBin};${process.env.PATH || ''}` },
      windowsHide: true,
      // Only use shell for .cmd files; .exe can be spawned directly (avoids deprecation warning)
      shell: process.platform === 'win32' && claudePath.endsWith('.cmd'),
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (useRepo) {
      if (isRemoteRepo) {
        const ws = path.join(os.tmpdir(), 'notes-intel-svn');
        try { fs.mkdirSync(ws, { recursive: true }); } catch {}
        spawnOpts.cwd = ws;
        log(`code cross-check (remote svn): url=${repoVal} cwd=${ws}`);
      } else {
        spawnOpts.cwd = repoVal;
        log(`code cross-check (local): cwd=${repoVal}`);
      }
    }

    log(`spawn: ${claudePath} ${args.join(' ')} | prompt length=${prompt.length}`);

    // Keep the machine awake while the CLI runs — standby mid-analysis kills the local socket
    let psbId = null;
    try { psbId = powerSaveBlocker.start('prevent-app-suspension'); } catch {}
    const releasePsb = () => { if (psbId !== null) { try { powerSaveBlocker.stop(psbId); } catch {} psbId = null; } };

    if (body.stream) {
      res.on('error', err => log(`res socket error (stream): ${err.message}`));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const safeWrite = d => { try { res.write(d); } catch(e) { log(`res write error: ${e.message}`); } };
      safeWrite('data: ' + JSON.stringify({ type: 'message_start', message: { id: 'cli', role: 'assistant', content: [], model } }) + '\n\n');
      safeWrite('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');

      const proc = spawn(claudePath, args, spawnOpts);
      proc.stdin.on('error', err => log(`stdin error (stream): ${err.message}`));
      try { proc.stdin.write(prompt, 'utf8'); proc.stdin.end(); } catch (e) { log(`stdin write error (stream): ${e.message}`); }

      let stderrBuf = '';
      proc.stderr.on('data', chunk => { stderrBuf += chunk.toString('utf8'); });

      proc.stdout.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (text) safeWrite('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + '\n\n');
      });

      proc.on('close', (code, signal) => {
        releasePsb();
        log(`stream close: code=${code} signal=${signal} stderr_len=${stderrBuf.length}`);
        if (stderrBuf) log(`stderr: ${stderrBuf.slice(0, 800)}`);
        cleanupTempFiles(tempFiles);
        if (code !== 0) {
          const errMsg = stderrBuf.trim().slice(0, 300) ||
            (signal ? `claude killed by signal ${signal}` : `claude exited with code ${code}`);
          safeWrite('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\n[Error: ' + errMsg + ']' } }) + '\n\n');
        }
        safeWrite('data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        safeWrite('data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
        safeWrite('data: [DONE]\n\n');
        try { res.end(); } catch(e) { log(`res.end error: ${e.message}`); }
      });

      // Do NOT kill on req close — in Electron the req socket closes prematurely
      // after the body is received even though the client is still reading SSE.
      // Let Claude finish; writes to a closed socket are silently ignored.

    } else {
      // Non-streaming. With body.asyncJob the result is stored in claudeJobs and the
      // request returns a jobId immediately — the frontend polls /api/job/<id>.
      // This keeps long code-check runs off a single fragile HTTP connection.
      let output = '';
      let stderrBuf = '';
      let timedOut = false;
      const asyncJob = body.asyncJob === true;
      let jobId = null;
      if (asyncJob) {
        jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        claudeJobs[jobId] = { status: 'running', startedAt: Date.now() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
        log(`async job started: ${jobId}`);
      }
      const finish = (statusCode, payload) => {
        if (asyncJob) {
          claudeJobs[jobId] = statusCode === 200
            ? { status: 'done', payload }
            : { status: 'error', error: payload.error };
          log(`async job ${jobId}: ${claudeJobs[jobId].status}`);
        } else {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
      };

      const proc = spawn(claudePath, args, spawnOpts);
      proc.stdin.on('error', err => log(`stdin error (non-stream): ${err.message}`));
      try { proc.stdin.write(prompt, 'utf8'); proc.stdin.end(); } catch (e) { log(`stdin write error (non-stream): ${e.message}`); }

      proc.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
      proc.stderr.on('data', chunk => { stderrBuf += chunk.toString('utf8'); });

      const timer = setTimeout(() => {
        log('non-streaming call timed out — killing process');
        timedOut = true;
        proc.kill();
      }, useRepo ? 900000 : 300000); // 15 min for code cross-check, 5 min otherwise

      proc.on('close', (code, signal) => {
        releasePsb();
        clearTimeout(timer);
        log(`non-stream close: code=${code} signal=${signal} output_len=${output.length} stderr_len=${stderrBuf.length}`);
        if (stderrBuf) log(`stderr: ${stderrBuf.slice(0, 800)}`);
        cleanupTempFiles(tempFiles);

        if (timedOut) {
          finish(500, { error: `analysis timed out after ${useRepo ? 15 : 5} minutes — try narrowing the input or adding a revision number` });
          return;
        }
        if (!output.trim() && (code !== 0 || code === null)) {
          const detail = stderrBuf.trim().slice(0, 200) ||
            (signal ? `claude killed by signal ${signal} — try again or reduce input size` : `claude exited with code ${code}`);
          finish(500, { error: detail });
          return;
        }

        // Strip markdown code fences — HTML already does this too, belt-and-braces.
        let text = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        let usage = null;
        // JSON output format: unwrap .result and capture token usage (code-check + metered fast mode).
        if (jsonOut) {
          try {
            const wrap = JSON.parse(output);
            if (typeof wrap.result === 'string') text = wrap.result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            const u = wrap.usage || {};
            const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            const cost = wrap.total_cost_usd != null ? wrap.total_cost_usd : wrap.cost_usd;
            usage = { input: inTok, output: u.output_tokens || 0, turns: wrap.num_turns || null, cost: cost != null ? cost : null };
            log(`code-check tokens: input=${inTok} output=${u.output_tokens || 0} turns=${wrap.num_turns || '?'} cost=${cost != null ? '$' + Number(cost).toFixed(4) : 'n/a'}`);
          } catch (e) {
            log(`code-check: could not parse json output-format (${e.message}) — using raw output`);
          }
        }
        finish(200, {
          id: 'cli', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text }],
          usage: usage,
          stop_reason: code === 0 ? 'end_turn' : 'error',
        });
      });
    }
  });
}

const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ico': 'image/x-icon' };

async function startServer() {
  proxyPort = await getFreePort();
  const appDir = path.join(app.getAppPath(), 'app');

  proxyServer = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/api/claude') {
      handleClaudeRequest(req, res); return;
    }
    if (req.url.startsWith('/api/job/') && req.method === 'GET') {
      const jid = req.url.slice('/api/job/'.length);
      const j = claudeJobs[jid];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j || { status: 'unknown' }));
      if (j && j.status !== 'running') delete claudeJobs[jid];
      return;
    }
    if (req.url === '/api/svn-changes' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', async () => {
        let b; try { b = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
        const url = (b.url || '').replace(/@\d+$/, '').trim();
        const rev = (b.rev || '').toString().replace(/^r/i, '').trim();
        if (!url) { res.writeHead(400); res.end('{"error":"missing url"}'); return; }
        const summaryOnly = !!b.summaryOnly;
        const branchNames = Array.isArray(b.branchNames) ? b.branchNames.map(String).filter(Boolean).slice(0, 4) : [];
        log(`svn-changes: url=${url} rev=${rev || 'HEAD'}${summaryOnly ? ' (summary)' : ''}${branchNames.length ? ' names=' + branchNames.join(',') : ''}`);
        try {
          const result = await fetchSvnChangedFiles(url, rev, { summaryOnly, branchNames });
          log(summaryOnly
            ? `svn-changes: ${result.changedCount} entries (summary only), ${result.moduleBranches.length} module branch(es)`
            : `svn-changes: ${result.includedCount}/${result.changedCount} files fetched, ${result.droppedForCap} over cap`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (e) {
          log(`svn-changes error: ${e.message}`);
          res.writeHead(500); res.end(JSON.stringify({ error: e.message.slice(0, 300) }));
        }
      });
      return;
    }
    // Batch-fetch specific files by URL — used by the two-stage flow after planning.
    if (req.url === '/api/svn-cat' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', async () => {
        let b; try { b = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
        const reqFiles = Array.isArray(b.files) ? b.files.slice(0, 20) : [];
        const maxBytes = Math.min(Number(b.maxBytes) || 55000, 120000);
        const out = [];
        for (const f of reqFiles) {
          const u = ((f && f.url) || '').trim();
          if (!u) continue;
          if (!isSafeSvnTarget(u)) { out.push({ url: u, error: 'rejected target' }); continue; }
          try {
            let content = await svn(['cat', '--', u + ((f && f.peg) || '')], 60000);
            let truncated = false;
            if (content.length > maxBytes) { content = content.slice(0, maxBytes); truncated = true; }
            out.push({ url: u, content, truncated });
          } catch (e) { out.push({ url: u, error: (e.message || '').slice(0, 200) }); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: out }));
      });
      return;
    }
    // Recursive .cs path index for symbol→file lookup (consumer code). Cached per root.
    if (req.url === '/api/svn-index' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', async () => {
        let b; try { b = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
        const roots = Array.isArray(b.roots) ? b.roots.slice(0, 4) : [];
        const indexes = {};
        for (const r of roots) {
          const root = String(r || '').trim().replace(/\/$/, '');
          if (!root || !isSafeSvnTarget(root)) { if (root) indexes[root] = []; continue; }
          if (svnLsCache.has(root)) { indexes[root] = svnLsCache.get(root); continue; }
          try {
            const txt = await svn(['ls', '-R', '--', root], 240000);
            const paths = txt.split(/\r?\n/).filter(p => /\.cs$/i.test(p)).slice(0, 20000);
            svnLsCache.set(root, paths);
            indexes[root] = paths;
            log(`svn-index: ${root} → ${paths.length} .cs files`);
          } catch (e) { log(`svn-index failed for ${root}: ${(e.message || '').slice(0, 120)}`); indexes[root] = []; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ indexes }));
      });
      return;
    }
    if (req.url === '/api/settings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.assign({ appVersion: app.getVersion() }, appSettings)));
      return;
    }
    if (req.url === '/api/settings' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try {
          const patch = JSON.parse(raw);
          const allowed = ['provider', 'openaiKey', 'folderPath', 'jiraUrl', 'repoPath'];
          allowed.forEach(k => { if (k in patch) appSettings[k] = patch[k]; });
          saveSettings();
          log(`settings updated: provider=${appSettings.provider} folder=${appSettings.folderPath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        } catch (e) { res.writeHead(400); res.end('{"error":"bad json"}'); }
      });
      return;
    }
    if (req.url === '/api/pick-folder') {
      const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : mainWindow;
      dialog.showOpenDialog(parent, { properties: ['openDirectory'] }).then(result => {
        if (result.canceled || !result.filePaths.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"cancelled":true}');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: result.filePaths[0] }));
        }
      }).catch(err => { log(`pick-folder error: ${err.message}`); res.writeHead(500); res.end('{}'); });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/save-file') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try {
          const { folder, filename, content } = JSON.parse(raw);
          const allowed = appSettings.folderPath ? path.resolve(appSettings.folderPath) : null;
          const resolved = path.resolve(folder);
          if (!allowed || (!resolved.startsWith(allowed + path.sep) && resolved !== allowed)) {
            res.writeHead(403); res.end('{"error":"forbidden path"}'); return;
          }
          const safeName = path.basename(filename).replace(/[/\\:*?"<>|]/g, '_');
          const dest = path.join(resolved, safeName);
          fs.promises.writeFile(dest, content, 'utf8').then(() => {
            log(`save-file: ${dest}`);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: dest }));
          }).catch(err => { log(`save-file error: ${err.message}`); res.writeHead(500); res.end('{"error":"write failed"}'); });
          return;
        } catch (err) { log(`save-file error: ${err.message}`); res.writeHead(500); res.end('{"error":"write failed"}'); }
      });
      return;
    }
    if (req.url === '/api/quit-and-install') {
      res.writeHead(200); res.end('ok');
      setTimeout(() => autoUpdater.quitAndInstall(), 500);
      return;
    }
    const urlPath = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
    const filePath = path.join(appDir, urlPath);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });

  // Long-running requests (code cross-check reads a repo for up to 10 min) —
  // disable Node's default 5-min request timeout which drops the socket mid-call.
  proxyServer.requestTimeout = 0;
  proxyServer.headersTimeout = 60000;
  proxyServer.keepAliveTimeout = 620000;

  await new Promise(resolve => proxyServer.listen(proxyPort, '127.0.0.1', resolve));
  log(`server started on port ${proxyPort}`);
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 440, height: 400,
    title: 'Notes Intel — Settings',
    parent: mainWindow,
    modal: false,
    show: false,
    resizable: false,
    backgroundColor: '#080809',
    icon: path.join(__dirname, '..', 'electron-resources', 'icon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadURL(`http://127.0.0.1:${proxyPort}/settings.html`);
}

function setupAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Notes Intel',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettingsWindow },
        { type: 'separator' },
        { label: 'Quit Notes Intel', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 900,
    minWidth: 680,
    minHeight: 600,
    show: false,
    title: 'Notes Intel',
    backgroundColor: '#080809',
    icon: path.join(__dirname, '..', 'electron-resources', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.loadURL(`http://127.0.0.1:${proxyPort}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function setupAutoUpdater() {
  autoUpdater.logger = { info: msg => log(`updater: ${msg}`), warn: msg => log(`updater warn: ${msg}`), error: msg => log(`updater error: ${msg}`) };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info => {
    log(`update available: ${info.version}`);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `(function(){ var b=document.createElement('div');
        b.style.cssText='position:fixed;top:12px;right:12px;z-index:99999;background:#0d1f16;border:0.5px solid #5DCAA5;border-radius:8px;padding:10px 16px;font-family:JetBrains Mono,monospace;font-size:11px;color:#5DCAA5;letter-spacing:.04em;';
        b.textContent='⬇ Update v${info.version} downloading…';
        document.body.appendChild(b);
        setTimeout(function(){b.remove();},6000); })()`
      ).catch(() => {});
    }
  });

  autoUpdater.on('update-downloaded', () => {
    log('update downloaded — will install on quit');
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `(function(){ var b=document.createElement('div');
        b.style.cssText='position:fixed;top:12px;right:12px;z-index:99999;background:#0d1f16;border:0.5px solid #5DCAA5;border-radius:8px;padding:10px 16px;font-family:JetBrains Mono,monospace;font-size:11px;color:#5DCAA5;letter-spacing:.04em;cursor:pointer;';
        b.innerHTML='✓ Update ready — <u>restart to apply</u>';
        b.onclick=function(){require("electron").ipcRenderer;};
        document.body.appendChild(b);
        b.addEventListener("click",function(){ fetch("/api/quit-and-install"); }); })()`
      ).catch(() => {});
    }
  });

  autoUpdater.on('error', err => log(`updater error: ${err && err.message}`));
  autoUpdater.checkForUpdatesAndNotify().catch(err => log(`update check failed: ${err && err.message}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.tactilegames.notesintel');
    loadSettings();
    setupAppMenu();
    await startServer();
    createWindow();
    setupAutoUpdater();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (proxyServer) proxyServer.close(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
