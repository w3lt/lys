import Foundation

/// Converts between floating-point samples and the wire format the backend
/// and the desktop use: 16-bit little-endian PCM, mono. Speech goes out at
/// 24 kHz and a dictation's audio comes in at 16 kHz; the bytes of a sample
/// are the same at both rates.
enum PCMConversion {
    /// Most negative 16-bit sample; the positive peak is one less, so a
    /// full-scale negative sample is not folded onto the positive peak.
    private static let minimumSample: Float = -32_768

    /// Most positive 16-bit sample, used to scale positive samples.
    private static let maximumSample: Float = 32_767

    /// Converts `samples` to little-endian 16-bit PCM bytes.
    ///
    /// Samples are clamped to `[-1, 1]` before scaling; `-1` maps to
    /// `-32768` and `1` to `32767`.
    ///
    /// - Parameter samples: Floating-point samples, nominally within `[-1, 1]`.
    /// - Returns: Twice as many bytes as there are samples.
    static func buildLittleEndianPCM16(from samples: [Float]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = min(1, max(-1, sample))
            let scaled = clamped < 0 ? clamped * -minimumSample : clamped * maximumSample
            var bits = Int16(clamping: Int(scaled.rounded())).littleEndian
            withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
        }
        return data
    }

    /// Reads little-endian 16-bit PCM bytes as samples.
    ///
    /// `-32768` maps to `-1`, and `32767` to just under `1`.
    ///
    /// - Parameter bytes: Two bytes per sample.
    /// - Returns: Half as many samples as there are bytes, each within
    ///   `[-1, 1)`, or `nil` when `bytes` ends in half a sample.
    static func parseLittleEndianPCM16(_ bytes: Data) -> [Float]? {
        guard bytes.count.isMultiple(of: 2) else { return nil }
        return stride(from: bytes.startIndex, to: bytes.endIndex, by: 2).map { index in
            let bits = UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8
            return Float(Int16(bitPattern: bits)) / -minimumSample
        }
    }
}
