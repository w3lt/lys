import Foundation
import Testing
@testable import voice

/// Checks how the dictation socket decodes the JSON messages the backend
/// sends and encodes the ones it answers with.
@Suite("Dictation messages")
struct DictationMessageTests {
    /// Verifies the two messages the backend sends decode as themselves.
    @Test(
        "Decodes the messages the backend sends",
        arguments: [
            (#"{"type":"transcribe"}"#, .transcribe),
            (#"{"type":"stop"}"#, .stop),
        ] as [(String, DictationMessage)]
    )
    func decodesClientMessages(json: String, expected: DictationMessage) {
        #expect(parseDictationMessage(json) == expected)
    }

    /// Verifies malformed messages, and a speech's messages, are refused,
    /// so the connection can answer with the protocol-error close code, or
    /// serve a speech when the message is the connection's first.
    @Test(
        "Refuses malformed messages",
        arguments: [
            "not json",
            "{}",
            #"{"type":"speak"}"#,
            #"{"type":42}"#,
            #"["transcribe"]"#,
        ]
    )
    func refusesMalformedMessages(json: String) {
        #expect(parseDictationMessage(json) == nil)
    }

    /// Verifies an update is encoded as the JSON object the backend
    /// validates: its kind as `type` and its text as `text`, with the
    /// characters JSON must escape intact.
    @Test(
        "Encodes an update as its type and text",
        arguments: [
            (DictationUpdate.partial("hello"), "partial", "hello"),
            (DictationUpdate.final("She said \"hi\".\n"), "final", "She said \"hi\".\n"),
            (DictationUpdate.final(""), "final", ""),
        ]
    )
    func encodesUpdates(update: DictationUpdate, type: String, text: String) throws {
        let object = try JSONSerialization.jsonObject(with: buildDictationUpdateMessage(update))

        #expect(object as? [String: String] == ["type": type, "text": text])
    }
}
