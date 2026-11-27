import type { VisualBudgetMode, VisualChannelContract } from '@antigravity-orbit/shared';

const WALLPAPER_HOST_ID = 'antigravity-orbit-optics-wallpaper-host';

/**
 * Ch11: Local Static & Video Wallpaper Channel.
 * Supports JPG/PNG/WebP/GIF/AVIF + MP4/WebM via loopback HTTP 206 Range gateway.
 * Automatically avoids Browser Hole regions and pauses video (0fps) on blur/hide/silent-eco.
 */
class OpticsWallpaperChannel implements VisualChannelContract {
  readonly id = 'ch11-optics-wallpaper' as const;
  private host: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private img: HTMLImageElement | null = null;

  mount(root: Document): void {
    const host = root.createElement('div');
    host.id = WALLPAPER_HOST_ID;
    host.setAttribute('data-antigravity-orbit-owned', 'true');
    const shadow = host.attachShadow({ mode: 'open' });

    const opacity = window.__antigravityOrbit?.getConfig()?.optics.wallpaperOpacity ?? 0.28;
    shadow.innerHTML = `
      <style>
        .layer {
          position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
          opacity: ${opacity}; transition: opacity 200ms ease;
        }
        :host-context([data-has-browser-hole="true"]) .layer { opacity: 0; }
        video, img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .scrim {
          position: absolute; inset: 0;
          background: radial-gradient(circle at center, transparent 35%, rgba(9,9,11,0.55) 100%);
        }
      </style>
      <div class="layer" id="pb-wp-layer">
        <div class="scrim"></div>
      </div>
    `;

    root.documentElement.appendChild(host);
    this.host = host;
  }

  setSource(url: string, mime: string): void {
    const layer = this.host?.shadowRoot?.getElementById('pb-wp-layer');
    if (!layer) return;

    this.video?.pause();
    this.video?.remove();
    this.img?.remove();
    this.video = null;
    this.img = null;

    if (mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      layer.prepend(video);
      this.video = video;
      void video.play().catch(() => {});
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.decoding = 'async';
      layer.prepend(img);
      this.img = img;
    }
  }

  onVisibilityChange(hidden: boolean): void {
    if (hidden) {
      this.video?.pause();
    } else {
      void this.video?.play().catch(() => {});
    }
  }

  onWindowBlur(blurred: boolean): void {
    if (blurred) {
      this.video?.pause();
    } else if (!document.hidden) {
      void this.video?.play().catch(() => {});
    }
  }

  setBudgetMode(mode: VisualBudgetMode): void {
    if (mode === 'silent-eco') {
      this.video?.pause();
    } else if (!document.hidden) {
      void this.video?.play().catch(() => {});
    }
  }

  reclaimVram(): void {
    this.video?.pause();
  }

  dispose(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.video = null;
    this.img = null;
    this.host?.remove();
    this.host = null;
  }
}

window.__antigravityOrbit?.registerChannel(new OpticsWallpaperChannel());
