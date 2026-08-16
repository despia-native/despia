package despia.engine.desktop

import kotlin.math.abs

/** Dependency-free ISO/IEC 18004 QR encoder for the desktop renderer.
 *
 * DSX desktop cannot inherit Android's ZXing artifact without also shipping a second
 * dependency graph. This byte-mode encoder covers versions 1...40 and all four error
 * correction levels, emits every required function/error-correction codeword, and
 * selects the least-penalized mask. It has no network, filesystem, or platform API.
 */
internal object DesktopQrEncoder {
    internal enum class Correction(val formatBits: Int) {
        LOW(1), MEDIUM(0), QUARTILE(3), HIGH(2);

        companion object {
            fun parse(raw: String?): Correction = when (raw?.uppercase()) {
                "L" -> LOW
                "Q" -> QUARTILE
                "H" -> HIGH
                else -> MEDIUM
            }
        }
    }

    internal fun encode(value: String, correction: String? = null): Array<BooleanArray>? {
        val data = value.toByteArray(Charsets.UTF_8)
        if (data.isEmpty() || data.size > 65_535) return null
        val level = Correction.parse(correction)
        val version = (1..40).firstOrNull { candidate ->
            val countBits = if (candidate <= 9) 8 else 16
            data.size < (1 shl countBits.coerceAtMost(30)) &&
                4 + countBits + data.size * 8 <= dataCapacityBits(candidate, level)
        } ?: return null

        val capacity = dataCapacityBits(version, level)
        val bits = BitBuffer()
        bits.append(0x4, 4) // byte mode
        bits.append(data.size, if (version <= 9) 8 else 16)
        data.forEach { bits.append(it.toInt() and 0xFF, 8) }
        bits.append(0, minOf(4, capacity - bits.size))
        while (bits.size % 8 != 0) bits.append(0, 1)
        var pad = 0xEC
        while (bits.size < capacity) {
            bits.append(pad, 8)
            pad = pad xor 0xEC xor 0x11
        }
        val codewords = ByteArray(bits.size / 8) { index -> bits.byteAt(index) }
        return Qr(version, level, addErrorCorrection(codewords, version, level)).matrix()
    }

    private class BitBuffer {
        private val bits = ArrayList<Boolean>()
        val size: Int get() = bits.size

        fun append(value: Int, count: Int) {
            require(count in 0..31 && (count == 31 || value ushr count == 0))
            for (i in count - 1 downTo 0) bits += ((value ushr i) and 1) != 0
        }

        fun byteAt(index: Int): Byte {
            var value = 0
            for (i in 0..7) value = value shl 1 or if (bits[index * 8 + i]) 1 else 0
            return value.toByte()
        }
    }

    private class Qr(
        private val version: Int,
        private val correction: Correction,
        private val codewords: ByteArray,
    ) {
        private val size = version * 4 + 17
        private var modules = Array(size) { BooleanArray(size) }
        private val function = Array(size) { BooleanArray(size) }

        fun matrix(): Array<BooleanArray> {
            drawFunctionPatterns()
            drawCodewords()
            val unmasked = modules.map(BooleanArray::clone).toTypedArray()
            var best: Array<BooleanArray>? = null
            var bestPenalty = Int.MAX_VALUE
            for (mask in 0..7) {
                modules = unmasked.map(BooleanArray::clone).toTypedArray()
                applyMask(mask)
                drawFormatBits(mask)
                val score = penaltyScore()
                if (score < bestPenalty) {
                    bestPenalty = score
                    best = modules.map(BooleanArray::clone).toTypedArray()
                }
            }
            return requireNotNull(best)
        }

        private fun drawFunctionPatterns() {
            for (i in 0 until size) {
                setFunction(6, i, i % 2 == 0)
                setFunction(i, 6, i % 2 == 0)
            }
            drawFinder(3, 3)
            drawFinder(size - 4, 3)
            drawFinder(3, size - 4)

            val align = alignmentPositions()
            for (i in align.indices) for (j in align.indices) {
                if ((i == 0 && j == 0) || (i == 0 && j == align.lastIndex) ||
                    (i == align.lastIndex && j == 0)) continue
                drawAlignment(align[i], align[j])
            }
            drawFormatBits(0)
            drawVersion()
        }

        private fun drawFinder(centerX: Int, centerY: Int) {
            for (dy in -4..4) for (dx in -4..4) {
                val x = centerX + dx
                val y = centerY + dy
                if (x !in 0 until size || y !in 0 until size) continue
                val distance = maxOf(abs(dx), abs(dy))
                setFunction(x, y, distance != 2 && distance != 4)
            }
        }

        private fun drawAlignment(centerX: Int, centerY: Int) {
            for (dy in -2..2) for (dx in -2..2) {
                setFunction(centerX + dx, centerY + dy, maxOf(abs(dx), abs(dy)) != 1)
            }
        }

        private fun drawFormatBits(mask: Int) {
            val data = correction.formatBits shl 3 or mask
            var remainder = data
            repeat(10) { remainder = remainder shl 1 xor ((remainder ushr 9) * 0x537) }
            val bits = (data shl 10 or remainder) xor 0x5412
            fun bit(index: Int) = ((bits ushr index) and 1) != 0

            for (i in 0..5) setFunction(8, i, bit(i))
            setFunction(8, 7, bit(6))
            setFunction(8, 8, bit(7))
            setFunction(7, 8, bit(8))
            for (i in 9..14) setFunction(14 - i, 8, bit(i))
            for (i in 0..7) setFunction(size - 1 - i, 8, bit(i))
            for (i in 8..14) setFunction(8, size - 15 + i, bit(i))
            setFunction(8, size - 8, true)
        }

        private fun drawVersion() {
            if (version < 7) return
            var remainder = version
            repeat(12) { remainder = remainder shl 1 xor ((remainder ushr 11) * 0x1F25) }
            val bits = version shl 12 or remainder
            for (i in 0 until 18) {
                val value = ((bits ushr i) and 1) != 0
                val a = size - 11 + i % 3
                val b = i / 3
                setFunction(a, b, value)
                setFunction(b, a, value)
            }
        }

        private fun drawCodewords() {
            var bitIndex = 0
            var right = size - 1
            while (right >= 1) {
                if (right == 6) right = 5
                for (vertical in 0 until size) {
                    val upward = ((right + 1) and 2) == 0
                    val y = if (upward) size - 1 - vertical else vertical
                    for (column in 0..1) {
                        val x = right - column
                        if (function[y][x] || bitIndex >= codewords.size * 8) continue
                        modules[y][x] = ((codewords[bitIndex ushr 3].toInt() ushr (7 - (bitIndex and 7))) and 1) != 0
                        bitIndex += 1
                    }
                }
                right -= 2
            }
            check(bitIndex == codewords.size * 8)
        }

        private fun applyMask(mask: Int) {
            for (y in 0 until size) for (x in 0 until size) {
                if (function[y][x]) continue
                val invert = when (mask) {
                    0 -> (x + y) % 2 == 0
                    1 -> y % 2 == 0
                    2 -> x % 3 == 0
                    3 -> (x + y) % 3 == 0
                    4 -> (x / 3 + y / 2) % 2 == 0
                    5 -> x * y % 2 + x * y % 3 == 0
                    6 -> (x * y % 2 + x * y % 3) % 2 == 0
                    else -> ((x + y) % 2 + x * y % 3) % 2 == 0
                }
                modules[y][x] = modules[y][x] xor invert
            }
        }

        private fun penaltyScore(): Int {
            var score = 0
            fun runs(line: (Int) -> Boolean) {
                var color = line(0)
                var length = 1
                for (i in 1 until size) {
                    val next = line(i)
                    if (next == color) length += 1
                    else {
                        if (length >= 5) score += 3 + length - 5
                        color = next
                        length = 1
                    }
                }
                if (length >= 5) score += 3 + length - 5
            }
            for (y in 0 until size) runs { x -> modules[y][x] }
            for (x in 0 until size) runs { y -> modules[y][x] }
            for (y in 0 until size - 1) for (x in 0 until size - 1) {
                val value = modules[y][x]
                if (modules[y][x + 1] == value && modules[y + 1][x] == value && modules[y + 1][x + 1] == value) score += 3
            }
            val pattern = booleanArrayOf(true, false, true, true, true, false, true)
            fun finderLike(line: (Int) -> Boolean) {
                for (start in 0..size - 7) {
                    if ((0..6).all { line(start + it) == pattern[it] }) {
                        val before = start >= 4 && (start - 4 until start).all { !line(it) }
                        val after = start + 11 <= size && (start + 7 until start + 11).all { !line(it) }
                        if (before || after) score += 40
                    }
                }
            }
            for (y in 0 until size) finderLike { x -> modules[y][x] }
            for (x in 0 until size) finderLike { y -> modules[y][x] }
            val dark = modules.sumOf { row -> row.count { it } }
            score += abs(dark * 20 - size * size * 10) / (size * size) * 10
            return score
        }

        private fun alignmentPositions(): IntArray {
            if (version == 1) return IntArray(0)
            val count = version / 7 + 2
            val step = if (version == 32) 26 else ((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2
            return IntArray(count) { index ->
                if (index == 0) 6 else size - 7 - (count - 1 - index) * step
            }
        }

        private fun setFunction(x: Int, y: Int, value: Boolean) {
            modules[y][x] = value
            function[y][x] = true
        }
    }

    private fun addErrorCorrection(data: ByteArray, version: Int, correction: Correction): ByteArray {
        val blocks = numBlocks[correction.ordinal][version]
        val blockEcc = eccCodewordsPerBlock[correction.ordinal][version]
        val rawCodewords = rawDataModules(version) / 8
        val shortBlocks = blocks - rawCodewords % blocks
        val shortBlockLength = rawCodewords / blocks
        val divisor = reedSolomonDivisor(blockEcc)
        val parts = ArrayList<ByteArray>(blocks)
        var offset = 0
        for (index in 0 until blocks) {
            val dataLength = shortBlockLength - blockEcc + if (index < shortBlocks) 0 else 1
            val blockData = data.copyOfRange(offset, offset + dataLength)
            offset += dataLength
            val ecc = reedSolomonRemainder(blockData, divisor)
            parts += if (index < shortBlocks) blockData + byteArrayOf(0) + ecc else blockData + ecc
        }
        check(offset == data.size)
        val result = ByteArray(rawCodewords)
        var out = 0
        for (position in parts[0].indices) for (block in parts.indices) {
            if (position == shortBlockLength - blockEcc && block < shortBlocks) continue
            result[out++] = parts[block][position]
        }
        check(out == result.size)
        return result
    }

    private fun reedSolomonDivisor(degree: Int): ByteArray {
        val result = ByteArray(degree)
        result[degree - 1] = 1
        var root = 1
        repeat(degree) {
            for (i in result.indices) {
                result[i] = multiply(result[i].toInt() and 0xFF, root).toByte()
                if (i + 1 < result.size) result[i] = (result[i].toInt() xor result[i + 1].toInt()).toByte()
            }
            root = multiply(root, 0x02)
        }
        return result
    }

    private fun reedSolomonRemainder(data: ByteArray, divisor: ByteArray): ByteArray {
        val result = ByteArray(divisor.size)
        for (value in data) {
            val factor = (value.toInt() xor result[0].toInt()) and 0xFF
            result.copyInto(result, 0, 1)
            result[result.lastIndex] = 0
            for (i in result.indices) {
                result[i] = (result[i].toInt() xor multiply(divisor[i].toInt() and 0xFF, factor)).toByte()
            }
        }
        return result
    }

    private fun multiply(left: Int, right: Int): Int {
        var x = left
        var y = right
        var product = 0
        repeat(8) {
            product = product xor (x * (y and 1))
            y = y ushr 1
            x = (x shl 1) xor ((x ushr 7) * 0x11D)
        }
        return product
    }

    private fun dataCapacityBits(version: Int, correction: Correction): Int =
        (rawDataModules(version) / 8 -
            eccCodewordsPerBlock[correction.ordinal][version] * numBlocks[correction.ordinal][version]) * 8

    private fun rawDataModules(version: Int): Int {
        var result = (16 * version + 128) * version + 64
        if (version >= 2) {
            val align = version / 7 + 2
            result -= (25 * align - 10) * align - 55
            if (version >= 7) result -= 36
        }
        return result
    }

    private val eccCodewordsPerBlock = arrayOf(
        intArrayOf(-1, 7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30),
        intArrayOf(-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28),
        intArrayOf(-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30),
        intArrayOf(-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30),
    )

    private val numBlocks = arrayOf(
        intArrayOf(-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25),
        intArrayOf(-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49),
        intArrayOf(-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68),
        intArrayOf(-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81),
    )
}
