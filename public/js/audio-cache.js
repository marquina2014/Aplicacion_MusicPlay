/**
 * MusicPlay Audio Cache Manager (IndexedDB)
 * Stores audio Blobs and metadata locally for 100% offline playback.
 * Works seamlessly on iOS Safari, Android Chrome, and Desktop PWAs.
 */

class AudioCacheManager {
  constructor() {
    this.dbName = 'MusicPlay_AudioCache';
    this.dbVersion = 1;
    this.storeName = 'cached_tracks';
    this.db = null;
    this.downloading = new Set();
    this.listeners = new Map();

    this.initPromise = this._initDB();
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }

  emit(event, data) {
    (this.listeners.get(event) || []).forEach(cb => {
      try { cb(data); } catch (e) { console.error('AudioCache listener error:', e); }
    });
  }

  _initDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported on this browser');
        return resolve(null);
      }

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        resolve(null);
      };
    });
  }

  async _getDB() {
    if (this.db) return this.db;
    return await this.initPromise;
  }

  async isCached(trackId) {
    if (!trackId) return false;
    const db = await this._getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(String(trackId));
        req.onsuccess = () => resolve(!!req.result && !!req.result.blob);
        req.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async getTrack(trackId) {
    if (!trackId) return null;
    const db = await this._getDB();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(String(trackId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async saveTrack(track, blob) {
    if (!track || !track.id || !blob) return false;
    const db = await this._getDB();
    if (!db) return false;

    const record = {
      id: String(track.id),
      title: track.title || 'Canción',
      artist: track.artist || 'Artista',
      thumbnail: track.thumbnail || '',
      duration: track.duration || 0,
      durationFormatted: track.durationFormatted || track.duration_formatted || '0:00',
      blob: blob,
      size: blob.size || 0,
      mimeType: blob.type || 'audio/mpeg',
      cachedAt: Date.now()
    };

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(record);

        req.onsuccess = () => {
          this.emit('track-cached', { trackId: record.id, track: record });
          resolve(true);
        };
        req.onerror = (e) => {
          console.error('Error saving track to cache:', e);
          resolve(false);
        };
      } catch (e) {
        console.error('Transaction error saving track:', e);
        resolve(false);
      }
    });
  }

  async deleteTrack(trackId) {
    if (!trackId) return false;
    const db = await this._getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.delete(String(trackId));
        req.onsuccess = () => {
          this.emit('track-deleted', { trackId: String(trackId) });
          resolve(true);
        };
        req.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async getAllTracks() {
    const db = await this._getDB();
    if (!db) return [];

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result || []).map(r => ({
            id: r.id,
            title: r.title,
            artist: r.artist,
            thumbnail: r.thumbnail,
            duration: r.duration,
            durationFormatted: r.durationFormatted,
            size: r.size,
            cachedAt: r.cachedAt
          })).sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
          resolve(list);
        };
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  async getCacheStats() {
    const tracks = await this.getAllTracks();
    const totalBytes = tracks.reduce((sum, t) => sum + (t.size || 0), 0);
    const count = tracks.length;

    let formatted = '0 MB';
    if (totalBytes > 1024 * 1024 * 1024) {
      formatted = (totalBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    } else if (totalBytes > 1024 * 1024) {
      formatted = (totalBytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else if (totalBytes > 1024) {
      formatted = (totalBytes / 1024).toFixed(0) + ' KB';
    }

    return { count, totalBytes, formatted, tracks };
  }

  async clearAll() {
    const db = await this._getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.clear();
        req.onsuccess = () => {
          this.emit('cache-cleared');
          resolve(true);
        };
        req.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async cacheTrack(track) {
    if (!track || !track.id) return false;
    const strId = String(track.id);

    if (await this.isCached(strId)) return true;
    if (this.downloading.has(strId)) return false;

    this.downloading.add(strId);
    this.emit('download-start', { trackId: strId, track });

    try {
      let res = await fetch('/api/stream/' + strId).catch(() => null);
      if (!res || !res.ok) {
        res = await fetch('/api/stream/' + strId + '?proxy=1');
      }

      if (!res.ok) {
        throw new Error('Stream fetch failed: HTTP ' + res.status);
      }

      const blob = await res.blob();
      if (!blob || blob.size < 1000) {
        throw new Error('Downloaded audio blob is invalid');
      }

      await this.saveTrack(track, blob);
      this.downloading.delete(strId);
      this.emit('download-success', { trackId: strId, track, size: blob.size });
      return true;
    } catch (err) {
      this.downloading.delete(strId);
      console.warn('[Cache] Error caching track ' + strId + ':', err.message);
      this.emit('download-error', { trackId: strId, error: err.message });
      return false;
    }
  }

  isDownloading(trackId) {
    return this.downloading.has(String(trackId));
  }
}

window.audioCache = new AudioCacheManager();
