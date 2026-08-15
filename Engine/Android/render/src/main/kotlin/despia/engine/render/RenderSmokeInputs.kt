//
//  RenderSmokeInputs.kt — the compile gate for the INPUT/DISPLAY element wave
//  (elements/*.kt: stars, otp, rangeslider, Checkbox/checkbox, RadioGroup,
//  segmentedButton, stepper, wheelpicker, combobox, datepicker/date, calendar, image
//  src=/asset=, svg, qrcode, the horizontal/marquee list) — instrumented tests aren't
//  possible in this environment; PLAN.md: compilation IS the gate for :render. A
//  @Preview-free composable that registers the wave (InputElements.register()) and
//  drives every element through the real kernel parser — bind seams, options grammar,
//  keep= hit-blocking and width="fit" included. The pure halves (ElementMath,
//  CalendarMath, SvgModel, the QR matrix) are additionally unit-tested in
//  ElementsLogicTest.kt.
//

package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import despia.engine.JSERunner
import despia.engine.StackStore
import despia.engine.StackXML
import despia.engine.render.elements.InputElements

private val smokeInputsDsx = """
<vstack spacing="12" padding="16">
  <head>
    <variable as="rating">3.5</variable>
    <variable as="code">''</variable>
    <variable as="low">10</variable>
    <variable as="high">80</variable>
    <variable as="qty">2</variable>
    <variable as="agreed">false</variable>
    <variable as="plan">'Monthly'</variable>
    <variable as="filters">'Day,Week'</variable>
    <variable as="tz">'UTC'</variable>
    <variable as="city">''</variable>
    <variable as="when">'2026-07-10T12:00:00Z'</variable>
    <variable as="day">'2026-07-10'</variable>
    <variable as="bookings">[{ date: '2026-07-12', color: '#34C759' }]</variable>
    <variable as="news">[{ id: 1, title: 'Alpha' }, { id: 2, title: 'Beta' }]</variable>
    <variable as="count">0</variable>
  </head>
  <stars bind="rating" count="5" size="24" color="#FFCC00" on:change="count = count + 1"/>
  <stars bind="rating" readonly="true"/>
  <otp bind="code" length="6" boxSize="48" color="accent"
       on:change="count = count + 1" on:complete="count = 100"/>
  <rangeslider bindLow="low" bindHigh="high" min="0" max="100" step="5" color="accent"/>
  <Checkbox bind="agreed" label="I accept the terms" on:change="count = count + 1"/>
  <checkbox bind="agreed" color="green"/>
  <RadioGroup bind="plan" options="Weekly,Monthly,Yearly"/>
  <RadioGroup bind="plan" optionsKey="news" valueField="id" labelField="title" color="accent"/>
  <segmentedButton bind="filters" options="Day,Week,Month" icons="sun.max,calendar,clock"/>
  <segmentedButton bind="plan" options="List,Grid" multiple="false"/>
  <stepper bind="qty" min="1" max="9" step="1" label="Tickets" color="accent"/>
  <wheelpicker bind="tz" options="UTC,CET,PST" on:change="count = count + 1"/>
  <wheelpicker bind="tz" optionsKey="news" valueField="id" labelField="title"/>
  <combobox bind="city" options="Paris,Berlin,Madrid" placeholder="City"
            on:select="count = count + 1"/>
  <datepicker bind="when" mode="datetime" label="Departure" color="accent"/>
  <date bind="when" mode="time"/>
  <calendar bind="day" min="2026-07-01" max="2026-12-31" color="accent"
            marks="bookings" markDateField="date" markColorField="color"
            on:month="count = count + 1" on:change="count = count + 1"/>
  <image icon="star.fill" iconSize="20"/>
  <image src="https://example.com/cover.jpg" width="120" height="80" on:tap="count = count + 1"/>
  <image src="https://example.com/anim.gif" cache="none"/>
  <image asset="logo"/>
  <svg d="M0 0 L10 10 Z" viewBox="0 0 10 10" fill="#FF2D55" width="40" height="40"/>
  <svg src="&lt;svg viewBox='0 0 24 24'&gt;&lt;circle cx='12' cy='12' r='10' fill='none' stroke='#fff' stroke-width='2'/&gt;&lt;/svg&gt;"/>
  <qrcode value="https://myapp.com/u/{{ count }}" size="160" color="black" background="white" correction="Q"/>
  <list bind="news" key="id" axis="horizontal" autoscroll="30" spacing="12" height="40">
    <text bind="item.title"/>
  </list>
  <list bind="news" key="id" axis="horizontal" spacing="8" height="40">
    <text bind="item.title"/>
  </list>
  <list bind="news" key="id" spacing="6" height="120">
    <row on:tap="count = item.index"><text bind="item.title"/></row>
  </list>
  <text value="fit + keep" width="fit"/>
  <vstack keep="true" visible-if="count > 3" height="fit">
    <button label="hidden stays inert" on:tap="count = 0"/>
  </vstack>
</vstack>
"""

@Composable
fun RenderSmokeInputs() {
    InputElements.register()
    val store = remember { StackStore() }
    val env = remember { JSERunner(store) }
    val root = remember { StackXML.parse(smokeInputsDsx) }
    if (root != null) StackRootView(root, store, env)
}
