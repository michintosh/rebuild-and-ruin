/**
 * Opt-in peer-to-peer webcam tiles, drawn over each seated human's home castle.
 *
 * Video never touches the game server or the sim: the server only relays small
 * WebRTC signalling envelopes (`MESSAGE.RTC_SIGNAL`) between seats. One
 * RTCPeerConnection per remote human, created by the LOWER seat (so offers can
 * never collide). Each connection owns a permanent sendrecv video transceiver,
 * so switching the camera on/off is a `replaceTrack` — no renegotiation.
 * Tiles are DOM elements positioned from the camera's world→screen projection
 * every frame; the camera and this overlay never feed back into the sim.
 */

import {
  type ClientMessage,
  MESSAGE,
  type RtcSignalData,
  type ServerMessage,
} from "../protocol/protocol.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";

export interface WebcamDeps {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWidth: number;
  readonly send: (msg: ClientMessage) => void;
  /** True while this client is in a room that allows webcams. */
  readonly isEnabled: () => boolean;
  /** This client's seat, or null for a spectator. */
  readonly myPlayerId: () => ValidPlayerId | null;
  /** Seats held by other humans (never AI seats). */
  readonly remoteHumans: () => ReadonlySet<ValidPlayerId>;
  /** World-pixel centre of the seat's home castle tower, or null if none. */
  readonly castleCenter: (
    playerId: ValidPlayerId,
  ) => { wx: number; wy: number } | null;
  readonly worldToScreen: (
    wx: number,
    wy: number,
  ) => { sx: number; sy: number };
  readonly towerPx: number;
  readonly playerColor: (playerId: ValidPlayerId) => string;
}

export interface Webcam {
  readonly onMessage: (msg: ServerMessage) => void;
}

interface Peer {
  readonly pc: RTCPeerConnection;
  readonly pendingIce: RTCIceCandidateInit[];
  /** The video transceiver's sender; null until the answerer's transceiver
   *  exists (it is created by `setRemoteDescription`, not by us). */
  sender: RTCRtpSender | null;
  stream: MediaStream | null;
  camOn: boolean;
}

interface Tile {
  readonly root: HTMLDivElement;
  readonly video: HTMLVideoElement;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const SYNC_INTERVAL_MS = 1000;
const CAMERA_PX = 160;
const CAMERA_FPS = 15;
const TILE_MIN_PX = 44;
const TILE_MAX_PX = 84;
const TILE_WIDTH_RATIO = 0.07;
const TILE_GAP_PX = 6;
const BUTTON_ON_LABEL = "Camera: on";
const BUTTON_OFF_LABEL = "Camera: off";

export function createWebcam(deps: WebcamDeps): Webcam {
  const peers = new Map<ValidPlayerId, Peer>();
  const tiles = new Map<ValidPlayerId, Tile>();
  let localStream: MediaStream | null = null;
  let frameHandle = 0;

  const layer = document.createElement("div");
  layer.className = "webcam-layer";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "webcam-toggle";
  button.textContent = BUTTON_OFF_LABEL;
  button.hidden = true;
  document.body.append(layer, button);

  button.addEventListener("click", () => {
    if (localStream) stopCamera();
    else void startCamera();
  });
  setInterval(sync, SYNC_INTERVAL_MS);

  function onMessage(msg: ServerMessage): void {
    if (msg.type !== MESSAGE.RTC_SIGNAL) return;
    if (!deps.isEnabled() || !deps.remoteHumans().has(msg.from)) return;
    void handleSignal(msg.from, msg.data);
  }

  async function handleSignal(
    from: ValidPlayerId,
    data: RtcSignalData,
  ): Promise<void> {
    try {
      if (data.kind === "offer") {
        // Only the lower seat offers; a fresh offer means it (re)connected.
        closePeer(from);
        const peer = openPeer(from, false);
        await peer.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        // The offer created the transceiver; make it send as well as receive.
        const transceiver = peer.pc.getTransceivers()[0];
        if (!transceiver) return;
        transceiver.direction = "sendrecv";
        peer.sender = transceiver.sender;
        publishTo(peer);
        await flushIce(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sendSignal(from, {
          kind: "answer",
          sdp: peer.pc.localDescription?.sdp ?? "",
        });
        return;
      }
      const peer = peers.get(from);
      if (!peer) return;
      if (data.kind === "answer") {
        if (peer.pc.signalingState !== "have-local-offer") return;
        await peer.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await flushIce(peer);
      } else if (data.kind === "ice") {
        const candidate: RTCIceCandidateInit = {
          candidate: data.candidate,
          sdpMid: data.sdpMid,
          sdpMLineIndex: data.sdpMLineIndex,
        };
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
        else peer.pendingIce.push(candidate);
      } else {
        peer.camOn = data.on;
      }
    } catch (err) {
      console.warn("[webcam] signalling failed:", err);
    }
  }

  async function flushIce(peer: Peer): Promise<void> {
    for (const candidate of peer.pendingIce.splice(0)) {
      await peer.pc.addIceCandidate(candidate);
    }
  }

  /** `offerer` peers add the transceiver themselves; answerers get theirs
   *  from the incoming offer. */
  function openPeer(remote: ValidPlayerId, offerer: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = {
      pc,
      pendingIce: [],
      sender: offerer
        ? pc.addTransceiver("video", { direction: "sendrecv" }).sender
        : null,
      stream: null,
      camOn: false,
    };
    publishTo(peer);
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      sendSignal(remote, {
        kind: "ice",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    };
    pc.ontrack = (event) => {
      peer.stream = event.streams[0] ?? new MediaStream([event.track]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        sendSignal(remote, { kind: "cam", on: localStream !== null });
      }
    };
    peers.set(remote, peer);
    return peer;
  }

  /** Point the peer's sender at the live camera track (or at nothing). */
  function publishTo(peer: Peer): void {
    const track = localStream?.getVideoTracks()[0] ?? null;
    void peer.sender?.replaceTrack(track);
  }

  async function offerTo(remote: ValidPlayerId): Promise<void> {
    closePeer(remote);
    const peer = openPeer(remote, true);
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      sendSignal(remote, {
        kind: "offer",
        sdp: peer.pc.localDescription?.sdp ?? "",
      });
    } catch (err) {
      console.warn("[webcam] offer failed:", err);
      closePeer(remote);
    }
  }

  function closePeer(remote: ValidPlayerId): void {
    const peer = peers.get(remote);
    if (!peer) return;
    peers.delete(remote);
    peer.pc.close();
  }

  function sendSignal(to: ValidPlayerId, data: RtcSignalData): void {
    deps.send({ type: MESSAGE.RTC_SIGNAL, to, data });
  }

  async function startCamera(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: CAMERA_PX },
          height: { ideal: CAMERA_PX },
          frameRate: { ideal: CAMERA_FPS },
        },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      localStream = stream;
      track.onended = stopCamera;
      for (const [remote, peer] of peers) {
        publishTo(peer);
        sendSignal(remote, { kind: "cam", on: true });
      }
      button.textContent = BUTTON_ON_LABEL;
    } catch (err) {
      console.warn("[webcam] camera unavailable:", err);
      button.title = "Camera unavailable or permission denied";
    }
  }

  function stopCamera(): void {
    if (!localStream) return;
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
    for (const [remote, peer] of peers) {
      publishTo(peer);
      sendSignal(remote, { kind: "cam", on: false });
    }
    button.textContent = BUTTON_OFF_LABEL;
  }

  /** Reconcile connections with the room: offer to every higher remote seat
   *  that has no live connection, drop connections for seats that left, and
   *  tear everything down when the room no longer allows webcams. */
  function sync(): void {
    const myId = deps.myPlayerId();
    const active = deps.isEnabled() && myId !== null;
    button.hidden = !active;
    if (!active) {
      stopCamera();
      for (const remote of [...peers.keys()]) closePeer(remote);
      stopFrameLoop();
      removeAllTiles();
      return;
    }
    const remotes = deps.remoteHumans();
    for (const remote of [...peers.keys()]) {
      if (!remotes.has(remote)) closePeer(remote);
    }
    for (const remote of remotes) {
      if (remote <= myId) continue;
      const state = peers.get(remote)?.pc.connectionState;
      if (state === undefined || state === "failed" || state === "closed") {
        void offerTo(remote);
      }
    }
    startFrameLoop();
  }

  function startFrameLoop(): void {
    if (frameHandle === 0) frameHandle = requestAnimationFrame(frame);
  }

  function stopFrameLoop(): void {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }

  function frame(): void {
    frameHandle = requestAnimationFrame(frame);
    const myId = deps.myPlayerId();
    const rect = deps.canvas.getBoundingClientRect();
    const cssPerPx = rect.width / deps.canvasWidth;
    const size = Math.min(
      TILE_MAX_PX,
      Math.max(TILE_MIN_PX, rect.width * TILE_WIDTH_RATIO),
    );
    const live = new Set<ValidPlayerId>();
    if (myId !== null && localStream) {
      placeTile(myId, localStream, true, rect, cssPerPx, size, live);
    }
    for (const [remote, peer] of peers) {
      if (peer.camOn && peer.stream) {
        placeTile(remote, peer.stream, false, rect, cssPerPx, size, live);
      }
    }
    for (const playerId of [...tiles.keys()]) {
      if (!live.has(playerId)) removeTile(playerId);
    }
  }

  function placeTile(
    playerId: ValidPlayerId,
    stream: MediaStream,
    mirrored: boolean,
    rect: DOMRect,
    cssPerPx: number,
    size: number,
    live: Set<ValidPlayerId>,
  ): void {
    const center = deps.castleCenter(playerId);
    if (!center) return;
    const above = deps.worldToScreen(center.wx, center.wy - deps.towerPx);
    const left = rect.left + above.sx * cssPerPx - size / 2;
    const top = rect.top + above.sy * cssPerPx - size - TILE_GAP_PX;
    const inView =
      left + size > rect.left &&
      left < rect.right &&
      top + size > rect.top &&
      top < rect.bottom;
    if (!inView) return;
    live.add(playerId);
    const tile = tiles.get(playerId) ?? createTile(playerId);
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.classList.toggle("webcam-mirrored", mirrored);
    tile.root.style.width = `${size}px`;
    tile.root.style.height = `${size}px`;
    tile.root.style.transform = `translate(${left}px, ${top}px)`;
  }

  function createTile(playerId: ValidPlayerId): Tile {
    const root = document.createElement("div");
    root.className = "webcam-tile";
    root.style.borderColor = deps.playerColor(playerId);
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    root.append(video);
    layer.append(root);
    const tile = { root, video };
    tiles.set(playerId, tile);
    return tile;
  }

  function removeTile(playerId: ValidPlayerId): void {
    tiles.get(playerId)?.root.remove();
    tiles.delete(playerId);
  }

  function removeAllTiles(): void {
    for (const playerId of [...tiles.keys()]) removeTile(playerId);
  }

  return { onMessage };
}
