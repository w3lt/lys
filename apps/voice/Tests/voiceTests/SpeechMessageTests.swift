import Foundation
import Testing
@testable import voice

/// Checks how the speech socket decodes the JSON messages the backend sends.
@Suite("Speech messages")
struct SpeechMessageTests {
    /// Verifies the three messages the backend sends decode as themselves.
    @Test(
        "Decodes the messages the backend sends",
        arguments: [
            (#"{"type":"speak"}"#, .speak),
            (#"{"type":"text","text":"Hello."}"#, .text("Hello.")),
            (#"{"type":"finish"}"#, .finish),
        ] as [(String, SpeechMessage)]
    )
    func decodesClientMessages(json: String, expected: SpeechMessage) {
        #expect(parseSpeechMessage(json) == expected)
    }

    /// Verifies malformed messages are refused, so the connection can answer
    /// with the protocol-error close code instead of crashing or guessing.
    @Test(
        "Refuses malformed messages",
        arguments: [
            "not json",
            "{}",
            #"{"type":"unknown"}"#,
            #"{"type":"text"}"#,
            #"{"type":"text","text":""}"#,
            #"{"type":"text","text":42}"#,
            #"[]"#,
        ]
    )
    func refusesMalformedMessages(json: String) {
        #expect(parseSpeechMessage(json) == nil)
    }
}
