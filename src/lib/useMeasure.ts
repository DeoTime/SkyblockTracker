import { useEffect, useRef, useState } from 'react';

/**
 * Reports the live pixel width of an element. Charts render at real pixel size
 * rather than scaling a viewBox, so labels keep their intended type size and
 * pointer hit-testing maps 1:1 to data coordinates.
 */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));

    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
