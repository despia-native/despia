//
//  MarkdownBlocksView.kt — the `<markdown>` element (A4b): the Compose consumer of the
//  neutral block tree (:core MarkdownBlocks.kt, corpus
//  OpenSource/Conformance/markdown/blocks.json) in the PROSE PLANE's design language
//  (:core MarkdownProse.kt, the dom/src/prose.ts twin): the type scale with tightening
//  weight/tracking, fenced code on an elevated rounded surface with the shared syntax
//  tint, inline code as a subtle fill chip, the accent quote rail over its wash,
//  band-header tables, muted tabular list markers, hairline rules.
//
//  PLATFORM IDIOM, not a pixel clone: colors resolve through the semantic-token funnel
//  (StackStyle.color — the system-defaults corpus words MarkdownProse declares), the
//  table card reads raised through its M3 tonal surface rather than a cast shadow, and
//  a standalone image rides the REAL `<image>` element (a synthetic node through
//  StackNodeView), so markdown images get the content-plane cache tiers for free.
//
//  Inline content renders through the ONE inline parser (:core parseInline — the
//  markdown.ts sink grammar): emphasis/strong/strike as spans, code spans as mono chip
//  runs, links as accent-underlined LinkAnnotations — tappable only for the absolute
//  schemes the allowlist admits (a relative target has no base to resolve against in an
//  app surface, so it styles without navigating).
//
//  The scheme pick for the tint palette + quote wash derives from the LIVE `label`
//  token's luminance (a light label means a dark scheme), so a `theme=` subtree pin and
//  the pre-theme fallback table both land on the right palette without a second signal.
//

package despia.engine.render

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import despia.engine.CodeTokenKind
import despia.engine.DSXStrings
import despia.engine.JSE
import despia.engine.JSERunner
import despia.engine.MarkdownBlock
import despia.engine.MarkdownBlocks
import despia.engine.MarkdownInlineSink
import despia.engine.MarkdownProse
import despia.engine.StackNode
import despia.engine.StackStore

/** The `<markdown>` element body — StackNodeView's "markdown" branch. Source precedence
 *  is the `<text>` element's: bind (data, never localized) > value > inner text
 *  (authored copy, through the DSXStrings choke point). */
@Composable
internal fun MarkdownBlocksElement(
    node: StackNode,
    a: Map<String, String>,
    modifier: Modifier,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
) {
    val bound = a["bind"]?.let { JSE.eval(it, store, item) }
    val source = when {
        bound != null -> JSE.string(bound)
        a["value"] != null -> DSXStrings.localize(JSE.interpolate(a["value"] ?: "", store, item))
        else -> DSXStrings.localize(JSE.interpolate(node.text ?: "", store, item))
    }
    val blocks = remember(source) { MarkdownBlocks.parse(source) }
    Column(modifier.fillMaxWidth()) {
        var previous: MarkdownBlock? = null
        for (block in blocks) {
            val gap = MarkdownProse.gap(previous, block)
            if (gap > 0f) Spacer(Modifier.height(gap.dp))
            MarkdownBlockView(block, MarkdownProse.isLede(previous, block), store, env, item, rowWrite)
            previous = block
        }
    }
}

/** A light `label` ink means the scheme is dark — the same luminance rule the theme
 *  derivation uses (StackTheme.derivedIsDark), read off the LIVE resolved token so
 *  subtree pins and the pre-theme fallback both pick the right tint tables. */
private fun proseSchemeIsDark(): Boolean {
    val label = StackStyle.color(MarkdownProse.BODY_INK)
    return 0.2126f * label.red + 0.7152f * label.green + 0.0722f * label.blue > 0.5f
}

private fun proseWeight(weight: Int): FontWeight = when {
    weight >= 700 -> FontWeight.Bold
    weight >= 600 -> FontWeight.SemiBold
    weight >= 500 -> FontWeight.Medium
    else -> FontWeight.Normal
}

private fun softHairline(): Color {
    val separator = StackStyle.color(MarkdownProse.HAIRLINE_INK)
    return separator.copy(alpha = separator.alpha * MarkdownProse.SOFT_HAIRLINE_ALPHA)
}

/** The inline vocabulary as spans: ONE parser (:core parseInline), emitted into an
 *  AnnotatedString. Code spans are the chip (mono at 0.9em over the `fill` token);
 *  links are accent + underline, tappable only for absolute allowlisted schemes. */
internal fun markdownInlineAnnotated(source: String, bodySize: Float): AnnotatedString =
    inlineAnnotated(source, bodySize)

private fun inlineAnnotated(source: String, bodySize: Float): AnnotatedString {
    val accent = StackStyle.color(MarkdownProse.LINK_INK)
    val chip = StackStyle.color(MarkdownProse.CHIP_SURFACE)
    val codeSize = (bodySize * MarkdownProse.CHIP_FONT_SCALE).sp
    val linkStyle = SpanStyle(color = accent, textDecoration = TextDecoration.Underline)
    return buildAnnotatedString {
        MarkdownBlocks.parseInline(source, object : MarkdownInlineSink {
            override fun text(value: String) { append(value) }
            override fun open(tag: String, href: String?) {
                when (tag) {
                    "strong" -> pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    "em" -> pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    "del" -> pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough))
                    "code" -> pushStyle(SpanStyle(
                        fontFamily = FontFamily.Monospace, fontSize = codeSize, background = chip))
                    else -> {
                        // "a": a relative target has no base in an app surface — style it,
                        // never navigate it; the absolute allowlisted schemes stay live.
                        val absolute = href != null && (href.startsWith("http", ignoreCase = true)
                            || href.startsWith("mailto:", ignoreCase = true)
                            || href.startsWith("tel:", ignoreCase = true))
                        if (absolute) pushLink(LinkAnnotation.Url(href!!, TextLinkStyles(linkStyle)))
                        else pushStyle(linkStyle)
                    }
                }
            }
            override fun close() { pop() }
        })
    }
}

@Composable
private fun MarkdownBlockView(
    block: MarkdownBlock,
    lede: Boolean,
    store: StackStore,
    env: JSERunner,
    item: Map<String, Any?>?,
    rowWrite: ((String, Any) -> Unit)?,
) {
    when (block) {
        is MarkdownBlock.Paragraph -> {
            val spec = if (lede) MarkdownProse.lede else MarkdownProse.paragraph
            val ink = if (lede) MarkdownProse.LEDE_INK else MarkdownProse.BODY_INK
            BasicText(inlineAnnotated(block.inline, spec.size), style = TextStyle(
                color = StackStyle.color(ink), fontSize = spec.size.sp,
                fontWeight = proseWeight(spec.weight), letterSpacing = spec.trackingEm.em,
                lineHeight = spec.lineHeight.em))
        }
        is MarkdownBlock.Heading -> {
            val spec = MarkdownProse.heading(block.level)
            BasicText(inlineAnnotated(block.inline, spec.size),
                Modifier.semantics { heading() },
                style = TextStyle(
                    color = StackStyle.color(MarkdownProse.headingInk(block.level)),
                    fontSize = spec.size.sp, fontWeight = proseWeight(spec.weight),
                    letterSpacing = spec.trackingEm.em, lineHeight = spec.lineHeight.em))
        }
        is MarkdownBlock.Code -> {
            val dark = proseSchemeIsDark()
            val tinted = remember(block, dark) {
                buildAnnotatedString {
                    for (token in MarkdownProse.tokenizeCode(block.language, block.text)) {
                        val tint = if (dark) MarkdownProse.tintDark(token.kind)
                                   else MarkdownProse.tintLight(token.kind)
                        if (tint == null) append(token.text)
                        else withStyle(SpanStyle(color = Color(tint),
                            fontStyle = if (token.kind == CodeTokenKind.COM) FontStyle.Italic else null)) {
                            append(token.text)
                        }
                    }
                }
            }
            val shape = RoundedCornerShape(MarkdownProse.CODE_RADIUS.dp)
            Box(Modifier.fillMaxWidth()
                    .clip(shape)
                    .background(StackStyle.color(MarkdownProse.CODE_SURFACE))
                    .border(1.dp, softHairline(), shape)
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = MarkdownProse.CODE_PAD_H.dp, vertical = MarkdownProse.CODE_PAD_V.dp)) {
                BasicText(tinted, style = TextStyle(
                    color = StackStyle.color(MarkdownProse.BODY_INK),
                    fontFamily = FontFamily.Monospace,
                    fontSize = MarkdownProse.CODE_FONT_SIZE.sp,
                    lineHeight = MarkdownProse.CODE_LINE_HEIGHT.em))
            }
        }
        is MarkdownBlock.Quote -> {
            val accent = StackStyle.color(MarkdownProse.LINK_INK)
            Box(Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(
                        topEnd = MarkdownProse.CHIP_RADIUS.dp, bottomEnd = MarkdownProse.CHIP_RADIUS.dp))
                    .background(accent.copy(alpha = MarkdownProse.QUOTE_WASH_ALPHA))) {
                Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.fillMaxHeight().width(MarkdownProse.QUOTE_RAIL_WIDTH.dp)
                            .background(accent.copy(alpha = MarkdownProse.QUOTE_RAIL_ALPHA)))
                    Column(Modifier.weight(1f).padding(
                        horizontal = MarkdownProse.QUOTE_PAD_H.dp, vertical = MarkdownProse.QUOTE_PAD_V.dp)) {
                        var previous: MarkdownBlock? = null
                        for (inner in block.blocks) {
                            val gap = MarkdownProse.gap(previous, inner)
                            if (previous != null && gap > 0f) Spacer(Modifier.height(gap.dp))
                            MarkdownBlockView(inner, lede = false, store, env, item, rowWrite)
                            previous = inner
                        }
                    }
                }
            }
        }
        MarkdownBlock.Rule -> {
            Box(Modifier.fillMaxWidth().height(1.dp)
                .background(StackStyle.color(MarkdownProse.HAIRLINE_INK)))
        }
        is MarkdownBlock.Image -> {
            // The REAL `<image>` element (content-plane cache, unsized → full width at
            // its intrinsic aspect), with the sheet's radius riding the style chain.
            val attrs = buildMap {
                put("src", block.src)
                put("radius", MarkdownProse.IMAGE_RADIUS.toInt().toString())
                if (block.alt.isNotEmpty()) put("a11yLabel", block.alt)
            }
            StackNodeView(StackNode("image", attrs, emptyList()), store, env, item, rowWrite)
        }
        is MarkdownBlock.Listing -> {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(MarkdownProse.LIST_ITEM_GAP.dp)) {
                val spec = MarkdownProse.paragraph
                val markerStyle = TextStyle(
                    color = StackStyle.color(MarkdownProse.MARKER_INK), fontSize = spec.size.sp,
                    lineHeight = spec.lineHeight.em, fontFeatureSettings = "tnum")
                for ((index, listItem) in block.items.withIndex()) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                        Box(Modifier.width(MarkdownProse.LIST_INDENT.dp).padding(end = 6.dp),
                            contentAlignment = Alignment.TopEnd) {
                            BasicText(
                                if (block.ordered) "${block.start + index}." else "•",
                                style = markerStyle)
                        }
                        Column(Modifier.weight(1f)) {
                            BasicText(inlineAnnotated(listItem.inline, spec.size), style = TextStyle(
                                color = StackStyle.color(MarkdownProse.BODY_INK), fontSize = spec.size.sp,
                                letterSpacing = spec.trackingEm.em, lineHeight = spec.lineHeight.em))
                            for (inner in listItem.blocks) {
                                Spacer(Modifier.height(MarkdownProse.LIST_ITEM_GAP.dp))
                                MarkdownBlockView(inner, lede = false, store, env, item, rowWrite)
                            }
                        }
                    }
                }
            }
        }
        is MarkdownBlock.Table -> {
            val spec = MarkdownProse.paragraph
            Column(Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(MarkdownProse.CARD_RADIUS.dp))
                    .background(StackStyle.color(MarkdownProse.CARD_SURFACE))
                    .padding(MarkdownProse.CARD_PAD.dp)) {
                Row(Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(MarkdownProse.CHIP_RADIUS.dp))
                        .background(StackStyle.color(MarkdownProse.BAND_SURFACE))
                        .height(MarkdownProse.BAND_HEIGHT.dp)
                        .semantics { heading() },
                    verticalAlignment = Alignment.CenterVertically) {
                    for (cell in block.header) {
                        BasicText(inlineAnnotated(cell, MarkdownProse.BAND_FONT_SIZE),
                            Modifier.weight(1f).padding(horizontal = MarkdownProse.TABLE_CELL_PAD_H.dp),
                            style = TextStyle(
                                color = StackStyle.color(MarkdownProse.BAND_INK),
                                fontSize = MarkdownProse.BAND_FONT_SIZE.sp,
                                fontWeight = FontWeight.SemiBold,
                                letterSpacing = MarkdownProse.BAND_TRACKING_EM.em))
                    }
                }
                Spacer(Modifier.height(MarkdownProse.BAND_GAP.dp))
                for ((r, row) in block.rows.withIndex()) {
                    Row(Modifier.fillMaxWidth()
                            .padding(vertical = MarkdownProse.TABLE_CELL_PAD_V.dp)
                            .semantics(mergeDescendants = true) { },   // a row reads as ONE element
                        verticalAlignment = Alignment.Top) {
                        for (cell in row) {
                            BasicText(inlineAnnotated(cell, MarkdownProse.TABLE_FONT_SIZE),
                                Modifier.weight(1f).padding(horizontal = MarkdownProse.TABLE_CELL_PAD_H.dp),
                                style = TextStyle(
                                    color = StackStyle.color(MarkdownProse.BODY_INK),
                                    fontSize = MarkdownProse.TABLE_FONT_SIZE.sp,
                                    letterSpacing = spec.trackingEm.em,
                                    lineHeight = 1.5f.em,
                                    fontFeatureSettings = "tnum"))
                        }
                    }
                    if (r < block.rows.size - 1) {
                        Box(Modifier.fillMaxWidth().height(1.dp).background(softHairline()))
                    }
                }
            }
        }
    }
}
