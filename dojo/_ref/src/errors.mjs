// errors.mjs — shared error contract (PROVIDED scaffolding; workers must NOT modify).
// Every unit throws this single typed error; the `code` disambiguates the stage.
export class CalcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CalcError";
    this.code = code; // 'LEX' | 'PARSE' | 'DIVZERO' | 'DEPTH'
  }
}
