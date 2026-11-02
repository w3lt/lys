//! Reading of stored JSON objects into the settings' stored shapes.
//!
//! Serde's derived structs and tagged enums also read a JSON array as their
//! fields in order; the `@lys/share` schemas refuse that form, so the groups
//! whose rules the renderer and the backend share read every stored shape
//! from an object first.

use serde::de::{DeserializeOwned, Error};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// Reads a JSON object into a stored shape, refusing every other JSON value.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not a JSON object, and
/// the shape's error when the object does not match it.
pub(super) fn parse_json_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let object = Map::<String, Value>::deserialize(deserializer)?;

    T::deserialize(Value::Object(object)).map_err(D::Error::custom)
}

/// Reads a JSON array of objects into stored shapes, refusing any item that is
/// not a JSON object, as [`parse_json_object`] does for one.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not an array of JSON
/// objects, and the shape's error when an object does not match it.
pub(super) fn parse_json_objects<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Vec::<Map<String, Value>>::deserialize(deserializer)?
        .into_iter()
        .map(|object| T::deserialize(Value::Object(object)).map_err(D::Error::custom))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::{json, Value};

    use super::{parse_json_object, parse_json_objects};

    #[derive(Debug, PartialEq, Deserialize)]
    #[serde(deny_unknown_fields)]
    /// A stored shape of two fields.
    struct Pair {
        /// First field.
        left: u8,
        /// Second field.
        right: u8,
    }

    #[derive(Debug, PartialEq, Deserialize)]
    /// A stored shape that reads its fields through the helpers.
    struct Holder {
        /// One object.
        #[serde(deserialize_with = "parse_json_object")]
        pair: Pair,
        /// A list of objects.
        #[serde(deserialize_with = "parse_json_objects")]
        pairs: Vec<Pair>,
    }

    /// Reads `stored` as a [`Holder`].
    fn parse_holder(stored: Value) -> Result<Holder, serde_json::Error> {
        serde_json::from_value(stored)
    }

    #[test]
    fn reads_objects_and_lists_of_objects() {
        let holder = parse_holder(json!({
            "pair": { "left": 1, "right": 2 },
            "pairs": [{ "left": 3, "right": 4 }]
        }))
        .expect("a valid holder");

        assert_eq!(
            holder,
            Holder {
                pair: Pair { left: 1, right: 2 },
                pairs: vec![Pair { left: 3, right: 4 }]
            }
        );
    }

    #[test]
    fn refuses_arrays_and_other_values_where_an_object_is_read() {
        for stored in [
            json!({ "pair": [1, 2], "pairs": [] }),
            json!({ "pair": null, "pairs": [] }),
            json!({ "pair": "1,2", "pairs": [] }),
            json!({ "pair": { "left": 1, "right": 2 }, "pairs": [[3, 4]] }),
            json!({ "pair": { "left": 1, "right": 2 }, "pairs": [null] }),
            json!({ "pair": { "left": 1, "right": 2 }, "pairs": { "left": 3, "right": 4 } }),
            json!({ "pair": { "left": 1, "right": 2, "extra": 0 }, "pairs": [] }),
        ] {
            assert!(parse_holder(stored.clone()).is_err(), "{stored}");
        }
    }
}
