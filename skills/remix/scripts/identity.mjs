#!/usr/bin/env node
// Step 7, the identity gate (references/replica.md §9): the verdict on a generated clip of a person.
//   node inspect.mjs <replica-dir> <request-id> --identity      read its frames first
//   node identity.mjs pass <replica-dir> <request-id> --saw "<whose face, where in the clip>"
//   node identity.mjs fail <replica-dir> <request-id> --saw "<whose face, where in the clip>"
//   node identity.mjs status <replica-dir>                      exit 1 while anything blocks render.mjs
import { fail, parseArgs } from './lib/common.mjs';
import { identityProblems, signOff } from './lib/identity.mjs';
import { loadReplica } from './lib/replica.mjs';

const USAGE = 'usage: identity.mjs pass|fail <replica-dir> <request-id> --saw "<what you saw>" | identity.mjs status <replica-dir>';
const args = parseArgs();
const [command, dir, id] = args._;
if (!dir || !['pass', 'fail', 'status'].includes(command) || (command !== 'status' && !id)) fail(USAGE, 2);

const ctx = loadReplica(dir);
if (command !== 'status') {
  try {
    signOff(ctx, id, command, { saw: args.saw });
  } catch (e) {
    fail(e.message);
  }
}
const problems = identityProblems(loadReplica(dir));
for (const p of problems) console.log(p);
if (command === 'status' && problems.length) process.exit(1);
if (!problems.length) console.log('identity gate clear');
