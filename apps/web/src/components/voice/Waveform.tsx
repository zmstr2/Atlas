'use client';
import { useFrequencyBars } from '@/lib/realtime/visualizer';

export function Waveform({
  stream,
  bars = 14,
  width = 96,
  height = 32,
  color,
}: {
  stream: MediaStream | null;
  bars?: number;
  width?: number;
  height?: number;
  color?: string;
}) {
  const rawValues = useFrequencyBars(stream, Math.ceil(bars / 2));

  // Mirror the values symmetrically so the highest-energy bars (low-frequency,
  // index 0) appear at the center and radiate outward — center-out effect.
  const half = rawValues;
  const mirrored: number[] = bars % 2 === 0
    ? [...half.slice().reverse(), ...half]
    : [...half.slice().reverse(), ...half.slice(1)];

  const gap = 3;
  const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);

  return (
    <div
      className="flex items-center justify-center"
      style={{ width, height, gap }}
      aria-hidden="true"
    >
      {mirrored.map((v, i) => (
        <div
          key={i}
          className="rounded-sm transition-all"
          style={{
            width: barWidth,
            height: Math.max(3, v * height),
            background: color ?? 'currentColor',
            transitionDuration: '90ms',
          }}
        />
      ))}
    </div>
  );
}
