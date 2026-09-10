/**
 * Spotify Web Player Engine
 * Optimized for iOS Safari background playback & MediaSession API
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
    this.setupAudioEvents();
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

  setupAudioEvents() {
    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this.updateMediaSessionState();
      this.emit('play');
    });

    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      this.updateMediaSessionState();
      this.emit('pause');
    });

    this.audio.addEventListener('waiting', () => {
      this.isLoading = true;
      this.emit('loading', true);
    });

    this.audio.addEventListener('playing', () => {
      this.isLoading = false;
      this.isPlaying = true;
      this.emit('loading', false);
      this.emit('play');
    });

    this.audio.addEventListener('timeupdate', () => {
      this.emit('timeupdate', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
        progress: (this.audio.currentTime / (this.audio.duration || 1)) * 100
      });
      this.updateMediaSessionPosition();
    });

    this.audio.addEventListener('ended', () => {
      this.emit('ended');
      if (this.repeatMode === 'one') {
        this.audio.currentTime = 0;
        this.audio.play().catch(console.warn);
      } else {
        this.next();
      }
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', e, this.audio.error);
      this.isLoading = false;
      this.isPlaying = false;
      this.emit('loading', false);
      this.emit('error', 'Error al reproducir el audio');
    });
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
    navigator.mediaSession.playbackState = (!this.audio.paused && this.isPlaying) ? 'playing' : 'paused';
  }

  updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    try {
      if (this.audio.duration && !isNaN(this.audio.duration) && !isNaN(this.audio.currentTime)) {
        navigator.mediaSession.setPositionState({
          duration: this.audio.duration,
          playbackRate: this.audio.playbackRate || 1,
          position: this.audio.currentTime
        });
      }
    } catch (e) {
      // Ignored for rapidly changing positions
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

    // Stream URL from our backend
    const streamUrl = `/api/stream/${track.id}`;
    this.audio.src = streamUrl;
    this.audio.load();

    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          this.isPlaying = true;
          this.isLoading = false;
          this.emit('loading', false);
          this.emit('play');
        })
        .catch(err => {
          // If paused by user before playback starts, ignore abort
          if (err.name === 'AbortError') {
            console.log('Play interrupted by pause');
            return;
          }
          console.warn('Playback initiation error:', err);
          this.isPlaying = false;
          this.isLoading = false;
          this.emit('loading', false);
          this.emit('pause');
        });
    }
  }

  play() {
    if (!this.audio.src && this.currentTrack) {
      this.loadAndPlay(this.currentTrack, this.queue, this.queueIndex);
      return;
    }
    this.isPlaying = true;
    this.emit('play');
    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        if (err.name === 'AbortError') return;
        console.warn('Audio play error:', err);
        this.isPlaying = false;
        this.emit('pause');
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
    if (!this.audio.paused) {
      this.pause();
    } else {
      this.play();
    }
  }

  seek(seconds) {
    if (this.audio.duration && !isNaN(this.audio.duration)) {
      const target = Math.max(0, Math.min(seconds, this.audio.duration));
      this.audio.currentTime = target;
      this.updateMediaSessionPosition();
    }
  }

  seekByPercentage(percentage) {
    if (this.audio.duration && !isNaN(this.audio.duration)) {
      const target = (percentage / 100) * this.audio.duration;
      this.seek(target);
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
          // Reached end of playlist
          this.pause();
          return;
        }
      }
    }

    this.queueIndex = nextIndex;
    this.loadAndPlay(this.queue[nextIndex], this.queue, nextIndex);
  }

  previous() {
    // If playing more than 3 seconds, restart current track
    if (this.audio.currentTime > 3) {
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
