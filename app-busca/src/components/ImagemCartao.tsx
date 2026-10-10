import { useEffect, useRef, useState } from 'react';
import { cardImageQueue } from '../lib/image-queue';

/** Load visible cards in pairs; temporary saturation retries instead of becoming a broken photo. */
export function ImagemCartao({ src, fallback, alt, className }: {
  src: string; fallback: string; alt: string; className?: string;
}) {
  const image = useRef<HTMLImageElement>(null);
  const release = useRef<(() => void) | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [allowed, setAllowed] = useState('');
  const [failed, setFailed] = useState(false);
  const key = `${src}\n${attempt}`;
  useEffect(() => {
    if (!image.current) return;
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(image.current);
    return () => observer.disconnect();
  }, [src]);
  useEffect(() => {
    if (!visible || src === fallback) return;
    return cardImageQueue.enqueue(done => { release.current = done; setAllowed(key); });
  }, [visible, key, src, fallback]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function finish() { release.current?.(); release.current = undefined; }
  function retry() {
    finish();
    if (failed || timer.current) return;
    if (attempt >= 3) { setFailed(true); return; }
    timer.current = setTimeout(() => { timer.current = undefined; setAttempt(value => value + 1); }, [500, 1500, 3000][attempt]);
  }
  return <img ref={image} key={key} src={failed || src === fallback ? fallback : allowed === key ? src : undefined}
    alt={alt} className={failed ? 'is-nopic' : className} data-fallback={failed || src === fallback ? 'yes' : undefined}
    decoding="async" onLoad={finish} onError={retry} />;
}
