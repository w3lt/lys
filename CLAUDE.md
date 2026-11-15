@AGENTS.md

## Claude Code subagents

This section applies to Claude Code only. It names the subagent in [`.claude/agents/`](.claude/agents/) that does each kind of work in the operations that `AGENTS.md` links, so that a cheaper model does bulky or narrow work. It changes no rule: every rule, step, and check stays as `AGENTS.md` and `docs/` define it, and the agent that starts a subagent stays responsible for the step.

These instructions are the explicit direction to start the agents below for the work named, with the model and effort their files set.

| Work                                                                                                                                            | Agent                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Locating code, callers, consumers, tests, and documentation across many files                                                                   | `Explore`                                       |
| The baseline, the validation checks, and the exact rule checks, wherever the operations or Merge Request Review ask for them                    | `check-runner`                                  |
| Waiting for CI and reading CI and SonarCloud: Work on an Issue Step 8, Check the Reviews Step 5 item 3, and Review a Pull Request Step 3 item 2 | `ci-reader`                                     |
| The code-quality part of Steps 2 and 3 of [Merge Request Review](docs/code_reviews/MR_REVIEW.md), in every review                               | `standards-reviewer`, one run per touched group |
| The self-review: Work on an Issue Step 6 item 4, and Check the Reviews Step 5 item 1                                                            | `change-reviewer`                               |

### Standards groups

The reviewer decides from the changed constructs which groups a change touches, and starts one `standards-reviewer` run per touched group. Each run gets the group, the boundary, the changed constructs of that group, and only the files that hold them. The runs start together.

| Group                   | Standards                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Functions and values | [Function](docs/code_standards/FUNCTION.md), [Variable](docs/code_standards/VARIABLE.md), [Constant](docs/code_standards/CONSTANT.md), [Type](docs/code_standards/TYPE.md), [Comment](docs/code_standards/COMMENT.md), and the [JSDoc Standard](docs/JSDOC.md) |
| 2. Classes and objects  | [Interface](docs/code_standards/INTERFACE.md), [Class](docs/code_standards/CLASS.md), [Object](docs/code_standards/OBJECT.md)                                                                                                                                  |
| 3. Files and packages   | [Module and File](docs/code_standards/MODULE.md), [Package and Dependency](docs/code_standards/PACKAGE.md), [Configuration](docs/code_standards/CONFIGURATION.md)                                                                                              |
| 4. Failure and timing   | [Error](docs/code_standards/ERROR.md), [Async Task and Stream](docs/code_standards/ASYNC.md), [Resource](docs/code_standards/RESOURCE.md), [Event and Message](docs/code_standards/EVENT.md)                                                                   |
| 5. Boundaries           | [API](docs/code_standards/API.md), [Schema and Migration](docs/code_standards/SCHEMA.md)                                                                                                                                                                       |
| 6. UI                   | [Component](docs/code_standards/COMPONENT.md), [Hook](docs/code_standards/HOOK.md)                                                                                                                                                                             |
| 7. Tests                | [Test and Fixture](docs/code_standards/TEST.md), over tests, fixtures, test doubles, harnesses, and test discovery and configuration                                                                                                                           |

The reports of the exact rule checks go to the reviewer as candidate findings without a `standards-reviewer` run. The reviewer does every other part of the review, and Step 4 for every candidate, whichever agent found it.

### Self-review

`change-reviewer` gets only inputs that exist when the self-review starts. It never gets the author's plan or reasoning, and it is never started as a fork, because a fork carries the author's conversation.

- Work on an Issue Step 6 item 4: the issue, the description draft, the boundary `<base>..<head>`, and the validation record of Step 6 items 1 to 3. Before starting it, the author writes the description draft in `.agent-work/pr-body.md` from the template that Step 7 item 3 selects, with the spec or the approach as its design, so that the draft exists. Step 7 completes the same file.
- Check the Reviews Step 5 item 1: the issue, the pull request number, the fix range `<reviewed head>..<head>` as the boundary, the links to the reviews of the round, the maintainer's answers that the fixes apply, quoted, and the validation record at the head.

The author handles every finding of its report as the operation's self-review step requires.

### Reports

A subagent's report is input to the agent that started it. Validation evidence is the command, exit code, and output that `check-runner` or `ci-reader` quotes. When a report is unclear or incomplete, the agent that started the subagent runs the check itself.
