# Comment

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines how comments communicate contracts and reasoning accurately, remain attached to the facts they explain, and preserve any behavior imposed by tools that consume them.

## Definition and scope

A **comment** is source-adjacent text written in a language's comment or documentation form. A **declaration comment** documents a named construct for its callers or consumers. An **implementation comment** explains a local decision, constraint, or relationship that is not clear from the surrounding code. A **tool-consumed comment** contains syntax interpreted by a compiler, analyzer, generator, documentation processor, or other supported tool.

A comment can serve more than one role. Documentation extracted into a public API reference remains declaration documentation; a directive remains a tooling input even if its syntax resembles ordinary prose. Source comments, generated reference text, and comments shipped inside assets can have different audiences and exposure.

The rules apply to repository-maintained comments in source, tests, scripts, tooling, configuration declarations, and templates, including API documentation and embedded examples. Adjacent guides and references remain subject to the existing documentation workflow and construct-specific owners; this chapter applies where they quote, generate, or explain the same comment contract. It does not replace handbook editorial policy, decision records, or the repository exception process.

This chapter does not require a comment on every line, branch, import, local value, or test assertion. It does not introduce a new documentation format, parser, linter, generated site, comment quota, or mandatory example for every declaration. Required coverage and language-specific syntax retain their existing owners. Generated output and third-party material retain their existing exemptions; maintained generators and templates remain in scope.

## Existing rule ownership

Each active standard retains its exact triggers, mandatory requirements, and permitted cases. Comment rules govern how an explanation is constructed and maintained; the owning item standard still determines the contract and documentation a construct requires.

| Concern                                                                                | Authoritative rule or document                                                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| JavaScript and TypeScript declaration coverage, exceptions, placement, style, and tags | [JSDoc Standard](../JSDOC.md)                                                                               |
| Named callable documentation and the narrow inline-callback exception                  | `FUNC-023` and `FUNC-019` in [Function](./FUNCTION.md)                                                      |
| Type meaning, property and variant documentation, assertion proof, and suppressions    | `TYPE-019` and `TYPE-020` in [Type](./TYPE.md)                                                              |
| Authoritative capability documentation and implementation references                   | `IFACE-012` in [Interface](./INTERFACE.md) and `CLASS-036` in [Class](./CLASS.md)                           |
| Constant meaning, units, boundaries, and compatibility                                 | `CONST-010` and `CONST-012` in [Constant](./CONSTANT.md)                                                    |
| Documentation attached to the construct owning an object value's meaning               | `OBJECT-057` in [Object](./OBJECT.md)                                                                       |
| Component contracts and supplemental documentation                                     | `COMP-018` and `COMP-166` in [Component](./COMPONENT.md)                                                    |
| Hook invocation, current results, and later behavior                                   | `HOOK-039` in [Hook](./HOOK.md)                                                                             |
| Directive position, generated authority, module facts, and example entry points        | `MODULE-039`, `MODULE-041`, `MODULE-046`, and `MODULE-047` in [Module and File](./MODULE.md)                |
| Package consumer obligations and supported commands                                    | `PKG-045` and `PKG-047` in [Package and Dependency](./PACKAGE.md)                                           |
| Accurate supported API examples                                                        | `API-047` in [API](./API.md)                                                                                |
| Failure meaning, recovery decisions, and diagnosis limits                              | `ERROR-041` in [Error](./ERROR.md)                                                                          |
| Message meaning and delivery guarantees                                                | `EVENT-045` in [Event and Message](./EVENT.md)                                                              |
| Observable temporal behavior and dependency limits                                     | `ASYNC-045` in [Async Task and Stream](./ASYNC.md)                                                          |
| Consumer ownership, valid lifetime, and release obligations                            | `RESOURCE-044` in [Resource](./RESOURCE.md)                                                                 |
| Supported configuration behavior and migration contracts                               | `CONFIG-048` in [Configuration](./CONFIGURATION.md) and `SCHEMA-056` in [Schema and Migration](./SCHEMA.md) |
| Negative static assertions, test-support documentation, and truthful verification      | `TEST-032`, `TEST-051`, `TEST-052`, and `TEST-055` in [Test and Fixture](./TEST.md)                         |
| Same-change documentation, obsolete code, unfinished work, and approved exceptions     | [Contributing to Lys](../../CONTRIBUTING.md)                                                                |

JSDoc retains its exact coverage, exceptions, and tag rules. An exemption in JSDoc does not cancel a separate documentation requirement in an active item standard. In particular, `FUNC-023`, `TYPE-019`, `IFACE-012`, and `CLASS-036` retain their declaration requirements, including the language-equivalent documentation required outside JavaScript and TypeScript. Comment rules create no new naming, size, callback, testing, or exception allowances.

## Construction process

Before adding or changing a comment:

1. Identify its reader, owning construct, and explanatory or tooling role.
2. Read the declaration, surrounding implementation, and directly affected consumers.
3. Identify applicable documentation requirements and the authoritative contract.
4. Determine which fact remains unclear after meaningful naming, typing, and structure.
5. Place the explanation where the reader makes the affected decision.
6. State the relevant reason, conditions, scope, and limits using established terms.
7. Reference shared authority or supporting evidence without creating a second contract.
8. Check examples, tool interpretation, generated consumers, and exposure where relevant.
9. Update or remove affected comments with the code and validate the actual changed boundary.

## Mandatory rules

### Purpose, correctness, and authority

### COMMENT-001 — Identify the comment's actual role

A comment MUST serve an identifiable reader and purpose permitted by its owning rules, such as a declaration contract, implementation rationale, necessary source reference, navigation aid, required notice, or supported tooling requirement. Its form and placement MUST make that role understandable in context.

A comment consumed by a tool MUST NOT be treated as disposable prose merely because it starts with comment syntax. An ordinary explanation MUST NOT be presented as a machine-enforced restriction when no such enforcement exists.

### COMMENT-002 — Required documentation retains its owner

Required declaration comments MUST satisfy their owning item standard and applicable language documentation rules. A short inline note, test label, external guide, or link alone MUST NOT replace required declaration coverage or required tags.

A comment MUST NOT grant a naming, callback, complexity, construction, or validation exception. An inline callback that requires extraction under `FUNC-019` remains subject to that rule even if an explanatory comment is added.

### COMMENT-003 — Clarify code before explaining avoidable obscurity

A comment MUST NOT compensate for an ambiguous name, invalid model, hidden dependency, mixed responsibility, or missing enforcement required by an active standard. The affected construct MUST first express the contract through its permitted structure.

Comments remain appropriate for domain constraints, external obligations, proofs, and trade-offs that cannot be made clear by names and types alone. Explaining a required precondition does not remove the owner's obligation to enforce it where enforcement is required.

### COMMENT-004 — Explain the non-obvious reason or consequence

An implementation comment MUST add information needed to understand a decision, invariant, ordering constraint, boundary, or consequence. Merely translating the next statement into prose MUST NOT be its only purpose.

A comment that says an operation is deliberately retained, delayed, repeated, or avoided MUST explain the relevant condition and why it matters. Required declaration summaries retain their own purpose and MUST NOT be removed merely because the implementation is short.

### COMMENT-005 — Claims agree with the approved contract

A comment MUST accurately describe the contract, supported behavior, or implementation fact it claims. A desired feature, accidental observation, or unverified assumption MUST NOT be stated as an implemented guarantee.

A disagreement between documentation and implementation MUST be resolved against the approved contract. Rewording a comment to bless a defect MUST NOT silently weaken that contract; an intentional contract change requires the owning change and compatibility process.

### COMMENT-006 — Qualify conditions and observation boundaries

A comment MUST state the conditions and scope needed to interpret a claim correctly. A snapshot, accepted request, completed callback, current process, or single invocation MUST NOT be described as proving a broader lifetime or system-wide result.

Words such as "always", "never", "complete", and "all" MUST apply to an identifiable supported boundary. If a statement depends on successful acquisition, valid input, a particular platform, or an existing owner, that dependency MUST be clear where it changes the meaning.

### COMMENT-007 — Distinguish evidence, assumptions, and plans

Comments MUST distinguish enforced guarantees, supported external obligations, implementation observations, and proposed future behavior. A version-dependent limitation or assumption that materially affects correctness MUST identify its relevant scope and supporting basis.

An acknowledged limitation MUST NOT be disguised as a guarantee by vague wording. Recording it also does not authorize defective behavior or bypass the exception process. Future design belongs in the appropriate proposal or work record, with only necessary present-day context retained beside the code.

### COMMENT-008 — Strong safety claims identify the actual guarantee

A comment claiming safety, atomicity, immutability, idempotency, cancellation, ordering, boundedness, or durability MUST use the meaning owned by the applicable construct standard. The name of a primitive, type, wrapper, or library alone MUST NOT justify the claim.

The explanation MUST identify the relevant owner or enforcement boundary when the guarantee is otherwise ambiguous. A local lock, frozen outer object, settled promise, or cleanup call MUST NOT be described as establishing unrelated guarantees.

### COMMENT-009 — Contract facts have one authoritative home

Comments MUST place shared meaning with the construct that owns it under the active standards, including `OBJECT-057`, `MODULE-046`, and `COMP-166`. A consumer comment MUST NOT become a competing definition of a provider's contract.

When another declaration needs the same fact, it SHOULD reference the authority and explain its own relationship to it. Repeated inventories of fields, defaults, variants, or operation names MUST NOT create independently maintained copies that can disagree.

### COMMENT-010 — Implementation documentation preserves interface authority

Implementation comments MUST retain `IFACE-012` and `CLASS-036`: refer to the shared capability contract and distinguish the mechanism-specific facts permitted by those owners. Required documentation tags may refer to authoritative inputs and results without disappearing.

A comment MUST NOT imply stronger caller preconditions, weaker outcomes, or a different ownership or completion meaning than the implemented interface allows. References to a shared contract MUST identify which contract or operation is being implemented.

### Placement and communication

### COMMENT-011 — Attach the explanation to the decision it explains

An implementation comment MUST be adjacent to the statement, branch, declaration, or cohesive region whose non-obvious behavior it explains. A reader MUST NOT need to infer attachment from distant position or an obsolete section number.

Declaration documentation retains the placement required by its language and owner. Required directives and loader metadata retain `MODULE-039`; moving explanatory text MUST NOT separate a directive from its required location.

### COMMENT-012 — Make the affected scope unambiguous

A comment covering several statements MUST identify the invariant or relationship spanning them. A trailing comment MUST clearly apply to the relevant value or statement and MUST NOT hide a condition that controls a larger operation.

References such as "this", "above", "below", "the first one", or "the other task" MUST have an unambiguous local referent. Where code can be moved independently, use the owning symbol, role, or named condition instead of positional wording.

### COMMENT-013 — Put shared reasoning at the narrowest coherent owner

Reasoning that governs multiple call sites or phases MUST have a discoverable authoritative explanation at their shared owner. Local comments SHOULD identify the connection without copying a long rationale into every participant.

Cross-file constraints MUST identify the participating responsibility and the relationship that must remain valid. A list of file names alone is insufficient when correctness depends on shared authority, initialization order, or a lifetime spanning those files.

### COMMENT-014 — Keep present obligations separate from history

Source comments MUST explain the present contract or decision rather than serve as a chronological change log, review conversation, or abandoned design archive. Historical context MAY remain when it explains a constraint that still affects correct changes.

Durable decision history SHOULD live in the repository's decision records. A comment linking a past incident or decision MUST state the current consequence so that the code remains understandable without reconstructing that history.

### COMMENT-015 — Use exact domain terminology

Comments MUST use the names, states, units, and boundary terms used by the authoritative contract. Distinct concepts such as a canonical key and a runtime instance identifier MUST NOT be given one interchangeable label.

A rename or contract change MUST update affected terminology. Informal labels such as "hack", "magic", or "special case" MUST NOT replace the actual constraint, owner, or condition the reader needs.

### COMMENT-016 — Write for the reader's decision

Explanatory prose SHOULD be concise, direct, and complete enough to guide the relevant reader. It SHOULD emphasize the fact that changes correct use or safe maintenance and omit filler, personal commentary, and repeated syntax.

Short unit labels, recognized markers, and compact local notes need not become paragraphs. Required API summaries and tags retain their language-specific style. Concision MUST NOT remove a condition or qualification needed to keep a statement true.

### COMMENT-017 — Numbers and representations retain their meaning

A comment explaining a quantity, threshold, format, or formula MUST make the relevant unit, counting model, boundary, or representation clear under its authoritative owner. A bare number or unexplained abbreviation MUST NOT conceal a consequential distinction.

Derived values SHOULD be explained through their relationship to the authoritative input rather than copied as a second changing constant. Comments describing examples or historical values MUST make that role clear instead of implying they configure current behavior.

### COMMENT-018 — Formatting supports attachment and readability

Comments MUST follow the local language's supported syntax and repository formatting conventions. Delimiters, indentation, wrapping, tags, and embedded markup MUST preserve the intended attachment and meaning.

Decorative banners or numbered narration MUST NOT substitute for coherent modules and functions. A divider MAY identify an existing cohesive group when it helps navigation; it does not exempt that group from size, responsibility, or file-boundary rules.

### Maintenance markers and tool interpretation

### COMMENT-019 — Comments do not retain dead implementations

Commented-out executable code, obsolete alternatives, and disabled implementation blocks remain prohibited under Contributing to Lys. Source history MUST NOT be recreated by preserving inactive copies in comments.

A clearly labeled explanatory example or counterexample is distinct from abandoned code. It MUST serve a present documentation purpose, identify any intentional omission, and satisfy the applicable example rules.

### COMMENT-020 — Work markers do not authorize unfinished behavior

A task marker, issue link, warning, or explanation MUST NOT authorize a placeholder, missing required behavior, disabled check, or unapproved exception. Existing restrictions on unfinished work remain in force.

Where a work note is permitted by the requested scope and repository workflow, it MUST identify the remaining obligation and a discoverable work record or concrete resolution condition. Completing or removing that obligation MUST update the note. This rule grants no general permission to leave unfinished work.

### COMMENT-021 — Workaround rationale has a bounded lifetime

A comment accompanying a necessary workaround MUST explain the actual constraint, affected scope, and why the chosen behavior is required. When removal depends on a dependency change or external fix, the relevant condition MUST be identifiable.

The comment MUST NOT invent a limitation or imply that a workaround is permanent merely because it already exists. An exception still requires the exact record and approval defined by Contributing to Lys; a local rationale is not that approval.

### COMMENT-022 — Suppression explanations preserve proof requirements

Compiler and lint suppression comments MUST retain the proof and single-expression-or-declaration scope required by `TYPE-020`. A reason, ticket, or tool complaint alone MUST NOT replace that proof or expand the allowed scope.

A comment MUST NOT justify disabling formatting, lint, type, test, security, or build checks to obtain a passing result. An externally imposed constraint that requires an exception follows the repository exception process; this chapter creates no suppression exemption.

### COMMENT-023 — Tool-consumed comments are reviewed as semantic inputs

Before adding, moving, rewriting, or deleting a comment that a supported tool consumes, the change owner MUST identify its consumer, scope, and effect. A textual-only diff MUST NOT be assumed to leave checking, loading, generation, optimization, or publication unchanged.

The marker MUST express only behavior supported by that tool and authorized by the owning standard. Unrecognized prose that resembles a directive MUST NOT be relied on for enforcement, and an explanatory rewrite MUST NOT accidentally create a directive.

### COMMENT-024 — Directive attachment survives edits

A tool-consumed comment MUST remain attached to the intended expression, declaration, file, or generated input under the actual consumer's syntax. Nearby insertions, line wrapping, block conversion, and formatting MUST NOT silently retarget or deactivate it.

Its effect MUST remain as narrow as the owning rule allows. A file-wide directive does not gain permission merely because the tool supports it. Surrounding explanatory prose MUST preserve exact significant syntax where the consumer depends on it.

### COMMENT-025 — Expected diagnostics remain test assertions

Comments used by negative compilation or analysis tests MUST preserve `TEST-032` and any applicable proof or exception requirements. The test MUST detect when the intended diagnostic no longer occurs, rather than accept an unrelated error or suppress the behavior it claims to test.

A negative-test marker MUST NOT be copied into production as a general error bypass. The fixture's intended invalidity and tested boundary MUST remain clear without manufacturing an invalid trusted value in ordinary runtime code.

### COMMENT-026 — Generated comments retain their real source

Generated documentation and comments MUST retain the authority defined by `MODULE-041`. Corrections to generated output MUST flow through its maintained source, generator, or supported input rather than establish an independently edited copy.

Generation markers and required notices MUST accurately identify their source or role. They MUST NOT be added to repository-maintained code to claim an exemption. Existing required notices MUST retain their actual meaning; this chapter does not require new per-file boilerplate.

### References, examples, and exposure

### COMMENT-027 — References resolve to the intended authority

Local paths, symbols, rule identifiers, documentation links, and referenced work records MUST identify the fact they support. A moved or renamed owner MUST update directly affected references.

Use stable symbols, section anchors, or record identifiers where available. A fragile line number SHOULD NOT be the only way to locate a continuing contract. A link that resolves but points to an obsolete or unrelated declaration is not a valid reference.

### COMMENT-028 — External references support the claimed constraint

An external reference used to justify behavior MUST support the specific claim and relevant dependency or platform scope. A general product homepage, unrelated issue, or outdated version note MUST NOT establish a current technical restriction.

When an external constraint changes, the affected rationale and workaround MUST be reconsidered. A link is supporting evidence, not authority to override repository contracts or use an unsupported integration surface.

### COMMENT-029 — Essential reasoning is understandable without opening a link

A comment whose purpose is to explain a non-obvious decision MUST state the relevant local reason and consequence. A bare URL or unexplained issue number MUST NOT be its entire explanation.

The local summary SHOULD remain short and point to detailed evidence. This does not require copying an external document or duplicating the complete authoritative API contract beside every reference.

### COMMENT-030 — Examples use the contract they claim to demonstrate

Comment examples MUST retain `MODULE-047`, `API-047`, and the other applicable construct rules. They MUST use supported entry points and meaningful inputs for the audience they address.

Executable examples, illustrative fragments, internal implementation examples, and intentional counterexamples MUST be distinguishable. An omitted declaration or simplified body MUST NOT make an illustrative fragment look like a complete supported command or working integration.

### COMMENT-031 — Examples preserve consequential obligations

An example MUST expose the input, result, ownership, failure, or lifecycle obligations necessary to understand its stated purpose. Concision MUST NOT teach an unawaited required operation, leaked resource, ignored failure, or unsupported default as correct usage.

Unrelated infrastructure may be omitted when the example is clearly illustrative. Required setup or cleanup affecting the demonstrated contract MUST be present or explicitly identified; it MUST NOT be silently assumed while the example claims to be directly executable.

### COMMENT-032 — Example outcomes and limits remain truthful

An example's expected output, error, ordering, and completion claim MUST match the scenario and boundary it demonstrates. A snippet, snapshot, or source inspection MUST NOT be presented as proof of a stronger external-system guarantee.

Known omissions MUST be stated without weakening the authoritative contract. Documentation for unsupported or planned behavior MUST NOT appear as normal current usage merely because the intended code is shown in a comment.

### COMMENT-033 — Comment contents are safe for their actual audience

Comments and embedded examples MUST follow the repository's sensitive-data rules. They MUST NOT retain credentials, private user contents, actual settings values, or copied production payloads that are unsafe to expose.

An HTML comment, source map, generated reference, or bundled source comment MUST NOT be treated as private storage. Examples MUST use suitable non-sensitive data. Hiding text from the rendered interface does not establish an access boundary.

### COMMENT-034 — Explanations do not manufacture trust

A comment describing input as validated, trusted, escaped, immutable, or authorized MUST point to an actual supported contract or enforcement boundary. The label alone MUST NOT establish that property.

Where the explanation accompanies a proof required by `TYPE-020`, it MUST describe the relationship actually proven and its limits. A comment MUST NOT conceal a missing check, incomplete invariant, or unsupported assumption about an external representation.

### Change review and verification

### COMMENT-035 — Comments change with the facts they describe

A change to a name, contract, representation, algorithm, boundary, or supported environment MUST inspect and update the directly affected comments in the same change. Moving code MUST preserve useful comments and their intended attachment.

Copied comments MUST be checked against the receiving construct. Similar signatures or code shapes MUST NOT be treated as evidence that ownership, side effects, errors, units, and completion semantics are interchangeable.

### COMMENT-036 — Removal accounts for the explanation's remaining purpose

A comment SHOULD be removed when its reason no longer applies or the improved construct fully expresses its information, provided no active owner still requires it. Required documentation, valid proof rationale, and tool-consumed syntax MUST NOT be deleted as generic cleanup.

Before removing a warning or workaround explanation, the change MUST establish whether the underlying constraint has ended or moved to another authoritative home. Obsolete comments MUST NOT remain to contradict the corrected implementation.

### COMMENT-037 — Validate the actual documentation consumer

Changes to parsed documentation syntax, symbol links, directives, templates, or generated comments MUST use relevant repository-supported validation for the affected consumer. Source formatting alone MUST NOT establish successful parsing, extraction, resolution, or generation.

Required tags and declaration attachment MUST be checked against the real signature and language owner. A successful documentation build does not establish semantic accuracy, and a compiler run that excludes the changed source does not validate its directives.

### COMMENT-038 — Verification follows the effect of the change

A purely explanatory edit requires relevant source review, formatting, and reference checks rather than unrelated application execution. When a comment changes tool behavior, generated contracts, selected tests, or emitted behavior, validation MUST cover that effect under its owning standards.

When documentation exposes a discrepancy, the change MUST establish whether it corrects prose or changes the supported contract or implementation. A change MUST NOT avoid required behavioral checks by describing a semantic modification as comment-only.

### COMMENT-039 — Validation records state what the evidence establishes

Comment-related validation reports MUST retain `TEST-051` and `TEST-052`: identify the actual command or procedure, scope, result, and material limitations. A source example or explanatory comment MUST NOT be claimed as an executed test.

If a relevant check cannot run, report the exact reason and the affected unverified boundary. Existing evidence may support a claim within its recorded scope, but MUST NOT be presented as fresh execution.

### COMMENT-040 — Review meaning as well as wording

Review of a comment change MUST assess its accuracy, scope, authoritative owner, attachment, references, and any tool interpretation. Spelling and formatting checks MUST NOT replace that assessment.

A correct explanation does not certify the surrounding implementation as compliant or waive a known defect. Findings and exceptions retain their canonical review processes, and only active rule identifiers may be cited as construction requirements.

## Repository boundary examples

These examples describe comments and nearby source in the current working tree. They illustrate review boundaries; they do not certify full compliance, executed tests, third-party behavior, or platform guarantees. Existing limitations are not exceptions for new or modified code.

| Observed source                                                                                                                   | Comment distinction                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chat registrar explains why it awaits settlement after creating two tasks                                                     | The comment explains a sequencing consequence beyond the final call's syntax. Source ordering can be inspected; full connection lifetime still requires the appropriate boundary evidence.         |
| The shared chat-event declaration describes start, generation, and concurrent title events                                        | The contract belongs with the protocol, while the producer establishes ordering. A schema validating each event's shape does not independently enforce the sequence.                               |
| The desktop stream adapter documents cancellation and reader release on early iteration exit                                      | The nested cleanup structure is observable in source. It does not by itself establish that all remote work terminates when the local reader is cancelled.                                          |
| The Rust spawn helper explains locking before spawning, while the public start contract discloses separate check and spawn phases | A valid local ownership rationale must not be generalized into a guarantee against concurrent starts across the whole operation.                                                                   |
| The uptime formatter names milliseconds, negative-input clamping, and minutes that do not roll into hours                         | Units and intentionally surprising output add information beyond a numeric parameter type. This is not a claim that every possible numeric input has been validated.                               |
| Rail-state comments connect a shared key and value to initialization, the control, and the stylesheet                             | The explanation identifies a cross-file contract. Head placement is visible in configuration; a claim about every rendered first paint needs suitable rendered evidence.                           |
| Record-index comments explain rechecking metadata before publishing complete index rows                                           | A local reason can preserve a seemingly redundant check. The statement about inferred types still needs the applicable compiler evidence when that claim is changed.                               |
| Source includes a checking directive and declaration-file references                                                              | Tool-consumed comment syntax has a different role from ordinary explanation. Its presence alone is not proof that the relevant checker ran.                                                        |
| ESLint documentation and its nearby ignore comment summarize the selected paths differently                                       | Duplicating changing inventories creates a concrete drift risk. Review must reconcile the actual declaration and the affected explanation, rather than count comments as evidence of completeness. |

The relevant sources are the [chat registrar](../../apps/backend/src/modules/chat/chat/index.ts), [chat protocol](../../packages/protocol/src/apis/chat/chatRoute.ts), [desktop stream adapter](../../apps/desktop/src/lib/apis/http/chat.ts), [Rust process owner and spawn path](../../apps/desktop/src-tauri/src/backend.rs), [uptime formatter](../../apps/desktop/src/lib/hooks/backendRuntime.ts), [shared rail contract](../../apps/docs/src/lib/handbook/rail.ts), [rail bootstrap configuration](../../apps/docs/astro.config.mjs), [rail control](../../apps/docs/src/components/handbook/RailCollapseToggle.astro), [rail stylesheet](../../apps/docs/src/styles/global.css), [record-index projection](../../apps/docs/src/lib/handbook/records.ts), [frontmatter declarations](../../apps/docs/src/content.config.ts), [backend declaration reference](../../apps/backend/src/fastify.d.ts), [desktop declaration reference](../../apps/desktop/src/vite-env.d.ts), and [lint configuration](../../eslint.config.ts).

The source illustrations are observations, not a cleanup request or a passing validation record. Suppression and generation rules apply when those constructs occur; this chapter does not claim that every comment category already appears in repository-maintained source.
