import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];

type Mode = 'fit' | 'zoom';

export function VideoViewer({ stream, overlay, overlayTone = 'info' }: { stream: MediaStream | null; overlay?: ReactNode; overlayTone?: 'info' | 'warning' }) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<Mode>('fit');
  const [zoom, setZoom] = useState(1);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const centerRef = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const updateDims = () => {
    const v = videoRef.current;
    if (v && v.videoWidth > 0) setDims({ w: v.videoWidth, h: v.videoHeight });
  };

  const fitScale = dims.w > 0 && box.w > 0 ? Math.min(box.w / dims.w, box.h / dims.h) : 1;
  const scale = mode === 'fit' ? fitScale : zoom;

  const rememberCenter = () => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth === 0) return;
    centerRef.current = {
      x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
      y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
    };
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const c = centerRef.current;
    if (!el || !c || mode !== 'zoom') return;
    el.scrollLeft = c.x * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = c.y * el.scrollHeight - el.clientHeight / 2;
    centerRef.current = null;
  }, [zoom, mode]);

  const setZoomLevel = useCallback(
    (next: number) => {
      rememberCenter();
      setMode('zoom');
      setZoom(Math.min(4, Math.max(0.1, next)));
    },
    [],
  );

  const step = (dir: 1 | -1) => {
    const current = scale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > current + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001);
    setZoomLevel(next ?? current);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || dims.w === 0) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoomLevel((mode === 'fit' ? fitScale : zoom) * factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, zoom, fitScale, dims.w, setZoomLevel]);

  const toggleFullscreen = async () => {
    if (fullscreenAvailable && wrapRef.current) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      else await wrapRef.current.requestFullscreen().catch(() => setMaximized((m) => !m));
    } else {
      setMaximized((m) => !m);
    }
  };

  const zoomed = mode === 'zoom';
  const videoStyle = zoomed && dims.w > 0 ? { width: Math.round(dims.w * zoom), height: Math.round(dims.h * zoom) } : undefined;
  const canPan = zoomed && videoStyle && (videoStyle.width > box.w || videoStyle.height > box.h);

  return (
    <div ref={wrapRef} className={`viewer${maximized ? ' viewer--max' : ''}${fullscreen ? ' viewer--fs' : ''}`} data-testid="viewer">
      <div className="viewer__toolbar">
        <div className="btn-group">
          <button type="button" className={`btn btn--tool${mode === 'fit' ? ' is-active' : ''}`} onClick={() => setMode('fit')} disabled={!stream}>
            {t('viewer.fit')}
          </button>
          <button
            type="button"
            className={`btn btn--tool${zoomed && zoom === 1 ? ' is-active' : ''}`}
            onClick={() => setZoomLevel(1)}
            disabled={!stream}
          >
            {t('viewer.original')}
          </button>
        </div>
        <div className="btn-group">
          <button type="button" className="btn btn--tool" onClick={() => step(-1)} disabled={!stream} aria-label={t('viewer.zoomOut')} title={t('viewer.zoomOut')}>
            −
          </button>
          <span className="viewer__zoom" data-testid="zoom-level">
            {Math.round(scale * 100)}%
          </span>
          <button type="button" className="btn btn--tool" onClick={() => step(1)} disabled={!stream} aria-label={t('viewer.zoomIn')} title={t('viewer.zoomIn')}>
            +
          </button>
        </div>
        <span className="viewer__res">{dims.w > 0 && stream ? `${dims.w}×${dims.h}` : ''}</span>
        <button type="button" className="btn btn--tool" onClick={toggleFullscreen} disabled={!stream}>
          {fullscreen || maximized ? t('viewer.restore') : fullscreenAvailable ? t('viewer.fullscreen') : t('viewer.maximize')}
        </button>
      </div>
      <div
        ref={scrollRef}
        className={`viewer__stage${zoomed ? ' is-zoomed' : ''}${canPan ? ' can-pan' : ''}`}
        onPointerDown={(e) => {
          if (!canPan || !scrollRef.current) return;
          drag.current = { x: e.clientX, y: e.clientY, left: scrollRef.current.scrollLeft, top: scrollRef.current.scrollTop };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = scrollRef.current;
          if (!d || !el) return;
          el.scrollLeft = d.left - (e.clientX - d.x);
          el.scrollTop = d.top - (e.clientY - d.y);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        title={canPan ? t('viewer.panHint') : undefined}
      >
        <video
          ref={videoRef}
          className={`viewer__video${zoomed ? '' : ' is-fit'}${stream ? '' : ' is-hidden'}`}
          style={videoStyle}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={updateDims}
          onResize={updateDims}
          data-testid="remote-video"
        />
        {overlay && <div className={`viewer__overlay viewer__overlay--${overlayTone}${stream ? ' is-floating' : ''}`}>{overlay}</div>}
      </div>
    </div>
  );
}
