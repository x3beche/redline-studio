// systemd Unit & udev Rule Builder.
//
// Unit mode reads a .service file, checks it against what systemd.service(5),
// systemd.unit(5), systemd.exec(5) and systemd.special(7) document, and
// works out the unit's place in the boot: what it is ordered after and
// before, what it pulls in, and which target pulls it in (with the implicit
// dependencies DefaultDependencies=yes adds).
//
// udev mode reads `udevadm info -a -n /dev/X` (the device, then each parent
// up to the root, with their keys), takes the match keys chosen from it and
// writes the rule. udev(7): KERNEL, SUBSYSTEM, DRIVER, ATTR{} match the
// device itself; KERNELS, SUBSYSTEMS, DRIVERS, ATTRS{} search the device
// and its parents, and all of them in one rule must match the same device -
// which is why udevadm says "attributes from one single parent device".
//
// The rules below are written from those manual pages; no systemd or udev
// source is reproduced.

import { parseUnit, listOf, lastOf, escapePath } from './unitfile.js';

// ---------------- unit: reference data ----------------
// systemd.unit(5) [Unit] and [Install] options.
const UNIT_KEYS = new Set(['Description', 'Documentation', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Upholds', 'Conflicts',
  'Before', 'After', 'OnFailure', 'OnSuccess', 'PropagatesReloadTo', 'ReloadPropagatedFrom', 'PropagatesStopTo', 'StopPropagatedFrom',
  'JoinsNamespaceOf', 'RequiresMountsFor', 'WantsMountsFor', 'OnFailureJobMode', 'OnSuccessJobMode', 'IgnoreOnIsolate', 'StopWhenUnneeded', 'RefuseManualStart',
  'RefuseManualStop', 'AllowIsolate', 'DefaultDependencies', 'SurviveFinalKillSignal', 'CollectMode', 'FailureAction', 'SuccessAction',
  'FailureActionExitStatus', 'SuccessActionExitStatus', 'JobTimeoutSec', 'JobRunningTimeoutSec', 'JobTimeoutAction', 'JobTimeoutRebootArgument',
  'StartLimitIntervalSec', 'StartLimitBurst', 'StartLimitAction', 'RebootArgument', 'SourcePath']);
const INSTALL_KEYS = new Set(['WantedBy', 'RequiredBy', 'UpheldBy', 'Alias', 'Also', 'DefaultInstance']);
// systemd.service(5) [Service] options; systemd.exec(5), .kill(5) and
// .resource-control(5) options are recognised by prefix below.
const SERVICE_KEYS = new Set(['Type', 'ExitType', 'RemainAfterExit', 'GuessMainPID', 'PIDFile', 'BusName', 'ExecStart', 'ExecStartPre',
  'ExecStartPost', 'ExecCondition', 'ExecReload', 'ExecStop', 'ExecStopPost', 'RestartSec', 'RestartSteps', 'RestartMaxDelaySec',
  'TimeoutStartSec', 'TimeoutStopSec', 'TimeoutAbortSec', 'TimeoutSec', 'TimeoutStartFailureMode', 'TimeoutStopFailureMode', 'RuntimeMaxSec',
  'RuntimeRandomizedExtraSec', 'WatchdogSec', 'Restart', 'RestartMode', 'SuccessExitStatus', 'RestartPreventExitStatus', 'RestartForceExitStatus',
  'RootDirectoryStartOnly', 'NonBlocking', 'NotifyAccess', 'Sockets', 'FileDescriptorStoreMax', 'FileDescriptorStorePreserve',
  'USBFunctionDescriptors', 'USBFunctionStrings', 'OOMPolicy', 'OpenFile', 'ReloadSignal', 'User', 'Group', 'DynamicUser',
  'SupplementaryGroups', 'WorkingDirectory', 'RootDirectory', 'RootImage', 'UMask', 'Nice', 'Slice', 'Delegate', 'KillMode', 'KillSignal',
  'SendSIGKILL', 'SendSIGHUP', 'FinalKillSignal', 'WatchdogSignal', 'SyslogIdentifier', 'SyslogFacility', 'SyslogLevel', 'TTYPath', 'TTYReset',
  'TTYVHangup', 'TTYVTDisallocate', 'IgnoreSIGPIPE', 'NoNewPrivileges', 'SecureBits', 'Personality', 'LockPersonality', 'KeyringMode',
  'OOMScoreAdjust', 'TimerSlackNSec', 'CoredumpFilter', 'UtmpIdentifier', 'UtmpMode', 'PAMName', 'SELinuxContext', 'AppArmorProfile',
  'SmackProcessLabel', 'MountFlags', 'MountAPIVFS', 'NUMAPolicy', 'NUMAMask', 'StartLimitInterval', 'StartLimitBurst', 'StartLimitAction',
  'FailureAction', 'SuccessAction', 'RebootArgument', 'PermissionsStartOnly', 'CPUAffinity', 'StandardInput', 'StandardOutput',
  'StandardError', 'StandardInputText', 'StandardInputData', 'DevicePolicy', 'DeviceAllow', 'Accounting']);
const SERVICE_PREFIX = /^(Limit|Memory|CPU|IO|Tasks|Protect|Private|Restrict|Timeout|Kill|Standard|Log|Runtime|State|Cache|Logs|Configuration|ReadWrite|ReadOnly|Inaccessible|Exec|NoExec|Bind|Environment|PassEnvironment|UnsetEnvironment|Capability|Ambient|SystemCall|Socket|IPAddress|IPIngress|IPEgress|IPAccounting|BPF|Startup|Allowed|Managed|Management|Default|Load|Set|Import|Credential|Temporary|Mount|Extension|Root|Network|Coredump|Syslog|DisableController|OOM|NUMA|Delegate)/;
const TYPES = ['simple', 'exec', 'forking', 'oneshot', 'notify', 'notify-reload', 'dbus', 'idle'];
const RESTARTS = ['no', 'on-success', 'on-failure', 'on-abnormal', 'on-watchdog', 'on-abort', 'always'];
// systemd.special(7): "passive" units are pulled in by the provider, a
// consumer only orders itself after them.
const PASSIVE = new Set(['network.target', 'network-pre.target', 'nss-lookup.target', 'nss-user-lookup.target', 'time-set.target',
  'time-sync.target', 'remote-fs-pre.target', 'local-fs-pre.target', 'cryptsetup-pre.target', 'first-boot-complete.target', 'getty-pre.target']);
// Always part of a normal boot; ordering after them without Wants= is fine.
const ALWAYS = new Set(['sysinit.target', 'basic.target', 'local-fs.target', 'remote-fs.target', 'sockets.target', 'timers.target', 'paths.target',
  'multi-user.target', 'default.target', 'systemd-udevd.service', 'systemd-journald.service', 'systemd-tmpfiles-setup.service', 'dbus.service', 'dbus.socket',
  'systemd-modules-load.service', 'systemd-sysctl.service', 'systemd-remount-fs.service', 'systemd-user-sessions.service', 'swap.target', 'slices.target']);
// The boot's own chain, from systemd.special(7) and bootup(7), so the graph
// can place what the unit names.
const CHAIN = [['local-fs-pre.target', 'local-fs.target'], ['local-fs.target', 'sysinit.target'], ['sysinit.target', 'basic.target'],
  ['sockets.target', 'basic.target'], ['timers.target', 'basic.target'], ['basic.target', 'multi-user.target'], ['multi-user.target', 'graphical.target'],
  ['network-pre.target', 'network.target'], ['network.target', 'network-online.target'], ['basic.target', 'network-online.target'],
  ['sysinit.target', 'time-set.target'], ['time-set.target', 'time-sync.target'], ['network-online.target', 'remote-fs.target'],
  ['basic.target', 'dbus.service'], ['dbus.socket', 'dbus.service'], ['sockets.target', 'dbus.service']];
// Hardening switches (systemd.exec(5) "Sandboxing" and "Security"); what
// `systemd-analyze security` weighs most for a typical daemon.
export const HARDENING = [
  ['NoNewPrivileges', 'yes', 'no setuid gains'],
  ['ProtectSystem', 'strict', '/usr, /etc read-only (strict: all)'],
  ['ProtectHome', 'yes', 'no /home, /root'],
  ['PrivateTmp', 'yes', 'own /tmp'],
  ['PrivateDevices', 'yes', 'no raw devices'],
  ['ProtectKernelTunables', 'yes', '/proc/sys read-only'],
  ['ProtectKernelModules', 'yes', 'no module loading'],
  ['ProtectKernelLogs', 'yes', 'no kmsg'],
  ['ProtectControlGroups', 'yes', 'cgroupfs read-only'],
  ['ProtectClock', 'yes', 'no clock set'],
  ['RestrictRealtime', 'yes', 'no RT scheduling'],
  ['RestrictSUIDSGID', 'yes', 'no setuid files'],
  ['LockPersonality', 'yes', 'no personality()'],
  ['MemoryDenyWriteExecute', 'yes', 'no W+X memory'],
  ['RestrictNamespaces', 'yes', 'no new namespaces'],
  ['SystemCallArchitectures', 'native', 'native syscalls only'],
];
const DEVNODE = /\/dev\/(tty[A-Za-z]*\d+|ttyUSB\d+|ttyACM\d+|ttymxc\d+|ttyS\d+|ttyAMA\d+|i2c-\d+|spidev[\d.]+|gpiochip\d+|can\d+|video\d+|watchdog\d*|mtd\w*|mmcblk\w*|sd[a-z]\d*|hidraw\d+|input\/\w+|serial\/[\w/-]+|snd\/\w+|fb\d+|dri\/\w+|[a-z][\w-]*)/;

const unitType = (n) => (/\.([a-z]+)$/.exec(n)?.[1] || 'service');

// ---------------- unit mode ----------------
function lintUnit(input) {
  const name = String(input.unitName || 'my.service').trim() || 'my.service';
  const text = String(input.unit ?? '');
  const p = parseUnit(text);
  const F = [];   // findings: {sev, line, msg}
  const add = (sev, line, msg) => F.push({ sev, line: line || 0, msg });
  const first = (sec, key) => p.entries.find((e) => e.section === sec && e.key === key);
  const lineOf = (sec, key) => first(sec, key)?.line || 0;
  const all = (sec, key) => p.entries.filter((e) => e.section === sec && e.key === key);

  if (!/\.(service|socket|timer|path|mount|target)$/.test(name)) add('warn', 0, `"${name}" has no unit suffix: save it as ${name}.service, systemd loads units by their full file name.`);
  if (!p.entries.length) add('error', 0, 'Nothing to read: paste a unit file with [Unit], [Service] and [Install] sections.');
  for (const j of p.junk) {
    add('error', j.line, j.section == null ? `"${j.text.trim()}" is outside any [Section]; systemd ignores it.` : `"${j.text.trim()}" is not a Key=value line; systemd ignores it.`);
  }
  for (const s of p.sections) {
    if (!['Unit', 'Service', 'Install'].includes(s.name) && !/^X-/.test(s.name)) {
      add(['Socket', 'Timer', 'Path', 'Mount'].includes(s.name) ? 'warn' : 'error', s.line,
        ['Socket', 'Timer', 'Path', 'Mount'].includes(s.name) ? `[${s.name}] belongs in a .${s.name.toLowerCase()} unit, not in this .service file.` : `[${s.name}] is not a section systemd knows (typo?); its settings are ignored. Custom sections start with X-.`);
    }
  }
  // wrong section / unknown key
  for (const e of p.entries) {
    const known = (sec, k) => (sec === 'Unit' ? UNIT_KEYS.has(k) || /^(Condition|Assert)/.test(k)
      : sec === 'Install' ? INSTALL_KEYS.has(k) : SERVICE_KEYS.has(k) || SERVICE_PREFIX.test(k));
    if (e.section == null) { add('error', e.line, `${e.key}= comes before any [Section] header; systemd ignores it.`); continue; }
    if (/^X-/.test(e.section) || !['Unit', 'Service', 'Install'].includes(e.section)) continue;
    if (known(e.section, e.key)) continue;
    const home = ['Unit', 'Service', 'Install'].find((s) => s !== e.section && known(s, e.key));
    if (e.key === 'StartLimitIntervalSec' && e.section === 'Service') {
      add('warn', e.line, 'StartLimitIntervalSec= belongs in [Unit] (moved there in systemd 230); in [Service] only the old StartLimitInterval= name is still read. Move it, with StartLimitBurst=.');
    } else if (home) {
      add('error', e.line, `${e.key}= is a [${home}] setting; in [${e.section}] systemd logs "Unknown key name" and ignores it.`);
    } else {
      add('warn', e.line, `${e.key}= is not a [${e.section}] setting systemd documents (typo?); it would be ignored.`);
    }
  }

  const type = lastOf(p, 'Service', 'Type') || (lastOf(p, 'Service', 'BusName') ? 'dbus' : 'simple');
  const restart = lastOf(p, 'Service', 'Restart') || 'no';
  const execs = all('Service', 'ExecStart').filter((e) => e.value);
  const hasService = p.sections.some((s) => s.name === 'Service');
  if (!TYPES.includes(type)) add('error', lineOf('Service', 'Type'), `Type=${type} is not one of ${TYPES.join(', ')}.`);
  if (!RESTARTS.includes(restart)) add('error', lineOf('Service', 'Restart'), `Restart=${restart} is not one of ${RESTARTS.join(', ')}.`);
  if (hasService || /\.service$/.test(name)) {
    if (!execs.length && !lastOf(p, 'Service', 'ExecStop') && !lastOf(p, 'Unit', 'SuccessAction')) {
      add('error', lineOf('Service', 'Type') || p.sections.find((s) => s.name === 'Service')?.line, 'No ExecStart=: systemd refuses to load a service with no ExecStart=, ExecStop= or SuccessAction=.');
    }
    if (execs.length > 1 && type !== 'oneshot') add('error', execs[1].line, `${execs.length} ExecStart= lines: only Type=oneshot may have more than one; systemd refuses this unit. Use ExecStartPre= for the earlier steps.`);
  }
  for (const e of execs) {
    const cmd = e.value.replace(/^[-@:+!]+/, '');
    const prog = cmd.split(/\s+/)[0] || '';
    if (prog && !prog.startsWith('/')) add('note', e.line, `ExecStart= runs "${prog}" by name: systemd 239 and later look it up in a fixed path (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin), older ones need an absolute path.`);
    if (/(^|\s)&\s*$/.test(cmd)) add('error', e.line, 'ExecStart= ends with "&": there is no shell, so "&" is passed to the program as an argument. Run it in the foreground (Type=simple/exec) or use Type=forking with a daemon that forks itself.');
    else if (/[|;<>]|&&|\$\(|`/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ''))) add('warn', e.line, 'ExecStart= uses shell syntax (| ; > && $( )), but systemd runs the command without a shell. Wrap it: ExecStart=/bin/sh -c \'...\', or better, put it in a script.');
  }
  if (type === 'forking' && !lastOf(p, 'Service', 'PIDFile')) add('warn', lineOf('Service', 'Type'), 'Type=forking without PIDFile=: systemd has to guess the main process (GuessMainPID=). Give PIDFile=, or run the program in the foreground with Type=simple or exec.');
  if ((type === 'notify' || type === 'notify-reload')) add('note', lineOf('Service', 'Type'), `Type=${type}: the program must send READY=1 with sd_notify(); if it never does, the start fails after TimeoutStartSec= (90 s by default).`);
  if (type === 'dbus' && !lastOf(p, 'Service', 'BusName')) add('error', lineOf('Service', 'Type'), 'Type=dbus needs BusName=.');
  if (type === 'oneshot' && (restart === 'always' || restart === 'on-success')) add('error', lineOf('Service', 'Restart'), `Type=oneshot with Restart=${restart}: systemd refuses it (only no, on-failure, on-abnormal, on-watchdog and on-abort are allowed for oneshot).`);
  if (type === 'oneshot' && lastOf(p, 'Service', 'RemainAfterExit') == null) add('note', lineOf('Service', 'Type'), 'Type=oneshot without RemainAfterExit=yes: the unit goes back to inactive when the command ends, so units that Require= it see it as stopped. Add RemainAfterExit=yes if it sets something up.');
  if (type === 'simple' && execs.length) add('note', lineOf('Service', 'Type') || execs[0].line, 'Type=simple counts as started the moment systemd forks, even if the binary is missing. Type=exec (systemd 240+) waits for exec() and reports a bad path as a failed start.');
  if (restart !== 'no' && !lastOf(p, 'Service', 'RestartSec')) {
    add('warn', lineOf('Service', 'Restart'), `Restart=${restart} without RestartSec=: systemd waits only 100 ms, and after StartLimitBurst= (5) starts within StartLimitIntervalSec= (10 s) it gives up for good. Set RestartSec=2 or more, and StartLimitIntervalSec=0 in [Unit] if it must never give up.`);
  }
  if (lastOf(p, 'Service', 'KillMode') === 'none') add('warn', lineOf('Service', 'KillMode'), 'KillMode=none is deprecated: processes survive the stop and the next start races them. Use control-group or mixed.');
  if (lastOf(p, 'Service', 'PermissionsStartOnly')) add('warn', lineOf('Service', 'PermissionsStartOnly'), 'PermissionsStartOnly= is deprecated; prefix single Exec lines with "+" to run them with full privileges.');

  // dependencies
  const rel = {};
  for (const k of ['After', 'Before', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Upholds', 'Conflicts']) rel[k] = listOf(p, 'Unit', k);
  for (const k of ['WantedBy', 'RequiredBy', 'UpheldBy']) rel[k] = listOf(p, 'Install', k);
  const pulls = new Set([...rel.Wants, ...rel.Requires, ...rel.Requisite, ...rel.BindsTo, ...rel.Upholds]);
  for (const u of rel.After) {
    if (u === name) { add('error', lineOf('Unit', 'After'), `After=${u}: the unit orders itself after itself.`); continue; }
    if (!pulls.has(u) && !PASSIVE.has(u) && !ALWAYS.has(u) && !/\.slice$/.test(u)) {
      add(u === 'network-online.target' ? 'warn' : 'note', entryWith(p, 'Unit', 'After', u),
        u === 'network-online.target'
          ? 'After=network-online.target without Wants=network-online.target: the ordering does nothing unless something else pulls the target in. systemd.special(7) asks for both.'
          : `After=${u} only orders; nothing here starts ${u}. Fine if ${u} is enabled on its own - otherwise add Wants=${u}.`);
    }
  }
  if (rel.After.includes('network.target') && !rel.After.includes('network-online.target')) {
    add('note', entryWith(p, 'Unit', 'After', 'network.target'), 'After=network.target only means the network stack is up, not that an address is configured or a server reachable. If the program connects out at start, use Wants= and After=network-online.target (or retry in the program).');
  }
  for (const u of rel.BindsTo) {
    if (!rel.After.includes(u)) add('warn', entryWith(p, 'Unit', 'BindsTo', u), `BindsTo=${u} without After=${u}: the unit can start before ${u} is up and is not stopped reliably when it goes. systemd.unit(5) pairs BindsTo= with After=.`);
  }
  for (const u of [...rel.Requires, ...rel.Requisite]) {
    if (!rel.After.includes(u) && !rel.Before.includes(u)) add('note', entryWith(p, 'Unit', rel.Requires.includes(u) ? 'Requires' : 'Requisite', u), `Requires=${u} without After=${u}: both start at the same time, and a failure of ${u} to start does not stop this one from starting. Add After=${u} if it must be up first.`);
  }
  for (const u of rel.Wants) {
    if (!rel.After.includes(u) && !rel.Before.includes(u) && !PASSIVE.has(u) && unitType(u) !== 'target') add('note', entryWith(p, 'Unit', 'Wants', u), `Wants=${u} without After=: both start in parallel. Add After=${u} if this unit needs it running first.`);
  }
  const both = rel.After.filter((u) => rel.Before.includes(u));
  for (const u of both) add('error', entryWith(p, 'Unit', 'Before', u), `Both After=${u} and Before=${u}: an ordering cycle; systemd breaks it by dropping a job at boot.`);
  const hasInstall = p.sections.some((s) => s.name === 'Install');
  if (!hasInstall) add('warn', 0, 'No [Install] section: `systemctl enable` has nothing to do and the unit starts only if another unit pulls it in. Add [Install] WantedBy=multi-user.target for a service that runs at boot.');
  else if (!rel.WantedBy.length && !rel.RequiredBy.length && !rel.UpheldBy.length && !listOf(p, 'Install', 'Alias').length) add('warn', p.sections.find((s) => s.name === 'Install').line, '[Install] names no WantedBy=/RequiredBy=: enabling the unit links nothing.');
  for (const t of rel.WantedBy) if (t === 'default.target') add('note', entryWith(p, 'Install', 'WantedBy', t), 'WantedBy=default.target follows whatever default.target points to (multi-user or graphical); multi-user.target is the usual choice for a system daemon.');

  // DefaultDependencies
  const defaults = !/^(no|false|0|off)$/i.test(lastOf(p, 'Unit', 'DefaultDependencies') || 'yes');
  if (!defaults) add('note', lineOf('Unit', 'DefaultDependencies'), 'DefaultDependencies=no: no implicit Requires/After=sysinit.target and basic.target, and no Conflicts/Before=shutdown.target. Only for early-boot units; this one will not be stopped cleanly at shutdown unless you add those yourself.');

  // sandboxing
  const bool = (k) => /^(yes|true|1|on|strict|full|read-only|tmpfs|invisible|noaccess|ptraceable|native)$/i.test(lastOf(p, 'Service', k) || '');
  const devs = execs.map((e) => (DEVNODE.exec(e.value) || [])[0]).filter(Boolean);
  const envDevs = listOf(p, 'Service', 'Environment').map((x) => (DEVNODE.exec(x) || [])[0]).filter(Boolean);
  const devUsed = [...new Set([...devs, ...envDevs])].filter((d) => !/^\/dev\/(null|zero|u?random|full|tty)$/.test(d));
  if (bool('PrivateDevices') && devUsed.length && !listOf(p, 'Service', 'DeviceAllow').length) {
    add('error', lineOf('Service', 'PrivateDevices'), `PrivateDevices=yes gives the service its own /dev with only null, zero, random and a few pseudo devices, but it opens ${devUsed.join(', ')}. Drop PrivateDevices=, or keep it off and use DevicePolicy=closed with DeviceAllow=${devUsed[0]} rw.`);
  }
  if (lastOf(p, 'Service', 'DevicePolicy') === 'closed' && devUsed.length && !listOf(p, 'Service', 'DeviceAllow').length) {
    add('error', lineOf('Service', 'DevicePolicy'), `DevicePolicy=closed without DeviceAllow=: ${devUsed.join(', ')} will be refused.`);
  }
  const user = lastOf(p, 'Service', 'User');
  const dyn = /^(yes|true|1)$/i.test(lastOf(p, 'Service', 'DynamicUser') || '');
  if (!user && !dyn && (hasService || /\.service$/.test(name))) add('note', 0, 'No User=: the service runs as root. Give it its own user (User=, or DynamicUser=yes), with SupplementaryGroups=dialout for serial ports.');
  if (lastOf(p, 'Service', 'ProtectSystem') === 'strict' && !listOf(p, 'Service', 'ReadWritePaths').length && !lastOf(p, 'Service', 'StateDirectory') && !lastOf(p, 'Service', 'RuntimeDirectory')) {
    add('note', lineOf('Service', 'ProtectSystem'), 'ProtectSystem=strict makes the whole file system read-only: give the service StateDirectory=/RuntimeDirectory= or ReadWritePaths= for what it writes.');
  }
  const hard = HARDENING.map(([k, v, what]) => ({ key: k, want: v, what, value: lastOf(p, 'Service', k), on: bool(k), line: lineOf('Service', k) }));
  const hardOn = hard.filter((x) => x.on).length;

  // ---------- the graph ----------
  const nodes = new Map();
  const node = (id, how) => { if (!nodes.has(id)) nodes.set(id, { id, how: new Set(), self: id === name }); if (how) nodes.get(id).how.add(how); return nodes.get(id); };
  node(name);
  const edges = [];
  const edge = (from, to, kind, implicit = false) => { edges.push({ from, to, kind, implicit }); };
  for (const u of rel.After) { node(u, 'After'); edge(u, name, 'order'); }
  for (const u of rel.Before) { node(u, 'Before'); edge(name, u, 'order'); }
  for (const k of ['Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Upholds', 'Conflicts']) for (const u of rel[k]) { node(u, k); edge(name, u, k.toLowerCase()); }
  for (const k of ['WantedBy', 'RequiredBy', 'UpheldBy']) for (const t of rel[k]) {
    node(t, k); edge(t, name, k === 'WantedBy' ? 'wants' : k === 'RequiredBy' ? 'requires' : 'upholds');
    // target units order themselves after what they want (systemd.target(5))
    if (unitType(t) === 'target' && !rel.After.includes(t)) edge(name, t, 'order', true);
  }
  if (defaults && /\.service$/.test(name)) {
    node('sysinit.target', 'default'); node('basic.target', 'default');
    if (!edges.some((e) => e.from === 'sysinit.target' && e.to === name && e.kind === 'order')) edge('sysinit.target', name, 'requires', true);
    if (!rel.After.includes('basic.target')) edge('basic.target', name, 'order', true);
  }
  if (type === 'dbus') { node('dbus.socket', 'dbus'); edge(name, 'dbus.socket', 'requires', true); edge('dbus.socket', name, 'order', true); }
  // the boot chain between the nodes that are already there
  for (const [a, b] of CHAIN) if (nodes.has(a) && nodes.has(b)) edge(a, b, 'order', true);
  // layers: longest path over ordering edges; an ordering cycle is cut and reported
  const ids = [...nodes.keys()];
  const order = edges.filter((e) => e.kind === 'order');
  const layer = Object.fromEntries(ids.map((i) => [i, 0]));
  let cyc = false;
  for (let pass = 0; pass <= ids.length; pass++) {
    let moved = false;
    for (const e of order) if (layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; moved = true; }
    if (!moved) break;
    if (pass === ids.length) cyc = true;
  }
  if (cyc && !both.length) add('error', lineOf('Unit', 'Before') || lineOf('Unit', 'After'), 'The After=/Before= lines form an ordering cycle with the boot targets; systemd will drop a job to break it. Check Before= on targets this unit also comes after.');
  if (cyc) for (const i of ids) layer[i] = Math.min(layer[i], ids.length);
  const graph = {
    self: name,
    nodes: ids.map((i) => ({ id: i, self: nodes.get(i).self, how: [...nodes.get(i).how], layer: layer[i], type: unitType(i) })),
    edges,
  };

  // ---------- output ----------
  const counts = { error: F.filter((f) => f.sev === 'error').length, warn: F.filter((f) => f.sev === 'warn').length, note: F.filter((f) => f.sev === 'note').length };
  F.sort((a, b) => ({ error: 0, warn: 1, note: 2 }[a.sev] - { error: 0, warn: 1, note: 2 }[b.sev]) || a.line - b.line);
  const at = (f) => (f.line ? `line ${f.line}: ` : '');
  const cleaned = text.replace(/\s+$/, '') + '\n';
  const install = [
    `# on the target`,
    `install -m 0644 ${name} /etc/systemd/system/${name}`,
    'systemctl daemon-reload',
    `systemd-analyze verify /etc/systemd/system/${name}`,
    `systemctl enable --now ${name}`,
    `systemd-analyze security ${name}      # exposure score of the sandboxing`,
    `journalctl -u ${name} -b`,
    '',
    '# in a Yocto recipe',
    'inherit systemd',
    `SRC_URI += "file://${name}"`,
    `SYSTEMD_SERVICE:\${PN} = "${name}"`,
    'SYSTEMD_AUTO_ENABLE = "enable"',
    'do_install:append() {',
    `    install -D -m 0644 \${WORKDIR}/${name} \${D}\${systemd_system_unitdir}/${name}`,
    '}',
  ];
  return {
    values: [
      { label: 'Type', value: type },
      { label: 'Restart', value: restart },
      { label: 'Errors', value: counts.error, tone: counts.error ? 'bad' : 'ok' },
      { label: 'Warnings', value: counts.warn, tone: counts.warn ? 'warn' : 'ok' },
      { label: 'Hardening switches on', value: `${hardOn} of ${HARDENING.length}`, tone: hardOn >= 8 ? 'ok' : hardOn >= 4 ? 'warn' : 'bad' },
      { label: 'Pulled in by', value: [...rel.WantedBy, ...rel.RequiredBy].join(' ') || 'nothing (not enabled)' },
    ],
    tables: [
      { title: 'Findings', columns: ['Severity', 'Line', 'Finding'], rows: F.map((f) => [f.sev, f.line || '', f.msg]) },
      { title: 'Dependencies', columns: ['Unit', 'Relations', 'Boot order step'], rows: graph.nodes.filter((n) => !n.self).map((n) => [n.id, n.how.join(', ') || 'boot chain', n.layer]) },
    ],
    texts: [{ title: name, body: cleaned, lang: 'ini' }, { title: 'Install & check', body: install.join('\n') + '\n', lang: 'sh' }],
    warnings: F.filter((f) => f.sev !== 'note').map((f) => at(f) + f.msg),
    notes: [...F.filter((f) => f.sev === 'note').map((f) => at(f) + f.msg),
      ...(defaults ? ['Implicit for a service with DefaultDependencies=yes: Requires= and After=sysinit.target, After=basic.target, Conflicts= and Before=shutdown.target (systemd.service(5)).'] : [])],
    draw: { mode: 'unit', name, type, restart, findings: F, graph, hard, rel, sections: p.sections.map((s) => s.name), lineCount: p.lineCount, user: user || (dyn ? 'dynamic' : ''), defaults },
  };
}

function entryWith(p, sec, key, item) {
  return p.entries.find((e) => e.section === sec && e.key === key && e.value.split(/\s+/).includes(item))?.line || 0;
}

// ---------------- udev mode ----------------
const DEVICE_KEYS = /^(KERNEL|SUBSYSTEM|DRIVER|ATTR\{[^}]+\}|ENV\{[^}]+\}|ACTION|NAME|DEVPATH|TAG|TEST\{[^}]*\}|PROGRAM|RESULT)$/;
const PARENT_KEYS = /^(KERNELS|SUBSYSTEMS|DRIVERS|ATTRS\{[^}]+\}|TAGS)$/;
// Values that change on every plug-in or boot; matching on them breaks the rule.
const VOLATILE = /^(ATTRS?\{(devnum|busnum|urbnum|devpath|power\/[^}]*|remove|authorized|avoid_reset_quirk|ltm_capable|quirks|rx_lanes|tx_lanes|runtime\w*|dev|uevent)\})$/;
const GOOD = /^(ATTRS?\{(idVendor|idProduct|serial|manufacturer|product|interface|bInterfaceNumber)\}|SUBSYSTEMS?|KERNEL|DRIVERS)$/;

/** `udevadm info -a` -> [{level, path, parent, keys: [{key, value}]}]; also `udevadm info` (P:/E: lines) as ENV{} keys. */
export function parseUdevadm(text) {
  const blocks = [];
  const unread = [];
  let cur = null;
  const props = { level: 0, path: '', parent: false, keys: [], env: true };
  String(text ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (!t) return;
    const head = /^looking at (parent )?device '([^']*)':?$/.exec(t);
    if (head) { cur = { level: blocks.length, path: head[2], parent: !!head[1], keys: [] }; blocks.push(cur); return; }
    const kv = /^([A-Z]+(?:\{[^}]+\})?)=="(.*)"$/.exec(t);
    if (kv && cur) { cur.keys.push({ key: kv[1], value: kv[2] }); return; }
    const pe = /^([PENSLQRUVDMJ]):\s*(.*)$/.exec(t);
    if (pe) {
      if (pe[1] === 'P') props.path = pe[2];
      if (pe[1] === 'E') { const m = /^([^=]+)=(.*)$/.exec(pe[2]); if (m) props.keys.push({ key: `ENV{${m[1]}}`, value: m[2] }); }
      return;
    }
    if (/^(Udevadm info starts|walks up the chain|found, all possible|A rule to match|and the attributes from one)/.test(t)) return;
    unread.push({ line: i + 1, text: t.slice(0, 100) });
  });
  if (props.keys.length) {
    if (blocks.length) { blocks[0].keys.push(...props.keys.filter((k) => !/^ENV\{(DEVPATH|SEQNUM|USEC_INITIALIZED|ACTION|MAJOR|MINOR|DEVLINKS|TAGS|CURRENT_TAGS)\}$/.test(k.key))); }
    else blocks.push({ level: 0, path: props.path, parent: false, keys: props.keys, env: true });
  }
  return { blocks, unread };
}

function globRe(v) {
  // udev(7) patterns: * ? [chars] and | between alternatives
  return new RegExp('^(' + String(v).split('|').map((alt) => alt.replace(/[.+^${}()\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|') + ')$');
}
const plainKey = (k) => k.replace(/^KERNELS$/, 'KERNEL').replace(/^SUBSYSTEMS$/, 'SUBSYSTEM').replace(/^DRIVERS$/, 'DRIVER').replace(/^ATTRS\{/, 'ATTR{');

function parsePicks(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\n|,(?=\s*[A-Z]+(?:\{[^}]*\})?\s*[!=]=)/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^([A-Z]+(?:\{[^}]+\})?)\s*(==|!=)\s*"(.*)"$/.exec(t);
    out.push(m ? { key: m[1], op: m[2], value: m[3], raw: t } : { bad: true, raw: t });
  }
  return out;
}

function quote(v) { return '"' + String(v).replace(/"/g, '\\"') + '"'; }

function udevMode(input) {
  const { blocks, unread } = parseUdevadm(input.udevInfo);
  const picks = parsePicks(input.udevPick);
  const F = [];
  const add = (sev, msg) => F.push({ sev, msg });
  if (!blocks.length) add('error', 'No "looking at device" blocks found: paste the output of `udevadm info -a -n /dev/ttyUSB0` (or of `udevadm info -q all -n ...`).');
  if (unread.length) add('warn', `${unread.length} line(s) of the udevadm output could not be read and were skipped, e.g. line ${unread[0].line}: "${unread[0].text}".`);

  // which blocks satisfy each pick
  const has = (b, key, re) => b.keys.some((k) => (k.key === key || (b.level === 0 && k.key === plainKey(key))) && re.test(k.value));
  const rows = [];
  for (const p of picks) {
    if (p.bad) { add('error', `Match "${p.raw}" is not KEY=="value"; it is left out.`); continue; }
    const re = globRe(p.value);
    const parentKey = PARENT_KEYS.test(p.key);
    const deviceKey = DEVICE_KEYS.test(p.key);
    if (!parentKey && !deviceKey) { add('error', `${p.key} is not a udev match key.`); continue; }
    const levels = blocks.filter((b) => (parentKey ? true : b.level === 0) && (p.op === '==' ? has(b, p.key, re) : !has(b, p.key, re))).map((b) => b.level);
    rows.push({ ...p, parentKey, levels });
    if (!levels.length) add('error', `${p.key}${p.op}"${p.value}" matches nothing in this device's chain; the rule would never fire.`);
    if (VOLATILE.test(p.key)) add('warn', `${p.key} changes when the device is re-plugged or the board reboots; the rule will stop matching. Match idVendor/idProduct/serial instead.`);
    if (p.key === 'KERNELS' && /^\d+-[\d.]+$/.test(p.value)) add('note', `KERNELS=="${p.value}" is the USB port path: the rule follows the physical port, not the adapter (useful for two identical adapters without serial numbers).`);
  }
  const par = rows.filter((r) => r.parentKey);
  let parentLevel = null;
  if (par.length) {
    const common = par.reduce((acc, r) => acc.filter((l) => r.levels.includes(l)), blocks.map((b) => b.level));
    if (!common.length) {
      const spread = [...new Set(par.map((r) => r.levels[0]).filter((l) => l != null))];
      add('error', `The ${par.map((r) => r.key).join(', ')} matches come from different devices in the chain (${spread.map((l) => `#${l}`).join(', ')}): udev needs every KERNELS/SUBSYSTEMS/DRIVERS/ATTRS key of one rule to match the same parent, so this rule never fires. Take them from one parent.`);
    } else parentLevel = common[0];
  }
  const dev = blocks[0];
  const devRows = rows.filter((r) => !r.parentKey);
  if (rows.length && !devRows.some((r) => /^(SUBSYSTEM|KERNEL)$/.test(r.key))) {
    add('warn', `No SUBSYSTEM== or KERNEL== on the device itself: ATTRS keys also match the parent devices' own events, so the link and permissions land on those too (the USB device under /dev/bus/usb). Add SUBSYSTEM=="${dev?.keys.find((k) => k.key === 'SUBSYSTEM')?.value || 'tty'}".`);
  }
  if (!rows.length) add('error', 'No match keys chosen yet: click keys in the device chain (SUBSYSTEM on the device, then idVendor, idProduct and serial from the USB device).');
  const hasSerial = par.some((r) => /serial\}$/.test(r.key));
  if (par.some((r) => /idVendor|idProduct/.test(r.key)) && !hasSerial) add('note', 'Matching idVendor/idProduct only: a second adapter of the same model would claim the same link. Add ATTRS{serial} if the device has one.');

  // assignments
  const symlink = String(input.symlink ?? '').trim().replace(/^\/dev\//, '');
  const mode = String(input.perm ?? '').trim();
  const group = String(input.group ?? '').trim();
  const owner = String(input.owner ?? '').trim();
  const wants = String(input.wants ?? '').trim();
  const tagSystemd = !!input.tagSystemd;
  const assigns = [];
  if (symlink) {
    if (/\s/.test(symlink)) add('warn', `SYMLINK "${symlink}" has a space: SYMLINK+= adds one link per space-separated word.`);
    if (/^(ttyUSB|ttyACM|tty)\d+$/.test(symlink)) add('warn', `SYMLINK+="${symlink}" looks like a kernel name; a link called ${symlink} can collide with a real node.`);
    assigns.push(['SYMLINK+=', symlink]);
  }
  if (mode) {
    if (!/^0?[0-7]{3}$/.test(mode)) add('error', `MODE="${mode}" is not an octal mode like 0660.`);
    else if (/[2367]$/.test(mode)) add('warn', `MODE="${mode}" lets every user write to the device; prefer 0660 with GROUP=.`);
    assigns.push(['MODE=', mode]);
  }
  if (group) assigns.push(['GROUP=', group]);
  if (owner) assigns.push(['OWNER=', owner]);
  if (tagSystemd) assigns.push(['TAG+=', 'systemd']);
  if (wants) {
    if (!tagSystemd) add('error', 'ENV{SYSTEMD_WANTS} is only read for devices tagged "systemd": turn on TAG+="systemd", or the service is never started.');
    if (!/\.(service|target|mount|socket)$/.test(wants)) add('warn', `SYSTEMD_WANTS "${wants}" is not a unit name (add .service).`);
    assigns.push(['ENV{SYSTEMD_WANTS}+=', wants]);
  }
  if (input.actionAdd && symlink) add('warn', 'ACTION=="add" with SYMLINK+=: on the next "change" event the rule does not match and udev removes the link. Leave ACTION out for links and permissions.');
  if (!assigns.length) add('warn', 'The rule assigns nothing: set a SYMLINK, MODE/GROUP or TAG.');

  let file = String(input.ruleFile ?? '').trim() || '99-local.rules';
  if (!/\.rules$/.test(file)) { add('warn', `"${file}" does not end in .rules; udev only reads *.rules files.`); }
  const prio = /^(\d+)-/.exec(file)?.[1];
  if (!prio) add('note', `"${file}" has no number prefix; rules files run in lexical order, and local rules usually start with 60- to 99- so they come after 50-udev-default.rules.`);
  else if (Number(prio) < 60 && (mode || group)) add('warn', `${file} runs before or with 50-udev-default.rules, which sets GROUP/MODE for tty and other devices and may override yours. Use a number of 60 or more.`);

  // the rule: device keys first, then the parent keys, then assignments
  const tokens = [];
  if (input.actionAdd) tokens.push({ t: 'ACTION=="add"', kind: 'device' });
  for (const r of rows.filter((x) => !x.parentKey)) tokens.push({ t: `${r.key}${r.op}${quote(r.value)}`, kind: 'device', key: r.key, ok: r.levels.length > 0 });
  for (const r of par) tokens.push({ t: `${r.key}${r.op}${quote(r.value)}`, kind: 'parent', key: r.key, ok: parentLevel != null && r.levels.includes(parentLevel) });
  for (const [k, v] of assigns) tokens.push({ t: `${k}${quote(v)}`, kind: 'assign' });
  const rule = tokens.map((x) => x.t).join(', ');
  const devNode = dev?.keys.find((k) => k.key === 'KERNEL')?.value;
  const unitName = symlink ? `${escapePath('/dev/' + symlink.split(/\s+/)[0])}.device` : '';
  const body = [`# /etc/udev/rules.d/${file}`,
    `# ${dev ? (blocks.find((b) => b.keys.some((k) => k.key === 'ATTRS{product}'))?.keys.find((k) => k.key === 'ATTRS{product}')?.value || devNode || 'device') : 'device'}${symlink ? ` -> /dev/${symlink.split(/\s+/)[0]}` : ''}`,
    rule || '# (choose match keys first)', ''].join('\n');
  const cmds = [
    `install -m 0644 ${file} /etc/udev/rules.d/${file}`,
    'udevadm control --reload-rules',
    devNode ? `udevadm trigger --action=change /dev/${devNode}` : 'udevadm trigger --action=change --subsystem-match=tty',
    devNode ? `udevadm test $(udevadm info -q path -n /dev/${devNode}) 2>&1 | grep -i -e '${file}' -e symlink` : '',
    symlink ? `ls -l /dev/${symlink.split(/\s+/)[0]}` : '',
    '',
    '# a service that lives and dies with the device',
    ...(unitName ? [`#   [Unit]  BindsTo=${unitName}  After=${unitName}`, `#   [Install]  WantedBy=${unitName}`, '#   (needs TAG+="systemd" on the rule so systemd sees the .device unit)'] : ['#   give the rule a SYMLINK and TAG+="systemd" to get a stable .device unit']),
    '',
    '# in a Yocto recipe',
    `SRC_URI += "file://${file}"`,
    'do_install:append() {',
    `    install -D -m 0644 \${WORKDIR}/${file} \${D}\${sysconfdir}/udev/rules.d/${file}`,
    '}',
    `FILES:\${PN} += "\${sysconfdir}/udev/rules.d/${file}"`,
  ].filter((l) => l !== null);
  const order = { error: 0, warn: 1, note: 2 };
  F.sort((a, b) => order[a.sev] - order[b.sev]);
  return {
    values: [
      { label: 'Device', value: devNode ? `/dev/${devNode}` : '–' },
      { label: 'Parents in chain', value: Math.max(0, blocks.length - 1) },
      { label: 'Match keys', value: rows.length, tone: rows.length ? 'ok' : 'bad' },
      { label: 'Parent matched', value: parentLevel != null ? `#${parentLevel} ${blocks[parentLevel]?.keys.find((k) => k.key === 'SUBSYSTEMS')?.value || ''}`.trim() : (par.length ? 'none - rule never fires' : 'device only'), tone: par.length && parentLevel == null ? 'bad' : 'ok' },
      { label: 'systemd unit', value: unitName || '–' },
    ],
    tables: [{ title: 'Match keys', columns: ['Key', 'Value', 'Matches at', 'Checked'], rows: rows.map((r) => [r.key, r.value, r.levels.map((l) => `#${l}`).join(' ') || 'nowhere', r.parentKey ? (parentLevel != null && r.levels.includes(parentLevel) ? 'same parent' : 'not with the others') : (r.levels.length ? 'device' : 'no match')]) }],
    texts: [{ title: file, body, lang: 'udev' }, { title: 'Install & test', body: cmds.join('\n') + '\n', lang: 'sh' }],
    warnings: F.filter((f) => f.sev !== 'note').map((f) => f.msg),
    notes: [...F.filter((f) => f.sev === 'note').map((f) => f.msg),
      'udev(7): RUN+= is for short commands only - udev kills long-running ones. Start daemons with TAG+="systemd" and ENV{SYSTEMD_WANTS} instead.'],
    draw: { mode: 'udev', blocks: blocks.map((b) => ({ level: b.level, path: b.path, parent: b.parent, env: !!b.env, keys: b.keys.map((k) => ({ ...k, volatile: VOLATILE.test(k.key), good: GOOD.test(k.key) })) })),
      picks: rows.map((r) => ({ key: r.key, op: r.op, value: r.value, levels: r.levels, parentKey: r.parentKey })), parentLevel, tokens, file, unitName, findings: F, unread: unread.length },
  };
}

export function run(input) {
  return input.mode === 'udev' ? udevMode(input) : lintUnit(input);
}
