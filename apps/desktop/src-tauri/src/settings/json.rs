//! Readers of stored settings shapes from JSON objects only.
//!
//! Serde's derived structs and tagged enums also read a JSON array as their
//! fields in order, so a derived settings group would accept `[]` or
//! `["Paris", null, null]` in place of its object. The `@lys/share` schemas,
//! which the renderer and the backend check, refuse that form; every stored
//! shape is read from an object first so that both sides judge a settings
//! file the same way.

use std::collections::BTreeMap;

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

/// Reads a JSON object whose values are JSON objects into stored shapes by
/// key, refusing any value that is not a JSON object, as
/// [`parse_json_object`] does for one.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not a JSON object of
/// JSON objects, and the shape's error when an object does not match it.
pub(super) fn parse_keyed_json_objects<'de, D, T>(
    deserializer: D,
) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    BTreeMap::<String, Map<String, Value>>::deserialize(deserializer)?
        .into_iter()
        .map(|(key, object)| {
            T::deserialize(Value::Object(object))
                .map(|shape| (key, shape))
                .map_err(D::Error::custom)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use std::collections::BTreeMap;

    use super::{parse_json_object, parse_json_objects, parse_keyed_json_objects};

    #[derive(Debug, PartialEq, Eq, Deserialize)]
    #[serde(default)]
    /// A derived shape, which serde alone would also read from an array.
    struct Shape {
        /// Any field.
        name: String,
    }

    impl Default for Shape {
        fn default() -> Self {
            Self {
                name: "default".to_string(),
            }
        }
    }

    #[test]
    fn a_derived_shape_alone_reads_an_array_as_its_fields() {
        let shape: Shape = serde_json::from_value(json!(["stored"])).expect("serde reads it");

        assert_eq!(shape.name, "stored");
    }

    #[test]
    fn reads_an_object_and_refuses_every_other_value() {
        let shape: Shape = parse_json_object(json!({ "name": "stored" })).expect("an object");
        assert_eq!(shape.name, "stored");

        for value in [
            json!(["stored"]),
            json!([]),
            json!(null),
            json!("stored"),
            json!(1),
        ] {
            let failure = parse_json_object::<_, Shape>(value.clone()).expect_err("not an object");

            assert!(
                failure.to_string().contains("expected a map"),
                "{value}: {failure}"
            );
        }
        assert!(parse_json_object::<_, Shape>(json!({ "name": 1 })).is_err());
    }

    #[test]
    fn reads_a_list_of_objects_and_refuses_any_other_item() {
        let shapes: Vec<Shape> = parse_json_objects(json!([{ "name": "a" }, {}])).expect("objects");
        assert_eq!(
            shapes
                .iter()
                .map(|shape| shape.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "default"]
        );

        for value in [
            json!([["a"]]),
            json!([{ "name": "a" }, null]),
            json!({ "name": "a" }),
        ] {
            assert!(
                parse_json_objects::<_, Shape>(value.clone()).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn reads_objects_by_key_and_refuses_any_other_value() {
        let shapes: BTreeMap<String, Shape> =
            parse_keyed_json_objects(json!({ "a": { "name": "stored" }, "b": {} }))
                .expect("objects");
        assert_eq!(
            shapes,
            BTreeMap::from([
                (
                    "a".to_string(),
                    Shape {
                        name: "stored".to_string()
                    }
                ),
                ("b".to_string(), Shape::default()),
            ])
        );

        for value in [
            json!({ "a": ["stored"] }),
            json!({ "a": { "name": "a" }, "b": null }),
            json!([{ "name": "a" }]),
        ] {
            assert!(
                parse_keyed_json_objects::<_, Shape>(value.clone()).is_err(),
                "{value}"
            );
        }
    }
}
