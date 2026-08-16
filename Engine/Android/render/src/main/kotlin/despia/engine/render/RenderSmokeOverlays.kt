//
//  RenderSmokeOverlays.kt — the compile gate for the STRUCTURE/OVERLAY element wave
//  (elements/ — sheet, popover, menu, contextmenu, alert, confirmDialog, lightbox,
//  Drawer, scaffold, form/field, searchbar, toolbar, carousel, flow, Table, Accordion,
//  Skeleton, ChatBubble, ProgressRing + RouterModalHost). Instrumented tests aren't
//  possible in this environment (the RenderSmoke precedent): a @Preview-free composable
//  that registers the elements and renders every one end-to-end through the real kernel
//  parser — if this compiles against :core, the wave's surface is type-correct.
//  RenderSmoke itself is owned by the core-set wave — this file only ADDS coverage.
//

package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import despia.engine.JSERunner
import despia.engine.StackStore
import despia.engine.StackXML
import despia.engine.render.elements.RouterModalHost
import despia.engine.render.elements.StackElements

private val overlaySmokeDsx = """
<scaffold>
  <head>
    <variable as="showSheet">false</variable>
    <variable as="showCard">false</variable>
    <variable as="showAlert">false</variable>
    <variable as="showActions">false</variable>
    <variable as="showInfo">false</variable>
    <variable as="showPhotos">false</variable>
    <variable as="photoIdx">0</variable>
    <variable as="card">0</variable>
    <variable as="query">''</variable>
    <variable as="uploaded">0.7</variable>
    <variable as="rowMenu">[{ title: 'Split', icon: 'scissors', action: 'studio.splitClip', args: { id: 4 } },
                            { separator: true },
                            { title: 'Move', icon: 'rectangle.stack', items: [{ title: 'Lane 1', action: 'studio.move', args: { lane: 1 } }] },
                            { title: 'Delete', icon: 'trash', role: 'destructive', action: 'studio.deleteClip' }]</variable>
    <variable as="alertButtons">[{ label: 'Delete', role: 'destructive', action: 'studio.deleteClip' },
                                 { title: 'Cancel', role: 'cancel' }]</variable>
    <variable as="orders">[{ id: 1, name: 'Espresso', qty: 2, total: '${'$'}7.00' },
                           { id: 2, name: 'Latte', qty: 1, total: '${'$'}4.50' }]</variable>
    <variable as="photos">[{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/b.jpg' }]</variable>
  </head>

  <toolbar pin="top" position="top" spacing="16">
    <button label="Sheet" on:tap="showSheet = true"/>
    <spacer/>
    <button label="Alert" on:tap="showAlert = true"/>
  </toolbar>

  <scroll>
    <vstack spacing="12" padding="16">
      <searchbar bind="query" placeholder="Search shows" on:change="card = card + 0" on:submit="card = card" on:clear="query = ''"/>

      <form as="signup" submit="Create account" spacing="12" on:submit="showAlert = true">
        <field name="email" type="email" label="Email" validate="required,email"/>
        <field name="password" type="secure" label="Password" validate="required,minLength:8" message="At least 8 characters"/>
        <field name="plan" type="picker" options="Weekly,Monthly,Yearly" placeholder="Plan"/>
        <field name="terms" type="toggle" label="I accept the terms" validate="required"/>
      </form>

      <flow spacing="8" lineSpacing="8">
        <text value="Swift"/>
        <text value="SwiftUI"/>
        <text value="WebKit"/>
      </flow>

      <carousel value="card" dots="true" peek="24" spacing="12" color="accent" on:change="photoIdx = card">
        <vstack padding="16"><text value="one"/></vstack>
        <vstack padding="16"><text value="two"/></vstack>
      </carousel>

      <Table bind="dsx.variable.orders" columns="Item,Qty,Total" fields="name,qty,total"/>

      <Accordion title="Details" open="false" color="accent" on:toggle="card = card + 0">
        <text value="Hidden until you tap the header."/>
      </Accordion>

      <Skeleton height="180" radius="16"/>
      <Skeleton height="14"/>

      <ChatBubble side="right"><text value="Sounds great."/></ChatBubble>
      <ChatBubble side="left" color="#3A3A3C" maxWidth="320"><text value="See you then."/></ChatBubble>

      <ProgressRing value="{{ uploaded }}" max="1" label="70%"/>
      <ProgressRing value="0.7" size="120" lineWidth="14" color="#34C759"/>

      <menu menu="dsx.variable.rowMenu">
        <text value="tap for menu"/>
      </menu>
      <contextmenu menu="dsx.variable.rowMenu">
        <text value="hold for menu"/>
      </contextmenu>

      <popover present="showInfo" arrow="bottom" on:dismiss="showInfo = false">
        <button label="Details" on:tap="showInfo = true"/>
        <vstack slot="content" padding="16"><text value="Released 2024 · 4K HDR"/></vstack>
      </popover>

      <Drawer on:close="showCard = false">
        <text value="drawer body"/>
      </Drawer>
    </vstack>
  </scroll>

  <toolbar pin="bottom" spacing="16">
    <button label="Cancel" on:tap="showActions = true"/>
    <spacer/>
    <button label="Done" on:tap="showPhotos = true"/>
  </toolbar>

  <sheet present="showSheet" detents="content,full" title="Add Layer" close="leading"
         action="Edit" actionSide="trailing" on:action="card = card + 0"
         on:dismiss="showSheet = false">
    <vstack padding="16"><text value="sheet body"/></vstack>
  </sheet>
  <sheet present="showCard" mode="card" inset="14" detents="content,full" background="clear"
         on:dismiss="showCard = false">
    <vstack padding="16" background="#1C1C1E" radius="24"><text value="card body"/></vstack>
  </sheet>

  <alert present="showAlert" title="Delete clip?" message="This can't be undone."
         buttons="dsx.variable.alertButtons" on:dismiss="showAlert = false"/>

  <confirmDialog present="showActions" title="Delete clip?" message="This can't be undone."
                 buttons="dsx.variable.alertButtons" on:dismiss="showActions = false"/>

  <lightbox present="showPhotos" images="photos" srcField="url" index="photoIdx"
            on:dismiss="showPhotos = false"/>
</scaffold>
"""

@Composable
fun RenderSmokeOverlays() {
    StackElements.register()
    val store = remember { StackStore() }
    val env = remember { JSERunner(store) }
    val root = remember { StackXML.parse(overlaySmokeDsx) }
    if (root != null) StackRootView(root, store, env)
    RouterModalHost()   // the nav.modal half rides the same gate
}
