// FAMILISTA VISION — the source vocabulary, and what is honestly behind each word
// ─────────────────────────────────────────────────────────────────────────────
// Fourteen source types are NAMED here and one is IMPLEMENTED. That ratio is
// the point of the file.
//
// A source type in this list is a slot in an architecture, not a promise that
// something works. `VIDEO_FILE` is implemented and validated across three real
// clips. `RTSP` is a word. `BALL_SENSOR` is a word. The `implemented` flag is
// what the UI reads, and an unimplemented type renders NOT IMPLEMENTED — never
// a greyed-out control that looks like it might work if you had the hardware.
//
// WHY THE LIST EXISTS AT ALL IF MOST OF IT IS UNBUILT
//
// Because the alternative is discovering, on the day a Sony ZV-E10 arrives,
// that the session model assumed one source and the calibration assumed one
// viewpoint. The names cost nothing now and the shape they impose — every
// source has an id, a type, a manufacturer that is METADATA rather than a code
// path, and a connection state — is what keeps the engine camera-agnostic.
//
// MANUFACTURER IS METADATA. THIS IS LOad-BEARING.
//
// Nothing in the Vision engine branches on camera brand. A Sony is a video
// source with Sony written on its label. The day that stops being true is the
// day Familista Vision becomes a Sony product, and it must never be one.

export type VisionSourceType =
  | 'VIDEO_FILE' | 'USB_CAMERA' | 'UVC_CAMERA' | 'IP_CAMERA' | 'RTSP' | 'ONVIF'
  | 'HDMI_CAPTURE' | 'SONY_CAMERA' | 'DRONE' | 'MULTI_CAMERA'
  | 'FIELD_NODE' | 'PLAYER_POD' | 'BALL_SENSOR';

export interface VisionSourceTypeSpec {
  type: VisionSourceType;
  label: string;
  /** Is there code behind this, today, that has processed real footage? */
  implemented: boolean;
  /** What a reader is waiting for, when they are waiting for something. */
  waitingOn: 'NOTHING' | 'FUTURE_CAMERA' | 'FUTURE_HARDWARE' | 'VALIDATION';
  describes: string;
}

export const SOURCE_TYPES: readonly VisionSourceTypeSpec[] = Object.freeze([
  {
    type: 'VIDEO_FILE', label: 'Video file', implemented: true, waitingOn: 'NOTHING',
    describes: 'A recorded clip. The only source type the validated engine has '
      + 'processed, across three real broadcast clips.',
  },
  {
    type: 'USB_CAMERA', label: 'USB camera', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'A camera attached to the host. No adapter is written.',
  },
  {
    type: 'UVC_CAMERA', label: 'UVC camera', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'A USB Video Class device. No adapter is written.',
  },
  {
    type: 'IP_CAMERA', label: 'IP camera', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'A networked camera. No adapter is written.',
  },
  {
    type: 'RTSP', label: 'RTSP stream', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'A live stream pulled over RTSP. No adapter is written.',
  },
  {
    type: 'ONVIF', label: 'ONVIF device', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'Discovery and control over ONVIF. No adapter is written.',
  },
  {
    type: 'HDMI_CAPTURE', label: 'HDMI capture', implemented: false, waitingOn: 'FUTURE_HARDWARE',
    describes: 'A capture card taking a camera’s HDMI out. Belongs to the Vision Hub.',
  },
  {
    type: 'SONY_CAMERA', label: 'Sony camera', implemented: false, waitingOn: 'FUTURE_CAMERA',
    describes: 'A Sony body, addressed as a video source with a manufacturer label. '
      + 'The engine has no Sony-specific code path and must never acquire one.',
  },
  {
    type: 'DRONE', label: 'Drone', implemented: false, waitingOn: 'FUTURE_HARDWARE',
    describes: 'An aerial source. Calibration from a moving aerial viewpoint is '
      + 'not validated.',
  },
  {
    type: 'MULTI_CAMERA', label: 'Multi-camera rig', implemented: false, waitingOn: 'VALIDATION',
    describes: 'Several synchronised viewpoints fused into one reconstruction. The '
      + 'architecture admits it; no fusion implementation is validated.',
  },
  {
    type: 'FIELD_NODE', label: 'Field node', implemented: false, waitingOn: 'FUTURE_HARDWARE',
    describes: 'Pitch-side environmental and positioning hardware. Does not exist.',
  },
  {
    type: 'PLAYER_POD', label: 'Player pod', implemented: false, waitingOn: 'FUTURE_HARDWARE',
    describes: 'Wearable IMU, ECG and GPS. Does not exist.',
  },
  {
    type: 'BALL_SENSOR', label: 'Ball sensor', implemented: false, waitingOn: 'FUTURE_HARDWARE',
    describes: 'Instrumented ball reporting impact, spin and speed. Does not exist.',
  },
]);

/** The rig slots a future pitch installation will fill, named now, empty now. */
export interface VisionSourceSlot {
  slot: string;
  label: string;
  intendedType: VisionSourceType;
  filled: boolean;
  waitingOn: VisionSourceTypeSpec['waitingOn'];
}

export const SOURCE_SLOTS: readonly VisionSourceSlot[] = Object.freeze([
  { slot: 'main', label: 'Main camera', intendedType: 'SONY_CAMERA', filled: false, waitingOn: 'FUTURE_CAMERA' },
  { slot: 'corner-1', label: 'Corner camera 1', intendedType: 'IP_CAMERA', filled: false, waitingOn: 'FUTURE_CAMERA' },
  { slot: 'corner-2', label: 'Corner camera 2', intendedType: 'IP_CAMERA', filled: false, waitingOn: 'FUTURE_CAMERA' },
  { slot: 'corner-3', label: 'Corner camera 3', intendedType: 'IP_CAMERA', filled: false, waitingOn: 'FUTURE_CAMERA' },
  { slot: 'corner-4', label: 'Corner camera 4', intendedType: 'IP_CAMERA', filled: false, waitingOn: 'FUTURE_CAMERA' },
  { slot: 'drone', label: 'Drone', intendedType: 'DRONE', filled: false, waitingOn: 'FUTURE_HARDWARE' },
  { slot: 'field-nodes', label: 'Field nodes', intendedType: 'FIELD_NODE', filled: false, waitingOn: 'FUTURE_HARDWARE' },
  { slot: 'player-pods', label: 'Player pods', intendedType: 'PLAYER_POD', filled: false, waitingOn: 'FUTURE_HARDWARE' },
  { slot: 'ball-sensor', label: 'Ball sensor', intendedType: 'BALL_SENSOR', filled: false, waitingOn: 'FUTURE_HARDWARE' },
]);

export function sourceTypeSpec(type: string): VisionSourceTypeSpec | null {
  return SOURCE_TYPES.find((s) => s.type === type) ?? null;
}
