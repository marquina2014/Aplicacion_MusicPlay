/**
 * MusicPlay Player
 * Uses YouTube IFrame API for playback.
 * iOS background audio trick: plays a near-silent looping <audio>
 * element so iOS maintains the audio session while the screen is locked,
 * allowing the YouTube IFrame audio to continue uninterrupted.
 */

// ─── Build near-silent WAV as data URI to keep iOS audio session alive ───
const SILENT_WAV_B64 = (() => {
  const sampleRate = 22050;
  const numSamples = sampleRate;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.round(50 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
})();

class SpotifyPlayer {
  constructor() {
    this.currentTrack   = null;
    this.queue          = [];
    this.queueIndex     = -1;
    this.isPlaying      = false;
    this.isLoading      = false;
    this.isShuffle      = false;
    this.repeatMode     = 'off';
    this.listeners      = new Map();
    this._progressTimer = null;
    this._ytDuration    = 0;
    this._ytCurrentTime = 0;
    this._ytReady       = false;
    this._ytPlayer      = null;
    this._pendingLoad   = null;

    // Near-silent audio keeps iOS audio session alive during screen lock
    this.keepAlive = new Audio(SILENT_WAV_B64);
    this.keepAlive.loop = true;
    this.keepAlive.volume = 0.01;
    this.keepAlive.setAttribute('playsinline', 'true');
    this.keepAlive.setAttribute('webkit-playsinline', 'true');

    this._initYouTubeIFrame();
    this.setupMediaSession();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }
  emit(event, data) {
    (this.listeners.get(event) || []).forEach(cb => { try { cb(data); } catch(e) {} });
  }

  _initYouTubeIFrame() {
    const div = document.createElement('div');
    div.id = 'yt-player-hidden';
    div.style.cssText = 'position:fixed;width:1px;height:1px;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
    document.body.appendChild(div);

    window.onYouTubeIframeAPIReady = () => {
      this._ytPlayer = new YT.Player('yt-player-hidden', {
        height: '1', width: '1',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady:       () => this._onYTReady(),
          onStateChange: (e) => this._onYTStateChange(e),
          onError:       (e) => this._onYTError(e),
        }
      });
    };

    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    } else {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  }

  _onYTReady() {
    this._ytReady = true;
    if (this._pendingLoad) {
      const p = this._pendingLoad; this._pendingLoad = null;
      this._doLoad(p.track, p.queue, p.index);
    }
  }

  _onYTStateChange(event) {
    const S = (window.YT && YT.PlayerState) || {};
    switch (event.data) {
      case S.PLAYING:
        this.isPlaying = true; this.isLoading = false;
        this._ytDuration = this._ytPlayer.getDuration() || 0;
        this.emit('loading', false); this.emit('play');
        this._startProgressTimer();
        this._updateMediaSessionState('playing');
        break;
      case S.PAUSED:
        this.isPlaying = false;
        this.emit('pause'); this._stopProgressTimer();
        this._updateMediaSessionState('paused');
        break;
      case S.BUFFERING:
        this.isLoading = true; this.emit('loading', true);
        break;
      case S.ENDED:
        this._stopProgressTimer(); this.emit('ended');
        if (this.repeatMode === 'one') { this._ytPlayer.seekTo(0); this._ytPlayer.playVideo(); }
        else this.next();
        break;
    }
  }

  _onYTError(event) {
    console.error('YouTube IFrame error:', event.data);
    this.isLoading = false; this.isPlaying = false;
    this.emit('loading', false);
    this.emit('error', 'Error al reproducir. Intenta con otra cancion.');
  }

  _startProgressTimer() {
    this._stopProgressTimer();
    this._progressTimer = setInterval(() => {
      if (!this._ytPlayer || !this.isPlaying) return;
      try {
        this._ytCurrentTime = this._ytPlayer.getCurrentTime() || 0;
        this._ytDuration    = this._ytPlayer.getDuration()    || 0;
        const progress = this._ytDuration > 0 ? Math.min(100, (this._ytCurrentTime / this._ytDuration) * 100) : 0;
        this.emit('timeupdate', { currentTime: this._ytCurrentTime, duration: this._ytDuration, progress });
        this._updateMediaSessionPosition();
      } catch(e) {}
    }, 500);
  }

  _stopProgressTimer() {
    if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
  }

  loadAndPlay(track, queue = [], index = 0) {
    if (!track || !track.id) return;
    this.currentTrack = track;
    this.queue        = queue.length ? [...queue] : [track];
    this.queueIndex   = queue.length ? index : 0;
    this.isLoading    = true;
    this.emit('loading', true);
    this.emit('trackchange', track);
    this._updateMediaSessionMetadata(track);
    if (!this._ytReady) { this._pendingLoad = { track, queue, index }; return; }
    this._doLoad(track, queue, index);
  }

  _doLoad(track) {
    this.keepAlive.play().catch(() => {});
    this._ytPlayer.loadVideoById({ videoId: track.id, startSeconds: 0 });
  }

  play() {
    if (!this._ytPlayer) return;
    this.keepAlive.play().catch(() => {});
    this._ytPlayer.playVideo();
    this.isPlaying = true; this.emit('play');
  }

  pause() {
    if (this._ytPlayer) this._ytPlayer.pauseVideo();
    this.isPlaying = false; this.isLoading = false;
    this._stopProgressTimer();
    this.emit('loading', false); this.emit('pause');
  }

  togglePlay() { if (this.isPlaying) this.pause(); else this.play(); }

  seek(seconds) {
    if (!this._ytPlayer || !this._ytDuration) return;
    this._ytPlayer.seekTo(Math.max(0, Math.min(seconds, this._ytDuration)), true);
    this._updateMediaSessionPosition();
  }

  seekByPercentage(pct) {
    const dur = this._ytDuration || (this.currentTrack ? this.currentTrack.duration : 0);
    if (dur > 0) this.seek((pct / 100) * dur);
  }

  next() {
    if (!this.queue.length) return;
    let idx;
    if (this.isShuffle) { idx = Math.floor(Math.random() * this.queue.length); }
    else {
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
    if ((this._ytCurrentTime || 0) > 3) { this.seek(0); return; }
    if (!this.queue.length) return;
    let idx = this.queueIndex - 1;
    if (idx < 0) idx = this.queue.length - 1;
    this.queueIndex = idx;
    this.loadAndPlay(this.queue[idx], this.queue, idx);
  }

  toggleShuffle() { this.isShuffle = !this.isShuffle; this.emit('shufflechange', this.isShuffle); return this.isShuffle; }

  toggleRepeat() {
    const modes = ['off', 'all', 'one'];
    this.repeatMode = modes[(modes.indexOf(this.repeatMode) + 1) % modes.length];
    this.emit('repeatchange', this.repeatMode);
    return this.repeatMode;
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play',          () => this.play());
      navigator.mediaSession.setActionHandler('pause',         () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack',     () => this.next());
      navigator.mediaSession.setActionHandler('seekto',        (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
      navigator.mediaSession.setActionHandler('seekbackward',  (d) => this.seek((this._ytCurrentTime || 0) - (d.seekOffset || 10)));
      navigator.mediaSession.setActionHandler('seekforward',   (d) => this.seek((this._ytCurrentTime || 0) + (d.seekOffset || 10)));
    } catch(e) { console.warn('MediaSession:', e); }
  }

  _updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    const thumb = track.thumbnail || '/icons/icon-512.png';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist || 'YouTube Music', album: 'MusicPlay',
      artwork: [{ src: thumb, sizes: '192x192', type: 'image/jpeg' }, { src: thumb, sizes: '512x512', type: 'image/jpeg' }]
    });
  }

  _updateMediaSessionState(state) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  _updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      if (this._ytDuration > 0) navigator.mediaSession.setPositionState({ duration: this._ytDuration, playbackRate: 1, position: Math.min(this._ytDuration, Math.max(0, this._ytCurrentTime)) });
    } catch(e) {}
  }
}

window.spotifyPlayer = new SpotifyPlayer();
