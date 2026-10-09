import type { SpeedPreset } from '../engine/types';

export const speedOptions: { key: SpeedPreset; label: string }[] = [
  { key: 'manual', label: 'Manual' },
  { key: 'slow', label: 'Slow' },
  { key: 'normal', label: 'Normal' },
  { key: 'fast', label: 'Fast' },
  { key: 'ultra', label: 'Ultra' },
];
