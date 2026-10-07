import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, DEFAULT_SETTINGS } from '../types';

const SETTINGS_STORAGE_KEY = '@secondshooter_settings';

type SettingsChangeCallback = (settings: AppSettings) => void;

class SettingsService {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private listeners: Set<SettingsChangeCallback> = new Set();
  private isLoaded: boolean = false;

  // Load settings from AsyncStorage
  async loadSettings(): Promise<AppSettings> {
    if (this.isLoaded) {
      return this.settings;
    }

    try {
      const stored = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<AppSettings>;
        const hadLegacyFramePreview = parsed.previewMode === 'frames';

        // The old Steady mode streamed repeated JPEG snapshots through the
        // command data channel. Migrate it away so an existing install cannot
        // re-enable the transport that can close the channel under load.
        if (hadLegacyFramePreview) {
          parsed.previewMode = 'auto';
        }

        this.settings = { ...DEFAULT_SETTINGS, ...parsed };

        if (hadLegacyFramePreview) {
          await this.saveSettings();
        }
      }
      this.isLoaded = true;
    } catch (error) {
      console.error('Error loading settings:', error);
    }

    return this.settings;
  }

  // Save settings to AsyncStorage
  private async saveSettings(): Promise<void> {
    try {
      await AsyncStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(this.settings)
      );
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  // Get current settings (synchronous, returns cached)
  getSettings(): AppSettings {
    return { ...this.settings };
  }

  // Get a single setting value
  getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key];
  }

  // Update a setting
  async updateSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
    this.notifyListeners();
  }

  // Update multiple settings at once
  async updateSettings(updates: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...updates };
    await this.saveSettings();
    this.notifyListeners();
  }

  // Reset to defaults
  async resetSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS };
    await this.saveSettings();
    this.notifyListeners();
  }

  // Subscribe to settings changes
  subscribe(callback: SettingsChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(): void {
    const currentSettings = this.getSettings();
    this.listeners.forEach((callback) => callback(currentSettings));
  }
}

export const settingsService = new SettingsService();
export default settingsService;
