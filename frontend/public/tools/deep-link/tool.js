// Deep Link Builder: assembles a deep link from its parts with correct
// percent-encoding (RFC 3986), and gives the commands that open it on an
// Android emulator (adb shell am start, Android "Test deep links") and the iOS
// Simulator (xcrun simctl openurl), plus the intent filter, the Chrome intent: URL
// and, for https links, the assetlinks.json / apple-app-site-association files.
// Sources: RFC 3986 (URI syntax), Android Developers "Create deep links to app
// content" and "Verify Android App Links", Apple "Supporting universal links in
// your app" and "Defining a custom URL scheme for your app", Chrome "Android Intents with Chrome".

const RESERVED = ['http', 'https', 'file', 'content', 'intent', 'tel', 'mailto', 'sms', 'geo', 'market', 'javascript', 'data', 'ftp', 'ws', 'wss'];
// Characters encodeURIComponent keeps that shells or parsers trip on.
const shellSafe = (s) => s.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const tryDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const encSeg = (s) => shellSafe(encodeURIComponent(tryDecode(s)));

export function run({ kind, scheme, host, path, params, fragment, pkg, bundle, team }) {
  const warnings = [], notes = [];
  const https = kind === 'https';
  let sch = https ? 'https' : String(scheme || '').trim().replace(/:\/*$/, '');
  if (!sch) return { warnings: ['Give the URL scheme, e.g. myapp.'] };
  if (!https) {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(sch)) return { warnings: [`"${sch}" is not a valid scheme: start with a letter, then letters, digits, + - or . only (RFC 3986 section 3.1).`] };
    if (sch !== sch.toLowerCase()) { warnings.push(`Scheme "${sch}" has capitals: Android intent filters match schemes case-sensitively, while browsers lower-case them (RFC 3986 says schemes are case-insensitive). Use "${sch.toLowerCase()}" everywhere.`); sch = sch.toLowerCase(); }
    if (RESERVED.includes(sch)) return { warnings: [`"${sch}" is a standard scheme, not one your app can own. Pick your own (e.g. com.example.shop or myshop), or use an https App Link.`] };
    if (sch.length < 5 && !sch.includes('.')) notes.push(`Short custom schemes like "${sch}" can clash with other apps: any app may register the same one. A reverse-domain scheme (com.example.${sch}) is safer.`);
  }
  let h = String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (https && !h) return { warnings: ['An https App Link / Universal Link needs a host, e.g. example.com.'] };
  if (h && !/^[a-z0-9.-]+(:\d+)?$/i.test(h)) warnings.push(`Host "${h}" has characters a host cannot have (letters, digits, dots, hyphens, an optional :port).`);
  h = h.toLowerCase();
  let p = String(path || '').trim();
  if (p && !p.startsWith('/')) p = '/' + p;
  const segs = p.split('/').slice(1);
  const encPath = segs.length ? '/' + segs.map(encSeg).join('/') : '';
  const list = (Array.isArray(params) ? params : []).filter((r) => String(r.key ?? '').trim() || String(r.value ?? '').trim());
  const noKey = list.filter((r) => !String(r.key ?? '').trim());
  if (noKey.length) warnings.push(`${noKey.length} parameter(s) have a value but no name; they were left out.`);
  const q = list.filter((r) => String(r.key ?? '').trim()).map((r) => [String(r.key).trim(), String(r.value ?? '')]);
  const query = q.length ? '?' + q.map(([k, v]) => `${encSeg(k)}=${encSeg(v)}`).join('&') : '';
  const frag = String(fragment || '').trim().replace(/^#/, '');
  const encFrag = frag ? '#' + encSeg(frag) : '';
  // A custom-scheme link without a host: the first path segment becomes the host on
  // Android (Uri.getHost) and in URLComponents - say so rather than surprise.
  let authority = h;
  let restPath = encPath;
  if (!https && !h) {
    if (segs.length && segs[0]) { authority = encSeg(segs[0]); restPath = segs.length > 1 ? '/' + segs.slice(1).map(encSeg).join('/') : ''; notes.push(`No host given: in ${sch}://${authority}${restPath} the first path part "${segs[0]}" is read as the host by Android's Uri and iOS URLComponents. Match on host="${segs[0]}" in the intent filter.`); }
  }
  const url = `${sch}://${authority}${restPath}${query}${encFrag}`;
  for (const [k] of q) if (/token|password|passwd|secret|session|auth|otp/i.test(k)) warnings.push(`Parameter "${k}" looks like a secret: deep links end up in logs, browser history and other apps (${https ? 'server logs' : 'any app can claim a custom scheme'}). Pass a short-lived one-time code instead.`);
  if (url.length > 2000) warnings.push(`The link is ${url.length} characters; keep it under about 2000 (some browsers, QR codes and SMS break long URLs).`);
  if (!https) notes.push('Custom schemes are not verified: any app can register the same one and Android shows a chooser. For links shared on the web, in email or with sensitive data, use an https App Link / Universal Link.');

  const P = String(pkg || '').trim();
  if (P && !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(P)) warnings.push(`"${P}" is not a valid Android package name (e.g. com.example.shop).`);
  const B = String(bundle || '').trim() || P;
  const T = String(team || '').trim() || 'TEAMID1234';
  // adb: the command line is re-parsed by the device shell, so the whole am
  // command goes in double quotes and the URL in single quotes inside it.
  const adb = `adb shell "am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${url}'${P ? ` ${P}` : ''}"`;
  const simctl = `xcrun simctl openurl booted '${url}'`;
  const intentUrl = `intent://${authority}${restPath}${query}#Intent;scheme=${sch};${P ? `package=${P};` : ''}${https ? '' : `S.browser_fallback_url=${encodeURIComponent('https://example.com/get-the-app')};`}end`;
  const first = https && segs.length && segs[0] ? `/${segs[0]}` : ''; // custom schemes: the host already picks the screen
  const dataLine = https || h
    ? `<data android:scheme="${sch}" android:host="${h}"${first ? ` android:pathPrefix="${first}"` : ''} />`
    : `<data android:scheme="${sch}"${authority ? ` android:host="${tryDecode(authority)}"` : ''} />`;
  const filter = [
    '<!-- AndroidManifest.xml, inside the <activity> that handles the link -->',
    `<intent-filter${https ? ' android:autoVerify="true"' : ''}>`,
    '    <action android:name="android.intent.action.VIEW" />',
    '    <category android:name="android.intent.category.DEFAULT" />',
    '    <category android:name="android.intent.category.BROWSABLE" />',
    `    ${dataLine}`,
    '</intent-filter>',
  ].join('\n');
  const texts = [
    { title: 'Test commands', body: [
      '# Android emulator or device (adb on the PATH)', adb, '',
      '# iOS Simulator', simctl, '',
      ...(https && P ? ['# Android App Link verification state (API 31+)', `adb shell pm verify-app-links --re-verify ${P}`, `adb shell pm get-app-links ${P}`, ''] : []),
      '# From a web page in Chrome for Android', `<a href="${intentUrl.replace(/&/g, '&amp;')}">Open in the app</a>`,
    ].join('\n') + '\n', lang: 'sh' },
    { title: 'Android intent filter', body: filter + '\n', lang: 'xml' },
  ];
  if (https) {
    texts.push({ title: 'assetlinks.json', lang: 'json', body: `// serve at https://${h}/.well-known/assetlinks.json (application/json, no redirects)\n` + JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: P || 'com.example.app', sha256_cert_fingerprints: ['AB:CD:…: from keytool -list -v or the Play Console App signing page'] },
    }], null, 2) + '\n' });
    texts.push({ title: 'apple-app-site-association', lang: 'json', body: `// serve at https://${h}/.well-known/apple-app-site-association (no .json, application/json)\n// and add the Associated Domains entitlement: applinks:${h}\n` + JSON.stringify({
      applinks: { details: [{ appIDs: [`${T}.${B || 'com.example.app'}`], components: [{ '/': first ? `${first}/*` : '/*', comment: 'links this app opens' }] }] },
    }, null, 2) + '\n' });
    if (!String(team || '').trim()) notes.push('Put your Apple Team ID (10 characters, from the developer account) in place of TEAMID1234.');
  } else {
    texts.push({ title: 'iOS Info.plist', lang: 'xml', body: ['<key>CFBundleURLTypes</key>', '<array>', '    <dict>', '        <key>CFBundleURLName</key>', `        <string>${B || 'com.example.app'}</string>`, '        <key>CFBundleURLSchemes</key>', '        <array>', `            <string>${sch}</string>`, '        </array>', '    </dict>', '</array>'].join('\n') + '\n' });
  }
  if (!P) notes.push('Without a package name the adb command lets Android pick the app (or show a chooser). Add the package to test one app for sure.');
  notes.push('adb: the command is in double quotes so the device shell gets the & between parameters unbroken; do not remove them. In Windows cmd, the same line works as is.');

  const rows = [
    ['Scheme', sch, sch],
    ['Host', h || (authority ? `(none; "${tryDecode(authority)}" read as host)` : '(none)'), authority || '–'],
    ['Path', p || '(none)', restPath || encPath || '–'],
    ...q.map(([k, v]) => [`Parameter ${k}`, v, `${encSeg(k)}=${encSeg(v)}`]),
    ...(frag ? [['Fragment', frag, encFrag]] : []),
  ];
  return {
    values: [
      { label: 'Deep link', value: url, tone: warnings.length ? 'warn' : 'ok' },
      { label: 'Length', value: url.length, unit: 'chars' },
      { label: 'Kind', value: https ? 'App Link / Universal Link' : 'Custom scheme', hint: https ? 'verified: opens the app directly' : 'unverified: any app may claim it' },
    ],
    warnings, notes,
    tables: [{ title: 'The link', columns: ['Deep link'], rows: [[url]] }, { title: 'Parts, as typed and as encoded', columns: ['Part', 'Value', 'In the link'], rows }],
    texts,
  };
}
