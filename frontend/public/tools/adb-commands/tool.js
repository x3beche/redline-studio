// ADB / emulator command palette: a reference table filtered by topic and words,
// with the package, activity, device serial and paths filled in.
// Commands follow the Android Developers docs: "Android Debug Bridge (adb)",
// "Logcat command-line tool", "Start the emulator from the command line" and
// "Send emulator console commands" (adb emu ...), plus AOSP `am`, `pm`, `wm`,
// `input`, `settings`, `dumpsys` and `cmd` shell tools.

const C = (cat, task, cmd, note = '') => ({ cat, task, cmd, note });

// {A} = adb (with -s serial when given), {pkg} {act} {apk} {url} {ip} {avd}
const COMMANDS = [
  // device
  C('device', 'List connected devices with model names', '{A} devices -l', 'state "unauthorized" = accept the RSA prompt on the phone'),
  C('device', 'Wait until a device is online', '{A} wait-for-device'),
  C('device', 'Restart the adb server', 'adb kill-server && adb start-server', 'fixes "device offline" and stuck connections'),
  C('device', 'Reboot', '{A} reboot'),
  C('device', 'Reboot to bootloader / fastboot', '{A} reboot bootloader'),
  C('device', 'Android version and API level', '{A} shell getprop ro.build.version.release && {A} shell getprop ro.build.version.sdk'),
  C('device', 'Model and CPU ABI', '{A} shell getprop ro.product.model && {A} shell getprop ro.product.cpu.abi'),
  C('device', 'Screen size and density', '{A} shell wm size && {A} shell wm density'),
  C('device', 'Pretend to be a smaller screen', '{A} shell wm size 720x1280 && {A} shell wm density 320', 'undo with: wm size reset; wm density reset'),
  C('device', 'Restart adbd as root', '{A} root', 'emulator images without Play Store and userdebug builds only'),
  C('device', 'Open a shell', '{A} shell'),
  // apps
  C('apps', 'Install or update an APK', '{A} install -r {apk}', '-r keeps data; add -g to grant all runtime permissions, -d to allow a downgrade, -t for test APKs'),
  C('apps', 'Install split APKs together', '{A} install-multiple -r base.apk split_config.arm64_v8a.apk'),
  C('apps', 'Uninstall', '{A} uninstall {pkg}'),
  C('apps', 'List third-party packages', '{A} shell pm list packages -3', 'add -f for the APK path'),
  C('apps', 'Where the installed APK is', '{A} shell pm path {pkg}'),
  C('apps', 'Installed version', '{A} shell dumpsys package {pkg} | grep -E "versionName|versionCode"'),
  C('apps', 'Start an activity', '{A} shell am start -n {pkg}/{act}'),
  C('apps', 'Start and measure launch time', '{A} shell am start -W -S -n {pkg}/{act}', '-S stops the app first (cold start); read TotalTime in ms'),
  C('apps', 'Launch the app as from the launcher', '{A} shell monkey -p {pkg} -c android.intent.category.LAUNCHER 1', 'no activity name needed'),
  C('apps', 'Open a deep link', '{A} shell am start -W -a android.intent.action.VIEW -d "{url}" {pkg}', 'drop the package to let the system choose'),
  C('apps', 'Force stop', '{A} shell am force-stop {pkg}'),
  C('apps', 'Clear app data (fresh install state)', '{A} shell pm clear {pkg}', 'also revokes runtime permissions'),
  C('apps', 'Grant a runtime permission', '{A} shell pm grant {pkg} android.permission.POST_NOTIFICATIONS'),
  C('apps', 'Revoke a runtime permission', '{A} shell pm revoke {pkg} android.permission.CAMERA', 'the process is killed, as when the user revokes it'),
  C('apps', 'Which activity is in front', '{A} shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"'),
  C('apps', 'Kill the process (as the system would in the background)', '{A} shell am kill {pkg}', 'app must be in the background; tests state restoration'),
  // files
  C('files', 'Copy a file to the device', '{A} push local.txt /sdcard/Download/'),
  C('files', 'Copy a file from the device', '{A} pull /sdcard/Download/file.txt .'),
  C('files', 'List a folder', '{A} shell ls -l /sdcard/Download'),
  C('files', 'List the app\'s private files', '{A} shell run-as {pkg} ls -R files databases shared_prefs', 'debuggable builds only'),
  C('files', 'Pull the app\'s database', '{A} exec-out run-as {pkg} cat databases/app.db > app.db', 'debuggable builds; also copy app.db-wal if WAL is on'),
  C('files', 'Read shared preferences', '{A} shell run-as {pkg} cat shared_prefs/{pkg}_preferences.xml'),
  // logs
  C('logs', 'Live log', '{A} logcat'),
  C('logs', 'Clear the log buffer', '{A} logcat -c'),
  C('logs', 'Log of this app only', '{A} logcat --pid=$({A} shell pidof -s {pkg})', 'the app must be running; re-run after a restart'),
  C('logs', 'Errors only', '{A} logcat "*:E"'),
  C('logs', 'One tag only', '{A} logcat -s MyTag:D', '-s silences every other tag'),
  C('logs', 'Crash stack traces', '{A} logcat -b crash -d'),
  C('logs', 'Save the log and exit', '{A} logcat -d -v threadtime > log.txt'),
  C('logs', 'Full bug report', '{A} bugreport bugreport.zip', 'includes ANR traces and dumpsys; takes a minute'),
  // screen
  C('screen', 'Screenshot to a PNG', '{A} exec-out screencap -p > screen.png'),
  C('screen', 'Record the screen', '{A} shell screenrecord --time-limit 30 /sdcard/demo.mp4 && {A} pull /sdcard/demo.mp4', 'max 180 s; no audio'),
  C('screen', 'Dump the view hierarchy (uiautomator)', '{A} shell uiautomator dump /sdcard/window_dump.xml && {A} pull /sdcard/window_dump.xml', 'feed it to the Layout Inspector Mapper'),
  C('screen', 'Show taps', '{A} shell settings put system show_touches 1'),
  C('screen', 'Pointer location overlay', '{A} shell settings put system pointer_location 1', 'shows x/y of touches: handy for input tap'),
  C('screen', 'Show layout bounds', '{A} shell setprop debug.layout true && {A} shell service call activity 1599295570', 'the service call makes running apps re-read the property'),
  C('screen', 'Dark theme on / off', '{A} shell cmd uimode night yes', 'no to switch back'),
  C('screen', 'Larger font', '{A} shell settings put system font_scale 1.3', '1.0 resets'),
  C('screen', 'Turn animations off (for UI tests)', '{A} shell settings put global window_animation_scale 0 && {A} shell settings put global transition_animation_scale 0 && {A} shell settings put global animator_duration_scale 0'),
  C('screen', 'Keep the screen on while charging', '{A} shell svc power stayon usb'),
  // input
  C('input', 'Tap at x, y (pixels)', '{A} shell input tap 540 1200'),
  C('input', 'Swipe up (x1 y1 x2 y2 ms)', '{A} shell input swipe 540 1600 540 400 300'),
  C('input', 'Long press', '{A} shell input swipe 540 1200 540 1200 800', 'a swipe that does not move'),
  C('input', 'Type text', '{A} shell input text "hello%sworld"', '%s is a space; no Unicode'),
  C('input', 'Back', '{A} shell input keyevent KEYCODE_BACK'),
  C('input', 'Home', '{A} shell input keyevent KEYCODE_HOME'),
  C('input', 'Recent apps', '{A} shell input keyevent KEYCODE_APP_SWITCH'),
  C('input', 'Wake and unlock (no PIN)', '{A} shell input keyevent KEYCODE_WAKEUP && {A} shell input keyevent KEYCODE_MENU'),
  C('input', 'Enter', '{A} shell input keyevent KEYCODE_ENTER'),
  // network
  C('network', 'Pair over Wi-Fi (Android 11+)', 'adb pair {ip}:37000', 'use the port and code from Developer options > Wireless debugging > Pair'),
  C('network', 'Connect over Wi-Fi (Android 11+)', 'adb connect {ip}:5555', 'the connect port is shown under Wireless debugging, it differs from the pair port'),
  C('network', 'Switch a USB device to TCP (older Android)', '{A} tcpip 5555 && adb connect {ip}:5555'),
  C('network', 'Disconnect all Wi-Fi devices', 'adb disconnect'),
  C('network', 'Device port -> computer (reverse)', '{A} reverse tcp:8081 tcp:8081', 'the phone reaches your dev server on localhost:8081 (Metro, Vite)'),
  C('network', 'Computer port -> device (forward)', '{A} forward tcp:9222 localabstract:chrome_devtools_remote', 'or tcp:8080 tcp:8080'),
  C('network', 'List port forwards', '{A} forward --list && {A} reverse --list'),
  C('network', 'Wi-Fi off / on', '{A} shell svc wifi disable', 'enable to switch back'),
  C('network', 'Mobile data off / on', '{A} shell svc data disable', 'enable to switch back'),
  C('network', 'Airplane mode on (Android 11+)', '{A} shell cmd connectivity airplane-mode enable', 'disable to switch back'),
  C('network', 'Set an HTTP proxy (Charles, mitmproxy)', '{A} shell settings put global http_proxy {ip}:8888', 'clear with: settings put global http_proxy :0'),
  // emulator
  C('emulator', 'List virtual devices', 'emulator -list-avds'),
  C('emulator', 'Start an emulator', 'emulator -avd {avd}'),
  C('emulator', 'Cold boot (ignore the snapshot)', 'emulator -avd {avd} -no-snapshot-load'),
  C('emulator', 'Factory reset the emulator', 'emulator -avd {avd} -wipe-data'),
  C('emulator', 'Headless for CI', 'emulator -avd {avd} -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect'),
  C('emulator', 'Wait for boot to finish', '{A} wait-for-device shell \'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done\''),
  C('emulator', 'Shut the emulator down', '{A} emu kill'),
  C('emulator', 'Set GPS position (longitude first)', '{A} emu geo fix 28.9784 41.0082', 'geo fix takes longitude, then latitude'),
  C('emulator', 'Receive an SMS', '{A} emu sms send 5551234 "Your code is 123456"'),
  C('emulator', 'Incoming call', '{A} emu gsm call 5551234', 'gsm cancel 5551234 hangs up'),
  C('emulator', 'Slow network', '{A} emu network speed edge && {A} emu network delay gprs', 'full / none resets'),
  C('emulator', 'Battery level and unplugged', '{A} emu power capacity 15 && {A} emu power ac off'),
  C('emulator', 'Touch the fingerprint sensor', '{A} emu finger touch 1', 'enrol finger 1 in Settings first'),
  C('emulator', 'Rotate', '{A} emu rotate'),
  // debug / performance
  C('debug', 'Memory use of the app', '{A} shell dumpsys meminfo {pkg}'),
  C('debug', 'Frame timing (jank)', '{A} shell dumpsys gfxinfo {pkg}', 'add reset to start a fresh window'),
  C('debug', 'Process id', '{A} shell pidof {pkg}'),
  C('debug', 'Top CPU users', '{A} shell top -n 1 -m 10'),
  C('debug', 'Wait for the debugger at launch', '{A} shell am set-debug-app -w {pkg}', 'clear with: am clear-debug-app'),
  C('debug', 'Heap dump', '{A} shell am dumpheap {pkg} /data/local/tmp/heap.hprof && {A} pull /data/local/tmp/heap.hprof'),
  C('debug', 'Force Doze (idle) mode', '{A} shell dumpsys battery unplug && {A} shell dumpsys deviceidle force-idle', 'undo: deviceidle unforce; battery reset'),
  C('debug', 'Fake battery level', '{A} shell dumpsys battery set level 5', 'battery reset to undo'),
  C('debug', 'Run a JobScheduler job now', '{A} shell cmd jobscheduler run -f {pkg} 1', 'the last number is the job id'),
  C('debug', 'Put the app in a standby bucket', '{A} shell am set-standby-bucket {pkg} rare', 'active, working_set, frequent, rare, restricted'),
];

export const CATEGORIES = ['device', 'apps', 'files', 'logs', 'screen', 'input', 'network', 'emulator', 'debug'];

const clean = (v) => String(v ?? '').trim();

export function run({ category, filter, pkg, activity, serial, apk, url, ip, avd }) {
  const warnings = [];
  const p = clean(pkg) || 'com.example.app';
  if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(p)) warnings.push(`"${p}" does not look like an application id (com.company.app): check it, am/pm commands will not find the app.`);
  let act = clean(activity) || '.MainActivity';
  if (/\s/.test(act)) warnings.push('The activity name has a space in it; use the class name, e.g. .MainActivity or com.example.app.ui.LoginActivity.');
  const s = clean(serial);
  if (/\s/.test(s)) warnings.push('A device serial has no spaces: copy it from the first column of adb devices.');
  const A = s ? `adb -s ${s}` : 'adb';
  const ipv = clean(ip) || '192.168.1.50';
  if (!/^(\d{1,3}\.){3}\d{1,3}$|^[\w.-]+$/.test(ipv)) warnings.push(`"${ipv}" is not an IP address or host name.`);
  const fill = (t) => t.replace(/\{A\}/g, A).replace(/\{pkg\}/g, p).replace(/\{act\}/g, act)
    .replace(/\{apk\}/g, clean(apk) || 'app-debug.apk').replace(/\{url\}/g, clean(url) || 'myapp://home')
    .replace(/\{ip\}/g, ipv).replace(/\{avd\}/g, clean(avd) || 'Pixel_8_API_35');

  const words = clean(filter).toLowerCase().split(/\s+/).filter(Boolean);
  const cat = CATEGORIES.includes(category) ? category : 'all';
  const hits = COMMANDS.filter((c) => (cat === 'all' || c.cat === cat))
    .map((c) => ({ ...c, cmd: fill(c.cmd), note: fill(c.note) }))
    .filter((c) => words.every((w) => `${c.cat} ${c.task} ${c.cmd} ${c.note}`.toLowerCase().includes(w)));

  // How many commands each topic has for these words, whatever topic is chosen
  // (the page puts these counts on the parts of the device it draws).
  const topics = Object.fromEntries(CATEGORIES.map((k) => [k, COMMANDS.filter((c) => c.cat === k)
    .filter((c) => { const f = { ...c, cmd: fill(c.cmd), note: fill(c.note) }; return words.every((w) => `${f.cat} ${f.task} ${f.cmd} ${f.note}`.toLowerCase().includes(w)); }).length]));
  if (!hits.length) {
    return { values: [{ label: 'Matching commands', value: 0, tone: 'warn' }], topics,
      warnings: [...warnings, `Nothing matches "${clean(filter)}"${cat !== 'all' ? ` in ${cat}` : ''}: try one word (log, install, tap, proxy) or the topic All.`] };
  }
  const byCat = CATEGORIES.map((k) => [k, hits.filter((h) => h.cat === k).length]).filter(([, n]) => n);
  const script = hits.map((h) => `# ${h.task}${h.note ? ` (${h.note})` : ''}\n${h.cmd}`).join('\n\n') + '\n';
  const notes = [
    `Per topic: ${byCat.map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    s ? `Every adb call targets ${s}; commands without -s (pair, connect, emulator) work on the host.` : 'With more than one device attached, set the serial so every adb call gets -s.',
    'Commands joined with && run in order and stop at the first failure. On Windows cmd, use a Unix-like shell (Git Bash, WSL) for the $(...), | grep and > file parts.',
  ];
  if (hits.some((h) => h.cat === 'emulator')) notes.push('adb emu ... talks to the emulator console and only works on emulators (emulator-5554 style serials).');
  return {
    values: [
      { label: 'Matching commands', value: hits.length },
      { label: 'adb prefix', value: A },
      { label: 'Package', value: p },
    ],
    tables: [{ title: cat === 'all' ? 'Commands' : `${cat[0].toUpperCase()}${cat.slice(1)} commands`, columns: ['Topic', 'Task', 'Command', 'Note'], rows: hits.map((h) => [h.cat, h.task, h.cmd, h.note]) }],
    texts: [{ title: 'Shell script', body: script, lang: 'bash' }],
    warnings, notes, topics,
  };
}
