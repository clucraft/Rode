import { useEffect, useState } from 'react';

/*
 * Screen Wake Lock on the Watch screen so the phone does not sleep while
 * someone is actually standing watch. Re-acquired when the tab becomes
 * visible again (the lock is released on visibility change by the browser).
 */

export function useWakeLock(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) {
      setHeld(false);
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          await lock.release();
          return;
        }
        setHeld(true);
        lock.addEventListener('release', () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
      setHeld(false);
    };
  }, [enabled]);
  return held;
}
