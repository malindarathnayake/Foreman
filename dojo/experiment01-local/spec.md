# Spec — Safe Expression Evaluator (`expr`)

## Intent
Build a dependency-free arithmetic expression evaluator in plain Node ESM, decomposed into 4 units
(`tokenize → parse → evaluate → calc`) with **frozen inter-unit interface contracts**. This is a
Foreman experiment-2 benchmark: the same spec is implemented twice under an Opus pit-boss, once with a
local-model worker pool and once with a Sonnet worker pool. Correctness is scored by a hidden acceptance
suite. Tier: **standard** (pure computation, no I/O).

## Decisions & Notes
| Decision | Choice | Rationale | Source |
|---|---|---|---|
| Parser | Recursive descent, one function per precedence level | Clear, delegable per unit | design-summary |
| Errors | ONE `CalcError extends Error` with `code ∈ {LEX,PARSE,DIVZERO,DEPTH}` | Unambiguous taxonomy | design-summary |
| `^` vs unary `-` | `^` binds tighter → `-2^2 = -4` | Standard math | design-summary |
| `^` associativity | RIGHT → `2^3^2 = 512` | Standard | design-summary |
| `/0` | throw `CalcError{DIVZERO}` | Deterministic | design-summary |
| Depth bound | paren nesting > `MAX_DEPTH=50` → `CalcError{DEPTH}` | DoS control (T1499) | design-summary |
| Numbers | `\d+(\.\d+)?`, JS double, sign via unary | Unambiguous lexer | design-summary |
| Empty/non-string to `calc` | `CalcError{PARSE}` | No silent 0 | design-summary |

## FROZEN interface contracts (reproduce verbatim; do NOT alter shapes)
```
// U1 tokenize output → U2 parse input
Token = { type: 'NUMBER'|'OP'|'LPAREN'|'RPAREN'|'EOF', value: number|null, op: string|null, pos: number }
  NUMBER → value:<number>, op:null      OP → value:null, op:∈{'+','-','*','/','^'}
  LPAREN/RPAREN/EOF → value:null, op:null      pos = 0-based start index (EOF.pos = input.length)

// U2 parse output → U3 evaluate input
Node = { type:'num', value:number }
     | { type:'binary', op:'+'|'-'|'*'|'/'|'^', left:Node, right:Node }
     | { type:'unary',  op:'-', operand:Node }

// shared (provided in src/errors.mjs — do NOT modify)
class CalcError extends Error { code: 'LEX'|'PARSE'|'DIVZERO'|'DEPTH' }
```

## Grammar (U2)
```
expr    := term  (('+'|'-') term)*      // left-assoc
term    := factor (('*'|'/') factor)*    // left-assoc
factor  := '-' factor | power            // unary minus, looser than ^
power   := primary ('^' factor)?         // right-assoc; RHS is a factor
primary := NUMBER | '(' expr ')'
```

## Core Behavior
1. `calc(input)` = `evaluate(parse(tokenize(input)))`.
2. `tokenize` scans left-to-right, skips ASCII whitespace, emits Tokens per contract, appends `EOF`.
3. `parse` consumes Tokens by recursive descent per the grammar, enforcing `MAX_DEPTH`, returns one `Node`.
4. `evaluate` walks the `Node` post-order and returns a `number`.

## Error Handling
| Scenario | Behavior |
|---|---|
| Invalid character (letters, `@`, `.` not in a number) | `tokenize` throws `CalcError{LEX}` |
| Empty/whitespace-only input, unbalanced parens, trailing/missing tokens | `parse` throws `CalcError{PARSE}` |
| `/` with right operand 0 | `evaluate` throws `CalcError{DIVZERO}` |
| Paren nesting depth > 50 | `parse` throws `CalcError{DEPTH}` |
| `calc(non-string)` | throws `CalcError{PARSE}` |

## Threat Table
| Component | Compromise Impact | ATT&CK | Controls | Detection Evidence |
|---|---|---|---|---|
| `parse` (untrusted input) | Deeply nested `(((…)))` → stack-overflow DoS | T1499 | `MAX_DEPTH=50` → `CalcError{DEPTH}` | Tested directly (`depth-guard` case); library has no telemetry |

## Telemetry Contract
None — pure library. Declared explicitly so no unit invents telemetry.

## Out of Scope
Variables, functions, `1e9` literals, bigint, `%`, comparisons/booleans, configurable precision, i18n
separators. Unary-chain recursion overflow (only paren depth is bounded).

## Testing Strategy
Archetype: hermetic Node ESM + `node:assert`, zero deps. Hidden `acceptance.test.mjs` (53 assertions,
`byCat` = tokenize/parse/evaluate/calc/errors) is GROUND TRUTH — never shown to a worker. Each category
is self-contained (parse tested on hand-built Tokens, evaluate on hand-built Nodes), so every unit is
gradeable independently. The pit-boss runs the scorer; workers implement against this spec + the frozen
contracts only.

## Implementation Order — one phase, 4 units (forward deps only)

### Unit U1 — `tokenize`  (file: `src/tokenize.mjs`)
- **Directive:** implement `tokenize(input:string): Token[]` per the frozen Token contract and grammar
  lexemes. Skip whitespace; numbers `\d+(\.\d+)?` (a lone `.` or trailing `.` is `LEX`); operators
  `+ - * / ^`; parens; append `EOF` at `pos = input.length`. Non-string input → `CalcError{PARSE}`.
  Invalid char → `CalcError{LEX}` with the offending position.
- **DO NOT:** collapse unary minus in the lexer (emit `OP '-'`); parse; evaluate; add exponent/sign literals.
- **Test:** pit-boss runs `node acceptance.test.mjs`, gate on `byCat.tokenize` = 10/10.

### Unit U2 — `parse`  (file: `src/parse.mjs`)
- **Directive:** implement `parse(tokens:Token[]): Node` by recursive descent per the grammar. Left-assoc
  `+ -` and `* /`; unary `-` looser than `^`; `^` right-assoc with a `factor` RHS. Track paren nesting
  depth; `> 50` → `CalcError{DEPTH}`. Empty (`[EOF]`), unbalanced, missing operand, or trailing tokens →
  `CalcError{PARSE}`. Build AST per the frozen Node contract exactly.
- **DO NOT:** re-tokenize; evaluate; change Node/Token shapes; accept trailing tokens.
- **Test:** gate on `byCat.parse` = 12/12 (uses hand-built tokens, independent of U1).

### Unit U3 — `evaluate`  (file: `src/evaluate.mjs`)
- **Directive:** implement `evaluate(node:Node): number` — post-order walk. `+ - * /` and `^`
  (`Math.pow`); unary `-` negates; `/` by 0 → `CalcError{DIVZERO}`.
- **DO NOT:** parse; special-case beyond the contract; return `Infinity`/`NaN` for `/0`.
- **Test:** gate on `byCat.evaluate` = 10/10 (hand-built nodes, independent of U2).

### Unit U4 — `calc`  (file: `src/calc.mjs`)
- **Directive:** implement `calc(input:string): number = evaluate(parse(tokenize(input)))`; keep the
  `export { CalcError }` re-export. Errors propagate unchanged from the stages.
- **DO NOT:** swallow errors; reimplement stages; alter error codes.
- **Test:** gate on `byCat.calc` = 18/18 and `byCat.errors` = 3/3 (full integration).

**Phase checkpoint:** `node acceptance.test.mjs` → 53/53, `byCat` all full.
