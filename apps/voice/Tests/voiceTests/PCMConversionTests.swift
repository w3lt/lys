import Foundation
import Testing
@testable import voice

/// Checks how raw samples become the bytes on the wire, and back.
@Suite("PCM conversion")
struct PCMConversionTests {
    /// Verifies full-scale floats map to the 16-bit extremes in little-endian
    /// byte order.
    @Test("Maps full scale to the 16-bit extremes, little endian")
    func mapsFullScale() {
        let data = PCMConversion.buildLittleEndianPCM16(from: [-1, 1])

        #expect(data == Data([0x00, 0x80, 0xFF, 0x7F]))
    }

    /// Verifies silence stays silence.
    @Test("Maps silence to zero bytes")
    func mapsSilence() {
        let data = PCMConversion.buildLittleEndianPCM16(from: [0, 0, 0])

        #expect(data == Data([0, 0, 0, 0, 0, 0]))
    }

    /// Verifies samples beyond the full scale are clamped, not wrapped.
    @Test("Clamps samples beyond full scale")
    func clamps() {
        let data = PCMConversion.buildLittleEndianPCM16(from: [-2, 2])

        #expect(data == Data([0x00, 0x80, 0xFF, 0x7F]))
    }

    /// Verifies the output carries two bytes per sample.
    @Test("Produces two bytes per sample")
    func sizeIsDouble() {
        let data = PCMConversion.buildLittleEndianPCM16(from: [Float](repeating: 0.5, count: 7))

        #expect(data.count == 14)
    }

    /// Verifies the 16-bit extremes and silence read back as samples within
    /// the unit range, low byte first.
    @Test("Reads little-endian bytes as samples within the unit range")
    func readsSamples() {
        let samples = PCMConversion.parseLittleEndianPCM16(Data([0x00, 0x80, 0x00, 0x00, 0x00, 0x40, 0xFF, 0x7F]))

        #expect(samples == [-1, 0, 0.5, 32_767.0 / 32_768.0])
    }

    /// Verifies a slice of a larger buffer reads from its own start.
    @Test("Reads a slice from its own start")
    func readsASlice() {
        let bytes = Data([0xFF, 0x00, 0x40, 0x00, 0x80])

        #expect(PCMConversion.parseLittleEndianPCM16(bytes[1 ..< 5]) == [0.5, -1])
    }

    /// Verifies bytes that end in half a sample are refused instead of
    /// being cut short.
    @Test("Refuses bytes that end in half a sample")
    func refusesHalfASample() {
        #expect(PCMConversion.parseLittleEndianPCM16(Data([0x00, 0x40, 0x01])) == nil)
    }

    /// Verifies no bytes read as no samples.
    @Test("Reads no bytes as no samples")
    func readsNothing() {
        #expect(PCMConversion.parseLittleEndianPCM16(Data()) == [])
    }
}
