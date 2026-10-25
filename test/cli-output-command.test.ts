import { describe, expect, it } from 'vite-plus/test';
import { commandLoader, main } from '../src/cli.ts';
import { CliOutput } from '../src/cli-output.ts';

describe('terminal inheritance output', () => {
  it('prints a command that inherits the terminal with an empty stdout and no stderr', async () => {
    const load = commandLoader(async () => {
      await Promise.resolve();
      return { run: () => new CliOutput(23) };
    });
    await expect(main(['quiet'], load)).resolves.toStrictEqual({ code: 23, stderr: '', stdout: '' });
  });
});
