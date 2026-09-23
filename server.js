const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { Readable } = require('stream');
const qrcode   = require('qrcode-terminal');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'playlists.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Caches ──────────────────────────────────────────────────────────────────
const streamCache = new Map(); // trackId -> { url, expiresAt }
const searchCache = new Map(); // query   -> { results, expiresAt }

// ─── Playlists helpers ────────────────────────────────────────────────────────
function getPlaylists() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = [{ id: 'favorites', name: 'Tus me gusta', description: 'Tus canciones favoritas', isSystem: true, cover: '', createdAt: Date.now(), tracks: [] }];
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch(e) { console.error('getPlaylists:', e); return []; }
}
function savePlaylists(pl) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(pl, null, 2)); return true; }
  catch(e) { console.error('savePlaylists:', e); return false; }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── SoundCloud client_id (auto-extracted from their website) ─────────────────
let scClientId        = null;
let scClientIdFetched = 0;

async function getSCClientId() {
  if (scClientId && (Date.now() - scClientIdFetched) < 12 * 60 * 60 * 1000) return scClientId;

  console.log('🔑 Fetching SoundCloud client_id...');
  const homeRes = await fetch('https://soundcloud.com', { headers: { 'User-Agent': SC_UA } });
  const html = await homeRes.text();

  const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map(m => m[1]).slice(-5);

  for (const url of scriptUrls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': SC_UA } });
      const txt = await r.text();
      const m = txt.match(/client_id:"([a-zA-Z0-9]{32})"/);
      if (m) {
        scClientId = m[1];
        scClientIdFetched = Date.now();
        console.log(`✅ SoundCloud client_id: ${scClientId.slice(0,8)}...`);
        return scClientId;
      }
    } catch(_) {}
  }
  throw new Error('Could not obtain SoundCloud client_id');
}

// ─── SoundCloud Search ────────────────────────────────────────────────────────
async function scSearch(query, limit = 25) {
  const cid = await getSCClientId();
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}&offset=0&linked_partitioning=1`;
  const res = await fetch(url, { headers: { 'User-Agent': SC_UA } });
  if (!res.ok) throw new Error(`SC search HTTP ${res.status}`);
  const data = await res.json();
  return (data.collection || []).filter(t => t.streamable && t.title);
}

// ─── SoundCloud Stream URL ────────────────────────────────────────────────────
async function scResolveStreamUrl(trackId, forceFresh = false) {
  const cached = streamCache.get(trackId);
  if (!forceFresh && cached && cached.expiresAt > Date.now()) return cached.url;

  const cid = await getSCClientId();

  // Get track object (has media.transcodings)
  const trackRes = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${cid}`, {
    headers: { 'User-Agent': SC_UA }
  });
  if (!trackRes.ok) throw new Error(`SC track HTTP ${trackRes.status}`);
  const track = await trackRes.json();

  const transcodings = track.media?.transcodings || [];

  // Prefer progressive MP3 → best for iOS native <audio>
  const mp3prog = transcodings.find(t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg'));
  const anyProg = transcodings.find(t => t.format?.protocol === 'progressive');
  const hls     = transcodings.find(t => t.format?.protocol === 'hls');
  const chosen  = mp3prog || anyProg || hls;
  if (!chosen) throw new Error('No streamable transcoding found');

  // Resolve CDN URL
  const streamRes = await fetch(`${chosen.url}?client_id=${cid}`, { headers: { 'User-Agent': SC_UA } });
  if (!streamRes.ok) throw new Error(`SC stream resolve HTTP ${streamRes.status}`);
  const { url: cdnUrl } = await streamRes.json();
  if (!cdnUrl) throw new Error('No CDN URL returned');

  // SoundCloud CDN URLs are valid ~1 hour; cache 55 min
  streamCache.set(trackId, { url: cdnUrl, expiresAt: Date.now() + 55 * 60 * 1000 });
  console.log(`[${trackId}] ✅ SoundCloud stream (${chosen.format?.protocol})`);
  return cdnUrl;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════════════════════════════════════════

// Search
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ tracks: [] });

  const cached = searchCache.get(query.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) return res.json({ tracks: cached.results });

  try {
    const scTracks = await scSearch(query);
    const tracks = scTracks.map(t => ({
      id:                String(t.id),
      title:             t.title,
      artist:            t.user?.username || 'Unknown',
      thumbnail:         (t.artwork_url || t.user?.avatar_url || '').replace('-large', '-t500x500') || '/icons/icon-512.png',
      duration:          Math.round((t.duration || 0) / 1000),
      durationFormatted: formatDuration(Math.round((t.duration || 0) / 1000)),
    }));

    searchCache.set(query.toLowerCase(), { results: tracks, expiresAt: Date.now() + 15 * 60 * 1000 });
    return res.json({ tracks });
  } catch(err) {
    console.error('Search error:', err.message);
    // If client_id expired, reset and let client retry
    if (err.message.includes('401') || err.message.includes('client_id')) {
      scClientId = null;
    }
    return res.status(500).json({ error: 'Error searching tracks', tracks: [] });
  }
});

// Stream — resolves SoundCloud CDN URL and redirects (or proxies for cache if needed)
app.get('/api/stream/:id', async (req, res) => {
  const trackId = req.params.id;
  if (!trackId || !/^\d+$/.test(trackId)) return res.status(400).send('Invalid track ID');

  try {
    const cdnUrl = await scResolveStreamUrl(trackId);

    // If client specifically requests proxy streaming / download
    if (req.query.proxy === '1') {
      const audioRes = await fetch(cdnUrl, {
        headers: { 'User-Agent': SC_UA }
      });
      if (!audioRes.ok) return res.status(audioRes.status).send('Upstream error');
      res.setHeader('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
      const cl = audioRes.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (audioRes.body) {
        Readable.fromWeb(audioRes.body).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.redirect(302, cdnUrl);
  } catch(err) {
    console.error(`Stream error [${trackId}]:`, err.message);
    if (err.message.includes('401') || err.message.includes('client_id')) scClientId = null;
    if (!res.headersSent) res.status(500).send('Stream unavailable');
  }
});

// Playlist CRUD ─────────────────────────────────────────────────────────────────
app.get('/api/playlists', (req, res) => res.json(getPlaylists()));

app.post('/api/playlists', (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const playlists = getPlaylists();
  const pl = { id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: name.trim(), description: (description || '').trim(), isSystem: false, cover: '', createdAt: Date.now(), tracks: [] };
  playlists.push(pl);
  savePlaylists(playlists);
  res.status(201).json(pl);
});

app.delete('/api/playlists/:id', (req, res) => {
  const playlists = getPlaylists();
  const target = playlists.find(p => p.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.isSystem) return res.status(400).json({ error: 'Cannot delete system playlist' });
  savePlaylists(playlists.filter(p => p.id !== req.params.id));
  res.json({ success: true });
});

app.post('/api/playlists/:id/tracks', (req, res) => {
  const track = req.body;
  if (!track?.id) return res.status(400).json({ error: 'Invalid track' });
  const playlists = getPlaylists();
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  if (!pl.tracks.some(t => t.id === track.id)) {
    pl.tracks.push({ id: track.id, title: track.title, artist: track.artist, thumbnail: track.thumbnail, duration: track.duration, durationFormatted: track.durationFormatted, addedAt: Date.now() });
    if (!pl.cover && track.thumbnail) pl.cover = track.thumbnail;
    savePlaylists(playlists);
  }
  res.json(pl);
});

app.delete('/api/playlists/:id/tracks/:trackId', (req, res) => {
  const playlists = getPlaylists();
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  pl.tracks = pl.tracks.filter(t => t.id !== req.params.trackId);
  savePlaylists(playlists);
  res.json(pl);
});

// SPA fallback
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start
app.listen(PORT, '0.0.0.0', () => {
  const localIp = (() => {
    for (const ifaces of Object.values(os.networkInterfaces()))
      for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) return i.address;
    return 'localhost';
  })();
  console.log('\n' + '='.repeat(50));
  console.log('🎵 MusicPlay — SoundCloud Audio Engine 🎵');
  console.log('='.repeat(50));
  console.log(`💻 Local:   http://localhost:${PORT}`);
  console.log(`📱 iPhone:  http://${localIp}:${PORT}`);
  try { qrcode.generate(`http://${localIp}:${PORT}`, { small: true }); } catch(_) {}
  console.log('='.repeat(50) + '\n');
  // Pre-fetch client_id at startup
  getSCClientId().catch(e => console.warn('SC client_id pre-fetch failed:', e.message));
});
