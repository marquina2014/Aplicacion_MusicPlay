# 🎵 Spotify Web Clone (YouTube Background Audio para iPhone)

Una aplicación web estilo **Spotify**, diseñada específicamente para teléfonos móviles y **iPhone (iOS Safari)**. Permite buscar canciones y música de YouTube, reproducir únicamente el flujo de audio con alta calidad (AAC/M4A), mantener la música sonando en segundo plano con la pantalla bloqueada o al cambiar de app, y gestionar playlists personalizadas.

---

## 📱 Cómo abrirla e instalarla en tu iPhone

1. **Asegúrate de que tu iPhone y tu PC estén conectados a la misma red Wi-Fi.**
2. En la terminal de tu PC, el servidor muestra tu dirección IP y un código QR:
   ```
   http://192.168.0.216:3000
   ```
3. Abre la **Cámara de tu iPhone** y apunta al código QR que aparece en la pantalla de tu computadora, o escribe manualmente `http://192.168.0.216:3000` en **Safari**.
4. **Instalar como App Nativa (Recomendado):**
   - En Safari, toca el botón de **Compartir** (el cuadro con una flecha hacia arriba en la parte inferior).
   - Desplázate hacia abajo y selecciona **"Añadir a la pantalla de inicio"** (Add to Home Screen).
   - Toca **"Añadir"**.
   - ¡Listo! Ahora tendrás el icono de Spotify en tu iPhone que se abre en pantalla completa sin las barras del navegador.

---

## 🎧 ¿Cómo funciona el Segundo Plano y la Pantalla Bloqueada?

- Al reproducir cualquier canción, puedes:
  - **Bloquear tu iPhone:** El audio continuará sonando sin cortes.
  - **Ver la pantalla de bloqueo:** Verás la carátula de la canción, el título, el artista y los botones de Play/Pausa, Anterior y Siguiente.
  - **Usar otras aplicaciones:** Puedes abrir WhatsApp, Instagram, juegos o navegar y la música seguirá sonando.
  - **Centro de Control:** Desliza desde la esquina superior derecha de tu iPhone para pausar o cambiar de canción.

---

## 🚀 Comandos del Proyecto

Para iniciar el servidor en cualquier momento desde esta carpeta:

```bash
npm start
```
O directamente:
```bash
node server.js
```

---

## 🛠️ Tecnologías Utilizadas

- **Backend:** Node.js, Express, `yt-search` (búsqueda instantánea), `yt-dlp` (extracción de audio directo m4a/aac a 128kbps), streaming HTTP con Range Requests (`206 Partial Content`).
- **Frontend:** HTML5, CSS3 moderno (Tailwind/Spotify design system), Vanilla JS, MediaSession API (`navigator.mediaSession`), Service Worker (PWA).
- **Almacenamiento:** `data/playlists.json` para guardar tus listas y canciones favoritas.
