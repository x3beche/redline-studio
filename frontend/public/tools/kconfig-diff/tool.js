// Kconfig Diff: two kernel (or U-Boot, Buildroot, BusyBox) .config files
// compared symbol by symbol, grouped by subsystem, and the chosen changes
// written as a config fragment for SRC_URI += "file://<name>.cfg".
//
// What a line means, as scripts/kconfig/confdata.c writes and reads it:
//   CONFIG_FOO=y | =m | =n        bool / tristate (=n is legal in a fragment)
//   CONFIG_FOO="text"              string (backslash escapes \" and \\)
//   CONFIG_FOO=0x1f | =250         hex / int
//   # CONFIG_FOO is not set        the symbol is visible and off (n)
// A symbol missing from a full .config (written by make / olddefconfig) was
// not visible: its "depends on" was false, so conf wrote nothing for it. A
// symbol missing from a defconfig (make savedefconfig) is at its default, so
// "missing" means "unknown here", not "off". That difference is kept.
//
// The fragment follows merge_config.sh (scripts/kconfig/merge_config.sh):
// later values win, "# CONFIG_X is not set" turns a symbol off, and after
// "make olddefconfig" any symbol whose dependencies are not met is dropped
// silently - merge_config.sh prints "Value requested for X not in final
// .config", and linux-yocto's kernel_configcheck reports the same.

const MAX_TABLE = 160;     // rows in the agent-visible table
const MAX_UNREAD = 8;      // unreadable lines quoted per file

// Symbols the toolchain sets (init/Kconfig: CC_VERSION_TEXT, CC_IS_GCC,
// GCC_VERSION ... from scripts/Kconfig.include "$(shell ...)" calls). A
// fragment cannot change them, and they differ whenever the compiler does.
const TOOLCHAIN = /^(CC_VERSION_TEXT|CC_IS_GCC|CC_IS_CLANG|GCC_VERSION|CLANG_VERSION|LD_VERSION|LLD_VERSION|AS_VERSION|AS_IS_GNU|AS_IS_LLVM|LD_IS_BFD|LD_IS_LLD|RUSTC_VERSION|RUSTC_LLVM_VERSION|BINDGEN_VERSION_TEXT|PAHOLE_VERSION|CC_CAN_LINK|CC_CAN_LINK_STATIC|CC_HAS_[A-Z0-9_]+|AS_HAS_[A-Z0-9_]+|LD_CAN_[A-Z0-9_]+|TOOLS_SUPPORT_RELR|CC_HAVE_[A-Z0-9_]+|GCC_ASM_GOTO_OUTPUT_WORKAROUND|GCC_SUPPORTS_[A-Z0-9_]+|CC_NO_[A-Z0-9_]+|RUST_IS_AVAILABLE|GCC10_NO_ARRAY_BOUNDS|GCC_PLUGINS_[A-Z0-9_]*|ARCH_SUPPORTS_[A-Z0-9_]+|ARCH_HAS_[A-Z0-9_]+|HAVE_[A-Z0-9_]+|ARCH_WANT_[A-Z0-9_]+)$/;

// Subsystem groups: first match wins. Linux symbol names follow the
// directory's Kconfig prefix (drivers/usb -> USB_, sound -> SND_ ...).
const UBOOT_GROUPS = [
  [/^CMD_/, 'Commands'],
  [/^(SPL|TPL|VPL)(_|$)/, 'SPL / TPL'],
  [/^ENV_|^SYS_REDUNDAND_ENVIRONMENT|^ENV$/, 'Environment'],
  [/^(BOOT|AUTOBOOT|BOOTDELAY|BOOTCOMMAND|BOOTARGS|BOOTSTD|DISTRO_DEFAULTS|BOOTCOUNT|BOOTMETH|FIT|LEGACY_IMAGE|SUPPORT_RAW_INITRD|USE_BOOTARGS|USE_BOOTCOMMAND|PREBOOT|USE_PREBOOT)(_|$)/, 'Boot'],
  [/^(DM|OF|DEFAULT_DEVICE_TREE|DEVICE_TREE|OF_LIST|MULTI_DTB)(_|$)/, 'Driver model & DT'],
  [/^(NET|ETH|ETHPRIME|USE_ETHPRIME|MII|PHY|PHYLIB|DM_ETH|FEC_MXC|DWC_ETH_QOS|DM_MDIO|IP_DEFRAG|TFTP\w*|BOOTP\w*)(_|$)/, 'Networking'],
  [/^(SYS|TARGET|ARCH|IMX|MX\d|SOC|NR_DRAM_BANKS|TEXT_BASE|SPL_TEXT_BASE|BOARD|SYSRESET|DISPLAY_\w+|HUSH_PARSER|CMDLINE_EDITING)(_|$)/, 'Board & SoC'],
];
const GROUPS = [
  [/^(WLAN|CFG80211|MAC80211|BRCMFMAC|BRCMUTIL|BRCM|ATH\w*|RTL8\w*|RTW\w*|MWIFIEX\w*|IWL\w*|WL\d*|RFKILL|WIRELESS)(_|$)/, 'Wireless'],
  [/^BT(_|$)/, 'Bluetooth'],
  [/^CAN(_|$)/, 'CAN'],
  [/^(USB|TYPEC|UCSI|USB4)(_|$)/, 'USB'],
  [/^(NET|INET|IPV6|IP|TCP|NETFILTER|NF|BRIDGE|VLAN|WIREGUARD|PACKET|UNIX|XFRM|NETDEVICES|ETHERNET|PHYLIB|PHYLINK|FEC|STMMAC|DWMAC|MACB|MDIO|PPP|TUN|VETH|MACVLAN|IPVLAN|8021Q|DNS_RESOLVER|NLMON|SYN_COOKIES|NETLINK)(_|$)/, 'Networking'],
  [/^(DRM|FB|BACKLIGHT|LCD|LOGO|FRAMEBUFFER|DUMMY_CONSOLE|FONT)(_|$)/, 'Graphics'],
  [/^(MEDIA|VIDEO|V4L|V4L2|DVB|VIDEOBUF2|CEC)(_|$)/, 'Media'],
  [/^(SND|SOUND|AC97)(_|$)/, 'Sound'],
  [/^(DEBUG|KASAN|KCSAN|UBSAN|KGDB|FTRACE|TRACING|TRACER|FUNCTION|PROVE|LOCKDEP|MAGIC_SYSRQ|PANIC|KALLSYMS|DYNAMIC_DEBUG|SCHED_DEBUG|FRAME_POINTER|STACKTRACE|KPROBES|UPROBES|PRINTK|EARLY_PRINTK|GDB|DETECT_HUNG_TASK|SOFTLOCKUP_DETECTOR|HARDLOCKUP_DETECTOR|BOOTPARAM|KCOV|FAULT_INJECTION|RUNTIME_TESTING_MENU|STRIP_ASM_SYMS|SLUB_DEBUG|PAGE_POISONING|KFENCE|BUG|PROFILING|PERF_EVENTS)(_|$)/, 'Debug & tracing'],
  [/^(ROOT_NFS|NFS\w*|CIFS|SMB\w*|EXT[234]\w*|BTRFS|XFS|F2FS|SQUASHFS|OVERLAY|VFAT|FAT|MSDOS|NTFS\w*|EXFAT|TMPFS|PROC|SYSFS|JFFS2|UBIFS|FUSE|AUTOFS|ISO9660|QUOTA|FS|CONFIGFS|EROFS|CRAMFS|ROMFS|NLS|FANOTIFY|INOTIFY\w*|DNOTIFY|FILE_LOCKING|PSTORE|9P|ECRYPT)(_|$)|_FS$/, 'File systems'],
  [/^(CRYPTO|KEYS|TRUSTED_KEYS|ENCRYPTED_KEYS|SYSTEM_TRUSTED\w*|MODULE_SIG\w*)(_|$)/, 'Crypto & keys'],
  [/^(PREEMPT|PREEMPTION|HZ|NO_HZ|SCHED|CPU_FREQ|CPU_IDLE|SMP|NR_CPUS|HOTPLUG_CPU|NUMA|RT_GROUP_SCHED|FAIR_GROUP_SCHED|TICK|HIGH_RES_TIMERS|VIRT_CPU_ACCOUNTING\w*|IRQ_TIME_ACCOUNTING|BSD_PROCESS_ACCT\w*|TASKSTATS|ENERGY_MODEL|UCLAMP\w*)(_|$)/, 'Scheduler & CPU'],
  [/^(PM|SUSPEND|HIBERNATION|THERMAL|CPU_THERMAL|REGULATOR|POWER|BATTERY|CHARGER|ARM_PSCI\w*|DEVFREQ|PM_DEVFREQ|OPP)(_|$)/, 'Power & thermal'],
  [/^(I2C|SPI|GPIO|GPIOLIB|PINCTRL|PWM|IIO|W1|SPMI|MFD|I3C)(_|$)/, 'Buses, GPIO & MFD'],
  [/^(MMC|MTD|NAND|UBI|BLK|SCSI|ATA|SATA|NVME|MD|BLK_DEV\w*|DM_\w*|BLOCK|IOSCHED|MQ_IOSCHED\w*|ZRAM|SWAP|ZSWAP|NVMEM_\w*)(_|$)/, 'Storage'],
  [/^(SERIAL|TTY|VT|CONSOLE|HVC|UNIX98_PTYS|LEGACY_PTYS|N_GSM|RPMSG\w*|MAILBOX|IMX_MBOX)(_|$)/, 'Serial & TTY'],
  [/^(WATCHDOG|SOFT_WATCHDOG)(_|$)|_WDT$/, 'Watchdog'],
  [/^(SECURITY|AUDIT|SELINUX|APPARMOR|INTEGRITY|IMA|EVM|LSM|HARDENED\w*|STACKPROTECTOR\w*|FORTIFY_SOURCE|SECCOMP|STRICT_KERNEL_RWX|STRICT_MODULE_RWX|RANDOMIZE_BASE|INIT_STACK\w*|INIT_ON\w*|SLAB_FREELIST\w*|SHUFFLE_PAGE_ALLOCATOR|STATIC_USERMODEHELPER|DEFAULT_SECURITY\w*)(_|$)/, 'Security'],
  [/^(CGROUP\w*|NAMESPACES|MEMCG|BPF\w*|CPUSETS|USER_NS|PID_NS|NET_NS|IPC_NS|UTS_NS|TIME_NS|CHECKPOINT_RESTORE|BLK_CGROUP|CFS_BANDWIDTH|RT_GROUP)(_|$)/, 'Containers & BPF'],
  [/^(MODULES?|MODVERSIONS|MODULE_\w+)(_|$)/, 'Modules'],
  [/^(KVM|VIRTIO|VIRTUALIZATION|XEN|HYPERV|VHOST)(_|$)/, 'Virtualization'],
  [/^(PCI|PCIE|PCIEPORTBUS)(_|$)/, 'PCI'],
  [/^(INPUT|KEYBOARD|MOUSE|TOUCHSCREEN|HID|JOYSTICK|UHID)(_|$)/, 'Input & HID'],
  [/^(LEDS?|NEW_LEDS)(_|$)/, 'LEDs'],
  [/^(RTC|NVMEM|EEPROM)(_|$)/, 'RTC & NVMEM'],
  [/^(CLK|COMMON_CLK|RESET|PHY|GENERIC_PHY|REMOTEPROC|RPMSG|DMADEVICES|DMA|IMX_SDMA|MXC_CLK|TIMER_OF|CLKSRC\w*)(_|$)/, 'Clocks, DMA & PHY'],
  [/^(ARCH|ARM64|ARM|SOC|CPU|MACH|PLAT|IMX|MXC|ROCKCHIP|SUNXI|BCM|TEGRA|QCOM|RENESAS|STM32|AM\d+|TI|K3|RASPBERRYPI|ERRATUM|CAVIUM|FUJITSU|ARM64_\w+)(_|$)/, 'Platform'],
  [/^(LOCALVERSION|DEFAULT_HOSTNAME|SYSVIPC|POSIX_MQUEUE|IKCONFIG|IKHEADERS|LOG_BUF_SHIFT|LOG_CPU_MAX_BUF_SHIFT|CMDLINE|INITRAMFS|BLK_DEV_INITRD|KERNEL_\w+|RD_\w+|EXPERT|EMBEDDED|UEVENT_HELPER\w*|DEVTMPFS\w*|FW_LOADER\w*|SHMEM|MULTIUSER|SGETMASK_SYSCALL|SYSFS_SYSCALL|FHANDLE|POSIX_TIMERS|FUTEX|EPOLL|SIGNALFD|TIMERFD|EVENTFD|AIO|IO_URING|ADVISE_SYSCALLS|MEMBARRIER|KALLSYMS|RSEQ|COMPAT\w*|SYSCTL\w*|BUILD_SALT|INIT_ENV_ARG_LIMIT|WATCH_QUEUE|CROSS_MEMORY_ATTACH|AUDITSYSCALL|INITRAMFS_SOURCE|CC_OPTIMIZE_FOR_\w+|RELAY|SLUB|SLAB|SLOB|COMPAT_BRK|TRIM_UNUSED_KSYMS|OVERCOMMIT)(_|$)/, 'General setup'],
];

// Heuristic parents: a child set in the fragment whose menu symbol is off in
// B (and not turned on by the fragment) will be dropped by olddefconfig.
// These are the menus the child sits inside in mainline Kconfig.
const PARENTS = [
  [/^USB_CONFIGFS_\w+/, 'USB_CONFIGFS'],
  [/^USB_(CONFIGFS|LIBCOMPOSITE|ETH|ETH_\w+|G_\w+|MASS_STORAGE|ZERO|AUDIO|GADGETFS|FUNCTIONFS|CDC_COMPOSITE)$/, 'USB_GADGET'],
  [/^USB_SERIAL_(?!CONSOLE$)\w+/, 'USB_SERIAL'],
  [/^USB_(STORAGE|STORAGE_\w+|UAS|SERIAL|ACM|PRINTER|WDM|EHCI_HCD|EHCI_\w+|OHCI_HCD|OHCI_\w+|XHCI_HCD|XHCI_\w+|HCD_\w+|USBNET|NET_\w+|HIDDEV|DWC3_HOST|CHIPIDEA_HOST|ANNOUNCE_NEW_DEVICES|DEFAULT_PERSIST|OTG)$/, 'USB'],
  [/^USB$|^USB_GADGET$/, 'USB_SUPPORT'],
  [/^DRM_\w+/, 'DRM'],
  [/^SND_SOC_\w+/, 'SND_SOC'],
  [/^SND_(?!SOC$)\w+/, 'SND'],
  [/^BT_\w+/, 'BT'],
  [/^CAN_\w+/, 'CAN'],
  [/^MAC80211_\w+/, 'MAC80211'],
  [/^CFG80211_\w+/, 'CFG80211'],
  [/^(BRCMFMAC|BRCMUTIL|ATH\d+K|RTW88|RTW89|MWIFIEX|IWLWIFI)$/, 'WLAN'],
  [/^I2C_\w+/, 'I2C'],
  [/^SPI_\w+/, 'SPI'],
  [/^MMC_\w+/, 'MMC'],
  [/^MTD_\w+/, 'MTD'],
  [/^ROOT_NFS$/, 'NFS_FS'],
  [/^NFS_V\d\w*/, 'NFS_FS'],
  [/^EXT4_FS_\w+/, 'EXT4_FS'],
  [/^SQUASHFS_\w+/, 'SQUASHFS'],
  [/^IMX2_WDT$|^\w+_WDT$|^WATCHDOG_\w+/, 'WATCHDOG'],
  [/^IKCONFIG_PROC$/, 'IKCONFIG'],
  [/^NETFILTER_\w+|^NF_\w+|^IP_NF_\w+/, 'NETFILTER'],
  [/^IPV6_\w+/, 'IPV6'],
  [/^SPL_\w+/, 'SPL'],
  [/^GPIO_\w+/, 'GPIOLIB'],
  [/^LEDS_\w+/, 'NEW_LEDS'],
  [/^CPU_FREQ_\w+/, 'CPU_FREQ'],
  [/^MEDIA_\w+|^VIDEO_\w+/, 'MEDIA_SUPPORT'],
];

// ---------------- parsing ----------------
function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return null;
}

/** Text -> { syms: Map(name -> {v, line}), unread, dups, header, kind } */
export function parseConfig(text) {
  const syms = new Map();
  const unread = [];
  const dups = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let generated = false, uboot = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const off = /^#\s*CONFIG_([A-Za-z0-9_]+) is not set\s*$/.exec(line);
    if (off) { put(off[1], 'n', i + 1); return; }
    if (line.startsWith('#')) {
      if (/Automatically generated file; DO NOT EDIT/i.test(line)) generated = true;
      if (/U-Boot/i.test(line)) uboot = true;
      return;
    }
    const m = /^CONFIG_([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m) { unread.push({ line: i + 1, text: raw.slice(0, 120) }); return; }
    let v = m[2].trim();
    if (v.startsWith('"')) {
      const s = unquote(v);
      if (s == null) { unread.push({ line: i + 1, text: raw.slice(0, 120) + '  (unclosed quote)' }); return; }
      v = JSON.stringify(s);   // kept quoted, so strings never look like y/m/n
    } else if (!/^(y|m|n|-?\d+|0[xX][0-9a-fA-F]+)$/.test(v)) {
      unread.push({ line: i + 1, text: raw.slice(0, 120) + '  (value is not y/m/n, a number, hex or a quoted string)' });
      return;
    }
    put(m[1], v, i + 1);
  });
  function put(name, v, line) {
    if (syms.has(name)) dups.push({ name, first: syms.get(name).line, line, was: syms.get(name).v, v });
    syms.set(name, { v, line });
  }
  for (const n of syms.keys()) if (/^(SYS_CONFIG_NAME|SYS_BOARD|SPL|TPL|SYS_TEXT_BASE|TEXT_BASE|ENV_SIZE|ENV_OFFSET|SYS_MALLOC_F_LEN)$/.test(n)) uboot = true;
  return { syms, unread, dups, generated, uboot, lines: lines.filter((l) => l.trim()).length };
}

/** 'auto' -> full or defconfig: a file make wrote has the header, or is long. */
function kindOf(p, pick) {
  if (pick === 'full' || pick === 'defconfig') return pick;
  if (p.generated) return 'full';
  const notset = [...p.syms.values()].filter((s) => s.v === 'n').length;
  // savedefconfig writes few "is not set" lines and no header; a .config
  // has hundreds of both
  return p.syms.size > 600 || (notset > 40 && notset > p.syms.size * 0.15) ? 'full' : 'defconfig';
}

export function groupOf(name, uboot) {
  if (TOOLCHAIN.test(name)) return 'Toolchain (auto)';
  if (uboot) for (const [re, g] of UBOOT_GROUPS) if (re.test(name)) return g;
  for (const [re, g] of GROUPS) if (re.test(name)) return g;
  const first = name.split('_')[0];
  return first.length > 1 ? first : 'Other';
}

const isOn = (v) => v != null && v !== 'n';
const show = (v) => (v == null ? '' : v);

/** Parse "+SYM -SYM" picks (CONFIG_ prefix optional). */
function parsePicks(text) {
  const add = new Set(), skip = new Set();
  for (const tok of String(text ?? '').split(/[\s,;]+/)) {
    const m = /^([+-])(?:CONFIG_)?([A-Za-z0-9_]+)$/.exec(tok.trim());
    if (!m) continue;
    if (m[1] === '+') { add.add(m[2]); skip.delete(m[2]); } else { skip.add(m[2]); add.delete(m[2]); }
  }
  return { add, skip };
}

// ---------------- the diff ----------------
export function run(input) {
  const pa = parseConfig(input.a);
  const pb = parseConfig(input.b);
  const kindA = kindOf(pa, input.kindA);
  const kindB = kindOf(pb, input.kindB);
  const uboot = pa.uboot || pb.uboot;
  const { add, skip } = parsePicks(input.picks);
  const name = String(input.name || 'changes.cfg').trim().replace(/[^\w.+-]/g, '_') || 'changes.cfg';
  const warnings = [];
  const notes = [];

  if (!pa.syms.size) warnings.push('Config A has no CONFIG_ lines: paste a .config or defconfig into A.');
  if (!pb.syms.size) warnings.push('Config B has no CONFIG_ lines: paste a .config or defconfig into B.');
  for (const [p, side] of [[pa, 'A'], [pb, 'B']]) {
    if (p.unread.length) {
      warnings.push(`Config ${side}: ${p.unread.length} line(s) could not be read and were skipped - ` +
        p.unread.slice(0, 3).map((u) => `line ${u.line}: "${u.text.trim()}"`).join('; ') +
        (p.unread.length > 3 ? ' ...' : '') + '. Only CONFIG_X=value and "# CONFIG_X is not set" lines count.');
    }
    if (p.dups.length) {
      warnings.push(`Config ${side}: ${p.dups.length} symbol(s) set twice, the later line wins (as merge_config.sh does): ` +
        p.dups.slice(0, 4).map((d) => `${d.name} (lines ${d.first} and ${d.line})`).join(', ') + (p.dups.length > 4 ? ' ...' : '') + '.');
    }
  }

  const all = new Set([...pa.syms.keys(), ...pb.syms.keys()]);
  const rows = [];
  let same = 0;
  for (const sym of all) {
    const a = pa.syms.get(sym)?.v ?? null;
    const b = pb.syms.get(sym)?.v ?? null;
    // Effective values: absent in a full .config = not visible = off;
    // absent in a defconfig = default, unknown here.
    const aKnown = a != null || kindA === 'full';
    const bKnown = b != null || kindB === 'full';
    const ea = a ?? (kindA === 'full' ? 'n' : null);
    let eb = b ?? (kindB === 'full' ? 'n' : null);
    if (aKnown && bKnown && ea === eb) { same++; continue; }
    let kind, why, inc;
    if (TOOLCHAIN.test(sym)) {
      kind = 'toolchain'; why = 'set by the compiler or architecture, not by a fragment'; inc = false;
    } else if (!aKnown && kindB === 'defconfig') {
      // Both are defconfigs: savedefconfig writes only values that differ
      // from the default, so B's line is a change from A's default.
      kind = !isOn(eb) ? 'removed' : /^[ym]$/.test(eb) ? 'added' : 'changed';
      why = 'A is at its default; B sets it'; inc = true;
    } else if (!aKnown || !bKnown) {
      kind = 'default';
      if (!bKnown && kindA === 'defconfig' && a === 'y') {
        // A bool at y in a defconfig is not its default, so B's default is n.
        eb = 'n'; why = 'not in defconfig B: at its default there (n, since A\'s y is not the default)';
      } else {
        why = !bKnown ? 'not in defconfig B: at its default there' : 'not in defconfig A: B\'s value may be the default';
      }
      inc = false;
    } else if (isOn(ea) && b == null) {
      kind = 'dropped'; why = 'missing from B: not visible there, a dependency is off'; inc = false;
    } else if (!isOn(ea) && isOn(eb)) {
      kind = 'added'; why = a == null ? 'was not visible in A' : ''; inc = true;
    } else if (isOn(ea) && !isOn(eb)) {
      kind = 'removed'; why = ''; inc = true;
    } else if ((ea === 'y' && eb === 'm') || (ea === 'm' && eb === 'y')) {
      kind = eb === 'm' ? 'tomodule' : 'builtin'; why = eb === 'm' ? 'built-in -> module' : 'module -> built-in'; inc = true;
    } else {
      kind = 'changed'; why = ''; inc = true;
    }
    const byDefault = inc;
    if (skip.has(sym)) inc = false;
    if (add.has(sym) && eb != null) inc = true;
    if (add.has(sym) && eb == null) inc = false;
    rows.push({ sym, a, b, ea, eb, kind, why, inc, byDefault, group: groupOf(sym, uboot),
      la: pa.syms.get(sym)?.line ?? 0, lb: pb.syms.get(sym)?.line ?? 0 });
  }

  // ---- warnings on the chosen fragment ----
  const frag = rows.filter((r) => r.inc);
  const fragOn = new Map(frag.map((r) => [r.sym, r.eb]));
  const valueInB = (s) => (fragOn.has(s) ? fragOn.get(s) : pb.syms.get(s)?.v ?? (kindB === 'full' ? 'n' : null));
  for (const r of frag) {
    if (r.eb === 'm' && !uboot && valueInB('MODULES') === 'n') {
      r.dep = 'needs CONFIG_MODULES=y';
    }
    if (r.eb === 'm' && uboot) r.dep = 'U-Boot has no modules: =m is read as y or dropped';
    if (isOn(r.eb) && !r.dep) {
      for (const [re, parent] of PARENTS) {
        if (re.test(r.sym) && parent !== r.sym) {
          const pv = valueInB(parent);
          if (pv === 'n') r.dep = `parent ${parent} is off in B`;
          else if (r.eb === 'y' && pv === 'm') r.dep = `=y under ${parent}=m becomes m`;
          break;
        }
      }
    }
  }
  const risky = frag.filter((r) => r.dep);
  if (risky.length) {
    warnings.push(`${risky.length} fragment line(s) may not survive olddefconfig: ` +
      risky.slice(0, 5).map((r) => `CONFIG_${r.sym} (${r.dep})`).join(', ') + (risky.length > 5 ? ' ...' : '') +
      '. Add the parent to the fragment, or check the result with merge_config.sh / kernel_configcheck.');
  }
  if (!uboot && frag.some((r) => r.eb === 'm') && valueInB('MODULES') == null) {
    notes.push('B does not say whether CONFIG_MODULES is set; =m lines need it.');
  }
  const dropped = rows.filter((r) => r.kind === 'dropped');
  if (dropped.length) {
    notes.push(`${dropped.length} symbol(s) are on in A and missing from B (${dropped.slice(0, 4).map((r) => r.sym).join(', ')}${dropped.length > 4 ? ' ...' : ''}): Kconfig removed them because something they depend on is off in B. They are left out of the fragment; turning the parent off is enough.`);
  }
  if (kindA === 'defconfig' || kindB === 'defconfig') {
    notes.push(`Compared as A = ${kindA === 'full' ? 'full .config' : 'defconfig'}, B = ${kindB === 'full' ? 'full .config' : 'defconfig'}. A symbol missing from a defconfig is at its default, so it is shown as "default" and not put in the fragment; add it with + if you want it pinned.`);
  }
  const tool = rows.filter((r) => r.kind === 'toolchain');
  if (tool.length) notes.push(`${tool.length} toolchain symbol(s) differ (${tool.slice(0, 3).map((r) => r.sym).join(', ')}): the compiler sets them, a fragment cannot.`);
  if (!rows.length && pa.syms.size && pb.syms.size) notes.push('The two configs are identical in every symbol they set.');

  // ---- order: groups by change count, rows by kind then name ----
  const ORDER = { added: 0, removed: 1, tomodule: 2, builtin: 3, changed: 4, dropped: 5, default: 6, toolchain: 7 };
  rows.sort((x, y) => (ORDER[x.kind] - ORDER[y.kind]) || (x.sym < y.sym ? -1 : 1));
  const gmap = new Map();
  for (const r of rows) {
    if (!gmap.has(r.group)) gmap.set(r.group, { name: r.group, rows: [], counts: {} });
    const g = gmap.get(r.group);
    g.rows.push(r);
    g.counts[r.kind] = (g.counts[r.kind] || 0) + 1;
  }
  const weight = (g) => g.rows.filter((r) => r.kind !== 'default' && r.kind !== 'toolchain').length;
  const groups = [...gmap.values()].sort((x, y) => (weight(y) - weight(x)) || (x.name < y.name ? -1 : 1));

  // ---- the fragment ----
  const line = (sym, v) => (v === 'n' ? `# CONFIG_${sym} is not set` : `CONFIG_${sym}=${v}`);
  const fragLines = [`# ${name}: ${frag.length} change${frag.length === 1 ? '' : 's'} from config A to config B`,
    '# Written by Kconfig Diff. Check it with merge_config.sh or kernel_configcheck.'];
  for (const g of groups) {
    const inc = g.rows.filter((r) => r.inc);
    if (!inc.length) continue;
    fragLines.push('', `# ${g.name}`);
    for (const r of inc) fragLines.push(line(r.sym, r.eb));
  }
  const fragment = fragLines.join('\n') + '\n';

  // ---- scripts/diffconfig format ----
  const dc = [];
  for (const r of [...rows].sort((x, y) => (x.sym < y.sym ? -1 : 1))) {
    if (r.a == null && r.b != null) dc.push(`+${r.sym} ${r.b}`);
    else if (r.a != null && r.b == null) dc.push(`-${r.sym} ${r.a}`);
    else if (r.a != null && r.b != null) dc.push(` ${r.sym} ${r.a} -> ${r.b}`);
  }

  const recipe = uboot
    ? [
      '# u-boot-%.bbappend (poky u-boot-configure merges *.cfg from SRC_URI with merge_config.sh)',
      'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"',
      `SRC_URI += "file://${name}"`,
      '',
      '# check that every line made it into the final .config',
      'bitbake virtual/bootloader -c configure -f',
      'grep -f <(grep -o "CONFIG_[A-Za-z0-9_]*" files/' + name + ') ${B}/.config',
      '',
      '# outside Yocto',
      `scripts/kconfig/merge_config.sh -m configs/<board>_defconfig ${name}`,
      'make olddefconfig && make savedefconfig',
    ]
    : [
      '# linux-yocto%.bbappend or your kernel recipe\'s .bbappend',
      'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"',
      `SRC_URI += "file://${name}"`,
      '',
      '# linux-yocto: report fragment lines that did not make it',
      'bitbake virtual/kernel -c kernel_configcheck -f',
      '',
      '# any kernel tree: merge, resolve, and list what was dropped',
      `scripts/kconfig/merge_config.sh -m .config ${name}`,
      'make ARCH=arm64 olddefconfig',
      'scripts/diffconfig .config.old .config',
    ];

  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const values = [
    { label: 'Symbols in A', value: pa.syms.size, hint: kindA === 'full' ? 'full .config' : 'defconfig' },
    { label: 'Symbols in B', value: pb.syms.size, hint: kindB === 'full' ? 'full .config' : 'defconfig' },
    { label: 'Added', value: counts.added || 0 },
    { label: 'Removed', value: counts.removed || 0 },
    { label: 'Built-in / module swaps', value: (counts.tomodule || 0) + (counts.builtin || 0), hint: 'y <-> m' },
    { label: 'Value changes', value: counts.changed || 0 },
    { label: 'Dropped by dependencies', value: counts.dropped || 0, tone: counts.dropped ? 'warn' : undefined },
    { label: 'Lines in the fragment', value: frag.length, tone: risky.length ? 'warn' : 'ok', hint: risky.length ? `${risky.length} may be dropped` : 'none at risk' },
  ];
  const KLABEL = { added: 'added', removed: 'removed', tomodule: 'y -> m', builtin: 'm -> y', changed: 'changed', dropped: 'dropped (dependency)', default: 'default (defconfig)', toolchain: 'toolchain' };
  const tableRows = rows.slice(0, MAX_TABLE).map((r) => [
    'CONFIG_' + r.sym, r.group, r.a == null ? (kindA === 'full' ? '(not visible)' : '(default)') : show(r.a),
    r.b == null ? (kindB === 'full' ? '(not visible)' : '(default)') : show(r.b), KLABEL[r.kind], r.inc ? 'yes' : 'no', r.dep || '']);
  if (rows.length > MAX_TABLE) notes.push(`The table lists the first ${MAX_TABLE} of ${rows.length} differences; the fragment and diffconfig texts have all of them.`);

  notes.push('Verify a fragment by merging it and diffing again: a line Kconfig refused (unmet "depends on", a choice, a "select" forcing it) vanishes silently. linux-yocto\'s do_kernel_configcheck lists them; elsewhere merge_config.sh prints "Value requested for CONFIG_X not in final .config".');

  return {
    values,
    tables: [{ title: 'Differences', columns: ['Symbol', 'Group', 'A', 'B', 'Change', 'In fragment', 'Risk'], rows: tableRows }],
    texts: [
      { title: name, body: fragment, lang: 'kconfig' },
      { title: 'diffconfig', body: (dc.join('\n') || '(no differences)') + '\n' },
      { title: 'Recipe & check', body: recipe.join('\n') + '\n', lang: 'sh' },
    ],
    warnings, notes,
    draw: {
      kindA, kindB, uboot, same, name,
      sides: {
        a: { symbols: pa.syms.size, lines: pa.lines, unread: pa.unread.slice(0, MAX_UNREAD), unreadCount: pa.unread.length, dups: pa.dups.length },
        b: { symbols: pb.syms.size, lines: pb.lines, unread: pb.unread.slice(0, MAX_UNREAD), unreadCount: pb.unread.length, dups: pb.dups.length },
      },
      counts, fragCount: frag.length, risky: risky.length,
      groups: groups.map((g) => ({ name: g.name, counts: g.counts,
        rows: g.rows.map((r) => ({ sym: r.sym, a: r.a, b: r.b, kind: r.kind, why: r.why, inc: r.inc, byDefault: r.byDefault, dep: r.dep || '', la: r.la, lb: r.lb })) })),
    },
  };
}
