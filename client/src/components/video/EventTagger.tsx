// Familista — EventTagger component (Phase S.1)
// Timestamp-based event markers on a video clip.
// Lists existing annotations and lets coaches add new ones.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { videoApi } from '@/api/endpoints';
import type { VideoAnnotation } from '@/api/types';
import styles from './EventTagger.module.css';

interface Props {
  clipId:         string;
  currentTimeSec: number;
  onSeek?:        (timeSec: number) => void;
}

const EVENT_LABELS = [
  'Goal', 'Shot', 'Assist', 'Key Pass',
  'Dribble', 'Tackle', 'Interception',
  'Yellow Card', 'Red Card',
  'Offside', 'Corner', 'Free Kick',
  'Foul', 'Header', 'Save',
];

function fmtTime(secs: number): string {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function EventTagger({ clipId, currentTimeSec, onSeek }: Props) {
  const qc = useQueryClient();

  const { data: annotations = [], isLoading } = useQuery({
    queryKey:  ['clip-annotations', clipId],
    queryFn:   () => videoApi.listAnnotations(clipId),
    enabled:   !!clipId,
  });

  const { mutate: createAnnotation, isPending: isCreating } = useMutation({
    mutationFn: videoApi.createAnnotation,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['clip-annotations', clipId] });
      setLabel('Goal');
      setNotes('');
    },
  });

  const { mutate: deleteAnnotation } = useMutation({
    mutationFn: videoApi.deleteAnnotation,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['clip-annotations', clipId] }),
  });

  const [label,  setLabel]  = useState('Goal');
  const [notes,  setNotes]  = useState('');

  const handleTag = () => {
    createAnnotation({
      clipId,
      timestampSec: Math.round(currentTimeSec),
      label:        label,
      shape:        'text',   // default shape for event tags
      x:            0.5,
      y:            0.5,
      color:        '#16a34a',
      thickness:    2,
    });
  };

  const sortedAnnotations = [...annotations].sort(
    (a, b) => a.timestampSec - b.timestampSec,
  );

  return (
    <div className={styles.wrap}>
      {/* Add event */}
      <div className={styles.addPanel}>
        <h4 className={styles.heading}>Tag Event at {fmtTime(currentTimeSec)}</h4>

        <div className={styles.row}>
          <select
            className={styles.select}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          >
            {EVENT_LABELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          <button
            className={styles.tagBtn}
            onClick={handleTag}
            disabled={isCreating}
          >
            {isCreating ? '…' : '+ Tag'}
          </button>
        </div>

        <input
          className={styles.input}
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={200}
        />
      </div>

      {/* Event list */}
      <div className={styles.list}>
        {isLoading && <p className={styles.empty}>Loading…</p>}
        {!isLoading && sortedAnnotations.length === 0 && (
          <p className={styles.empty}>No events tagged yet.</p>
        )}
        {sortedAnnotations.map((ann: VideoAnnotation) => (
          <div key={ann.id} className={styles.item}>
            <button
              className={styles.timeBtn}
              onClick={() => onSeek?.(ann.timestampSec)}
              title="Jump to this moment"
            >
              {fmtTime(ann.timestampSec)}
            </button>
            <span className={styles.eventLabel}>{ann.label ?? 'Event'}</span>
            <button
              className={styles.delBtn}
              onClick={() => deleteAnnotation(ann.id)}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
