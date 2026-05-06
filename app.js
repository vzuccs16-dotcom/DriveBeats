/* ═══════════════════════════════════════════
   DriveBeats — app.js
   Google Drive music player
═══════════════════════════════════════════ */

'use strict';

// ── CONFIG ──────────────────────────────────────────────────────────────────
const SCOPES       = 'https://www.googleapis.com/auth/drive.readonly';
const AUDIO_TYPES  = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac',
                      'audio/x-flac', 'audio/mp4', 'audio/x-m4a', 'audio/ogg',
                      'audio/aac', 'audio/x-aac', 'audio/webm'];
const AUDIO_EXTS   = /\.(mp3|wav|flac|m4a|ogg|aac|opus|weba|webm)$/i;

// ── STATE ───────────────────────────────────────────────────────────────────
let tokenClient   = null;
let accessToken   = null;
let allTracks     = [];   // { id, name, mimeType, modifiedTime, size }
let queue         = [];   // current play queue (indices into allTracks)
let queueIdx      = -1;   // position in queue
let shuffleOn     = false;
let repeatMode    = 0;    // 0=off 1=all 2=one
let folderStack   = [];   // navigation stack for folder browser

const audio = document.getElementById('audio-player');

// ── INIT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('origin-hint').textContent = location.origin;

  // Load saved client ID
  const saved = localStorage.getItem('db_client_id');
  if (saved) document.getElementById('client-id-input').value = saved;

  // Wire audio events
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onTrackEnded);
  audio.addEventListener('loadedmetadata', onMetadata);
  audio.addEventListener('play', () => setPlayIcon(true));
  audio.addEventListener('pause', () => setPlayIcon(false));
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
function loadGsiScript(clientId) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
}

async function connectDrive() {
  const clientId = document.getElementById('client-id-input').value.trim();
  if (!clientId) { showAuthError('Please paste your Client ID first.'); return; }
  localStorage.setItem('db_client_id', clientId);

  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  clearAuthError();

  try {
    await loadGsiScript(clientId);

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: handleTokenResponse,
      error_callback: (err) => {
        showAuthError('Auth error: ' + (err.message || JSON.stringify(err)));
        btn.disabled = false;
        btn.textContent = 'Connect to Google Drive';
      }
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  } catch (e) {
    showAuthError(e.message);
    btn.disabled = false;
    btn.textContent = 'Connect to Google Drive';
  }
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    showAuthError('OAuth error: ' + resp.error);
    document.getElementById('connect-btn').disabled = false;
    document.getElementById('connect-btn').textContent = 'Connect to Google Drive';
    return;
  }

  accessToken = resp.access_token;
  showApp();
  await loadAllMusic();
}

function signOut() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  allTracks = [];
  queue = [];
  queueIdx = -1;
  audio.src = '';
  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('player-bar').classList.add('hidden');
  document.getElementById('connect-btn').disabled = false;
  document.getElementById('connect-btn').textContent = 'Connect to Google Drive';
}

// ── SCREEN SWITCHING ─────────────────────────────────────────────────────────
function showApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
}

// ── DRIVE API ─────────────────────────────────────────────────────────────────
async function driveRequest(url) {
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (res.status === 401) { signOut(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error('Drive API error: ' + res.status);
  return res.json();
}

async function loadAllMusic() {
  const grid  = document.getElementById('track-grid');
  const empty = document.getElementById('empty-library');
  const loading = document.getElementById('loading-indicator');

  grid.innerHTML = '';
  empty.classList.add('hidden');
  loading.classList.remove('hidden');

  try {
    allTracks = await fetchAllMusicFiles();
  } catch (e) {
    loading.classList.add('hidden');
    grid.innerHTML = `<div class="empty-state"><div class="empty-text">Error loading Drive: ${e.message}</div></div>`;
    return;
  }

  loading.classList.add('hidden');

  if (allTracks.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  sortTracksBy('name');
  renderTrackGrid(allTracks, 'track-grid');

  // Set default queue to all tracks in order
  queue = allTracks.map((_, i) => i);
}

async function fetchAllMusicFiles() {
  const files = [];
  let pageToken = null;

  // Query for audio files
  const mimeQuery = AUDIO_TYPES.map(m => `mimeType='${m}'`).join(' or ');
  const query = encodeURIComponent(`(${mimeQuery}) and trashed=false`);
  const fields = 'nextPageToken,files(id,name,mimeType,modifiedTime,size)';

  do {
    let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${encodeURIComponent(fields)}&pageSize=1000`;
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);

    const data = await driveRequest(url);
    if (data.files) files.push(...data.files);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  // Also catch files that may have wrong MIME but right extension
  // (some uploaders don't set MIME correctly)
  const extQuery = encodeURIComponent(`name contains '.mp3' or name contains '.flac' or name contains '.m4a' or name contains '.ogg' or name contains '.wav' or name contains '.aac'`);
  let extToken = null;
  do {
    let url = `https://www.googleapis.com/drive/v3/files?q=${extQuery} and trashed=false&fields=${encodeURIComponent(fields)}&pageSize=1000`;
    if (extToken) url += '&pageToken=' + encodeURIComponent(extToken);
    const data = await driveRequest(url);
    if (data.files) {
      for (const f of data.files) {
        if (!files.find(x => x.id === f.id) && AUDIO_EXTS.test(f.name)) {
          files.push(f);
        }
      }
    }
    extToken = data.nextPageToken || null;
  } while (extToken);

  return files;
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderTrackGrid(tracks, containerId) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = '';

  tracks.forEach((track, localIdx) => {
    const globalIdx = allTracks.indexOf(track);
    const ext = (track.name.match(/\.(\w+)$/) || ['','?'])[1].toUpperCase();
    const playing = queueIdx >= 0 && queue[queueIdx] === globalIdx;

    const card = document.createElement('div');
    card.className = 'track-card' + (playing ? ' playing' : '');
    card.dataset.globalIdx = globalIdx;
    card.innerHTML = `
      <div class="track-art">
        <span>🎵</span>
        <div class="track-play-overlay">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
        <div class="eq-bars">
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
        </div>
      </div>
      <div class="track-name" title="${escHtml(track.name)}">${escHtml(stripExt(track.name))}</div>
      <div class="track-ext">${ext}</div>
    `;
    card.onclick = () => playFromLibrary(globalIdx);
    grid.appendChild(card);
  });
}

// ── PLAYBACK ──────────────────────────────────────────────────────────────────
function playFromLibrary(globalIdx) {
  // Set queue to all tracks and jump to this one
  queue = allTracks.map((_, i) => i);
  if (shuffleOn) {
    // Move chosen track to front, shuffle rest
    const rest = queue.filter(i => i !== globalIdx);
    shuffleArray(rest);
    queue = [globalIdx, ...rest];
    queueIdx = 0;
  } else {
    queueIdx = queue.indexOf(globalIdx);
  }
  playCurrentTrack();
}

async function playCurrentTrack() {
  if (queueIdx < 0 || queueIdx >= queue.length) return;
  const track = allTracks[queue[queueIdx]];

  // Stream via Google Drive API
  const streamUrl = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;

  // We need to fetch with auth header, then create object URL (for CORS)
  try {
    const res = await fetch(streamUrl, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) throw new Error('Could not stream file');
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);

    // Revoke old object URL
    if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.src = objUrl;
    audio.play();

    updatePlayerUI(track);
    updateQueueUI();
    highlightPlayingCard();
  } catch (e) {
    console.error('Playback error:', e);
  }
}

function updatePlayerUI(track) {
  document.getElementById('player-bar').classList.remove('hidden');
  document.getElementById('player-title').textContent = stripExt(track.name);
  document.getElementById('player-artist').textContent = getExt(track.name).toUpperCase() + ' · Google Drive';
  document.getElementById('player-art').innerHTML = '🎵';
}

function highlightPlayingCard() {
  document.querySelectorAll('.track-card').forEach(card => {
    const idx = parseInt(card.dataset.globalIdx);
    const isPlaying = queueIdx >= 0 && queue[queueIdx] === idx;
    card.classList.toggle('playing', isPlaying);
  });
}

function togglePlay() {
  if (audio.paused) audio.play(); else audio.pause();
}

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (repeatMode === 2) { audio.currentTime = 0; audio.play(); return; }
  queueIdx = (queueIdx - 1 + queue.length) % queue.length;
  playCurrentTrack();
}

function nextTrack() {
  if (repeatMode === 2) { audio.currentTime = 0; audio.play(); return; }
  if (queueIdx < queue.length - 1) {
    queueIdx++;
    playCurrentTrack();
  } else if (repeatMode === 1) {
    queueIdx = 0;
    playCurrentTrack();
  }
}

function onTrackEnded() {
  if (repeatMode === 2) { audio.play(); return; }
  if (queueIdx < queue.length - 1) {
    queueIdx++;
    playCurrentTrack();
  } else if (repeatMode === 1) {
    queueIdx = 0;
    playCurrentTrack();
  } else {
    setPlayIcon(false);
  }
}

function toggleShuffle() {
  shuffleOn = !shuffleOn;
  document.getElementById('shuffle-btn').classList.toggle('active', shuffleOn);
  if (shuffleOn && queue.length > 1) {
    const current = queue[queueIdx];
    const rest = queue.filter((_, i) => i !== queueIdx);
    shuffleArray(rest);
    queue = [current, ...rest];
    queueIdx = 0;
    updateQueueUI();
  }
}

function toggleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const btn = document.getElementById('repeat-btn');
  btn.classList.toggle('active', repeatMode > 0);
  btn.title = ['Repeat: Off', 'Repeat: All', 'Repeat: One'][repeatMode];
}

function shuffleAll() {
  if (allTracks.length === 0) return;
  queue = allTracks.map((_, i) => i);
  shuffleArray(queue);
  queueIdx = 0;
  playCurrentTrack();
}

// ── PROGRESS & VOLUME ─────────────────────────────────────────────────────────
function onTimeUpdate() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('current-time').textContent = formatTime(audio.currentTime);
}

function onMetadata() {
  document.getElementById('total-time').textContent = formatTime(audio.duration);
}

function seekTo(e) {
  const bar = document.getElementById('progress-bar');
  const rect = bar.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

function setVolume(v) { audio.volume = parseFloat(v); }

function setPlayIcon(playing) {
  document.getElementById('play-icon').classList.toggle('hidden', playing);
  document.getElementById('pause-icon').classList.toggle('hidden', !playing);
}

// ── QUEUE UI ──────────────────────────────────────────────────────────────────
function updateQueueUI() {
  const list = document.getElementById('queue-list');
  const upcoming = queue.slice(queueIdx, queueIdx + 12);

  if (upcoming.length === 0) {
    list.innerHTML = '<div class="queue-empty">No queue yet</div>';
    return;
  }

  list.innerHTML = upcoming.map((globalIdx, i) => {
    const track = allTracks[globalIdx];
    const isCurrent = i === 0;
    return `<div class="queue-item ${isCurrent ? 'active' : ''}" onclick="jumpQueue(${queueIdx + i})">
      <span class="queue-num">${isCurrent ? '▶' : queueIdx + i + 1}</span>
      <span class="queue-name">${escHtml(stripExt(track.name))}</span>
    </div>`;
  }).join('');
}

function jumpQueue(idx) {
  queueIdx = idx;
  playCurrentTrack();
}

// ── SORT ──────────────────────────────────────────────────────────────────────
function sortTracks() {
  sortTracksBy(document.getElementById('sort-select').value);
}

function sortTracksBy(mode) {
  if (mode === 'name') allTracks.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'name-desc') allTracks.sort((a, b) => b.name.localeCompare(a.name));
  else if (mode === 'recent') allTracks.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  renderTrackGrid(allTracks, 'track-grid');
  queue = allTracks.map((_, i) => i);
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
let searchTimeout = null;
function handleSearch(q) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => doSearch(q), 200);
}

function doSearch(q) {
  const resultsEl = document.getElementById('search-results');
  const emptyEl   = document.getElementById('search-empty');

  if (!q.trim()) {
    resultsEl.innerHTML = '';
    emptyEl.classList.add('hidden');
    return;
  }

  const lower = q.toLowerCase();
  const results = allTracks.filter(t => t.name.toLowerCase().includes(lower));

  if (results.length === 0) {
    resultsEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    renderTrackGrid(results, 'search-results');
  }
}

// ── FOLDER BROWSER ───────────────────────────────────────────────────────────
document.querySelector('[data-view="folders"]').addEventListener('click', () => {
  if (folderStack.length === 0) loadFolder('root', 'My Drive');
});

async function loadFolder(folderId, folderName) {
  const grid = document.getElementById('folder-grid');
  grid.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading…</span></div>';

  // Push to stack
  folderStack.push({ id: folderId, name: folderName });
  renderBreadcrumb();

  try {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = 'files(id,name,mimeType,modifiedTime)';
    const data = await driveRequest(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent(fields)}&pageSize=200&orderBy=folder,name`
    );

    grid.innerHTML = '';
    const folders = data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const music   = data.files.filter(f => AUDIO_TYPES.includes(f.mimeType) || AUDIO_EXTS.test(f.name));

    if (folders.length === 0 && music.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><div class="empty-text">This folder is empty.</div></div>';
      return;
    }

    for (const folder of folders) {
      const card = document.createElement('div');
      card.className = 'folder-card';
      card.innerHTML = `<span class="folder-icon">📁</span><div><div class="folder-name">${escHtml(folder.name)}</div><div class="folder-count">Folder</div></div>`;
      card.onclick = () => loadFolder(folder.id, folder.name);
      grid.appendChild(card);
    }

    for (const track of music) {
      // Add to allTracks if not already there
      let globalIdx = allTracks.findIndex(t => t.id === track.id);
      if (globalIdx === -1) { allTracks.push(track); globalIdx = allTracks.length - 1; }

      const ext = getExt(track.name).toUpperCase();
      const card = document.createElement('div');
      card.className = 'track-card';
      card.dataset.globalIdx = globalIdx;
      card.innerHTML = `
        <div class="track-art">
          <span>🎵</span>
          <div class="track-play-overlay">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
        </div>
        <div class="track-name" title="${escHtml(track.name)}">${escHtml(stripExt(track.name))}</div>
        <div class="track-ext">${ext}</div>`;
      card.onclick = () => playFromLibrary(globalIdx);
      grid.appendChild(card);
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-text">Error: ${e.message}</div></div>`;
  }
}

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = folderStack.map((item, i) => {
    const isCurrent = i === folderStack.length - 1;
    const sep = i > 0 ? '<span class="breadcrumb-sep">›</span>' : '';
    return `${sep}<span class="breadcrumb-item ${isCurrent ? 'current' : ''}" 
      onclick="${isCurrent ? '' : `navigateTo(${i})`}">${escHtml(item.name)}</span>`;
  }).join('');
}

function navigateTo(stackIdx) {
  folderStack = folderStack.slice(0, stackIdx);
  const target = folderStack.pop(); // will be re-pushed by loadFolder
  loadFolder(target.id, target.name);
}

// ── AUTH ERROR ────────────────────────────────────────────────────────────────
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stripExt(name) { return name.replace(/\.[^/.]+$/, ''); }
function getExt(name) { return (name.match(/\.([^.]+)$/) || ['',''])[1]; }
function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2,'0')}`;
}
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
