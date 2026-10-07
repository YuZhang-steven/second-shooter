import AsyncStorage from '@react-native-async-storage/async-storage';
import { isValidSessionId } from '../utils/sessionId';

const CAMERA_PAIR_KEY = '@secondshooter_camera_pair_id';
const REMOTE_PAIR_KEY = '@secondshooter_remote_pair_id';

class PairingService {
  private async getValidPairId(key: string): Promise<string | null> {
    try {
      const stored = await AsyncStorage.getItem(key);
      if (!stored) return null;

      const normalized = stored.trim().toUpperCase();
      if (!isValidSessionId(normalized)) {
        await AsyncStorage.removeItem(key);
        return null;
      }

      return normalized;
    } catch (error) {
      console.error('[Pairing] Failed to read saved pair ID:', error);
      return null;
    }
  }

  private async savePairId(key: string, pairId: string): Promise<void> {
    const normalized = pairId.trim().toUpperCase();
    if (!isValidSessionId(normalized)) {
      throw new Error(`Invalid pair ID: ${pairId}`);
    }

    await AsyncStorage.setItem(key, normalized);
  }

  getCameraPairId(): Promise<string | null> {
    return this.getValidPairId(CAMERA_PAIR_KEY);
  }

  getRemotePairId(): Promise<string | null> {
    return this.getValidPairId(REMOTE_PAIR_KEY);
  }

  saveCameraPairId(pairId: string): Promise<void> {
    return this.savePairId(CAMERA_PAIR_KEY, pairId);
  }

  saveRemotePairId(pairId: string): Promise<void> {
    return this.savePairId(REMOTE_PAIR_KEY, pairId);
  }

  async clearCameraPairId(): Promise<void> {
    await AsyncStorage.removeItem(CAMERA_PAIR_KEY);
  }

  async clearRemotePairId(): Promise<void> {
    await AsyncStorage.removeItem(REMOTE_PAIR_KEY);
  }
}

export const pairingService = new PairingService();
export default pairingService;
