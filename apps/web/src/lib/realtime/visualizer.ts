'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Returns a number in [0, 1] proportional to RMS audio level on the supplied stream.
 * Updates ~30 times per second via requestAnimationFrame. Cleans up on unmount.
 */
export function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }

    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length) / 255; // 0..1
      setLevel(Math.min(1, rms * 1.6));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
    };
  }, [stream]);

  return level;
}

/**
 * Returns N normalized [0..1] frequency-bin heights sampled from the stream's
 * audio at ~30fps. Use to drive a bar-style waveform visualization. Returns
 * a flat low-amplitude array when no stream is connected so consumers can
 * always render a stable number of bars.
 */
export function useFrequencyBars(stream: MediaStream | null, bars = 12): number[] {
  const [values, setValues] = useState<number[]>(() => Array(bars).fill(0.05));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setValues(Array(bars).fill(0.05));
      return;
    }

    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    // Voice energy concentrates in the lower bins; sample from the bottom 60%
    // of the spectrum to keep the bars visually responsive to speech.
    const usableBins = Math.floor(analyser.frequencyBinCount * 0.6);
    const binsPerBar = Math.max(1, Math.floor(usableBins / bars));

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const next = new Array<number>(bars);
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        const start = i * binsPerBar;
        const end = Math.min(start + binsPerBar, usableBins);
        for (let j = start; j < end; j++) sum += data[j];
        const avg = sum / Math.max(1, end - start) / 255;
        next[i] = Math.max(0.05, Math.min(1, avg * 1.4));
      }
      setValues(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
    };
  }, [stream, bars]);

  return values;
}
