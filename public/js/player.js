/**
 * MusicPlay Player - Native Audio with Offline Cache Support
 * Uses HTML5 <audio> with IndexedDB offline caching and /api/stream/:id.
 * Supports iOS Safari background playback via MediaSession API.
 * Automatically saves songs to cache and recovers seamlessly if WiFi/data drops.
 */

class SpotifyPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', 'true');
    this.audio.setAttribute('webkit-playsinline', 'true');

    this.currentTrack = null;
    this.queue = [];
    this.queueIndex = -1;
    this.isPlaying = false;
    this.isLoading = false;
    this.isShuffle = false;
    this.repeatMode = 'off'; // 'off' | 'all' | 'one'
    this.listeners = new Map();
    this.currentBlobUrl = null;
    this.isCurrentLocallyCached = false;

    this._setupAudioEvents();
    this._setupMediaSession();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  emit(event, data) {
    (this.listeners.get(event) || []).forEach(cb => {
      try { cb(data); } catch(e) {}
    });
  }

  _setupAudioEvents() {
    const a = this.audio;

    a.addEventListener('play', () => {
      this.isPlaying = true;
      this._updateState('playing');
      this.emit('play');
    });

    a.addEventListener('pause', () => {
      this.isPlaying = false;
      this._updateState('paused');
      this.emit('pause');
    });

    a.addEventListener('waiting', () => {
      this.isLoading = true;
      this.emit('loading', true);
    });

    a.addEventListener('canplay', () => {
      this.isLoading = false;
      this.emit('loading', false);
    });

    a.addEventListener('playing', () => {
      this.isLoading = false;
      this.isPlaying = true;
      this._updateState('playing');
      this.emit('loading', false);
      this.emit('play');
    });

    a.addEventListener('timeupdate', () => {
      const currentTime = a.currentTime || 0;
      const duration = a.duration || (this.currentTrack ? this.currentTrack.duration : 0) || 0;
      const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
      this.emit('timeupdate', { currentTime, duration, progress });
      this._updatePosition();
    });

    a.addEventListener('ended', () => {
      this.emit('ended');
      if (this.repeatMode === 'one') {
        a.currentTime = 0;
        a.play().catch(console.warn);
      } else {
        this.next();
      }
    });

    // Offline resilience: if audio stream errors out (e.g. WiFi dropped mid-song),
    // attempt to seamlessly switch to the locally cached Blob!
    a.addEventListener('error', async (e) => {
      console.warn('Audio stream error encountered:', a.error);

      if (this.currentTrack && window.audioCache) {
        try {
          const cached = await window.audioCache.getTrack(this.currentTrack.id);
          if (cached && cached.blob && !this.isCurrentLocallyCached) {
            const resumePos = a.currentTime || 0;
            console.log('[Player] Conexión perdida, recuperando reproducción desde caché local en ' + resumePos + 's');
            
            if (this.currentBlobUrl) {
              URL.revokeObjectURL(this.currentBlobUrl);
            }
            this.currentBlobUrl = URL.createObjectURL(cached.blob);
            this.isCurrentLocallyCached = true;
            a.src = this.currentBlobUrl;
            a.currentTime = resumePos;
            
            a.play().then(() => {
              this.isPlaying = true;
              this.isLoading = false;
              this.emit('loading', false);
              this.emit('cachedstatus', { trackId: this.currentTrack.id, isCached: true, offlineFallback: true });
            }).catch(console.error);
            return;
          }
        } catch (err) {
          console.error('Error recovering from cache:', err);
        }
      }

      this.isLoading = false;
      this.isPlaying = false;
      this.emit('loading', false);
      this.emit('error', 'Error al reproducir. Revisa tu conexión.');
    });
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if (d.seekTime != null) this.seek(d.seekTime);
      });
      navigator.mediaSession.setActionHandler('seekbackward', (d) => {
        this.seek((this.audio.currentTime || 0) - (d.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (d) => {
        this.seek((this.audio.currentTime || 0) + (d.seekOffset || 10));
      });
    } catch(e) {
      console.warn('MediaSession handler warning:', e);
    }
  }

  _updateMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    const thumb = track.thumbnail || '/icons/icon-512.png';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || 'Música',
      album: 'MusicPlay',
      artwork: [
        { src: thumb, sizes: '192x192', type: 'image/jpeg' },
        { src: thumb, sizes: '512x512', type: 'image/jpeg' },
      ]
    });
  }

  _updateState(state) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  _updatePosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      const dur = this.audio.duration;
      if (dur && !isNaN(dur) && !isNaN(this.audio.currentTime)) {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: this.audio.playbackRate || 1,
          position: Math.min(dur, Math.max(0, this.audio.currentTime))
        });
      }
    } catch(e) {}
  }

  async loadAndPlay(track, queue = [], index = 0) {
    if (!track || !track.id) return;

    // Auto-migrate legacy non-numeric IDs (e.g. YouTube IDs saved in playlists/favorites)
    if (!/^\d+$/.test(String(track.id)) && track.title) {
      try {
        const query = track.title + ' ' + (track.artist || '');
        const sRes = await fetch('/api/search?q=' + encodeURIComponent(query));
        const sData = await sRes.json();
        if (sData.tracks && sData.tracks.length > 0) {
          console.log('[Player] Migrando pista legacy a SoundCloud ID:', sData.tracks[0].id);
          track.id = sData.tracks[0].id;
        }
      } catch (e) {
        console.warn('Could not migrate legacy track ID:', e);
      }
    }

    this.currentTrack = track;
    this.queue = queue.length ? [...queue] : [track];
    this.queueIndex = queue.length ? index : 0;

    this.isLoading = true;
    this.isPlaying = true;
    this.emit('loading', true);
    this.emit('trackchange', this.currentTrack);
    this._updateMetadata(track);

    // Clean up previous blob URL
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch(_) {}
      this.currentBlobUrl = null;
    }
    this.isCurrentLocallyCached = false;

    // Check if song is already cached in IndexedDB
    let cached = null;
    if (window.audioCache) {
      try {
        cached = await window.audioCache.getTrack(track.id);
      } catch (e) {
        console.warn('Error checking cache:', e);
      }
    }

    if (cached && cached.blob) {
      // PLAY FROM LOCAL CACHE (100% OFFLINE / ZERO NETWORK USAGE)
      this.isCurrentLocallyCached = true;
      this.currentBlobUrl = URL.createObjectURL(cached.blob);
      this.audio.src = this.currentBlobUrl;
      this.emit('cachedstatus', { trackId: track.id, isCached: true });
    } else {
      // PLAY STREAM FROM SERVER
      this.audio.src = '/api/stream/' + track.id + '?t=' + Date.now();
      this.emit('cachedstatus', { trackId: track.id, isCached: false });

      // Automatically cache in background so it keeps playing if megas/wifi run out!
      if (window.audioCache && navigator.onLine !== false) {
        window.audioCache.cacheTrack(track).then((ok) => {
          if (ok && this.currentTrack && this.currentTrack.id === track.id) {
            this.emit('cachedstatus', { trackId: track.id, isCached: true });
            // Pre-cache next song in queue for seamless offline progression
            this.preCacheNextTrack();
          }
        }).catch(() => {});
      }
    }

    this.audio.load();

    const p = this.audio.play();
    if (p) {
      p.catch(err => {
        if (err.name === 'AbortError') return;
        console.warn('Play error:', err);
        this.isPlaying = false;
        this.isLoading = false;
        this.emit('loading', false);
        this.emit('pause');
      });
    }
  }

  // Pre-cache the next track in the queue in background
  preCacheNextTrack() {
    if (!window.audioCache || navigator.onLine === false || !this.queue.length) return;
    const nextIdx = this.queueIndex + 1;
    if (nextIdx < this.queue.length) {
      const nextTrack = this.queue[nextIdx];
      if (nextTrack && nextTrack.id) {
        window.audioCache.isCached(nextTrack.id).then(cached => {
          if (!cached) {
            window.audioCache.cacheTrack(nextTrack).catch(() => {});
          }
        });
      }
    }
  }

  play() {
    if (!this.audio.src && this.currentTrack) {
      this.loadAndPlay(this.currentTrack, this.queue, this.queueIndex);
      return;
    }
    this.isPlaying = true;
    this.emit('play');
    const p = this.audio.play();
    if (p) {
      p.catch(err => {
        if (err.name !== 'AbortError') {
          console.warn(err);
          this.isPlaying = false;
          this.emit('pause');
        }
      });
    }
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    this.isLoading = false;
    this.emit('loading', false);
    this.emit('pause');
  }

  togglePlay() {
    if (!this.audio.paused) this.pause();
    else this.play();
  }

  seek(seconds) {
    if (this.audio.duration && !isNaN(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
      this._updatePosition();
    }
  }

  seekByPercentage(pct) {
    const dur = this.audio.duration || (this.currentTrack ? this.currentTrack.duration : 0);
    if (dur > 0) this.seek((pct / 100) * dur);
  }

  next() {
    if (!this.queue.length) return;
    let idx;
    if (this.isShuffle) {
      idx = Math.floor(Math.random() * this.queue.length);
    } else {
      idx = this.queueIndex + 1;
      if (idx >= this.queue.length) {
        if (this.repeatMode === 'all') idx = 0;
        else { this.pause(); return; }
      }
    }
    this.queueIndex = idx;
    this.loadAndPlay(this.queue[idx], this.queue, idx);
  }

  previous() {
    if ((this.audio.currentTime || 0) > 3) {
      this.seek(0);
      return;
    }
    if (!this.queue.length) return;
    let idx = this.queueIndex - 1;
    if (idx < 0) idx = this.queue.length - 1;
    this.queueIndex = idx;
    this.loadAndPlay(this.queue[idx], this.queue, idx);
  }

  toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    this.emit('shufflechange', this.isShuffle);
    return this.isShuffle;
  }

  toggleRepeat() {
    const modes = ['off', 'all', 'one'];
    this.repeatMode = modes[(modes.indexOf(this.repeatMode) + 1) % modes.length];
    this.emit('repeatchange', this.repeatMode);
    return this.repeatMode;
  }
}

window.spotifyPlayer = new SpotifyPlayer();
