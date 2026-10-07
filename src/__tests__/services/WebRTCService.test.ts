import { IceCandidate } from '../../types';

// WebRTCService pulls ICE servers from a Cloud Function; keep tests offline.
jest.mock('../../config/webrtc', () => ({
  getRtcConfig: jest.fn().mockResolvedValue({ iceServers: [] }),
  DATA_CHANNEL_CONFIG: { ordered: true },
  COMMAND_CHANNEL_NAME: 'camera-commands',
}));

import { mediaDevices } from 'react-native-webrtc';
import { webRTCService } from '../../services/WebRTCService';

const candidate = (id: string): IceCandidate => ({
  candidate: `candidate:${id} 1 udp 2122260223 192.168.1.5 54321 typ host`,
  sdpMLineIndex: 0,
  sdpMid: '0',
});

const OFFER = { type: 'offer' as const, sdp: 'mock-offer-sdp' };

describe('WebRTCService', () => {
  afterEach(() => {
    webRTCService.close();
  });

  describe('addIceCandidate', () => {
    it('buffers candidates that arrive before the remote description', async () => {
      const pc: any = await webRTCService.createPeerConnection();

      await webRTCService.addIceCandidate(candidate('a'));
      await webRTCService.addIceCandidate(candidate('b'));

      expect(pc.addIceCandidate).not.toHaveBeenCalled();
    });

    it('applies buffered candidates once the remote description is set', async () => {
      const pc: any = await webRTCService.createPeerConnection();

      await webRTCService.addIceCandidate(candidate('a'));
      await webRTCService.addIceCandidate(candidate('b'));
      await webRTCService.setRemoteDescription(OFFER);

      expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
      const applied = pc.addIceCandidate.mock.calls.map((c: any[]) => c[0].candidate);
      expect(applied).toEqual([candidate('a').candidate, candidate('b').candidate]);
    });

    it('applies candidates immediately once the remote description exists', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      await webRTCService.setRemoteDescription(OFFER);

      await webRTCService.addIceCandidate(candidate('a'));

      expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);
    });

    it('buffers instead of throwing when no peer connection exists yet', async () => {
      await expect(webRTCService.addIceCandidate(candidate('a'))).resolves.toBeUndefined();
    });

    it('keeps applying candidates after one of them fails', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      pc.addIceCandidate
        .mockRejectedValueOnce(new Error('bad candidate'))
        .mockResolvedValue(undefined);

      await webRTCService.addIceCandidate(candidate('a'));
      await webRTCService.addIceCandidate(candidate('b'));
      await webRTCService.setRemoteDescription(OFFER);

      expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    });

    it('does not replay buffered candidates onto a new peer connection', async () => {
      await webRTCService.createPeerConnection();
      await webRTCService.addIceCandidate(candidate('a'));

      const pc: any = await webRTCService.createPeerConnection();
      await webRTCService.setRemoteDescription(OFFER);

      expect(pc.addIceCandidate).not.toHaveBeenCalled();
    });
  });

  // Recovering a pairing after the app was backgrounded (screen off) is an ICE
  // restart on the existing connection, plus a fresh capture track - Android
  // ends the old one while the app is away.
  describe('reconnection', () => {
    const streamWith = (readyState: 'live' | 'ended') => ({
      getTracks: () => [{ kind: 'video', readyState, stop: jest.fn() }],
      getVideoTracks: () => [{ kind: 'video', readyState, stop: jest.fn() }],
    });

    afterEach(() => {
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
        getTracks: () => [],
        getVideoTracks: () => [],
      });
    });

    it('does not restart ICE on an ordinary offer', async () => {
      const pc: any = await webRTCService.createPeerConnection();

      await webRTCService.createOffer();

      expect(pc.createOffer).toHaveBeenCalledWith(
        expect.objectContaining({ iceRestart: false })
      );
    });

    it('restarts ICE when asked, without rebuilding the connection', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      const generation = webRTCService.getGeneration();

      await webRTCService.createOffer({ iceRestart: true });

      expect(pc.createOffer).toHaveBeenCalledWith(
        expect.objectContaining({ iceRestart: true })
      );
      // The data channel only survives if the connection itself does.
      expect(webRTCService.getGeneration()).toBe(generation);
      expect(pc.close).not.toHaveBeenCalled();
    });

    it('reports no live video track before a stream is acquired', () => {
      expect(webRTCService.hasLiveVideoTrack()).toBe(false);
    });

    // The reconnect loop schedules an attempt on a timer, so setup teardown can
    // land in between. Without this check it renegotiated onto nothing and threw
    // "Peer connection not initialized".
    it('reports no peer connection before setup and after close', async () => {
      expect(webRTCService.hasPeerConnection()).toBe(false);

      await webRTCService.createPeerConnection();
      expect(webRTCService.hasPeerConnection()).toBe(true);

      webRTCService.close();
      expect(webRTCService.hasPeerConnection()).toBe(false);
    });

    it('reports a live video track while streaming', async () => {
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(streamWith('live'));

      await webRTCService.getLocalStream('back');

      expect(webRTCService.hasLiveVideoTrack()).toBe(true);
    });

    it('reports the track Android ended while backgrounded as not live', async () => {
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(streamWith('ended'));

      await webRTCService.getLocalStream('back');

      expect(webRTCService.hasLiveVideoTrack()).toBe(false);
    });
  });

  describe('recording camera handoff', () => {
    it('detaches the WebRTC camera track without removing its sender, then restores a fresh track', async () => {
      const pc: any = await webRTCService.createPeerConnection();

      const originalTrack = {
        kind: 'video',
        id: 'preview-original',
        readyState: 'live',
        enabled: true,
        stop: jest.fn(),
      };
      const originalStream: any = {
        getTracks: () => [originalTrack],
        getVideoTracks: () => [originalTrack],
      };

      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(originalStream);

      const stream = await webRTCService.getLocalStream('back');
      webRTCService.addLocalStream(stream);

      const sender = pc.getSenders()[0];
      expect(sender.track).toBe(originalTrack);

      await webRTCService.detachLocalVideoTrackForRecording();

      expect(sender.replaceTrack).toHaveBeenCalledWith(null);
      expect(sender.track).toBeNull();
      expect(originalTrack.stop).toHaveBeenCalledTimes(1);
      expect(webRTCService.getLocalStreamRef()).toBeNull();

      const restoredTrack = {
        kind: 'video',
        id: 'preview-restored',
        readyState: 'live',
        enabled: true,
        stop: jest.fn(),
      };
      const restoredStream: any = {
        getTracks: () => [restoredTrack],
        getVideoTracks: () => [restoredTrack],
      };
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(restoredStream);

      await webRTCService.resumeLocalStream('back');

      expect(sender.replaceTrack).toHaveBeenLastCalledWith(restoredTrack);
      expect(sender.track).toBe(restoredTrack);
    });
  });

  describe('low-bandwidth preview', () => {
    it('requests a small 15fps video stream for remote framing', async () => {
      await webRTCService.getLocalStream('back');

      expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
        audio: false,
        video: expect.objectContaining({
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15 },
          facingMode: 'environment',
        }),
      });
    });
  });

  describe('data channel lifecycle', () => {
    it('recognizes a channel that is already open when JS handlers attach', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      const onOpen = jest.fn();
      webRTCService.onDataChannelOpen(onOpen);

      const channel: any = {
        readyState: 'open',
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null,
        send: jest.fn(),
        close: jest.fn(),
      };

      pc.ondatachannel?.({ channel });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(webRTCService.isDataChannelReady()).toBe(true);
    });

    it('notifies listeners when the active data channel closes', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      const onClose = jest.fn();
      webRTCService.onDataChannelClose(onClose);

      const channel: any = webRTCService.createDataChannel();
      expect(pc.createDataChannel).toHaveBeenCalled();

      channel.onclose?.();

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery data channel', () => {
    it('replaces a stale open command channel before recovery negotiation', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      const first: any = webRTCService.createDataChannel();
      first.readyState = 'open';

      webRTCService.replaceDataChannelForRecovery();

      expect(first.close).toHaveBeenCalledTimes(1);
      expect(pc.createDataChannel).toHaveBeenCalledTimes(2);
    });

    it('recreates a closed command channel on the existing peer connection', async () => {
      const pc: any = await webRTCService.createPeerConnection();
      const first: any = webRTCService.createDataChannel();
      first.readyState = 'closed';

      webRTCService.ensureDataChannel();

      expect(pc.createDataChannel).toHaveBeenCalledTimes(2);
    });
  });

  describe('generation', () => {
    it('changes on create so a stale owner can detect it lost the connection', async () => {
      await webRTCService.createPeerConnection();
      const first = webRTCService.getGeneration();

      await webRTCService.createPeerConnection();

      expect(webRTCService.getGeneration()).not.toBe(first);
    });

    it('changes on close', async () => {
      await webRTCService.createPeerConnection();
      const generation = webRTCService.getGeneration();

      webRTCService.close();

      expect(webRTCService.getGeneration()).not.toBe(generation);
    });
  });
});

describe('concurrent connection setup', () => {
  it('has a peer connection ready for every caller that awaited creation', async () => {
    // Reproduces the original failure: while createPeerConnection awaits TURN
    // credentials, peerConnection is null. A second caller that skipped the
    // wait would wire up listeners and immediately hit a null connection.
    const inFlight = webRTCService.createPeerConnection();

    // A candidate arriving mid-fetch must not throw.
    await expect(webRTCService.addIceCandidate(candidate('a'))).resolves.toBeUndefined();

    await inFlight;

    await expect(webRTCService.setRemoteDescription(OFFER)).resolves.toBeUndefined();
  });
});
