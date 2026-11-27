import type { VisualBudgetMode, VisualChannelContract } from '@antigravity-orbit/shared';

interface PeriodicPickerInstance {
  destroy?: () => void;
  getStatus?: () => Record<string, unknown>;
}

interface PeriodicPickerFactory {
  mountPeriodicPicker?: (opts: { root: Window; doc: Document; mode: 'on' | 'off' }) => PeriodicPickerInstance;
}

const CLEANUP_GLOBALS = [
  '__agOrbitPeriodicPicker',
  '__agOrbitPeriodicPickerFactory',
  '__agOrbitKeyboard3D',
  '__agOrbitPeriodicKeyboard3D',
  '__agOrbitOledScreen',
  '__agOrbitGrainAssets',
  '__agPeriodicAudioFx',
  '__agPeriodicModelCatalog',
  '__agPeriodicHostBridge',
  '__agPeriodicBentoUi',
  '__agPeriodicPbrGrainAssets',
  '__agPeriodicOledScreen',
  '__agPeriodicKeyboard3D',
] as const;

/**
 * Ch09: WebGL2 3D Mechanical Keyboard / Periodic Model Picker.
 * Mounted on demand when picker3d is enabled and symmetrically torn down on disable/silent-eco.
 */
class OpticsPicker3DChannel implements VisualChannelContract {
  readonly id = 'ch09-optics-picker' as const;
  private instance: PeriodicPickerInstance | null = null;
  private activeRoot: Document | null = null;

  mount(root: Document): void {
    this.activeRoot = root;
    const win = window as unknown as Record<string, unknown>;
    const factory = (win.__agOrbitPeriodicPickerFactory ??
      (globalThis as unknown as Record<string, unknown>).__agOrbitPeriodicPickerFactory) as
      | PeriodicPickerFactory
      | undefined;

    if (!factory || typeof factory.mountPeriodicPicker !== 'function') return;

    try {
      (win.__agOrbitPeriodicPicker as PeriodicPickerInstance | undefined)?.destroy?.();
    } catch {
      // Ignore stale cleanup
    }

    const inst = factory.mountPeriodicPicker({
      root: window,
      doc: root,
      mode: 'on',
    });
    this.instance = inst ?? null;
    if (inst) {
      win.__agOrbitPeriodicPicker = inst;
    }
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}

  setBudgetMode(mode: VisualBudgetMode): void {
    if (mode === 'silent-eco') {
      this.dispose();
    } else if (!this.instance && this.activeRoot) {
      this.mount(this.activeRoot);
    }
  }

  reclaimVram(): void {
    // Periodic picker keeps WebGL2 context closed while overlay is not open;
    // dispose cleanly tears down any open overlay.
  }

  dispose(): void {
    const win = window as unknown as Record<string, unknown>;
    try {
      this.instance?.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    try {
      (win.__agOrbitPeriodicPicker as PeriodicPickerInstance | undefined)?.destroy?.();
    } catch {
      // Ignore destroy errors
    }
    this.instance = null;
    try {
      document.documentElement?.removeAttribute('data-ag-orbit-periodic-picker');
      document.documentElement?.removeAttribute('data-ag-pp-open');
      document.documentElement?.removeAttribute('data-ag-pp-holding');
      document
        .querySelectorAll('#ag-orbit-periodic-picker-css, #ag-orbit-periodic-picker-root, .ag-pp-hold-ring, .ag-pp-mini-keycap')
        .forEach((n) => n.remove());
    } catch {
      // Ignore DOM errors
    }
    for (const key of CLEANUP_GLOBALS) {
      try {
        delete win[key];
      } catch {
        // Ignore non-configurable globals
      }
    }
  }
}

const ch09PickerChannel = new OpticsPicker3DChannel();

const mainRegistry = ((window as unknown as {
  __antigravityOrbitMain?: {
    channels: Record<string, VisualChannelContract>;
    dispose: (id: string) => void;
    disposeAll: () => void;
  };
}).__antigravityOrbitMain ??= {
  channels: {},
  dispose(id: string) {
    try {
      this.channels[id]?.dispose();
    } finally {
      delete this.channels[id];
    }
  },
  disposeAll() {
    for (const id of Object.keys(this.channels)) {
      this.dispose(id);
    }
  },
});

mainRegistry.channels[ch09PickerChannel.id] = ch09PickerChannel;

if (window.__antigravityOrbit?.registerChannel) {
  window.__antigravityOrbit.registerChannel(ch09PickerChannel);
} else {
  ch09PickerChannel.mount(document);
}
