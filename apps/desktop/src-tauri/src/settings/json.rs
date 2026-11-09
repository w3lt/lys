//! Readers of stored settings shapes from JSON objects only.
//!
//! Serde's derived structs and tagged enums also read a JSON array as their
//! fields in order, so a derived settings group would accept `[]` or
//! `["Paris", null, null]` in place of its object. The `@lys/share` schemas,
//! which the renderer and the backend check, refuse that form; every stored
//! shape is read from an object first so that both sides judge a settings
//! file the same way. The shape reads the object's entries as the JSON reader
//! reads them, so a failure inside it still names its line and column.

use std::{collections::BTreeMap, fmt, marker::PhantomData};

use serde::de::{value::MapAccessDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// Reads a JSON object into a stored shape, refusing every other JSON value.
///
/// # Errors
///
/// Returns the deserializer's error when the input is not a JSON object, and
/// the shape's error when the object does not match it.
pub(super) fn parse_json_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    deserializer.deserialize_map(JsonObjectVisitor(PhantomData))
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
    T: Deserialize<'de>,
{
    let objects = Vec::<JsonObject<T>>::deserialize(deserializer)?;

    Ok(objects.into_iter().map(|JsonObject(shape)| shape).collect())
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
    T: Deserialize<'de>,
{
    let objects = BTreeMap::<String, JsonObject<T>>::deserialize(deserializer)?;

    Ok(objects
        .into_iter()
        .map(|(key, JsonObject(shape))| (key, shape))
        .collect())
}

/// A stored shape read from a JSON object only, as [`parse_json_object`]
/// reads it, so that a list or a map of them is read the same way.
struct JsonObject<T>(
    /// The shape read from the object.
    T,
);

/// Deserializes the shape from a JSON object only.
impl<'de, T: Deserialize<'de>> Deserialize<'de> for JsonObject<T> {
    /// Reads the shape as [`parse_json_object`] does.
    ///
    /// # Errors
    ///
    /// Returns the deserializer's error when the input is not a JSON object,
    /// and the shape's error when the object does not match it.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        parse_json_object(deserializer).map(Self)
    }
}

/// Visitor that accepts a JSON object only and reads a stored shape from it.
struct JsonObjectVisitor<T>(
    /// The shape the object is read into; the visitor holds no value.
    PhantomData<T>,
);

/// Hands the object's entries, as the JSON reader reads them, to the shape.
impl<'de, T: Deserialize<'de>> Visitor<'de> for JsonObjectVisitor<T> {
    type Value = T;

    /// Names what was expected in a refusal of any other JSON value.
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    /// Reads the shape from the object's entries.
    ///
    /// # Errors
    ///
    /// Returns the shape's error when the object does not match it.
    fn visit_map<A>(self, map: A) -> Result<T, A::Error>
    where
        A: MapAccess<'de>,
    {
        T::deserialize(MapAccessDeserializer::new(map))
    }
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
                failure.to_string().contains("expected a JSON object"),
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

    #[test]
    fn a_failure_inside_an_object_names_the_line_the_json_reader_was_on() {
        let single = "{\n  \"name\": 1\n}";
        let listed = "[\n  {},\n  { \"name\": 1 }\n]";
        let keyed = "{\n  \"a\": {},\n  \"b\": { \"name\": 1 }\n}";

        let single_failure =
            parse_json_object::<_, Shape>(&mut serde_json::Deserializer::from_str(single))
                .expect_err("a name that is a number");
        let listed_failure =
            parse_json_objects::<_, Shape>(&mut serde_json::Deserializer::from_str(listed))
                .expect_err("a name that is a number");
        let keyed_failure =
            parse_keyed_json_objects::<_, Shape>(&mut serde_json::Deserializer::from_str(keyed))
                .expect_err("a name that is a number");

        assert_eq!(
            [
                single_failure.line(),
                listed_failure.line(),
                keyed_failure.line()
            ],
            [2, 3, 3]
        );
    }
}
