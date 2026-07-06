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

// Fast code-check: fetch the full text of every file changed in a revision.
// One `svn diff --summarize` + one `svn cat` per changed file — no agentic crawl.
async function fetchSvnChangedFiles(baseUrl, rev) {
  const SKIP_EXT = /\.(meta|png|jpg|jpeg|gif|tga|psd|fbx|anim|controller|prefab|unity|asset|dll|so|a|mat|wav|mp3|ogg|ttf|otf|bytes)$/i;
  const MAX_FILES = 12;
  const MAX_FILE_BYTES = 55000;
  const peg = rev ? '@' + rev : '';
  const revArg = rev ? ['-c', rev] : ['-c', 'HEAD'];
  // --summarize gives one line per changed path: "M       <url>"
  const summary = await svn(['diff', '--summarize'].concat(revArg).concat([baseUrl]), 90000);
  const lines = summary.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const all = [];
  const skipped = [];
  for (const line of lines) {
    const m = line.match(/^([AMDR!~ ]+)\s+(\S.*)$/);
    if (!m) continue;
    const status = m[1].trim();
    const url = m[2].trim();
    if (status === 'D') { skipped.push({ url, why: 'deleted' }); continue; }
    if (SKIP_EXT.test(url)) { skipped.push({ url, why: 'asset/binary' }); continue; }
    all.push({ status, url });
  }
  const picked = all.slice(0, MAX_FILES);
  const files = [];
  for (const f of picked) {
    try {
      let content = await svn(['cat', f.url + peg], 60000);
      let truncated = false;
      if (content.length > MAX_FILE_BYTES) { content = content.slice(0, MAX_FILE_BYTES); truncated = true; }
      files.push({ path: f.url.replace(baseUrl, '').replace(/^\//, ''), status: f.status, content, truncated });
    } catch (e) {
      files.push({ path: f.url.replace(baseUrl, '').replace(/^\//, ''), status: f.status, content: '', error: e.message });
    }
  }
  let logMsg = '';
  try { logMsg = await svn(['log'].concat(revArg).concat([baseUrl]), 30000); } catch (e) {}
  return {
    files,
    commitLog: logMsg.slice(0, 2000),
    changedCount: all.length,
    includedCount: files.length,
    droppedForCap: Math.max(0, all.length - picked.length),
    skipped: skipped.slice(0, 30)
  };
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
    const args = useRepo
      ? ['--allowedTools', 'Read Grep Glob Bash(svn:*) Bash(git:*)', '--output-format', 'json', '--model', model, '-p']
      : jsonOut
        ? ['--dangerously-skip-permissions', '--output-format', 'json', '--model', model, '-p']
        : ['--dangerously-skip-permissions', '--model', model, '-p'];

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
        log(`svn-changes: url=${url} rev=${rev || 'HEAD'}`);
        try {
          const result = await fetchSvnChangedFiles(url, rev);
          log(`svn-changes: ${result.includedCount}/${result.changedCount} files fetched, ${result.droppedForCap} over cap`);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (e) {
          log(`svn-changes error: ${e.message}`);
          res.writeHead(500); res.end(JSON.stringify({ error: e.message.slice(0, 300) }));
        }
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
