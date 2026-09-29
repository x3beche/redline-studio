// A small synthetic CMSIS-SVD file written for this tool (not copied from any
// vendor file). The part "RLX32F1" does not exist; its peripherals are laid
// out the way a typical Cortex-M3/M4 microcontroller lays them out, so that
// every SVD feature the browser handles shows up once:
//   derivedFrom on peripherals (GPIOB/GPIOC, USART2), register arrays
//   (TIM2 CCR[%s]), list-style dim names (EXTI MR%s fields), clusters with a
//   dim (DMA1 CH[%s]), enumeratedValues with don't-care bits (RCC HPRE #0xxx),
//   modifiedWriteValues (oneToClear, zeroToClear), readAction, write-only
//   and read-only fields, a 16-bit register and interrupts.
// Element names and meanings follow the CMSIS-SVD schema 1.3 (Arm, Apache-2.0):
// https://arm-software.github.io/CMSIS_5/SVD/html/svd_Format_pg.html

export const SAMPLE_SVD = `<?xml version="1.0" encoding="utf-8"?>
<!-- Synthetic example device for the Redline SVD browser. -->
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xs:noNamespaceSchemaLocation="CMSIS-SVD.xsd">
  <vendor>Redline</vendor>
  <name>RLX32F1</name>
  <version>1.2</version>
  <description>Synthetic Cortex-M4 microcontroller used as the example device</description>
  <cpu>
    <name>CM4</name><revision>r0p1</revision><endian>little</endian>
    <mpuPresent>true</mpuPresent><fpuPresent>true</fpuPresent>
    <nvicPrioBits>4</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig>
  </cpu>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>32</size>
  <access>read-write</access>
  <resetValue>0x00000000</resetValue>
  <resetMask>0xFFFFFFFF</resetMask>
  <peripherals>
    <peripheral>
      <name>TIM2</name>
      <description>General-purpose 32-bit timer</description>
      <groupName>TIM</groupName>
      <baseAddress>0x40000000</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <interrupt><name>TIM2</name><description>TIM2 global interrupt</description><value>28</value></interrupt>
      <registers>
        <register>
          <name>CR1</name><description>Control register 1</description>
          <addressOffset>0x00</addressOffset><size>16</size><resetValue>0x0000</resetValue>
          <fields>
            <field><name>CEN</name><description>Counter enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>UDIS</name><description>Update disable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>URS</name><description>Update request source</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>OPM</name><description>One-pulse mode</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>DIR</name><description>Counting direction</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Up</name><description>Counter counts up</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Down</name><description>Counter counts down</description><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>CMS</name><description>Center-aligned mode selection</description><bitRange>[6:5]</bitRange>
              <enumeratedValues>
                <enumeratedValue><name>Edge</name><description>Edge-aligned, DIR sets the direction</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Center1</name><description>Center-aligned 1: compare flags set counting down</description><value>1</value></enumeratedValue>
                <enumeratedValue><name>Center2</name><description>Center-aligned 2: compare flags set counting up</description><value>2</value></enumeratedValue>
                <enumeratedValue><name>Center3</name><description>Center-aligned 3: compare flags set both ways</description><value>3</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>ARPE</name><description>Auto-reload preload enable</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CKD</name><description>Clock division for the dead-time and filter clock</description><lsb>8</lsb><msb>9</msb>
              <enumeratedValues>
                <enumeratedValue><name>Div1</name><description>tDTS = tCK_INT</description><value>0b00</value></enumeratedValue>
                <enumeratedValue><name>Div2</name><description>tDTS = 2 x tCK_INT</description><value>0b01</value></enumeratedValue>
                <enumeratedValue><name>Div4</name><description>tDTS = 4 x tCK_INT</description><value>0b10</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register>
          <name>DIER</name><description>DMA and interrupt enable register</description>
          <addressOffset>0x0C</addressOffset><size>16</size>
          <fields>
            <field><name>UIE</name><description>Update interrupt enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>4</dim><dimIncrement>1</dimIncrement><dimIndex>1-4</dimIndex><name>CC%sIE</name><description>Capture/compare %s interrupt enable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>UDE</name><description>Update DMA request enable</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>SR</name><description>Status register (write 0 to clear a flag)</description>
          <addressOffset>0x10</addressOffset><size>16</size>
          <modifiedWriteValues>zeroToClear</modifiedWriteValues>
          <fields>
            <field><name>UIF</name><description>Update interrupt flag</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>4</dim><dimIncrement>1</dimIncrement><dimIndex>1-4</dimIndex><name>CC%sIF</name><description>Capture/compare %s interrupt flag</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>4</dim><dimIncrement>1</dimIncrement><dimIndex>1-4</dimIndex><name>CC%sOF</name><description>Capture/compare %s overcapture flag</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>EGR</name><description>Event generation register</description>
          <addressOffset>0x14</addressOffset><size>16</size><access>write-only</access>
          <fields>
            <field><name>UG</name><description>Update generation</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>4</dim><dimIncrement>1</dimIncrement><dimIndex>1-4</dimIndex><name>CC%sG</name><description>Capture/compare %s generation</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>CNT</name><description>Counter</description><addressOffset>0x24</addressOffset>
          <fields><field><name>CNT</name><description>Counter value</description><bitRange>[31:0]</bitRange></field></fields>
        </register>
        <register>
          <name>PSC</name><description>Prescaler (counter clock = fCK_PSC / (PSC + 1))</description><addressOffset>0x28</addressOffset><size>16</size>
          <fields><field><name>PSC</name><description>Prescaler value</description><bitRange>[15:0]</bitRange></field></fields>
        </register>
        <register>
          <name>ARR</name><description>Auto-reload register</description><addressOffset>0x2C</addressOffset><resetValue>0xFFFFFFFF</resetValue>
          <fields><field><name>ARR</name><description>Auto-reload value</description><bitRange>[31:0]</bitRange></field></fields>
        </register>
        <register>
          <dim>4</dim><dimIncrement>0x4</dimIncrement>
          <name>CCR[%s]</name><description>Capture/compare register %s</description><addressOffset>0x34</addressOffset>
          <fields><field><name>CCR</name><description>Capture/compare value</description><bitRange>[31:0]</bitRange></field></fields>
        </register>
      </registers>
    </peripheral>
    <peripheral>
      <name>USART1</name>
      <description>Universal synchronous asynchronous receiver transmitter</description>
      <groupName>USART</groupName>
      <baseAddress>0x40013800</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <interrupt><name>USART1</name><description>USART1 global interrupt</description><value>37</value></interrupt>
      <registers>
        <register>
          <name>SR</name><description>Status register</description>
          <addressOffset>0x00</addressOffset><resetValue>0x000000C0</resetValue>
          <fields>
            <field><name>PE</name><description>Parity error</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>FE</name><description>Framing error</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>NE</name><description>Noise detected</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>ORE</name><description>Overrun error (cleared by reading SR then DR)</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>IDLE</name><description>Idle line detected</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>RXNE</name><description>Read data register not empty</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>zeroToClear</modifiedWriteValues></field>
            <field><name>TC</name><description>Transmission complete</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>zeroToClear</modifiedWriteValues></field>
            <field><name>TXE</name><description>Transmit data register empty</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>LBD</name><description>LIN break detection flag</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>zeroToClear</modifiedWriteValues></field>
            <field><name>CTS</name><description>CTS flag</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>zeroToClear</modifiedWriteValues></field>
          </fields>
        </register>
        <register>
          <name>DR</name><description>Data register</description><addressOffset>0x04</addressOffset><resetValue>0x00000000</resetValue><resetMask>0x00000000</resetMask>
          <readAction>modify</readAction>
          <fields><field><name>DR</name><description>Data value (a read pops the receive buffer)</description><bitOffset>0</bitOffset><bitWidth>9</bitWidth></field></fields>
        </register>
        <register>
          <name>BRR</name><description>Baud rate register: USARTDIV = fPCLK / baud, as mantissa.fraction/16</description><addressOffset>0x08</addressOffset>
          <fields>
            <field><name>DIV_Fraction</name><description>Fraction of USARTDIV (sixteenths)</description><bitOffset>0</bitOffset><bitWidth>4</bitWidth></field>
            <field><name>DIV_Mantissa</name><description>Mantissa of USARTDIV</description><bitOffset>4</bitOffset><bitWidth>12</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>CR1</name><description>Control register 1</description><addressOffset>0x0C</addressOffset>
          <fields>
            <field><name>SBK</name><description>Send break</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>RWU</name><description>Receiver wakeup (mute mode)</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>RE</name><description>Receiver enable</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>TE</name><description>Transmitter enable</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>IDLEIE</name><description>IDLE interrupt enable</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>RXNEIE</name><description>RXNE interrupt enable</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>TCIE</name><description>Transmission complete interrupt enable</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>TXEIE</name><description>TXE interrupt enable</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>PEIE</name><description>PE interrupt enable</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>PS</name><description>Parity selection</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Even</name><description>Even parity</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Odd</name><description>Odd parity</description><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>PCE</name><description>Parity control enable</description><bitOffset>10</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>WAKE</name><description>Wakeup method</description><bitOffset>11</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>IdleLine</name><description>Wake on idle line</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>AddressMark</name><description>Wake on address mark</description><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>M</name><description>Word length</description><bitOffset>12</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Bits8</name><description>1 start bit, 8 data bits, n stop bits</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Bits9</name><description>1 start bit, 9 data bits, n stop bits</description><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>UE</name><description>USART enable</description><bitOffset>13</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>OVER8</name><description>Oversampling by 8 (0: by 16)</description><bitOffset>15</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>CR2</name><description>Control register 2</description><addressOffset>0x10</addressOffset>
          <fields>
            <field><name>ADD</name><description>Address of the USART node</description><bitOffset>0</bitOffset><bitWidth>4</bitWidth></field>
            <field><name>LBDL</name><description>LIN break detection length</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>LBDIE</name><description>LIN break detection interrupt enable</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>LBCL</name><description>Last bit clock pulse</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CPHA</name><description>Clock phase</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CPOL</name><description>Clock polarity</description><bitOffset>10</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CLKEN</name><description>Clock enable</description><bitOffset>11</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>STOP</name><description>Number of stop bits</description><bitOffset>12</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Stop1</name><description>1 stop bit</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Stop0p5</name><description>0.5 stop bit</description><value>1</value></enumeratedValue>
                <enumeratedValue><name>Stop2</name><description>2 stop bits</description><value>2</value></enumeratedValue>
                <enumeratedValue><name>Stop1p5</name><description>1.5 stop bits</description><value>3</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>LINEN</name><description>LIN mode enable</description><bitOffset>14</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>CR3</name><description>Control register 3</description><addressOffset>0x14</addressOffset>
          <fields>
            <field><name>EIE</name><description>Error interrupt enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>HDSEL</name><description>Half-duplex selection</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>DMAR</name><description>DMA enable receiver</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>DMAT</name><description>DMA enable transmitter</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>RTSE</name><description>RTS enable</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CTSE</name><description>CTS enable</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="USART1">
      <name>USART2</name>
      <baseAddress>0x40004400</baseAddress>
      <interrupt><name>USART2</name><description>USART2 global interrupt</description><value>38</value></interrupt>
    </peripheral>
    <peripheral>
      <name>EXTI</name>
      <description>External interrupt/event controller</description>
      <baseAddress>0x40010400</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <registers>
        <register>
          <name>IMR</name><description>Interrupt mask register</description><addressOffset>0x00</addressOffset>
          <fields><field><dim>20</dim><dimIncrement>1</dimIncrement><name>MR%s</name><description>Interrupt request on line %s not masked</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>RTSR</name><description>Rising trigger selection register</description><addressOffset>0x08</addressOffset>
          <fields><field><dim>20</dim><dimIncrement>1</dimIncrement><name>TR%s</name><description>Rising trigger on line %s</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>FTSR</name><description>Falling trigger selection register</description><addressOffset>0x0C</addressOffset>
          <fields><field><dim>20</dim><dimIncrement>1</dimIncrement><name>TR%s</name><description>Falling trigger on line %s</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>PR</name><description>Pending register (write 1 to clear)</description><addressOffset>0x14</addressOffset>
          <modifiedWriteValues>oneToClear</modifiedWriteValues>
          <fields><field><dim>20</dim><dimIncrement>1</dimIncrement><name>PR%s</name><description>Pending bit on line %s</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
      </registers>
    </peripheral>
    <peripheral>
      <name>GPIOA</name>
      <description>General-purpose I/O port</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x40010800</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <registers>
        <register>
          <name>MODER</name><description>Port mode register</description><addressOffset>0x00</addressOffset><resetValue>0xA8000000</resetValue>
          <fields>
            <field><dim>16</dim><dimIncrement>2</dimIncrement><name>MODE%s</name><description>Pin %s mode</description><bitOffset>0</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <name>PinMode</name>
                <enumeratedValue><name>Input</name><description>Input (reset state)</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>Output</name><description>General-purpose output</description><value>1</value></enumeratedValue>
                <enumeratedValue><name>Alternate</name><description>Alternate function</description><value>2</value></enumeratedValue>
                <enumeratedValue><name>Analog</name><description>Analog</description><value>3</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register>
          <name>OTYPER</name><description>Port output type register</description><addressOffset>0x04</addressOffset>
          <fields><field><dim>16</dim><dimIncrement>1</dimIncrement><name>OT%s</name><description>Pin %s output type (0 push-pull, 1 open-drain)</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>IDR</name><description>Port input data register</description><addressOffset>0x10</addressOffset><access>read-only</access><resetMask>0x00000000</resetMask>
          <fields><field><dim>16</dim><dimIncrement>1</dimIncrement><name>ID%s</name><description>Pin %s input level</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>ODR</name><description>Port output data register</description><addressOffset>0x14</addressOffset>
          <fields><field><dim>16</dim><dimIncrement>1</dimIncrement><name>OD%s</name><description>Pin %s output level</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field></fields>
        </register>
        <register>
          <name>BSRR</name><description>Port bit set/reset register (atomic)</description><addressOffset>0x18</addressOffset><access>write-only</access>
          <fields>
            <field><dim>16</dim><dimIncrement>1</dimIncrement><name>BS%s</name><description>Set pin %s</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>oneToSet</modifiedWriteValues></field>
            <field><dim>16</dim><dimIncrement>1</dimIncrement><name>BR%s</name><description>Reset pin %s</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>oneToClear</modifiedWriteValues></field>
          </fields>
        </register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOB</name><baseAddress>0x40010C00</baseAddress>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOC</name><baseAddress>0x40011000</baseAddress>
    </peripheral>
    <peripheral>
      <name>DMA1</name>
      <description>Direct memory access controller, 7 channels</description>
      <groupName>DMA</groupName>
      <baseAddress>0x40020000</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <interrupt><name>DMA1_Channel1</name><value>11</value></interrupt>
      <interrupt><name>DMA1_Channel2</name><value>12</value></interrupt>
      <registers>
        <register>
          <name>ISR</name><description>Interrupt status register</description><addressOffset>0x00</addressOffset><access>read-only</access>
          <fields>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>GIF%s</name><description>Channel %s global interrupt flag</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>TCIF%s</name><description>Channel %s transfer complete flag</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>HTIF%s</name><description>Channel %s half transfer flag</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>TEIF%s</name><description>Channel %s transfer error flag</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>IFCR</name><description>Interrupt flag clear register</description><addressOffset>0x04</addressOffset><access>write-only</access>
          <modifiedWriteValues>oneToClear</modifiedWriteValues>
          <fields>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>CGIF%s</name><description>Clear channel %s global flag</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>CTCIF%s</name><description>Clear channel %s transfer complete flag</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>CHTIF%s</name><description>Clear channel %s half transfer flag</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><dim>7</dim><dimIncrement>4</dimIncrement><dimIndex>1-7</dimIndex><name>CTEIF%s</name><description>Clear channel %s transfer error flag</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <cluster>
          <dim>7</dim><dimIncrement>0x14</dimIncrement>
          <name>CH[%s]</name><description>DMA channel %s</description><addressOffset>0x08</addressOffset>
          <register>
            <name>CCR</name><description>Channel configuration register</description><addressOffset>0x00</addressOffset>
            <fields>
              <field><name>EN</name><description>Channel enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>TCIE</name><description>Transfer complete interrupt enable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>HTIE</name><description>Half transfer interrupt enable</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>TEIE</name><description>Transfer error interrupt enable</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>DIR</name><description>Data transfer direction</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth>
                <enumeratedValues>
                  <enumeratedValue><name>FromPeripheral</name><description>Read from peripheral</description><value>0</value></enumeratedValue>
                  <enumeratedValue><name>FromMemory</name><description>Read from memory</description><value>1</value></enumeratedValue>
                </enumeratedValues>
              </field>
              <field><name>CIRC</name><description>Circular mode</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>PINC</name><description>Peripheral increment mode</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>MINC</name><description>Memory increment mode</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth></field>
              <field><name>PSIZE</name><description>Peripheral size</description><bitOffset>8</bitOffset><bitWidth>2</bitWidth>
                <enumeratedValues>
                  <name>TransferSize</name>
                  <enumeratedValue><name>Bits8</name><description>8-bit</description><value>0</value></enumeratedValue>
                  <enumeratedValue><name>Bits16</name><description>16-bit</description><value>1</value></enumeratedValue>
                  <enumeratedValue><name>Bits32</name><description>32-bit</description><value>2</value></enumeratedValue>
                </enumeratedValues>
              </field>
              <field><name>MSIZE</name><description>Memory size</description><bitOffset>10</bitOffset><bitWidth>2</bitWidth>
                <enumeratedValues derivedFrom="TransferSize"></enumeratedValues>
              </field>
              <field><name>PL</name><description>Channel priority level</description><bitOffset>12</bitOffset><bitWidth>2</bitWidth>
                <enumeratedValues>
                  <enumeratedValue><name>Low</name><value>0</value></enumeratedValue>
                  <enumeratedValue><name>Medium</name><value>1</value></enumeratedValue>
                  <enumeratedValue><name>High</name><value>2</value></enumeratedValue>
                  <enumeratedValue><name>VeryHigh</name><value>3</value></enumeratedValue>
                </enumeratedValues>
              </field>
              <field><name>MEM2MEM</name><description>Memory-to-memory mode</description><bitOffset>14</bitOffset><bitWidth>1</bitWidth></field>
            </fields>
          </register>
          <register>
            <name>CNDTR</name><description>Number of data to transfer</description><addressOffset>0x04</addressOffset>
            <fields><field><name>NDT</name><description>Number of data items left</description><bitOffset>0</bitOffset><bitWidth>16</bitWidth></field></fields>
          </register>
          <register>
            <name>CPAR</name><description>Peripheral address</description><addressOffset>0x08</addressOffset>
            <fields><field><name>PA</name><description>Peripheral address</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth></field></fields>
          </register>
          <register>
            <name>CMAR</name><description>Memory address</description><addressOffset>0x0C</addressOffset>
            <fields><field><name>MA</name><description>Memory address</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth></field></fields>
          </register>
        </cluster>
      </registers>
    </peripheral>
    <peripheral>
      <name>RCC</name>
      <description>Reset and clock control</description>
      <baseAddress>0x40021000</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <interrupt><name>RCC</name><description>RCC global interrupt</description><value>5</value></interrupt>
      <registers>
        <register>
          <name>CR</name><description>Clock control register</description><addressOffset>0x00</addressOffset><resetValue>0x00000083</resetValue><resetMask>0xFFFFFF03</resetMask>
          <fields>
            <field><name>HSION</name><description>Internal high-speed oscillator enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>HSIRDY</name><description>Internal oscillator ready</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>HSITRIM</name><description>Internal oscillator trimming</description><bitOffset>3</bitOffset><bitWidth>5</bitWidth></field>
            <field><name>HSICAL</name><description>Internal oscillator calibration (factory set)</description><bitOffset>8</bitOffset><bitWidth>8</bitWidth><access>read-only</access></field>
            <field><name>HSEON</name><description>External oscillator enable</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>HSERDY</name><description>External oscillator ready</description><bitOffset>17</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>HSEBYP</name><description>External oscillator bypass</description><bitOffset>18</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>CSSON</name><description>Clock security system enable</description><bitOffset>19</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>PLLON</name><description>PLL enable</description><bitOffset>24</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>PLLRDY</name><description>PLL clock ready</description><bitOffset>25</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
          </fields>
        </register>
        <register>
          <name>CFGR</name><description>Clock configuration register</description><addressOffset>0x04</addressOffset>
          <fields>
            <field><name>SW</name><description>System clock switch</description><bitOffset>0</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <name>ClockSource</name>
                <enumeratedValue><name>HSI</name><description>HSI selected as system clock</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>HSE</name><description>HSE selected as system clock</description><value>1</value></enumeratedValue>
                <enumeratedValue><name>PLL</name><description>PLL selected as system clock</description><value>2</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>SWS</name><description>System clock switch status</description><bitOffset>2</bitOffset><bitWidth>2</bitWidth><access>read-only</access>
              <enumeratedValues derivedFrom="ClockSource"></enumeratedValues>
            </field>
            <field><name>HPRE</name><description>AHB prescaler</description><bitOffset>4</bitOffset><bitWidth>4</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>Div1</name><description>SYSCLK not divided</description><value>#0xxx</value></enumeratedValue>
                <enumeratedValue><name>Div2</name><description>SYSCLK / 2</description><value>8</value></enumeratedValue>
                <enumeratedValue><name>Div4</name><description>SYSCLK / 4</description><value>9</value></enumeratedValue>
                <enumeratedValue><name>Div8</name><description>SYSCLK / 8</description><value>10</value></enumeratedValue>
                <enumeratedValue><name>Div16</name><description>SYSCLK / 16</description><value>11</value></enumeratedValue>
                <enumeratedValue><name>Div64</name><description>SYSCLK / 64</description><value>12</value></enumeratedValue>
                <enumeratedValue><name>Div128</name><description>SYSCLK / 128</description><value>13</value></enumeratedValue>
                <enumeratedValue><name>Div256</name><description>SYSCLK / 256</description><value>14</value></enumeratedValue>
                <enumeratedValue><name>Div512</name><description>SYSCLK / 512</description><value>15</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>PPRE1</name><description>APB1 prescaler</description><bitOffset>8</bitOffset><bitWidth>3</bitWidth>
              <enumeratedValues>
                <name>ApbPrescaler</name>
                <enumeratedValue><name>Div1</name><description>HCLK not divided</description><value>#0xx</value></enumeratedValue>
                <enumeratedValue><name>Div2</name><description>HCLK / 2</description><value>4</value></enumeratedValue>
                <enumeratedValue><name>Div4</name><description>HCLK / 4</description><value>5</value></enumeratedValue>
                <enumeratedValue><name>Div8</name><description>HCLK / 8</description><value>6</value></enumeratedValue>
                <enumeratedValue><name>Div16</name><description>HCLK / 16</description><value>7</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>PPRE2</name><description>APB2 prescaler</description><bitOffset>11</bitOffset><bitWidth>3</bitWidth>
              <enumeratedValues derivedFrom="ApbPrescaler"></enumeratedValues>
            </field>
            <field><name>PLLSRC</name><description>PLL entry clock source</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>HSI_Div2</name><description>HSI / 2</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>HSE</name><description>HSE</description><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field><name>PLLMUL</name><description>PLL multiplication factor (value + 2, 15 = x16)</description><bitOffset>18</bitOffset><bitWidth>4</bitWidth></field>
            <field><name>MCO</name><description>Microcontroller clock output</description><bitOffset>24</bitOffset><bitWidth>3</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>NoClock</name><description>No clock</description><value>#0xx</value></enumeratedValue>
                <enumeratedValue><name>SYSCLK</name><description>System clock</description><value>4</value></enumeratedValue>
                <enumeratedValue><name>HSI</name><description>HSI clock</description><value>5</value></enumeratedValue>
                <enumeratedValue><name>HSE</name><description>HSE clock</description><value>6</value></enumeratedValue>
                <enumeratedValue><name>PLL_Div2</name><description>PLL clock / 2</description><value>7</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register>
          <name>CIR</name><description>Clock interrupt register</description><addressOffset>0x08</addressOffset>
          <fields>
            <field><name>LSIRDYF</name><description>LSI ready interrupt flag</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>HSIRDYF</name><description>HSI ready interrupt flag</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>HSERDYF</name><description>HSE ready interrupt flag</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>PLLRDYF</name><description>PLL ready interrupt flag</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>CSSF</name><description>Clock security system interrupt flag</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field>
            <field><name>HSERDYIE</name><description>HSE ready interrupt enable</description><bitOffset>11</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>PLLRDYIE</name><description>PLL ready interrupt enable</description><bitOffset>12</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>HSERDYC</name><description>HSE ready interrupt clear</description><bitOffset>19</bitOffset><bitWidth>1</bitWidth><access>write-only</access><modifiedWriteValues>oneToClear</modifiedWriteValues></field>
            <field><name>PLLRDYC</name><description>PLL ready interrupt clear</description><bitOffset>20</bitOffset><bitWidth>1</bitWidth><access>write-only</access><modifiedWriteValues>oneToClear</modifiedWriteValues></field>
            <field><name>CSSC</name><description>Clock security system interrupt clear</description><bitOffset>23</bitOffset><bitWidth>1</bitWidth><access>write-only</access><modifiedWriteValues>oneToClear</modifiedWriteValues></field>
          </fields>
        </register>
        <register>
          <name>APB2ENR</name><description>APB2 peripheral clock enable register</description><addressOffset>0x18</addressOffset>
          <fields>
            <field><name>AFIOEN</name><description>Alternate function I/O clock enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>IOPAEN</name><description>GPIOA clock enable</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>IOPBEN</name><description>GPIOB clock enable</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>IOPCEN</name><description>GPIOC clock enable</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>USART1EN</name><description>USART1 clock enable</description><bitOffset>14</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
        <register>
          <name>APB1ENR</name><description>APB1 peripheral clock enable register</description><addressOffset>0x1C</addressOffset>
          <fields>
            <field><name>TIM2EN</name><description>TIM2 clock enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>USART2EN</name><description>USART2 clock enable</description><bitOffset>17</bitOffset><bitWidth>1</bitWidth></field>
          </fields>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>
`;
