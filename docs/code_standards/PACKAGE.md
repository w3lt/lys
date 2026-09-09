# Package and Dependency

This item standard is governed by the shared [Code Construction Rules](../CODE_STANDARDS.md).

This chapter defines the construction rules for repository-owned packages and their dependencies.

## Definition and scope

A **package** is a named unit that an ecosystem or repository toolchain resolves, builds, installs, distributes, or consumes under an identifiable contract. It can be an application, a reusable library, a source-consumed workspace unit, a native artifact, or development tooling. A package may contain several cohesive logical modules.

A **workspace root** coordinates packages and shared tooling. A root that owns only workspace configuration and development commands does not need a runtime entry point or a distributable library surface.

A **package dependency** is code, declarations, assets, tooling, or another artifact required to construct, validate, install, or use a package. A **runtime prerequisite** is an external executable, system facility, service, or host capability required by its supported operation. Both belong in the package's dependency assessment, even when only the first appears in its language manifest.

A **direct dependency** is consumed by repository-maintained source, declarations, assets, configuration, scripts, or generated output. A **transitive dependency** is required by another dependency without being directly consumed by the repository package. Importing a transitive package directly makes that use a direct requirement.

A **manifest** declares package identity, intended dependency constraints, entry points, scripts, features, and other ecosystem metadata. A **resolution record**, usually a lockfile, records the selected dependency graph for a particular supported installation. Declared constraints and selected versions are different contracts.

A **consumer artifact** is what the supported consumer actually receives: workspace source, generated declarations, compiled code, a registry archive, a native binary, an application bundle, or a static site. The development checkout is not automatically the consumer artifact.

Dependency stage and provisioning are separate dimensions. A dependency may be needed during build, verification, installation, or execution, and may be directly installed, supplied by a host or peer, bundled, optional, or selected for a target. These descriptions are not mutually exclusive categories.

This chapter governs package boundaries, manifests, dependency selection and resolution, installation trust, build inputs, artifact contents, compatibility, and verification. It does not prescribe a registry, package manager, versioning system, universal directory layout, public release process, or separate build command for every package.

Runtime collaboration between objects remains governed by the Function, Interface, and Class chapters. API interaction contracts are governed by [API](./API.md). Resource ownership and release are governed by [Resource](./RESOURCE.md). Configuration contracts are governed by [Configuration](./CONFIGURATION.md). Schema contracts and migrations are governed by [Schema and Migration](./SCHEMA.md). Tests and fixtures are governed by [Test and Fixture](./TEST.md).

## Existing rule ownership

Package rules add requirements at installation, build, resolution, and distribution boundaries. Existing construct rules retain their triggers and permitted cases.

| Concern                                                                                        | Authoritative rule or document                                                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Demonstrated dependency need, evaluation criteria, compatibility approval, and change workflow | [Contributing to Lys](../../CONTRIBUTING.md)                                                          |
| Module cohesion and extraction                                                                 | `MODULE-001` through `MODULE-006` in [Module and File](./MODULE.md)                                   |
| Supported surfaces, private access, and public signatures                                      | `MODULE-008` through `MODULE-015` in [Module and File](./MODULE.md)                                   |
| Import graphs, ownership direction, and contract placement                                     | `MODULE-016` through `MODULE-022` in [Module and File](./MODULE.md)                                   |
| Resolution, identity, loading, environments, and assets                                        | `MODULE-023` through `MODULE-037` in [Module and File](./MODULE.md)                                   |
| Generated authority, compatibility paths, and boundary documentation                           | `MODULE-041` through `MODULE-047` in [Module and File](./MODULE.md)                                   |
| Module graph, consumer, and loading checks                                                     | `MODULE-048` through `MODULE-050` in [Module and File](./MODULE.md)                                   |
| Narrow dependencies and meaningful wrappers                                                    | `FUNC-012`, `FUNC-021` in [Function](./FUNCTION.md)                                                   |
| Capability eligibility, ownership, injection, compatibility, and conformance tests             | `IFACE-003`, `IFACE-004`, `IFACE-024`, `IFACE-030` through `IFACE-032` in [Interface](./INTERFACE.md) |
| Concrete collaborators and external class adaptation                                           | `CLASS-008`, `CLASS-030` in [Class](./CLASS.md)                                                       |
| Domain types and external object forms                                                         | `TYPE-024` in [Type](./TYPE.md); `OBJECT-061` in [Object](./OBJECT.md)                                |
| External UI integration and supported vendor contracts                                         | `COMP-141` through `COMP-154` in [Component](./COMPONENT.md)                                          |
| Persisted representation versions                                                              | `OBJECT-045` in [Object](./OBJECT.md)                                                                 |
| Declaration documentation                                                                      | [JSDoc Standard](../JSDOC.md)                                                                         |

This chapter does not require an adapter around every dependency. Existing interface, function, class, and component rules decide when direct use or adaptation is appropriate. A package version change cannot waive an underlying compatibility rule.

## Construction process

Before creating a package or changing its dependencies:

1. Identify the package's purpose, owner, consumer group, and source or artifact delivery contract.
2. Establish whether the change belongs in an existing package or requires a real package boundary.
3. Trace direct uses through source, types, assets, configuration, scripts, generation, and runtime prerequisites.
4. Determine when each dependency is required and who supplies it to that consumer.
5. Inspect the relevant manifest, workspace configuration, selected resolution, and affected consumers.
6. Evaluate a new dependency under Contributing to Lys and preserve applicable adapter boundaries.
7. Identify changes to source trust, installation execution, enabled features, native targets, and permissions.
8. Define compatible version constraints, toolchain requirements, and the intended resolved graph.
9. Identify the actual consumer artifact and verify that its metadata and contents agree.
10. Validate the affected installation, build, consumer, and behavioral paths; record limitations precisely.

## Mandatory rules

### Package boundary and identity

### PKG-001 — A package has a coherent delivery contract

A package MUST have an identifiable purpose, owner, consumer group, and unit of consumption or delivery.

Its modules MUST belong together because they provide that contract, share a justified build or delivery boundary, or form one cohesive application or tooling unit. Sharing a language, framework, author, or repository directory is insufficient by itself.

A package MAY contain multiple logical modules. Their individual cohesion remains governed by `MODULE-001` through `MODULE-006`; package cohesion does not require one function, capability, or layer per package.

### PKG-002 — A new package requires a current package-level need

A package MAY be extracted or introduced only when a current requirement needs at least one of:

- Consumption by an independently owned application, package, or tool.
- A distinct build target, runtime, native toolchain, or installation boundary.
- A supported distribution or release boundary.
- Isolation of dependencies that cannot appropriately belong to the existing consumer artifact.
- An ecosystem-required workspace or tooling unit.

Anticipated reuse, naming symmetry, file length, or a desire to create more layers is insufficient. A logical module may remain inside its existing package when a package boundary adds no delivery or dependency contract.

### PKG-003 — Requirements follow the package's actual role

A package's declared role MUST distinguish application execution, library consumption, workspace source consumption, and development tooling where their obligations differ.

A workspace coordinator does not require a runtime API. A source-consumed package does not require a redundant compilation step. An application does not require registry publication. A private library still requires a usable consumer contract.

The role MUST follow actual scripts, consumers, metadata, and artifacts rather than the directory name or a conventional script name alone.

### PKG-004 — Identity and publication intent are explicit

A package MUST have one authoritative ecosystem identity, with an unambiguous name or coordinate in each registry or workspace where it is resolved.

Its publication intent MUST be identifiable. Where the ecosystem provides a publication-prevention setting, a package not intended for that publication path MUST use it or be covered by an explicit repository-level restriction that prevents accidental publication.

A version field, an absent private flag, or a successful package build does not establish approval to publish. Native library names, executable names, application identifiers, and registry names may differ when their mapping is deliberate and compatible.

### PKG-005 — Manifest metadata describes the supported surface

Package entry metadata, visibility configuration, command mappings, and asset declarations MUST agree with the supported module surface under `MODULE-008` through `MODULE-015`.

A declared entry point MUST exist in the artifact where the consumer resolves it. Metadata MUST NOT point to an unpublished source file, stale build output, a developer's absolute path, or a different implementation from the one validated.

An explicit export map is required only when the ecosystem or intended boundary needs it. Its absence does not make every physically reachable file a supported API.

### PKG-006 — Supported environments have an authoritative definition

A package MUST identify the runtime, toolchain, and target requirements needed by its current supported consumers.

For an application or native artifact, this includes relevant operating-system facilities, architecture, executable prerequisites, and external runtime services. For a source-consumed library, it includes the consumer's required language and transformation capabilities.

Requirements MAY live in shared repository configuration or canonical environment documentation when that authority clearly covers the package. A package MUST NOT claim support for every platform or runtime merely because no restriction is recorded.

### Dependency declarations and provisioning

### PKG-007 — Direct requirements are declared by an accountable owner

Every directly consumed package dependency MUST have an authoritative declaration in the consuming package or an explicit shared-tooling arrangement under `PKG-008`.

Consumers MUST NOT rely on incidental hoisting, a sibling's dependency, an undeclared global executable, a developer's machine, or a transitive dependency happening to be installed.

Declaration requirements include packages referenced by static types, stylesheets, configuration, scripts, code generation, and emitted artifacts. Built-in runtime facilities and separately provisioned system services use the prerequisite contract under `PKG-006`; they need not be invented as registry dependencies.

### PKG-008 — Shared workspace tooling has one clear provider

Common development tools MAY be declared at the workspace root when the supported workspace setup deliberately supplies them to the packages that use them.

The tool owner, supported invocation, version authority, and applicable consumer set MUST be identifiable from repository scripts, configuration, or documentation. Merely being executable from one developer's checkout is insufficient.

An independently consumed package MUST NOT require an unrelated workspace root to supply an undeclared runtime, build, or type dependency. Tooling that belongs only to the repository's own validation environment need not be duplicated in every private member manifest.

### PKG-009 — Classification follows stage and consumer

A dependency MUST be classified according to when it is actually needed and how the consuming environment obtains it.

The assessment MUST distinguish build, verification, installation, execution, and downstream type-checking requirements when they differ. Peer provisioning, optional selection, and platform selection are additional constraints rather than substitutes for that assessment.

A package name, existing manifest section, or type-only import alone does not establish the classification. A generator may also supply runtime assets; a source-consumed package may need transformation tools in its consumer's build.

### PKG-010 — Required execution dependencies survive deployment

Every dependency required by a supported installed or deployed artifact MUST be bundled, installed through its declared dependency graph, or supplied through an explicit host prerequisite.

A dependency needed during execution MUST NOT be available only because development installed test or build tooling. Conversely, tools used only to construct the artifact MUST NOT be represented as execution prerequisites without a real runtime use.

The deployment's installation mode and bundling behavior determine availability. Manifest section names do not prove what is present in a shipped artifact.

### PKG-011 — Downstream type requirements remain available

When consumers require a dependency to resolve shipped declarations or compile supplied source, the package MUST arrange for that dependency to be available through its supported consumer installation contract.

A declaration-only use MUST NOT automatically be assigned to a producer-only development category. Peer or host-provided types are permitted when the consumer is explicitly responsible for satisfying that requirement.

Private type-checking tools that leave no consumer requirement may remain producer development dependencies. Usability of public signatures remains governed by `MODULE-013`.

### PKG-012 — Host and peer dependencies define compatibility obligations

A host- or peer-supplied package dependency MUST identify who supplies it, the supported compatibility range, and whether shared runtime identity is required.

The producer's development installation MUST NOT be treated as proof that an independently installed consumer satisfies those obligations. Automatic peer installation by a package manager does not itself verify compatibility.

An optional peer MUST follow the absence rules in `PKG-013`. A peer relationship MUST NOT be used merely to transfer an ordinary private implementation dependency to every consumer without a host-integration reason.

### PKG-013 — Optionality has an exact selection and absence contract

An optional dependency MUST mean either:

- A declared capability may be unavailable when the dependency is absent.
- A target or feature selects another supported implementation instead.

The package MUST define which case applies and ensure that a selected supported path has every dependency it requires. A platform-specific optional binary can be required on the platform that selects it.

Absence MUST produce the declared capability state, alternative, or explicit failure. It MUST NOT cause fabricated success or make a required feature silently disappear. Marking a dependency optional MUST NOT merely hide an installation failure.

### PKG-014 — Features select complete dependency sets

Enabled features, extras, plugins, or equivalent package options MUST have an identified purpose and the dependency set required to implement that purpose.

Defaults and supported combinations MUST be explicit where they affect consumer behavior, availability, or installation cost. A change MUST account for feature unification or combined selection when the ecosystem can activate features through multiple consumers.

Code MUST NOT depend on an unrelated consumer enabling a required feature. Unsupported combinations MUST be rejected or excluded by the declared contract rather than accepted with incomplete behavior.

### PKG-015 — Native dependencies distinguish build host from target

Native bindings, build helpers, system libraries, and executable dependencies MUST distinguish the machine performing the build from the platform that executes the result.

Relevant compiler, ABI, architecture, operating-system, and linked-library requirements MUST be compatible across that boundary. Required platform-selected packages and companion bindings MUST be included in the supported target's dependency closure.

A successful build on one host MUST NOT be presented as verification of another target. No requirement to support additional platforms follows from this rule.

### PKG-016 — Package dependency graphs have explicit phases

Package analysis MUST include installation, production build, execution, and verification relationships as distinct graphs where their meaning differs.

Independently produced package artifacts MUST have an acyclic production build prerequisite graph. They MUST NOT require a previously built copy of one another to bootstrap an undocumented cycle. Packages with inseparable compilation may use an explicit supported joint build unit instead of claiming independent builds.

A verification fixture may consume the built package it tests without becoming a prerequisite of that package's production artifact. Root task aggregation and workspace membership are not reverse dependencies by themselves.

Runtime and type ownership direction remain governed by `MODULE-016` through `MODULE-022`. Changing a manifest category or adding a test-only edge does not waive those rules.

### Dependency selection and trust

### PKG-017 — Adoption decisions are reviewable

For a new dependency or a materially changed use, the change MUST contain enough evidence to assess the dependency-evaluation requirements in Contributing to Lys.

Evidence MUST identify the required capability, intended uses, and why the selected dependency fits the existing package and integration boundary. Existing configuration, the change description, and focused measurements may supply that evidence; a separate document for every dependency is not required.

The decision MUST NOT be justified solely by popularity, familiarity, a passing install, or the fact that the dependency already appears transitively. This chapter adds no separate approval ceremony to the repository's normal contribution workflow.

### PKG-018 — Integration uses supported external contracts

Repository integration MUST use the dependency's supported entry points, APIs, configuration, and artifact formats for the selected version.

Private package internals, installed-file edits, unsupported runtime probing, and accidental generated layout MUST NOT become integration contracts. An unavoidable unsupported integration requires the existing exception process; a reproducible maintained patch is governed separately by `PKG-031`.

Adapter eligibility remains owned by `FUNC-012`, `FUNC-021`, `IFACE-003`, `IFACE-004`, `CLASS-008`, and the applicable external-construct rules. UI integration MUST preserve the specific permissions and requirements in `COMP-141` through `COMP-154`.

### PKG-019 — Resolved sources have verifiable identities

A dependency's declared name, source, selected version or revision, and integrity metadata MUST identify the intended artifact through the ecosystem's supported resolution mechanism.

Changes to registry origin, source repository, package alias, remote archive, or local-path source MUST be reviewed as source changes even when an apparent version number stays the same.

A remote branch, mutable tag, or download URL is insufficient as the sole identity of a retained reproducible resolution. Where such a selector is supported, the resolution record MUST retain the selected immutable revision or verified content identity. Local workspace source is identified by the repository state being built.

### PKG-020 — Installation and build execution are part of dependency trust

Adopting or updating a dependency MUST account for install hooks, build scripts, native compilation, executable downloads, and other code that runs before application execution.

The assessment MUST identify newly introduced or materially changed execution, its purpose, and any required network, filesystem, environment, or process access. A development-only classification does not make arbitrary execution trustworthy.

Execution permission MUST remain as narrow as the supported package-manager or build policy allows. A broad allow-all setting MUST NOT replace a missing decision about a specific dependency's required script.

### PKG-021 — Dependency trust exceptions remain specific

A change to build-script permissions, release-age exclusions, source allowlists, integrity checks, or another dependency trust control MUST state the exact affected dependency or source, the technical reason, and the remaining risk.

An exception MUST NOT expand to unrelated packages or future versions without evidence that the same reason applies. Temporary exceptions MUST have a removal condition; permanent ones require a stated continuing constraint.

If the change excepts an active rule or weakens a required check, it MUST follow Contributing to Lys. A resolver setting or successful installation does not grant that exception implicitly.

### PKG-022 — Known dependency findings receive an explicit disposition

Relevant security, integrity, maintenance, and compatibility findings from required checks or the dependency change review MUST be investigated and resolved or recorded with their affected scope, evidence, and disposition.

A finding MUST NOT be suppressed merely to make a check pass. An accepted unresolved risk MUST follow the existing review and exception requirements where applicable, and identify its mitigation or follow-up owner.

A scanner result is evidence, not a complete verdict: reachability, build-time execution, distributed contents, and the supported environment matter. No universal requirement to install the newest release or achieve an arbitrary zero-warning report follows from this rule.

### PKG-023 — Distribution preserves applicable third-party obligations

The package's intended use and distribution MUST be assessed against applicable third-party licensing and attribution requirements under Contributing to Lys.

Required notices and other distribution material MUST accompany the artifact when its dependencies, copied source, fonts, images, binaries, or other assets require them. Build-time or bundled use does not by itself establish that no obligation applies.

An unresolved requirement that could change permitted use or distribution MUST be resolved through the appropriate repository review before that distribution. The package's own license field MUST NOT be treated as a license for all included third-party material.

### PKG-024 — Dependency cost is assessed at the consuming artifact

Dependency evaluation MUST consider the relevant direct and transitive installation, build, runtime, and distribution costs required by Contributing to Lys.

When a change affects a performance, size, startup, or resource requirement, evidence MUST address the actual consumer artifact and enabled features. The size of one source import or the count of direct manifest entries is not sufficient evidence of shipped cost.

Packages MUST NOT add overlapping implementations of the same capability without a concrete reason. Distinct requirements, compatibility, or isolated target environments may justify coexistence; there is no arbitrary maximum dependency count.

### Versions and reproducible resolution

### PKG-025 — Version constraints describe supported compatibility

A dependency constraint MUST include the versions the package intends to support and exclude known incompatible versions relevant to its use.

The lower bound MUST provide the APIs, assets, types, and behavior actually required. Broad ranges MUST NOT conceal a known incompatibility, while exact pins MUST NOT be used as a substitute for understanding an integration contract.

Exact versions, bounded ranges, workspace references, and immutable source revisions are permitted when appropriate to the ecosystem and package role. Moving selectors such as a latest-release label MUST NOT be the only retained resolution for a reproducible application build.

### PKG-026 — Declared constraints and selected versions remain distinct

Manifests MUST express intended dependency constraints; the supported resolution record MUST identify the selected graph used to validate and reproduce the applicable installation.

Repository application and workspace builds MUST retain their authoritative resolution records in version control when supported by the ecosystem. Those records MUST include the relevant source and integrity information the resolver provides.

A library producer's lockfile does not constrain an independently resolving consumer by itself. Consumer compatibility MUST be expressed in the package contract and validated under the applicable checks below.

### PKG-027 — Resolution changes use the owning tools

A dependency change MUST keep manifests, workspace settings, resolution records, and maintained patches coherent through the supported toolchain.

Resolver-owned entries MUST NOT be hand-constructed, assigned invented integrity values, or edited to make a declaration appear resolved. Conflict resolution MUST produce a graph verified by the resolver rather than merely syntactically valid lockfile text.

Unrelated resolution churn MUST be avoided. Necessary transitive, peer, target, or tool-format changes MUST be inspected and explained as consequences of the intended update.

### PKG-028 — Toolchain requirements have one authority

Package-manager, runtime, compiler, and build-tool requirements MUST be consistent across the authoritative version declarations, relevant package metadata, automation, and setup documentation.

Shared toolchain requirements MAY be owned by the workspace. A package-specific minimum or constraint MUST be declared when it differs and must be compatible with every supported consumer that uses that package.

Changing a tool version or resolution format MUST NOT silently reinterpret an unchanged manifest under incompatible defaults. Update and validate the affected installation and build contracts together.

### PKG-029 — Verification does not silently refresh the dependency graph

Normal validation and release builds MUST consume the intended retained resolution without silently selecting newer dependencies or rewriting its record.

Use the ecosystem's locked, frozen, or equivalent consistent-resolution mode when available. An intentional dependency refresh is a separate explicit change whose resulting graph is reviewed under `PKG-027`.

A compatibility probe MAY deliberately resolve an isolated consumer under different supported constraints. It MUST record the tested versions and configuration, leave the authoritative application or workspace resolution unchanged, and supplement rather than replace checks of that retained resolution.

A supported fresh-install path MUST not require a developer's pre-existing dependency cache or mutable installation state. A verified cache may accelerate that path but MUST NOT supply a missing declaration or unrecorded artifact.

### PKG-030 — Version coexistence preserves identity contracts

Multiple versions of one dependency MAY coexist when their consumer contracts and runtime identities remain independent.

When interoperability requires a single host, shared registry, renderer, nominal type, or other identity-sensitive value, the package graph MUST supply compatible instances and preserve `MODULE-026`.

Forced deduplication MUST NOT cross incompatible version or peer contracts merely to reduce the lockfile. Conversely, adding another copy MUST NOT conceal an unresolved shared-identity conflict.

### PKG-031 — Overrides and patches have narrow ownership

A dependency override, alias used for replacement, maintained patch, or equivalent resolution correction MUST identify:

- The exact affected source and dependency scope.
- The observed defect or constraint and supporting evidence.
- Why the ordinary supported version selection is insufficient.
- The expected compatibility impact and verification.
- The removal condition or permanent maintenance responsibility.

The correction MUST be reproducible from repository-owned inputs and apply to the intended dependency identity. Installed directories and local caches MUST NOT contain the only copy of the fix.

An override MUST NOT claim support for an incompatible transitive or peer contract without resolving and validating that incompatibility. Active-rule exceptions still follow Contributing to Lys.

### PKG-032 — Updates preserve one reviewable purpose

A dependency update MUST have a clear intended outcome, such as a required capability, defect correction, security remediation, or supported toolchain transition.

Related packages MAY change together when compatibility requires it. Unrelated upgrades, broad constraint rewrites, and opportunistic deduplication MUST NOT be mixed into the change merely because the resolver permits them.

The update MUST inspect relevant upstream changes and the resulting dependency graph, then update affected integrations, constraints, patches, and documentation together. Passing compilation does not establish unchanged runtime or installation behavior.

### Build and artifact boundaries

### PKG-033 — Build inputs and prerequisites are explicit

A package build MUST obtain its source, generation inputs, required tools, dependencies, and relevant environment inputs through the supported package or workspace contract.

It MUST NOT depend on undeclared files outside that boundary, a developer's current working directory, stale sibling build output, or unrecorded machine state.

Build-time secrets and signing credentials, where an authorized build requires them, MUST be supplied through the supported secret mechanism and excluded from emitted artifacts and logs. Their values MUST NOT become manifest, lockfile, source, or documentation content.

### PKG-034 — Build outputs correspond to the declared target

A build operation MUST identify the artifact it produces and report failure when required production, transformation, generation, or packaging steps fail.

Its result MUST correspond to the source, dependency resolution, target, and build options being validated. A stale output directory or a partial artifact MUST NOT stand in for a successful current build.

A package without a separate build step MUST identify the source artifact consumed directly under `PKG-035`; it MUST NOT add a no-op build script merely to satisfy naming symmetry.

### PKG-035 — Source-consumed packages declare the consumer contract

A package MAY deliberately supply source when its supported consumers can resolve, transform, and execute or type-check that source as required.

Its entry metadata, source language, module format, dependencies, generation requirements, and assets MUST agree with that delivery choice. Producer-only setup MUST NOT be silently required in an independent consumer.

Private workspace source consumption does not imply registry readiness. When external source distribution is intended, its artifact and prerequisite checks MUST exercise an independently installed consumer rather than rely only on workspace links.

### PKG-036 — Compiled code and declarations describe the same implementation

When a package emits executable code and declarations, they MUST have a consistent runtime export contract and derive from the same authoritative source and build configuration.

Declarations MUST NOT promise runtime exports absent from the executable artifact. Type-only exports MAY intentionally have no executable representation. Runtime entry points MUST NOT resolve to a different implementation than their declarations, and conditional output formats MUST preserve the promised consumer contract.

Generated declarations and bindings remain governed by `MODULE-041`, including when distributed separately.

### PKG-037 — Artifact contents are deliberate and complete

A distributed artifact MUST contain the files required by its declared consumer contract, including applicable runtime code, source, declarations, assets, executable metadata, native companions, and required notices.

It MUST exclude credentials, private configuration, user data, local caches, and unrelated development artifacts. Source maps, source archives, and bundled fixtures require deliberate inclusion based on the delivery contract rather than accidental directory capture.

Use the ecosystem's supported inclusion or exclusion mechanism and inspect the resulting file inventory. A correct checkout is not proof that a registry archive, application bundle, or static site contains the right files.

### PKG-038 — Bundled and external requirements are accounted for separately

Packaging MUST distinguish included dependency code from dependencies and prerequisites supplied after installation.

An externalized dependency, host executable, system library, or service MUST remain declared and available under the delivery contract. The package MUST NOT succeed only because the build machine supplies it through the development checkout.

Bundling MUST preserve required assets, native companions, identity, notices, and loading behavior. Removing dependency metadata is valid only when the consumer no longer needs it for any supported use, including declarations and source consumption.

### PKG-039 — Package scripts have explicit scope and effects

A maintained package script or build hook MUST have one named operation, a supported invocation context, and identifiable effects on files, processes, and external systems.

Installation or preparation MUST NOT silently publish, deploy, mutate unrelated projects, or require application production credentials merely to make a package available. Repeated supported invocation MUST not depend on undocumented prior manual steps.

Network downloads or native preparation required by the package MUST be part of the declared installation/build contract and preserve the source identity requirements of `PKG-019`. Operation completion, failure, and cleanup remain governed by the Function and Class chapters.

### PKG-040 — Build caches cannot change the package contract

A reused build result MUST match the source, relevant dependencies, toolchain, target, and options that determine its observable artifact.

A cache MUST NOT hide a missing generation input, select a different dependency resolution, or let one target reuse an incompatible native artifact from another.

When a build or packaging change depends on invalidation behavior, validation MUST include the relevant cache transition or a clean build. A package need not introduce caching merely to satisfy this rule.

### Compatibility and lifecycle

### PKG-041 — Package compatibility includes installation and consumption

A package change MUST assess compatibility beyond exported function signatures, including applicable:

- Identity, supported entry points, and artifact formats.
- Runtime, toolchain, platform, and system prerequisites.
- Dependency constraints, peer requirements, features, and optional availability.
- Installation/build scripts and required permissions or network access.
- Supplied declarations, source, assets, binaries, and native interfaces.

Module-visible compatibility remains owned by `MODULE-043` through `MODULE-045`. A change to dependency placement or bundled contents is not automatically internal simply because source imports still compile.

### PKG-042 — Versioning describes compatibility rather than authorizing it

A package that is independently versioned or distributed MUST follow an identified versioning policy, and its version and release information MUST describe the actual compatibility change.

A version bump MUST NOT substitute for the approval, migration, and construct requirements in Contributing to Lys and the active standards. In particular, published capability changes remain governed by `IFACE-031`.

Package versions, application release identifiers, and persisted or wire representation versions have distinct owners. They MUST NOT be assumed interchangeable; serialized representation versioning remains governed by `OBJECT-045` where applicable.

Private packages released only through one application or workspace revision need not invent independent releases. Their affected consumers still require coordinated validation.

### PKG-043 — Package moves and replacements preserve consumer transitions

A package rename, split, merge, source-origin change, or dependency replacement MUST identify the consumers and artifacts that resolve the old contract.

The change MUST update their declarations, resolution records, import surfaces, build prerequisites, and documentation coherently. Independently distributed consumers require the approved compatibility or migration path; workspace source consumers may migrate atomically when that is their actual delivery contract.

Compatibility forwarding follows `MODULE-045`. A replacement package name MUST NOT silently redirect consumers to different behavior or trust provenance.

### PKG-044 — Released artifacts are traceable to the validated result

An artifact prepared for release MUST be traceable to its authoritative source, intended dependency resolution, toolchain, target, and relevant build options through the supported release process.

The artifact delivered MUST be the validated result or a reproducible equivalent verified after any subsequent transformation, signing, or packaging step. A published version or immutable release identifier MUST NOT be reused for silently different contents.

Registry publication, deployment, signing, and upload remain actions of the authorized release workflow. A successful build or package validation does not itself authorize them or require creation of a new release pipeline.

### PKG-045 — Package documentation states non-obvious consumer obligations

A package MUST document obligations that its consumers cannot determine from authoritative metadata, including source transformation, shared tooling, host provisioning, optional capabilities, supported feature combinations, native prerequisites, and any required build or install ordering.

The documentation MUST distinguish current supported delivery from planned distribution or unverified platforms. A development launcher MUST NOT be presented as an installer or proof of a self-contained release.

Dependency decisions, patches, and trust exceptions MAY be documented with the corresponding configuration or change record when that gives them one discoverable authority. Declaration comments remain governed by JSDoc and `MODULE-046`.

### PKG-046 — Removal accounts for every consumption path

Removing a dependency or package MUST account for uses in source, types, assets, scripts, configuration, generated output, native linkage, runtime discovery, and independent consumer contracts.

The change MUST remove obsolete declarations, resolution entries through their owning tool, patches, trust exceptions, generated inputs, and documentation when no supported use remains. Shared dependency instances and compatibility paths still required elsewhere MUST remain intact.

The absence of static imports is insufficient evidence of non-use. A package used only for a stylesheet, generator, executable, or type declaration is still a direct dependency when that path is required.

### Verification

### PKG-047 — Validation follows the changed package contract

Validation MUST cover the installation, build, consumer, and behavior boundaries actually affected by the change, using the smallest reliable checks first under Contributing to Lys.

A package may be validated by its supported application or workspace consumers. It MUST NOT add empty test scripts, duplicate suites, or synthetic build commands simply to make every manifest look alike.

Commands MUST come from the repository's current scripts and supported tooling. Documentation that names a nonexistent command is not evidence that validation ran.

### PKG-048 — Installation checks detect undeclared availability

When dependency declarations, resolution, installation scripts, or consumer provisioning change, validation MUST exercise a supported fresh or appropriately isolated installation that can detect reliance on undeclared dependencies.

The check MUST use the intended resolution and installation mode. It MUST distinguish declared shared workspace tooling from incidental availability through a root or sibling installation.

A cache may supply verified artifacts; it MUST NOT supply an unrecorded dependency or replace installation semantics. Avoid destroying a developer's working installation merely to perform this check; use an isolated supported environment when needed.

### PKG-049 — Distribution checks consume the actual artifact

When package contents, entry metadata, output format, or distribution prerequisites change, validation MUST inspect the resulting artifact and exercise its supported consumer entry paths.

For a separately installed package, use the packaged result outside accidental workspace availability. For a workspace source package, use the supported workspace resolution. For a native application or static site, exercise the relevant produced artifact and runtime prerequisites.

Source type-checking alone does not prove archive contents, executable loading, binary compatibility, or installed dependency availability. These checks do not require publishing an artifact to a registry or external service.

### PKG-050 — Compatibility checks cover affected selections

A change affecting version ranges, peers, optional dependencies, features, or native targets MUST validate the relevant supported selection boundaries.

Checks MUST cover applicable absence/disabled paths as well as enabled paths, and the version or target combinations whose compatibility the change alters. Testing only one fully enabled development installation is insufficient when that conceals a changed requirement.

The validation record MUST identify the configurations tested. A finite matrix supports a stated compatibility assessment; it MUST NOT be described as proof of every possible version or platform combination.

### PKG-051 — Integration behavior survives dependency changes

A dependency update MUST run the relevant existing integration and contract checks for the behavior the repository uses, in addition to resolver or compiler checks where applicable.

Tests MUST observe repository contracts, including meaningful failures, defaults, data transformations, identity, loading, and lifecycle when the update affects them. Required interface and component checks remain owned by `IFACE-032`, the Component chapter, and `MODULE-048` through `MODULE-050`.

A dependency's upstream test suite or installation success does not establish that the repository integration remains correct. Tests MUST NOT be weakened, bypassed, or broadly mocked to conceal an incompatible update.

### PKG-052 — Validation reports identify evidence and limits

A package change report MUST identify the relevant commands and outcomes, artifact or consumer mode tested, and any affected installation, target, feature, peer, or runtime path that could not be verified.

Unverified support MUST remain an explicit limitation with the evidence or environment needed to resolve it. A local build MUST NOT be described as a signed release, an independent-consumer test, or support for an untested platform.

Documentation-only changes to package guidance require documentation validation rather than dependency installation or execution when they change no package contract or configuration.

## Boundary examples

These examples illustrate the rules. They do not declare current repository manifests compliant, prescribe new dependencies, or promise a release capability that the repository does not yet provide.

### One dependency can have several roles

| Consumed item                                              | Producer need                              | Consumer obligation                                                                          |
| ---------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Schema library referenced by shipped executable validators | Build/type-check and execution             | Bundled or available through the supported runtime dependency contract                       |
| Type package referenced by published declarations          | Producer type-checking                     | Available to downstream type-checkers through the declared consumer contract                 |
| Formatter used only by workspace validation                | Development tooling                        | Supplied by the declared workspace tool owner; not an application runtime prerequisite       |
| Host framework shared with a library                       | Development integration and host execution | Compatible host/peer provisioning, including shared identity when required                   |
| Generator package that also supplies imported styles       | Generation plus asset construction         | Each actual use is classified; the package is not removable just because generation finished |
| Platform-selected native binary                            | Installation and target execution          | Required on the selected supported target even if the ecosystem labels the branch optional   |

The table describes obligations rather than a universal mapping to manifest section names. The ecosystem and the actual delivery mode determine the declaration form.

### Workspace source packages

```text
Illustrative workspace consumption:

  backend application -> protocol package -> conversation model package
  desktop application -> protocol package
  backend and desktop -> conversation model package

  package entries -> maintained TypeScript source
  application toolchains -> transform that supported source
  runtime schema dependencies -> remain available in the resulting artifacts

No separate library build or registry publication is implied.
```

This delivery model is compatible with source-consumed internal packages. If a package later targets independent installation, its source or compiled artifact needs the corresponding consumer and prerequisite checks; the existing workspace test is not sufficient evidence.

### Package graphs depend on the phase

```text
Production build:
  application artifact requires library artifact
  library artifact requires generator and maintained generation inputs

Verification after the library build:
  consumer fixture installs the library artifact
  test orchestration runs that fixture

Prohibited production prerequisite:
  library artifact requires consumer fixture artifact
  consumer fixture artifact requires library artifact
```

A root task that schedules both builds is not a package depending on its consumers. A library's consumer fixture can validate the built result without becoming part of its production prerequisites.

### Build success and delivered completeness

```text
Development can accidentally provide:
  workspace source directories
  package-manager and compiler executables
  sibling build output
  globally installed native tools

A supported consumer receives:
  the declared source or built artifact
  its declared installed dependencies
  explicitly provisioned host and system prerequisites

Validation must not confuse those environments.
```

A desktop launcher that runs a backend from the source checkout is evidence of a development path. A release claiming the same capability must establish where the backend, its runtime, and its dependencies come from in the delivered environment.

### Resolution and consumer compatibility

```text
Producer manifest:
  states the supported dependency constraints

Workspace resolution record:
  records the selected dependency identities for a reproducible build

Independent consumer:
  resolves under its supported constraints and host/peer setup

Producer lockfile success alone does not establish consumer compatibility.
```

An exact selected version and a broader supported range can both be correct. An override that installs outside a dependency's declared peer range requires a resolved compatibility assessment; removing the warning is not that assessment.

## Objective review criteria and SOLID mapping

This section summarizes the rules without creating another source of requirements.

| Property                                                          | Decision rule               |
| ----------------------------------------------------------------- | --------------------------- |
| Package purpose, role, identity, and delivery boundary            | `PKG-001` through `PKG-006` |
| Accountable direct requirements and consumer provisioning         | `PKG-007` through `PKG-015` |
| Valid build prerequisites and distinct dependency phases          | `PKG-016`                   |
| Reviewable adoption, source trust, execution, and obligations     | `PKG-017` through `PKG-024` |
| Compatible constraints and reproducible selected resolution       | `PKG-025` through `PKG-032` |
| Complete builds, artifacts, and external prerequisites            | `PKG-033` through `PKG-040` |
| Explicit compatibility, migration, release, and removal contracts | `PKG-041` through `PKG-046` |
| Validation through the actual affected consumer boundary          | `PKG-047` through `PKG-052` |

This chapter sets no arbitrary maximum number of packages, dependencies, modules, or source lines. It does not mandate identical versions throughout the workspace, public publishing, a separate build or test script per package, or a wrapper around every external library. Current requirements and applicable construct standards govern those decisions.

- **SRP:** package contents share an identified consumption or delivery responsibility under `PKG-001` through `PKG-003`; contained modules retain their own responsibilities.
- **OCP:** package selection and upgrades preserve justified extension contracts through `PKG-018` and `PKG-051`; `IFACE-003` owns whether an extension abstraction is warranted.
- **LSP:** dependency versions, peers, features, and artifact variants preserve their promised consumer contracts under `PKG-012` through `PKG-015`, `PKG-025`, and `PKG-041`.
- **ISP:** consumers receive the supported package surface and applicable dependency requirements under `PKG-005`, `PKG-009`, and `PKG-014`; broad package contents do not authorize broad callable dependencies.
- **DIP:** package declarations and integration choices preserve the ownership direction already required by `MODULE-020`, `MODULE-021`, `IFACE-004`, and `IFACE-024`. A registry boundary does not itself establish a domain abstraction.

## Construction and review checklist

- [ ] The package's purpose, owner, role, consumers, and delivery mode are identifiable.
- [ ] A new package has a current package-level need rather than a speculative organizational purpose.
- [ ] Identity, publication intent, entry metadata, and supported environments agree.
- [ ] Every direct dependency has an accountable declaration, including type, asset, script, and generation uses.
- [ ] Shared tooling and host prerequisites have explicit providers.
- [ ] Dependency stage, peer provisioning, optionality, features, and target selection are distinguished.
- [ ] Production build prerequisites are viable without undeclared prior outputs or cycles.
- [ ] Adoption evidence addresses the existing contribution criteria and preserves integration boundaries.
- [ ] Source identity, install/build execution, trust exceptions, and applicable third-party obligations are reviewable.
- [ ] Constraints, toolchain requirements, selected resolutions, and maintained patches remain coherent.
- [ ] Multiple dependency versions preserve required compatibility and runtime identity.
- [ ] Source or compiled artifacts contain the supported files and exclude private or unrelated material.
- [ ] Bundled and externally provisioned dependencies account for the delivered runtime.
- [ ] Versioning and migration describe compatibility without waiving active construct rules.
- [ ] Package updates and removals cover all real consumption paths.
- [ ] Validation exercises the affected installation, artifact, consumer, feature, and behavioral contracts.
- [ ] The report distinguishes verified support from missing environments or evidence.
- [ ] Any active-rule exception follows Contributing to Lys and has explicit reviewer approval.
