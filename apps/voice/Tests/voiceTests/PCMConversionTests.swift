import Foundation
import Testing
@testable import voice

/// Checks how raw samples become the bytes on the wire.
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
}
