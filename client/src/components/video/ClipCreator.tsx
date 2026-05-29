// Familista — ClipCreator component (Phase S.1)
// Inline clip creation tool. Set in/out points, give the clip a title,
// submit to create a VideoClip record.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { videoApi } from '@/api/endpoints';
import styles from './ClipCreator.module.css';

interface Props {
  assetId:       string;
  currentTimeSec: number;
  durationSec:    number;
}

function fmtTime(secs: number): string {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function ClipCreator({ assetId, currentTimeSec, durationSec }: Props) {
  const qc = useQueryClient();

  const [startSec,    setStartSec]    = useState<number | null>(null);
  const [endSec,      setEndSec]      = useState<number | null>(null);
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [error,       setError]       = useState('');

  const { mutate: createClip, isPending } = useMutation({
    mutationFn: videoApi.createClip,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['video-clips', assetId] });
      setStartSec(null);
      setEndSec(null);
      setTitle('');
      setDescription('');
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    if (startSec === null || endSec === null) {
      setError('Set both start and end points first.'); return;
    }
    if (endSec <= startSec) {
      setError('End must be after start.'); return;
    }
    if (!title.trim()) {
      setError('Clip title is required.'); return;
    }
    setError('');
    createClip({
      assetId,
      title: title.trim(),
      description: description.trim() || undefined,
      startSec,
      endSec,
    });
  };

  const progressPct  = durationSec > 0 ? (currentTimeSec / durationSec) * 100 : 0;
  const startPct     = durationSec > 0 && startSec !== null ? (startSec / durationSec) * 100 : null;
  const endPct       = durationSec > 0 && endSec   !== null ? (endSec   / durationSec) * 100 : null;

  return (
    <div className={styles.wrap}>
      <h4 className={styles.heading}>Create Clip</h4>

      {/* Mini timeline */}
      <div className={styles.timeline} title="Clip selection range">
        {/* Playhead */}
        <div className={styles.playhead} style={{ left: `${progressPct}%` }} />
        {/* Selected range */}
        {startPct !== null && endPct !== null && (
          <div
            className={styles.range}
            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          />
        )}
        {startPct !== null && (
          <div className={`${styles.marker} ${styles.markerStart}`} style={{ left: `${startPct}%` }} />
        )}
        {endPct !== null && (
          <div className={`${styles.marker} ${styles.markerEnd}`} style={{ left: `${endPct}%` }} />
        )}
      </div>

      {/* In/Out controls */}
      <div className={styles.inOut}>
        <div className={styles.point}>
          <span className={styles.pointLabel}>IN</span>
          <span className={styles.pointTime}>
            {startSec !== null ? fmtTime(startSec) : '--:--'}
          </span>
          <button
            className={styles.setBtn}
            onClick={() => setStartSec(Math.floor(currentTimeSec))}
            title="Set start to current playhead"
          >
            Set
          </button>
        </div>

        <div className={styles.point}>
          <span className={styles.pointLabel}>OUT</span>
          <span className={styles.pointTime}>
            {endSec !== null ? fmtTime(endSec) : '--:--'}
          </span>
          <button
            className={styles.setBtn}
            onClick={() => setEndSec(Math.floor(currentTimeSec))}
            title="Set end to current playhead"
          >
            Set
          </button>
        </div>

        {startSec !== null && endSec !== null && endSec > startSec && (
          <div className={styles.duration}>
            {fmtTime(endSec - startSec)} clip
          </div>
        )}
      </div>

      {/* Metadata */}
      <input
        className={styles.input}
        type="text"
        placeholder="Clip title *"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={120}
      />
      <textarea
        className={styles.textarea}
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        maxLength={500}
      />

      {error && <p className={styles.error}>{error}</p>}

      <button
        className={styles.submitBtn}
        onClick={handleSubmit}
        disabled={isPending}
      >
        {isPending ? 'Saving…' : '+ Save Clip'}
      </button>
    </div>
  );
}
