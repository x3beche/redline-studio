// FreeRTOS Config & Heap Sizer: the heap an application needs for its tasks,
// queues, semaphores, event groups, stream buffers and timers, the interrupt
// priorities that may call the FromISR API, and a FreeRTOSConfig.h.
//
// Pure: no DOM. Every size is for a 32-bit Cortex-M port (4-byte pointers,
// 32-bit ticks, portBYTE_ALIGNMENT 8) of FreeRTOS Kernel V10.6.x:
//   - Object sizes are the struct layouts in tasks.c (TCB_t), queue.c
//     (Queue_t), timers.c (Timer_t, DaemonTaskMessage_t), event_groups.c
//     (EventGroup_t) and stream_buffer.c (StreamBuffer_t), cross-checked by
//     compiling V10.6.2 with arm-none-eabi-gcc for Cortex-M4 and reading
//     sizeof(StaticTask_t) etc. (TCB 92 B with trace facility, 84 B without).
//   - What each create call allocates: xTaskCreate() = stack then TCB (two
//     pvPortMalloc calls when the stack grows down); xQueueGenericCreate() =
//     one block of sizeof(Queue_t) + length * item size; semaphores and
//     mutexes are queues with item size 0; xStreamBufferGenericCreate() = one
//     block of sizeof(StreamBuffer_t) + size + 1.
//   - heap_4/heap_2/heap_5: each block is the request plus xHeapStructSize
//     (8 B) rounded up to 8; the end marker takes 8 B of the array. heap_1:
//     the request rounded up to 8, usable size configTOTAL_HEAP_SIZE - 8.
//     heap_3 wraps the C library malloc (its overhead here is an estimate).
//   - Interrupt priorities: the port.c rules for ARM_CM3/CM4F/CM7/CM33
//     (BASEPRI masking; configMAX_SYSCALL_INTERRUPT_PRIORITY != 0; all
//     priority bits preempt), and FreeRTOS.org "Running the RTOS on an ARM
//     Cortex-M core".

const PORTS = {
  ARM_CM0: { name: 'ARM_CM0 (Cortex-M0/M0+)', basepri: false, ctx: 16, fpCtx: 0, fpu: false },
  ARM_CM3: { name: 'ARM_CM3 (Cortex-M3)', basepri: true, ctx: 16, fpCtx: 0, fpu: false },
  ARM_CM4F: { name: 'ARM_CM4F (Cortex-M4 with FPU)', basepri: true, ctx: 17, fpCtx: 50, fpu: true },
  ARM_CM7: { name: 'ARM_CM7 (Cortex-M7 r0p1+)', basepri: true, ctx: 17, fpCtx: 50, fpu: true },
  ARM_CM33_NTZ: { name: 'ARM_CM33_NTZ (Cortex-M33, no TrustZone)', basepri: true, ctx: 18, fpCtx: 50, fpu: true },
};
// Words a switched-out task keeps on its stack: the hardware frame (8), the
// registers the port saves (R4-R11, plus EXC_RETURN on the FPU ports, plus
// PSPLIM on CM33) and, for a task that used the FPU, the 18-word FP frame and
// S16-S31 (16) - from each port's xPortPendSVHandler / pxPortInitialiseStack.

const ALIGN = 8;       // portBYTE_ALIGNMENT on every Cortex-M port
const HDR = 8;         // heap_2/4/5 xHeapStructSize: sizeof(BlockLink_t) rounded to 8
const up8 = (n) => Math.ceil(n / ALIGN) * ALIGN;
const up4 = (n) => Math.ceil(n / 4) * 4;

/** "24K", "24 KiB", "0x6000", "24576" -> bytes; null when it does not read. */
export function readBytes(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text) : null;
  const t = String(text ?? '').trim().replace(/_/g, '');
  if (!t) return null;
  let m = /^0x([0-9a-f]+)$/i.exec(t);
  if (m) return parseInt(m[1], 16);
  m = /^(\d+(?:\.\d+)?)\s*(k|kb|kib|m|mb|mib)?$/i.exec(t);
  if (!m) m = /^\(?\s*(\d+)\s*\*\s*(1024)\s*\)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  const v = unit === '1024' ? n * 1024 : unit.startsWith('k') ? n * 1024 : unit.startsWith('m') ? n * 1048576 : n;
  return Number.isFinite(v) ? Math.round(v) : null;
}

const int = (v, d) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n) : d; };

/** sizeof(TCB_t) for a 32-bit port, field by field as tasks.c lays it out. */
export function tcbSize(o) {
  let off = 4 + 20 + 20 + 4 + 4;           // pxTopOfStack, xStateListItem, xEventListItem, uxPriority, pxStack
  off += o.nameLen;                          // pcTaskName[configMAX_TASK_NAME_LEN]
  off = up4(off);
  if (o.trace) off += 8;                     // uxTCBNumber, uxTaskNumber
  if (o.mutexes) off += 8;                   // uxBasePriority, uxMutexesHeld
  if (o.tag) off += 4;                       // pxTaskTag
  off += 4 * o.tls;                          // pvThreadLocalStoragePointers[]
  if (o.runtime) off += 4;                   // ulRunTimeCounter (32-bit counter)
  if (o.newlib === 'nano') off += 76;        // struct _reent, arm-none-eabi newlib-nano (measured)
  if (o.newlib === 'full') off += 292;       // struct _reent, arm-none-eabi newlib (measured)
  off += 4 * o.notify + o.notify;            // ulNotifiedValue[], ucNotifyState[]
  if (o.staticAlloc) off += 1;               // ucStaticallyAllocated (static and dynamic both on)
  if (o.abortDelay) off += 1;                // ucDelayAborted
  return up4(off);
}
const queueSize = (o) => 72 + (o.queueSets ? 4 : 0) + (o.trace ? 8 : 0);
const timerSize = (o) => 40 + (o.trace ? 4 : 0);
const eventGroupSize = (o) => 24 + (o.trace ? 4 : 0) + (o.staticAlloc ? 4 : 0);
const streamBufferSize = (o) => 32 + (o.trace ? 4 : 0);
const DAEMON_MSG = 16;  // DaemonTaskMessage_t with INCLUDE_xTimerPendFunctionCall = 1

const KINDS = {
  'queue': { label: 'Queue', uses: 'length × item' },
  'binary semaphore': { label: 'Binary semaphore' },
  'counting semaphore': { label: 'Counting semaphore', uses: 'max count' },
  'mutex': { label: 'Mutex' },
  'recursive mutex': { label: 'Recursive mutex' },
  'event group': { label: 'Event group' },
  'stream buffer': { label: 'Stream buffer', uses: 'size' },
  'message buffer': { label: 'Message buffer', uses: 'size' },
  'timer': { label: 'Software timer' },
};

export function run(input) {
  const warnings = [];
  const notes = [];
  const port = PORTS[input.port] || PORTS.ARM_CM4F;
  const portId = PORTS[input.port] ? input.port : 'ARM_CM4F';
  const scheme = ['heap_1', 'heap_2', 'heap_3', 'heap_4', 'heap_5'].includes(input.heap) ? input.heap : 'heap_4';
  const cpuHz = Number.isFinite(input.cpuHz) && input.cpuHz > 0 ? input.cpuHz : 168e6;
  const tickHz = Number.isFinite(input.tickHz) && input.tickHz > 0 ? input.tickHz : 1000;
  const maxPrio = Math.max(1, Math.min(256, int(input.maxPriorities, 7)));
  const minStack = Math.max(16, int(input.minimalStack, 128));
  const nameLen = Math.max(1, Math.min(64, int(input.maxNameLen, 16)));
  let total = readBytes(input.totalHeap);
  if (total == null || total <= 0) {
    warnings.push(`configTOTAL_HEAP_SIZE "${input.totalHeap}" does not read as a size; write it like 24K, 24576 or 0x6000. Using 16K.`);
    total = 16384;
  }
  const tasksIn = Array.isArray(input.tasks) ? input.tasks : [];
  const objsIn = Array.isArray(input.objects) ? input.objects : [];
  const isrsIn = Array.isArray(input.isrs) ? input.isrs : [];

  const hasKind = (k) => objsIn.some((o) => String(o.kind || '').trim() === k);
  const o = {
    nameLen,
    trace: !!input.trace,
    mutexes: hasKind('mutex') || hasKind('recursive mutex') || !!input.forceMutexes,
    tag: false,
    tls: Math.max(0, Math.min(16, int(input.tlsPointers, 0))),
    runtime: !!input.runtimeStats,
    newlib: ['none', 'nano', 'full'].includes(input.newlib) ? input.newlib : 'none',
    notify: Math.max(1, Math.min(32, int(input.notifyEntries, 1))),
    staticAlloc: !!input.staticAlloc,
    abortDelay: false,
    queueSets: !!input.queueSets,
  };
  const useTimers = !!input.useTimers;
  const timerStack = Math.max(16, int(input.timerStack, 256));
  const timerQLen = Math.max(1, int(input.timerQueueLength, 10));
  const timerPrio = int(input.timerPriority, maxPrio - 1);

  const TCB = tcbSize(o), QS = queueSize(o), TS = timerSize(o), EGS = eventGroupSize(o), SBS = streamBufferSize(o);
  const alloc = scheme === 'heap_1' ? (n) => up8(n) : (n) => up8(n + HDR);
  const usable = scheme === 'heap_1' || scheme === 'heap_2' ? total - ALIGN : Math.floor((total - HDR) / ALIGN) * ALIGN;

  const blocks = [];
  const addBlock = (owner, kind, part, req, group) => {
    blocks.push({ owner, kind, part, req, size: alloc(req), group });
  };

  // ---- application tasks ----
  const tasks = [];
  const badRows = [];
  tasksIn.forEach((t, i) => {
    const name = String(t.name ?? '').trim() || `task${i + 1}`;
    const words = int(t.stack, NaN);
    const prio = int(t.priority, NaN);
    if (!Number.isFinite(words) || words <= 0) { badRows.push(`task "${name}": stack "${t.stack}" is not a word count`); return; }
    if (!Number.isFinite(prio) || prio < 0) { badRows.push(`task "${name}": priority "${t.priority}" is not a number`); return; }
    const fpu = /^(y|yes|true|1)$/i.test(String(t.fpu ?? '').trim()) && port.fpu;
    const ctxWords = port.ctx + (fpu ? port.fpCtx : 0);
    tasks.push({ name, words, bytes: words * 4, prio, fpu, ctxWords, row: i, system: false });
    if (name.length >= nameLen) notes.push(`Task name "${name}" is ${name.length} characters; configMAX_TASK_NAME_LEN ${nameLen} keeps ${nameLen - 1} of them.`);
  });
  // ---- kernel tasks, created by vTaskStartScheduler() ----
  const idle = { name: 'IDLE', words: minStack, bytes: minStack * 4, prio: 0, fpu: false, ctxWords: port.ctx, row: -1, system: true };
  const tmr = useTimers ? { name: 'Tmr Svc', words: timerStack, bytes: timerStack * 4, prio: timerPrio, fpu: false, ctxWords: port.ctx, row: -2, system: true } : null;

  for (const t of tasks) { addBlock(t.name, 'stack', 'stack', t.bytes, 'task'); addBlock(t.name, 'tcb', 'TCB', TCB, 'task'); }

  // ---- objects ----
  const objects = [];
  let anyTimer = false;
  objsIn.forEach((r, i) => {
    const kind = String(r.kind ?? '').trim().toLowerCase();
    const name = String(r.name ?? '').trim() || `${kind || 'object'}${i + 1}`;
    if (!KINDS[kind]) { badRows.push(`object "${name}": kind "${r.kind}" is not one of ${Object.keys(KINDS).join(', ')}`); return; }
    const count = Math.max(1, int(r.count, 1));
    const len = int(r.length, NaN);
    const item = int(r.itemSize, NaN);
    let req = 0, detail = '';
    if (kind === 'queue') {
      if (!(len > 0) || !(item >= 0)) { badRows.push(`queue "${name}": length ${r.length} and item size ${r.itemSize} must be numbers (length > 0)`); return; }
      req = QS + len * item; detail = `${len} × ${item} B + Queue_t ${QS} B`;
    } else if (kind === 'counting semaphore') {
      req = QS; detail = `Queue_t ${QS} B (max count ${Number.isFinite(len) ? len : '?'}, no storage)`;
    } else if (kind === 'binary semaphore' || kind === 'mutex' || kind === 'recursive mutex') {
      req = QS; detail = `Queue_t ${QS} B, no storage`;
    } else if (kind === 'event group') {
      req = EGS; detail = `EventGroup_t ${EGS} B`;
    } else if (kind === 'stream buffer' || kind === 'message buffer') {
      if (!(len > 0)) { badRows.push(`${kind} "${name}": size "${r.length}" must be a byte count > 0`); return; }
      req = SBS + len + 1; detail = `${len} + 1 B + StreamBuffer_t ${SBS} B`;
      if (kind === 'message buffer') notes.push(`Message buffer "${name}": each message also stores a ${4}-byte length, so ${len} B holds fewer bytes of payload.`);
    } else if (kind === 'timer') {
      req = TS; detail = `Timer_t ${TS} B`; anyTimer = true;
    }
    objects.push({ name, kind, count, req, detail, row: i });
    for (let c = 0; c < count; c++) addBlock(count > 1 ? `${name}[${c}]` : name, kind, KINDS[kind].label, req, 'object');
  });
  if (anyTimer && !useTimers) warnings.push('Software timers are listed but configUSE_TIMERS is off: xTimerCreate() will not link. Turn timers on.');

  // Kernel objects: idle task, then the timer service queue and task.
  if (!o.staticAlloc) { addBlock('IDLE', 'stack', 'stack', idle.bytes, 'kernel'); addBlock('IDLE', 'tcb', 'TCB', TCB, 'kernel'); }
  if (useTimers) {
    addBlock('TmrQ', 'queue', 'Timer queue', QS + timerQLen * DAEMON_MSG, 'kernel');
    if (!o.staticAlloc) { addBlock('Tmr Svc', 'stack', 'stack', tmr.bytes, 'kernel'); addBlock('Tmr Svc', 'tcb', 'TCB', TCB, 'kernel'); }
  }
  if (o.staticAlloc) notes.push('configSUPPORT_STATIC_ALLOCATION = 1: the idle and timer task stacks and TCBs come from vApplicationGetIdleTaskMemory() / vApplicationGetTimerTaskMemory(), outside the heap.');

  let off = 0;
  for (const b of blocks) { b.start = off; off += b.size; }
  const used = off;
  const reqTotal = blocks.reduce((s, b) => s + b.req, 0);
  const overhead = used - reqTotal;
  const free = usable - used;
  const pct = usable > 0 ? (used / usable) * 100 : 0;
  // Suggested size: what is used, 20 % margin for later allocations, whole KiB.
  const suggest = Math.ceil(((used + (total - usable)) * 1.2) / 1024) * 1024;

  if (scheme === 'heap_3') notes.push('heap_3 wraps malloc()/free(): configTOTAL_HEAP_SIZE is not used - the heap is the linker script\'s heap (_Min_Heap_Size / sbrk). Block overhead here is the heap_4 figure; the C library\'s own is similar (4-8 B per block).');
  if (scheme === 'heap_5') notes.push('heap_5 spans several regions given to vPortDefineHeapRegions(); the total here is their sum, and each region loses its own 8-byte end marker.');
  if (scheme === 'heap_1') notes.push('heap_1 never frees: vTaskDelete() and vQueueDelete() leak. Fine when everything is created once at start-up.');
  if (scheme === 'heap_2') notes.push('heap_2 does not merge freed neighbours; repeated create/delete of different sizes fragments it. heap_4 is the usual choice.');
  if (free < 0) warnings.push(`The heap is ${-free} B short: the objects need ${used} B of ${usable} B usable. The last creations return NULL / errCOULD_NOT_ALLOCATE_REQUIRED_MEMORY (vTaskStartScheduler() returns if the idle or timer task does not fit). Set configTOTAL_HEAP_SIZE to at least ${suggest} (${suggest / 1024} KiB) - drag the heap's end.`);
  else if (free < usable * 0.1) warnings.push(`Only ${free} B (${(100 - pct).toFixed(1)} %) of the heap is left for later allocations; anything created after start-up (or a library using pvPortMalloc) may fail. Consider ${suggest} B.`);
  else if (free > usable * 0.5 && usable > 8192) notes.push(`${free} B of the heap (${(100 - pct).toFixed(0)} %) is never allocated by these objects; ${suggest} B would leave a 20 % margin and give the rest back to .bss.`);
  notes.push('Check it on the target: xPortGetMinimumEverFreeHeapSize() (heap_4/5) after the system has run a while is the real headroom.');

  // ---- tasks: priorities, stacks ----
  const allTasks = [...tasks, idle, ...(tmr ? [tmr] : [])];
  for (const t of allTasks) {
    t.issues = [];
    if (t.prio >= maxPrio) t.issues.push(`priority ${t.prio} >= configMAX_PRIORITIES ${maxPrio}: xTaskCreate() asserts and caps it at ${maxPrio - 1}`);
    if (t.words < minStack && !t.system) t.issues.push(`stack ${t.words} words is below configMINIMAL_STACK_SIZE ${minStack}`);
    if (t.fpu && t.words < minStack + port.fpCtx) t.issues.push(`uses the FPU: a saved FP context alone is ${port.ctx + port.fpCtx} words`);
    if (t.words < t.ctxWords * 2) t.issues.push(`${t.words} words barely holds the ${t.ctxWords}-word saved context`);
  }
  for (const t of allTasks) if (t.issues.length) warnings.push(`Task "${t.name}": ${t.issues.join('; ')}.`);
  if (useTimers && timerPrio >= maxPrio) warnings.push(`configTIMER_TASK_PRIORITY ${timerPrio} must be below configMAX_PRIORITIES ${maxPrio}.`);
  const usedPrios = new Set(allTasks.map((t) => Math.min(t.prio, maxPrio - 1)));
  if (maxPrio > 32 && port.basepri) warnings.push(`configMAX_PRIORITIES ${maxPrio} is above 32: the port's optimised task selection (configUSE_PORT_OPTIMISED_TASK_SELECTION) cannot be used.`);
  const readyListsBytes = maxPrio * 20;
  if (maxPrio - usedPrios.size >= 4) notes.push(`${maxPrio} priorities but only ${usedPrios.size} in use: each priority costs a 20-byte ready list in .bss (${readyListsBytes} B now); ${Math.max(...usedPrios) + 1} would do.`);

  // ---- tick ----
  const reload = Math.round(cpuHz / tickHz) - 1;
  const reloadOk = reload >= 1 && reload <= 0xFFFFFF;
  const tickErrPpm = ((cpuHz / (reload + 1)) - tickHz) / tickHz * 1e6;
  if (!reloadOk) warnings.push(`SysTick reload ${reload} does not fit the 24-bit counter (max 16777215): ${fmt(cpuHz)} Hz / ${tickHz} Hz. Raise configTICK_RATE_HZ or clock SysTick from HCLK/8.`);
  if (Math.abs(tickErrPpm) >= 1) notes.push(`${fmt(cpuHz)} Hz / ${tickHz} Hz is not a whole number of clocks: the tick is off by ${tickErrPpm.toFixed(0)} ppm.`);
  if (tickHz > 1000) notes.push(`configTICK_RATE_HZ ${tickHz}: pdMS_TO_TICKS() works in whole ticks and the tick interrupt costs CPU ${tickHz} times a second; 1000 Hz or less is typical.`);
  if (1000 % tickHz !== 0 && tickHz < 1000) notes.push(`At ${tickHz} Hz a tick is ${(1000 / tickHz).toFixed(2)} ms: pdMS_TO_TICKS() rounds down, so short delays come out shorter than asked.`);

  // ---- interrupt priorities ----
  const bits = Math.max(2, Math.min(8, int(input.prioBits, 4)));
  const levels = 1 << bits;
  const shift = 8 - bits;
  let syscall = int(input.maxSyscall, 5);
  const subBits = Math.max(0, Math.min(bits, int(input.subBits, 0)));
  const lowest = levels - 1;
  if (port.basepri) {
    if (syscall <= 0) warnings.push('configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 0 is not allowed: port.c asserts that configMAX_SYSCALL_INTERRUPT_PRIORITY is not 0 (BASEPRI = 0 masks nothing). Use 1 or higher.');
    if (syscall > lowest) { warnings.push(`configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY ${syscall} is beyond the lowest priority ${lowest} with ${bits} priority bits.`); syscall = lowest; }
    if (subBits > 0) warnings.push(`${subBits} sub-priority bit(s) set in PRIGROUP: FreeRTOS asserts in xPortStartScheduler() unless every priority bit is pre-emption priority. Call NVIC_SetPriorityGrouping(0) (HAL: NVIC_PRIORITYGROUP_4) before starting the scheduler.`);
  }
  const isrs = [];
  isrsIn.forEach((r, i) => {
    const name = String(r.name ?? '').trim() || `IRQ${i}`;
    const p = int(r.priority, NaN);
    if (!Number.isFinite(p) || p < 0) { badRows.push(`ISR "${name}": priority "${r.priority}"`); return; }
    const calls = /^(y|yes|true|1)$/i.test(String(r.fromIsr ?? '').trim());
    const issues = [];
    let status = 'ok';
    if (p > lowest) { issues.push(`priority ${p} does not exist with ${bits} bits (0..${lowest}); the NVIC keeps only the top ${bits} bits`); status = 'bad'; }
    if (port.basepri) {
      if (calls && p < syscall) { issues.push(`calls FromISR API at priority ${p}, above configMAX_SYSCALL (${syscall}): the kernel cannot mask it, so it corrupts kernel lists (configASSERT in vPortValidateInterruptPriority). Lower its urgency to ${syscall}..${lowest}, or stop calling the API`); status = 'bad'; }
      else if (!calls && p < syscall) status = 'fast';
      if (calls && p === 0) issues.push('priority 0 is the reset default: an IRQ never given a priority lands here');
    }
    isrs.push({ name, prio: p, raw: (Math.min(p, lowest) << shift) & 0xFF, calls, status, issues, row: i });
  });
  for (const i of isrs) if (i.issues.length) warnings.push(`ISR "${i.name}": ${i.issues.join('; ')}.`);
  if (!port.basepri) notes.push('ARM_CM0 has no BASEPRI: critical sections disable all interrupts (PRIMASK), so every ISR is delayed by them and any ISR may call the FromISR API. configMAX_SYSCALL_INTERRUPT_PRIORITY is not used.');

  if (badRows.length) warnings.push(`Skipped ${badRows.length} row(s): ${badRows.slice(0, 4).join('; ')}.`);
  const kernelRaw = (lowest << shift) & 0xFF;
  const syscallRaw = (Math.max(0, syscall) << shift) & 0xFF;

  // ---- FreeRTOSConfig.h ----
  const mutexes = o.mutexes ? 1 : 0;
  const counting = hasKind('counting semaphore') ? 1 : 0;
  const recursive = hasKind('recursive mutex') ? 1 : 0;
  const stream = hasKind('stream buffer') || hasKind('message buffer');
  const eg = hasKind('event group');
  const L = [];
  const def = (k, v, c) => L.push(`#define ${k.padEnd(44)} ${String(v)}${c ? `   /* ${c} */` : ''}`);
  L.push('/* FreeRTOSConfig.h - written by the Redline FreeRTOS Config & Heap Sizer', ` * Port: portable/GCC/${portId}, heap: portable/MemMang/${scheme}.c`, ` * Heap estimate: ${used} B used of ${usable} B usable (${pct.toFixed(1)} %). */`, '#ifndef FREERTOS_CONFIG_H', '#define FREERTOS_CONFIG_H', '');
  L.push('#if defined(__ICCARM__) || defined(__CC_ARM) || defined(__GNUC__)', '  #include <stdint.h>', '  extern uint32_t SystemCoreClock;', '#endif', '');
  def('configUSE_PREEMPTION', 1);
  def('configUSE_PORT_OPTIMISED_TASK_SELECTION', port.basepri && maxPrio <= 32 ? 1 : 0, port.basepri ? 'CLZ-based, max 32 priorities' : 'not on Armv6-M');
  def('configUSE_TICKLESS_IDLE', 0);
  def('configCPU_CLOCK_HZ', '( SystemCoreClock )', `${fmt(cpuHz)} Hz here`);
  def('configTICK_RATE_HZ', `( ( TickType_t ) ${tickHz} )`, `SysTick reload ${reload}`);
  def('configMAX_PRIORITIES', maxPrio);
  def('configMINIMAL_STACK_SIZE', `( ( uint16_t ) ${minStack} )`, 'words: the idle task stack');
  def('configTOTAL_HEAP_SIZE', `( ( size_t ) ${total} )`, `${(total / 1024).toFixed(total % 1024 ? 2 : 0)} KiB${scheme === 'heap_3' ? ', unused by heap_3' : ''}`);
  def('configMAX_TASK_NAME_LEN', nameLen);
  def('configUSE_16_BIT_TICKS', 0);
  def('configIDLE_SHOULD_YIELD', 1);
  def('configUSE_TASK_NOTIFICATIONS', 1);
  def('configTASK_NOTIFICATION_ARRAY_ENTRIES', o.notify);
  def('configUSE_MUTEXES', mutexes);
  def('configUSE_RECURSIVE_MUTEXES', recursive);
  def('configUSE_COUNTING_SEMAPHORES', counting);
  def('configUSE_QUEUE_SETS', o.queueSets ? 1 : 0);
  def('configQUEUE_REGISTRY_SIZE', 8, 'debugger names only, not heap');
  def('configUSE_TRACE_FACILITY', o.trace ? 1 : 0);
  def('configUSE_NEWLIB_REENTRANT', o.newlib === 'none' ? 0 : 1, o.newlib === 'none' ? '' : `struct _reent in every TCB (${o.newlib === 'nano' ? 76 : 292} B)`);
  def('configNUM_THREAD_LOCAL_STORAGE_POINTERS', o.tls);
  def('configSUPPORT_STATIC_ALLOCATION', o.staticAlloc ? 1 : 0);
  def('configSUPPORT_DYNAMIC_ALLOCATION', 1);
  def('configCHECK_FOR_STACK_OVERFLOW', ['0', '1', '2'].includes(String(input.stackCheck)) ? input.stackCheck : 2, 'needs vApplicationStackOverflowHook()');
  def('configUSE_MALLOC_FAILED_HOOK', 1, 'needs vApplicationMallocFailedHook()');
  def('configUSE_IDLE_HOOK', 0);
  def('configUSE_TICK_HOOK', 0);
  def('configGENERATE_RUN_TIME_STATS', o.runtime ? 1 : 0);
  if (o.runtime) { L.push('/* Provide a timer 10-100x faster than the tick: */'); def('portCONFIGURE_TIMER_FOR_RUN_TIME_STATS()', 'vConfigureRunTimeStatsTimer()'); def('portGET_RUN_TIME_COUNTER_VALUE()', 'ulGetRunTimeCounterValue()'); }
  def('configUSE_STATS_FORMATTING_FUNCTIONS', o.trace ? 1 : 0);
  L.push('');
  def('configUSE_TIMERS', useTimers ? 1 : 0);
  if (useTimers) {
    def('configTIMER_TASK_PRIORITY', timerPrio);
    def('configTIMER_QUEUE_LENGTH', timerQLen);
    def('configTIMER_TASK_STACK_DEPTH', timerStack, 'words');
  }
  L.push('');
  def('INCLUDE_vTaskPrioritySet', 1); def('INCLUDE_uxTaskPriorityGet', 1); def('INCLUDE_vTaskDelete', 1);
  def('INCLUDE_vTaskSuspend', 1); def('INCLUDE_vTaskDelayUntil', 1); def('INCLUDE_vTaskDelay', 1);
  def('INCLUDE_xTaskGetSchedulerState', 1); def('INCLUDE_uxTaskGetStackHighWaterMark', 1);
  def('INCLUDE_xTimerPendFunctionCall', useTimers ? 1 : 0);
  def('INCLUDE_xEventGroupSetBitFromISR', eg && useTimers ? 1 : 0);
  if (stream) L.push('/* stream_buffer.c must be in the build for the stream/message buffers */');
  L.push('');
  if (port.basepri) {
    L.push('/* Cortex-M interrupt priorities: lower number = more urgent. */');
    L.push('#ifdef __NVIC_PRIO_BITS', `  #define configPRIO_BITS                          __NVIC_PRIO_BITS`, '#else', `  #define configPRIO_BITS                          ${bits}`, '#endif');
    def('configLIBRARY_LOWEST_INTERRUPT_PRIORITY', lowest, 'for NVIC_SetPriority()/HAL');
    def('configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY', syscall, `ISRs at ${syscall}..${lowest} may call FromISR`);
    def('configKERNEL_INTERRUPT_PRIORITY', '( configLIBRARY_LOWEST_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )', `0x${kernelRaw.toString(16).toUpperCase()}`);
    def('configMAX_SYSCALL_INTERRUPT_PRIORITY', '( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )', `0x${syscallRaw.toString(16).toUpperCase()} in BASEPRI`);
  } else {
    def('configKERNEL_INTERRUPT_PRIORITY', 255, 'Armv6-M: only the top 2 bits exist');
  }
  L.push('');
  L.push('#define configASSERT( x )    if( ( x ) == 0 ) { taskDISABLE_INTERRUPTS(); for( ;; ); }');
  L.push('', '/* Map the port handlers onto the CMSIS names (not with STM32Cube\'s own SysTick_Handler). */');
  def('vPortSVCHandler', 'SVC_Handler'); def('xPortPendSVHandler', 'PendSV_Handler'); def('xPortSysTickHandler', 'SysTick_Handler');
  L.push('', '#endif /* FREERTOS_CONFIG_H */');

  // ---- result ----
  const values = [
    { label: 'Heap used', value: used, unit: 'B', hint: `${pct.toFixed(1)} % of ${usable} B usable`, tone: free < 0 ? 'bad' : free < usable * 0.1 ? 'warn' : 'ok' },
    { label: 'Heap free', value: free, unit: 'B', tone: free < 0 ? 'bad' : undefined },
    { label: 'configTOTAL_HEAP_SIZE', value: total, unit: 'B' },
    { label: 'Suggested heap', value: suggest, unit: 'B', hint: 'used + 20 %, whole KiB' },
    { label: 'Block overhead', value: overhead, unit: 'B', hint: `${blocks.length} blocks${scheme === 'heap_1' ? ', alignment only' : ' × 8 B header + alignment'}` },
    { label: 'sizeof(TCB_t)', value: TCB, unit: 'B' },
    { label: 'sizeof(Queue_t)', value: QS, unit: 'B' },
    { label: 'SysTick reload', value: reload, tone: reloadOk ? undefined : 'bad' },
  ];
  if (port.basepri) {
    values.push({ label: 'configMAX_SYSCALL_INTERRUPT_PRIORITY', value: `0x${syscallRaw.toString(16).toUpperCase()}`, hint: `logical ${syscall} << ${shift}` });
    values.push({ label: 'configKERNEL_INTERRUPT_PRIORITY', value: `0x${kernelRaw.toString(16).toUpperCase()}`, hint: `logical ${lowest} << ${shift}` });
  }

  const groupBy = new Map();
  for (const b of blocks) {
    const k = `${b.owner}|${b.part}`;
    if (!groupBy.has(k)) groupBy.set(k, { ...b, n: 0, sum: 0 });
    const g = groupBy.get(k); g.n++; g.sum += b.size;
  }
  const tables = [
    { title: 'Heap blocks (in creation order)', columns: ['Object', 'Part', 'Requested B', 'Allocated B'],
      rows: blocks.map((b) => [b.owner, b.part, b.req, b.size]).concat([['Total', '', reqTotal, used]]) },
    { title: 'Tasks', columns: ['Task', 'Priority', 'Stack words', 'Stack B', 'Saved context words', 'Heap B (stack + TCB)', 'Issues'],
      rows: allTasks.map((t) => [t.name, t.prio, t.words, t.bytes, t.ctxWords, t.system && o.staticAlloc ? 'static' : alloc(t.bytes) + alloc(TCB), t.issues.join('; ') || '-']) },
  ];
  if (isrs.length) tables.push({ title: 'Interrupt priorities', columns: ['ISR', 'Priority', 'NVIC byte', 'Calls FromISR', 'Status'],
    rows: isrs.map((i) => [i.name, i.prio, `0x${i.raw.toString(16).toUpperCase().padStart(2, '0')}`, i.calls ? 'yes' : 'no',
      i.status === 'bad' ? 'NOT ALLOWED' : i.status === 'fast' ? 'above the kernel: never masked, no API' : 'masked in critical sections, API ok'] ) });

  return {
    values,
    tables,
    texts: [{ title: 'FreeRTOSConfig.h', body: L.join('\n') + '\n', lang: 'c' }],
    warnings,
    notes,
    view: {
      port: { id: portId, ...port },
      scheme, total, usable, used, free, suggest, pct,
      blocks: blocks.map((b) => ({ owner: b.owner, kind: b.kind, part: b.part, req: b.req, size: b.size, start: b.start, group: b.group })),
      tasks: allTasks.map((t) => ({ name: t.name, words: t.words, prio: t.prio, fpu: t.fpu, ctxWords: t.ctxWords, row: t.row, system: t.system, issues: t.issues })),
      objects, isrs, maxPrio, minStack, sizes: { TCB, QS, TS, EGS, SBS },
      nvic: { basepri: port.basepri, bits, levels, lowest, syscall, shift, syscallRaw, kernelRaw, subBits },
      tick: { reload, reloadOk, tickHz, cpuHz },
    },
  };
}

function fmt(v) {
  if (v >= 1e6) return `${Number((v / 1e6).toPrecision(6))} M`;
  if (v >= 1e3) return `${Number((v / 1e3).toPrecision(6))} k`;
  return String(v);
}
