# -*- coding: utf-8 -*-
"""The Redline bridge, inside Renode (IronPython 2.7 - no f-strings here).

Renode runs this with `include @bridge.py` after the machine is built and the
ELF is loaded. It speaks the SPEC messages (backend/sim/SPEC.md section 1) as
JSON Lines over one TCP connection that the adapter opens, then starts the
emulation. Everything below runs in the Renode process:

  MCU -> parts
    pin   GPIO outputs, from a hook on every write to a GPIO port (exact time)
    pwm   timer channels on pins in alternate-function mode, computed from the
          timer's registers (CR1, CCMR, CCER, PSC, ARR, CCR, BDTR) on a 1 ms
          virtual-time tick; Renode's STM32 timer has no PWM output of its own
    uart  what the USARTs transmit (CharReceived), a message per line or tick
    i2c   a proxy II2CPeripheral at each address of the board's I2C parts
    spi   a proxy ISPIPeripheral on each SPI bus, one transaction per byte
          (i2c/spi block the CPU thread until the reply: virtual time stops)
  parts -> MCU
    pin   drives a GPIO input (a button); undriven inputs follow PUPDR
    freq  a virtual-time pulse train on the pin; each rising edge also sets
          the capture flag of the timer channel the pin is routed to when
          that channel is in input-capture mode (Renode's timer has none)
    adc   the ADC channel's value
    uart  typed into the USART
    reply the answer to the transaction the CPU waits on

Virtual time never runs ahead of the wall clock (the tick sleeps when it is
ahead), so the runtime's wall-clock interpolation between events holds.
"""

import clr
import json
import System
clr.AddReference('System.Net.Primitives')
clr.AddReference('System.Net.Sockets')
from System import Array, Byte, Decimal, Func, Int64, UInt32
from System.Net import IPAddress
from System.Net.Sockets import TcpListener
from System.IO import StreamReader, StreamWriter
from System.Text import UTF8Encoding
from System.Threading import Thread, ThreadStart, ManualResetEvent
from System.Diagnostics import Stopwatch
from System.Reflection import BindingFlags
from Antmicro.Renode.Core import EmulationManager
from Antmicro.Renode.Core.Structure import NumberRegistrationPoint, NullRegistrationPoint
from Antmicro.Renode.Time import ClockEntry
from Antmicro.Renode.Peripherals.I2C import II2CPeripheral
from Antmicro.Renode.Peripherals.SPI import ISPIPeripheral

CONFIG = '/session/config.json'
PORTS = 'ABCDEF'
GPIO_BASE = 0x48000000          # port N at GPIO_BASE + N * 0x400
MODER, PUPDR, IDR, ODR, BSRR, AFRL, AFRH, BRR = 0x00, 0x0C, 0x10, 0x14, 0x18, 0x20, 0x24, 0x28

# STM32F0 timers and the pins their channels reach: (pin, AF) -> (timer, channel 0..3).
# From the STM32F042/F072 datasheets' alternate-function tables.
TIMERS = {'timer1': 0x40012C00, 'timer2': 0x40000000, 'timer3': 0x40000400, 'timer14': 0x40002000,
          'timer15': 0x40014000, 'timer16': 0x40014400, 'timer17': 0x40014800}
ADVANCED = ('timer1', 'timer15', 'timer16', 'timer17')      # outputs need BDTR.MOE
AF_TIMER = {
    ('PA0', 2): ('timer2', 0), ('PA1', 2): ('timer2', 1), ('PA2', 2): ('timer2', 2), ('PA3', 2): ('timer2', 3),
    ('PA2', 0): ('timer15', 0), ('PA3', 0): ('timer15', 1), ('PA4', 4): ('timer14', 0), ('PA5', 2): ('timer2', 0),
    ('PA6', 1): ('timer3', 0), ('PA6', 5): ('timer16', 0), ('PA7', 1): ('timer3', 1), ('PA7', 4): ('timer14', 0),
    ('PA7', 5): ('timer17', 0), ('PA8', 2): ('timer1', 0), ('PA9', 2): ('timer1', 1), ('PA10', 2): ('timer1', 2),
    ('PA11', 2): ('timer1', 3), ('PA15', 2): ('timer2', 0), ('PB0', 1): ('timer3', 2), ('PB1', 1): ('timer3', 3),
    ('PB1', 0): ('timer14', 0), ('PB3', 2): ('timer2', 1), ('PB4', 1): ('timer3', 0), ('PB5', 1): ('timer3', 1),
    ('PB8', 2): ('timer16', 0), ('PB9', 2): ('timer17', 0), ('PB10', 2): ('timer2', 2), ('PB11', 2): ('timer2', 3),
    ('PB14', 1): ('timer15', 0), ('PB15', 1): ('timer15', 1),
    ('PC6', 0): ('timer3', 0), ('PC7', 0): ('timer3', 1), ('PC8', 0): ('timer3', 2), ('PC9', 0): ('timer3', 3),
}
# ADC channels: PA0..PA7 -> IN0..IN7, PB0/PB1 -> IN8/IN9, PC0..PC5 -> IN10..IN15.
ADC_CHANNEL = dict([('PA%d' % i, i) for i in range(8)] + [('PB0', 8), ('PB1', 9)] +
                   [('PC%d' % i, 10 + i) for i in range(6)])

cfg = json.loads(open(CONFIG).read())
machine = list(EmulationManager.Instance.CurrentEmulation.Machines)[0]
bus = machine.SystemBus
PRIVATE = BindingFlags.NonPublic | BindingFlags.Instance


def peripheral(name):
    try:
        return machine['sysbus.' + name]
    except Exception:
        return None


def now_us():
    return int(machine.ElapsedVirtualTime.TimeElapsed.TotalMicroseconds)


def pin_name(port, n):
    return 'P%s%d' % (PORTS[port], n)


def parse_pin(name):
    """'PA6' -> (0, 6); None for anything else."""
    name = str(name).upper()
    if len(name) < 3 or name[0] != 'P' or name[1] not in PORTS or not name[2:].isdigit():
        return None
    return PORTS.index(name[1]), int(name[2:])


class Link(object):
    """The one TCP connection to the adapter: JSON Lines both ways."""

    def __init__(self, port):
        self.listener = TcpListener(IPAddress.Loopback, port)
        self.listener.Start()
        self.writer = None
        self.lock = System.Object()

    def accept(self):
        client = self.listener.AcceptTcpClient()
        client.NoDelay = True
        stream = client.GetStream()
        self.reader = StreamReader(stream, UTF8Encoding(False))
        self.writer = StreamWriter(stream, UTF8Encoding(False))
        self.writer.AutoFlush = True

    def send(self, msg):
        if self.writer is None:
            return
        line = json.dumps(msg, separators=(',', ':'))
        System.Threading.Monitor.Enter(self.lock)
        try:
            self.writer.Write(line + '\n')
        except Exception:
            self.writer = None
        finally:
            System.Threading.Monitor.Exit(self.lock)


class Bridge(object):
    def __init__(self):
        self.link = Link(int(cfg['port']))
        self.clock_hz = float(cfg.get('clock_hz', 8000000))
        self.tick_us = int(cfg.get('tick_us', 1000))
        self.ports = {}                       # port index -> GPIO peripheral
        for i, letter in enumerate(PORTS):
            p = peripheral('gpioPort' + letter)
            if p is not None:
                self.ports[i] = p
        self.shadow = {}                      # port -> {'moder', 'odr', 'pupdr'} as the CPU wrote them
        self.levels = {}                      # output pin -> last level sent
        self.pwm = {}                         # pin -> (duty, hz) last sent
        self.driven = set()                   # input pins a part drives
        self.uarts = {}                       # 'USART1' -> peripheral
        self.uart_buf = {}
        self.tach = {}                        # pin -> {'entry', 'handler', 'level'}
        self.pending = {}                     # transaction id -> [event, reply]
        self.next_id = 1
        self.wall = Stopwatch()
        self.t0 = 0
        self.ahead_ms = int(cfg.get('pace_ms', 2))

    # ---- MCU -> parts ----

    def emit(self, msg):
        msg['t'] = now_us()
        self.link.send(msg)

    def gpio_write(self, port, value, offset):
        """Before-write hook on a GPIO port: work out the register as it will be, then diff."""
        s = self.shadow[port]
        value = int(value)
        if offset == MODER:
            s['moder'] = value
        elif offset == ODR:
            s['odr'] = value & 0xFFFF
        elif offset == BSRR:
            s['odr'] = (s['odr'] & ~(value >> 16) | value) & 0xFFFF
        elif offset == BRR:
            s['odr'] = s['odr'] & ~value & 0xFFFF
        elif offset == PUPDR:
            s['pupdr'] = value
        else:
            return
        self.outputs(port)
        if offset in (MODER, PUPDR):
            self.pulls(port)

    def outputs(self, port):
        s = self.shadow[port]
        for n in range(16):
            if (s['moder'] >> 2 * n) & 3 != 1:
                continue
            name, level = pin_name(port, n), (s['odr'] >> n) & 1
            if self.levels.get(name) != level:
                self.levels[name] = level
                self.pwm.pop(name, None)
                self.emit({'type': 'pin', 'pin': name, 'level': level})

    def pulls(self, port):
        """An input nobody drives reads what its pull-up or pull-down says."""
        s, gpio = self.shadow[port], self.ports[port]
        for n in range(16):
            if (s['moder'] >> 2 * n) & 3 != 0 or pin_name(port, n) in self.driven:
                continue
            pull = (s['pupdr'] >> 2 * n) & 3
            if pull in (1, 2):
                gpio.OnGPIO(n, pull == 1)

    def timer_channel(self, name):
        """(timer, channel) a pin in alternate-function mode is routed to, or None."""
        at = parse_pin(name)
        if at is None or at[0] not in self.ports:
            return None
        port, n = at
        if (self.shadow[port]['moder'] >> 2 * n) & 3 != 2:
            return None
        base = GPIO_BASE + port * 0x400
        afr = bus.ReadDoubleWord(base + (AFRL if n < 8 else AFRH))
        af = (afr >> 4 * (n % 8)) & 0xF
        return AF_TIMER.get((name, af))

    def pwm_of(self, timer, ch):
        base = TIMERS[timer]
        r = lambda off: bus.ReadDoubleWord(base + off)
        cr1, ccer, psc, arr = r(0x00), r(0x20), r(0x28), r(0x2C)
        ccmr = r(0x18 if ch < 2 else 0x1C) >> (8 * (ch % 2))
        if ccmr & 3:                                    # an input, not an output
            return None
        mode = (ccmr >> 4) & 7
        on = cr1 & 1 and (ccer >> 4 * ch) & 1 and (timer not in ADVANCED or r(0x44) & 0x8000)
        if not on:
            return 0.0, 0.0
        centre = (cr1 >> 5) & 3
        period = (arr + 1) if not centre else 2 * max(arr, 1)
        hz = self.clock_hz / (psc + 1) / period
        ccr = r(0x34 + 4 * ch)
        if mode == 6:
            duty = min(ccr, arr + 1) / float(arr + 1)
        elif mode == 7:
            duty = 1.0 - min(ccr, arr + 1) / float(arr + 1)
        elif mode == 5:
            duty = 1.0
        elif mode == 4:
            duty = 0.0
        else:
            return None
        if (ccer >> (4 * ch + 1)) & 1:                  # active low
            duty = 1.0 - duty
        return round(duty, 4), round(hz, 3)

    def poll_pwm(self):
        for port, s in self.shadow.items():
            for n in range(16):
                if (s['moder'] >> 2 * n) & 3 != 2:
                    continue
                name = pin_name(port, n)
                route = self.timer_channel(name)
                if route is None:
                    continue
                value = self.pwm_of(*route)
                if value is not None and self.pwm.get(name) != value:
                    self.pwm[name] = value
                    self.levels.pop(name, None)
                    self.emit({'type': 'pwm', 'pin': name, 'duty': value[0], 'hz': value[1]})

    def on_char(self, port, b):
        buf = self.uart_buf[port]
        buf.append(int(b))
        if int(b) == 10:
            self.flush_uart(port)

    def flush_uart(self, port):
        buf = self.uart_buf[port]
        if buf:
            data = bytearray(buf)
            del buf[:]
            self.emit({'type': 'uart', 'port': port, 'data': data.decode('utf-8', 'replace')})

    def tick(self):
        try:
            for port in self.uarts:
                self.flush_uart(port)
            self.poll_pwm()
            ahead = (now_us() - self.t0) / 1000 - self.wall.ElapsedMilliseconds
            if ahead > self.ahead_ms:
                Thread.Sleep(int(ahead))
        except Exception as e:
            machine.InfoLog('redline tick: %s' % e)

    def transact(self, msg):
        """Send an i2c/spi transaction and hold the CPU thread (and so virtual time) for the reply."""
        tid = self.next_id
        self.next_id += 1
        msg['id'] = tid
        done = ManualResetEvent(False)
        self.pending[tid] = [done, None]
        self.emit(msg)
        if not done.WaitOne(int(cfg.get('reply_timeout_ms', 10000))):
            self.pending.pop(tid, None)
            return None
        return self.pending.pop(tid)[1]

    # ---- parts -> MCU ----

    def set_pin(self, name, level):
        at = parse_pin(name)
        if at is None or at[0] not in self.ports:
            return
        self.driven.add(name)
        self.ports[at[0]].OnGPIO(at[1], bool(level))

    def set_freq(self, name, hz):
        """A square wave on the pin in virtual time. A new rate keeps the phase and level,
        so a fan model updating its speed every tick does not add or lose edges."""
        at = parse_pin(name)
        if at is None or at[0] not in self.ports:
            return
        state = self.tach.get(name)
        if hz <= 0:
            if state is not None:
                machine.ClockSource.TryRemoveClockEntry(state['handler'])
                del self.tach[name]
            return
        half = max(1, int(round(1e6 / (2.0 * hz))))     # microseconds per half period
        if state is not None:
            machine.ClockSource.ExchangeClockEntryWith(
                state['handler'], Func[ClockEntry, ClockEntry](lambda e: self._retime(e, half)), None)
            return
        gpio, n = self.ports[at[0]], at[1]
        state = {'level': False}
        self.driven.add(name)

        def edge():
            state['level'] = not state['level']
            gpio.OnGPIO(n, state['level'])
            self.capture(name, state['level'])

        state['handler'] = System.Action(edge)
        machine.ClockSource.AddClockEntry(ClockEntry(half, 1000000, state['handler'], machine, 'redline-' + name, True))
        self.tach[name] = state

    @staticmethod
    def _retime(entry, half):
        """The same entry at a new half period; the edge due is never later than one new half period."""
        if str(entry.Direction) == 'Descending':          # Value counts down to 0
            return entry.With(period=half, value=min(entry.Value, half))
        return entry.With(period=half, value=max(entry.Value, entry.Period - half) - (entry.Period - half))

    def capture(self, name, rising):
        """An edge on a pin routed to a timer channel in input-capture mode sets CCxIF."""
        route = self.timer_channel(name)
        if route is None:
            return
        timer, ch = route
        base = TIMERS[timer]
        ccmr = bus.ReadDoubleWord(base + (0x18 if ch < 2 else 0x1C)) >> (8 * (ch % 2))
        ccer = bus.ReadDoubleWord(base + 0x20)
        if not ccmr & 3 or not (ccer >> 4 * ch) & 1:
            return
        falling, both = (ccer >> (4 * ch + 1)) & 1, (ccer >> (4 * ch + 3)) & 1
        if not both and rising == bool(falling):
            return
        t = peripheral(timer)
        flags = t.GetType().GetField('ccInterruptFlag', PRIVATE).GetValue(t)
        flags[ch] = True
        t.GetType().GetMethod('UpdateInterrupts', PRIVATE).Invoke(t, None)

    def set_adc(self, name, volts):
        adc, ch = peripheral('adc'), ADC_CHANNEL.get(str(name).upper())
        if adc is not None and ch is not None:
            adc.SetDefaultValue(Decimal(float(volts) * 1000.0), ch)

    def type_uart(self, port, text):
        u = self.uarts.get(str(port).upper())
        if u is None:
            return
        for b in bytearray(text.encode('utf-8')):
            u.WriteChar(b)

    def reply(self, msg):
        entry = self.pending.get(msg.get('id'))
        if entry is not None:
            entry[1] = msg
            entry[0].Set()

    def handle(self, msg):
        kind = msg.get('type')
        if kind == 'pin':
            self.set_pin(msg['pin'], msg['level'])
        elif kind == 'freq':
            self.set_freq(msg['pin'], float(msg['hz']))
        elif kind == 'adc':
            self.set_adc(msg['pin'], msg['volts'])
        elif kind == 'uart':
            self.type_uart(msg.get('port', 'USART1'), msg.get('data', ''))
        elif kind == 'reply':
            self.reply(msg)

    def read_loop(self):
        while True:
            line = self.link.reader.ReadLine()
            if line is None:
                break
            try:
                self.handle(json.loads(line))
            except Exception as e:
                machine.InfoLog('redline: bad message %r: %s' % (line[:120], e))
        EmulationManager.Instance.CurrentEmulation.PauseAll()

    # ---- wiring ----

    def wire(self):
        for port, gpio in self.ports.items():
            base = GPIO_BASE + port * 0x400
            self.shadow[port] = {'moder': bus.ReadDoubleWord(base + MODER), 'odr': bus.ReadDoubleWord(base + ODR),
                                 'pupdr': bus.ReadDoubleWord(base + PUPDR)}
            hook = (lambda p: lambda value, offset: self._hooked(p, value, offset))(port)
            bus.SetHookBeforePeripheralWrite[UInt32](gpio, Func[UInt32, Int64, UInt32](hook), None)
            self.pulls(port)
        for i in range(1, 9):
            u = peripheral('usart%d' % i)
            if u is None:
                continue
            name = 'USART%d' % i
            self.uarts[name], self.uart_buf[name] = u, []
            u.CharReceived += (lambda p: lambda b: self.on_char(p, b))(name)
        for dev in cfg.get('i2c', []):
            ctrl = peripheral(dev['controller'])
            if ctrl is not None:
                ctrl.Register(I2CProxy(self, dev['bus'], int(dev['addr'])),
                              NumberRegistrationPoint[int](int(dev['addr'])))
        for dev in cfg.get('spi', []):
            ctrl = peripheral(dev['controller'])
            if ctrl is not None:
                ctrl.Register(SPIProxy(self, dev['bus'], dev.get('cs') or []),
                              NullRegistrationPoint.Instance)
        self.clock = System.Action(self.tick)
        machine.ClockSource.AddClockEntry(ClockEntry(self.tick_us, 1000000, self.clock, machine, 'redline-tick', True))

    def _hooked(self, port, value, offset):
        try:
            self.gpio_write(port, value, offset)
        except Exception as e:
            machine.InfoLog('redline gpio hook: %s' % e)
        return value

    def serve(self):
        self.link.accept()
        self.link.send({'type': 'hello', 'sim': 'redline-renode', 't': now_us()})
        self.t0 = now_us()
        self.wall.Start()
        Thread(ThreadStart(self.read_loop)).Start()
        EmulationManager.Instance.CurrentEmulation.StartAll()


class I2CProxy(II2CPeripheral):
    """Any I2C part: bytes the controller writes are kept until a read or the stop,
    then go out as one `i2c` transaction; the CPU waits for the `reply`."""

    def __init__(self, bridge, bus_name, addr):
        self.bridge, self.bus_name, self.addr, self.out = bridge, bus_name, addr, []

    def _go(self, read):
        msg = {'type': 'i2c', 'bus': self.bus_name, 'addr': self.addr,
               'write': ''.join('%02x' % b for b in self.out), 'read': read}
        self.out = []
        answer = self.bridge.transact(msg)
        data = bytearray.fromhex(str(answer.get('data') or '')) if answer else bytearray()
        return (list(data) + [0xFF] * read)[:read]

    def Write(self, data):
        self.out.extend(int(b) for b in data)

    def Read(self, count=1):
        return Array[Byte]([Byte(b) for b in self._go(int(count))])

    def FinishTransmission(self):
        if self.out:
            self._go(0)

    def Reset(self):
        self.out = []


class SPIProxy(ISPIPeripheral):
    """Any SPI part: SPI is full duplex, so each byte is a transaction (write 1, read 1).
    `cs` is the chip-select pin whose output is low, among the board's parts on this bus."""

    def __init__(self, bridge, bus_name, cs):
        self.bridge, self.bus_name, self.cs = bridge, bus_name, list(cs)

    def _cs(self):
        for name in self.cs:
            if self.bridge.levels.get(name) == 0:
                return name
        return self.cs[0] if self.cs else '?'

    def Transmit(self, data):
        answer = self.bridge.transact({'type': 'spi', 'bus': self.bus_name, 'cs': self._cs(),
                                       'write': '%02x' % int(data), 'read': 1})
        data = bytearray.fromhex(str(answer.get('data') or '')) if answer else bytearray()
        return Byte(data[0] if data else 0xFF)

    def FinishTransmission(self):
        pass

    def Reset(self):
        pass


redline = Bridge()
redline.wire()
Thread(ThreadStart(redline.serve)).Start()
