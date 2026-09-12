/**
 * Spotify Web Player Engine
 * Optimized for iOS Safari background playback & MediaSession API
 */
class SpotifyPlayer {
  constructor() {
    this.ytPlayer = null;
    this.isYtReady = false;
    this.pendingVideoId = null;

    this.currentTrack = null;
    this.queue = [];
    this.queueIndex = -1;
    this.isPlaying = false;
    this.isLoading = false;
    this.isShuffle = false;
    this.repeatMode = 'off'; // 'off' | 'all' | 'one'

    this.listeners = new Map();
    this.progressInterval = null;

    this.initYouTubeAPI();
    this.setupMediaSession();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error(`Error in listener for ${event}:`, e);
        }
      });
    }
  }

  initYouTubeAPI() {
    const setup = () => {
      if (typeof YT !== 'undefined' && YT.Player) {
        this.createYouTubePlayer();
      } else {
        window.onYouTubeIframeAPIReady = () => {
          this.createYouTubePlayer();
        };
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setup();
    } else {
      window.addEventListener('DOMContentLoaded', setup);
    }
  }

  createYouTubePlayer() {
    try {
      this.ytPlayer = new YT.Player('yt-iframe-placeholder', {
        height: '1',
        width: '1',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: () => {
            this.isYtReady = true;
            if (this.pendingVideoId) {
              const vid = this.pendingVideoId;
              this.pendingVideoId = null;
              this.ytPlayer.loadVideoById(vid);
            }
          },
          onStateChange: (event) => {
            this.handlePlayerStateChange(event.data);
          },
          onError: (event) => {
            console.error('YouTube Player Error code:', event.data);
            this.isLoading = false;
            this.isPlaying = false;
            this.emit('loading', false);
            this.emit('error', 'Canción no disponible, pasando a la siguiente...');
            setTimeout(() => this.next(), 1000);
          }
        }
      });
    } catch (e) {
      console.error('Failed to create YouTube player instance:', e);
    }
  }

  handlePlayerStateChange(state) {
    // YT.PlayerState: UNSTARTED (-1), ENDED (0), PLAYING (1), PAUSED (2), BUFFERING (3), CUED (5)
    if (state === 1) { // PLAYING
      this.isPlaying = true;
      this.isLoading = false;
      this.emit('loading', false);
      this.emit('play');
      this.updateMediaSessionState();
      this.startProgressTracking();
    } else if (state === 2) { // PAUSED
      this.isPlaying = false;
      this.isLoading = false;
      this.emit('loading', false);
      this.emit('pause');
      this.updateMediaSessionState();
      this.stopProgressTracking();
    } else if (state === 3) { // BUFFERING
      this.isLoading = true;
      this.emit('loading', true);
    } else if (state === 0) { // ENDED
      this.stopProgressTracking();
      this.emit('ended');
      if (this.repeatMode === 'one') {
        this.seek(0);
        this.play();
      } else {
        this.next();
      }
    }
  }

  startProgressTracking() {
    this.stopProgressTracking();
    this.progressInterval = setInterval(() => {
      if (!this.ytPlayer || typeof this.ytPlayer.getCurrentTime !== 'function') return;

      const currentTime = this.ytPlayer.getCurrentTime() || 0;
      const duration = this.ytPlayer.getDuration() || (this.currentTrack ? this.currentTrack.duration : 0);
      const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

      this.emit('timeupdate', {
        currentTime,
        duration,
        progress: Math.min(100, Math.max(0, progress))
      });

      this.updateMediaSessionPosition(currentTime, duration);
    }, 500);
  }

  stopProgressTracking() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && details.seekTime !== null) {
          this.seek(details.seekTime);
        }
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        this.seek(this.audio.currentTime - (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        this.seek(this.audio.currentTime + (details.seekOffset || 10));
      });
    } catch (e) {
      console.warn('MediaSession handler warning:', e);
    }
  }

  updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;

    const thumb = track.thumbnail || '/icons/icon-512.png';

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || 'YouTube Music',
      album: 'Spotify Web',
      artwork: [
        { src: thumb, sizes: '192x192', type: 'image/jpeg' },
        { src: thumb, sizes: '512x512', type: 'image/jpeg' }
      ]
    });
  }

  updateMediaSessionState() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
  }

  updateMediaSessionPosition(currentTime, duration) {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    try {
      if (duration && !isNaN(duration) && !isNaN(currentTime)) {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: 1,
          position: Math.min(duration, Math.max(0, currentTime))
        });
      }
    } catch (e) {
      // Ignored for rapid updates
    }
  }

  loadAndPlay(track, queue = [], index = 0) {
    if (!track || !track.id) return;

    this.currentTrack = track;
    if (queue.length) {
      this.queue = [...queue];
      this.queueIndex = index;
    } else {
      this.queue = [track];
      this.queueIndex = 0;
    }

    this.isLoading = true;
    this.isPlaying = true;
    this.emit('loading', true);
    this.emit('trackchange', this.currentTrack);
    this.updateMediaSessionMetadata(track);

    if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function') {
      try {
        this.ytPlayer.loadVideoById({
          videoId: track.id,
          suggestedQuality: 'small'
        });
      } catch (e) {
        console.warn('Error loading video by ID:', e);
        this.pendingVideoId = track.id;
      }
    } else {
      this.pendingVideoId = track.id;
    }
  }

  play() {
    if (this.ytPlayer && typeof this.ytPlayer.playVideo === 'function') {
      try {
        this.ytPlayer.playVideo();
      } catch (e) {
        console.warn('Play video error:', e);
      }
    } else if (this.currentTrack) {
      this.loadAndPlay(this.currentTrack, this.queue, this.queueIndex);
    }
  }

  pause() {
    if (this.ytPlayer && typeof this.ytPlayer.pauseVideo === 'function') {
      try {
        this.ytPlayer.pauseVideo();
      } catch (e) {
        console.warn('Pause video error:', e);
      }
    }
    this.isPlaying = false;
    this.isLoading = false;
    this.emit('loading', false);
    this.emit('pause');
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(seconds) {
    if (this.ytPlayer && typeof this.ytPlayer.seekTo === 'function') {
      try {
        this.ytPlayer.seekTo(seconds, true);
      } catch (e) {}
    }
  }

  seekByPercentage(percentage) {
    if (this.ytPlayer && typeof this.ytPlayer.getDuration === 'function') {
      try {
        const dur = this.ytPlayer.getDuration();
        if (dur > 0) {
          const target = (percentage / 100) * dur;
          this.seek(target);
        }
      } catch (e) {}
    }
  }

  next() {
    if (!this.queue.length) return;

    let nextIndex;
    if (this.isShuffle) {
      nextIndex = Math.floor(Math.random() * this.queue.length);
    } else {
      nextIndex = this.queueIndex + 1;
      if (nextIndex >= this.queue.length) {
        if (this.repeatMode === 'all') {
          nextIndex = 0;
        } else {
          this.pause();
          return;
        }
      }
    }

    this.queueIndex = nextIndex;
    this.loadAndPlay(this.queue[nextIndex], this.queue, nextIndex);
  }

  previous() {
    const cur = (this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') ? this.ytPlayer.getCurrentTime() : 0;
    if (cur > 3) {
      this.seek(0);
      return;
    }

    if (!this.queue.length) return;

    let prevIndex = this.queueIndex - 1;
    if (prevIndex < 0) {
      prevIndex = this.queue.length - 1;
    }

    this.queueIndex = prevIndex;
    this.loadAndPlay(this.queue[prevIndex], this.queue, prevIndex);
  }

  toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    this.emit('shufflechange', this.isShuffle);
    return this.isShuffle;
  }

  toggleRepeat() {
    const modes = ['off', 'all', 'one'];
    const currentIdx = modes.indexOf(this.repeatMode);
    this.repeatMode = modes[(currentIdx + 1) % modes.length];
    this.emit('repeatchange', this.repeatMode);
    return this.repeatMode;
  }
}

// Global instance
window.spotifyPlayer = new SpotifyPlayer();
