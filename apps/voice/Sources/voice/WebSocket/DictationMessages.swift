import Foundation

/// A message the backend sends on a dictation socket, decoded and validated.
enum DictationMessage: Equatable {
    /// `{ "type": "transcribe" }` — start a dictation, closing any older one.
    case transcribe
    /// `{ "type": "stop" }` — no more audio follows; send the final text.
    case stop
}

/// Decodes one client text message of a dictation.
///
/// - Parameter body: The message's UTF-8 text.
/// - Returns: The message, or `nil` for malformed JSON, a value that is not
///   an object, or an unknown `type`; the connection then closes with the
///   protocol-error code, or, for a first message, serves a speech.
func parseDictationMessage(_ body: String) -> DictationMessage? {
    guard let data = body.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let message = object as? [String: Any],
          let type = message["type"] as? String
    else { return nil }
    switch type {
    case "transcribe":
        return .transcribe
    case "stop":
        return .stop
    default:
        return nil
    }
}

/// The JSON object that carries a dictation's text to the backend.
private struct DictationTextMessage: Encodable {
    /// `partial` or `final`.
    let type: String
    /// The whole text so far, or the finished text.
    let text: String
}

/// Builds the text message that carries one update to the backend.
///
/// - Parameter update: The update to send.
/// - Returns: `{ "type": "partial", "text": "…" }` or
///   `{ "type": "final", "text": "…" }`, as UTF-8 JSON.
/// - Throws: The encoder's error when the text cannot be encoded.
func buildDictationUpdateMessage(_ update: DictationUpdate) throws -> Data {
    switch update {
    case .partial(let text):
        return try JSONEncoder().encode(DictationTextMessage(type: "partial", text: text))
    case .final(let text):
        return try JSONEncoder().encode(DictationTextMessage(type: "final", text: text))
    }
}
