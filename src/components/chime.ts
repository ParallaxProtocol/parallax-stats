// A short two-note chime for new blocks, synthesized with Web Audio so no
// sound file is needed. Browsers allow audio only after the viewer has
// interacted with the page: the audio context is unlocked by any click, tap
// or key press, and until then the chime stays silent and the sound button
// says so.

let context: AudioContext | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** unlockAudio starts audio from a user gesture; it resolves once audio runs, or not at all. */
export async function unlockAudio(): Promise<boolean> {
  try {
    if (!context) {
      context = new AudioContext();
      context.addEventListener("statechange", notify);
    }

    if (context.state !== "running") await context.resume();
  } catch {
    // No Web Audio, or not allowed from this event
  }

  notify();

  return context?.state === "running";
}

// Safari counts a tap as permission only once the finger lifts, so listen
// for the end of gestures as well, and keep listening until audio runs
const GESTURES = ["pointerup", "touchend", "click", "keydown"] as const;

function onGesture(): void {
  void unlockAudio().then((running) => {
    if (running) for (const event of GESTURES) window.removeEventListener(event, onGesture, true);
  });
}

if (typeof window !== "undefined") {
  for (const event of GESTURES) window.addEventListener(event, onGesture, true);
}

export function audioUnlocked(): boolean {
  return context?.state === "running";
}

export function subscribeAudio(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** play sounds soft tones, each a [frequency, start offset in seconds] pair, when audio is allowed. */
function play(tones: [number, number][], type: OscillatorType = "sine"): void {
  if (!context || context.state !== "running") return;

  const start = context.currentTime;

  for (const [frequency, offset] of tones) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    const at = start + offset;

    tone.type = type;
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    tone.connect(gain).connect(context.destination);
    tone.start(at);
    tone.stop(at + 0.55);
  }
}

/** chime plays the new-block sound: a rising C6 then G6. */
export function chime(): void {
  play([
    [1046.5, 0],
    [1568, 0.11],
  ]);
}

/**
 * reorgChime plays the reorganization sound: lower and falling, so it is
 * told apart from a new block without looking. A deep one adds a third,
 * lower note.
 */
export function reorgChime(deep: boolean): void {
  play(
    [
      [659.3, 0],
      [493.9, 0.16],
      ...(deep ? ([[392, 0.32]] as [number, number][]) : []),
    ],
    "triangle",
  );
}
