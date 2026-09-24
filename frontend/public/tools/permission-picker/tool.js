// Permission Picker: from the features an app uses, the Android manifest
// lines (with the API-level limits each permission has) and the iOS
// Info.plist purpose-string keys.
// Sources: Android Developers "Manifest.permission" reference, "Permissions on
// Android" (normal / runtime / special), "Bluetooth permissions", "Request
// location permissions", "Granular media permissions", "Foreground service
// types"; Apple "Information Property List" keys (Protected resources).

// type: normal (granted at install), runtime (asked in a dialog), special (a settings screen)
// min/max: the API levels the line applies to (maxSdkVersion is written when max is set).
const P = (name, type, opt = {}) => ({ name, type, ...opt });
const FEATURES = {
  camera: { label: 'Camera', android: [P('android.permission.CAMERA', 'runtime')], uses: ['android.hardware.camera'],
    ios: [['NSCameraUsageDescription', 'take photos and scan documents']] },
  microphone: { label: 'Microphone', android: [P('android.permission.RECORD_AUDIO', 'runtime')], uses: ['android.hardware.microphone'],
    ios: [['NSMicrophoneUsageDescription', 'record voice messages']] },
  photosRead: { label: 'Read photos/videos', android: [
    P('android.permission.READ_EXTERNAL_STORAGE', 'runtime', { max: 32 }),
    P('android.permission.READ_MEDIA_IMAGES', 'runtime', { min: 33 }),
    P('android.permission.READ_MEDIA_VIDEO', 'runtime', { min: 33 }),
    P('android.permission.READ_MEDIA_VISUAL_USER_SELECTED', 'runtime', { min: 34, note: 'partial access: the user picks some photos' })],
    ios: [['NSPhotoLibraryUsageDescription', 'choose photos from your library']],
    warn: 'Reading photos: the system photo picker (Android PickVisualMedia, iOS PHPickerViewController) needs no permission at all. Google Play only allows READ_MEDIA_IMAGES/VIDEO for apps whose core use is broad photo access (gallery, editor, backup) - otherwise remove them and use the picker.' },
  photosSave: { label: 'Save to gallery', android: [P('android.permission.WRITE_EXTERNAL_STORAGE', 'runtime', { max: 28, note: 'API 29+ saves through MediaStore without a permission' })],
    ios: [['NSPhotoLibraryAddUsageDescription', 'save images to your photo library']] },
  location: { label: 'Location (in use)', android: [P('android.permission.ACCESS_COARSE_LOCATION', 'runtime'), P('android.permission.ACCESS_FINE_LOCATION', 'runtime', { note: 'API 31+: ask for both together; the user may grant only approximate' })],
    uses: ['android.hardware.location.gps'], ios: [['NSLocationWhenInUseUsageDescription', 'show places near you']] },
  bgLocation: { label: 'Background location', needs: 'location', android: [P('android.permission.ACCESS_BACKGROUND_LOCATION', 'runtime', { min: 29, note: 'ask only after foreground location is granted' })],
    ios: [['NSLocationAlwaysAndWhenInUseUsageDescription', 'record your route while the app is closed']], iosModes: ['location'],
    warn: 'Background location: Android 11+ sends the user to Settings to choose "Allow all the time" - ask for it separately, after foreground location, and explain why first. Google Play requires a declaration and a video; the App Store asks for a clear user benefit.' },
  bluetooth: { label: 'Bluetooth LE', android: [
    P('android.permission.BLUETOOTH', 'normal', { max: 30 }), P('android.permission.BLUETOOTH_ADMIN', 'normal', { max: 30 }),
    P('android.permission.ACCESS_FINE_LOCATION', 'runtime', { max: 30, note: 'BLE scanning needs location up to Android 11' }),
    P('android.permission.BLUETOOTH_SCAN', 'runtime', { min: 31, attrs: 'android:usesPermissionFlags="neverForLocation"', note: 'drop neverForLocation if scans derive location (beacons)' }),
    P('android.permission.BLUETOOTH_CONNECT', 'runtime', { min: 31 })],
    uses: ['android.hardware.bluetooth_le'], ios: [['NSBluetoothAlwaysUsageDescription', 'connect to your device']] },
  notifications: { label: 'Notifications', android: [P('android.permission.POST_NOTIFICATIONS', 'runtime', { min: 33 })],
    ios: [], iosNote: 'no Info.plist key: ask with UNUserNotificationCenter.requestAuthorization; remote push needs the Push Notifications capability (aps-environment)' },
  contacts: { label: 'Contacts', android: [P('android.permission.READ_CONTACTS', 'runtime')], ios: [['NSContactsUsageDescription', 'find friends who already use the app']] },
  calendar: { label: 'Calendar', android: [P('android.permission.READ_CALENDAR', 'runtime'), P('android.permission.WRITE_CALENDAR', 'runtime')],
    ios: [['NSCalendarsFullAccessUsageDescription', 'add your bookings to your calendar'], ['NSCalendarsUsageDescription', 'add your bookings to your calendar']],
    iosNote: 'iOS 17+ uses NSCalendarsFullAccessUsageDescription (or ...WriteOnlyAccess... if you only add events); keep NSCalendarsUsageDescription for iOS 16 and older' },
  internet: { label: 'Internet', android: [P('android.permission.INTERNET', 'normal'), P('android.permission.ACCESS_NETWORK_STATE', 'normal')], ios: [],
    iosNote: 'no key; plain http:// needs an NSAppTransportSecurity exception' },
  localNetwork: { label: 'Local network', android: [P('android.permission.ACCESS_WIFI_STATE', 'normal'), P('android.permission.CHANGE_WIFI_MULTICAST_STATE', 'normal', { note: 'for mDNS / multicast discovery' })],
    ios: [['NSLocalNetworkUsageDescription', 'find and control devices on your Wi-Fi']], iosBonjour: true },
  biometrics: { label: 'Biometrics', android: [P('android.permission.USE_BIOMETRIC', 'normal', { min: 28 })], ios: [['NSFaceIDUsageDescription', 'unlock the app with Face ID']] },
  nfc: { label: 'NFC', android: [P('android.permission.NFC', 'normal')], uses: ['android.hardware.nfc'],
    ios: [['NFCReaderUsageDescription', 'read your NFC tags']], iosNote: 'also the Near Field Communication Tag Reading capability' },
  vibrate: { label: 'Vibration', android: [P('android.permission.VIBRATE', 'normal')], ios: [] },
  boot: { label: 'Start at boot', android: [P('android.permission.RECEIVE_BOOT_COMPLETED', 'normal')], ios: [], iosNote: 'no equivalent on iOS' },
  exactAlarm: { label: 'Exact alarms', android: [P('android.permission.SCHEDULE_EXACT_ALARM', 'special', { min: 31, note: 'user grants it in Settings > Alarms & reminders' })], ios: [],
    warn: 'Exact alarms: on Android 14+ SCHEDULE_EXACT_ALARM is denied by default for new installs - check canScheduleExactAlarms() and send the user to Settings. Only alarm-clock and calendar apps may use USE_EXACT_ALARM instead (Play policy). Most reminders work with inexact alarms or WorkManager.' },
  fgs: { label: 'Foreground service', android: [P('android.permission.FOREGROUND_SERVICE', 'normal', { min: 28 })], ios: [] },
  motion: { label: 'Activity / steps', android: [P('com.google.android.gms.permission.ACTIVITY_RECOGNITION', 'normal', { max: 28 }), P('android.permission.ACTIVITY_RECOGNITION', 'runtime', { min: 29 })],
    ios: [['NSMotionUsageDescription', 'count your steps']] },
  speech: { label: 'Speech recognition', needsMic: true, android: [P('android.permission.RECORD_AUDIO', 'runtime')], uses: ['android.hardware.microphone'],
    ios: [['NSSpeechRecognitionUsageDescription', 'turn what you say into text'], ['NSMicrophoneUsageDescription', 'turn what you say into text']] },
  tracking: { label: 'Ad tracking ID', android: [P('com.google.android.gms.permission.AD_ID', 'normal', { note: 'needed when targeting API 33+ and reading the advertising ID' })],
    ios: [['NSUserTrackingUsageDescription', 'show you ads that match your interests']], iosNote: 'ask with ATTrackingManager before reading the IDFA' },
  wakeLock: { label: 'Keep awake', android: [P('android.permission.WAKE_LOCK', 'normal')], ios: [] },
};
// Android 14 (API 34): each foreground service type has its own permission.
const FGS = {
  dataSync: { perm: 'FOREGROUND_SERVICE_DATA_SYNC', ios: 'fetch', note: 'dataSync is limited to 6 h per day on Android 15; prefer WorkManager' },
  location: { perm: 'FOREGROUND_SERVICE_LOCATION', ios: 'location', needs: 'location' },
  mediaPlayback: { perm: 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', ios: 'audio' },
  camera: { perm: 'FOREGROUND_SERVICE_CAMERA', needs: 'camera' },
  microphone: { perm: 'FOREGROUND_SERVICE_MICROPHONE', ios: 'audio', needs: 'microphone' },
  connectedDevice: { perm: 'FOREGROUND_SERVICE_CONNECTED_DEVICE', ios: 'bluetooth-central' },
  health: { perm: 'FOREGROUND_SERVICE_HEALTH' },
  remoteMessaging: { perm: 'FOREGROUND_SERVICE_REMOTE_MESSAGING' },
  shortService: { perm: null, note: 'shortService needs no extra permission; about 3 minutes only' },
  specialUse: { perm: 'FOREGROUND_SERVICE_SPECIAL_USE', note: 'needs a <property> explaining the use, reviewed by Play' },
};
const api = (p) => (p.min && p.max ? `${p.min}-${p.max}` : p.min ? `${p.min}+` : p.max ? `≤ ${p.max}` : 'all');

export function run(input) {
  const { platform, minSdk, targetSdk, fgsType } = input;
  const warnings = [], notes = [];
  const lo = Number.isFinite(minSdk) ? Math.round(minSdk) : 24, hi = Number.isFinite(targetSdk) ? Math.round(targetSdk) : 35;
  if (lo < 21 || lo > 36) warnings.push(`minSdk ${lo} is unusual: current tools support 21 and up.`);
  if (hi < lo) return { warnings: [`targetSdk (${hi}) must be at least minSdk (${lo}).`] };
  if (hi < 34) warnings.push(`targetSdk ${hi}: Google Play requires targeting a recent API level (35 from August 2025 for new apps and updates). Some lines below only matter once you raise it.`);
  const chosen = Object.keys(FEATURES).filter((k) => input[k]);
  if (!chosen.length) return { warnings: ['Tick the features the app uses.'] };
  const doAndroid = platform !== 'ios', doIos = platform !== 'android';

  // --- Android: merge by permission name; a line with no max wins over one with a max ---
  const perms = new Map(), uses = new Set(), rows = [];
  const addPerm = (p, feat) => {
    if (p.max && p.max < lo) return; // below the app's minSdk: never used
    const old = perms.get(p.name);
    if (!old) perms.set(p.name, { ...p, feats: [feat] });
    else {
      old.feats.push(feat);
      if (!p.max || !old.max) old.max = undefined; else old.max = Math.max(old.max, p.max);
      if (!p.min || !old.min) old.min = undefined; else old.min = Math.min(old.min, p.min);
      if (p.attrs && old.attrs !== p.attrs) old.attrs = old.attrs || p.attrs;
    }
  };
  for (const k of chosen) {
    const f = FEATURES[k];
    for (const p of f.android) addPerm(p, f.label);
    for (const u of f.uses || []) uses.add(u);
    if (f.warn) warnings.push(f.warn);
    if (f.needs && !input[f.needs]) {
      warnings.push(`${f.label} needs ${FEATURES[f.needs].label} too; its Android lines are added.`);
      FEATURES[f.needs].android.forEach((p) => addPerm(p, FEATURES[f.needs].label));
    }
  }
  // Bluetooth + location: when location is asked for anyway, the BT-only
  // FINE_LOCATION (max 30) merges into the unrestricted one above.
  let fgsLine = null;
  if (input.fgs) {
    const t = FGS[fgsType] || FGS.dataSync;
    if (t.perm) addPerm(P(`android.permission.${t.perm}`, 'normal', { min: 34 }), 'Foreground service');
    if (t.needs && !input[t.needs]) warnings.push(`A ${fgsType} foreground service also needs the ${FEATURES[t.needs].label} permission granted before it starts: tick it.`);
    if (t.note) notes.push(`Foreground service: ${t.note}.`);
    fgsLine = `<service\n    android:name=".MyService"\n    android:foregroundServiceType="${fgsType}"\n    android:exported="false"${fgsType === 'specialUse' ? '>\n    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="explain the use here" />\n</service>' : ' />'}`;
  }
  const applies = (p) => !(p.min && p.min > hi);
  const list = [...perms.values()].filter(applies).sort((a, b) => a.name.localeCompare(b.name));
  const skippedHigh = [...perms.values()].filter((p) => !applies(p));
  if (skippedHigh.length && doAndroid) notes.push(`Left out, they only exist above targetSdk ${hi}: ${skippedHigh.map((p) => p.name.split('.').pop()).join(', ')}.`);
  for (const p of list) {
    rows.push([p.feats.join(', '), p.name.replace('android.permission.', ''), p.type, api(p), p.note || '']);
  }
  const xml = [];
  if (doAndroid) {
    xml.push('<!-- AndroidManifest.xml, inside <manifest> -->');
    for (const p of list) xml.push(`<uses-permission android:name="${p.name}"${p.max ? ` android:maxSdkVersion="${p.max}"` : ''}${p.attrs ? ` ${p.attrs}` : ''} />`);
    if (uses.size) { xml.push(''); for (const u of [...uses].sort()) xml.push(`<uses-feature android:name="${u}" android:required="false" />`); }
    if (fgsLine) xml.push('', '<!-- inside <application> -->', fgsLine);
  }
  // --- iOS ---
  const keys = new Map(), modes = new Set(), iosNotes = [];
  for (const k of chosen) {
    const f = FEATURES[k];
    for (const [key, why] of f.ios) if (!keys.has(key)) keys.set(key, why);
    for (const m of f.iosModes || []) modes.add(m);
    if (f.iosNote) iosNotes.push(`${f.label}: ${f.iosNote}`);
  }
  if (input.fgs && FGS[fgsType]?.ios) modes.add(FGS[fgsType].ios);
  const plist = [];
  if (doIos) {
    plist.push('<!-- Info.plist, inside the top <dict>. Rewrite each string: say what the user gets. -->');
    for (const [key, why] of keys) plist.push(`<key>${key}</key>`, `<string>$(PRODUCT_NAME) uses this to ${why}.</string>`);
    if (chosen.includes('localNetwork')) plist.push('<key>NSBonjourServices</key>', '<array>', '    <string>_myservice._tcp</string>', '</array>');
    if (modes.size) { plist.push('<key>UIBackgroundModes</key>', '<array>'); for (const m of modes) plist.push(`    <string>${m}</string>`); plist.push('</array>'); }
    if (plist.length === 1) plist.push('<!-- nothing needed for these features -->');
  }
  const runtime = list.filter((p) => p.type === 'runtime');
  const special = list.filter((p) => p.type === 'special');
  const code = runtime.length ? [
    '// Kotlin: ask at the moment the feature is used, not at app start.',
    'val needed = buildList {',
    ...runtime.filter((p) => !/BACKGROUND_LOCATION/.test(p.name)).map((p) => {
      const c = p.name.startsWith('android.permission.') ? `Manifest.permission.${p.name.split('.').pop()}` : `"${p.name}"`;
      const cond = p.min && p.min > lo && p.max ? `Build.VERSION.SDK_INT in ${p.min}..${p.max}` : p.min && p.min > lo ? `Build.VERSION.SDK_INT >= ${p.min}` : p.max ? `Build.VERSION.SDK_INT <= ${p.max}` : '';
      return cond ? `    if (${cond}) add(${c})` : `    add(${c})`;
    }),
    '}',
    'requestPermissions.launch(needed.toTypedArray())   // ActivityResultContracts.RequestMultiplePermissions()',
    ...(runtime.some((p) => /BACKGROUND_LOCATION/.test(p.name)) ? ['', '// Later, on its own and only once location is granted (API 29+):',
      'if (Build.VERSION.SDK_INT >= 29) requestPermissions.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))'] : []),
  ].join('\n') + '\n' : '';
  // iOS rows join the table
  const tableRows = [...(doAndroid ? rows : [])];
  if (doIos) for (const [key] of keys) tableRows.push([chosen.map((k) => FEATURES[k]).filter((f) => f.ios.some(([x]) => x === key)).map((f) => f.label).join(', '), key, 'iOS purpose string', 'iOS', '']);
  if (doIos && modes.size) tableRows.push(['Background', `UIBackgroundModes: ${[...modes].join(', ')}`, 'iOS capability', 'iOS', '']);
  if (doIos) notes.push(...iosNotes.map((n) => `iOS - ${n}.`));
  notes.push('Declare only what the app uses: every runtime permission is a dialog the user can refuse, and store reviews ask about each one.');
  notes.push('A missing purpose string makes iOS terminate the app the first time it touches that resource; a vague one gets the build rejected in review.');
  return {
    values: [
      ...(doAndroid ? [{ label: 'Android permissions', value: list.length, hint: `for API ${lo}-${hi}` },
        { label: 'Runtime (asked)', value: runtime.length, tone: runtime.length > 4 ? 'warn' : undefined, hint: special.length ? `+ ${special.length} special` : '' }] : []),
      ...(doIos ? [{ label: 'iOS purpose strings', value: keys.size }] : []),
      { label: 'Features', value: chosen.length },
    ],
    warnings,
    tables: [{ title: 'What each feature needs', columns: ['Feature', 'Permission / key', 'Kind', 'API levels', 'Note'], rows: tableRows }],
    texts: [
      ...(doAndroid ? [{ title: 'AndroidManifest.xml', body: xml.join('\n') + '\n', lang: 'xml' }] : []),
      ...(doIos ? [{ title: 'Info.plist', body: plist.join('\n') + '\n', lang: 'xml' }] : []),
      ...(doAndroid && code ? [{ title: 'Runtime request', body: code, lang: 'kotlin' }] : []),
    ],
    notes,
  };
}
