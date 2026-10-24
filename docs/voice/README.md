# FloodLine conversation draft

Version: **0.1.0** · Status: **proposed; manual evaluation only**

These documents define the initial Claude conversation for a fictional flood
intake simulation. They do not change the running voice service.

- [System prompt v0.1.0](system-prompt-v0.1.0.md): copy only the fenced text into
  Claude's system-message field in a manual test environment.
- [Eight caller scenarios](caller-scenarios-v0.1.0.md): caller scripts, expected
  behavior, and failure conditions.
- [Manual evaluation checklist](manual-evaluation.md): a short repeatable review
  procedure and result template.

Use fictional details only. Start a fresh conversation for each scenario, keep
the same prompt version, and do not supply tools. The caller scripts are user
turns; evaluator directions in brackets are not spoken caller content.

## Scope and pending decisions

The prompt covers spoken intake, conversational memory, corrections, uncertainty,
and a caller-reviewed summary. Details mentioned in these documents are
conversation targets, not an agreed incident schema, required-field contract,
or storage format. An incomplete conversation can remain incomplete.

The incident contract must be agreed before tool instructions are drafted. Any
future tool instructions belong in a separate document and review, rather than
inside this conversation prompt. Persistence, submission, transfers, dispatch,
APIs, and model fine-tuning are outside this draft. No tool instructions or
integration code are included here.

When changing the prompt, create a new versioned prompt file and rerun all eight
scenarios. Record the version and outcomes in the evaluation notes so results
remain attributable to the exact prompt tested.
