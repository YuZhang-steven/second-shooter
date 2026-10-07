import AsyncStorage from '@react-native-async-storage/async-storage';
import { pairingService } from '../../services/PairingService';

describe('PairingService', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('persists camera and controller Pair IDs independently', async () => {
    await pairingService.saveCameraPairId('ABC234');
    await pairingService.saveRemotePairId('XYZ789');

    await expect(pairingService.getCameraPairId()).resolves.toBe('ABC234');
    await expect(pairingService.getRemotePairId()).resolves.toBe('XYZ789');
  });

  it('normalizes Pair IDs before saving', async () => {
    await pairingService.saveRemotePairId('abc234');

    await expect(pairingService.getRemotePairId()).resolves.toBe('ABC234');
  });

  it('clears only the requested side of the pairing', async () => {
    await pairingService.saveCameraPairId('ABC234');
    await pairingService.saveRemotePairId('XYZ789');

    await pairingService.clearRemotePairId();

    await expect(pairingService.getCameraPairId()).resolves.toBe('ABC234');
    await expect(pairingService.getRemotePairId()).resolves.toBeNull();
  });
});
