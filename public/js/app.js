/**
 * Spotify Web Application UI & Controller
 * Integrated with Supabase Auth & Cloud Database + Local Offline Resilience
 */

// Helper to format seconds to mm:ss
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Toast helper
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast.hideTimeout);
  toast.hideTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

class SpotifyApp {
  constructor() {
    this.player = window.spotifyPlayer;
    this.supabase = window.supabaseClient;
    this.currentUser = null;
    this.authMode = 'login'; // 'login' | 'register'

    this.playlists = [];
    this.activePlaylist = null;
    this.selectedTrackForModal = null;
    this.currentView = 'home';
    this.isDraggingScrub = false;

    this.init();
  }

  async init() {
    this.bindEvents();
    this.bindAuthEvents();
    this.setupPlayerListeners();
    this.registerServiceWorker();

    // Check existing Supabase session
    if (this.supabase) {
      try {
        const { data: { session } } = await this.supabase.auth.getSession();
        this.currentUser = session ? session.user : null;
      } catch (err) {
        console.warn('Error fetching Supabase session:', err);
      }
      this.updateUserUI();

      // Listen for login / logout changes
      this.supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('Supabase Auth Event:', event);
        this.currentUser = session ? session.user : null;
        this.updateUserUI();
        await this.loadPlaylists();
      });
    }

    await this.loadPlaylists();
    this.renderHomeQuickGrid();
    this.loadHomeRecommendations();
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  // -------------------------------------------------------------
  // USER UI & AUTH STATE
  // -------------------------------------------------------------
  updateUserUI() {
    const avatarBtnHome = document.getElementById('user-profile-btn');
    const avatarBtnLib = document.getElementById('user-profile-btn-lib');
    const avatarTextHome = document.getElementById('user-avatar-text');
    const avatarTextLib = document.getElementById('user-avatar-text-lib');
    const avatarIconHome = document.getElementById('user-avatar-icon');
    const avatarIconLib = document.getElementById('user-avatar-icon-lib');
    const dotHome = document.getElementById('user-status-dot');
    const dotLib = document.getElementById('user-status-dot-lib');

    if (this.currentUser) {
      const initial = (this.currentUser.email || 'U').charAt(0).toUpperCase();

      [avatarBtnHome, avatarBtnLib].forEach(btn => btn && btn.classList.add('logged-in'));
      [avatarTextHome, avatarTextLib].forEach(t => {
        if (t) {
          t.textContent = initial;
          t.style.display = 'inline';
        }
      });
      [avatarIconHome, avatarIconLib].forEach(i => i && (i.style.display = 'none'));
      [dotHome, dotLib].forEach(d => d && d.classList.add('active'));

      // Update Profile Modal details
      const profileEmail = document.getElementById('profile-email');
      const profileCircle = document.getElementById('profile-avatar-circle');
      const statPlaylists = document.getElementById('profile-stat-playlists');
      const statLikes = document.getElementById('profile-stat-likes');

      if (profileEmail) profileEmail.textContent = this.currentUser.email;
      if (profileCircle) profileCircle.textContent = initial;

      const fav = this.getFavoritesPlaylist();
      const customPls = this.playlists.filter(p => !p.isSystem && p.id !== 'favorites');
      if (statPlaylists) statPlaylists.textContent = customPls.length;
      if (statLikes) statLikes.textContent = (fav && fav.tracks) ? fav.tracks.length : 0;
    } else {
      [avatarBtnHome, avatarBtnLib].forEach(btn => btn && btn.classList.remove('logged-in'));
      [avatarTextHome, avatarTextLib].forEach(t => t && (t.style.display = 'none'));
      [avatarIconHome, avatarIconLib].forEach(i => i && (i.style.display = 'block'));
      [dotHome, dotLib].forEach(d => d && d.classList.remove('active'));
    }
  }

  openAuthModal(mode = 'login') {
    this.authMode = mode;
    const title = document.getElementById('auth-modal-title');
    const subtitle = document.getElementById('auth-modal-subtitle');
    const submitBtn = document.getElementById('auth-submit-btn');
    const switchBtn = document.getElementById('auth-switch-mode-btn');
    const errorBox = document.getElementById('auth-error-msg');
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');

    if (errorBox) {
      errorBox.style.display = 'none';
      errorBox.style.background = 'rgba(233, 20, 41, 0.15)';
      errorBox.style.borderColor = '#e91429';
      errorBox.style.color = '#ff7070';
      errorBox.textContent = '';
    }

    if (mode === 'login') {
      if (title) title.textContent = 'Iniciar sesión';
      if (subtitle) subtitle.textContent = 'Guarda y sincroniza tus listas en la nube';
      if (submitBtn) submitBtn.textContent = 'Iniciar sesión';
      if (switchBtn) switchBtn.textContent = '¿No tienes cuenta? Regístrate aquí';
      if (tabLogin) tabLogin.classList.add('active');
      if (tabRegister) tabRegister.classList.remove('active');
    } else {
      if (title) title.textContent = 'Crear cuenta gratis';
      if (subtitle) subtitle.textContent = 'Disfruta de tu música y listas en cualquier dispositivo';
      if (submitBtn) submitBtn.textContent = 'Registrarse';
      if (switchBtn) switchBtn.textContent = '¿Ya tienes cuenta? Inicia sesión aquí';
      if (tabLogin) tabLogin.classList.remove('active');
      if (tabRegister) tabRegister.classList.add('active');
    }

    this.openModal('auth-modal');
    setTimeout(() => {
      document.getElementById('auth-email')?.focus();
    }, 120);
  }

  bindAuthEvents() {
    const handleAvatarClick = () => {
      if (this.currentUser) {
        // Refresh counts dynamically before opening modal
        const profileEmail = document.getElementById('profile-email');
        const profileCircle = document.getElementById('profile-avatar-circle');
        const statPlaylists = document.getElementById('profile-stat-playlists');
        const statLikes = document.getElementById('profile-stat-likes');
        const initial = (this.currentUser.email || 'U').charAt(0).toUpperCase();

        if (profileEmail) profileEmail.textContent = this.currentUser.email;
        if (profileCircle) profileCircle.textContent = initial;

        const fav = this.getFavoritesPlaylist();
        const customPls = this.playlists.filter(p => !p.isSystem && p.id !== 'favorites');
        if (statPlaylists) statPlaylists.textContent = customPls.length;
        if (statLikes) statLikes.textContent = (fav && fav.tracks) ? fav.tracks.length : 0;

        this.openModal('profile-modal');
      } else {
        this.openAuthModal('login');
      }
    };

    const avatarBtnHome = document.getElementById('user-profile-btn');
    if (avatarBtnHome) avatarBtnHome.addEventListener('click', handleAvatarClick);

    const avatarBtnLib = document.getElementById('user-profile-btn-lib');
    if (avatarBtnLib) avatarBtnLib.addEventListener('click', handleAvatarClick);

    document.getElementById('close-auth-modal')?.addEventListener('click', () => {
      this.closeModal('auth-modal');
    });
    document.getElementById('close-profile-modal')?.addEventListener('click', () => {
      this.closeModal('profile-modal');
    });

    // Switch tabs
    document.getElementById('tab-login')?.addEventListener('click', () => this.openAuthModal('login'));
    document.getElementById('tab-register')?.addEventListener('click', () => this.openAuthModal('register'));

    document.getElementById('auth-switch-mode-btn')?.addEventListener('click', () => {
      this.openAuthModal(this.authMode === 'login' ? 'register' : 'login');
    });

    // Show/Hide password toggle
    const togglePwdBtn = document.getElementById('toggle-pwd-btn');
    const pwdInput = document.getElementById('auth-password');
    if (togglePwdBtn && pwdInput) {
      togglePwdBtn.addEventListener('click', () => {
        const isPassword = pwdInput.type === 'password';
        pwdInput.type = isPassword ? 'text' : 'password';
        togglePwdBtn.innerHTML = isPassword ? `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
          </svg>
        ` : `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
          </svg>
        `;
      });
    }

    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleAuthSubmit();
      });
    }

    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      await this.handleLogout();
    });
  }

  async handleAuthSubmit() {
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const submitBtn = document.getElementById('auth-submit-btn');
    const errorBox = document.getElementById('auth-error-msg');

    const email = (emailInput.value || '').trim();
    const password = (passwordInput.value || '').trim();

    if (!email || !password) {
      errorBox.style.background = 'rgba(233, 20, 41, 0.15)';
      errorBox.style.borderColor = '#e91429';
      errorBox.style.color = '#ff7070';
      errorBox.textContent = 'Por favor completa todos los campos.';
      errorBox.style.display = 'block';
      return;
    }

    if (password.length < 6) {
      errorBox.style.background = 'rgba(233, 20, 41, 0.15)';
      errorBox.style.borderColor = '#e91429';
      errorBox.style.color = '#ff7070';
      errorBox.textContent = 'La contraseña debe tener al menos 6 caracteres.';
      errorBox.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = this.authMode === 'login' ? 'Iniciando sesión...' : 'Creando cuenta...';
    errorBox.style.display = 'none';

    try {
      if (!this.supabase) {
        throw new Error('Supabase no está configurado correctamente');
      }

      if (this.authMode === 'login') {
        const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;

        this.currentUser = data.user;
        showToast(`¡Bienvenido, ${email}!`);
        this.closeModal('auth-modal');
      } else {
        const { data, error } = await this.supabase.auth.signUp({ email, password });
        if (error) throw error;

        // Check if user already exists when confirmation is enabled
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('User already registered');
        }

        if (data.session) {
          this.currentUser = data.user;
          showToast(`¡Bienvenido! Cuenta creada con éxito`);
          this.closeModal('auth-modal');
        } else {
          // Supabase project requires email confirmation
          showToast(`¡Cuenta registrada con éxito!`);
          this.openAuthModal('login');
          if (errorBox) {
            errorBox.style.display = 'block';
            errorBox.style.background = 'rgba(29, 185, 84, 0.15)';
            errorBox.style.borderColor = 'var(--primary)';
            errorBox.style.color = 'var(--primary-bright)';
            errorBox.textContent = '¡Cuenta registrada! Si tu proyecto tiene confirmación activa, revisa tu correo antes de iniciar sesión.';
          }
          return;
        }
      }

      emailInput.value = '';
      passwordInput.value = '';
      this.updateUserUI();
      await this.loadPlaylists();
    } catch (err) {
      console.error('Auth error:', err);
      let msg = err.message || 'Ocurrió un error con la autenticación';
      if (msg.includes('Invalid login credentials')) {
        msg = 'Correo o contraseña incorrectos.';
      } else if (msg.includes('User already registered') || msg.includes('already exists')) {
        msg = 'Este correo ya está registrado. Inicia sesión.';
      } else if (msg.includes('Password should be at least 6 characters') || msg.includes('weak password')) {
        msg = 'La contraseña debe tener al menos 6 caracteres.';
      } else if (msg.includes('Email not confirmed')) {
        msg = 'Por favor confirma tu correo electrónico antes de iniciar sesión.';
      } else if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) {
        msg = 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
      } else if (msg.includes('valid email') || msg.includes('Unable to validate email address')) {
        msg = 'Por favor introduce un correo electrónico válido.';
      }
      errorBox.style.background = 'rgba(233, 20, 41, 0.15)';
      errorBox.style.borderColor = '#e91429';
      errorBox.style.color = '#ff7070';
      errorBox.textContent = msg;
      errorBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }

  async handleLogout() {
    try {
      if (this.supabase) {
        await this.supabase.auth.signOut();
      }
      this.currentUser = null;
      this.closeModal('profile-modal');
      this.updateUserUI();
      showToast('Sesión cerrada');
      await this.loadPlaylists();
    } catch (err) {
      console.error('Logout error:', err);
      showToast('Error al cerrar sesión');
    }
  }

  // -------------------------------------------------------------
  // PLAYLISTS MANAGEMENT (Supabase Cloud + Local Storage fallback)
  // -------------------------------------------------------------
  getLocalPlaylists() {
    try {
      const raw = localStorage.getItem('spotify_playlists_cache');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [
      {
        id: 'favorites',
        name: 'Tus me gusta',
        description: 'Tus canciones favoritas guardadas',
        isSystem: true,
        systemType: 'favorites',
        cover: 'https://misc.scdn.co/liked-songs/liked-songs-300.png',
        tracks: []
      }
    ];
  }

  saveLocalPlaylists(lists) {
    try {
      localStorage.setItem('spotify_playlists_cache', JSON.stringify(lists));
    } catch (e) {}
  }

  async loadPlaylists() {
    // 1. If user is logged in with Supabase
    if (this.supabase && this.currentUser) {
      try {
        const { data, error } = await this.supabase
          .from('playlists')
          .select('*, playlist_tracks(*)')
          .order('created_at', { ascending: true });

        if (error) throw error;

        let userPlaylists = data || [];

        // Ensure "Tus me gusta" system playlist exists for this user
        let favoritesPlaylist = userPlaylists.find(p => p.system_type === 'favorites');
        if (!favoritesPlaylist) {
          const { data: newFav, error: favErr } = await this.supabase
            .from('playlists')
            .insert([{
              user_id: this.currentUser.id,
              name: 'Tus me gusta',
              description: 'Tus canciones favoritas guardadas',
              is_system: true,
              system_type: 'favorites',
              cover: 'https://misc.scdn.co/liked-songs/liked-songs-300.png'
            }])
            .select('*, playlist_tracks(*)')
            .single();

          if (!favErr && newFav) {
            userPlaylists.unshift(newFav);
          }
        }

        // Normalize structure
        this.playlists = userPlaylists.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          isSystem: p.is_system,
          systemType: p.system_type,
          cover: p.cover || (p.system_type === 'favorites' ? 'https://misc.scdn.co/liked-songs/liked-songs-300.png' : ''),
          tracks: (p.playlist_tracks || []).map(t => ({
            id: t.track_id,
            title: t.title,
            artist: t.artist,
            thumbnail: t.thumbnail,
            duration: t.duration,
            durationFormatted: t.duration_formatted,
            addedAt: t.added_at
          }))
        }));

        this.renderLibrary();
        if (this.player.currentTrack) {
          this.updateLikeButton(this.player.currentTrack.id);
        }
        return;
      } catch (err) {
        console.error('Error fetching Supabase playlists:', err);
      }
    }

    // 2. Fallback to Local Storage so guests and offline users can still play & save
    this.playlists = this.getLocalPlaylists();
    this.renderLibrary();
    if (this.player.currentTrack) {
      this.updateLikeButton(this.player.currentTrack.id);
    }
  }

  getFavoritesPlaylist() {
    return this.playlists.find(p => p.systemType === 'favorites' || p.id === 'favorites') || this.playlists[0];
  }

  isTrackLiked(trackId) {
    const fav = this.getFavoritesPlaylist();
    return fav && fav.tracks && fav.tracks.some(t => t.id === trackId);
  }

  async toggleLike(track) {
    if (!track) return;

    const fav = this.getFavoritesPlaylist();
    if (!fav) return;

    const isLiked = this.isTrackLiked(track.id);

    try {
      if (this.supabase && this.currentUser) {
        if (isLiked) {
          await this.supabase
            .from('playlist_tracks')
            .delete()
            .match({ playlist_id: fav.id, track_id: track.id });
          showToast('Eliminada de Tus me gusta');
        } else {
          await this.supabase
            .from('playlist_tracks')
            .insert([{
              playlist_id: fav.id,
              user_id: this.currentUser.id,
              track_id: track.id,
              title: track.title,
              artist: track.artist,
              thumbnail: track.thumbnail || '',
              duration: track.duration || 0,
              duration_formatted: track.durationFormatted || track.duration_formatted || '0:00'
            }]);
          showToast('Añadida a Tus me gusta ❤️');
        }
        await this.loadPlaylists();
      } else {
        // Local mode
        if (isLiked) {
          fav.tracks = fav.tracks.filter(t => t.id !== track.id);
          showToast('Eliminada de Tus me gusta');
        } else {
          fav.tracks.push({
            id: track.id,
            title: track.title,
            artist: track.artist,
            thumbnail: track.thumbnail || '',
            duration: track.duration || 0,
            durationFormatted: track.durationFormatted || track.duration_formatted || '0:00'
          });
          showToast('Añadida a Tus me gusta ❤️');
        }
        this.saveLocalPlaylists(this.playlists);
        this.renderLibrary();
      }

      this.updateLikeButton(track.id);

      if (this.activePlaylist && (this.activePlaylist.id === fav.id || this.activePlaylist.systemType === 'favorites')) {
        this.openPlaylist(this.getFavoritesPlaylist());
      }
    } catch (e) {
      console.error('Error toggling like:', e);
      showToast('Error al actualizar favoritos');
    }
  }

  async handleCreatePlaylist(customName = null) {
    const nameInput = document.getElementById('new-playlist-name');
    const descInput = document.getElementById('new-playlist-desc');
    const name = (customName || (nameInput ? nameInput.value : '')).trim();
    if (!name) return null;

    try {
      let created = null;

      if (this.supabase && this.currentUser) {
        const { data, error } = await this.supabase
          .from('playlists')
          .insert([{
            user_id: this.currentUser.id,
            name: name,
            description: descInput ? descInput.value.trim() : '',
            is_system: false,
            cover: ''
          }])
          .select()
          .single();

        if (error) throw error;
        created = {
          id: data.id,
          name: data.name,
          description: data.description,
          isSystem: false,
          cover: '',
          tracks: []
        };
      } else {
        // Local Mode
        created = {
          id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          name: name,
          description: descInput ? descInput.value.trim() : '',
          isSystem: false,
          cover: '',
          tracks: []
        };
        this.playlists.push(created);
        this.saveLocalPlaylists(this.playlists);
      }

      if (nameInput) nameInput.value = '';
      if (descInput) descInput.value = '';
      this.closeModal('create-playlist-modal');
      await this.loadPlaylists();
      showToast(`Playlist "${name}" creada`);
      return created;
    } catch (e) {
      console.error('Error creating playlist:', e);
      showToast('Error al crear la playlist');
      return null;
    }
  }

  async deletePlaylist(playlistId) {
    try {
      if (this.supabase && this.currentUser) {
        const { error } = await this.supabase
          .from('playlists')
          .delete()
          .eq('id', playlistId);
        if (error) throw error;
        await this.loadPlaylists();
      } else {
        this.playlists = this.playlists.filter(p => p.id !== playlistId);
        this.saveLocalPlaylists(this.playlists);
        this.renderLibrary();
      }

      showToast('Playlist eliminada');
      this.activePlaylist = null;
      this.switchView('library');
    } catch (e) {
      console.error('Error deleting playlist:', e);
      showToast('Error al eliminar playlist');
    }
  }

  openAddToPlaylistModal(track) {
    if (!track) return;
    this.selectedTrackForModal = track;
    const quickInput = document.getElementById('quick-playlist-input');
    if (quickInput) quickInput.value = '';

    this.renderModalPlaylists();
    this.openModal('add-to-playlist-modal');
  }

  renderModalPlaylists() {
    const container = document.getElementById('modal-playlists-list');
    if (!container) return;
    container.innerHTML = '';

    const track = this.selectedTrackForModal;
    if (!track) return;

    if (this.playlists.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#b3b3b3; padding:12px 0;">No tienes listas aún. Crea una arriba.</p>';
      return;
    }

    this.playlists.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'track-item';
      item.style.padding = '10px 8px';
      item.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

      const alreadyIn = pl.tracks && pl.tracks.some(t => t.id === track.id);
      const isFav = pl.systemType === 'favorites' || pl.isSystem;

      item.innerHTML = `
        <div class="track-thumb-wrap" style="width:38px; height:38px; border-radius:4px; margin-right:10px;">
          <img class="track-thumb" src="${pl.cover || (isFav ? 'https://misc.scdn.co/liked-songs/liked-songs-64.png' : '/icons/icon-192.png')}" alt="">
        </div>
        <div class="track-info">
          <div class="track-title" style="font-size:14px; font-weight:600;">${pl.name}</div>
          <div class="track-artist" style="font-size:12px;">${pl.tracks ? pl.tracks.length : 0} canciones</div>
        </div>
        <div>
          ${alreadyIn 
            ? '<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; color:#1db954; font-weight:700;">✓ En lista</button>' 
            : '<button class="btn btn-primary btn-add-action" style="padding:6px 14px; font-size:12px;">+ Añadir</button>'}
        </div>
      `;

      const actionBtn = item.querySelector('.btn-add-action');
      if (actionBtn) {
        actionBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          actionBtn.disabled = true;
          actionBtn.textContent = '...';
          await this.addTrackToPlaylist(pl.id, track);
          this.renderModalPlaylists();
        });
      }

      container.appendChild(item);
    });
  }

  async addTrackToPlaylist(playlistId, track) {
    if (!track || !playlistId) return;

    try {
      if (this.supabase && this.currentUser) {
        const { error } = await this.supabase
          .from('playlist_tracks')
          .insert([{
            playlist_id: playlistId,
            user_id: this.currentUser.id,
            track_id: track.id,
            title: track.title,
            artist: track.artist,
            thumbnail: track.thumbnail || '',
            duration: track.duration || 0,
            duration_formatted: track.durationFormatted || track.duration_formatted || '0:00'
          }]);

        if (error) throw error;

        // Set playlist cover if first track
        const pl = this.playlists.find(p => p.id === playlistId);
        if (pl && !pl.cover && track.thumbnail && !pl.isSystem) {
          await this.supabase
            .from('playlists')
            .update({ cover: track.thumbnail })
            .eq('id', playlistId);
        }

        await this.loadPlaylists();
      } else {
        // Local mode
        const pl = this.playlists.find(p => p.id === playlistId);
        if (pl) {
          const exists = pl.tracks && pl.tracks.some(t => t.id === track.id);
          if (!exists) {
            pl.tracks = pl.tracks || [];
            pl.tracks.push({
              id: track.id,
              title: track.title,
              artist: track.artist,
              thumbnail: track.thumbnail || '',
              duration: track.duration || 0,
              durationFormatted: track.durationFormatted || track.duration_formatted || '0:00'
            });
            if (!pl.cover && track.thumbnail && !pl.isSystem) {
              pl.cover = track.thumbnail;
            }
            this.saveLocalPlaylists(this.playlists);
            this.renderLibrary();
          }
        }
      }

      const targetPl = this.playlists.find(p => p.id === playlistId);
      showToast(`Añadida a "${targetPl ? targetPl.name : 'la lista'}"`);

      if (this.activePlaylist && this.activePlaylist.id === playlistId) {
        const updated = this.playlists.find(p => p.id === playlistId);
        if (updated) this.openPlaylist(updated);
      }
    } catch (e) {
      console.error('Error adding track to playlist:', e);
      showToast('Error al agregar la canción a la lista');
    }
  }

  async removeTrackFromPlaylist(playlistId, trackId) {
    if (!playlistId || !trackId) return;

    try {
      if (this.supabase && this.currentUser) {
        const { error } = await this.supabase
          .from('playlist_tracks')
          .delete()
          .match({ playlist_id: playlistId, track_id: trackId });
        if (error) throw error;
        await this.loadPlaylists();
      } else {
        const pl = this.playlists.find(p => p.id === playlistId);
        if (pl && pl.tracks) {
          pl.tracks = pl.tracks.filter(t => t.id !== trackId);
          this.saveLocalPlaylists(this.playlists);
          this.renderLibrary();
        }
      }

      showToast('Canción quitada de la lista');

      if (this.activePlaylist && this.activePlaylist.id === playlistId) {
        const updated = this.playlists.find(p => p.id === playlistId);
        if (updated) this.openPlaylist(updated);
      }
    } catch (e) {
      console.error('Error removing track from playlist:', e);
      showToast('Error al quitar la canción');
    }
  }

  // -------------------------------------------------------------
  // PLAYLIST DETAIL: SEARCH & ADD MODAL
  // -------------------------------------------------------------
  openSearchPlaylistModal(playlist) {
    const targetLabel = document.getElementById('search-playlist-target-name');
    const input = document.getElementById('search-playlist-input');
    const resultsContainer = document.getElementById('search-playlist-results');

    if (targetLabel) targetLabel.textContent = `Añadiendo a: ${playlist.name}`;
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 150);
    }
    if (resultsContainer) {
      resultsContainer.innerHTML = '<p style="text-align:center; color:#b3b3b3; font-size:13px; margin-top:30px;">Escribe el nombre de una canción o artista para buscar</p>';
    }

    this.openModal('search-playlist-modal');
  }

  renderPlaylistSearchResults(tracks, container) {
    if (!container) return;
    container.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#b3b3b3; margin-top:20px;">No se encontraron resultados</p>';
      return;
    }

    const targetPlaylist = this.activePlaylist;
    if (!targetPlaylist) return;

    tracks.forEach(track => {
      const item = document.createElement('div');
      item.className = 'track-item';
      item.style.padding = '8px 4px';
      item.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

      const alreadyIn = targetPlaylist.tracks && targetPlaylist.tracks.some(t => t.id === track.id);

      item.innerHTML = `
        <div class="track-thumb-wrap" style="width:40px; height:40px; border-radius:4px; margin-right:10px;">
          <img class="track-thumb" src="${track.thumbnail}" alt="" loading="lazy">
        </div>
        <div class="track-info" style="flex:1; overflow:hidden;">
          <div class="track-title" style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${track.title}</div>
          <div class="track-artist" style="font-size:11px; color:#b3b3b3;">${track.artist}</div>
        </div>
        <div>
          ${alreadyIn 
            ? '<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; color:#1db954; font-weight:700;">✓ En lista</button>' 
            : '<button class="btn btn-primary btn-add-direct" style="padding:6px 14px; font-size:12px;">+ Añadir</button>'}
        </div>
      `;

      const addBtn = item.querySelector('.btn-add-direct');
      if (addBtn) {
        addBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          addBtn.disabled = true;
          addBtn.textContent = '...';
          await this.addTrackToPlaylist(targetPlaylist.id, track);
          addBtn.className = 'btn btn-secondary';
          addBtn.style.color = '#1db954';
          addBtn.style.fontWeight = '700';
          addBtn.textContent = '✓ Añadida';
        });
      }

      container.appendChild(item);
    });
  }

  // -------------------------------------------------------------
  // UI & NAVIGATION EVENT BINDINGS
  // -------------------------------------------------------------
  bindEvents() {
    // Navigation tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        this.switchView(view);
      });
    });

    // Search input with debounce
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
    let debounceTimer;

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      searchClear.style.display = query ? 'block' : 'none';

      clearTimeout(debounceTimer);
      if (!query) {
        document.getElementById('search-results').innerHTML = '';
        return;
      }

      debounceTimer = setTimeout(() => {
        this.performSearch(query);
      }, 450);
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      document.getElementById('search-results').innerHTML = '';
      searchInput.focus();
    });

    // Genre chips click
    document.querySelectorAll('.genre-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const query = chip.dataset.query || chip.textContent;
        searchInput.value = query;
        searchClear.style.display = 'block';
        this.performSearch(query);
      });
    });

    // Mini Player click -> Open Fullscreen Modal
    document.getElementById('mini-player').addEventListener('click', (e) => {
      if (e.target.closest('.mini-controls') || e.target.closest('.mini-like-btn')) return;
      this.openPlayerModal();
    });

    // Mini Player Play/Pause
    document.getElementById('mini-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.player.togglePlay();
    });

    // Fullscreen Player Close
    document.getElementById('close-player-btn').addEventListener('click', () => {
      this.closePlayerModal();
    });

    // Fullscreen Play/Pause
    document.getElementById('ctrl-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.player.togglePlay();
    });

    // Fullscreen Next / Prev / Shuffle / Repeat
    document.getElementById('ctrl-prev-btn').addEventListener('click', () => {
      this.player.previous();
    });
    document.getElementById('ctrl-next-btn').addEventListener('click', () => {
      this.player.next();
    });
    document.getElementById('ctrl-shuffle-btn').addEventListener('click', () => {
      const isShuffle = this.player.toggleShuffle();
      document.getElementById('ctrl-shuffle-btn').classList.toggle('active', isShuffle);
      showToast(isShuffle ? 'Modo aleatorio activado' : 'Modo aleatorio desactivado');
    });
    document.getElementById('ctrl-repeat-btn').addEventListener('click', () => {
      const mode = this.player.toggleRepeat();
      const btn = document.getElementById('ctrl-repeat-btn');
      btn.classList.toggle('active', mode !== 'off');
      showToast(mode === 'one' ? 'Repitiendo esta canción' : mode === 'all' ? 'Repetición en bucle activada' : 'Repetición desactivada');
    });

    // Like button in full player
    document.getElementById('player-like-btn').addEventListener('click', () => {
      if (this.player.currentTrack) {
        this.toggleLike(this.player.currentTrack);
      }
    });

    // Add to playlist button in full player
    document.getElementById('player-add-playlist-btn')?.addEventListener('click', () => {
      if (this.player.currentTrack) {
        this.openAddToPlaylistModal(this.player.currentTrack);
      }
    });

    // Scrub Bar Interaction (Mouse & Touch)
    const scrubTrack = document.getElementById('scrub-track');
    const updateScrubPos = (clientX) => {
      const rect = scrubTrack.getBoundingClientRect();
      const percentage = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      document.getElementById('scrub-progress').style.width = `${percentage}%`;
      return percentage;
    };

    scrubTrack.addEventListener('pointerdown', (e) => {
      this.isDraggingScrub = true;
      const percentage = updateScrubPos(e.clientX);
      this.player.seekByPercentage(percentage);
    });

    window.addEventListener('pointermove', (e) => {
      if (this.isDraggingScrub) {
        updateScrubPos(e.clientX);
      }
    });

    window.addEventListener('pointerup', (e) => {
      if (this.isDraggingScrub) {
        this.isDraggingScrub = false;
        const percentage = updateScrubPos(e.clientX);
        this.player.seekByPercentage(percentage);
      }
    });

    // Create Playlist Modal Buttons
    document.getElementById('create-playlist-btn').addEventListener('click', () => {
      this.openModal('create-playlist-modal');
    });
    document.getElementById('cancel-create-playlist').addEventListener('click', () => {
      this.closeModal('create-playlist-modal');
    });
    document.getElementById('confirm-create-playlist').addEventListener('click', () => {
      this.handleCreatePlaylist();
    });

    // Add to Playlist Modal Cancel & Close
    document.getElementById('cancel-add-to-playlist')?.addEventListener('click', () => {
      this.closeModal('add-to-playlist-modal');
    });
    document.getElementById('close-add-to-playlist-btn')?.addEventListener('click', () => {
      this.closeModal('add-to-playlist-modal');
    });

    // Quick create playlist inside "Añadir a lista" modal
    const handleQuickCreate = async () => {
      const input = document.getElementById('quick-playlist-input');
      const name = (input ? input.value : '').trim();
      if (!name) return;

      const created = await this.handleCreatePlaylist(name);
      if (created && this.selectedTrackForModal) {
        await this.addTrackToPlaylist(created.id, this.selectedTrackForModal);
      }
      if (input) input.value = '';
      this.renderModalPlaylists();
    };

    document.getElementById('quick-create-playlist-btn')?.addEventListener('click', handleQuickCreate);
    document.getElementById('quick-playlist-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleQuickCreate();
    });

    // Playlist Detail: Add tracks button
    document.getElementById('playlist-add-tracks-btn')?.addEventListener('click', () => {
      if (!this.activePlaylist) return;
      this.openSearchPlaylistModal(this.activePlaylist);
    });

    document.getElementById('close-search-playlist-modal')?.addEventListener('click', () => {
      this.closeModal('search-playlist-modal');
    });

    document.getElementById('done-search-playlist-btn')?.addEventListener('click', () => {
      this.closeModal('search-playlist-modal');
    });

    // Playlist Detail: Search inside search-playlist-modal
    let playlistSearchDebounce;
    const searchPlInput = document.getElementById('search-playlist-input');
    if (searchPlInput) {
      searchPlInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearTimeout(playlistSearchDebounce);

        const results = document.getElementById('search-playlist-results');
        if (!query) {
          if (results) results.innerHTML = '<p style="text-align:center; color:#b3b3b3; font-size:13px; margin-top:30px;">Escribe el nombre de una canción para buscar</p>';
          return;
        }

        if (results) results.innerHTML = '<div class="spinner"></div>';

        playlistSearchDebounce = setTimeout(async () => {
          try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            this.renderPlaylistSearchResults(data.tracks || [], results);
          } catch (err) {
            if (results) results.innerHTML = '<p style="text-align:center; color:#b3b3b3; margin-top:20px;">Error al buscar canciones</p>';
          }
        }, 400);
      });
    }

    // Playlist Detail: Delete playlist button
    document.getElementById('playlist-delete-btn')?.addEventListener('click', async () => {
      if (!this.activePlaylist || this.activePlaylist.isSystem) return;
      if (confirm(`¿Estás seguro de eliminar la playlist "${this.activePlaylist.name}"?`)) {
        await this.deletePlaylist(this.activePlaylist.id);
      }
    });

    // Playlist Detail Back Button
    document.getElementById('playlist-back-btn').addEventListener('click', () => {
      this.switchView('library');
    });

    // Play All in Playlist Detail
    document.getElementById('playlist-play-all-btn').addEventListener('click', () => {
      if (this.activePlaylist && this.activePlaylist.tracks && this.activePlaylist.tracks.length > 0) {
        this.player.loadAndPlay(this.activePlaylist.tracks[0], this.activePlaylist.tracks, 0);
      } else {
        showToast('Esta lista aún no tiene canciones');
      }
    });

    // Swipe down to close player on mobile
    let touchStartY = 0;
    const playerModal = document.getElementById('player-modal');
    playerModal.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    playerModal.addEventListener('touchmove', (e) => {
      const touchY = e.touches[0].clientY;
      const diff = touchY - touchStartY;
      if (diff > 80) {
        this.closePlayerModal();
      }
    }, { passive: true });

    // Close modals on overlay backdrop click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('open');
        }
      });
    });

    // Close modals on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
      }
    });
  }

  setupPlayerListeners() {
    this.player.on('trackchange', (track) => {
      this.updatePlayerUI(track);
      this.updatePlayingItemInLists(track.id);
    });

    this.player.on('play', () => {
      this.setPlayPauseState(true);
    });

    this.player.on('pause', () => {
      this.setPlayPauseState(false);
    });

    this.player.on('loading', (isLoading) => {
      const playIcon = document.getElementById('ctrl-play-icon');
      if (playIcon) {
        playIcon.classList.toggle('pulse', isLoading);
      }
    });

    this.player.on('timeupdate', ({ currentTime, duration, progress }) => {
      if (!this.isDraggingScrub) {
        const scrubProgress = document.getElementById('scrub-progress');
        const miniProgressFill = document.getElementById('mini-progress-fill');
        const timeCurrent = document.getElementById('time-current');
        const timeTotal = document.getElementById('time-total');

        if (scrubProgress) scrubProgress.style.width = `${progress}%`;
        if (miniProgressFill) miniProgressFill.style.width = `${progress}%`;
        if (timeCurrent) timeCurrent.textContent = formatTime(currentTime);
        if (timeTotal) timeTotal.textContent = formatTime(duration);
      }
    });
  }

  switchView(viewName) {
    this.currentView = viewName;

    // Update bottom nav
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    // Update view visibility
    document.querySelectorAll('.view').forEach(view => {
      view.classList.remove('active');
    });

    const activeView = document.getElementById(`view-${viewName}`);
    if (activeView) {
      activeView.classList.add('active');
    }

    if (viewName === 'library') {
      this.renderLibrary();
    }
  }

  openPlayerModal() {
    document.getElementById('player-modal').classList.add('open');
  }

  closePlayerModal() {
    document.getElementById('player-modal').classList.remove('open');
  }

  updatePlayerUI(track) {
    if (!track) return;

    // Show mini player
    document.getElementById('mini-player').classList.remove('hidden');

    // Mini Player
    document.getElementById('mini-thumb').src = track.thumbnail;
    document.getElementById('mini-title').textContent = track.title;
    document.getElementById('mini-artist').textContent = track.artist;

    // Full Player Modal
    document.getElementById('player-cover-img').src = track.thumbnail;
    document.getElementById('player-title').textContent = track.title;
    document.getElementById('player-artist').textContent = track.artist;

    this.updateLikeButton(track.id);
  }

  updateLikeButton(trackId) {
    const isLiked = this.isTrackLiked(trackId);
    const likeBtn = document.getElementById('player-like-btn');
    if (!likeBtn) return;
    likeBtn.classList.toggle('active', isLiked);

    const heartPath = likeBtn.querySelector('path');
    if (heartPath) {
      heartPath.setAttribute('fill', isLiked ? '#1db954' : 'none');
      heartPath.setAttribute('stroke', isLiked ? '#1db954' : 'currentColor');
    }
  }

  setPlayPauseState(isPlaying) {
    const playSvg = `
      <svg id="ctrl-play-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
    `;
    const pauseSvg = `
      <svg id="ctrl-play-icon" width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
      </svg>
    `;

    const miniPlaySvg = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>
    `;
    const miniPauseSvg = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
      </svg>
    `;

    const miniBtn = document.getElementById('mini-play-btn');
    const ctrlBtn = document.getElementById('ctrl-play-btn');
    if (miniBtn) miniBtn.innerHTML = isPlaying ? miniPauseSvg : miniPlaySvg;
    if (ctrlBtn) ctrlBtn.innerHTML = isPlaying ? pauseSvg : playSvg;

    if (this.player.currentTrack) {
      this.updatePlayingItemInLists(this.player.currentTrack.id);
    }
  }

  updatePlayingItemInLists(trackId) {
    document.querySelectorAll('.track-item').forEach(item => {
      const isCurrent = item.dataset.id === trackId;
      item.classList.toggle('playing', isCurrent);
    });
  }

  // Search execution
  async performSearch(query) {
    const container = document.getElementById('search-results');
    container.innerHTML = '<div class="spinner"></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#b3b3b3; margin-top:24px;">No se encontraron canciones</p>';
        return;
      }

      this.renderTrackList(data.tracks, container, data.tracks);
    } catch (e) {
      container.innerHTML = '<p style="text-align:center; color:#b3b3b3; margin-top:24px;">Error al buscar canciones</p>';
    }
  }

  renderTrackList(tracks, container, queueContext = [], playlistContext = null) {
    container.innerHTML = '';
    const listWrap = document.createElement('div');
    listWrap.className = 'track-list';

    tracks.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'track-item';
      item.dataset.id = track.id;

      if (this.player.currentTrack && this.player.currentTrack.id === track.id) {
        item.classList.add('playing');
      }

      item.innerHTML = `
        <div class="track-thumb-wrap">
          <img class="track-thumb" src="${track.thumbnail}" alt="" loading="lazy">
          <div class="track-playing-indicator">
            <div class="track-playing-bars">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
        <div class="track-info">
          <div class="track-title">${track.title}</div>
          <div class="track-artist">${track.artist}</div>
        </div>
        <div class="track-duration">${track.durationFormatted || track.duration_formatted || '0:00'}</div>
        <div class="track-actions">
          <button class="icon-btn track-like-btn" title="Me gusta">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="${this.isTrackLiked(track.id) ? '#1db954' : 'none'}" stroke="${this.isTrackLiked(track.id) ? '#1db954' : 'currentColor'}" stroke-width="2">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
          </button>
          <button class="icon-btn track-menu-btn" title="Añadir a playlist">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/>
            </svg>
          </button>
          ${playlistContext ? `
            <button class="icon-btn track-remove-btn" title="Quitar de esta lista" style="color:#b3b3b3;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          ` : ''}
        </div>
      `;

      // Click to play
      item.addEventListener('click', (e) => {
        if (e.target.closest('.track-actions')) return;
        this.player.loadAndPlay(track, queueContext, index);
      });

      // Like track button
      item.querySelector('.track-like-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.toggleLike(track);
        const svg = item.querySelector('.track-like-btn svg');
        const liked = this.isTrackLiked(track.id);
        svg.setAttribute('fill', liked ? '#1db954' : 'none');
        svg.setAttribute('stroke', liked ? '#1db954' : 'currentColor');
      });

      // Options menu (Add to playlist)
      item.querySelector('.track-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openAddToPlaylistModal(track);
      });

      // Remove from current playlist
      const removeBtn = item.querySelector('.track-remove-btn');
      if (removeBtn && playlistContext) {
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.removeTrackFromPlaylist(playlistContext.id, track.id);
        });
      }

      listWrap.appendChild(item);
    });

    container.appendChild(listWrap);
  }

  // Home Screen rendering
  renderHomeQuickGrid() {
    const grid = document.getElementById('home-quick-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const quickItems = [
      { name: 'Tus me gusta', cover: 'https://misc.scdn.co/liked-songs/liked-songs-64.png', action: () => this.openPlaylist(this.getFavoritesPlaylist()) },
      { name: 'Top Éxitos', cover: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg', search: 'Top hits musica 2026' },
      { name: 'Reggaetón 2026', cover: 'https://i.ytimg.com/vi/c5wXFxiLabI/hqdefault.jpg', search: 'Reggaeton nuevo' },
      { name: 'Pop en Inglés', cover: 'https://i.ytimg.com/vi/5NV6Rdv1a3I/hqdefault.jpg', search: 'Pop hits mix' }
    ];

    quickItems.forEach(item => {
      const card = document.createElement('div');
      card.className = 'quick-card';
      card.innerHTML = `
        <img class="quick-card-img" src="${item.cover}" alt="">
        <div class="quick-card-name">${item.name}</div>
      `;
      card.addEventListener('click', () => {
        if (item.action) {
          item.action();
        } else if (item.search) {
          this.switchView('search');
          const input = document.getElementById('search-input');
          input.value = item.search;
          document.getElementById('search-clear').style.display = 'block';
          this.performSearch(item.search);
        }
      });
      grid.appendChild(card);
    });
  }

  async loadHomeRecommendations() {
    const container = document.getElementById('home-recommendations');
    if (!container) return;
    try {
      const res = await fetch('/api/search?q=musica tendencia');
      const data = await res.json();
      if (data.tracks) {
        this.renderTrackList(data.tracks.slice(0, 10), container, data.tracks);
      }
    } catch (e) {
      console.error('Error loading recommendations:', e);
    }
  }

  // Library View rendering
  renderLibrary() {
    const grid = document.getElementById('playlists-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Show guest banner inviting user to log in / register
    if (!this.currentUser) {
      const banner = document.createElement('div');
      banner.className = 'guest-library-banner';
      banner.innerHTML = `
        <div class="guest-banner-left">
          <div class="guest-banner-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
            </svg>
          </div>
          <div>
            <div class="guest-banner-title">Sincroniza tus listas en la nube</div>
            <div class="guest-banner-desc">Inicia sesión o regístrate para guardar y escuchar tus playlists en cualquier dispositivo.</div>
          </div>
        </div>
        <button type="button" class="btn btn-primary guest-banner-btn" id="guest-lib-login-btn">Iniciar sesión</button>
      `;
      banner.querySelector('#guest-lib-login-btn').addEventListener('click', () => {
        this.openAuthModal('login');
      });
      grid.appendChild(banner);
    }

    this.playlists.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      const cover = pl.cover || (pl.isSystem ? 'https://misc.scdn.co/liked-songs/liked-songs-300.png' : '/icons/icon-192.png');

      card.innerHTML = `
        <div class="playlist-cover-wrap">
          <img class="playlist-cover" src="${cover}" alt="">
        </div>
        <div class="playlist-card-title">${pl.name}</div>
        <div class="playlist-card-desc">${pl.tracks ? pl.tracks.length : 0} canciones</div>
      `;

      card.addEventListener('click', () => {
        this.openPlaylist(pl);
      });

      grid.appendChild(card);
    });
  }

  // Open Playlist Detail View
  openPlaylist(playlist) {
    if (!playlist) return;
    this.activePlaylist = playlist;

    document.getElementById('playlist-hero-title').textContent = playlist.name;
    document.getElementById('playlist-hero-desc').textContent = `${playlist.tracks ? playlist.tracks.length : 0} canciones • ${playlist.description || 'Playlist de Spotify'}`;

    const coverImg = document.getElementById('playlist-hero-cover');
    coverImg.src = playlist.cover || (playlist.isSystem ? 'https://misc.scdn.co/liked-songs/liked-songs-300.png' : '/icons/icon-512.png');

    const container = document.getElementById('playlist-tracks-container');
    if (playlist.tracks && playlist.tracks.length > 0) {
      this.renderTrackList(playlist.tracks, container, playlist.tracks, playlist);
    } else {
      container.innerHTML = '<p style="text-align:center; color:#b3b3b3; margin-top:24px;">No hay canciones en esta lista.<br>¡Toca "Añadir canciones" arriba para buscar y agregar!</p>';
    }

    // Toggle delete playlist button visibility
    const delBtn = document.getElementById('playlist-delete-btn');
    if (delBtn) {
      delBtn.style.display = (!playlist.isSystem && playlist.id !== 'favorites') ? 'block' : 'none';
    }

    this.switchView('playlist-detail');
  }

  // Modals management
  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new SpotifyApp();
});
