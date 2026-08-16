@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package despia.engine.desktop

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.runSkikoComposeUiTest
import androidx.compose.ui.unit.Density
import despia.engine.Platform
import despia.engine.StackNode
import despia.engine.StackStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

/** Verifies the emitted Compose semantics consumed by native desktop assistive
 * technology, complementing the pure attribute-folding contract tests. */
class DesktopAccessibilityUiTest {
    @org.junit.jupiter.api.BeforeEach
    fun requireDesktopRendering() = DesktopUiTestEnvironment.assumeRenderable()

    @AfterEach
    fun restorePlatform() {
        Platform.os = "android"
        Platform.nodeTarget = null
    }

    @Test
    fun authoredAccessibilityMetadataReachesTheNativeSemanticsTree() = runSkikoComposeUiTest(
        size = Size(640f, 480f),
        density = Density(1f),
    ) {
        DesktopHost.boot("Windows 11")
        val root = parse(
            """
            <vstack id="a11y-root" grow="true" padding="20">
              <vstack id="a11y-card" disabled="true"
                      a11yLabel="Save" a11yHint="Writes the document" a11yValue="Ready"
                      a11yGroup="true" a11yTrait="button, selected, header">
                <text value="Visible child copy"/>
              </vstack>
              <text id="a11y-hidden" value="Private diagnostic" a11yHidden="true"/>
            </vstack>
            """.trimIndent(),
        )

        setContent { DesktopSurface(root, StackStore()) }
        waitForIdle()

        onNodeWithTag("a11y-card", useUnmergedTree = true)
            .assertContentDescriptionEquals("Save. Writes the document")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Ready"))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
            .assertIsSelected()
            .assertIsNotEnabled()

        onNodeWithTag("a11y-hidden", useUnmergedTree = true)
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility))
    }

    @Test
    fun labeledToggleAndCheckboxExposeOneAuthoredAssistiveTargetEach() = runSkikoComposeUiTest(
        size = Size(640f, 480f),
        density = Density(1f),
    ) {
        DesktopHost.boot("Linux")
        val root = parse(
            """
            <vstack id="controls-root" grow="true" padding="20">
              <head>
                <variable as="notifications">return true</variable>
                <variable as="accepted">return true</variable>
              </head>
              <toggle id="notifications-toggle" bind="dsx.variable.notifications"
                      label="Notifications" a11yLabel="Notifications"/>
              <checkbox id="accepted-checkbox" bind="dsx.variable.accepted"
                        label="Accepted" a11yLabel="Accepted"/>
            </vstack>
            """.trimIndent(),
        )

        setContent { DesktopSurface(root, StackStore()) }
        waitForIdle()

        onAllNodes(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch),
            useUnmergedTree = true,
        ).assertCountEquals(1)
        onAllNodes(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox),
            useUnmergedTree = true,
        ).assertCountEquals(1)
        onNodeWithTag("notifications-toggle", useUnmergedTree = true)
            .assertContentDescriptionEquals("Notifications")
            .assertIsOn()
        onNodeWithTag("accepted-checkbox", useUnmergedTree = true)
            .assertContentDescriptionEquals("Accepted")
            .assertIsOn()
    }

    @Test
    fun ariaAliasesAndEveryTraitWordReachDeterministicNativeSemantics() = runSkikoComposeUiTest(
        size = Size(640f, 480f),
        density = Density(1f),
    ) {
        DesktopHost.boot("Windows 11")
        val root = parse(
            """
            <vstack id="trait-root" grow="true" padding="20">
              <text id="trait-link" value="Documentation"
                    aria-label="Open documentation" aria-description="External resource"
                    aria-valuetext="Available" a11yTrait="link, header, selected"/>
              <text id="trait-static" value="Copy" on:tap="noop" a11yTrait="static"/>
              <vstack id="trait-image" a11yTrait="image"/>
            </vstack>
            """.trimIndent(),
        )

        setContent { DesktopSurface(root, StackStore()) }
        waitForIdle()

        onNodeWithTag("trait-link", useUnmergedTree = true)
            .assertContentDescriptionEquals("Open documentation. External resource")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Available"))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
            .assertIsSelected()
        onNodeWithTag("trait-static", useUnmergedTree = true)
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Role))
        onNodeWithTag("trait-image", useUnmergedTree = true)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image))
    }

    private fun parse(markup: String): StackNode = requireNotNull(
        DesktopHost.parseDocument(DesktopHost.Document("accessibility-ui-test.dsx", markup)),
    )
}
