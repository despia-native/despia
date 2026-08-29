//
//  webm.ts - a minimal WebM (Matroska) writer for the film PREVIEW tier.
//
//  WHY THIS EXISTS. The pinned Chromium encodes VP9 through WebCodecs but ships no muxer a
//  page can reach, and this package carries no external dependencies - so the container is
//  written here, by hand. It is deliberately the SMALLEST correct WebM: one video track,
//  known-size EBML elements (no streaming/unknown-size), a cluster per keyframe, SimpleBlocks
//  with cluster-relative timecodes. Every mainstream player and every browser reads this.
//
//  The MASTER tier (H.264/AAC for store slots) is FFmpeg's job behind the same encoder
//  interface - see film-render.ts - because the store formats need codecs the open-source
//  browser does not carry (12-marketing-video.md, Annex A, measured).
//
//  Layout written:
//    EBML(version/read-version/doctype webm)
//    Segment
//      Info(TimecodeScale 1e6, Duration, MuxingApp, WritingApp)
//      Tracks(TrackEntry: number 1, uid 1, type video, codec V_VP9, Video{w,h})
//      Cluster(Timecode)* with SimpleBlock* - a new cluster at every keyframe
//

export type WebmFrame = {
  /** encoded VP9 payload (an EncodedVideoChunk's bytes) */
  data: Uint8Array;
  /** presentation time in MILLISECONDS (TimecodeScale is pinned to 1e6 ns = 1ms) */
  timecodeMs: number;
  key: boolean;
};

// ── EBML primitives ──────────────────────────────────────────────────────────────────

/** Element size as a VINT. 8-byte form always: correct everywhere, simplest to prove. */
function vintSize(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7; i >= 1; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

function element(id: number, payload: Uint8Array): Uint8Array {
  const idb = idBytes(id);
  const size = vintSize(payload.length);
  const out = new Uint8Array(idb.length + size.length + payload.length);
  out.set(idb, 0);
  out.set(size, idb.length);
  out.set(payload, idb.length + size.length);
  return out;
}

function uintPayload(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

function floatPayload(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return new Uint8Array(buf);
}

function stringPayload(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── element IDs (Matroska spec) ──────────────────────────────────────────────────────

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5,
  TrackType: 0x83, CodecID: 0x86, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
} as const;

// ── the writer ───────────────────────────────────────────────────────────────────────

function simpleBlock(frame: WebmFrame, clusterMs: number): Uint8Array {
  const rel = frame.timecodeMs - clusterMs;
  if (rel < -32768 || rel > 32767) {
    throw new Error(`webm: block timecode ${rel}ms exceeds the int16 cluster window`);
  }
  const head = new Uint8Array(4);
  head[0] = 0x81; // track 1 as a 1-byte VINT
  head[1] = (rel >> 8) & 0xff;
  head[2] = rel & 0xff;
  head[3] = frame.key ? 0x80 : 0x00;
  const payload = concat([head, frame.data]);
  return element(ID.SimpleBlock, payload);
}

export function muxWebm(
  frames: ReadonlyArray<WebmFrame>, width: number, height: number, durationMs: number,
): Uint8Array {
  if (frames.length === 0) throw new Error("webm: no frames");
  if (!frames[0]!.key) throw new Error("webm: the first frame must be a keyframe");

  const ebml = element(ID.EBML, concat([
    element(ID.EBMLVersion, uintPayload(1)),
    element(ID.EBMLReadVersion, uintPayload(1)),
    element(ID.EBMLMaxIDLength, uintPayload(4)),
    element(ID.EBMLMaxSizeLength, uintPayload(8)),
    element(ID.DocType, stringPayload("webm")),
    element(ID.DocTypeVersion, uintPayload(2)),
    element(ID.DocTypeReadVersion, uintPayload(2)),
  ]));

  const info = element(ID.Info, concat([
    element(ID.TimecodeScale, uintPayload(1_000_000)),
    element(ID.Duration, floatPayload(durationMs)),
    element(ID.MuxingApp, stringPayload("despia")),
    element(ID.WritingApp, stringPayload("despia film")),
  ]));

  const tracks = element(ID.Tracks, element(ID.TrackEntry, concat([
    element(ID.TrackNumber, uintPayload(1)),
    element(ID.TrackUID, uintPayload(1)),
    element(ID.TrackType, uintPayload(1)), // video
    element(ID.CodecID, stringPayload("V_VP9")),
    element(ID.Video, concat([
      element(ID.PixelWidth, uintPayload(width)),
      element(ID.PixelHeight, uintPayload(height)),
    ])),
  ])));

  const clusters: Uint8Array[] = [];
  let clusterMs = 0;
  let blocks: Uint8Array[] = [];
  const flush = (): void => {
    if (blocks.length === 0) return;
    clusters.push(element(ID.Cluster, concat([
      element(ID.Timecode, uintPayload(clusterMs)), ...blocks,
    ])));
    blocks = [];
  };
  for (const frame of frames) {
    if (frame.key && blocks.length > 0) {
      flush();
      clusterMs = frame.timecodeMs;
    }
    if (blocks.length === 0) clusterMs = frame.timecodeMs;
    blocks.push(simpleBlock(frame, clusterMs));
  }
  flush();

  const segment = element(ID.Segment, concat([info, tracks, ...clusters]));
  return concat([ebml, segment]);
}
