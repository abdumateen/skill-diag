import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('skill-diag')
  .description('Capability surface observability for agent skills')
  .version(pkg.version);

program.parse();
