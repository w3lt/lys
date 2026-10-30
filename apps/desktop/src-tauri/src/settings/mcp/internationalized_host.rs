//! The rule of the hosts a server URL may name.
//!
//! URL parsers do not convert internationalized domain names alike: this
//! host's (the `url` crate with `idna`), Node's, and WebKit's accept different
//! ones and map some characters to others. A host is accepted when it is plain
//! ASCII, which the other URL rules judge, or an internationalized domain name
//! whose every part is lowercase letters of one of the Latin, Greek, Cyrillic,
//! Chinese, Japanese, or Korean scripts, digits, and hyphens, typed as those
//! letters or as their punycode. Such a name passes only when the parser kept
//! every typed character, apart from ASCII case, so every parser that accepts
//! it writes the same host.
//!
//! Every rule matches `internationalizedHost.ts` in `@lys/share`, which the
//! renderer and the backend check; both sides read the same shared test cases.
//! Punycode is decoded and encoded here, as RFC 3492 defines it, rather than
//! through `idna`, which this crate does not depend on directly.

/// Script whose letters one part of an internationalized domain name may hold.
///
/// ASCII letters are Latin; Chinese, Japanese, and Korean letters form one
/// script, as names in those languages mix them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostScript {
    /// Latin letters, ASCII ones included.
    Latin,
    /// Greek letters.
    Greek,
    /// Cyrillic letters.
    Cyrillic,
    /// Chinese ideographs, Japanese kana, and Korean Hangul syllables.
    Cjk,
}

/// Letters of one script that a part of an internationalized domain name may
/// hold: the code points from `first` to `last`, taking every `step`-th one.
struct ScriptLetterRange {
    /// Script the letters belong to.
    script: HostScript,
    /// First code point of the range.
    first: u32,
    /// Last code point of the range, inclusive.
    last: u32,
    /// 1 to take every code point of the range, 2 to take every other one,
    /// for a block where uppercase and lowercase letters alternate.
    step: u32,
}

/// Letters a part of an internationalized domain name may hold: ASCII
/// lowercase letters, and lowercase letters of long-stable left-to-right
/// scripts that are in Unicode's composed form and that UTS #46 keeps as they
/// are, so every URL parser Lys uses writes them alike.
///
/// Leaves out right-to-left scripts, emoji, symbols, combining marks, and
/// newer characters; `ß`, final `ς`, `ĳ`, `ŀ`, `ŉ`, and `ſ`, which UTS #46
/// maps or treats as deviations; and uppercase letters, which URL parsers
/// lowercase. Matches the list of `@lys/share`; changing one changes which
/// settings files load and requires a coordinated desktop and backend release.
const ACCEPTED_LETTER_RANGES: [ScriptLetterRange; 17] = [
    // Basic Latin: a to z.
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x61,
        last: 0x7a,
        step: 1,
    },
    // Latin-1 Supplement: à to ö, and ø to ÿ.
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0xe0,
        last: 0xf6,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0xf8,
        last: 0xff,
        step: 1,
    },
    // Latin Extended-A: ā to ı, ĵ, ķ, ĸ to ľ, ł to ň, ŋ to ŷ, and ź to ž.
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x101,
        last: 0x131,
        step: 2,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x135,
        last: 0x137,
        step: 2,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x138,
        last: 0x13e,
        step: 2,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x142,
        last: 0x148,
        step: 2,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x14b,
        last: 0x177,
        step: 2,
    },
    ScriptLetterRange {
        script: HostScript::Latin,
        first: 0x17a,
        last: 0x17e,
        step: 2,
    },
    // Greek: ά to ώ, without final ς.
    ScriptLetterRange {
        script: HostScript::Greek,
        first: 0x3ac,
        last: 0x3c1,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Greek,
        first: 0x3c3,
        last: 0x3ce,
        step: 1,
    },
    // Cyrillic: а to џ.
    ScriptLetterRange {
        script: HostScript::Cyrillic,
        first: 0x430,
        last: 0x45f,
        step: 1,
    },
    // Hiragana, Katakana with the prolonged sound mark, the CJK Unified
    // Ideographs of Unicode 1.1, and Hangul syllables.
    ScriptLetterRange {
        script: HostScript::Cjk,
        first: 0x3041,
        last: 0x3093,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Cjk,
        first: 0x30a1,
        last: 0x30f6,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Cjk,
        first: 0x30fc,
        last: 0x30fc,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Cjk,
        first: 0x4e00,
        last: 0x9fa5,
        step: 1,
    },
    ScriptLetterRange {
        script: HostScript::Cjk,
        first: 0xac00,
        last: 0xd7a3,
        step: 1,
    },
];

/// Start of a label of an internationalized domain name in ASCII form.
const PUNYCODE_LABEL_PREFIX: &str = "xn--";

/// Most characters of the punycode after `xn--` in one label, inclusive: the
/// 63 characters of a DNS label less the prefix.
const MAXIMUM_PUNYCODE_LENGTH: usize = 59;

/// Number of punycode digits, `base` in RFC 3492, section 5.
const PUNYCODE_BASE: u32 = 36;

/// Smallest digit threshold, `tmin` in RFC 3492, section 5.
const PUNYCODE_MINIMUM_THRESHOLD: u32 = 1;

/// Largest digit threshold, `tmax` in RFC 3492, section 5.
const PUNYCODE_MAXIMUM_THRESHOLD: u32 = 26;

/// Bias adaptation skew, `skew` in RFC 3492, section 5.
const PUNYCODE_SKEW: u32 = 38;

/// Divisor of the first delta's bias, `damp` in RFC 3492, section 5.
const PUNYCODE_DAMP: u32 = 700;

/// Bias of the first delta, `initial_bias` in RFC 3492, section 5.
const PUNYCODE_INITIAL_BIAS: u32 = 72;

/// First code point a delta can reach, `initial_n` in RFC 3492, section 5.
const PUNYCODE_INITIAL_CODE_POINT: u32 = 0x80;

/// Character after the basic code points of punycode, when it has any.
const PUNYCODE_DELIMITER: char = '-';

/// Punycode digits in value order: `a` to `z` are 0 to 25 and `0` to `9` are
/// 26 to 35. A decoder reads an uppercase letter as its lowercase one.
const PUNYCODE_DIGITS: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// RFC 3492 decoder state between two deltas of one punycode label.
struct PunycodeDecoding {
    /// Characters decoded so far, in order.
    characters: Vec<char>,
    /// Code point of the last insertion, `n` in RFC 3492.
    code_point: u32,
    /// Position the next delta counts from, `i` in RFC 3492.
    position: u32,
    /// Bias of the next delta's digits.
    bias: u32,
}

/// One variable-length integer read from punycode.
struct PunycodeInteger {
    /// Value of the integer.
    value: u32,
    /// Index of the byte after the integer's last digit.
    end: usize,
}

/// RFC 3492 encoder state between two code points of one label.
struct PunycodeEncoding {
    /// Punycode written so far.
    punycode: String,
    /// Code point the next round starts from, `n` in RFC 3492.
    code_point: u32,
    /// Delta carried into the next round.
    delta: u32,
    /// Bias of the next delta's digits.
    bias: u32,
    /// Code points of the text already encoded, `h` in RFC 3492.
    handled_count: u32,
}

/// Calculates the threshold of one digit of a punycode integer (RFC 3492,
/// section 6.2): from [`PUNYCODE_MINIMUM_THRESHOLD`] to
/// [`PUNYCODE_MAXIMUM_THRESHOLD`]; a digit below it is the integer's last.
///
/// `base_multiple` is the digit's `k`: the base times its one-based position
/// in the integer.
fn calculate_punycode_threshold(base_multiple: u32, bias: u32) -> u32 {
    if base_multiple <= bias {
        PUNYCODE_MINIMUM_THRESHOLD
    } else if base_multiple >= bias + PUNYCODE_MAXIMUM_THRESHOLD {
        PUNYCODE_MAXIMUM_THRESHOLD
    } else {
        base_multiple - bias
    }
}

/// Calculates the bias of the next delta (RFC 3492, section 6.1).
///
/// `delta` is the delta just decoded or encoded, `code_point_count` the code
/// points of the label once its code point is in place, and `is_first_delta`
/// whether it is the label's first, which is scaled down more.
fn calculate_punycode_bias(delta: u32, code_point_count: u32, is_first_delta: bool) -> u32 {
    let digit_range = PUNYCODE_BASE - PUNYCODE_MINIMUM_THRESHOLD;
    let first_scaled_delta = delta / if is_first_delta { PUNYCODE_DAMP } else { 2 };
    let mut scaled_delta = first_scaled_delta + first_scaled_delta / code_point_count;
    let mut base_multiple = 0;
    while scaled_delta > digit_range * PUNYCODE_MAXIMUM_THRESHOLD / 2 {
        scaled_delta /= digit_range;
        base_multiple += PUNYCODE_BASE;
    }

    base_multiple + (digit_range + 1) * scaled_delta / (scaled_delta + PUNYCODE_SKEW)
}

/// Finds the value of one punycode digit: 0 to 25 for an ASCII letter, either
/// case, 26 to 35 for an ASCII digit, or `None` for any other byte.
fn find_punycode_digit_value(byte: u8) -> Option<u32> {
    let lowercase_byte = byte.to_ascii_lowercase();

    PUNYCODE_DIGITS
        .iter()
        .position(|digit| *digit == lowercase_byte)
        .and_then(|value| u32::try_from(value).ok())
}

/// Gets the punycode digit of `value`, in lowercase.
///
/// # Panics
///
/// Panics when `value` is 36 or more, which no digit has; the encoder only
/// asks for digits below the base.
fn get_punycode_digit(value: u32) -> char {
    char::from(PUNYCODE_DIGITS[value as usize])
}

/// Parses one variable-length integer of ASCII punycode, starting at `start`
/// (RFC 3492, section 6.2).
///
/// Returns the integer and where it ends, or `None` when a byte is not a
/// digit, the punycode ends before the integer does, or the integer overflows
/// a `u32`.
fn parse_punycode_integer(punycode: &[u8], start: usize, bias: u32) -> Option<PunycodeInteger> {
    let mut value: u32 = 0;
    let mut weight: u32 = 1;
    let mut base_multiple = PUNYCODE_BASE;
    for (index, byte) in punycode.iter().enumerate().skip(start) {
        let digit = find_punycode_digit_value(*byte)?;
        value = value.checked_add(digit.checked_mul(weight)?)?;
        let threshold = calculate_punycode_threshold(base_multiple, bias);
        if digit < threshold {
            return Some(PunycodeInteger {
                value,
                end: index + 1,
            });
        }
        weight = weight.checked_mul(PUNYCODE_BASE - threshold)?;
        base_multiple += PUNYCODE_BASE;
    }

    None
}

/// Calculates the decoder state after the code point of one decoded delta is
/// inserted (RFC 3492, section 6.2).
///
/// Returns the decoder state after the insertion, or `None` when the position
/// or the code point overflows a `u32` or the code point is not a Unicode
/// scalar value.
fn calculate_next_punycode_decoding(
    decoding: PunycodeDecoding,
    delta: u32,
) -> Option<PunycodeDecoding> {
    let is_first_delta = decoding.position == 0;
    let position = decoding.position.checked_add(delta)?;
    let code_point_count = u32::try_from(decoding.characters.len() + 1).ok()?;
    let code_point = decoding
        .code_point
        .checked_add(position / code_point_count)?;
    let character = char::from_u32(code_point)?;
    let insertion_index = position % code_point_count;
    let mut characters = decoding.characters;
    characters.insert(usize::try_from(insertion_index).ok()?, character);

    Some(PunycodeDecoding {
        characters,
        code_point,
        position: insertion_index + 1,
        bias: calculate_punycode_bias(delta, code_point_count, is_first_delta),
    })
}

/// Parses punycode, such as the part of a label after `xn--`, into the text
/// it encodes, as RFC 3492's decoder does (section 6.2), reading uppercase
/// letters as lowercase ones.
///
/// Returns `None` when the punycode is longer than
/// [`MAXIMUM_PUNYCODE_LENGTH`] bytes, holds a character beyond ASCII or a
/// character that is not a digit where a digit belongs, ends inside an
/// integer, overflows, or encodes a code point that is not a Unicode scalar
/// value.
fn parse_punycode(punycode: &str) -> Option<String> {
    if punycode.len() > MAXIMUM_PUNYCODE_LENGTH || !punycode.is_ascii() {
        return None;
    }
    let delimiter_index = punycode.rfind(PUNYCODE_DELIMITER);
    let basic_text = punycode.get(..delimiter_index.unwrap_or(0))?;
    let mut decoding = PunycodeDecoding {
        characters: basic_text.chars().collect(),
        code_point: PUNYCODE_INITIAL_CODE_POINT,
        position: 0,
        bias: PUNYCODE_INITIAL_BIAS,
    };
    let mut index = delimiter_index
        .filter(|delimiter| *delimiter > 0)
        .map_or(0, |delimiter| delimiter + 1);
    while index < punycode.len() {
        let delta = parse_punycode_integer(punycode.as_bytes(), index, decoding.bias)?;
        decoding = calculate_next_punycode_decoding(decoding, delta.value)?;
        index = delta.end;
    }

    Some(decoding.characters.into_iter().collect())
}

/// Calculates the punycode digits of one integer, in lowercase (RFC 3492,
/// section 6.3).
fn calculate_punycode_integer(value: u32, bias: u32) -> String {
    let mut digits = String::new();
    let mut remainder = value;
    let mut base_multiple = PUNYCODE_BASE;
    loop {
        let threshold = calculate_punycode_threshold(base_multiple, bias);
        if remainder < threshold {
            digits.push(get_punycode_digit(remainder));
            return digits;
        }
        let digit_range = PUNYCODE_BASE - threshold;
        digits.push(get_punycode_digit(
            threshold + (remainder - threshold) % digit_range,
        ));
        remainder = (remainder - threshold) / digit_range;
        base_multiple += PUNYCODE_BASE;
    }
}

/// Calculates one round of RFC 3492's encoder (section 6.3): writes the
/// deltas of every occurrence of the smallest code point not yet encoded.
///
/// `code_points` are those of the whole text, in order, and `basic_count`
/// how many of them are ASCII. Returns the encoder state after the round, or
/// `None` when a delta overflows a `u32`.
fn calculate_next_punycode_encoding(
    encoding: PunycodeEncoding,
    code_points: &[u32],
    basic_count: u32,
) -> Option<PunycodeEncoding> {
    let PunycodeEncoding {
        mut punycode,
        code_point: start_code_point,
        delta: start_delta,
        mut bias,
        mut handled_count,
    } = encoding;
    let code_point = code_points
        .iter()
        .copied()
        .filter(|candidate| *candidate >= start_code_point)
        .min()?;
    let mut delta = (code_point - start_code_point)
        .checked_mul(handled_count + 1)?
        .checked_add(start_delta)?;
    for candidate in code_points.iter().copied() {
        if candidate < code_point {
            delta = delta.checked_add(1)?;
        }
        if candidate == code_point {
            punycode.push_str(&calculate_punycode_integer(delta, bias));
            bias = calculate_punycode_bias(delta, handled_count + 1, handled_count == basic_count);
            delta = 0;
            handled_count += 1;
        }
    }

    Some(PunycodeEncoding {
        punycode,
        code_point: code_point + 1,
        delta: delta.checked_add(1)?,
        bias,
        handled_count,
    })
}

/// Calculates the punycode of `text`, as RFC 3492's encoder does (section
/// 6.3), with its ASCII characters as they are and its digits in lowercase.
///
/// Returns `None` when a delta overflows a `u32`.
fn calculate_punycode(text: &str) -> Option<String> {
    let code_points: Vec<u32> = text.chars().map(u32::from).collect();
    let basic_text: String = text.chars().filter(char::is_ascii).collect();
    let basic_count = u32::try_from(basic_text.len()).ok()?;
    let code_point_count = u32::try_from(code_points.len()).ok()?;
    let mut encoding = PunycodeEncoding {
        punycode: if basic_text.is_empty() {
            String::new()
        } else {
            format!("{basic_text}{PUNYCODE_DELIMITER}")
        },
        code_point: PUNYCODE_INITIAL_CODE_POINT,
        delta: 0,
        bias: PUNYCODE_INITIAL_BIAS,
        handled_count: basic_count,
    };
    while encoding.handled_count < code_point_count {
        encoding = calculate_next_punycode_encoding(encoding, &code_points, basic_count)?;
    }

    Some(encoding.punycode)
}

/// Reports whether `code_point` is one of the letters of `range`.
fn is_in_letter_range(code_point: u32, range: &ScriptLetterRange) -> bool {
    (range.first..=range.last).contains(&code_point)
        && (code_point - range.first).is_multiple_of(range.step)
}

/// Finds the script of an accepted letter, or returns `None` when `character`
/// is not a letter a part of an internationalized domain name may hold.
fn find_letter_script(character: char) -> Option<HostScript> {
    let code_point = u32::from(character);

    ACCEPTED_LETTER_RANGES
        .iter()
        .find(|range| is_in_letter_range(code_point, range))
        .map(|range| range.script)
}

/// Reports whether the hyphens of a part of a domain name stand where DNS
/// names allow them: not at either end, and not as its third and fourth
/// characters, which mark a label such as `xn--`.
fn has_accepted_hyphens(characters: &[char]) -> bool {
    let has_edge_hyphen = characters.first() == Some(&'-') || characters.last() == Some(&'-');
    let has_hyphen_pair = characters.get(2) == Some(&'-') && characters.get(3) == Some(&'-');

    !has_edge_hyphen && !has_hyphen_pair
}

/// Reports whether `text`, one part of an internationalized domain name as a
/// person types it, follows the rule: not empty, accepted letters of one
/// script, digits, and hyphens, with hyphens only where
/// [`has_accepted_hyphens`] allows them.
fn is_accepted_label_text(text: &str) -> bool {
    let characters: Vec<char> = text.chars().collect();
    if characters.is_empty() || !has_accepted_hyphens(&characters) {
        return false;
    }
    let scripts: Vec<Option<HostScript>> = characters
        .iter()
        .copied()
        .filter(|character| !character.is_ascii_digit() && *character != '-')
        .map(find_letter_script)
        .collect();

    scripts
        .iter()
        .all(|script| script.is_some() && Some(script) == scripts.first())
}

/// Parses one label of a host, as the URL parser wrote it in lowercase ASCII,
/// into the text a person types for it: a label starting with `xn--` decoded
/// from its punycode, or any other label as it is.
///
/// Returns `None` when the punycode does not decode, decodes to ASCII only,
/// or is not exactly what the text encodes to. The last check is a guard:
/// the URL parsers Lys uses write only punycode that is exactly what its
/// text encodes to, so it does not refuse a host they wrote.
fn parse_label_text(label: &str) -> Option<String> {
    let Some(punycode) = label.strip_prefix(PUNYCODE_LABEL_PREFIX) else {
        return Some(label.to_owned());
    };
    let text = parse_punycode(punycode).filter(|text| !text.is_ascii())?;

    (calculate_punycode(&text).as_deref() == Some(punycode)).then_some(text)
}

/// Reports whether one label of an internationalized domain name follows the
/// rule and is what the URL text holds: its text follows
/// [`is_accepted_label_text`], and `typed_label`, with its ASCII letters in
/// lowercase, is that text or the label's punycode form. A label the parser
/// changed any other character of is refused.
fn is_accepted_label(typed_label: &str, label: &str) -> bool {
    let typed_text = typed_label.to_ascii_lowercase();

    parse_label_text(label).is_some_and(|text| {
        is_accepted_label_text(&text) && (typed_text == text || typed_text == label)
    })
}

/// Gets the host of an `http:` or `https:` URL as `url_text` holds it, before
/// the URL parser converts it: after the scheme, the slashes or backslashes
/// that follow it, and any user name and password, up to the port, path,
/// query, or fragment. An IPv6 address keeps its brackets.
fn get_typed_host(url_text: &str) -> &str {
    let after_scheme = url_text.split_once(':').map_or(url_text, |(_, rest)| rest);
    let authority = after_scheme
        .trim_start_matches(['/', '\\'])
        .split(['/', '\\', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_and_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if host_and_port.starts_with('[') {
        return host_and_port
            .find(']')
            .map_or("", |end| &host_and_port[..=end]);
    }

    host_and_port.split(':').next().unwrap_or_default()
}

/// Reports whether a host is plain ASCII: `typed_host` holds no character
/// beyond ASCII, and `host`, as the URL parser wrote it, no label starting
/// with `xn--`, which a percent-encoded name can also get.
fn is_plain_ascii_host(typed_host: &str, host: &str) -> bool {
    typed_host.is_ascii()
        && !host
            .split('.')
            .any(|label| label.starts_with(PUNYCODE_LABEL_PREFIX))
}

/// Reports whether an internationalized domain name follows the rule: typed
/// without percent-encoding, with the same parts the URL parser wrote, each
/// following [`is_accepted_label`]. A host whose parts the text separates with
/// a character the parser turns into a dot, such as `。`, is refused.
fn is_accepted_internationalized_host(typed_host: &str, host: &str) -> bool {
    let typed_labels: Vec<&str> = typed_host.split('.').collect();
    let labels: Vec<&str> = host.split('.').collect();
    if typed_host.contains('%') || typed_labels.len() != labels.len() {
        return false;
    }

    typed_labels
        .iter()
        .zip(&labels)
        .all(|(typed_label, label)| is_accepted_label(typed_label, label))
}

/// Reports whether the host of an `http:` or `https:` URL is one Lys accepts:
/// plain ASCII, which the other URL rules judge, or an internationalized
/// domain name that follows the rule of this module.
///
/// `url_text` is the URL as typed, which parses with an `http:` or `https:`
/// scheme, and `host` its host as the URL parser wrote it.
pub(super) fn is_accepted_host(url_text: &str, host: &str) -> bool {
    let typed_host = get_typed_host(url_text);

    is_plain_ascii_host(typed_host, host) || is_accepted_internationalized_host(typed_host, host)
}

#[cfg(test)]
mod tests {
    use tauri::Url;

    use super::{
        calculate_punycode, get_typed_host, is_accepted_host, is_accepted_label_text,
        parse_label_text, parse_punycode, ACCEPTED_LETTER_RANGES,
    };

    /// The samples of RFC 3492, section 7.1, but for sample H, whose
    /// punycode is longer than a label holds: each sample's letter, text, and
    /// punycode. Sample I's punycode is in lowercase, as the encoder writes
    /// it; the RFC marks one of its letters uppercase.
    const RFC_3492_SAMPLES: [(&str, &str, &str); 18] = [
        ("A", "ليهمابتكلموشعربي؟", "egbpdaj6bu4bxfgehfvwxn"),
        ("B", "他们为什么不说中文", "ihqwcrb4cv8a8dqg056pqjye"),
        ("C", "他們爲什麽不說中文", "ihqwctvzc91f659drss3x8bo0yb"),
        (
            "D",
            "Pročprostěnemluvíčesky",
            "Proprostnemluvesky-uyb24dma41a",
        ),
        (
            "E",
            "למההםפשוטלאמדבריםעברית",
            "4dbcagdahymbxekheh6e0a7fei0b",
        ),
        (
            "F",
            "यहलोगहिन्दीक्योंनहींबोलसकतेहैं",
            "i1baa7eci9glrd9b2ae1bj0hfcgg6iyaf8o0a1dig0cd",
        ),
        (
            "G",
            "なぜみんな日本語を話してくれないのか",
            "n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa",
        ),
        (
            "I",
            "почемужеонинеговорятпорусски",
            "b1abfaaepdrnnbgefbadotcwatmq2g4l",
        ),
        (
            "J",
            "PorquénopuedensimplementehablarenEspañol",
            "PorqunopuedensimplementehablarenEspaol-fmd56a",
        ),
        (
            "K",
            "TạisaohọkhôngthểchỉnóitiếngViệt",
            "TisaohkhngthchnitingVit-kjcr8268qyxafd2f1b9g",
        ),
        ("L", "3年B組金八先生", "3B-ww4c5e180e575a65lsy2b"),
        (
            "M",
            "安室奈美恵-with-SUPER-MONKEYS",
            "-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n",
        ),
        (
            "N",
            "Hello-Another-Way-それぞれの場所",
            "Hello-Another-Way--fc4qua05auwb3674vfr0b",
        ),
        ("O", "ひとつ屋根の下2", "2-u9tlzr9756bt3uc0v"),
        ("P", "MajiでKoiする5秒前", "MajiKoi5-783gue6qz075azm5e"),
        ("Q", "パフィーdeルンバ", "de-jg4avhby1noc0d"),
        ("R", "そのスピードで", "d9juau41awczczp"),
        ("S", "-> $1.00 <-", "-> $1.00 <--"),
    ];

    /// Sample H of RFC 3492, section 7.1: Korean text whose 69-character
    /// punycode is longer than a label holds.
    const RFC_3492_SAMPLE_H: (&str, &str) = (
        "세계의모든사람들이한국어를이해한다면얼마나좋을까",
        "989aomsvi5e83db1d2a355cv1e0vak1dwrv93d5xbh15a0dt30a5jpsd879ccm6fea98c",
    );

    #[test]
    fn decodes_and_encodes_the_rfc_3492_samples() {
        for (sample, text, punycode) in RFC_3492_SAMPLES {
            assert_eq!(
                parse_punycode(punycode).as_deref(),
                Some(text),
                "sample {sample}"
            );
            assert_eq!(
                calculate_punycode(text).as_deref(),
                Some(punycode),
                "sample {sample}"
            );
        }
    }

    #[test]
    fn reads_uppercase_punycode_digits_as_lowercase_ones() {
        assert_eq!(
            parse_punycode("b1abfaaepdrnnbgefbaDotcwatmq2g4l").as_deref(),
            Some("почемужеонинеговорятпорусски")
        );
        assert_eq!(parse_punycode("bcher-KVA").as_deref(), Some("bücher"));
    }

    #[test]
    fn decodes_punycode_only_up_to_the_length_a_label_holds() {
        let longest_punycode = format!("{}-8yf", "a".repeat(55));
        let too_long_punycode = format!("{}-t2f", "a".repeat(56));
        let (sample_h_text, sample_h_punycode) = RFC_3492_SAMPLE_H;

        assert_eq!(
            parse_punycode(&longest_punycode),
            Some(format!("{}ü", "a".repeat(55)))
        );
        assert_eq!(
            calculate_punycode(&format!("{}ü", "a".repeat(56))),
            Some(too_long_punycode.clone())
        );
        assert_eq!(parse_punycode(&too_long_punycode), None);
        assert_eq!(
            calculate_punycode(sample_h_text).as_deref(),
            Some(sample_h_punycode)
        );
        assert_eq!(parse_punycode(sample_h_punycode), None);
    }

    #[test]
    fn refuses_punycode_that_does_not_decode_to_unicode_scalar_values() {
        for punycode in [
            // A character beyond ASCII.
            "bücher-kva",
            // A character that is not a digit where a digit belongs.
            "bcher-k!a",
            // A delimiter with no basic code point before it.
            "-kva",
            // An integer the punycode ends inside.
            "bcher-kv",
            // An integer past 32 bits.
            "99999999999a",
            // A surrogate, U+D800.
            "ib9b",
            // A code point past U+10FFFF.
            "en32g",
        ] {
            assert_eq!(parse_punycode(punycode), None, "{punycode}");
        }
        assert_eq!(parse_punycode("dn32g").as_deref(), Some("\u{10ffff}"));
    }

    #[test]
    fn reads_a_label_from_its_punycode_only_in_the_form_the_encoder_writes() {
        assert_eq!(parse_label_text("xn--bcher-kva").as_deref(), Some("bücher"));
        assert_eq!(parse_label_text("example").as_deref(), Some("example"));
        for label in [
            // Digits in uppercase, which the encoder writes in lowercase.
            "xn--bcher-KVA",
            // Punycode of ASCII text only.
            "xn--abc-",
            "xn--",
            // Punycode that does not decode.
            "xn--b",
        ] {
            assert_eq!(parse_label_text(label), None, "{label}");
        }
    }

    #[test]
    fn accepts_parts_of_letters_of_one_listed_script_digits_and_hyphens() {
        for text in [
            "bücher",
            "zażółć",
            "ıiçin",
            "παράδειγμα",
            "пример",
            "サーバー",
            "例え",
            "실례",
            "例子",
            "b-ü-cher-2",
            "1ü2",
        ] {
            assert!(is_accepted_label_text(text), "{text}");
        }
    }

    #[test]
    fn refuses_parts_that_mix_scripts_or_misplace_hyphens() {
        for text in ["", "p\u{430}ypal", "aα", "例a", "-bü", "bü-", "bü--cher"] {
            assert!(!is_accepted_label_text(text), "{text}");
        }
    }

    #[test]
    fn refuses_characters_off_the_list_of_letters() {
        // An ASCII uppercase letter and symbol; Latin letters next to listed
        // ones or that UTS #46 maps; Greek, Cyrillic, kana, ideographs, and
        // Hangul past the listed ranges; then an emoji, Arabic and Hebrew
        // letters, a combining mark, and a middle dot.
        let characters = "A_À×ß÷ĀİĲĳĴŀŁŉŊŸŹſΆΐςϐЯѠゔゝヷ・ヽ\u{3400}\u{9fa6}\u{d7b0}\u{20000}\
            \u{1f600}\u{628}\u{5d0}\u{301}\u{b7}";

        for character in characters.chars() {
            assert!(
                !is_accepted_label_text(&format!("1{character}2")),
                "{character:?}"
            );
        }
    }

    #[test]
    fn accepts_every_listed_letter_typed_as_itself_or_as_punycode() {
        let letters = ACCEPTED_LETTER_RANGES.iter().flat_map(|range| {
            (range.first..=range.last)
                .step_by(range.step as usize)
                .filter_map(char::from_u32)
        });

        for letter in letters {
            let url_text = format!("https://1{letter}2.example/mcp");
            let url = Url::parse(&url_text).expect("a URL to the letter");
            let host = url.host_str().expect("a host");
            let first_label = host.split('.').next().unwrap_or_default();
            let punycode_url_text = format!("https://{}/mcp", host.to_ascii_uppercase());

            assert_eq!(
                parse_label_text(first_label),
                Some(format!("1{letter}2")),
                "{letter:?}"
            );
            assert!(is_accepted_host(&url_text, host), "{letter:?}");
            assert!(is_accepted_host(&punycode_url_text, host), "{letter:?}");
        }
    }

    #[test]
    fn gets_the_host_as_the_url_text_holds_it() {
        for (url_text, typed_host) in [
            ("https://bücher.example/mcp", "bücher.example"),
            ("HTTPS://BÜCHER.example:8443/mcp?x=1", "BÜCHER.example"),
            ("https://user:pass@bücher.example/mcp", "bücher.example"),
            ("https:///bücher.example/mcp", "bücher.example"),
            ("https:\\\\bücher.example\\mcp", "bücher.example"),
            ("https://bücher.example?x=1", "bücher.example"),
            ("https://bücher.example#top", "bücher.example"),
            ("https://bücher.example", "bücher.example"),
            ("http://[::1]:3000/mcp", "[::1]"),
        ] {
            assert_eq!(get_typed_host(url_text), typed_host, "{url_text}");
        }
    }
}
