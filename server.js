const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const ytSearch = require('yt-search');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'playlists.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Cache structures
const streamCache = new Map(); // videoId -> { url: string, expiresAt: number }
const searchCache = new Map(); // query -> { results: Array, expiresAt: number }

// Helper: Ensure playlists file exists
function getPlaylists() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const initial = [
        {
          id: 'favorites',
          name: 'Tus me gusta',
          description: 'Tus canciones favoritas guardadas',
          isSystem: true,
          cover: '',
          createdAt: Date.now(),
          tracks: []
        }
      ];
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading playlists:', err);
    return [];
  }
}

function savePlaylists(playlists) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error saving playlists:', err);
    return false;
  }
}

// Helper: Get cookies file path if available (copies to /tmp to avoid read-only filesystem issues)
function getCookiesPath() {
  const TMP_COOKIES = '/tmp/yt_dlp_cookies.txt';

  function copyToTmp(sourcePath) {
    try {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      fs.writeFileSync(TMP_COOKIES, content, 'utf-8');
      console.log(`🍪 Cookies copiadas desde ${sourcePath} → ${TMP_COOKIES}`);
      return TMP_COOKIES;
    } catch (e) {
      console.warn(`Could not copy cookies from ${sourcePath}:`, e.message);
      return null;
    }
  }

  if (process.env.COOKIES_PATH && fs.existsSync(process.env.COOKIES_PATH)) {
    return copyToTmp(process.env.COOKIES_PATH) || process.env.COOKIES_PATH;
  }
  const renderSecretPath = '/etc/secrets/cookies.txt';
  if (fs.existsSync(renderSecretPath)) {
    return copyToTmp(renderSecretPath) || renderSecretPath;
  }
  const localCookies = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(localCookies)) {
    return copyToTmp(localCookies) || localCookies;
  }
  if (process.env.YOUTUBE_COOKIES) {
    try {
      let content = process.env.YOUTUBE_COOKIES.trim();
      if (!content.includes('\t') && content.length > 50) {
        try { content = Buffer.from(content, 'base64').toString('utf-8'); } catch (_) {}
      }
      fs.writeFileSync(TMP_COOKIES, content, 'utf-8');
      return TMP_COOKIES;
    } catch (e) {
      console.warn('Could not write cookies from env:', e.message);
    }
  }
  return null;
}

// Piped API instances (reliable YouTube frontend, no datacenter IP restrictions)
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.projectsegfau.lt',
];

// Invidious public instances (secondary fallback)
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.privacydev.net',
  'https://invidious.lunar.icu',
  'https://yt.oelrichsgarcia.de',
  'https://invidious.perennialte.ch',
];

// Resolve audio URL via Piped API
async function resolveViaPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const url = `${instance}/streams/${videoId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { console.log(`[${videoId}] Piped ${instance} HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (data.error) { console.log(`[${videoId}] Piped ${instance} error: ${data.error}`); continue; }

      const audioStreams = (data.audioStreams || [])
        .filter(s => s.mimeType && (s.mimeType.includes('mp4') || s.mimeType.includes('m4a')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (audioStreams.length > 0) {
        console.log(`[${videoId}] ✅ Piped stream via ${instance} (${audioStreams[0].bitrate}bps)`);
        return audioStreams[0].url;
      }

      const anyAudio = (data.audioStreams || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (anyAudio.length > 0) {
        console.log(`[${videoId}] ✅ Piped audio (non-m4a) via ${instance}`);
        return anyAudio[0].url;
      }

      if (data.hls) {
        console.log(`[${videoId}] ✅ Piped HLS via ${instance}`);
        return data.hls;
      }

      console.log(`[${videoId}] Piped ${instance} returned no audio streams`);
    } catch (e) {
      console.log(`[${videoId}] Piped ${instance} error: ${e.message}`);
    }
  }
  throw new Error('All Piped instances failed');
}

// Resolve audio URL via Invidious API
async function resolveViaInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,hlsUrl`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { console.log(`[${videoId}] Invidious ${instance} HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (data.error) { console.log(`[${videoId}] Invidious ${instance} API error: ${data.error}`); continue; }

      const formats = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.startsWith('audio/') && (f.type.includes('mp4') || f.type.includes('m4a')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (formats.length > 0) {
        console.log(`[${videoId}] ✅ Invidious stream via ${instance}`);
        return formats[0].url;
      }

      const anyAudio = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (anyAudio.length > 0) {
        console.log(`[${videoId}] ✅ Invidious audio (non-m4a) via ${instance}`);
        return anyAudio[0].url;
      }

      if (data.hlsUrl) {
        console.log(`[${videoId}] ✅ Invidious HLS via ${instance}`);
        return data.hlsUrl;
      }

      console.log(`[${videoId}] Invidious ${instance} returned no audio formats`);
    } catch (e) {
      console.log(`[${videoId}] Invidious ${instance} error: ${e.message}`);
    }
  }
  throw new Error('All Invidious instances failed');
}

// Resolve audio URL via yt-dlp (fallback when Invidious fails)
function resolveViaYtDlp(videoId) {
  const cookiesPath = getCookiesPath();
  const isWin = process.platform === 'win32';
  const localBin = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  function buildArgs(extraArgs = []) {
    const args = ['--no-warnings', '--no-playlist', '-g',
      '-f', '140/bestaudio[ext=m4a]/bestaudio/best', ...extraArgs];
    if (cookiesPath) args.unshift('--cookies', cookiesPath);
    args.push(videoUrl);
    return args;
  }

  function run(cmd, args) {
    return new Promise((res, rej) => {
      execFile(cmd, args, { timeout: 30000 }, (error, stdout) => {
        if (error) return rej(error);
        const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('http'));
        if (!lines.length) return rej(new Error('No URL in output'));
        res(lines[0].trim());
      });
    });
  }

  function runWithArgs(extraArgs) {
    const args = buildArgs(extraArgs);
    if (fs.existsSync(localBin)) return run(localBin, args);
    return run('python3', ['-m', 'yt_dlp', ...args])
      .catch(() => run('python', ['-m', 'yt_dlp', ...args]));
  }

  const withClient = (c) => runWithArgs(['--extractor-args', `youtube:player_client=${c}`]);
  return withClient('tv_embedded')
    .catch(() => withClient('ios'))
    .catch(() => withClient('mweb'))
    .catch(() => withClient('web'))
    .catch(() => runWithArgs([]));
}

// Helper: Resolve audio stream URL — tries Piped → Invidious → yt-dlp
async function resolveAudioUrl(videoId, forceFresh = false) {
  const cached = streamCache.get(videoId);
  if (!forceFresh && cached && cached.expiresAt > Date.now()) return cached.url;

  let streamUrl;

  // 1. Try Piped (most reliable for datacenter IPs)
  try {
    streamUrl = await resolveViaPiped(videoId);
  } catch (_) {
    // 2. Try Invidious
    console.log(`[${videoId}] Piped failed, trying Invidious...`);
    try {
      streamUrl = await resolveViaInvidious(videoId);
    } catch (_2) {
      // 3. Try yt-dlp as last resort
      console.log(`[${videoId}] Invidious failed, trying yt-dlp...`);
      try {
        streamUrl = await resolveViaYtDlp(videoId);
        console.log(`[${videoId}] ✅ yt-dlp stream resolved`);
      } catch (e3) {
        console.error(`[${videoId}] All sources failed:`, e3.message);
        throw new Error('Failed to extract audio stream');
      }
    }
  }

  streamCache.set(videoId, { url: streamUrl, expiresAt: Date.now() + 3 * 60 * 60 * 1000 });
  return streamUrl;
}


// API: Search YouTube
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.json({ tracks: [] });
  }

  const cached = searchCache.get(query.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ tracks: cached.results });
  }

  try {
    const result = await ytSearch(query);
    const videos = (result && result.videos ? result.videos : []).slice(0, 25);

    const tracks = videos.map(v => ({
      id: v.videoId,
      title: v.title,
      artist: v.author ? v.author.name : 'YouTube Music',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      duration: v.seconds || 0,
      durationFormatted: v.timestamp || '0:00',
      views: v.views
    }));

    searchCache.set(query.toLowerCase(), {
      results: tracks,
      expiresAt: Date.now() + 15 * 60 * 1000 // 15 min cache
    });

    res.json({ tracks });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Error searching tracks', tracks: [] });
  }
});

// API: Stream Audio (Supports iOS Range Requests)
app.get('/api/stream/:id', async (req, res) => {
  const videoId = req.params.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  async function attemptStream(retry = false) {
    try {
      const streamUrl = await resolveAudioUrl(videoId, retry);

      const requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      };

      if (req.headers.range) {
        requestHeaders['Range'] = req.headers.range;
      }

      const controller = new AbortController();
      req.on('close', () => controller.abort());

      const ytResponse = await fetch(streamUrl, {
        headers: requestHeaders,
        signal: controller.signal
      });

      if (!ytResponse.ok) {
        // If 403 Forbidden, stream URL expired, retry once with fresh URL
        if (ytResponse.status === 403 && !retry) {
          console.log(`Stream 403 for ${videoId}, retrying with fresh URL...`);
          streamCache.delete(videoId);
          return attemptStream(true);
        }
        return res.status(ytResponse.status).send('Upstream stream error');
      }

      // Forward headers necessary for iOS Safari seeking and background play
      res.status(ytResponse.status);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', ytResponse.headers.get('content-type') || 'audio/mp4');

      const contentRange = ytResponse.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);

      const contentLength = ytResponse.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      res.setHeader('Cache-Control', 'public, max-age=3600');

      if (ytResponse.body) {
        Readable.fromWeb(ytResponse.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(`Streaming error for ${videoId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).send('Error streaming audio');
      }
    }
  }

  await attemptStream();
});

// API: Track Info (useful for direct links / IDs)
app.get('/api/info/:id', async (req, res) => {
  const videoId = req.params.id;
  try {
    const result = await ytSearch({ videoId });
    if (!result) return res.status(404).json({ error: 'Track not found' });

    res.json({
      id: result.videoId,
      title: result.title,
      artist: result.author ? result.author.name : 'YouTube Music',
      thumbnail: result.thumbnail || `https://i.ytimg.com/vi/${result.videoId}/hqdefault.jpg`,
      duration: result.seconds || 0,
      durationFormatted: result.timestamp || '0:00'
    });
  } catch (err) {
    console.error('Info error:', err);
    res.status(500).json({ error: 'Error fetching track info' });
  }
});

// API: Playlists CRUD
app.get('/api/playlists', (req, res) => {
  res.json(getPlaylists());
});

app.post('/api/playlists', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const playlists = getPlaylists();
  const newPlaylist = {
    id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: name.trim(),
    description: (description || '').trim(),
    isSystem: false,
    cover: '',
    createdAt: Date.now(),
    tracks: []
  };

  playlists.push(newPlaylist);
  savePlaylists(playlists);
  res.status(201).json(newPlaylist);
});

app.delete('/api/playlists/:id', (req, res) => {
  const { id } = req.params;
  const playlists = getPlaylists();
  const target = playlists.find(p => p.id === id);

  if (!target) {
    return res.status(404).json({ error: 'Playlist not found' });
  }
  if (target.isSystem) {
    return res.status(400).json({ error: 'Cannot delete system playlist' });
  }

  const filtered = playlists.filter(p => p.id !== id);
  savePlaylists(filtered);
  res.json({ success: true });
});

// API: Add track to playlist
app.post('/api/playlists/:id/tracks', (req, res) => {
  const { id } = req.params;
  const track = req.body;

  if (!track || !track.id) {
    return res.status(400).json({ error: 'Invalid track data' });
  }

  const playlists = getPlaylists();
  const playlist = playlists.find(p => p.id === id);

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  // Prevent duplicate track addition if already exists
  const exists = playlist.tracks.some(t => t.id === track.id);
  if (!exists) {
    playlist.tracks.push({
      id: track.id,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail,
      duration: track.duration,
      durationFormatted: track.durationFormatted,
      addedAt: Date.now()
    });
    // Set playlist cover to first track's thumbnail if empty
    if (!playlist.cover && track.thumbnail) {
      playlist.cover = track.thumbnail;
    }
    savePlaylists(playlists);
  }

  res.json(playlist);
});

// API: Remove track from playlist
app.delete('/api/playlists/:id/tracks/:trackId', (req, res) => {
  const { id, trackId } = req.params;
  const playlists = getPlaylists();
  const playlist = playlists.find(p => p.id === id);

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
  savePlaylists(playlists);
  res.json(playlist);
});

// Helper to get local network IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Fallback for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  const networkUrl = `http://${localIp}:${PORT}`;
  const localUrl = `http://localhost:${PORT}`;

  console.log('\n' + '='.repeat(50));
  console.log('🎵 SPOTIFY WEB CLONE (YOUTUBE BACKGROUND AUDIO) 🎵');
  console.log('='.repeat(50));
  console.log(`\n💻 En tu computadora: ${localUrl}`);
  console.log(`📱 En tu iPhone (misma Wi-Fi): ${networkUrl}\n`);
  console.log('Escanea este código QR con la cámara de tu iPhone:');

  try {
    qrcode.generate(networkUrl, { small: true });
  } catch (e) {
    console.log('QR Code could not be generated in terminal.');
  }

  const cookiesFound = getCookiesPath();
  if (cookiesFound) {
    console.log(`🍪 Cookies de YouTube activas: ${cookiesFound}`);
  } else {
    console.log('ℹ️ Sin archivo de cookies. (En Render: configurar Secret File "cookies.txt")');
  }

  const isWin = process.platform === 'win32';
  const localBin = path.join(__dirname, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(localBin)) {
    console.log(`⚡ Binario de yt-dlp local detectado: ${localBin}`);
  } else {
    console.log('⚡ yt-dlp: usando binario del sistema o python.');
  }

  console.log('='.repeat(50) + '\n');
});
