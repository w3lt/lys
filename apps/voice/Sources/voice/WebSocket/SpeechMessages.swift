import Foundation

/// A message the backend sends on a speech socket, decoded and validated.
enum SpeechMessage: Equatable {
    /// `{ "type": "speak" }` — start a speech, closing any older one.
    case speak
    /// `{ "type": "text", "text": "…" }` — queue one sentence.
    case text(String)
    /// `{ "type": "finish" }` — no more text will follow.
    case finish
}

/// Decodes one client message.
///
/// Returns `nil` for malformed JSON, an unknown `type`, a `text` message
/// without a non-empty `text` string, or extra non-JSON payloads; the
/// connection closes with the protocol-error code when this returns `nil`.
func decodeSpeechMessage(_ body: String) -> SpeechMessage? {
    guard let data = body.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let message = object as? [String: Any],
          let type = message["type"] as? String
    else { return nil }
    switch type {
    case "speak":
        return .speak
    case "text":
        guard let text = message["text"] as? String, !text.isEmpty else { return nil }
        return .text(text)
    case "finish":
        return .finish
    default:
        return nil
    }
}
