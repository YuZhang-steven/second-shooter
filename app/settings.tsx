import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  ScrollView,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Modal,
  Pressable,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useSettings } from '../src/hooks/useSettings';
import { isSaveFolderSupported, pickSaveFolder } from '../src/utils/saveFolder';
import { mediaService } from '../src/services/MediaService';
import {
  GalleryAppInfo,
  isGalleryAppChoiceSupported,
  listGalleryApps,
} from '../src/utils/galleryApps';
import {
  TimerDuration,
  AspectRatio,
  GridOverlay,
  FlashMode,
  GalleryApp,
  SYSTEM_DEFAULT_GALLERY,
} from '../src/types';

// Option definitions
const TIMER_OPTIONS: { value: TimerDuration; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 2, label: '2s' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
];

const ASPECT_RATIO_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '1:1', label: '1:1 (Square)' },
  { value: '4:5', label: '4:5 (Portrait)' },
  { value: '9:16', label: '9:16 (Full)' },
];

const GRID_OPTIONS: { value: GridOverlay; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '3x3', label: '3x3 (Rule of Thirds)' },
  { value: '4x4', label: '4x4' },
];

const FLASH_OPTIONS: { value: FlashMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'auto', label: 'Auto' },
];

const SYSTEM_DEFAULT_GALLERY_OPTION = {
  value: SYSTEM_DEFAULT_GALLERY,
  label: 'System Default',
};

// Setting Row Component with Modal Picker
function SettingRow<T extends string | number>({
  label,
  value,
  displayValue,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  value: T;
  displayValue?: string;
  options: { value: T; label: string }[];
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const selectedLabel =
    displayValue || options.find((o) => o.value === value)?.label || String(value);

  return (
    <>
      <TouchableOpacity
        style={styles.row}
        onPress={() => !disabled && setShowPicker(true)}
        disabled={disabled}
        activeOpacity={0.7}
      >
        <Text style={[styles.rowLabel, disabled && styles.rowLabelDisabled]}>
          {label}
        </Text>
        <View style={styles.rowValue}>
          <Text style={[styles.rowValueText, disabled && styles.rowValueDisabled]}>
            {selectedLabel}
          </Text>
          <Feather name="chevron-right" size={18} color="#666" />
        </View>
      </TouchableOpacity>

      <Modal
        visible={showPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPicker(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowPicker(false)}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{label}</Text>
            {options.map((option) => (
              <TouchableOpacity
                key={String(option.value)}
                style={[
                  styles.modalOption,
                  option.value === value && styles.modalOptionSelected,
                ]}
                onPress={() => {
                  onSelect(option.value);
                  setShowPicker(false);
                }}
              >
                <Text
                  style={[
                    styles.modalOptionText,
                    option.value === value && styles.modalOptionTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
                {option.value === value && (
                  <Feather name="check" size={20} color="#007AFF" />
                )}
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setShowPicker(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { settings, updateSetting, updateSettings, isLoaded } = useSettings();

  // Which gallery apps are installed is a device fact, not a setting, so it's
  // read once per visit to Settings rather than persisted. Empty until the
  // native query comes back - and permanently empty where the choice isn't
  // supported, which is what hides the row.
  const [galleryApps, setGalleryApps] = useState<GalleryAppInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    listGalleryApps().then((apps) => {
      if (!cancelled) {
        setGalleryApps(apps);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const galleryAppOptions = [
    SYSTEM_DEFAULT_GALLERY_OPTION,
    ...galleryApps.map((app) => ({ value: app.packageName, label: app.label })),
  ];

  // A remembered package can have been uninstalled since it was picked, and
  // then it isn't in the list to look a name up in. Showing the raw package
  // name beats showing 'System Default' for something that isn't set to it.
  const galleryAppLabel =
    settings.galleryApp === SYSTEM_DEFAULT_GALLERY
      ? SYSTEM_DEFAULT_GALLERY_OPTION.label
      : galleryApps.find((app) => app.packageName === settings.galleryApp)?.label ??
        settings.galleryApp;

  // A stored folder can stop working - the grant is revocable from system
  // settings and the folder itself can be deleted - and nothing tells the app
  // until a save fails. That failure is exactly what this reads: no probing,
  // and it reports what actually happened to the last photo.
  const [folderMissing, setFolderMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!settings.saveFolderUri) {
      setFolderMissing(false);
      return;
    }
    mediaService.getBrokenSaveFolder().then((broken) => {
      if (!cancelled) {
        setFolderMissing(broken === settings.saveFolderUri);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settings.saveFolderUri]);

  // Tapping the row goes straight to the system folder browser - there's only
  // one thing to choose here, so a menu in front of it would be a dead step.
  const chooseFolder = async () => {
    const result = await pickSaveFolder();

    if (result.status === 'picked') {
      // A fresh pick is a repair attempt: whatever failed last time, this
      // folder's grant is seconds old and deserves a clean slate.
      await mediaService.clearBrokenSaveFolder();
      // The two values move together: a name without its URI has nowhere to
      // write, and a URI without a name has nothing to show.
      await updateSettings({
        saveFolderUri: result.folder.uri,
        saveFolderName: result.folder.name,
      });
      return;
    }

    // Backing out of the picker is a decision, and the picker already being up
    // means the tap was a duplicate. Neither needs to be reported back.
    if (result.status === 'cancelled' || result.status === 'already-open') {
      return;
    }

    // Everything else means no picker appeared. Saying so matters more than
    // usual here: the screen looks exactly the same as a cancel, so without a
    // message the user is left tapping a button that does nothing.
    if (result.status === 'stuck') {
      Alert.alert(
        "Folder picker won't open",
        'Android still thinks an earlier folder request is open. Close the app completely and reopen it, then try again.'
      );
      return;
    }

    Alert.alert(
      "Folder picker won't open",
      result.status === 'failed'
        ? result.message
        : 'This device has no folder picker. Photos go to the camera roll.'
    );
  };

  const folderLabel = !settings.saveFolderName
    ? 'Camera Roll'
    : folderMissing
      ? `${settings.saveFolderName} (unavailable)`
      : settings.saveFolderName;

  const saveFolderHint = !settings.saveFolderUri
    ? 'Photos go wherever this phone keeps camera photos. Pick a folder to put them somewhere you choose.'
    : folderMissing
      ? "The last photo couldn't be written here, so it went to the camera roll. Pick the folder again to retry."
      : 'Photos are written to this folder. The gallery app may take a while to notice them.';

  if (!isLoaded) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Feather name="chevron-left" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 20 },
        ]}
      >
        {/* Camera Section */}
        <Text style={styles.sectionTitle}>Camera</Text>
        <View style={styles.section}>
          <SettingRow
            label="Timer"
            value={settings.timer}
            displayValue={settings.timer === 0 ? 'Off' : `${settings.timer}s`}
            options={TIMER_OPTIONS}
            onSelect={(value) => updateSetting('timer', value)}
          />
          <SettingRow
            label="Aspect Ratio"
            value={settings.aspectRatio}
            options={ASPECT_RATIO_OPTIONS}
            onSelect={(value) => updateSetting('aspectRatio', value)}
          />
          <SettingRow
            label="Grid Overlay"
            value={settings.gridOverlay}
            displayValue={
              settings.gridOverlay === 'none' ? 'None' : settings.gridOverlay
            }
            options={GRID_OPTIONS}
            onSelect={(value) => updateSetting('gridOverlay', value)}
          />
          <SettingRow
            label="Default Flash"
            value={settings.flash}
            displayValue={
              settings.flash.charAt(0).toUpperCase() + settings.flash.slice(1)
            }
            options={FLASH_OPTIONS}
            onSelect={(value) => updateSetting('flash', value)}
          />
        </View>

        {/* Media Section */}
        <Text style={styles.sectionTitle}>Media</Text>
        <View style={styles.section}>
          {isSaveFolderSupported() && (
            <TouchableOpacity
              style={styles.row}
              onPress={chooseFolder}
              activeOpacity={0.7}
            >
              <Text style={styles.rowLabel}>Save Folder</Text>
              <View style={styles.rowValue}>
                <Text
                  style={[
                    styles.rowValueText,
                    styles.rowValueTruncated,
                    folderMissing && styles.rowValueWarning,
                  ]}
                  numberOfLines={1}
                  ellipsizeMode="head"
                >
                  {folderLabel}
                </Text>
                <Feather name="chevron-right" size={18} color="#666" />
              </View>
            </TouchableOpacity>
          )}
          {isGalleryAppChoiceSupported() && (
            <SettingRow
              label="Gallery App"
              value={settings.galleryApp}
              displayValue={galleryAppLabel}
              options={galleryAppOptions}
              onSelect={(value: GalleryApp) => updateSetting('galleryApp', value)}
            />
          )}
        </View>
        {isSaveFolderSupported() && (
          <Text style={styles.sectionFooter}>{saveFolderHint}</Text>
        )}

        {/* Remote Section */}
        <Text style={styles.sectionTitle}>Remote Preview</Text>
        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Preview</Text>
            <Text style={styles.rowValueText}>Low Bandwidth (Automatic)</Text>
          </View>
        </View>
        <Text style={styles.sectionFooter}>
          Preview is kept lightweight so camera controls and capture stay responsive on weaker connections.
        </Text>

        {/* General Section */}
        <Text style={styles.sectionTitle}>General</Text>
        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Keep Screen Awake</Text>
            <Switch
              value={settings.keepScreenAwake}
              onValueChange={(value) => updateSetting('keepScreenAwake', value)}
              trackColor={{ false: '#555', true: '#4cd964' }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Volume Button Shutter</Text>
            <Switch
              value={settings.volumeShutter}
              onValueChange={(value) => updateSetting('volumeShutter', value)}
              trackColor={{ false: '#555', true: '#4cd964' }}
              thumbColor="#fff"
            />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    textAlign: 'center',
    marginTop: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
    marginTop: 24,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  section: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    overflow: 'hidden',
  },
  sectionFooter: {
    fontSize: 13,
    color: '#888',
    marginTop: 8,
    paddingHorizontal: 4,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  rowLabel: {
    fontSize: 16,
    color: '#fff',
  },
  rowLabelDisabled: {
    color: '#666',
  },
  rowValue: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowValueText: {
    fontSize: 16,
    color: '#888',
    marginRight: 4,
  },
  rowValueDisabled: {
    color: '#555',
  },
  // Folder paths get long; keep them from pushing the chevron off the row.
  rowValueTruncated: {
    maxWidth: 220,
  },
  rowValueWarning: {
    color: '#ff9f0a',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#2c2c2e',
    borderRadius: 14,
    width: '80%',
    maxWidth: 320,
    overflow: 'hidden',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#444',
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#444',
  },
  modalOptionSelected: {
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
  },
  modalOptionText: {
    color: '#fff',
    fontSize: 16,
  },
  modalOptionTextSelected: {
    color: '#007AFF',
  },
  modalCancel: {
    paddingVertical: 16,
    backgroundColor: '#1c1c1e',
  },
  modalCancelText: {
    color: '#ff453a',
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
});
