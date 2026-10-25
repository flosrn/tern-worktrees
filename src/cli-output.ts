/** A command result that uses literal output or a child's inherited streams. */
export class CliOutput {
  readonly exitCode: number;
  readonly output: string;

  constructor(exitCode: number, output = '') {
    this.exitCode = exitCode;
    this.output = output;
  }
}
