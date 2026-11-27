import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  type DeepPartial,
  type AntigravityOrbitConfig,
  type VisualBudgetMode,
} from '@antigravity-orbit/shared';
import { atomicWritePrivateFile } from '../platform/paths.js';

export class ConfigStore extends EventEmitter<{ changed: [AntigravityOrbitConfig] }> {
  private current: AntigravityOrbitConfig = DEFAULT_CONFIG;
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DeepPartial<AntigravityOrbitConfig>;
      this.current = normalizeConfig(raw, DEFAULT_CONFIG);
    } catch {
      this.current = DEFAULT_CONFIG;
    }
  }

  get(): AntigravityOrbitConfig {
    return this.current;
  }

  patch(delta: DeepPartial<AntigravityOrbitConfig>): AntigravityOrbitConfig {
    const next = normalizeConfig(delta, this.current);
    this.current = next;
    atomicWritePrivateFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    this.emit('changed', next);
    return next;
  }

  applyPreset(preset: VisualBudgetMode): AntigravityOrbitConfig {
    if (preset === 'full-optics') {
      return this.patch({
        visualBudget: 'full-optics',
        hud: { enabled: true, style: 'hybrid' },
        workbench: { inkStreamFade: true, effortSlider: true },
        optics: { picker3d: true, horizonRipple: true },
      });
    }
    if (preset === 'focus') {
      return this.patch({
        visualBudget: 'focus',
        hud: { enabled: true, style: 'capsules' },
        workbench: { inkStreamFade: true, effortSlider: true },
        optics: { picker3d: false, wallpaper: false, horizonRipple: false },
      });
    }
    return this.patch({
      visualBudget: 'silent-eco',
      hud: { enabled: true, style: 'capsules' },
      workbench: { inkStreamFade: false, effortSlider: false },
      optics: { picker3d: false, wallpaper: false, horizonRipple: false },
    });
  }
}
