// Familista — VideoPlayer component (Phase S.1)
// HLS.js-backed video player with custom controls.
// Passes currentTime up via onTimeUpdate so ClipCreator / EventTagger
// can read the playhead position.

import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import styles from './VideoPlayer.module.css';

export interface VideoPlayerProps {
  assetId:      string;
  hlsUrl:       string;
  thumbUrl?:    string;
  onTimeUpdate?: (currentTimeSec: number, durationSec: number) => void;
}

function fmtTime(secs: number): string {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function VideoPlayer({ assetId, hlsUrl, thumbUrl, onTimeUpdate }: VideoPlayerProps) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const hlsRef     = useRef<Hls | null>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [volume,      setVolume]      = useState(1);
  const [muted,       setMuted]       = useState(false);
  const [buffered,    setBuffered]    = useState(0);
  const [hlsError,    setHlsError]    = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── HLS setup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hlsUrl) return;

    setHlsError(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    // Tear down any previous hls instance.
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const token = localStorage.getItem('familista_token') ?? '';
      const hls = new Hls({
        enableWorker: true,
        // Attach Authorization header to every XHR (manifest + segments)
        xhrSetup: (xhr: XMLHttpRequest) => {
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        },
      });
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setHlsError(`Stream error: ${data.type} — ${data.details}`);
          hls.destroy();
          hlsRef.current = null;
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS — works without auth headers for CDN URLs
      video.src = hlsUrl;
    } else {
      setHlsError('HLS playback is not supported in this browser.');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [hlsUrl, assetId]);

  // ── Video element event handlers ──────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    onTimeUpdate?.(v.currentTime, v.duration || 0);

    // Update buffered position.
    if (v.buffered.length > 0) {
      setBuffered((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
    }
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
  }, []);

  const handleEnded = useCallback(() => setPlaying(false), []);

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPlaying(true); }
    else          { v.pause();                setPlaying(false); }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = Number(e.target.value);
    v.currentTime = t;
    setCurrentTime(t);
  };

  const changeVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Number(e.target.value);
    v.volume = vol;
    setVolume(vol);
    setMuted(vol === 0);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const skip = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
  };

  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!document.fullscreenElement) {
      wrap.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (hlsError) {
    return (
      <div className={styles.error}>
        <span className={styles.errorIcon}>⚠</span>
        <p>{hlsError}</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {/* Video element */}
      <video
        ref={videoRef}
        className={styles.video}
        poster={thumbUrl}
        playsInline
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      {/* Controls overlay */}
      <div className={styles.controls}>
        {/* Progress bar */}
        <div className={styles.progressWrap}>
          <div className={styles.bufferedBar} style={{ width: `${buffered}%` }} />
          <div className={styles.progressBar} style={{ width: `${progressPct}%` }} />
          <input
            type="range"
            className={styles.seekInput}
            min={0}
            max={duration || 100}
            step={0.5}
            value={currentTime}
            onChange={seek}
            aria-label="Seek"
          />
        </div>

        {/* Bottom row */}
        <div className={styles.bottomRow}>
          <div className={styles.leftControls}>
            {/* Skip back */}
            <button className={styles.btn} onClick={() => skip(-10)} title="Back 10s">
              ⏪
            </button>
            {/* Play/Pause */}
            <button className={styles.btnPlay} onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
              {playing ? '⏸' : '▶'}
            </button>
            {/* Skip forward */}
            <button className={styles.btn} onClick={() => skip(10)} title="Forward 10s">
              ⏩
            </button>

            {/* Time */}
            <span className={styles.time}>
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
          </div>

          <div className={styles.rightControls}>
            {/* Mute */}
            <button className={styles.btn} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            {/* Volume */}
            <input
              type="range"
              className={styles.volumeInput}
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={changeVolume}
              aria-label="Volume"
            />
            {/* Fullscreen */}
            <button className={styles.btn} onClick={toggleFullscreen} title="Fullscreen">
              {isFullscreen ? '⛶' : '⛶'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
