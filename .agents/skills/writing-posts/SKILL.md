---
name: writing-posts
description: Write, edit, translate, or critique this blog's post prose using the owner's accepted voice and source material. Use for dictated edits, bilingual synchronization, and AI-tell review; collection data and image sourcing use the project's completion criteria.
---

# Writing posts

The owner's latest direction and accepted prose are the standard. Read the current piece and relevant published work in `src/content/posts/`; examples show his range, not a template for every genre. Apply his preferences together: concision must keep information, personality, and continuity. A review can honestly conclude that a passage should stay.

## Match the requested work

| Request | Mode | Action |
| --- | --- | --- |
| “What do you think?”, critique, or audit | Reader review | Read the whole piece and images. Explain substantive strengths and weaknesses; do not edit unless authorized. |
| Apply pasted or dictated edits | Faithful application | Keep typed/pasted wording verbatim. Compose dictated meaning fluently, preserving load-bearing words and jokes, with sibling sync and mechanics as needed. |
| Draft, rewrite, restructure, or translate | Composition | Make editorial choices within the requested scope, using the source material and the piece's register. |
| Check for AI tells | Lint review | Report contextual findings; do not bulk-rewrite. Read [the lint reference](references/ai-tell-review.md). |

A request to edit one passage does not authorize polishing its neighbors. An authorized rewrite requires judgment, not transcription. Clarify a consequential ambiguity when the established scope and source material cannot resolve it.

## Compose from the material

- Read the full post, actual photographs, and supplied notes before drafting. Form an independent reading, then choose material that serves it. A remark in dictation is not a request to include it. Prose develops the subject rather than listing each photograph's contents.
- Let an implicit topic or threads guide selection and movement. Do not force a theme onto incidental background objects. When the material supports a clear reading, make that choice and expose it at preview; ask when missing intention prevents a meaningful draft.
- Preserve accepted scenes, facts, jokes, photo selections and order unless the owner authorizes changing them. New composition may omit incidental notes; narrow edits preserve approved surrounding text. Respect the piece's actual chronology and transitions instead of imposing a fixed travel-essay structure.
- Never invent personal experiences, sensations, people, or facts. Research can explain a subject; it cannot supply the owner's memories or opinions. Resolve consequential garbled names and numbers from source material or reliable references instead of repeating errors or blurring them away.
- Write the authorized passage coherently. Compare with its strongest accepted passages for rhythm, temperature, repetition, and continuity. Check for AI tells afterward, as a diagnostic rather than a sentence-generation recipe.

Before a substantial overwrite, preserve a recoverable state through the existing [checkpoint workflow](../checkpoint/SKILL.md); do not create another backup directory.

## Voice and editorial judgment

Concrete material, observation, thought, and dry humor carry the feeling. The narrator can think, hedge, make a wry aside, and talk warmly to the reader when appropriate. An emoji or playful curatorial aside is not automatically an AI tell. The older blanket ban on reaction shots, asides, and self-commentary does not apply.

Concision removes redundancy and framing; it keeps useful information and flavor such as 难得、终于 and the shape of a joke. Natural repetition, fragments, and lines earned by surrounding material can stay. Do not swap equivalent phrases just to produce findings, or reverse accepted edits without a substantive reason.

Avoid invented atmosphere, forced symmetry, repeated cinematic metaphors, generic praise, and lesson-shaped endings. Judge warm or declarative lines in context. When the owner ends on an image, preserve that ending. Follow the repository's no-em-dash rule.

Read [voice and translation examples](references/voice-and-translation.md) when choosing a register, resolving a title/subtitle, or weighing a borderline change. Current material and newer owner choices outrank examples.

## Apply the owner's edits

- Apply typed or pasted final prose verbatim. Compose dictation into readable sentences, removing fillers and resolving repeated takes; a clearly later take replaces the earlier one. Preserve intended meaning and jokes rather than reproducing a speech transcript.
- When reviewing wording, show meaningful composed lines or uncertain interpretations as original/proposed pairs. Disclose content-bearing additions and genuine guesses, not every routine punctuation fix.
- When changing photos, inspect the actual files and rendered order. Do not infer “last photo” from a filename or remove an adjacent image by mistake.
- Fact-checking concerns factual contradictions. Preserve personal impressions rather than rewriting them as generic attributed claims. Include illustrations when they are part of the requested audit.

## Keep language siblings aligned

For the established travel-post workflow, Chinese is the ground truth and receives substantive review before English. Follow an explicitly chosen English-led draft when that is the task, then synchronize Chinese. The source is the owner's accepted version.

- Preserve facts, scenes, jokes, image order, and temperature while writing idiomatically. Meaning changes need sibling sync; language-specific mechanics need not force artificial edits to the other body.
- Align primary frontmatter `title`, `titleZh`, `titleEn`, `description`, `descriptionZh`, and `descriptionEn` with the bodies; keep the sibling's `title` in its language. Shared metadata comes from the primary file. Inspect the current translation resolver before bulk changes.
- When the owner supplies a title or subtitle, understand his line and render it natively. Do not replace it with a new line mined from the body. Preserve the joke's target; drop untranslatable wordplay rather than turn it into a different meaning. The subtitle should not merely restate the title.

## Finish before handoff

Read every changed sibling in full. Check continuity, repeated ideas, phrasing, punctuation, CJK-Latin spacing, names, casing, and metadata. Correct alt text made stale or wrong by the edit. When composing a post, provide descriptive alt text in each file's language. Previously empty or thin alt text outside a narrow edit's scope is an issue to flag, not permission to rewrite every caption.

Meet the repository's [completion criteria](../../../docs/completion-criteria.md). Inspect the actual changed page and images; a known mismatch remains unfinished unless the owner accepts that exception. Verify that the preview opens and serves the current result.

For prose review, show original and proposed context side by side in HTML, with changes highlighted and language switching when both languages are reviewed. Number alternatives clearly when selection is needed. For a finished-page request, show the actual production-preview page first. A methodology summary or separate report cannot replace the requested result.

At handoff, disclose structural choices, substantive additions, unresolved ambiguities, and whether work is local or published. Separate mechanics from optional suggestions. Publishing follows [AGENTS.md](../../../AGENTS.md) and the existing preview/release workflows; honor authorization already given for the reviewed scope without requesting it again.
