//
//  FormsAccessoryTest.kt — plain-JVM units for the keyboard accessory bar's pure half
//  (Forms.kt `fieldNeighbors` — Field.swift prevField/nextField): the ▲▼ walk over
//  `form.fieldOrder`, its end-of-form disables, and the no-form-scope degrade. The bar
//  composable itself (the IME-anchored Popup) is gated by compilation (the RenderSmoke
//  rule).
//

package despia.engine.render

import despia.engine.render.elements.fieldNeighbors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FormsAccessoryTest {

    private val order = listOf("email", "password", "confirm")

    @Test fun middleFieldHasBothNeighbors() {
        assertEquals("email" to "confirm", fieldNeighbors(order, "password"))
    }

    @Test fun firstFieldDisablesUp() {
        assertEquals(null to "password", fieldNeighbors(order, "email"))       // ▲ disabled
    }

    @Test fun lastFieldDisablesDown() {
        assertEquals("password" to null, fieldNeighbors(order, "confirm"))     // ▼ disabled
    }

    @Test fun soloFieldDisablesBoth() {
        assertEquals(null to null, fieldNeighbors(listOf("only"), "only"))     // Done-only bar
    }

    @Test fun unregisteredFieldDegradesToDoneOnly() {
        // No form scope / not yet registered in fieldOrder — both chevrons disable.
        assertEquals(null to null, fieldNeighbors(emptyList(), "email"))
        assertEquals(null to null, fieldNeighbors(order, "phone"))
    }

    @Test fun textFieldUsesTheRealMaterial3Control() {
        val source = File(
            "src/main/kotlin/despia/engine/render/elements/Forms.kt",
        ).readText()
        val field = source
            .substringAfter("private fun FieldTextInput")
            .substringBefore("// MARK: - the keyboard accessory bar")

        assertTrue(field.contains("OutlinedTextField("))
        assertFalse(field.contains("BasicTextField("))
        assertTrue(field.contains("label = { if (label != null) Text(label) }"))
        assertTrue(field.contains("placeholder = { if (placeholder != null) Text(placeholder) }"))
        assertTrue(field.contains("isError = isError"))
        assertTrue(field.contains("colors = m3TextInputColors("))
        assertTrue(
            "The conditional keyboard accessory must follow the field so recomposition " +
                "cannot replace the focus-owning slot",
            field.indexOf("OutlinedTextField(") < field.indexOf("if (focused) {"),
        )
    }
}
