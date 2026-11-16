import Foundation

/// Converts the samples PocketTTS produces into the wire format the backend
/// and the desktop player use: 16-bit little-endian PCM, 24 kHz, mono.
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
    static func littleEndianPCM16(from samples: [Float]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = min(1, max(-1, sample))
            let scaled = clamped < 0 ? clamped * -minimumSample : clamped * maximumSample
            var bits = Int16(clamping: Int(scaled.rounded())).littleEndian
            withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
        }
        return data
    }
}
