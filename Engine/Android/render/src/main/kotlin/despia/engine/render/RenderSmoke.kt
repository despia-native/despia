//
//  RenderSmoke.kt — the compile gate for the K4 core set (instrumented tests aren't
//  possible in this environment; PLAN.md: compilation IS the gate for :render this wave).
//  A @Preview-free composable that exercises every rendered element + the reactive paths
//  (interpolation, visible-if, on:tap through JSERunner, a named class, a component +
//  slot) end-to-end through the real kernel parser — if this compiles against :core, the
//  renderer's surface is type-correct. Includes the data plane: list/grid (keyed rows +
//  item.* write-back, incl. inputs INSIDE a row), pager/tabs (two-way index), <watch>,
//  and the inputs toggle/textfield/slider/progress/spinner.
//

package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import despia.engine.JSERunner
import despia.engine.StackStore
import despia.engine.StackXML

private val smokeDsx = """
<vstack spacing="12" padding="16" background="#121212" radius="16">
  <head>
    <variable as="count">0</variable>
    <variable as="title">'Smoke'</variable>
    <variable as="todos">[{ id: 1, name: 'Alpha', done: false }, { id: 2, name: 'Beta', done: true }]</variable>
    <variable as="page">0</variable>
    <variable as="tab">0</variable>
    <variable as="flag">true</variable>
    <variable as="query">''</variable>
    <variable as="volume">3</variable>
    <style as="muted" color="secondary" fontSize="13"/>
    <action as="bump" step="1">count = count + step</action>
    <watch value="count" on:change="title = 'Smoke ' + count"/>
    <watch value="query" immediate="true" on:change="count = count + 0"/>
    <component as="Badge">
      <hstack spacing="4" padding="6" background="rgba(255,255,255,0.06)" radius="8">
        <text value="{{ kind }}"/>
        <slot/>
      </hstack>
    </component>
  </head>
  <hstack spacing="8" align="center" enter="slide-bottom" anim="spring">
    <image icon="star.fill" iconSize="20"/>
    <text value="{{ title }} {{ count }}" fontSize="17" fontWeight="semibold"/>
    <spacer/>
    <button label="+1" on:tap="bump({ step: 2 })" arg:step="1"/>
  </hstack>
  <divider/>
  <scroll height="120">
    <zstack align="topLeading" grow="width" minHeight="40" opacity="0.9">
      <text class="muted" visible-if="count > 0" transition="slide-left" anim="easeOut" animDuration="0.2">count is positive</text>
      <text value="kept" keep="true" visible-if="count > 1" anim="linear"/>
    </zstack>
    <Badge kind="beta"><text value="slotted"/></Badge>
    <pressable on:tap="count = 0"><text>reset</text></pressable>
  </scroll>
  <stack style="display: grid; gap: 0.5rem; padding: 0.5rem; background: rgba(255,255,255,0.04); border-radius: 12px">
    <text value="css-styled" style="font-size: 0.875rem; font-weight: 600; color: white"/>
  </stack>
  <zstack surface="glass" radius="20" zIndex="2" ignoreSafeArea="bottom">
    <text value="frosted" offsetY="-2"/>
  </zstack>
  <vstack gradient="#FF2D55|rgba(0,0,0,0.4)" gradientDir="diagonal" aspectRatio="16:9" radius="12" borderColor="rgba(255,255,255,0.2)" borderWidth="1" shadow="8" shadowColor="rgba(0,0,0,0.5)" shadowY="4" rotation="3" scale="0.98" blur="2" offsetX="4">
    <text value="styled"/>
  </vstack>
  <hstack surface="sheet" glassTint="rgba(255,45,85,0.3)" fullBleed="horizontal" offset="6">
    <text value="tinted glass"/>
  </hstack>
  <list bind="todos" key="id" spacing="6" height="140" on:reachEnd="count = count + 1">
    <row on:tap="page = item.index">
      <hstack spacing="8" align="center">
        <toggle bind="item.done" on:change="count = count + 1"/>
        <text bind="item.name"/>
        <spacer/>
        <textfield bind="item.name" placeholder="rename" width="120"/>
      </hstack>
    </row>
  </list>
  <grid bind="todos" key="id" columns="2" spacing="8" scroll="false">
    <vstack padding="8" background="rgba(255,255,255,0.06)" radius="8">
      <text bind="item.name" visible-if="!item.done"/>
      <text class="muted" bind="item.id"/>
    </vstack>
  </grid>
  <pager bind="page" height="80" on:change="count = count + 1">
    <vstack align="center"><text>page one</text></vstack>
    <vstack align="center"><text>page two</text></vstack>
  </pager>
  <tabs bind="tab" color="accent" on:change="count = count + 1">
    <vstack tabTitle="First"><text>first pane</text></vstack>
    <vstack tabTitle="Second"><text>second pane</text></vstack>
  </tabs>
  <hstack spacing="10" align="center">
    <toggle bind="flag" on:change="count = count + 1"/>
    <spinner color="white"/>
    <text class="muted" value="{{ query }}"/>
  </hstack>
  <textfield bind="query" placeholder="Search" on:change.debounce="200" on:change="count = count + 1"/>
  <slider bind="volume" min="0" max="10" on:change="count = count + 1"/>
  <progress value="0.4"/>
  <progress bind="volume / 10" color="accent" height="4"/>
  <vstack theme="dark" background="white">
    <text color="secondary" value="theme= beats the light canvas (subtree pin)"/>
  </vstack>
  <list bind="todos" key="id" height="140">
    <row on:tap="page = item.index"><text bind="item.name"/></row>
  </list>
</vstack>
"""

@Composable
fun RenderSmoke() {
    val store = remember { StackStore() }
    val env = remember { JSERunner(store) }
    val root = remember { StackXML.parse(smokeDsx) }
    if (root != null) StackRootView(root, store, env)
}
