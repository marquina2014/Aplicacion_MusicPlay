/**
 * MusicPlay Player - Native Audio
 * Uses HTML5 <audio> with /api/stream/:id (proxied via server).
 * Supports iOS background playback via MediaSession API.
 * Native <audio> is the ONLY reliable way to get background audio on iOS Safari.
 */
class SpotifyPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', 'true');
    this.audio.setAttribute('webkit-playsinline', 'true');

    this.currentTrack = null;
    this.queue        = [];
    this.queueIndex   = -1;
    this.isPlaying    = false;
    this.isLoading    = false;
    this.isShuffle    = false;
    this.repeatMode   = 'off'; // 'off' | 'all' | 'one'
    this.listeners    = new Map();

    this._setupAudioEvents();
    this._setupMediaSession();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }
  emit(event, data) {
    (this.listeners.get(event) || []).forEach(cb => { try { cb(data); } catch(e) {} });
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

    a.addEventListener('waiting',  () => { this.isLoading = true;  this.emit('loading', true);  });
    a.addEventListener('canplay',  () => { this.isLoading = false; this.emit('loading', false); });

    a.addEventListener('playing', () => {
      this.isLoading = false;
      this.isPlaying = true;
      this._updateState('playing');
      this.emit('loading', false);
      this.emit('play');
    });

    a.addEventListener('timeupdate', () => {
      const currentTime = a.currentTime || 0;
      const duration    = a.duration || (this.currentTrack ? this.currentTrack.duration : 0) || 0;
      const progress    = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
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

    a.addEventListener('error', (e) => {
      console.error('Audio error:', e, a.error);
      this.isLoading = false;
      this.isPlaying = false;
      this.emit('loading', false);
      this.emit('error', 'Error al reproducir. Intenta con otra cancion.');
    });
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play',          () => this.play());
      navigator.mediaSession.setActionHandler('pause',         () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack',     () => this.next());
      navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
      navigator.mediaSession.setActionHandler('seekbackward', (d) => this.seek((this.audio.currentTime || 0) - (d.seekOffset || 10)));
      navigator.mediaSession.setActionHandler('seekforward',  (d) => this.seek((this.audio.currentTime || 0) + (d.seekOffset || 10)));
    } catch(e) { console.warn('MediaSession:', e); }
  }

  _updateMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    const thumb = track.thumbnail || '/icons/icon-512.png';
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   track.title,
      artist:  track.artist || 'YouTube Music',
      album:   'MusicPlay',
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
          duration:     dur,
          playbackRate: this.audio.playbackRate || 1,
          position:     Math.min(dur, Math.max(0, this.audio.currentTime))
        });
      }
    } catch(e) {}
  }

  loadAndPlay(track, queue = [], index = 0) {
    if (!track || !track.id) return;

    this.currentTrack = track;
    this.queue        = queue.length ? [...queue] : [track];
    this.queueIndex   = queue.length ? index : 0;

    this.isLoading = true;
    this.isPlaying = true;
    this.emit('loading', true);
    this.emit('trackchange', this.currentTrack);
    this._updateMetadata(track);

    // Cache-bust so Render doesnt serve a stale error response
    this.audio.src = `/api/stream/${track.id}?t=${Date.now()}`;
    this.audio.load();

    const p = this.audio.play();
    if (p) p.catch(err => {
      if (err.name === 'AbortError') return;
      console.warn('Play error:', err);
      this.isPlaying = false;
      this.isLoading = false;
      this.emit('loading', false);
      this.emit('pause');
    });
  }

  play() {
    if (!this.audio.src && this.currentTrack) {
      this.loadAndPlay(this.currentTrack, this.queue, this.queueIndex);
      return;
    }
    this.isPlaying = true;
    this.emit('play');
    const p = this.audio.play();
    if (p) p.catch(err => { if (err.name !== 'AbortError') { console.warn(err); this.isPlaying = false; this.emit('pause'); } });
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    this.isLoading = false;
    this.emit('loading', false);
    this.emit('pause');
  }

  togglePlay() { if (!this.audio.paused) this.pause(); else this.play(); }

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
    if ((this.audio.currentTime || 0) > 3) { this.seek(0); return; }
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
