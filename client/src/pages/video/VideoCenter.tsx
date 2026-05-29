// Familista — Video Intelligence Center (Phase S.1)
// Full video library + HLS player + clip creation + event tagging.
//
// Layout:
//   Left  (320px) : asset list with status filter + upload button
//   Right (flex)  : selected asset view
//                    ├── VideoPlayer (HLS.js)
//                    └── Tabs: Info | Clips | Events

import { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { videoApi } from '@/api/endpoints';
import type { VideoAsset, VideoClip } from '@/api/types';
import { VideoPlayer }  from '@/components/video/VideoPlayer';
import { ClipCreator }  from '@/components/video/ClipCreator';
import { EventTagger }  from '@/components/video/EventTagger';
import styles from './VideoCenter.module.css';

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  PENDING:  'Pending',
  UPLOADED: 'Processing',
  READY:    'Ready',
  FAILED:   'Failed',
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'READY'    ? styles.badgeReady    :
    status === 'FAILED'   ? styles.badgeFailed   :
    status === 'UPLOADED' ? styles.badgeUploading :
    styles.badgePending;
  return <span className={`${styles.badge} ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function fmtDuration(secs: number | null): string {
  if (!secs) return '--';
  const m  = Math.floor(secs / 60);
  const s  = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Upload modal ─────────────────────────────────────────────────────────────

interface UploadState {
  file:     File;
  title:    string;
  kind:     string;
  progress: number;       // 0-100
  phase:    'idle' | 'uploading' | 'confirming' | 'done' | 'error';
  error?:   string;
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file,  setFile]  = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind,  setKind]  = useState('MATCH');
  const [state, setState] = useState<UploadState | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const start = async () => {
    if (!file || !title.trim()) return;
    const sizeMb = file.size / 1_048_576;

    setState({ file, title, kind, progress: 0, phase: 'uploading' });

    try {
      // 1. Request presigned upload URL.
      const { asset, uploadUrl } = await videoApi.requestUpload({
        title:       title.trim(),
        sourceKind:  kind,
        filename:    file.name,
        fileSizeMb:  Math.ceil(sizeMb),
      });

      // 2. PUT directly to S3.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setState((prev) => prev ? { ...prev, progress: Math.round((e.loaded / e.total) * 100) } : prev);
          }
        };
        xhr.onload  = () => (xhr.status < 400 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)));
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(file);
      });

      // 3. Confirm upload → triggers transcode job.
      setState((prev) => prev ? { ...prev, phase: 'confirming', progress: 100 } : prev);
      await videoApi.confirmUpload(asset.id);

      setState((prev) => prev ? { ...prev, phase: 'done' } : prev);
      setTimeout(() => { onDone(); onClose(); }, 1200);
    } catch (err) {
      setState((prev) => prev ? { ...prev, phase: 'error', error: (err as Error).message } : prev);
    }
  };

  const cancel = () => {
    xhrRef.current?.abort();
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={cancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>Upload Video</h3>
          <button className={styles.closeBtn} onClick={cancel}>×</button>
        </div>

        {!state && (
          <div className={styles.modalBody}>
            <label className={styles.fileLabel}>
              <input
                type="file"
                accept="video/*"
                className={styles.fileInput}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className={styles.fileName}>{file.name}</span>
              ) : (
                <span className={styles.filePlaceholder}>
                  ↑ Choose video file (.mp4, .mov, .avi, .mkv, .webm)
                </span>
              )}
            </label>

            <input
              className={styles.modalInput}
              type="text"
              placeholder="Title *"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <select
              className={styles.modalSelect}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="MATCH">Match</option>
              <option value="TRAINING">Training</option>
              <option value="HIGHLIGHTS">Highlights</option>
              <option value="SCOUTING">Scouting</option>
              <option value="OTHER">Other</option>
            </select>

            <button
              className={styles.uploadBtn}
              disabled={!file || !title.trim()}
              onClick={start}
            >
              Upload
            </button>
          </div>
        )}

        {state && (
          <div className={styles.modalBody}>
            {state.phase === 'uploading' && (
              <>
                <p className={styles.uploadMsg}>Uploading… {state.progress}%</p>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${state.progress}%` }} />
                </div>
              </>
            )}
            {state.phase === 'confirming' && <p className={styles.uploadMsg}>Queuing transcode…</p>}
            {state.phase === 'done' && (
              <p className={`${styles.uploadMsg} ${styles.uploadDone}`}>
                ✓ Upload complete — video is being processed
              </p>
            )}
            {state.phase === 'error' && (
              <p className={`${styles.uploadMsg} ${styles.uploadError}`}>{state.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const STATUS_FILTERS = ['ALL', 'READY', 'UPLOADED', 'PENDING', 'FAILED'];

export function VideoCenter() {
  const qc = useQueryClient();

  const [statusFilter,  setStatusFilter]  = useState('ALL');
  const [selectedAsset, setSelectedAsset] = useState<VideoAsset | null>(null);
  const [activeTab,     setActiveTab]     = useState<'info' | 'clips' | 'events'>('info');
  const [showUpload,    setShowUpload]    = useState(false);

  // Current playhead state (lifted from VideoPlayer).
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec,    setDurationSec]    = useState(0);

  // Selected clip (for event tagger).
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);

  const { data: assetsData, isLoading, refetch } = useQuery({
    queryKey:  ['video-assets', statusFilter],
    queryFn:   ({ signal }) =>
      videoApi.list(
        statusFilter === 'ALL' ? { limit: 50 } : { status: statusFilter, limit: 50 },
        signal,
      ),
    refetchInterval: 15_000,   // poll for status changes (UPLOADED → READY)
  });

  const { data: clipsData } = useQuery({
    queryKey: ['video-clips', selectedAsset?.id],
    queryFn:  () => videoApi.listClips(selectedAsset!.id),
    enabled:  !!selectedAsset && selectedAsset.status === 'READY',
  });

  const { mutate: deleteAsset } = useMutation({
    mutationFn: videoApi.delete,
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['video-assets'] });
      if (selectedAsset) setSelectedAsset(null);
    },
  });

  const handleTimeUpdate = useCallback((t: number, d: number) => {
    setCurrentTimeSec(t);
    setDurationSec(d);
  }, []);

  const assets = assetsData?.items ?? [];
  const clips  = clipsData?.items  ?? [];

  const hlsUrl = selectedAsset?.status === 'READY'
    ? videoApi.hlsUrl(selectedAsset.id)
    : null;

  const thumbUrl = selectedAsset?.thumbStorageKey && selectedAsset?.cdnBaseUrl
    ? `${selectedAsset.cdnBaseUrl}/${selectedAsset.thumbStorageKey}`
    : undefined;

  return (
    <div className={styles.page}>
      {/* ── Left panel: asset library ─────────────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2 className={styles.pageTitle}>Video Intelligence</h2>
          <button className={styles.uploadTrigger} onClick={() => setShowUpload(true)}>
            ↑ Upload
          </button>
        </div>

        {/* Status filter tabs */}
        <div className={styles.filterTabs}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              className={`${styles.filterTab} ${statusFilter === f ? styles.filterTabActive : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Asset list */}
        <div className={styles.assetList}>
          {isLoading && <div className={styles.loading}>Loading…</div>}
          {!isLoading && assets.length === 0 && (
            <div className={styles.empty}>
              <span>📽</span>
              <p>No videos found</p>
            </div>
          )}
          {assets.map((asset) => (
            <button
              key={asset.id}
              className={`${styles.assetItem} ${selectedAsset?.id === asset.id ? styles.assetSelected : ''}`}
              onClick={() => {
                setSelectedAsset(asset);
                setActiveTab('info');
                setSelectedClip(null);
              }}
            >
              {/* Thumbnail */}
              <div className={styles.thumb}>
                {asset.status === 'READY' ? (
                  <span className={styles.thumbPlay}>▶</span>
                ) : (
                  <span className={styles.thumbSpinner}>⟳</span>
                )}
              </div>

              <div className={styles.assetMeta}>
                <p className={styles.assetTitle}>{asset.title}</p>
                <div className={styles.assetDetails}>
                  <StatusBadge status={asset.status} />
                  <span className={styles.assetKind}>{asset.sourceKind}</span>
                  {asset.durationSec && (
                    <span className={styles.assetDuration}>{fmtDuration(asset.durationSec)}</span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Right panel: player + details ────────────────────────────────── */}
      <main className={styles.main}>
        {!selectedAsset ? (
          <div className={styles.noSelection}>
            <span className={styles.noSelectionIcon}>📹</span>
            <p>Select a video to play</p>
            <button className={styles.uploadTrigger2} onClick={() => setShowUpload(true)}>
              Upload your first video
            </button>
          </div>
        ) : (
          <>
            {/* Video player */}
            {hlsUrl ? (
              <VideoPlayer
                assetId={selectedAsset.id}
                hlsUrl={hlsUrl}
                thumbUrl={thumbUrl}
                onTimeUpdate={handleTimeUpdate}
              />
            ) : (
              <div className={styles.processingState}>
                {selectedAsset.status === 'FAILED' ? (
                  <>
                    <span className={styles.failIcon}>✗</span>
                    <p>Transcoding failed — upload a new version</p>
                  </>
                ) : (
                  <>
                    <span className={styles.spinnerLg}>⟳</span>
                    <p>Video is being processed…</p>
                    <p className={styles.processingHint}>
                      This usually takes 2–10 minutes depending on video length.
                    </p>
                    <button className={styles.refreshBtn} onClick={() => refetch()}>
                      Refresh
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Tabs */}
            <div className={styles.tabs}>
              {(['info', 'clips', 'events'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab === 'clips'  && clips.length > 0 && (
                    <span className={styles.tabCount}>{clips.length}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className={styles.tabContent}>
              {/* ── Info tab */}
              {activeTab === 'info' && (
                <div className={styles.infoGrid}>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Title</span>
                    <span className={styles.infoVal}>{selectedAsset.title}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Status</span>
                    <StatusBadge status={selectedAsset.status} />
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Source</span>
                    <span className={styles.infoVal}>{selectedAsset.sourceKind}</span>
                  </div>
                  {selectedAsset.durationSec && (
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Duration</span>
                      <span className={styles.infoVal}>{fmtDuration(selectedAsset.durationSec)}</span>
                    </div>
                  )}
                  {selectedAsset.widthPx && selectedAsset.heightPx && (
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Resolution</span>
                      <span className={styles.infoVal}>{selectedAsset.widthPx}×{selectedAsset.heightPx}</span>
                    </div>
                  )}
                  {selectedAsset.description && (
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Notes</span>
                      <span className={styles.infoVal}>{selectedAsset.description}</span>
                    </div>
                  )}
                  {selectedAsset.tags.length > 0 && (
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>Tags</span>
                      <span className={styles.infoVal}>{selectedAsset.tags.join(', ')}</span>
                    </div>
                  )}
                  <div className={`${styles.infoRow} ${styles.infoRowDanger}`}>
                    <span className={styles.infoLabel}>Actions</span>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => {
                        if (confirm(`Delete "${selectedAsset.title}"?`)) {
                          deleteAsset(selectedAsset.id);
                        }
                      }}
                    >
                      Delete video
                    </button>
                  </div>
                </div>
              )}

              {/* ── Clips tab */}
              {activeTab === 'clips' && (
                <div className={styles.clipsPanel}>
                  {selectedAsset.status === 'READY' && (
                    <ClipCreator
                      assetId={selectedAsset.id}
                      currentTimeSec={currentTimeSec}
                      durationSec={durationSec}
                    />
                  )}

                  <div className={styles.clipList}>
                    {clips.length === 0 && (
                      <p className={styles.clipEmpty}>
                        No clips yet. Use the clip creator above.
                      </p>
                    )}
                    {clips.map((clip: VideoClip) => (
                      <div
                        key={clip.id}
                        className={`${styles.clipCard} ${selectedClip?.id === clip.id ? styles.clipCardSelected : ''}`}
                        onClick={() => {
                          setSelectedClip(clip);
                          setActiveTab('events');
                        }}
                      >
                        <div className={styles.clipInfo}>
                          <span className={styles.clipTitle}>{clip.title ?? 'Untitled clip'}</span>
                          <span className={styles.clipTime}>
                            {fmtDuration(clip.startSec)} – {fmtDuration(clip.endSec)}
                            {' '}({fmtDuration(clip.endSec - clip.startSec)})
                          </span>
                        </div>
                        <span className={styles.clipArrow}>›</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Events tab */}
              {activeTab === 'events' && (
                <div className={styles.eventsPanel}>
                  {!selectedClip ? (
                    <div className={styles.noClip}>
                      <p>Select a clip from the Clips tab to tag events</p>
                      <button
                        className={styles.goClipsBtn}
                        onClick={() => setActiveTab('clips')}
                      >
                        Go to Clips
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.clipBanner}>
                        <span className={styles.clipBannerTitle}>
                          {selectedClip.title ?? 'Untitled clip'}
                        </span>
                        <button
                          className={styles.changeClipBtn}
                          onClick={() => setSelectedClip(null)}
                        >
                          Change clip
                        </button>
                      </div>
                      <EventTagger
                        clipId={selectedClip.id}
                        currentTimeSec={currentTimeSec}
                        onSeek={(t) => {
                          // Seek VideoPlayer via DOM (imperative — simplest approach)
                          const v = document.querySelector<HTMLVideoElement>('video');
                          if (v) { v.currentTime = t; }
                        }}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {/* Upload modal */}
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onDone={() => qc.invalidateQueries({ queryKey: ['video-assets'] })}
        />
      )}
    </div>
  );
}
