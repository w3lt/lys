# Code Construction Rules

This document is the canonical construction manual for repository-owned code. It defines how to create each atomic or important codebase item so that the result is understandable, maintainable, and testable.

The normative rules are language-independent. A construct's rules apply whenever a language or framework provides that construct or an equivalent construct. Language-specific examples illustrate a rule but do not define or limit it.

## Normative language

- **MUST** and **MUST NOT** define mandatory requirements.
- **SHOULD** defines the expected default. A different choice requires a concrete technical reason.
- **MAY** identifies an allowed option.

Each rule has a stable identifier so reviews and future automation can reference it without paraphrasing it.

## SOLID construction framework

SOLID principles apply through concrete construction rules rather than general slogans:

- **Single Responsibility Principle (SRP):** A construct owns one domain responsibility and has one category of reason to change.
- **Open/Closed Principle (OCP):** A declared extension axis accepts new implementations through composition or a stable contract without modifying the coordinating policy.
- **Liskov Substitution Principle (LSP):** Every implementation honors the complete observable contract of the abstraction it implements.
- **Interface Segregation Principle (ISP):** A consumer depends only on the capability it uses.
- **Dependency Inversion Principle (DIP):** High-level policy depends on domain-facing abstractions rather than low-level mechanisms.

SOLID MUST NOT be used to justify speculative interfaces, wrappers, inheritance, strategies, or extension points. Each item chapter defines the observable conditions under which a principle applies.

## How to use these standards

For every code change:

1. Read this shared foundation.
2. Open the item standard for every construct being added or modified.
3. Apply every triggered rule in those item standards.
4. Use rule IDs when documenting a failure, exception, or review decision.
5. Load additional concern standards when an item standard links to them.

Rules are owned by exactly one file. Item files may reference another rule by ID but MUST NOT redefine it. Language-specific examples illustrate the language-independent requirement in their containing rule.

## Item standards

| Item      | Standard                                   | Rule prefix |
| --------- | ------------------------------------------ | ----------- |
| Variable  | [Variable](./code_standards/VARIABLE.md)   | `VAR`       |
| Constant  | [Constant](./code_standards/CONSTANT.md)   | `CONST`     |
| Function  | [Function](./code_standards/FUNCTION.md)   | `FUNC`      |
| Type      | [Type](./code_standards/TYPE.md)           | `TYPE`      |
| Interface | [Interface](./code_standards/INTERFACE.md) | `IFACE`     |
| Class     | [Class](./code_standards/CLASS.md)         | `CLASS`     |
| Object    | [Object](./code_standards/OBJECT.md)       | `OBJECT`    |
| Component | [Component](./code_standards/COMPONENT.md) | `COMP`      |

The index grows only when an item's rules have been reviewed, approved, and written. Missing item standards do not waive applicable rules already defined by an approved standard.

## Deferred item standards

The following item chapters are registered but intentionally deferred. A planned path is not an active standard and the file MUST NOT be created as an empty placeholder.

| Item                 | Planned standard                       | Planned prefix | Status          |
| -------------------- | -------------------------------------- | -------------- | --------------- |
| Module / file        | `docs/code_standards/MODULE.md`        | `MODULE`       | TODO — deferred |
| Package / dependency | `docs/code_standards/PACKAGE.md`       | `PKG`          | TODO — deferred |
| Hook                 | `docs/code_standards/HOOK.md`          | `HOOK`         | TODO — deferred |
| API                  | `docs/code_standards/API.md`           | `API`          | TODO — deferred |
| Error                | `docs/code_standards/ERROR.md`         | `ERROR`        | TODO — deferred |
| Event / message      | `docs/code_standards/EVENT.md`         | `EVENT`        | TODO — deferred |
| Async task / stream  | `docs/code_standards/ASYNC.md`         | `ASYNC`        | TODO — deferred |
| Resource             | `docs/code_standards/RESOURCE.md`      | `RESOURCE`     | TODO — deferred |
| Configuration        | `docs/code_standards/CONFIGURATION.md` | `CONFIG`       | TODO — deferred |
| Schema / migration   | `docs/code_standards/SCHEMA.md`        | `SCHEMA`       | TODO — deferred |
| Test / fixture       | `docs/code_standards/TEST.md`          | `TEST`         | TODO — deferred |
| Comment              | `docs/code_standards/COMMENT.md`       | `COMMENT`      | TODO — deferred |

Deferred means that the dedicated chapter has not yet been written or approved. It does not waive this foundation, an applicable active item standard, `CONTRIBUTING.md`, existing repository conventions, or ordinary maintainability requirements.

Developers and agents MUST NOT cite a planned prefix as an active rule, invent requirements on behalf of a deferred chapter, or treat the missing chapter as permission for unclear or unmaintainable code.

To activate a deferred standard:

1. Draft and review its complete rules.
2. Obtain explicit approval.
3. Create the planned item file with stable rule identifiers.
4. Move the item into the active Item standards table.
5. Validate every new reference and link.

## Finding a rule

Search by stable rule ID or title:

```sh
rg -n '^(### [A-Z]+-[0-9]{3}|# )' docs/code_standards
```
